import pg from "pg";
import { randomBytes } from "node:crypto";
import { CompositeCredentialProvider } from "./credential-provider.js";

const { Pool } = pg;

export const LEGACY_123_GYM_LOCATION_ID = "pUePVc6UKEUecvZS6EYU";
export const LEGACY_123_GYM_TENANT_ID = "00000000-0000-4000-8000-000000000123";

export class TenantAuthorizationError extends Error {
  constructor(message, code = "TENANT_FORBIDDEN") {
    super(message);
    this.name = "TenantAuthorizationError";
    this.code = code;
  }
}

function slugify(value) {
  const base = String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "tenant";
}

export class PostgresConnectionRepository {
  constructor({ connectionString, pool } = {}) {
    if (!pool && !connectionString) throw new Error("DATABASE_URL is required for the database tenant registry.");
    this.pool = pool || new Pool({ connectionString, ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined });
  }

  async findActiveConnectionByTenantId(tenantId) {
    const { rows } = await this.pool.query(
      `SELECT t.id AS tenant_id, t.display_name AS tenant_name, t.status AS tenant_status,
              c.id AS connection_id, c.external_location_id AS location_id, c.status AS connection_status,
              c.auth_type, c.scopes, c.default_user_id, tc.id AS credential_id, tc.secret_backend, tc.secret_ref,
              tc.credential_type, tc.expires_at, tc.encrypted_payload
         FROM tenants t
         JOIN connections c ON c.tenant_id = t.id AND c.provider = 'highlevel'
         JOIN tenant_credentials tc ON tc.id = c.credential_id
        WHERE t.id = $1 AND t.status = 'active' AND c.status = 'active'
        LIMIT 1`,
      [tenantId]
    );
    return rows[0] || null;
  }

  async findActiveConnectionByLocationId(locationId) {
    const { rows } = await this.pool.query(
      `SELECT t.id AS tenant_id, t.display_name AS tenant_name, t.status AS tenant_status,
              c.id AS connection_id, c.external_location_id AS location_id, c.status AS connection_status,
              c.auth_type, c.scopes, c.default_user_id, tc.id AS credential_id, tc.secret_backend, tc.secret_ref,
              tc.credential_type, tc.expires_at, tc.encrypted_payload
         FROM tenants t
         JOIN connections c ON c.tenant_id = t.id AND c.provider = 'highlevel'
         JOIN tenant_credentials tc ON tc.id = c.credential_id
        WHERE c.external_location_id = $1 AND t.status = 'active' AND c.status = 'active'
        LIMIT 1`,
      [locationId]
    );
    return rows[0] || null;
  }

