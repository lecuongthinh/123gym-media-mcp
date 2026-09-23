import pg from "pg";

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
              c.auth_type, c.scopes, tc.secret_backend, tc.secret_ref, tc.credential_type, tc.expires_at
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
              c.auth_type, c.scopes, tc.secret_backend, tc.secret_ref, tc.credential_type, tc.expires_at
         FROM tenants t
         JOIN connections c ON c.tenant_id = t.id AND c.provider = 'highlevel'
         JOIN tenant_credentials tc ON tc.id = c.credential_id
        WHERE c.external_location_id = $1 AND t.status = 'active' AND c.status = 'active'
        LIMIT 1`,
      [locationId]
    );
    return rows[0] || null;
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
  const credentialProvider = overrides.credentialProvider || new EnvironmentCredentialProvider(env);
  return { repository, credentialProvider };
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
