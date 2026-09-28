import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import express from "express";

import { app as mcpApp } from "./server.js";
import { protectedResourceMetadata } from "./src/auth.js";
import { authenticateIssuedToken, completeHighLevelLogin, createOAuthRouter } from "./src/oauth-server.js";

const LOCATION_ID = "UwsfBVLmz7XSKJbhuOTS";
const CHATGPT_REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const sha = (value) => createHash("sha256").update(value).digest("hex");

function env(overrides = {}) {
  return {
    OAUTH_SERVER_ENABLED: "true",
    MCP_RESOURCE_URL: "https://staging.example.com",
    HIGHLEVEL_INSTALL_URL: "https://marketplace.gohighlevel.com/oauth/chooselocation?client_id=test-client",
    HIGHLEVEL_REDIRECT_URI: "https://staging.example.com/oauth/callback/social-crm",
    HIGHLEVEL_CLIENT_ID: "test-client",
    HIGHLEVEL_CLIENT_SECRET: "client-secret-not-for-logs",
    TENANT_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    ENABLE_SELF_SERVE_SIGNUP: "true",
    ...overrides
  };
}

// In-memory stand-in for PostgresConnectionRepository's OAuth-server methods.
class FakeRepository {
  clients = new Map();
  logins = new Map();
  codes = new Map();
  tokens = new Map();
  users = new Map();
  tenants = new Map();
  memberships = [];
  connections = new Map();

  async registerOAuthClient({ clientId, clientName, redirectUris }) {
    this.clients.set(clientId, { client_id: clientId, client_name: clientName, redirect_uris: redirectUris });
  }
  async findOAuthClient(id) { return this.clients.get(id) || null; }
  async createLoginRequest(v) { this.logins.set(v.stateHash, { ...v, client_id: v.clientId, redirect_uri: v.redirectUri, code_challenge: v.codeChallenge, client_state: v.clientState, used: false }); }
  async consumeLoginRequest(hash) {
    const row = this.logins.get(hash);
    if (!row || row.used || row.expiresAt < new Date()) return null;
    row.used = true;
    return row;
  }
  async provisionHighLevelLogin(v) {
    let user = this.users.get(v.subject);
    if (!user) { user = { id: randomUUID(), auth_subject: v.subject, email: v.email }; this.users.set(v.subject, user); }
    let tenantId = this.connections.get(v.locationId)?.tenantId;
    let created = false;
    if (!tenantId) {
      if (!v.allowCreateTenant) {
        const { TenantAuthorizationError } = await import("./src/tenant-services.js");
        throw new TenantAuthorizationError("Self-serve sign-up is disabled.", "SIGNUP_DISABLED");
      }
      tenantId = randomUUID();
      this.tenants.set(tenantId, { id: tenantId, display_name: v.tenantName });
      created = true;
    }
    let membership = this.memberships.find((m) => m.user_id === user.id && m.tenant_id === tenantId);
    if (!membership) {
      const first = !this.memberships.some((m) => m.tenant_id === tenantId);
      membership = { id: randomUUID(), user_id: user.id, tenant_id: tenantId, role: first ? "tenant_owner" : v.newMemberRole };
      this.memberships.push(membership);
    }
    this.connections.set(v.locationId, { tenantId, payload: v.encryptedPayload, defaultUserId: v.defaultUserId });
    return { userId: user.id, tenantId, role: membership.role, created };
  }
  async createAuthCode(v) { this.codes.set(v.codeHash, { ...v, client_id: v.clientId, redirect_uri: v.redirectUri, code_challenge: v.codeChallenge, user_id: v.userId, tenant_id: v.tenantId, used: false }); }
  async consumeAuthCode(hash) {
    const row = this.codes.get(hash);
    if (!row || row.used || row.expiresAt < new Date()) return null;
    row.used = true;
    return row;
  }
  async insertOAuthToken(v) { this.tokens.set(v.tokenHash, { ...v, client_id: v.clientId, user_id: v.userId, tenant_id: v.tenantId, family_id: v.familyId, used: false, revoked: false }); }
  async findAccessToken(hash) {
    const row = this.tokens.get(hash);
    return row && row.kind === "access" && !row.revoked && row.expiresAt > new Date() ? row : null;
  }
  async consumeRefreshToken(hash) {
    const row = this.tokens.get(hash);
    if (row && row.kind === "refresh" && !row.used && !row.revoked && row.expiresAt > new Date()) { row.used = true; return row; }
    if (row?.used) for (const token of this.tokens.values()) if (token.family_id === row.family_id) token.revoked = true;
    return null;
  }
  async resolvePrincipalForUserTenant(userId, tenantId) {
    const user = [...this.users.values()].find((u) => u.id === userId);
    const membership = this.memberships.find((m) => m.user_id === userId && m.tenant_id === tenantId);
    if (!user || !membership) return null;
    return { id: user.id, auth_subject: user.auth_subject, email: user.email, membership_id: membership.id, role: membership.role, tenant_id: tenantId, tenant_name: this.tenants.get(tenantId).display_name };
  }
}

