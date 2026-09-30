import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { listMedia } from "./server.js";
import {
  authorizeTenantContext,
  EnvironmentCredentialProvider,
  InMemoryConnectionRepository,
  LEGACY_123_GYM_TENANT_ID,
  PostgresConnectionRepository,
  TenantAuthorizationError
} from "./src/tenant-services.js";

const GYM_LOCATION = "pUePVc6UKEUecvZS6EYU";
const TEST_LOCATION = "UwsfBVLmz7XSKJbhuOTS";
const TEST_TENANT_ID = "00000000-0000-4000-8000-000000000124";

function connection(tenantId, tenantName, locationId, envName, defaultUserId = null) {
  return {
    tenant_id: tenantId,
    tenant_name: tenantName,
    connection_id: `connection:${tenantId}`,
    location_id: locationId,
    tenant_status: "active",
    connection_status: "active",
    secret_backend: "environment",
    secret_ref: `env://${envName}`,
    credential_type: "private_integration_token",
    scopes: ["social:read", "media:read"],
    default_user_id: defaultUserId
  };
}

function pilotServices(env = {}) {
  return {
    repository: new InMemoryConnectionRepository([
      connection(LEGACY_123_GYM_TENANT_ID, "123 GYM", GYM_LOCATION, "LC_PRIVATE_TOKEN"),
      connection(TEST_TENANT_ID, "Testing Agency", TEST_LOCATION, "LC_PRIVATE_TOKEN_TESTING_AGENCY", "tenant-default-user-id")
    ]),
    credentialProvider: new EnvironmentCredentialProvider({
      LC_PRIVATE_TOKEN: "gym-routing-token",
      LC_PRIVATE_TOKEN_TESTING_AGENCY: "testing-routing-token",
      ...env
    })
  };
}

test("authorized tenant context routes 123 GYM to its own credential", async () => {
  const context = await authorizeTenantContext({ tenantId: LEGACY_123_GYM_TENANT_ID, requestedLocationId: GYM_LOCATION, ...pilotServices() });
  assert.equal(context.locationId, GYM_LOCATION);
  assert.equal(context.accessToken, "gym-routing-token");
  assert.equal(context.tenantName, "123 GYM");
});

test("authorized tenant context routes Testing Agency to its own credential", async () => {
  const context = await authorizeTenantContext({ tenantId: TEST_TENANT_ID, requestedLocationId: TEST_LOCATION, ...pilotServices() });
  assert.equal(context.locationId, TEST_LOCATION);
  assert.equal(context.accessToken, "testing-routing-token");
  assert.equal(context.tenantName, "Testing Agency");
  assert.equal(context.defaultUserId, "tenant-default-user-id");
});

test("authorized tenant context reports no default_user_id when the tenant has not configured one", async () => {
  const context = await authorizeTenantContext({ tenantId: LEGACY_123_GYM_TENANT_ID, requestedLocationId: GYM_LOCATION, ...pilotServices() });
  assert.equal(context.defaultUserId, null);
});

test("authorized tenant cannot switch locationId to another tenant", async () => {
  await assert.rejects(
    () => authorizeTenantContext({ tenantId: LEGACY_123_GYM_TENANT_ID, requestedLocationId: TEST_LOCATION, ...pilotServices() }),
    (error) => error instanceof TenantAuthorizationError && error.code === "TENANT_FORBIDDEN"
  );
});