  async resolveUserAuthorization({ authSubject, tenantIdClaim, email, displayName, emailVerified, allowSelfServeProvisioning = false }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const userResult = await client.query(
        `UPDATE users
            SET email = COALESCE($2, email), display_name = COALESCE($3, display_name),
                last_login_at = now(), updated_at = now()
          WHERE auth_subject = $1 AND status = 'active'
        RETURNING id, auth_subject, email, display_name`,
        [authSubject, email || null, displayName || null]
      );
      const user = userResult.rows[0];
      if (!user) {
        const existing = await client.query(`SELECT 1 FROM users WHERE auth_subject = $1`, [authSubject]);
        if (existing.rowCount > 0 || !allowSelfServeProvisioning) {
          throw new TenantAuthorizationError("Authenticated user is not provisioned or is inactive.", "USER_NOT_PROVISIONED");
        }
        const provisioned = await this.#provisionSelfServeTenant(client, { authSubject, email, displayName, emailVerified });
        await client.query("COMMIT");
        return provisioned;
      }
      const memberships = await client.query(
        `SELECT m.id AS membership_id, m.role, t.id AS tenant_id, t.display_name AS tenant_name
           FROM memberships m
           JOIN tenants t ON t.id = m.tenant_id
          WHERE m.user_id = $1 AND m.status = 'active' AND t.status = 'active'
          ORDER BY t.id`,
        [user.id]
      );
      let membership;
      if (tenantIdClaim) membership = memberships.rows.find((row) => row.tenant_id === tenantIdClaim);
      else if (memberships.rowCount === 1) membership = memberships.rows[0];
      else if (memberships.rowCount > 1) throw new TenantAuthorizationError("Tenant selection is ambiguous; the access token must include an authorized tenant claim.", "TENANT_CONTEXT_AMBIGUOUS");
      if (!membership) throw new TenantAuthorizationError("User has no active membership for the requested tenant.");
      await client.query("COMMIT");
      return { ...user, ...membership };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async #provisionSelfServeTenant(client, { authSubject, email, displayName, emailVerified }) {
    // Only an invited email may create a tenant. Consuming the invite happens
    // inside the caller's transaction, so any later failure rolls it back.
    if (emailVerified === false) {
      throw new TenantAuthorizationError("Email address is not verified.", "EMAIL_NOT_VERIFIED");
    }
    if (!email) {
      throw new TenantAuthorizationError("The access token carries no email, so no invitation can be matched.", "NOT_INVITED");
    }
    const inviteResult = await client.query(
      `UPDATE customer_invites
          SET status = 'accepted', accepted_at = now()
        WHERE lower(email) = lower($1) AND status = 'pending'
      RETURNING id, tenant_display_name`,
      [email]
    );
    const invite = inviteResult.rows[0];
    if (!invite) {
      throw new TenantAuthorizationError("This account has not been invited. Ask Uplifting to invite your email first.", "NOT_INVITED");
    }
    const tenantName = invite.tenant_display_name || displayName || email;
    const baseSlug = slugify(tenantName);
    let tenant;
    let usedSlug;
    for (let attempt = 0; attempt < 5 && !tenant; attempt += 1) {
      usedSlug = attempt === 0 ? baseSlug : `${baseSlug}-${randomBytes(3).toString("hex")}`;
      try {
        const tenantResult = await client.query(
          `INSERT INTO tenants (slug, display_name) VALUES ($1, $2) RETURNING id, display_name`,
          [usedSlug, tenantName]
        );
        tenant = tenantResult.rows[0];
      } catch (error) {
        if (error.code !== "23505") throw error;
      }
    }
    if (!tenant) throw new Error("Unable to allocate a unique tenant slug for self-serve provisioning.");
    const userResult = await client.query(
      `INSERT INTO users (auth_subject, email, display_name, last_login_at)
       VALUES ($1, $2, $3, now())
       RETURNING id, auth_subject, email, display_name`,
      [authSubject, email || null, displayName || null]
    );
    const user = userResult.rows[0];
    const membershipResult = await client.query(
      `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'tenant_owner') RETURNING id AS membership_id, role`,
      [user.id, tenant.id]
    );
    const membership = membershipResult.rows[0];
    await client.query(`UPDATE customer_invites SET accepted_tenant_id = $2 WHERE id = $1`, [invite.id, tenant.id]);
    await client.query(
      `INSERT INTO audit_events (actor_user_id, tenant_id, action, result, metadata)
       VALUES ($1, $2, 'tenant.self_serve_provisioned', 'success', $3::jsonb)`,
      [user.id, tenant.id, JSON.stringify({ slug: usedSlug, inviteId: invite.id })]
    );
    return { ...user, ...membership, tenant_id: tenant.id, tenant_name: tenant.display_name };
  }

  async findInvitedLocationId(tenantId) {
    const { rows } = await this.pool.query(
      `SELECT default_location_id FROM customer_invites WHERE accepted_tenant_id = $1 LIMIT 1`,
      [tenantId]
    );
    return rows[0]?.default_location_id || null;
  }