function highLevelFetch({ grant = {}, users, fail = false } = {}) {
  return async (url, options = {}) => {
    const parsed = new URL(String(url));
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
    if (parsed.pathname === "/oauth/token") {
      if (fail) return json({}, 400);
      return json({ access_token: "hl-access", refresh_token: "hl-refresh", locationId: LOCATION_ID, userId: "hl-user-1", expires_in: 86400, scope: "socialplanner/post.write", ...grant });
    }
    if (parsed.pathname === "/users/") return json({ users: users || [{ id: "hl-user-1", firstName: "Ada", lastName: "Owner", email: "ada@example.com", roles: { role: "admin" } }] });
    if (parsed.pathname.startsWith("/locations/")) return json({ location: { name: "Acme Gym" } });
    return json({}, 404);
  };
}

async function withOAuthApp(configuration, { fetchImpl = highLevelFetch(), repository = new FakeRepository() } = {}, fn) {
  const app = express();
  app.use(express.json());
  app.use(createOAuthRouter({ env: configuration, getRepository: () => repository }));
  app.get("/oauth/callback/social-crm", async (req, res) => {
    const login = await completeHighLevelLogin({ query: req.query, repository, env: configuration, fetchImpl });
    if (!login) return res.status(204).end();
    if (login.redirectUrl) return res.redirect(302, login.redirectUrl);
    return res.status(login.status).type("html").send(login.html);
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}`, repository); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

async function register(base, redirectUri = CHATGPT_REDIRECT) {
  const response = await fetch(`${base}/oauth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" })
  });
  return { response, body: await response.json() };
}

function pkce() {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function beginLogin(base, clientId, challenge, extra = {}) {
  const params = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: CHATGPT_REDIRECT,
    code_challenge: challenge, code_challenge_method: "S256", state: "chatgpt-state", ...extra
  });
  return fetch(`${base}/oauth/authorize?${params}`, { redirect: "manual" });
}

// Runs authorize -> HighLevel callback and returns the code ChatGPT would receive.
async function loginForCode(base, { challenge, clientId }) {
  const authorize = await beginLogin(base, clientId, challenge);
  assert.equal(authorize.status, 302);
  const highLevelState = new URL(authorize.headers.get("location")).searchParams.get("state");
  const callback = await fetch(`${base}/oauth/callback/social-crm?code=hl-code&state=${highLevelState}`, { redirect: "manual" });
  assert.equal(callback.status, 302);
  const redirect = new URL(callback.headers.get("location"));
  assert.equal(redirect.origin + redirect.pathname, CHATGPT_REDIRECT);
  assert.equal(redirect.searchParams.get("state"), "chatgpt-state");
  return redirect.searchParams.get("code");
}

function tokenRequest(base, params) {
  return fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
}

test("authorization server metadata is served only when the built-in server is enabled", async () => {
  await withOAuthApp(env(), {}, async (base) => {
    const metadata = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.equal(metadata.issuer, "https://staging.example.com");
    assert.equal(metadata.token_endpoint, "https://staging.example.com/oauth/token");
    assert.equal(metadata.registration_endpoint, "https://staging.example.com/oauth/register");
    assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  });
  await withOAuthApp(env({ OAUTH_SERVER_ENABLED: undefined }), {}, async (base) => {
    assert.equal((await fetch(`${base}/.well-known/oauth-authorization-server`)).status, 404);
    assert.equal((await fetch(`${base}/oauth/authorize`)).status, 404);
  });
  assert.deepEqual(protectedResourceMetadata(env()).authorization_servers, ["https://staging.example.com"]);
});

