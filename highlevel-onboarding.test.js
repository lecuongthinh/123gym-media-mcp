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
    HIGHLEVEL_REDIRECT_URI: "https://staging.example.com/oauth/callback/social-crm",
    HIGHLEVEL_CLIENT_ID: "test-client",
    HIGHLEVEL_CLIENT_SECRET: "client-secret-not-for-logs",
    TENANT_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64")
  };
}

function repositoryWithState(overrides = {}) {
  let storedState;
  return {
    get storedState() { return storedState; },
    async createOAuthState(value) { storedState = value; },
    async consumeOAuthState(stateHash) {
      assert.equal(stateHash, storedState.stateHash);
      return { tenant_id: TENANT_ID, actor_user_id: USER_ID, intended_location_id: storedState.intendedLocationId };
    },
    ...overrides
  };
}

test("HighLevel onboarding state is single-use and tokens are persisted only as ciphertext", async () => {
  const configuration = env();
  let saved;
  const repository = repositoryWithState({
    async saveHighLevelOAuthConnection(value) { saved = value; },
    async recordAuditEvent(value) {
      assert.equal(value.tenantId, TENANT_ID);
      assert.equal(value.metadata.locationId, LOCATION_ID);
    }
  });
  const fetchImpl = async (url, options) => {
    if (String(url) === "https://services.leadconnectorhq.com/oauth/token") {
      assert.equal(options.body.get("client_secret"), configuration.HIGHLEVEL_CLIENT_SECRET);
      return new Response(JSON.stringify({
        access_token: "highlevel-access-token",
        refresh_token: "highlevel-refresh-token",
        locationId: LOCATION_ID,
        expires_in: 86400,
        scope: "socialplanner/post.readonly socialplanner/account.readonly"
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const parsed = new URL(String(url));
    assert.equal(parsed.pathname, "/users/");
    assert.equal(parsed.searchParams.get("locationId"), LOCATION_ID);
    assert.equal(options.headers.Authorization, "Bearer highlevel-access-token");
    return new Response(JSON.stringify({ users: [
      { id: "owner-user-id", firstName: "Owner", lastName: "User", roles: { role: "admin", type: "account" } }
    ] }), { status: 200 });
  };
  const onboarding = createHighLevelOnboarding({ env: configuration, repository, fetchImpl });
  const principal = { tenantId: TENANT_ID, userId: USER_ID, role: "tenant_owner" };
  const started = await onboarding.start(principal, { locationId: LOCATION_ID });
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  assert.ok(state);
  assert.notEqual(repository.storedState.stateHash, state);

  const result = await onboarding.callback({ code: "one-time-code", state });
  assert.deepEqual(result, { connected: true, locationId: LOCATION_ID, defaultUserIdResolved: true });
  assert.equal(saved.tenantId, TENANT_ID);
  assert.equal(saved.locationId, LOCATION_ID);
  assert.equal(saved.defaultUserId, "owner-user-id");
  assert.doesNotMatch(saved.encryptedPayload.toString("utf8"), /highlevel-access-token|highlevel-refresh-token/);
  const decrypted = decryptCredential(saved.encryptedPayload, configuration);
  assert.equal(decrypted.auth_mode, "location");
  assert.equal(decrypted.location_id, LOCATION_ID);
  assert.equal(decrypted.refresh_token, "highlevel-refresh-token");
});

test("HighLevel onboarding still connects when the Users API lacks scope, leaving default_user_id unset", async () => {
  const configuration = env();
  let saved;
  const repository = repositoryWithState({
    async saveHighLevelOAuthConnection(value) { saved = value; },
    async recordAuditEvent(value) {
      assert.equal(value.metadata.defaultUserIdResolved, false);
    }
  });
  const fetchImpl = async (url) => {
    if (String(url) === "https://services.leadconnectorhq.com/oauth/token") {
      return new Response(JSON.stringify({
        access_token: "highlevel-access-token",
        refresh_token: "highlevel-refresh-token",
        locationId: LOCATION_ID,
        expires_in: 86400,
        scope: "socialplanner/post.readonly"
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ message: "The token is not authorized for this scope." }), { status: 401 });
  };
  const onboarding = createHighLevelOnboarding({ env: configuration, repository, fetchImpl });
  const started = await onboarding.start({ tenantId: TENANT_ID, userId: USER_ID, role: "tenant_owner" }, { locationId: LOCATION_ID });
  const state = new URL(started.authorizationUrl).searchParams.get("state");

  const result = await onboarding.callback({ code: "one-time-code", state });
  assert.deepEqual(result, { connected: true, locationId: LOCATION_ID, defaultUserIdResolved: false });
  assert.equal(saved.defaultUserId, null);
});

test("HighLevel onboarding mints a location-scoped token for a Company (agency) OAuth grant", async () => {
  const configuration = env();
  let saved;
  const repository = repositoryWithState({
    async saveHighLevelOAuthConnection(value) { saved = value; },
    async recordAuditEvent(value) {
      assert.equal(value.metadata.authMode, "company");
      assert.equal(value.metadata.locationId, LOCATION_ID);
    }
  });
  const fetchImpl = async (url, options) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/oauth/token" && new URLSearchParams(options.body).get("grant_type") === "authorization_code") {
      return new Response(JSON.stringify({
        access_token: "company-access-token",
        refresh_token: "company-refresh-token",
        userType: "Company",
        companyId: "company-1",
        isBulkInstallation: true,
        installToFutureLocations: false,
        approveAllLocations: false,
        expires_in: 86400,
        scope: "socialplanner/post.readonly"
      }), { status: 200 });
    }
    if (parsed.pathname === "/oauth/locationToken") {
      assert.equal(options.headers.Authorization, "Bearer company-access-token");
      assert.equal(options.body.get("companyId"), "company-1");
      assert.equal(options.body.get("locationId"), LOCATION_ID);
      return new Response(JSON.stringify({ access_token: "location-access-token", expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify({ message: "not authorized" }), { status: 401 });
  };
  const onboarding = createHighLevelOnboarding({ env: configuration, repository, fetchImpl });
  const started = await onboarding.start({ tenantId: TENANT_ID, userId: USER_ID, role: "tenant_owner" }, { locationId: LOCATION_ID });
  const state = new URL(started.authorizationUrl).searchParams.get("state");

  const result = await onboarding.callback({ code: "one-time-code", state });
  assert.deepEqual(result, { connected: true, locationId: LOCATION_ID, defaultUserIdResolved: false });
  assert.equal(saved.locationId, LOCATION_ID);
  const decrypted = decryptCredential(saved.encryptedPayload, configuration);
  assert.equal(decrypted.auth_mode, "company");
  assert.equal(decrypted.company_id, "company-1");
  assert.equal(decrypted.company_refresh_token, "company-refresh-token");
  assert.equal(decrypted.access_token, "location-access-token");
});

test("HighLevel onboarding rejects a Company grant when connect_highlevel was called without locationId", async () => {
  const configuration = env();
  const repository = repositoryWithState({
    async saveHighLevelOAuthConnection() { throw new Error("must not save"); },
    async recordAuditEvent() {}
  });
  // Simulate a pre-existing state row saved before locationId became required.
  repository.consumeOAuthState = async () => ({ tenant_id: TENANT_ID, actor_user_id: USER_ID, intended_location_id: null });
  const fetchImpl = async () => new Response(JSON.stringify({
    access_token: "company-access-token",
    refresh_token: "company-refresh-token",
    userType: "Company",
    companyId: "company-1",
    expires_in: 86400
  }), { status: 200 });
  const onboarding = createHighLevelOnboarding({ env: configuration, repository, fetchImpl });
  await assert.rejects(
    () => onboarding.callback({ code: "one-time-code", state: "irrelevant-state" }),
    /must be called with locationId/
  );
});

test("HighLevel onboarding requires locationId to start", async () => {
  const onboarding = createHighLevelOnboarding({
    env: env(),
    repository: { async createOAuthState() { throw new Error("must not be called"); } }
  });
  await assert.rejects(
    () => onboarding.start({ tenantId: TENANT_ID, userId: USER_ID, role: "tenant_owner" }),
    /requires locationId/
  );
});

test("HighLevel onboarding rejects non-admin tenant roles before creating state", async () => {
  let called = false;
  const onboarding = createHighLevelOnboarding({
    env: env(),
    repository: { async createOAuthState() { called = true; } }
  });
  await assert.rejects(
    () => onboarding.start({ tenantId: TENANT_ID, userId: USER_ID, role: "viewer" }, { locationId: LOCATION_ID }),
    /owner or administrator/
  );
  assert.equal(called, false);
});

test("HighLevel onboarding uses the sub-account assigned by the invitation when none is passed", async () => {
  let storedState;
  const onboarding = createHighLevelOnboarding({
    env: env(),
    repository: {
      async findInvitedLocationId(tenantId) { assert.equal(tenantId, TENANT_ID); return LOCATION_ID; },
      async createOAuthState(value) { storedState = value; }
    }
  });
  await onboarding.start({ tenantId: TENANT_ID, userId: USER_ID, role: "tenant_owner" });
  assert.equal(storedState.intendedLocationId, LOCATION_ID);
});

test("HighLevel onboarding refuses a different sub-account than the invitation assigned", async () => {
  const onboarding = createHighLevelOnboarding({
    env: env(),
    repository: {
      async findInvitedLocationId() { return LOCATION_ID; },
      async createOAuthState() { throw new Error("must not be called"); }
    }
  });
  await assert.rejects(
    () => onboarding.start({ tenantId: TENANT_ID, userId: USER_ID, role: "tenant_owner" }, { locationId: "some-other-location" }),
    /assigned to a different HighLevel sub-account/
  );
});