  async recordAuditEvent({ actorUserId = null, tenantId = null, toolName = null, action, result, requestId = null, metadata = {} }) {
    await this.pool.query(
      `INSERT INTO audit_events (actor_user_id, tenant_id, tool_name, action, result, request_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [actorUserId, tenantId, toolName, action, result, requestId, JSON.stringify(metadata)]
    );
  }

  async updateEncryptedCredential(credentialId, encryptedPayload, expiresAt) {
    await this.pool.query(
      `UPDATE tenant_credentials
          SET encrypted_payload = $2, encryption_version = 1, expires_at = $3, last_rotated_at = now(), updated_at = now()
        WHERE id = $1`,
      [credentialId, encryptedPayload, expiresAt]
    );
  }

  async createOAuthState({ stateHash, tenantId, actorUserId, expiresAt, intendedLocationId = null }) {
    await this.pool.query(
      `INSERT INTO oauth_states (state_hash, tenant_id, actor_user_id, provider, expires_at, intended_location_id)
       VALUES ($1, $2, $3, 'highlevel', $4, $5)`,
      [stateHash, tenantId, actorUserId, expiresAt, intendedLocationId]
    );
  }

  async consumeOAuthState(stateHash) {
    const { rows } = await this.pool.query(
      `UPDATE oauth_states
          SET used_at = now()
        WHERE state_hash = $1 AND provider = 'highlevel' AND used_at IS NULL AND expires_at > now()
      RETURNING tenant_id, actor_user_id, intended_location_id`,
      [stateHash]
    );
    return rows[0] || null;
  }

  async saveHighLevelOAuthConnection({ tenantId, locationId, encryptedPayload, expiresAt, scopes, defaultUserId = null }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.#saveConnection(client, { tenantId, locationId, encryptedPayload, expiresAt, scopes, defaultUserId });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async #saveConnection(client, { tenantId, locationId, encryptedPayload, expiresAt, scopes, defaultUserId = null }) {
    const previous = await client.query(
      `SELECT credential_id FROM connections
        WHERE tenant_id = $1 AND provider = 'highlevel'
        FOR UPDATE`,
      [tenantId]
    );
    const credential = await client.query(
      `INSERT INTO tenant_credentials (secret_backend, secret_ref, credential_type, encrypted_payload, encryption_version, expires_at)
       VALUES ('encrypted_database', $1, 'oauth2', $2, 1, $3)
       RETURNING id`,
      [`encrypted://highlevel/${tenantId}/${Date.now()}`, encryptedPayload, expiresAt]
    );
    await client.query(
      `INSERT INTO connections (tenant_id, provider, external_location_id, auth_type, status, scopes, credential_id, default_user_id)
       VALUES ($1, 'highlevel', $2, 'oauth2', 'active', $3, $4, $5)
       ON CONFLICT (tenant_id, provider) DO UPDATE SET
         external_location_id = EXCLUDED.external_location_id,
         auth_type = 'oauth2', status = 'active', scopes = EXCLUDED.scopes,
         credential_id = EXCLUDED.credential_id,
         default_user_id = COALESCE(EXCLUDED.default_user_id, connections.default_user_id),
         updated_at = now()`,
      [tenantId, locationId, scopes, credential.rows[0].id, defaultUserId]
    );
    const previousCredentialId = previous.rows[0]?.credential_id;
    if (previousCredentialId && previousCredentialId !== credential.rows[0].id) {
      await client.query(
        `DELETE FROM tenant_credentials tc
          WHERE tc.id = $1
            AND NOT EXISTS (SELECT 1 FROM connections c WHERE c.credential_id = tc.id)`,
        [previousCredentialId]
      );
    }
  }

  // ---- Built-in OAuth authorization server storage -------------------------

  async registerOAuthClient({ clientId, clientName, redirectUris }) {
    await this.pool.query(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, $2, $3)`,
      [clientId, clientName || null, redirectUris]
    );
  }

  async findOAuthClient(clientId) {
    const { rows } = await this.pool.query(
      `SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = $1`,
      [clientId]
    );
    return rows[0] || null;
  }

  async createLoginRequest({ stateHash, clientId, redirectUri, codeChallenge, clientState, resource, expiresAt }) {
    await this.pool.query(
      `INSERT INTO oauth_login_requests (state_hash, client_id, redirect_uri, code_challenge, client_state, resource, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [stateHash, clientId, redirectUri, codeChallenge, clientState || null, resource || null, expiresAt]
    );
  }

  async consumeLoginRequest(stateHash) {
    const { rows } = await this.pool.query(
      `UPDATE oauth_login_requests SET used_at = now()
        WHERE state_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING client_id, redirect_uri, code_challenge, client_state, resource`,
      [stateHash]
    );
    return rows[0] || null;
  }