test("dynamic client registration accepts ChatGPT redirects and rejects everything else", async () => {
  await withOAuthApp(env(), {}, async (base) => {
    const ok = await register(base);
    assert.equal(ok.response.status, 201);
    assert.match(ok.body.client_id, /^mcp_/);
    assert.equal(ok.body.token_endpoint_auth_method, "none");
    for (const bad of ["https://evil.example.com/cb", "http://chatgpt.com/cb", "javascript:alert(1)", "https://chatgpt.com/cb#frag"]) {
      assert.equal((await register(base, bad)).response.status, 400, bad);
    }
    assert.equal((await register(base, "http://localhost:8080/cb")).response.status, 201);
  });
});

test("authorize refuses to redirect for an unknown client or an unregistered redirect_uri", async () => {
  await withOAuthApp(env(), {}, async (base) => {
    const { body } = await register(base);
    const { challenge } = pkce();
    assert.equal((await beginLogin(base, "mcp_unknown", challenge)).status, 400);
    const params = new URLSearchParams({ response_type: "code", client_id: body.client_id, redirect_uri: "https://chatgpt.com/other", code_challenge: challenge, code_challenge_method: "S256" });
    assert.equal((await fetch(`${base}/oauth/authorize?${params}`, { redirect: "manual" })).status, 400);
  });
});

test("authorize requires PKCE S256 and a known resource, then sends the user to HighLevel", async () => {
  await withOAuthApp(env(), {}, async (base) => {
    const { body } = await register(base);
    const { challenge } = pkce();
    const noPkce = await beginLogin(base, body.client_id, challenge, { code_challenge_method: "plain" });
    assert.equal(noPkce.status, 302);
    assert.equal(new URL(noPkce.headers.get("location")).searchParams.get("error"), "invalid_request");
    const badResource = await beginLogin(base, body.client_id, challenge, { resource: "https://other.example.com" });
    assert.equal(new URL(badResource.headers.get("location")).searchParams.get("error"), "invalid_target");
    const ok = await beginLogin(base, body.client_id, challenge, { resource: "https://staging.example.com/mcp" });
    assert.equal(ok.status, 302);
    const target = new URL(ok.headers.get("location"));
    assert.equal(target.origin + target.pathname, "https://marketplace.gohighlevel.com/oauth/chooselocation");
    assert.equal(target.searchParams.get("client_id"), "test-client");
    assert.ok(target.searchParams.get("state"));
  });
});

test("full login: HighLevel approval creates the tenant, then the code exchange yields a working token", async () => {
  await withOAuthApp(env(), {}, async (base, repository) => {
    const { body: client } = await register(base);
    const { verifier, challenge } = pkce();
    const code = await loginForCode(base, { challenge, clientId: client.client_id });

    assert.equal(repository.tenants.size, 1);
    assert.equal([...repository.tenants.values()][0].display_name, "Acme Gym");
    assert.equal(repository.connections.get(LOCATION_ID).defaultUserId, "hl-user-1");
    assert.doesNotMatch(String(repository.connections.get(LOCATION_ID).payload.toString("utf8")), /hl-access|hl-refresh/);

    const exchanged = await tokenRequest(base, { grant_type: "authorization_code", code, redirect_uri: CHATGPT_REDIRECT, client_id: client.client_id, code_verifier: verifier });
    assert.equal(exchanged.status, 200);
    assert.equal(exchanged.headers.get("cache-control"), "no-store");
    const tokens = await exchanged.json();
    assert.match(tokens.access_token, /^uat_/);
    assert.equal(tokens.token_type, "Bearer");

    const principal = await authenticateIssuedToken({ token: tokens.access_token, repository });
    assert.equal(principal.authType, "oauth");
    assert.equal(principal.role, "tenant_owner");
    assert.equal(principal.tenantName, "Acme Gym");
    assert.equal(principal.subject, "highlevel:hl-user-1");
    assert.equal(await authenticateIssuedToken({ token: "eyJnotours", repository }), null);
    await assert.rejects(() => authenticateIssuedToken({ token: "uat_forged", repository }), /invalid or expired/);
  });
});

