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