  // One transaction: identify the HighLevel user, find or create the tenant
  // that owns this sub-account, join the user to it, and store the freshly
  // granted HighLevel credential. Logging in and connecting are the same step.
  async provisionHighLevelLogin({
    subject, email, displayName, locationId, newMemberRole, tenantName, allowCreateTenant,
    encryptedPayload, expiresAt, scopes, defaultUserId = null
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const userResult = await client.query(
        `INSERT INTO users (auth_subject, email, display_name, last_login_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (auth_subject) DO UPDATE SET
           email = COALESCE(EXCLUDED.email, users.email),
           display_name = COALESCE(EXCLUDED.display_name, users.display_name),
           last_login_at = now(), updated_at = now()
         RETURNING id, status`,
        [subject, email || null, displayName || null]
      );
      const user = userResult.rows[0];
      if (user.status !== "active") throw new TenantAuthorizationError("User account is not active.", "USER_INACTIVE");

      const existing = await client.query(
        `SELECT c.tenant_id, t.status AS tenant_status
           FROM connections c JOIN tenants t ON t.id = c.tenant_id
          WHERE c.provider = 'highlevel' AND c.external_location_id = $1`,
        [locationId]
      );
      let tenantId;
      let created = false;
      if (existing.rowCount > 0) {
        if (existing.rows[0].tenant_status !== "active") throw new TenantAuthorizationError("This account is suspended.", "TENANT_INACTIVE");
        tenantId = existing.rows[0].tenant_id;
      } else {
        if (!allowCreateTenant) throw new TenantAuthorizationError("Self-serve sign-up is disabled.", "SIGNUP_DISABLED");
        const baseSlug = slugify(tenantName);
        let tenant;
        for (let attempt = 0; attempt < 5 && !tenant; attempt += 1) {
          const slug = attempt === 0 ? baseSlug : `${baseSlug}-${randomBytes(3).toString("hex")}`;
          const inserted = await client.query(
            `INSERT INTO tenants (slug, display_name) VALUES ($1, $2)
             ON CONFLICT (slug) DO NOTHING RETURNING id`,
            [slug, tenantName]
          );
          tenant = inserted.rows[0];
        }
        if (!tenant) throw new Error("Unable to allocate a unique tenant slug.");
        tenantId = tenant.id;
        created = true;
      }

      const memberCount = await client.query(
        `SELECT count(*)::int AS n FROM memberships WHERE tenant_id = $1 AND status = 'active'`,
        [tenantId]
      );
      const role = created || memberCount.rows[0].n === 0 ? "tenant_owner" : newMemberRole;
      await client.query(
        `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, tenant_id) DO NOTHING`,
        [user.id, tenantId, role]
      );
      const membership = await client.query(
        `SELECT role, status FROM memberships WHERE user_id = $1 AND tenant_id = $2`,
        [user.id, tenantId]
      );
      if (membership.rows[0].status !== "active") throw new TenantAuthorizationError("Your access to this account was revoked.", "MEMBERSHIP_REVOKED");

      await this.#saveConnection(client, { tenantId, locationId, encryptedPayload, expiresAt, scopes, defaultUserId });
      await client.query(
        `INSERT INTO audit_events (actor_user_id, tenant_id, action, result, metadata)
         VALUES ($1, $2, $3, 'success', $4::jsonb)`,
        [user.id, tenantId, created ? "tenant.self_serve_provisioned" : "highlevel.login", JSON.stringify({ locationId, role: membership.rows[0].role })]
      );
      await client.query("COMMIT");
      return { userId: user.id, tenantId, role: membership.rows[0].role, created };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async createAuthCode({ codeHash, clientId, redirectUri, codeChallenge, userId, tenantId, expiresAt }) {
    await this.pool.query(
      `INSERT INTO oauth_auth_codes (code_hash, client_id, redirect_uri, code_challenge, user_id, tenant_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [codeHash, clientId, redirectUri, codeChallenge, userId, tenantId, expiresAt]
    );
  }

  async consumeAuthCode(codeHash) {
    const { rows } = await this.pool.query(
      `UPDATE oauth_auth_codes SET used_at = now()
        WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING client_id, redirect_uri, code_challenge, user_id, tenant_id`,
      [codeHash]
    );
    return rows[0] || null;
  }

  async insertOAuthToken({ tokenHash, kind, familyId, clientId, userId, tenantId, expiresAt }) {
    await this.pool.query(
      `INSERT INTO oauth_tokens (token_hash, kind, family_id, client_id, user_id, tenant_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tokenHash, kind, familyId, clientId, userId, tenantId, expiresAt]
    );
  }

  async findAccessToken(tokenHash) {
    const { rows } = await this.pool.query(
      `SELECT user_id, tenant_id, client_id FROM oauth_tokens
        WHERE token_hash = $1 AND kind = 'access' AND revoked_at IS NULL AND expires_at > now()`,
      [tokenHash]
    );
    return rows[0] || null;
  }

  // Returns the token's owner when it is a live, unused refresh token (and
  // marks it used). A refresh token that was already used is being replayed:
  // revoke its whole family and report nothing.
  async consumeRefreshToken(tokenHash) {
    const { rows } = await this.pool.query(
      `UPDATE oauth_tokens SET used_at = now()
        WHERE token_hash = $1 AND kind = 'refresh' AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
      RETURNING family_id, client_id, user_id, tenant_id`,
      [tokenHash]
    );
    if (rows[0]) return rows[0];
    await this.pool.query(
      `UPDATE oauth_tokens SET revoked_at = now()
        WHERE revoked_at IS NULL AND family_id = (
          SELECT family_id FROM oauth_tokens WHERE token_hash = $1 AND kind = 'refresh' AND used_at IS NOT NULL)`,
      [tokenHash]
    );
    return null;
  }

  async resolvePrincipalForUserTenant(userId, tenantId) {
    const { rows } = await this.pool.query(
      `SELECT u.id, u.auth_subject, u.email, m.id AS membership_id, m.role, t.id AS tenant_id, t.display_name AS tenant_name, t.plan
         FROM users u
         JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $2 AND m.status = 'active'
         JOIN tenants t ON t.id = m.tenant_id AND t.status = 'active'
        WHERE u.id = $1 AND u.status = 'active'`,
      [userId, tenantId]
    );
    return rows[0] || null;
  }

  // Usage counters (Phase 1 pricing foundation -- see migration 009). One row
  // per tenant/metric/calendar-month; `period` is 'YYYY-MM' in UTC, computed
  // by the caller so this stays a plain increment. Counting failures must
  // never block the feature that triggered them, so callers should treat
  // this as best-effort and not await it inline with the user-facing result.
  async incrementUsage({ tenantId, metric, period, by = 1 }) {
    await this.pool.query(
      `INSERT INTO tenant_usage_counters (tenant_id, metric, period, count)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, metric, period)
       DO UPDATE SET count = tenant_usage_counters.count + EXCLUDED.count, updated_at = now()`,
      [tenantId, metric, period, by]
    );
  }

  async getUsage({ tenantId, metric, period }) {
    const { rows } = await this.pool.query(
      `SELECT count FROM tenant_usage_counters WHERE tenant_id = $1 AND metric = $2 AND period = $3`,
      [tenantId, metric, period]
    );
    return rows[0]?.count ?? 0;
  }

  async recordAgentPosts(tenantId, posts) {
    for (const post of posts) {
      if (!post.postId) continue;
      await this.pool.query(
        `INSERT INTO agent_posts (tenant_id, post_id, platform) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, post_id) DO NOTHING`,
        [tenantId, post.postId, post.platform || null]
      );
    }
  }

  async findAgentPostIds(tenantId, postIds) {
    if (!postIds.length) return new Set();
    const { rows } = await this.pool.query(`SELECT post_id FROM agent_posts WHERE tenant_id = $1 AND post_id = ANY($2::text[])`, [tenantId, postIds]);
    return new Set(rows.map((row) => row.post_id));
  }

  async countActiveMemberships(tenantId) {
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS n FROM memberships WHERE tenant_id = $1 AND status = 'active'`,
      [tenantId]
    );
    return rows[0]?.n ?? 0;
  }

  // ---- Plan limits (admin panel) --------------------------------------------

  async getPlanLimits() {
    const { rows } = await this.pool.query(`SELECT plan, max_users, max_posts_per_month FROM plan_limits`);
    const byPlan = {};
    for (const row of rows) byPlan[row.plan] = { maxUsers: row.max_users, maxPostsPerMonth: row.max_posts_per_month };
    return byPlan;
  }

  async setPlanLimit({ plan, maxUsers, maxPostsPerMonth }) {
    await this.pool.query(
      `INSERT INTO plan_limits (plan, max_users, max_posts_per_month)
       VALUES ($1, $2, $3)
       ON CONFLICT (plan) DO UPDATE SET max_users = EXCLUDED.max_users, max_posts_per_month = EXCLUDED.max_posts_per_month, updated_at = now()`,
      [plan, maxUsers, maxPostsPerMonth]
    );
  }

  async setTenantPlan(tenantId, plan) {
    await this.pool.query(`UPDATE tenants SET plan = $1, updated_at = now() WHERE id = $2`, [plan, tenantId]);
  }

  // Admin panel's tenant listing -- one row per tenant with its plan and this
  // month's usage, so an admin can see who is near a limit without guessing.
  async listTenantsForAdmin(period) {
    const { rows } = await this.pool.query(
      `SELECT t.id, t.display_name, t.plan, t.status,
              (SELECT count(*)::int FROM memberships m WHERE m.tenant_id = t.id AND m.status = 'active') AS member_count,
              COALESCE((SELECT count FROM tenant_usage_counters u WHERE u.tenant_id = t.id AND u.metric = 'posts_created' AND u.period = $1), 0) AS posts_this_period
         FROM tenants t
        ORDER BY t.created_at DESC`,
      [period]
    );
    return rows.map((row) => ({
      id: row.id, displayName: row.display_name, plan: row.plan, status: row.status,
      memberCount: row.member_count, postsThisPeriod: row.posts_this_period
    }));
  }

  async deleteExpiredOAuthArtifacts() {
    await this.pool.query(`DELETE FROM oauth_tokens WHERE expires_at < now() - interval '1 day'`);
    await this.pool.query(`DELETE FROM oauth_auth_codes WHERE expires_at < now() - interval '1 day'`);
    await this.pool.query(`DELETE FROM oauth_login_requests WHERE expires_at < now() - interval '1 day'`);
    await this.pool.query(`DELETE FROM team_invites WHERE expires_at < now() - interval '7 day' AND status <> 'accepted'`);
    await this.pool.query(`DELETE FROM email_login_tokens WHERE expires_at < now() - interval '1 day'`);
  }

  // ---- Team invites (email-based, no HighLevel Admin needed) ---------------

  async createTeamInvite({ tokenHash, tenantId, email, role, invitedByUserId, expiresAt }) {
    await this.pool.query(
      `INSERT INTO team_invites (token_hash, tenant_id, email, role, invited_by_user_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tokenHash, tenantId, email, role, invitedByUserId, expiresAt]
    );
  }

  // One transaction: consume the invite, create (or find) the user by email,
  // and grant membership. A person can hold at most one active membership
  // per tenant; re-accepting an invite for the same tenant is a no-op on the
  // membership row (COALESCE keeps whichever role was already granted).
  async acceptTeamInvite(tokenHash) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inviteResult = await client.query(
        `UPDATE team_invites SET status = 'accepted', accepted_at = now()
          WHERE token_hash = $1 AND status = 'pending' AND expires_at > now()
        RETURNING id, tenant_id, email, role`,
        [tokenHash]
      );
      const invite = inviteResult.rows[0];
      if (!invite) { await client.query("ROLLBACK"); return null; }
      const userResult = await client.query(
        `INSERT INTO users (auth_subject, email, last_login_at)
         VALUES ($1, $2, now())
         ON CONFLICT (auth_subject) DO UPDATE SET email = EXCLUDED.email, updated_at = now()
         RETURNING id, status`,
        [`email:${invite.email.toLowerCase()}`, invite.email]
      );
      const user = userResult.rows[0];
      if (user.status !== "active") throw new TenantAuthorizationError("User account is not active.", "USER_INACTIVE");
      await client.query(
        `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, tenant_id) DO NOTHING`,
        [user.id, invite.tenant_id, invite.role]
      );
      const tenant = await client.query(`SELECT display_name FROM tenants WHERE id = $1`, [invite.tenant_id]);
      await client.query(
        `INSERT INTO audit_events (actor_user_id, tenant_id, action, result, metadata)
         VALUES ($1, $2, 'team_invite.accepted', 'success', $3::jsonb)`,
        [user.id, invite.tenant_id, JSON.stringify({ inviteId: invite.id, role: invite.role })]
      );
      await client.query("COMMIT");
      return { userId: user.id, tenantId: invite.tenant_id, tenantName: tenant.rows[0]?.display_name || null, role: invite.role };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // Used only by the email-login path: an email is expected to resolve to
  // exactly one active membership. Zero or more than one both report "not
  // found" -- an ambiguous match is not safe to silently pick between.
  async findSoleMembershipByEmail(email) {
    const { rows } = await this.pool.query(
      `SELECT u.id AS user_id, m.tenant_id, m.role, t.display_name AS tenant_name
         FROM users u
         JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
         JOIN tenants t ON t.id = m.tenant_id AND t.status = 'active'
        WHERE lower(u.email) = lower($1) AND u.status = 'active'`,
      [email]
    );
    return rows.length === 1 ? rows[0] : null;
  }

  async createEmailLoginToken({ tokenHash, pollHash = null, clientId, redirectUri, codeChallenge, clientState, userId, tenantId, expiresAt }) {
    await this.pool.query(
      `INSERT INTO email_login_tokens (token_hash, poll_hash, client_id, redirect_uri, code_challenge, client_state, user_id, tenant_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [tokenHash, pollHash, clientId, redirectUri, codeChallenge, clientState || null, userId, tenantId, expiresAt]
    );
  }

  async storeEmailLoginCompletion(tokenHash, redirectUrl) {
    await this.pool.query(`UPDATE email_login_tokens SET completed_redirect = $2 WHERE token_hash = $1`, [tokenHash, redirectUrl]);
  }

  // Hands the finished redirect to whoever holds the poll secret, exactly once.
  async takeEmailLoginCompletion(pollHash) {
    const { rows } = await this.pool.query(
      `WITH taken AS (
         SELECT token_hash, completed_redirect FROM email_login_tokens
          WHERE poll_hash = $1 AND completed_redirect IS NOT NULL FOR UPDATE
       ), cleared AS (
         UPDATE email_login_tokens SET completed_redirect = NULL
          WHERE token_hash IN (SELECT token_hash FROM taken)
       )
       SELECT completed_redirect AS redirect FROM taken`,
      [pollHash]
    );
    return rows[0]?.redirect || null;
  }

  async consumeEmailLoginToken(tokenHash) {
    const { rows } = await this.pool.query(
      `UPDATE email_login_tokens SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING client_id, redirect_uri, code_challenge, client_state, user_id, tenant_id, poll_hash`,
      [tokenHash]
    );
    return rows[0] || null;
  }

  async close() {
    await this.pool.end();
  }
}

export class InMemoryConnectionRepository {
  constructor(connections = []) {
    this.connections = connections.map((item) => ({ ...item }));
  }

  async findActiveConnectionByTenantId(tenantId) {
    return this.connections.find((item) => item.tenant_id === tenantId && item.tenant_status !== "suspended" && item.connection_status !== "disabled") || null;
  }

  async findActiveConnectionByLocationId(locationId) {
    return this.connections.find((item) => item.location_id === locationId && item.tenant_status !== "suspended" && item.connection_status !== "disabled") || null;
  }
}

export class EnvironmentCredentialProvider {
  constructor(env = process.env) {
    this.env = env;
  }

  async getAccess(connection) {
    if (!connection || connection.secret_backend !== "environment") throw new Error("Unsupported credential backend.");
    const match = /^env:\/\/([A-Z][A-Z0-9_]*)$/.exec(connection.secret_ref || "");
    if (!match) throw new Error("Invalid environment credential reference.");
    const accessToken = this.env[match[1]];
    if (!accessToken) throw new Error(`Credential is not configured for connection ${connection.connection_id}.`);
    return {
      accessToken,
      locationId: connection.location_id,
      scopes: connection.scopes || [],
      expiresAt: connection.expires_at || null
    };
  }
}

export function legacyConnectionsFromEnv(env = process.env) {
  const definitions = [{
    tenant_id: LEGACY_123_GYM_TENANT_ID,
    tenant_name: "123 GYM",
    connection_id: "legacy-123-gym",
    location_id: LEGACY_123_GYM_LOCATION_ID,
    secret_backend: "environment",
    secret_ref: "env://LC_PRIVATE_TOKEN",
    credential_type: "private_integration_token",
    tenant_status: "active",
    connection_status: "active",
    scopes: [],
    default_user_id: env.LC_DEFAULT_USER_ID || null
  }];
  if (env.LC_TENANTS_JSON) {
    let configured;
    try { configured = JSON.parse(env.LC_TENANTS_JSON); } catch { throw new Error("LC_TENANTS_JSON is not valid JSON."); }
    for (const [locationId, tenant] of Object.entries(configured || {})) {
      if (!tenant?.tokenEnv || !/^[A-Z][A-Z0-9_]*$/.test(tenant.tokenEnv)) throw new Error("LC_TENANTS_JSON contains an invalid tenant definition.");
      const existing = definitions.find((item) => item.location_id === locationId);
      const item = {
        tenant_id: tenant.tenantId || `legacy:${locationId}`,
        tenant_name: String(tenant.name || locationId),
        connection_id: `legacy:${locationId}`,
        location_id: locationId,
        secret_backend: "environment",
        secret_ref: `env://${tenant.tokenEnv}`,
        credential_type: "private_integration_token",
        tenant_status: "active",
        connection_status: "active",
        scopes: [],
        default_user_id: tenant.defaultUserId || null
      };
      if (existing) Object.assign(existing, item);
      else definitions.push(item);
    }
  }
  return definitions;
}