test("authorization codes are single-use and bound to the PKCE verifier, client and redirect_uri", async () => {
  await withOAuthApp(env(), {}, async (base) => {
    const { body: client } = await register(base);
    const { verifier, challenge } = pkce();
    const good = { grant_type: "authorization_code", redirect_uri: CHATGPT_REDIRECT, client_id: client.client_id, code_verifier: verifier };

    let code = await loginForCode(base, { challenge, clientId: client.client_id });
    assert.equal((await tokenRequest(base, { ...good, code, code_verifier: pkce().verifier })).status, 400);
    assert.equal((await tokenRequest(base, { ...good, code })).status, 400, "a failed attempt burns the code");

    code = await loginForCode(base, { challenge, clientId: client.client_id });
    assert.equal((await tokenRequest(base, { ...good, code, redirect_uri: "https://chatgpt.com/other" })).status, 400);

    code = await loginForCode(base, { challenge, clientId: client.client_id });
    assert.equal((await tokenRequest(base, { ...good, code, client_id: "mcp_someone_else" })).status, 400);

    code = await loginForCode(base, { challenge, clientId: client.client_id });
    assert.equal((await tokenRequest(base, { ...good, code })).status, 200);
    const replay = await tokenRequest(base, { ...good, code });
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).error, "invalid_grant");
  });
});

test("refresh tokens rotate, and replaying a used one revokes the whole token family", async () => {
  await withOAuthApp(env(), {}, async (base, repository) => {
    const { body: client } = await register(base);
    const { verifier, challenge } = pkce();
    const code = await loginForCode(base, { challenge, clientId: client.client_id });
    const first = await (await tokenRequest(base, { grant_type: "authorization_code", code, redirect_uri: CHATGPT_REDIRECT, client_id: client.client_id, code_verifier: verifier })).json();

    const refreshed = await tokenRequest(base, { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: client.client_id });
    assert.equal(refreshed.status, 200);
    const second = await refreshed.json();
    assert.notEqual(second.refresh_token, first.refresh_token);
    assert.ok(await authenticateIssuedToken({ token: second.access_token, repository }));

    const replay = await tokenRequest(base, { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: client.client_id });
    assert.equal(replay.status, 400);
    await assert.rejects(() => authenticateIssuedToken({ token: second.access_token, repository }), /invalid or expired/);
    assert.equal((await tokenRequest(base, { grant_type: "refresh_token", refresh_token: second.refresh_token, client_id: client.client_id })).status, 400);
    assert.equal((await tokenRequest(base, { grant_type: "password" })).status, 400);
  });
});

test("a second HighLevel user of the same sub-account joins the existing tenant without owner rights", async () => {
  const repository = new FakeRepository();
  await withOAuthApp(env(), { repository }, async (base) => {
    const { body: client } = await register(base);
    await loginForCode(base, { challenge: pkce().challenge, clientId: client.client_id });
  });
  await withOAuthApp(env(), {
    repository,
    fetchImpl: highLevelFetch({ grant: { userId: "hl-user-2" }, users: [{ id: "hl-user-2", firstName: "Bo", email: "bo@example.com", roles: { role: "user" } }] })
  }, async (base) => {
    const { body: client } = await register(base);
    const { verifier, challenge } = pkce();
    const code = await loginForCode(base, { challenge, clientId: client.client_id });
    const tokens = await (await tokenRequest(base, { grant_type: "authorization_code", code, redirect_uri: CHATGPT_REDIRECT, client_id: client.client_id, code_verifier: verifier })).json();
    const principal = await authenticateIssuedToken({ token: tokens.access_token, repository });
    assert.equal(repository.tenants.size, 1);
    assert.equal(principal.role, "editor");
  });
});

