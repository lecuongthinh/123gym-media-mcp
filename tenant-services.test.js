import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { listMedia } from "./server.js";
import {
  authorizeTenantContext,
  EnvironmentCredentialProvider,
  InMemoryConnectionRepository,
  LEGACY_123_GYM_TENANT_ID,
  TenantAuthorizationError
} from "./src/tenant-services.js";

const GYM_LOCATION = "pUePVc6UKEUecvZS6EYU";
const TEST_LOCATION = "UwsfBVLmz7XSKJbhuOTS";
const TEST_TENANT_ID = "00000000-0000-4000-8000-000000000124";

function connection(tenantId, tenantName, locationId, envName) {
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
    scopes: ["social:read", "media:read"]
  };
}

function pilotServices(env = {}) {
  return {
    repository: new InMemoryConnectionRepository([
      connection(LEGACY_123_GYM_TENANT_ID, "123 GYM", GYM_LOCATION, "LC_PRIVATE_TOKEN"),
      connection(TEST_TENANT_ID, "Testing Agency", TEST_LOCATION, "LC_PRIVATE_TOKEN_TESTING_AGENCY")
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
    /credential is not configured/
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
