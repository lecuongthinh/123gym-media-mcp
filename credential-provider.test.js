import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { CompositeCredentialProvider, CredentialRefreshError, RECONNECT_MESSAGE, decryptCredential, encryptCredential } from "./src/credential-provider.js";

const key = randomBytes(32).toString("base64");
const env = { TENANT_CREDENTIAL_ENCRYPTION_KEY: key };

test("tenant credential encryption does not retain plaintext and round-trips", () => {
  const secret = { access_token: "highlevel-access-secret", refresh_token: "highlevel-refresh-secret", location_id: "location-1" };
  const encrypted = encryptCredential(secret, env);
  assert.doesNotMatch(encrypted.toString("utf8"), /highlevel-access-secret|highlevel-refresh-secret/);
  assert.deepEqual(decryptCredential(encrypted, env), secret);
});

test("encrypted credential provider rejects a credential bound to another location", async () => {
  const encrypted = encryptCredential({ access_token: "secret", location_id: "other-location" }, env);
  const provider = new CompositeCredentialProvider({ env, repository: {} });
  await assert.rejects(() => provider.getAccess({
    connection_id: "c1", location_id: "expected-location", secret_backend: "encrypted_database",
    encrypted_payload: encrypted, scopes: []
  }), /location binding mismatch/);
});

test("encrypted credential provider refreshes a Company-mode credential by minting a fresh location token", async () => {
  const expired = encryptCredential({
    auth_mode: "company",
    company_id: "company-1",
    company_refresh_token: "old-company-refresh",
    location_id: "loc-1",
    access_token: "stale-location-token",
    expires_at: new Date(Date.now() - 1000).toISOString()
  }, env);
  let updated;
  const repository = {
    async updateEncryptedCredential(credentialId, payload, expiresAt) {
      updated = { credentialId, payload, expiresAt };
    }
  };
  const fetchImpl = async (url, options) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/oauth/token") {
      assert.equal(options.body.get("grant_type"), "refresh_token");
      assert.equal(options.body.get("refresh_token"), "old-company-refresh");
      assert.equal(options.body.get("user_type"), "Company");
      return new Response(JSON.stringify({ access_token: "new-company-access", refresh_token: "new-company-refresh", expires_in: 86400 }), { status: 200 });
    }
    if (parsed.pathname === "/oauth/locationToken") {
      assert.equal(options.headers.Authorization, "Bearer new-company-access");
      assert.equal(options.body.get("companyId"), "company-1");
      assert.equal(options.body.get("locationId"), "loc-1");
      return new Response(JSON.stringify({ access_token: "fresh-location-token", expires_in: 3600 }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const provider = new CompositeCredentialProvider({ env, repository, fetchImpl });
  const result = await provider.getAccess({
    connection_id: "c1", credential_id: "cred-1", location_id: "loc-1",
    secret_backend: "encrypted_database", encrypted_payload: expired, scopes: []
  });
  assert.equal(result.accessToken, "fresh-location-token");
  assert.equal(result.locationId, "loc-1");
  assert.ok(updated);
  const decrypted = decryptCredential(updated.payload, env);
  assert.equal(decrypted.company_refresh_token, "new-company-refresh");
  assert.equal(decrypted.access_token, "fresh-location-token");
});

function expiredConnection(extra = {}) {
  return {
    connection_id: "c1", credential_id: "cred-1", tenant_id: "t1", location_id: "loc-1",
    secret_backend: "encrypted_database", scopes: [],
    encrypted_payload: encryptCredential({
      access_token: "stale-access", refresh_token: "old-refresh-secret", location_id: "loc-1",
      expires_at: new Date(Date.now() - 1000).toISOString()
    }, env),
    ...extra
  };
}

// Mimics the DB row lock: callers run one at a time against the stored payload.
function lockingRepository(initialPayload) {
  let stored = initialPayload;
  let chain = Promise.resolve();
  const repo = {
    errors: [], audits: [],
    withCredentialLock(_id, fn) {
      const run = chain.then(() => fn({ encryptedPayload: stored, save: async (payload) => { stored = payload; } }));
      chain = run.catch(() => {});
      return run;
    },
    async markConnectionError(id) { repo.errors.push(id); },
    async recordAuditEvent(event) { repo.audits.push(event); }
  };
  return repo;
}

test("parallel refreshes call HighLevel once, even across providers sharing the DB lock", async () => {
  const connection = expiredConnection();
  const repository = lockingRepository(connection.encrypted_payload);
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls += 1;
    assert.equal(options.body.get("refresh_token"), "old-refresh-secret");
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 86400 }), { status: 200 });
  };
  // Two providers = two Render instances: only the DB lock + re-read protects them.
  const a = new CompositeCredentialProvider({ env, repository, fetchImpl });
  const b = new CompositeCredentialProvider({ env, repository, fetchImpl });
  const results = await Promise.all([a.getAccess(connection), a.getAccess(connection), b.getAccess(connection)]);
  assert.equal(calls, 1);
  assert.deepEqual(results.map((r) => r.accessToken), ["new-access", "new-access", "new-access"]);
});

test("refresh rejected by HighLevel gives an actionable Vietnamese error, marks the connection and leaks no token", async () => {
  const connection = expiredConnection();
  const repository = lockingRepository(connection.encrypted_payload);
  const fetchImpl = async () => new Response(JSON.stringify({ error: "Invalid refresh token old-refresh-secret" }), { status: 400 });
  const provider = new CompositeCredentialProvider({ env, repository, fetchImpl });
  const failures = await Promise.allSettled([provider.getAccess(connection), provider.getAccess(connection)]);
  for (const failure of failures) {
    assert.equal(failure.status, "rejected");
    assert.ok(failure.reason instanceof CredentialRefreshError);
    assert.equal(failure.reason.message, RECONNECT_MESSAGE);
    assert.match(failure.reason.message, /connect_social_account/);
    assert.doesNotMatch(JSON.stringify(failure.reason.message), /old-refresh-secret|stale-access/);
  }
  assert.deepEqual(repository.errors, ["c1"]);
  assert.equal(repository.audits.length, 1);
  assert.equal(repository.audits[0].action, "credential.refresh_failed");
  assert.equal(repository.audits[0].metadata.httpStatus, 400);
  assert.doesNotMatch(JSON.stringify(repository.audits), /old-refresh-secret|stale-access/);
});

test("transient refresh failures (5xx) do not mark the connection as errored", async () => {
  const connection = expiredConnection();
  const repository = lockingRepository(connection.encrypted_payload);
  const fetchImpl = async () => new Response("{}", { status: 503 });
  const provider = new CompositeCredentialProvider({ env, repository, fetchImpl });
  await assert.rejects(() => provider.getAccess(connection), /OAuth refresh failed \(503\)/);
  assert.deepEqual(repository.errors, []);
});