test("an agency-wide (Company) grant is refused with guidance and never yields a code", async () => {
  await withOAuthApp(env(), { fetchImpl: highLevelFetch({ grant: { locationId: undefined, companyId: "company-1", userType: "Company" } }) }, async (base, repository) => {
    const { body: client } = await register(base);
    const authorize = await beginLogin(base, client.client_id, pkce().challenge);
    const state = new URL(authorize.headers.get("location")).searchParams.get("state");
    const callback = await fetch(`${base}/oauth/callback/social-crm?code=hl-code&state=${state}`, { redirect: "manual" });
    assert.equal(callback.status, 403);
    assert.match(await callback.text(), /sub-account/);
    assert.equal(repository.codes.size, 0);
    assert.equal(repository.tenants.size, 0);
  });
});

test("sign-up can be switched off, and HighLevel failures show a generic page without leaking details", async () => {
  await withOAuthApp(env({ ENABLE_SELF_SERVE_SIGNUP: "false" }), {}, async (base, repository) => {
    const { body: client } = await register(base);
    const authorize = await beginLogin(base, client.client_id, pkce().challenge);
    const state = new URL(authorize.headers.get("location")).searchParams.get("state");
    const callback = await fetch(`${base}/oauth/callback/social-crm?code=hl-code&state=${state}`, { redirect: "manual" });
    assert.equal(callback.status, 403);
    assert.equal(repository.tenants.size, 0);
  });
  await withOAuthApp(env(), { fetchImpl: highLevelFetch({ fail: true }) }, async (base) => {
    const { body: client } = await register(base);
    const authorize = await beginLogin(base, client.client_id, pkce().challenge);
    const state = new URL(authorize.headers.get("location")).searchParams.get("state");
    const callback = await fetch(`${base}/oauth/callback/social-crm?code=hl-code&state=${state}`, { redirect: "manual" });
    assert.equal(callback.status, 500);
    assert.doesNotMatch(await callback.text(), /client-secret|400/);
  });
});

test("declined HighLevel consent returns access_denied to the client; unrelated states fall through", async () => {
  await withOAuthApp(env(), {}, async (base) => {
    const { body: client } = await register(base);
    const authorize = await beginLogin(base, client.client_id, pkce().challenge);
    const state = new URL(authorize.headers.get("location")).searchParams.get("state");
    const denied = await fetch(`${base}/oauth/callback/social-crm?error=access_denied&state=${state}`, { redirect: "manual" });
    assert.equal(denied.status, 302);
    const target = new URL(denied.headers.get("location"));
    assert.equal(target.searchParams.get("error"), "access_denied");
    assert.equal(target.searchParams.get("state"), "chatgpt-state");
    assert.equal((await fetch(`${base}/oauth/callback/social-crm?code=x&state=not-a-login-state`)).status, 204);
    assert.equal((await fetch(`${base}/oauth/callback/social-crm?code=x&state=${state}`)).status, 204, "a login state is single-use");
  });
});

test("the MCP endpoint accepts a built-in access token and rejects a forged one", async () => {
  const repository = new FakeRepository();
  const previous = {};
  const values = env({ AUTH0_ISSUER_BASE_URL: undefined, AUTH0_AUDIENCE: undefined });
  for (const [key, value] of Object.entries(values)) { previous[key] = process.env[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  mcpApp.locals.tenantServices = { repository, credentialProvider: {} };
  const server = mcpApp.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { body: client } = await register(base);
    const userId = randomUUID();
    const tenantId = randomUUID();
    repository.users.set("highlevel:hl-user-1", { id: userId, auth_subject: "highlevel:hl-user-1", email: null });
    repository.tenants.set(tenantId, { id: tenantId, display_name: "Acme Gym" });
    repository.memberships.push({ id: randomUUID(), user_id: userId, tenant_id: tenantId, role: "tenant_owner" });
    await repository.insertOAuthToken({ tokenHash: sha("uat_valid"), kind: "access", familyId: randomUUID(), clientId: client.client_id, userId, tenantId, expiresAt: new Date(Date.now() + 60_000) });
    const tokens = { access_token: "uat_valid" };
    const call = (token) => fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal((await call(tokens.access_token)).status, 200);
    const forged = await call("uat_forged");
    assert.equal(forged.status, 401);
    assert.match(forged.headers.get("www-authenticate"), /resource_metadata=/);
    assert.equal((await fetch(`${base}/.well-known/oauth-protected-resource`)).status, 200);
  } finally {
    delete mcpApp.locals.tenantServices;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await new Promise((resolve) => server.close(resolve));
  }
});