test("tool rejects locationId different from its authorized context before upstream fetch", async () => {
  const context = await authorizeTenantContext({ tenantId: TEST_TENANT_ID, requestedLocationId: TEST_LOCATION, ...pilotServices() });
  let fetchCalled = false;
  const originalFetch = global.fetch;
  global.fetch = async () => { fetchCalled = true; throw new Error("must not be called"); };
  try {
    await assert.rejects(() => listMedia({ locationId: GYM_LOCATION }, context), /Cross-tenant location access blocked/);
    assert.equal(fetchCalled, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("credential routing fails closed when selected tenant secret is missing", async () => {
  const services = pilotServices({ LC_PRIVATE_TOKEN_TESTING_AGENCY: undefined });
  await assert.rejects(
    () => authorizeTenantContext({ tenantId: TEST_TENANT_ID, requestedLocationId: TEST_LOCATION, ...services }),
    /Credential is not configured/
  );
});

test("pilot seed stores secret references and no raw credentials", async () => {
  const seed = await readFile(new URL("./migrations/002_seed_pilot_tenants.sql", import.meta.url), "utf8");
  assert.match(seed, /env:\/\/LC_PRIVATE_TOKEN/);
  assert.match(seed, /env:\/\/LC_PRIVATE_TOKEN_TESTING_AGENCY/);
  assert.doesNotMatch(seed, /Bearer\s+|eyJ[a-zA-Z0-9_-]+\./);
});

test("OAuth security migration is additive, enables RLS, and revokes Data API roles", async () => {
  const migration = await readFile(new URL("./migrations/003_oauth_security.sql", import.meta.url), "utf8");
  assert.doesNotMatch(migration, /\b(?:DELETE\s+FROM|TRUNCATE|DROP\s+TABLE)\b/i);
  for (const table of ["users", "tenants", "memberships", "connections", "tenant_credentials", "audit_events", "schema_migrations", "oauth_states"]) {
    assert.match(migration, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, "i"));
  }
  assert.match(migration, /FROM anon, authenticated/i);
  assert.match(migration, /encrypted_payload bytea/i);
  assert.doesNotMatch(migration, /Bearer\s+[A-Za-z0-9._-]{20,}|eyJ[A-Za-z0-9_-]+\./);
});

function createFakePool(seed = {}) {
  const state = {
    tenants: [...(seed.tenants || [])],
    users: [...(seed.users || [])],
    memberships: [...(seed.memberships || [])],
    invites: (seed.invites || []).map((invite) => ({ status: "pending", tenant_display_name: null, ...invite })),
    auditEvents: []
  };
  let nextId = 1;
  const genId = () => `generated-${nextId++}`;
  async function run(sql, params = []) {
    const text = sql.replace(/\s+/g, " ").trim();
    if (text === "BEGIN" || text === "COMMIT" || text.startsWith("ROLLBACK")) return { rows: [] };
    if (text.startsWith("UPDATE users")) {
      const [authSubject, email, displayName] = params;
      const user = state.users.find((u) => u.auth_subject === authSubject && u.status === "active");
      if (!user) return { rows: [], rowCount: 0 };
      if (email) user.email = email;
      if (displayName) user.display_name = displayName;
      return { rows: [{ id: user.id, auth_subject: user.auth_subject, email: user.email, display_name: user.display_name }] };
    }
    if (text.startsWith("SELECT 1 FROM users WHERE auth_subject")) {
      const [authSubject] = params;
      const exists = state.users.some((u) => u.auth_subject === authSubject);
      return { rows: exists ? [{}] : [], rowCount: exists ? 1 : 0 };
    }
    if (text.startsWith("SELECT m.id AS membership_id")) {
      const [userId] = params;
      const rows = state.memberships
        .filter((m) => m.user_id === userId && m.status === "active")
        .map((m) => {
          const tenant = state.tenants.find((t) => t.id === m.tenant_id && t.status === "active");
          return tenant ? { membership_id: m.id, role: m.role, tenant_id: tenant.id, tenant_name: tenant.display_name } : null;
        })
        .filter(Boolean);
      return { rows, rowCount: rows.length };
    }
    if (text.startsWith("UPDATE customer_invites SET status = 'accepted'")) {
      const [email] = params;
      const invite = state.invites.find((i) => i.email.toLowerCase() === String(email).toLowerCase() && i.status === "pending");
      if (!invite) return { rows: [] };
      invite.status = "accepted";
      return { rows: [{ id: invite.id, tenant_display_name: invite.tenant_display_name }] };
    }
    if (text.startsWith("UPDATE customer_invites SET accepted_tenant_id")) {
      const [inviteId, tenantId] = params;
      state.invites.find((i) => i.id === inviteId).accepted_tenant_id = tenantId;
      return { rows: [] };
    }
    if (text.startsWith("INSERT INTO tenants")) {
      const [slug, displayName] = params;
      if (state.tenants.some((t) => t.slug === slug)) {
        const error = new Error("duplicate key value violates unique constraint");
        error.code = "23505";
        throw error;
      }
      const tenant = { id: genId(), slug, display_name: displayName, status: "active" };
      state.tenants.push(tenant);
      return { rows: [{ id: tenant.id, display_name: tenant.display_name }] };
    }
    if (text.startsWith("INSERT INTO users")) {
      const [authSubject, email, displayName] = params;
      const user = { id: genId(), auth_subject: authSubject, email, display_name: displayName, status: "active" };
      state.users.push(user);
      return { rows: [{ id: user.id, auth_subject: user.auth_subject, email: user.email, display_name: user.display_name }] };
    }
    if (text.startsWith("INSERT INTO memberships")) {
      const [userId, tenantId] = params;
      const membership = { id: genId(), user_id: userId, tenant_id: tenantId, role: "tenant_owner", status: "active" };
      state.memberships.push(membership);
      return { rows: [{ membership_id: membership.id, role: membership.role }] };
    }
    if (text.startsWith("INSERT INTO audit_events")) {
      state.auditEvents.push({ actorUserId: params[0], tenantId: params[1], metadata: JSON.parse(params[2]) });
      return { rows: [] };
    }
    throw new Error(`Unhandled fake SQL in test: ${text}`);
  }
  return {
    state,
    async connect() { return { query: run, release() {} }; },
    async query(sql, params) { return run(sql, params); }
  };
}

const NEW_INVITE = { id: "invite-1", email: "new@example.com" };

test("self-serve provisioning creates a new tenant, user and owner membership for an invited email", async () => {
  const fakePool = createFakePool({ invites: [{ ...NEW_INVITE, tenant_display_name: "New Customer Co" }] });
  const repository = new PostgresConnectionRepository({ pool: fakePool });
  const result = await repository.resolveUserAuthorization({
    authSubject: "auth0|new-user",
    email: "new@example.com",
    displayName: "New Customer",
    allowSelfServeProvisioning: true
  });
  assert.equal(result.auth_subject, "auth0|new-user");
  assert.equal(result.role, "tenant_owner");
  assert.ok(result.tenant_id);
  assert.equal(fakePool.state.tenants.length, 1);
  assert.equal(fakePool.state.tenants[0].slug, "new-customer-co");
  assert.equal(fakePool.state.tenants[0].display_name, "New Customer Co");
  assert.equal(fakePool.state.invites[0].status, "accepted");
  assert.equal(fakePool.state.invites[0].accepted_tenant_id, result.tenant_id);
  assert.equal(fakePool.state.auditEvents.length, 1);
  assert.equal(fakePool.state.auditEvents[0].tenantId, result.tenant_id);
});

test("self-serve provisioning is disabled unless explicitly allowed", async () => {
  const fakePool = createFakePool({ invites: [NEW_INVITE] });
  const repository = new PostgresConnectionRepository({ pool: fakePool });
  await assert.rejects(
    () => repository.resolveUserAuthorization({ authSubject: "auth0|new-user", email: "new@example.com" }),
    (error) => error instanceof TenantAuthorizationError && error.code === "USER_NOT_PROVISIONED"
  );
  assert.equal(fakePool.state.tenants.length, 0);
});

test("self-serve provisioning never runs for an existing user, even if suspended", async () => {
  const fakePool = createFakePool({ invites: [NEW_INVITE], users: [{ id: "existing-user", auth_subject: "auth0|suspended-user", status: "suspended" }] });
  const repository = new PostgresConnectionRepository({ pool: fakePool });
  await assert.rejects(
    () => repository.resolveUserAuthorization({ authSubject: "auth0|suspended-user", allowSelfServeProvisioning: true }),
    (error) => error instanceof TenantAuthorizationError && error.code === "USER_NOT_PROVISIONED"
  );
  assert.equal(fakePool.state.tenants.length, 0);
  assert.equal(fakePool.state.users.length, 1);
});

test("self-serve provisioning retries slug allocation on a collision", async () => {
  const fakePool = createFakePool({
    invites: [{ id: "invite-2", email: "second@example.com" }],
    tenants: [{ id: "existing-tenant", slug: "new-customer", display_name: "Existing", status: "active" }]
  });
  const repository = new PostgresConnectionRepository({ pool: fakePool });
  const result = await repository.resolveUserAuthorization({
    authSubject: "auth0|new-user-2",
    email: "second@example.com",
    displayName: "New Customer",
    allowSelfServeProvisioning: true
  });
  assert.ok(result.tenant_id);
  assert.equal(fakePool.state.tenants.length, 2);
  assert.notEqual(fakePool.state.tenants[1].slug, "new-customer");
  assert.match(fakePool.state.tenants[1].slug, /^new-customer-[0-9a-f]{6}$/);
});

test("self-serve provisioning refuses an email that has no invitation", async () => {
  const fakePool = createFakePool({ invites: [NEW_INVITE] });
  const repository = new PostgresConnectionRepository({ pool: fakePool });
  await assert.rejects(
    () => repository.resolveUserAuthorization({ authSubject: "auth0|stranger", email: "stranger@example.com", allowSelfServeProvisioning: true }),
    (error) => error instanceof TenantAuthorizationError && error.code === "NOT_INVITED"
  );
  assert.equal(fakePool.state.tenants.length, 0);
  assert.equal(fakePool.state.invites[0].status, "pending");
});

test("self-serve provisioning matches the invited email case-insensitively", async () => {
  const fakePool = createFakePool({ invites: [NEW_INVITE] });
  const repository = new PostgresConnectionRepository({ pool: fakePool });
  const result = await repository.resolveUserAuthorization({ authSubject: "auth0|new-user", email: "NEW@Example.com", allowSelfServeProvisioning: true });
  assert.equal(result.role, "tenant_owner");
});

test("self-serve provisioning refuses an email Auth0 marks unverified, leaving the invite pending", async () => {
  const fakePool = createFakePool({ invites: [NEW_INVITE] });
  const repository = new PostgresConnectionRepository({ pool: fakePool });
  await assert.rejects(
    () => repository.resolveUserAuthorization({ authSubject: "auth0|new-user", email: "new@example.com", emailVerified: false, allowSelfServeProvisioning: true }),
    (error) => error instanceof TenantAuthorizationError && error.code === "EMAIL_NOT_VERIFIED"
  );
  assert.equal(fakePool.state.invites[0].status, "pending");
  assert.equal(fakePool.state.tenants.length, 0);
});

test("an invitation can only be used once", async () => {
  const fakePool = createFakePool({ invites: [NEW_INVITE] });
  const repository = new PostgresConnectionRepository({ pool: fakePool });
  await repository.resolveUserAuthorization({ authSubject: "auth0|first", email: "new@example.com", allowSelfServeProvisioning: true });
  await assert.rejects(
    () => repository.resolveUserAuthorization({ authSubject: "auth0|second", email: "new@example.com", allowSelfServeProvisioning: true }),
    (error) => error instanceof TenantAuthorizationError && error.code === "NOT_INVITED"
  );
  assert.equal(fakePool.state.tenants.length, 1);
});