export function createTenantServices(env = process.env, overrides = {}) {
  const repository = overrides.repository || (env.DATABASE_URL
    ? new PostgresConnectionRepository({ connectionString: env.DATABASE_URL })
    : new InMemoryConnectionRepository(legacyConnectionsFromEnv(env)));
  const credentialProvider = overrides.credentialProvider || new CompositeCredentialProvider({ env, repository });
  return { repository, credentialProvider };
}

export async function authorizeUserPrincipal({ identity, repository, allowSelfServeProvisioning = false }) {
  const authorization = await repository.resolveUserAuthorization({
    authSubject: identity.subject,
    tenantIdClaim: identity.tenantIdClaim,
    email: identity.email,
    displayName: identity.displayName,
    emailVerified: identity.emailVerified,
    allowSelfServeProvisioning
  });
  return Object.freeze({
    authType: "oauth",
    userId: authorization.id,
    subject: authorization.auth_subject,
    email: authorization.email,
    tenantId: authorization.tenant_id,
    tenantName: authorization.tenant_name,
    membershipId: authorization.membership_id,
    role: authorization.role,
    scopes: identity.scopes
  });
}

export async function authorizeTenantContext({ tenantId, requestedLocationId, repository, credentialProvider, actor = null }) {
  if (!tenantId) throw new TenantAuthorizationError("Authorized tenant is required.", "TENANT_CONTEXT_MISSING");
  const connection = await repository.findActiveConnectionByTenantId(tenantId);
  if (!connection) throw new TenantAuthorizationError("No active connection exists for the authorized tenant.", "CONNECTION_NOT_FOUND");
  if (requestedLocationId && requestedLocationId !== connection.location_id) {
    throw new TenantAuthorizationError("Cross-tenant location access blocked.");
  }
  const credential = await credentialProvider.getAccess(connection);
  if (credential.locationId !== connection.location_id) throw new TenantAuthorizationError("Credential location binding mismatch.");
  return Object.freeze({
    tenantId: connection.tenant_id,
    tenantName: connection.tenant_name,
    connectionId: connection.connection_id,
    locationId: connection.location_id,
    accessToken: credential.accessToken,
    scopes: credential.scopes,
    defaultUserId: connection.default_user_id || null,
    actor
  });
}

export async function authorizeLegacyAdminContext({ requestedLocationId, repository, credentialProvider, defaultLocationId = LEGACY_123_GYM_LOCATION_ID }) {
  const locationId = requestedLocationId || defaultLocationId;
  const connection = await repository.findActiveConnectionByLocationId(locationId);
  if (!connection) throw new TenantAuthorizationError("Unknown or unauthorized locationId.");
  return authorizeTenantContext({ tenantId: connection.tenant_id, requestedLocationId: locationId, repository, credentialProvider, actor: { type: "legacy_admin" } });
}
