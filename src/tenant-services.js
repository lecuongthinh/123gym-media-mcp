import pg from "pg";
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

export class PostgresConnectionRepository {
  constructor({ connectionString, pool } = {}) {
    if (!pool && !connectionString) throw new Error("DATABASE_URL is required for the database tenant registry.");
    this.pool = pool || new Pool({ connectionString, ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined });
  }

  async findActiveConnectionByTenantId(tenantId) {
    const { rows } = await this.pool.query(
      `SELECT t.id AS tenant_id, t.display_name AS tenant_name, t.status AS tenant_status,
              c.id AS connection_id, c.external_location_id AS location_id, c.status AS connection_status,
              c.auth_type, c.scopes, tc.id AS credential_id, tc.secret_backend, tc.secret_ref,
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
              c.auth_type, c.scopes, tc.id AS credential_id, tc.secret_backend, tc.secret_ref,
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

  async resolveUserAuthorization({ authSubject, tenantIdClaim, email, displayName }) {
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
      if (!user) throw new TenantAuthorizationError("Authenticated user is not provisioned or is inactive.", "USER_NOT_PROVISIONED");
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

  async createOAuthState({ stateHash, tenantId, actorUserId, expiresAt }) {
    await this.pool.query(
      `INSERT INTO oauth_states (state_hash, tenant_id, actor_user_id, provider, expires_at)
       VALUES ($1, $2, $3, 'highlevel', $4)`,
      [stateHash, tenantId, actorUserId, expiresAt]
    );
  }

  async consumeOAuthState(stateHash) {
    const { rows } = await this.pool.query(
      `UPDATE oauth_states
          SET used_at = now()
        WHERE state_hash = $1 AND provider = 'highlevel' AND used_at IS NULL AND expires_at > now()
      RETURNING tenant_id, actor_user_id`,
      [stateHash]
    );
    return rows[0] || null;
  }

  async saveHighLevelOAuthConnection({ tenantId, locationId, encryptedPayload, expiresAt, scopes }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
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
        `INSERT INTO connections (tenant_id, provider, external_location_id, auth_type, status, scopes, credential_id)
         VALUES ($1, 'highlevel', $2, 'oauth2', 'active', $3, $4)
         ON CONFLICT (tenant_id, provider) DO UPDATE SET
           external_location_id = EXCLUDED.external_location_id,
           auth_type = 'oauth2', status = 'active', scopes = EXCLUDED.scopes,
           credential_id = EXCLUDED.credential_id, updated_at = now()`,
        [tenantId, locationId, scopes, credential.rows[0].id]
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
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
    if (!accessToken) throw new Error(`HighLevel credential is not configured for connection ${connection.connection_id}.`);
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
    scopes: []
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
        scopes: []
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

export async function authorizeUserPrincipal({ identity, repository }) {
  const authorization = await repository.resolveUserAuthorization({
    authSubject: identity.subject,
    tenantIdClaim: identity.tenantIdClaim,
    email: identity.email,
    displayName: identity.displayName
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
  if (!connection) throw new TenantAuthorizationError("No active HighLevel connection exists for the authorized tenant.", "CONNECTION_NOT_FOUND");
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
    actor
  });
}

export async function authorizeLegacyAdminContext({ requestedLocationId, repository, credentialProvider, defaultLocationId = LEGACY_123_GYM_LOCATION_ID }) {
  const locationId = requestedLocationId || defaultLocationId;
  const connection = await repository.findActiveConnectionByLocationId(locationId);
  if (!connection) throw new TenantAuthorizationError("Unknown or unauthorized locationId.");
  return authorizeTenantContext({ tenantId: connection.tenant_id, requestedLocationId: locationId, repository, credentialProvider, actor: { type: "legacy_admin" } });
}
