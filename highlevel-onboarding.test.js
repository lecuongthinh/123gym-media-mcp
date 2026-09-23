import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { decryptCredential } from "./src/credential-provider.js";
import { createHighLevelOnboarding } from "./src/highlevel-onboarding.js";

const TENANT_ID = "00000000-0000-4000-8000-000000000124";
const USER_ID = "30000000-0000-4000-8000-000000000124";
const LOCATION_ID = "UwsfBVLmz7XSKJbhuOTS";

function env() {
  return {
    HIGHLEVEL_INSTALL_URL: "https://marketplace.gohighlevel.com/oauth/chooselocation?client_id=test-client",
    HIGHLEVEL_REDIRECT_URI: "https://staging.example.com/oauth/callback/highlevel",
    HIGHLEVEL_CLIENT_ID: "test-client",
    HIGHLEVEL_CLIENT_SECRET: "client-secret-not-for-logs",
    TENANT_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64")
  };
}

test("HighLevel onboarding state is single-use and tokens are persisted only as ciphertext", async () => {
  const configuration = env();
  let storedState;
  let saved;
  const repository = {
    async createOAuthState(value) { storedState = value; },
    async consumeOAuthState(stateHash) {
      assert.equal(stateHash, storedState.stateHash);
      return { tenant_id: TENANT_ID, actor_user_id: USER_ID };
    },
    async saveHighLevelOAuthConnection(value) { saved = value; },
    async recordAuditEvent(value) {
      assert.equal(value.tenantId, TENANT_ID);
      assert.equal(value.metadata.locationId, LOCATION_ID);
    }
  };
  const fetchImpl = async (url, options) => {
    assert.equal(url, "https://services.leadconnectorhq.com/oauth/token");
    assert.equal(options.body.get("client_secret"), configuration.HIGHLEVEL_CLIENT_SECRET);
    return new Response(JSON.stringify({
      access_token: "highlevel-access-token",
      refresh_token: "highlevel-refresh-token",
      locationId: LOCATION_ID,
      expires_in: 86400,
      scope: "socialplanner/post.readonly socialplanner/account.readonly"
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const onboarding = createHighLevelOnboarding({ env: configuration, repository, fetchImpl });
  const principal = { tenantId: TENANT_ID, userId: USER_ID, role: "tenant_owner" };
  const started = await onboarding.start(principal);
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  assert.ok(state);
  assert.notEqual(storedState.stateHash, state);

  const result = await onboarding.callback({ code: "one-time-code", state });
  assert.deepEqual(result, { connected: true, locationId: LOCATION_ID });
  assert.equal(saved.tenantId, TENANT_ID);
  assert.equal(saved.locationId, LOCATION_ID);
  assert.doesNotMatch(saved.encryptedPayload.toString("utf8"), /highlevel-access-token|highlevel-refresh-token/);
  const decrypted = decryptCredential(saved.encryptedPayload, configuration);
  assert.equal(decrypted.location_id, LOCATION_ID);
  assert.equal(decrypted.refresh_token, "highlevel-refresh-token");
});

test("HighLevel onboarding rejects non-admin tenant roles before creating state", async () => {
  let called = false;
  const onboarding = createHighLevelOnboarding({
    env: env(),
    repository: { async createOAuthState() { called = true; } }
  });
  await assert.rejects(
    () => onboarding.start({ tenantId: TENANT_ID, userId: USER_ID, role: "viewer" }),
    /owner or administrator/
  );
  assert.equal(called, false);
});
