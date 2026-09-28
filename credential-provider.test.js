import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { CompositeCredentialProvider, decryptCredential, encryptCredential } from "./src/credential-provider.js";

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
