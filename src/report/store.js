import { randomUUID } from "node:crypto";
import pg from "pg";

export class ReportAccessError extends Error {
  constructor(message, code = "REPORT_ACCESS_DENIED") {
    super(message);
    this.name = "ReportAccessError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// In-memory store: used by the tests and for local runs without a database.
// Postgres store below implements exactly the same methods.
// ---------------------------------------------------------------------------
export class InMemoryReportStore {
  constructor() {
    this.tenants = new Map();
    this.users = new Map();
    this.memberships = new Map(); // `${userId}:${tenantId}` -> row
    this.connections = new Map();
    this.grants = new Map(); // `${tenantId}:${pack}` -> row
    this.rolePacks = new Map(); // `${tenantId}:${role}:${pack}` -> row
    this.auditRows = [];
    this.clients = new Map();
    this.loginRequests = new Map();
    this.authCodes = new Map();
    this.tokens = new Map();
    this.adminLoginTokens = new Map();
    this.invites = new Map();
    this.settings = new Map();
  }

  async getSetting(key) {
    return this.settings.get(key) ?? null;
  }

  async setSetting(key, value, by) {
    this.settings.set(key, String(value));
  }

  async createInvite({ tokenHash, tenantId, email, role, createdBy, expiresAt }) {
    this.invites.set(tokenHash, { tokenHash, tenantId, email, role, createdBy, expiresAt, consumedAt: null });
  }

  async acceptInvite({ tokenHash, email }) {
    const invite = this.invites.get(tokenHash);
    if (!invite || invite.consumedAt || invite.expiresAt.getTime() <= Date.now() || invite.email !== email) return null;
    const tenant = this.tenants.get(invite.tenantId);
    if (!tenant || tenant.status === "suspended") return null;
    const subject = `invite:${invite.tenantId}:${invite.email}`;
    let user = [...this.users.values()].find((row) => row.subject === subject);
    if (!user) {
      user = { id: randomUUID(), subject, email: invite.email, display_name: null, status: "active" };
      this.users.set(user.id, user);
    }
    if (user.status !== "active") return null;
    const key = `${user.id}:${tenant.id}`;
    const existing = this.memberships.get(key);
    if (existing?.status === "revoked") throw new ReportAccessError("Quyền truy cập của người dùng này đã bị thu hồi.", "MEMBERSHIP_REVOKED");
    if (!existing) this.memberships.set(key, { user_id: user.id, tenant_id: tenant.id, role: invite.role, status: "active" });
    invite.consumedAt = new Date();
    return { userId: user.id, tenantId: tenant.id, role: (existing || this.memberships.get(key)).role };
  }

  async listInvites(tenantId) {
    return [...this.invites.values()].filter((row) => row.tenantId === tenantId)
      .map((row) => ({ email: row.email, role: row.role, expiresAt: row.expiresAt, consumed: Boolean(row.consumedAt) }));
  }

  async provisionTenant({ locationId, name }) {
    const existing = [...this.tenants.values()].find((row) => row.location_id === locationId);
    if (existing) return { id: existing.id, created: false, status: existing.status };
    const tenant = { id: randomUUID(), location_id: locationId, name: name || locationId, status: "pending", created_at: new Date() };
    this.tenants.set(tenant.id, tenant);
    return { id: tenant.id, created: true, status: tenant.status };
  }

  async provisionLogin({ subject, email, displayName, locationId, locationName, encryptedPayload, expiresAt, scopes, allowCreate = false }) {
    let tenant = [...this.tenants.values()].find((row) => row.location_id === locationId);
    let created = false;
    if (!tenant) {
      if (!allowCreate) throw new ReportAccessError("Tài khoản này chưa được Uplifting kích hoạt. Vui lòng liên hệ Uplifting để được cấp quyền trước khi kết nối.", "NOT_PROVISIONED");
      tenant = { id: randomUUID(), location_id: locationId, name: locationName || locationId, status: "pending", created_at: new Date() };
      this.tenants.set(tenant.id, tenant);
      created = true;
    } else if (locationName && tenant.name === tenant.location_id) {
      tenant.name = locationName; // keep a name an admin typed; only replace the placeholder
    }
    if (tenant.status === "suspended") throw new ReportAccessError("Tài khoản này đang bị tạm khóa.", "TENANT_SUSPENDED");
    let user = [...this.users.values()].find((row) => row.subject === subject);
    if (!user) {
      user = { id: randomUUID(), subject, email: email || null, display_name: displayName || null, status: "active" };
      this.users.set(user.id, user);
    } else {
      user.email = email || user.email;
      user.display_name = displayName || user.display_name;
    }
    if (user.status !== "active") throw new ReportAccessError("Người dùng này đang bị tạm khóa.", "USER_SUSPENDED");
    const key = `${user.id}:${tenant.id}`;
    let membership = this.memberships.get(key);
    if (membership?.status === "revoked") throw new ReportAccessError("Quyền truy cập của người dùng này đã bị thu hồi.", "MEMBERSHIP_REVOKED");
    if (!membership) {
      const active = [...this.memberships.values()].filter((row) => row.tenant_id === tenant.id && row.status === "active").length;
      membership = { user_id: user.id, tenant_id: tenant.id, role: active === 0 ? "owner" : "admin", status: "active" };
      this.memberships.set(key, membership);
    }
    this.connections.set(tenant.id, {
      tenant_id: tenant.id, location_id: locationId, encrypted_payload: encryptedPayload,
      expires_at: expiresAt, scopes: scopes || [], status: "active"
    });
    return { userId: user.id, tenantId: tenant.id, role: membership.role, created, tenantStatus: tenant.status };
  }

  async resolvePrincipal(userId, tenantId) {
    const user = this.users.get(userId);
    const tenant = this.tenants.get(tenantId);
    const membership = this.memberships.get(`${userId}:${tenantId}`);
    if (!user || !tenant || !membership) return null;
    if (user.status !== "active" || membership.status !== "active" || tenant.status === "suspended") return null;
    return {
      userId: user.id, subject: user.subject, email: user.email, tenantId: tenant.id, tenantName: tenant.name,
      tenantStatus: tenant.status, locationId: tenant.location_id, role: membership.role
    };
  }

  async getConnection(tenantId) {
    const row = this.connections.get(tenantId);
    return row && row.status === "active" ? { ...row } : null;
  }

  async updateConnectionCredential(tenantId, encryptedPayload, expiresAt) {
    const row = this.connections.get(tenantId);
    if (row) { row.encrypted_payload = encryptedPayload; row.expires_at = expiresAt; }
  }

  async listTenants() {
    return [...this.tenants.values()].map((tenant) => ({
      id: tenant.id, locationId: tenant.location_id, name: tenant.name, status: tenant.status,
      createdAt: tenant.created_at, connected: this.connections.get(tenant.id)?.status === "active",
      memberCount: [...this.memberships.values()].filter((m) => m.tenant_id === tenant.id && m.status === "active").length
    })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  async getTenant(tenantId) {
    const tenant = this.tenants.get(tenantId);
    return tenant ? { id: tenant.id, locationId: tenant.location_id, name: tenant.name, status: tenant.status } : null;
  }

  async setTenantStatus(tenantId, status) {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return false;
    tenant.status = status;
    return true;
  }

  async listMembers(tenantId) {
    return [...this.memberships.values()].filter((m) => m.tenant_id === tenantId).map((m) => {
      const user = this.users.get(m.user_id);
      return { userId: m.user_id, email: user?.email || null, displayName: user?.display_name || null, role: m.role, status: m.status };
    });
  }

  async setMembershipRole(tenantId, userId, role) {
    const m = this.memberships.get(`${userId}:${tenantId}`);
    if (!m) return false;
    m.role = role;
    return true;
  }

  async setMembershipStatus(tenantId, userId, status) {
    const m = this.memberships.get(`${userId}:${tenantId}`);
    if (!m) return false;
    m.status = status;
    return true;
  }

  async getPermissions(tenantId) {
    const grants = {};
    const rolePacks = {};
    for (const row of this.grants.values()) if (row.tenant_id === tenantId) grants[row.pack] = row.enabled;
    for (const row of this.rolePacks.values()) if (row.tenant_id === tenantId) rolePacks[`${row.role}:${row.pack}`] = row.enabled;
    return { grants, rolePacks };
  }

  async setPackGrant(tenantId, pack, enabled, by) {
    this.grants.set(`${tenantId}:${pack}`, { tenant_id: tenantId, pack, enabled, updated_by: by });
  }

  async setRolePack(tenantId, role, pack, enabled, by) {
    this.rolePacks.set(`${tenantId}:${role}:${pack}`, { tenant_id: tenantId, role, pack, enabled, updated_by: by });
  }

  async recordAudit(entry) {
    this.auditRows.push({ id: this.auditRows.length + 1, created_at: new Date(), metadata: {}, ...entry });
  }

  async listAudit({ tenantId = null, limit = 100 } = {}) {
    return this.auditRows.filter((row) => !tenantId || row.tenantId === tenantId).slice(-limit).reverse();
  }

  async registerClient({ clientId, clientName, redirectUris }) {
    this.clients.set(clientId, { client_id: clientId, client_name: clientName, redirect_uris: redirectUris });
  }

  async findClient(clientId) {
    return this.clients.get(clientId) || null;
  }

  async createLoginRequest(row) {
    this.loginRequests.set(row.stateHash, row);
  }

  async consumeLoginRequest(stateHash) {
    const row = this.loginRequests.get(stateHash);
    this.loginRequests.delete(stateHash);
    if (!row || row.expiresAt.getTime() <= Date.now()) return null;
    return {
      client_id: row.clientId, redirect_uri: row.redirectUri, code_challenge: row.codeChallenge, client_state: row.clientState
    };
  }

  async createAuthCode(row) {
    this.authCodes.set(row.codeHash, row);
  }

  async consumeAuthCode(codeHash) {
    const row = this.authCodes.get(codeHash);
    this.authCodes.delete(codeHash);
    if (!row || row.expiresAt.getTime() <= Date.now()) return null;
    return {
      client_id: row.clientId, redirect_uri: row.redirectUri, code_challenge: row.codeChallenge,
      user_id: row.userId, tenant_id: row.tenantId
    };
  }

  async insertToken(row) {
    this.tokens.set(row.tokenHash, { ...row, consumedAt: null, revokedAt: null });
  }

  async findAccessToken(tokenHash) {
    const row = this.tokens.get(tokenHash);
    if (!row || row.kind !== "access" || row.revokedAt || row.expiresAt.getTime() <= Date.now()) return null;
    return { user_id: row.userId, tenant_id: row.tenantId, client_id: row.clientId };
  }

  async consumeRefreshToken(tokenHash) {
    const row = this.tokens.get(tokenHash);
    if (!row || row.kind !== "refresh") return null;
    if (row.consumedAt || row.revokedAt) {
      for (const other of this.tokens.values()) if (other.familyId === row.familyId) other.revokedAt = new Date();
      return null;
    }
    if (row.expiresAt.getTime() <= Date.now()) return null;
    row.consumedAt = new Date();
    return { family_id: row.familyId, client_id: row.clientId, user_id: row.userId, tenant_id: row.tenantId };
  }

  async revokeTokens({ tenantId, userId = null }) {
    for (const row of this.tokens.values()) {
      if (row.tenantId === tenantId && (!userId || row.userId === userId)) row.revokedAt = new Date();
    }
  }

  async createAdminLoginToken(row) {
    this.adminLoginTokens.set(row.tokenHash, { ...row, consumedAt: null });
  }

  async consumeAdminLoginToken(tokenHash) {
    const row = this.adminLoginTokens.get(tokenHash);
    if (!row || row.consumedAt || row.expiresAt.getTime() <= Date.now()) return null;
    row.consumedAt = new Date();
    return { email: row.email };
  }

  async deleteExpired() {
    const now = Date.now();
    for (const [key, row] of this.loginRequests) if (row.expiresAt.getTime() <= now) this.loginRequests.delete(key);
    for (const [key, row] of this.authCodes) if (row.expiresAt.getTime() <= now) this.authCodes.delete(key);
    for (const [key, row] of this.tokens) if (row.expiresAt.getTime() <= now) this.tokens.delete(key);
    for (const [key, row] of this.adminLoginTokens) if (row.expiresAt.getTime() <= now) this.adminLoginTokens.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Postgres store. Tables: migrations/013_report_gateway.sql.
// ---------------------------------------------------------------------------
export class PostgresReportStore {
  constructor({ connectionString, pool } = {}) {
    this.pool = pool || new pg.Pool({
      connectionString,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
      max: 5
    });
  }

  async getSetting(key) {
    const { rows } = await this.pool.query("SELECT value FROM report_settings WHERE key = $1", [key]);
    return rows[0]?.value ?? null;
  }

  async setSetting(key, value, by) {
    await this.pool.query(
      `INSERT INTO report_settings (key, value, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, String(value), by || null]
    );
  }

  async createInvite({ tokenHash, tenantId, email, role, createdBy, expiresAt }) {
    await this.pool.query(
      "INSERT INTO report_invites (token_hash, tenant_id, email, role, created_by, expires_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [tokenHash, tenantId, email, role, createdBy || null, expiresAt]
    );
  }

  async acceptInvite({ tokenHash, email }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const invite = await client.query(
        `UPDATE report_invites i SET consumed_at = now()
           FROM report_tenants t
          WHERE i.token_hash = $1 AND i.email = $2 AND i.consumed_at IS NULL AND i.expires_at > now()
            AND t.id = i.tenant_id AND t.status <> 'suspended'
          RETURNING i.tenant_id, i.email, i.role`,
        [tokenHash, email]
      );
      if (!invite.rowCount) { await client.query("ROLLBACK"); return null; }
      const { tenant_id: tenantId, role } = invite.rows[0];
      const subject = `invite:${tenantId}:${email}`;
      const user = (await client.query(
        `INSERT INTO report_users (subject, email) VALUES ($1, $2)
         ON CONFLICT (subject) DO UPDATE SET email = EXCLUDED.email RETURNING id, status`,
        [subject, email]
      )).rows[0];
      if (user.status !== "active") { await client.query("ROLLBACK"); return null; }
      const existing = await client.query("SELECT role, status FROM report_memberships WHERE user_id = $1 AND tenant_id = $2", [user.id, tenantId]);
      let finalRole = role;
      if (existing.rowCount) {
        if (existing.rows[0].status === "revoked") throw new ReportAccessError("Quyền truy cập của người dùng này đã bị thu hồi.", "MEMBERSHIP_REVOKED");
        finalRole = existing.rows[0].role;
      } else {
        await client.query("INSERT INTO report_memberships (user_id, tenant_id, role) VALUES ($1, $2, $3)", [user.id, tenantId, role]);
      }
      await client.query("COMMIT");
      return { userId: user.id, tenantId, role: finalRole };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async listInvites(tenantId) {
    const { rows } = await this.pool.query(
      "SELECT email, role, expires_at, consumed_at FROM report_invites WHERE tenant_id = $1 ORDER BY expires_at DESC LIMIT 50",
      [tenantId]
    );
    return rows.map((row) => ({ email: row.email, role: row.role, expiresAt: row.expires_at, consumed: Boolean(row.consumed_at) }));
  }

  async provisionTenant({ locationId, name }) {
    const inserted = await this.pool.query(
      `INSERT INTO report_tenants (location_id, name) VALUES ($1, $2)
       ON CONFLICT (location_id) DO NOTHING RETURNING id, status`,
      [locationId, name || locationId]
    );
    if (inserted.rowCount) return { id: inserted.rows[0].id, created: true, status: inserted.rows[0].status };
    const { rows } = await this.pool.query("SELECT id, status FROM report_tenants WHERE location_id = $1", [locationId]);
    return { id: rows[0].id, created: false, status: rows[0].status };
  }

  async provisionLogin({ subject, email, displayName, locationId, locationName, encryptedPayload, expiresAt, scopes, allowCreate = false }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query("SELECT id, status, name, location_id FROM report_tenants WHERE location_id = $1 FOR UPDATE", [locationId]);
      let tenant;
      if (found.rowCount) {
        tenant = { ...found.rows[0], created: false };
        if (locationName && tenant.name === tenant.location_id) {
          await client.query("UPDATE report_tenants SET name = $2, updated_at = now() WHERE id = $1", [tenant.id, locationName]);
        }
      } else {
        if (!allowCreate) throw new ReportAccessError("Tài khoản này chưa được Uplifting kích hoạt. Vui lòng liên hệ Uplifting để được cấp quyền trước khi kết nối.", "NOT_PROVISIONED");
        const inserted = await client.query(
          "INSERT INTO report_tenants (location_id, name) VALUES ($1, $2) RETURNING id, status",
          [locationId, locationName || locationId]
        );
        tenant = { ...inserted.rows[0], created: true };
      }
      if (tenant.status === "suspended") throw new ReportAccessError("Tài khoản này đang bị tạm khóa.", "TENANT_SUSPENDED");
      const userResult = await client.query(
        `INSERT INTO report_users (subject, email, display_name) VALUES ($1, $2, $3)
         ON CONFLICT (subject) DO UPDATE SET email = COALESCE(EXCLUDED.email, report_users.email),
           display_name = COALESCE(EXCLUDED.display_name, report_users.display_name)
         RETURNING id, status`,
        [subject, email || null, displayName || null]
      );
      const user = userResult.rows[0];
      if (user.status !== "active") throw new ReportAccessError("Người dùng này đang bị tạm khóa.", "USER_SUSPENDED");
      const existing = await client.query("SELECT role, status FROM report_memberships WHERE user_id = $1 AND tenant_id = $2", [user.id, tenant.id]);
      let role;
      if (existing.rowCount) {
        if (existing.rows[0].status === "revoked") throw new ReportAccessError("Quyền truy cập của người dùng này đã bị thu hồi.", "MEMBERSHIP_REVOKED");
        role = existing.rows[0].role;
      } else {
        const count = await client.query("SELECT count(*)::int AS n FROM report_memberships WHERE tenant_id = $1 AND status = 'active'", [tenant.id]);
        role = count.rows[0].n === 0 ? "owner" : "admin";
        await client.query("INSERT INTO report_memberships (user_id, tenant_id, role) VALUES ($1, $2, $3)", [user.id, tenant.id, role]);
      }
      await client.query(
        `INSERT INTO report_connections (tenant_id, location_id, encrypted_payload, expires_at, scopes, status)
         VALUES ($1, $2, $3, $4, $5, 'active')
         ON CONFLICT (tenant_id) DO UPDATE SET location_id = EXCLUDED.location_id, encrypted_payload = EXCLUDED.encrypted_payload,
           expires_at = EXCLUDED.expires_at, scopes = EXCLUDED.scopes, status = 'active', updated_at = now()`,
        [tenant.id, locationId, encryptedPayload, expiresAt, scopes || []]
      );
      await client.query("COMMIT");
      return { userId: user.id, tenantId: tenant.id, role, created: tenant.created, tenantStatus: tenant.status };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async resolvePrincipal(userId, tenantId) {
    const { rows } = await this.pool.query(
      `SELECT u.id AS user_id, u.subject, u.email, t.id AS tenant_id, t.name AS tenant_name, t.status AS tenant_status,
              t.location_id, m.role
         FROM report_memberships m
         JOIN report_users u ON u.id = m.user_id
         JOIN report_tenants t ON t.id = m.tenant_id
        WHERE m.user_id = $1 AND m.tenant_id = $2 AND m.status = 'active' AND u.status = 'active' AND t.status <> 'suspended'`,
      [userId, tenantId]
    );
    const row = rows[0];
    return row ? {
      userId: row.user_id, subject: row.subject, email: row.email, tenantId: row.tenant_id, tenantName: row.tenant_name,
      tenantStatus: row.tenant_status, locationId: row.location_id, role: row.role
    } : null;
  }

  async getConnection(tenantId) {
    const { rows } = await this.pool.query(
      "SELECT tenant_id, location_id, encrypted_payload, expires_at, scopes FROM report_connections WHERE tenant_id = $1 AND status = 'active'",
      [tenantId]
    );
    return rows[0] || null;
  }

  async updateConnectionCredential(tenantId, encryptedPayload, expiresAt) {
    await this.pool.query(
      "UPDATE report_connections SET encrypted_payload = $2, expires_at = $3, updated_at = now() WHERE tenant_id = $1",
      [tenantId, encryptedPayload, expiresAt]
    );
  }

  async listTenants() {
    const { rows } = await this.pool.query(
      `SELECT t.id, t.location_id, t.name, t.status, t.created_at,
              (SELECT count(*)::int FROM report_memberships m WHERE m.tenant_id = t.id AND m.status = 'active') AS member_count,
              EXISTS (SELECT 1 FROM report_connections c WHERE c.tenant_id = t.id AND c.status = 'active') AS connected
         FROM report_tenants t ORDER BY t.name`
    );
    return rows.map((row) => ({
      id: row.id, locationId: row.location_id, name: row.name, status: row.status, createdAt: row.created_at, memberCount: row.member_count, connected: row.connected
    }));
  }

  async getTenant(tenantId) {
    const { rows } = await this.pool.query("SELECT id, location_id, name, status FROM report_tenants WHERE id = $1", [tenantId]);
    const row = rows[0];
    return row ? { id: row.id, locationId: row.location_id, name: row.name, status: row.status } : null;
  }

  async setTenantStatus(tenantId, status) {
    const result = await this.pool.query("UPDATE report_tenants SET status = $2, updated_at = now() WHERE id = $1", [tenantId, status]);
    return result.rowCount > 0;
  }

  async listMembers(tenantId) {
    const { rows } = await this.pool.query(
      `SELECT m.user_id, u.email, u.display_name, m.role, m.status
         FROM report_memberships m JOIN report_users u ON u.id = m.user_id
        WHERE m.tenant_id = $1 ORDER BY m.created_at`,
      [tenantId]
    );
    return rows.map((row) => ({ userId: row.user_id, email: row.email, displayName: row.display_name, role: row.role, status: row.status }));
  }

  async setMembershipRole(tenantId, userId, role) {
    const result = await this.pool.query("UPDATE report_memberships SET role = $3 WHERE tenant_id = $1 AND user_id = $2", [tenantId, userId, role]);
    return result.rowCount > 0;
  }

  async setMembershipStatus(tenantId, userId, status) {
    const result = await this.pool.query("UPDATE report_memberships SET status = $3 WHERE tenant_id = $1 AND user_id = $2", [tenantId, userId, status]);
    return result.rowCount > 0;
  }

  async getPermissions(tenantId) {
    const [grants, rolePacks] = await Promise.all([
      this.pool.query("SELECT pack, enabled FROM report_pack_grants WHERE tenant_id = $1", [tenantId]),
      this.pool.query("SELECT role, pack, enabled FROM report_role_packs WHERE tenant_id = $1", [tenantId])
    ]);
    return {
      grants: Object.fromEntries(grants.rows.map((row) => [row.pack, row.enabled])),
      rolePacks: Object.fromEntries(rolePacks.rows.map((row) => [`${row.role}:${row.pack}`, row.enabled]))
    };
  }

  async setPackGrant(tenantId, pack, enabled, by) {
    await this.pool.query(
      `INSERT INTO report_pack_grants (tenant_id, pack, enabled, updated_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, pack) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [tenantId, pack, enabled, by || null]
    );
  }

  async setRolePack(tenantId, role, pack, enabled, by) {
    await this.pool.query(
      `INSERT INTO report_role_packs (tenant_id, role, pack, enabled, updated_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, role, pack) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [tenantId, role, pack, enabled, by || null]
    );
  }

  async recordAudit({ tenantId = null, actorType, actor = null, action, tool = null, pack = null, result, metadata = {} }) {
    await this.pool.query(
      `INSERT INTO report_audit (tenant_id, actor_type, actor, action, tool, pack, result, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [tenantId, actorType, actor, action, tool, pack, result, JSON.stringify(metadata)]
    );
  }

  async listAudit({ tenantId = null, limit = 100 } = {}) {
    const { rows } = await this.pool.query(
      `SELECT id, tenant_id, actor_type, actor, action, tool, pack, result, metadata, created_at
         FROM report_audit WHERE ($1::uuid IS NULL OR tenant_id = $1) ORDER BY id DESC LIMIT $2`,
      [tenantId, Math.min(Number(limit) || 100, 500)]
    );
    return rows.map((row) => ({
      id: row.id, tenantId: row.tenant_id, actorType: row.actor_type, actor: row.actor, action: row.action,
      tool: row.tool, pack: row.pack, result: row.result, metadata: row.metadata, created_at: row.created_at
    }));
  }

  async registerClient({ clientId, clientName, redirectUris }) {
    await this.pool.query("INSERT INTO report_oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, $2, $3)", [clientId, clientName, redirectUris]);
  }

  async findClient(clientId) {
    const { rows } = await this.pool.query("SELECT client_id, client_name, redirect_uris FROM report_oauth_clients WHERE client_id = $1", [clientId]);
    return rows[0] || null;
  }

  async createLoginRequest({ stateHash, clientId, redirectUri, codeChallenge, clientState, expiresAt }) {
    await this.pool.query(
      "INSERT INTO report_login_requests (state_hash, client_id, redirect_uri, code_challenge, client_state, expires_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [stateHash, clientId, redirectUri, codeChallenge, clientState, expiresAt]
    );
  }

  async consumeLoginRequest(stateHash) {
    const { rows } = await this.pool.query(
      "DELETE FROM report_login_requests WHERE state_hash = $1 AND expires_at > now() RETURNING client_id, redirect_uri, code_challenge, client_state",
      [stateHash]
    );
    return rows[0] || null;
  }

  async createAuthCode({ codeHash, clientId, redirectUri, codeChallenge, userId, tenantId, expiresAt }) {
    await this.pool.query(
      "INSERT INTO report_auth_codes (code_hash, client_id, redirect_uri, code_challenge, user_id, tenant_id, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [codeHash, clientId, redirectUri, codeChallenge, userId, tenantId, expiresAt]
    );
  }

  async consumeAuthCode(codeHash) {
    const { rows } = await this.pool.query(
      "DELETE FROM report_auth_codes WHERE code_hash = $1 AND expires_at > now() RETURNING client_id, redirect_uri, code_challenge, user_id, tenant_id",
      [codeHash]
    );
    return rows[0] || null;
  }

  async insertToken({ tokenHash, kind, familyId, clientId, userId, tenantId, expiresAt }) {
    await this.pool.query(
      "INSERT INTO report_oauth_tokens (token_hash, kind, family_id, client_id, user_id, tenant_id, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [tokenHash, kind, familyId, clientId, userId, tenantId, expiresAt]
    );
  }

  async findAccessToken(tokenHash) {
    const { rows } = await this.pool.query(
      "SELECT user_id, tenant_id, client_id FROM report_oauth_tokens WHERE token_hash = $1 AND kind = 'access' AND revoked_at IS NULL AND expires_at > now()",
      [tokenHash]
    );
    return rows[0] || null;
  }

  async consumeRefreshToken(tokenHash) {
    const consumed = await this.pool.query(
      `UPDATE report_oauth_tokens SET consumed_at = now()
        WHERE token_hash = $1 AND kind = 'refresh' AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()
        RETURNING family_id, client_id, user_id, tenant_id`,
      [tokenHash]
    );
    if (consumed.rowCount) return consumed.rows[0];
    // A refresh token that was already used is a replay: kill its whole family.
    const replay = await this.pool.query("SELECT family_id FROM report_oauth_tokens WHERE token_hash = $1 AND kind = 'refresh' AND consumed_at IS NOT NULL", [tokenHash]);
    if (replay.rowCount) await this.pool.query("UPDATE report_oauth_tokens SET revoked_at = now() WHERE family_id = $1", [replay.rows[0].family_id]);
    return null;
  }

  async revokeTokens({ tenantId, userId = null }) {
    await this.pool.query(
      "UPDATE report_oauth_tokens SET revoked_at = now() WHERE tenant_id = $1 AND ($2::uuid IS NULL OR user_id = $2) AND revoked_at IS NULL",
      [tenantId, userId]
    );
  }

  async createAdminLoginToken({ tokenHash, email, expiresAt }) {
    await this.pool.query("INSERT INTO report_admin_login_tokens (token_hash, email, expires_at) VALUES ($1, $2, $3)", [tokenHash, email, expiresAt]);
  }

  async consumeAdminLoginToken(tokenHash) {
    const { rows } = await this.pool.query(
      "UPDATE report_admin_login_tokens SET consumed_at = now() WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now() RETURNING email",
      [tokenHash]
    );
    return rows[0] || null;
  }

  async deleteExpired() {
    await this.pool.query("DELETE FROM report_login_requests WHERE expires_at <= now()");
    await this.pool.query("DELETE FROM report_auth_codes WHERE expires_at <= now()");
    await this.pool.query("DELETE FROM report_oauth_tokens WHERE expires_at <= now() - interval '1 day'");
    await this.pool.query("DELETE FROM report_admin_login_tokens WHERE expires_at <= now() - interval '1 day'");
  }
}

export function createReportStore(env = process.env) {
  return env.DATABASE_URL ? new PostgresReportStore({ connectionString: env.DATABASE_URL }) : new InMemoryReportStore();
}
