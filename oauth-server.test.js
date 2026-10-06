import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import express from "express";

import { app as mcpApp } from "./server.js";
import { protectedResourceMetadata } from "./src/auth.js";
import { authenticateIssuedToken, completeHighLevelLogin, createOAuthRouter, highLevelAuthorizeUrl, inviteTeamMember } from "./src/oauth-server.js";

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
    HIGHLEVEL_INVITE_WEBHOOK_URL: WEBHOOK_URL,
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

  teamInvites = new Map();
  emailLoginTokens = new Map();

  async createTeamInvite(v) { this.teamInvites.set(v.tokenHash, { ...v, tenant_id: v.tenantId, status: "pending" }); }
  async acceptTeamInvite(hash) {
    const invite = this.teamInvites.get(hash);
    if (!invite || invite.status !== "pending" || invite.expiresAt < new Date()) return null;
    invite.status = "accepted";
    let user = [...this.users.values()].find((u) => u.email?.toLowerCase() === invite.email.toLowerCase());
    if (!user) { user = { id: randomUUID(), auth_subject: `email:${invite.email.toLowerCase()}`, email: invite.email }; this.users.set(user.auth_subject, user); }
    if (!this.memberships.some((m) => m.user_id === user.id && m.tenant_id === invite.tenant_id)) {
      this.memberships.push({ id: randomUUID(), user_id: user.id, tenant_id: invite.tenant_id, role: invite.role });
    }
    return { userId: user.id, tenantId: invite.tenant_id, tenantName: this.tenants.get(invite.tenant_id)?.display_name, role: invite.role };
  }
  async findSoleMembershipByEmail(email) {
    const user = [...this.users.values()].find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (!user) return null;
    const matches = this.memberships.filter((m) => m.user_id === user.id);
    if (matches.length !== 1) return null;
    return { user_id: user.id, tenant_id: matches[0].tenant_id, role: matches[0].role, tenant_name: this.tenants.get(matches[0].tenant_id)?.display_name };
  }
  async createEmailLoginToken(v) { this.emailLoginTokens.set(v.tokenHash, { ...v, client_id: v.clientId, redirect_uri: v.redirectUri, code_challenge: v.codeChallenge, client_state: v.clientState, user_id: v.userId, tenant_id: v.tenantId, used: false }); }
  async consumeEmailLoginToken(hash) {
    const row = this.emailLoginTokens.get(hash);
    if (!row || row.used || row.expiresAt < new Date()) return null;
    row.used = true;
    return { ...row, poll_hash: row.pollHash };
  }
  async storeEmailLoginCompletion(hash, redirectUrl) { this.emailLoginTokens.get(hash).completedRedirect = redirectUrl; }
  async takeEmailLoginCompletion(pollHash) {
    const row = [...this.emailLoginTokens.values()].find((r) => r.pollHash === pollHash && r.completedRedirect);
    if (!row) return null;
    const redirect = row.completedRedirect;
    row.completedRedirect = null;
    return redirect;
  }
}

const WEBHOOK_URL = "https://services.leadconnectorhq.com/hooks/test-location/webhook-trigger/test-hook";

function highLevelFetch({ grant = {}, users, fail = false } = {}) {
  const webhookCalls = [];
  const fetchImpl = async (url, options = {}) => {
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
    if (String(url) === WEBHOOK_URL) {
      webhookCalls.push(JSON.parse(options.body));
      return json({ status: "Success: test request received" });
    }
    const parsed = new URL(String(url));
    if (parsed.pathname === "/oauth/token") {
      if (fail) return json({}, 400);
      return json({ access_token: "hl-access", refresh_token: "hl-refresh", locationId: LOCATION_ID, userId: "hl-user-1", expires_in: 86400, scope: "socialplanner/post.write", ...grant });
    }
    if (parsed.pathname === "/users/") return json({ users: users || [{ id: "hl-user-1", firstName: "Ada", lastName: "Owner", email: "ada@example.com", roles: { role: "admin" } }] });
    if (parsed.pathname.startsWith("/locations/")) return json({ location: { name: "Acme Gym" } });
    return json({}, 404);
  };
  fetchImpl.webhookCalls = webhookCalls;
  return fetchImpl;
}

async function withOAuthApp(configuration, { fetchImpl = highLevelFetch(), repository = new FakeRepository() } = {}, fn) {
  const app = express();
  app.use(express.json());
  app.use(createOAuthRouter({ env: configuration, getRepository: () => repository, fetchImpl }));
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

// /oauth/authorize now shows a "HighLevel or email" choice page (200) rather
// than redirecting straight to HighLevel; this helper clicks "Continue with
// HighLevel" for tests, so every existing caller still gets back a response
// whose Location has the highLevelState in `state`. A caller expecting the
// route's own error redirect/rejection (bad PKCE, unknown client) still sees
// that directly, since those return before the choice page ever renders.
async function beginLogin(base, clientId, challenge, extra = {}) {
  const params = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: CHATGPT_REDIRECT,
    code_challenge: challenge, code_challenge_method: "S256", state: "chatgpt-state", ...extra
  });
  const choice = await fetch(`${base}/oauth/authorize?${params}`, { redirect: "manual" });
  if (choice.status !== 200) return choice;
  const html = await choice.text();
  const s = /\/oauth\/authorize\/highlevel\?s=([^"&]+)/.exec(html)?.[1];
  assert.ok(s, "choice page must link to /oauth/authorize/highlevel with the login state");
  return fetch(`${base}/oauth/authorize/highlevel?s=${s}`, { redirect: "manual" });
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
    assert.deepEqual(metadata.scopes_supported, ["uplifting:read", "uplifting:write"]);
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
    assert.equal(target.searchParams.get("response_type"), "code");
    assert.equal(target.searchParams.get("redirect_uri"), "https://staging.example.com/oauth/callback/social-crm");
    assert.match(target.searchParams.get("scope"), /socialplanner\/post\.write/);
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
    // ChatGPT compares each tool's required scope with the token's scope and shows
    // "needs additional access" when none is granted (seen live on a new customer's first connect).
    assert.equal(tokens.scope, "uplifting:read uplifting:write");
    const scoped = await authenticateIssuedToken({ token: tokens.access_token, repository });
    assert.ok(scoped.scopes.has("uplifting:read") && scoped.scopes.has("uplifting:write"));

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

test("a second HighLevel user of the same sub-account joins the existing tenant as tenant_admin, even absent from the location's Users list", async () => {
  // HighLevel only lets a sub-account Admin reach this consent screen at
  // all (this app is Sub-Account type), so completing it already proves
  // Admin access -- regardless of whether the per-location Users API
  // happens to list this person (it won't, for an agency-level Admin with
  // inherited access; confirmed live 2026-09-30). The role must not depend
  // on that lookup.
  const repository = new FakeRepository();
  await withOAuthApp(env(), { repository }, async (base) => {
    const { body: client } = await register(base);
    await loginForCode(base, { challenge: pkce().challenge, clientId: client.client_id });
  });
  await withOAuthApp(env(), {
    repository,
    fetchImpl: highLevelFetch({ grant: { userId: "hl-user-2" }, users: [{ id: "hl-user-1", firstName: "Existing Owner", email: "owner@example.com", roles: { role: "admin" } }] })
  }, async (base) => {
    const { body: client } = await register(base);
    const { verifier, challenge } = pkce();
    const code = await loginForCode(base, { challenge, clientId: client.client_id });
    const tokens = await (await tokenRequest(base, { grant_type: "authorization_code", code, redirect_uri: CHATGPT_REDIRECT, client_id: client.client_id, code_verifier: verifier })).json();
    const principal = await authenticateIssuedToken({ token: tokens.access_token, repository });
    assert.equal(repository.tenants.size, 1);
    assert.equal(principal.role, "tenant_admin");
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

test("the invite_team_member tool is wired into /mcp and is gated to owners/admins", async () => {
  const repository = new FakeRepository();
  const previous = {};
  const values = env({ AUTH0_ISSUER_BASE_URL: undefined, AUTH0_AUDIENCE: undefined, HIGHLEVEL_INVITE_WEBHOOK_URL: undefined });
  for (const [key, value] of Object.entries(values)) { previous[key] = process.env[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  mcpApp.locals.tenantServices = { repository, credentialProvider: {} };
  const server = mcpApp.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { body: client } = await register(base);
    const tenantId = randomUUID();
    repository.tenants.set(tenantId, { id: tenantId, display_name: "Acme Gym" });
    const asRole = async (role, args) => {
      const userId = randomUUID();
      repository.users.set(`u-${userId}`, { id: userId, auth_subject: `u-${userId}`, email: null });
      repository.memberships.push({ id: randomUUID(), user_id: userId, tenant_id: tenantId, role });
      const token = `uat_${role}`;
      await repository.insertOAuthToken({ tokenHash: sha(token), kind: "access", familyId: randomUUID(), clientId: client.client_id, userId, tenantId, expiresAt: new Date(Date.now() + 60_000) });
      return fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "invite_team_member", arguments: args } }) });
    };
    const denied = await asRole("editor", { email: "teammate@example.com", role: "viewer" });
    const deniedBody = await denied.json();
    assert.ok(deniedBody.error, "an editor must not be able to invite teammates");
    assert.equal(repository.teamInvites.size, 0);

    const ok = await asRole("tenant_owner", { email: "teammate@example.com", role: "editor" });
    const okBody = await ok.json();
    assert.equal(okBody.result.structuredContent.invited, true);
    assert.equal(repository.teamInvites.size, 1);
  } finally {
    delete mcpApp.locals.tenantServices;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the HighLevel consent URL is the standard OAuth URL, taking version_id from the Marketplace install link", () => {
  const url = new URL(highLevelAuthorizeUrl(env({ HIGHLEVEL_INSTALL_URL: "https://app.gohighlevel.com/integration/abc123/versions/def456" }), "s1"));
  assert.equal(url.origin + url.pathname, "https://marketplace.gohighlevel.com/oauth/chooselocation");
  assert.equal(url.searchParams.get("version_id"), "def456");
  assert.equal(url.searchParams.get("state"), "s1");
  assert.equal(url.searchParams.get("scope").split(" ").length, 20);
  const whiteLabel = new URL(highLevelAuthorizeUrl(env({ HIGHLEVEL_AUTHORIZE_URL: "https://app.uplifting.vn/oauth/chooselocation" }), "s"));
  assert.equal(whiteLabel.origin + whiteLabel.pathname, "https://app.uplifting.vn/oauth/chooselocation");
  assert.equal(whiteLabel.searchParams.get("client_id"), "test-client");
  assert.equal(new URL(highLevelAuthorizeUrl(env({ HIGHLEVEL_OAUTH_SCOPES: "medias.readonly" }), "s")).searchParams.get("scope"), "medias.readonly");
});

test("tool discovery works without a token but every tool call still requires one", async () => {
  const repository = new FakeRepository();
  const previous = {};
  const values = env({ AUTH0_ISSUER_BASE_URL: undefined, AUTH0_AUDIENCE: undefined });
  for (const [key, value] of Object.entries(values)) { previous[key] = process.env[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  mcpApp.locals.tenantServices = { repository, credentialProvider: {} };
  const server = mcpApp.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const rpc = (body, headers = {}) => fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }) });
  try {
    const list = await rpc({ method: "tools/list" });
    assert.equal(list.status, 200);
    assert.ok((await list.json()).result.tools.length > 0);
    assert.equal((await rpc({ method: "initialize" })).status, 200);
    for (const method of ["tools/call", "resources/list"]) {
      const denied = await rpc({ method, params: { name: "list_social_accounts", arguments: {} } });
      assert.equal(denied.status, 401, method);
      assert.match(denied.headers.get("www-authenticate"), /resource_metadata=/);
    }
    const badToken = await rpc({ method: "tools/list" }, { authorization: "Bearer uat_forged" });
    assert.equal(badToken.status, 401, "a presented but invalid token is still rejected");
  } finally {
    delete mcpApp.locals.tenantServices;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await new Promise((resolve) => server.close(resolve));
  }
});

function inviteLinkToken(payload) {
  return new URL(payload.inviteLink).searchParams.get("token");
}

test("the sign-in choice page offers both HighLevel and email, without redirecting on its own", async () => {
  await withOAuthApp(env(), {}, async (base) => {
    const { body: client } = await register(base);
    const params = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: CHATGPT_REDIRECT, code_challenge: pkce().challenge, code_challenge_method: "S256", state: "s" });
    const choice = await fetch(`${base}/oauth/authorize?${params}`, { redirect: "manual" });
    assert.equal(choice.status, 200);
    const html = await choice.text();
    assert.match(html, /oauth\/authorize\/highlevel\?s=/);
    assert.match(html, /action="\/oauth\/authorize\/email"/);
  });
});

test("invite_team_member sends an email and the recipient becomes a member of the right tenant on accept", async () => {
  const fetchImpl = highLevelFetch();
  await withOAuthApp(env(), { fetchImpl }, async (base, repository) => {
    const { body: client } = await register(base);
    const { verifier, challenge } = pkce();
    const code = await loginForCode(base, { challenge, clientId: client.client_id });
    const tokens = await (await tokenRequest(base, { grant_type: "authorization_code", code, redirect_uri: CHATGPT_REDIRECT, client_id: client.client_id, code_verifier: verifier })).json();
    const owner = await authenticateIssuedToken({ token: tokens.access_token, repository });
    assert.equal(owner.role, "tenant_owner");
    const { tenantId, tenantName } = owner;

    await inviteTeamMember({ repository, env: env(), fetchImpl, tenantId, tenantName, invitedByUserId: owner.userId, inviterName: "Ada", email: "teammate@example.com", role: "editor" });

    assert.equal(fetchImpl.webhookCalls.length, 1);
    const invite = fetchImpl.webhookCalls[0];
    assert.equal(invite.email, "teammate@example.com");
    assert.equal(invite.tenantName, tenantName);
    assert.equal(invite.inviterName, "Ada");
    assert.match(invite.inviteLink, /\/invite\/accept\?token=/);

    const accept = await fetch(`${base}${new URL(invite.inviteLink).pathname}${new URL(invite.inviteLink).search}`, { redirect: "manual" });
    assert.equal(accept.status, 200);
    assert.match(await accept.text(), /You&#39;re in/);

    const membership = repository.memberships.find((m) => m.tenant_id === tenantId && m.user_id !== owner.userId);
    assert.ok(membership, "a membership row for the invited teammate must exist");
    assert.equal(membership.role, "editor");
  });
});

test("an invite link is single-use and rejects once expired or already accepted", async () => {
  const fetchImpl = highLevelFetch();
  await withOAuthApp(env(), { fetchImpl }, async (base, repository) => {
    const { body: client } = await register(base);
    await loginForCode(base, { challenge: pkce().challenge, clientId: client.client_id });
    const tenantId = [...repository.tenants.keys()][0];
    await inviteTeamMember({ repository, env: env(), fetchImpl, tenantId, tenantName: "Acme Gym", invitedByUserId: null, email: "again@example.com", role: "viewer" });
    const token = inviteLinkToken(fetchImpl.webhookCalls[0]);
    const first = await fetch(`${base}/invite/accept?token=${token}`, { redirect: "manual" });
    assert.equal(first.status, 200);
    const replay = await fetch(`${base}/invite/accept?token=${token}`, { redirect: "manual" });
    assert.equal(replay.status, 400);
    assert.match(await replay.text(), /expired/);
    assert.equal((await fetch(`${base}/invite/accept?token=does-not-exist`)).status, 400);
  });
});

test("an invited teammate signs into a fresh ChatGPT connection by email, with no HighLevel step at all", async () => {
  const fetchImpl = highLevelFetch();
  await withOAuthApp(env(), { fetchImpl }, async (base, repository) => {
    const { body: ownerClient } = await register(base);
    await loginForCode(base, { challenge: pkce().challenge, clientId: ownerClient.client_id });
    const tenantId = [...repository.tenants.keys()][0];
    await inviteTeamMember({ repository, env: env(), fetchImpl, tenantId, tenantName: "Acme Gym", invitedByUserId: null, email: "teammate@example.com", role: "editor" });
    await fetch(`${base}/invite/accept?token=${inviteLinkToken(fetchImpl.webhookCalls[0])}`);
    fetchImpl.webhookCalls.length = 0;

    // The teammate's own connector: a separate client registration from the owner's.
    const { body: memberClient } = await register(base);
    const { verifier, challenge } = pkce();
    const params = new URLSearchParams({ response_type: "code", client_id: memberClient.client_id, redirect_uri: CHATGPT_REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "member-state" });
    const choice = await fetch(`${base}/oauth/authorize?${params}`, { redirect: "manual" });
    const s = /\/oauth\/authorize\/highlevel\?s=([^"&]+)/.exec(await choice.text())[1];

    const emailStep = await fetch(`${base}/oauth/authorize/email`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ s, email: "teammate@example.com" }) });
    assert.equal(emailStep.status, 200);
    const waitingPage = await emailStep.text();
    const pollSecret = /var p=("[^"]+")/.exec(waitingPage) && JSON.parse(/var p=("[^"]+")/.exec(waitingPage)[1]);
    assert.ok(pollSecret, "the waiting page must carry a poll secret so the original window can finish by itself");
    assert.equal(fetchImpl.webhookCalls.length, 1);
    const signInLink = fetchImpl.webhookCalls[0].inviteLink;
    assert.match(signInLink, /\/oauth\/email-login\/verify\?token=/);

    // The link may be opened anywhere (another tab/device); until it is, polling stays pending.
    assert.deepEqual(await (await fetch(`${base}/oauth/email-login/poll?p=${encodeURIComponent(pollSecret)}`)).json(), { pending: true });
    const verify = await fetch(signInLink.replace("https://staging.example.com", base), { redirect: "manual" });
    assert.equal(verify.status, 200);
    assert.match(await verify.text(), /signed in/i);
    const poll = await (await fetch(`${base}/oauth/email-login/poll?p=${encodeURIComponent(pollSecret)}`)).json();
    const redirect = new URL(poll.redirect);
    assert.equal(redirect.origin + redirect.pathname, CHATGPT_REDIRECT);
    assert.equal(redirect.searchParams.get("state"), "member-state");
    assert.deepEqual(await (await fetch(`${base}/oauth/email-login/poll?p=${encodeURIComponent(pollSecret)}`)).json(), { pending: true }, "the finished redirect is handed out exactly once");
    assert.deepEqual(await (await fetch(`${base}/oauth/email-login/poll?p=not-the-secret`)).json(), { pending: true });

    const tokens = await (await tokenRequest(base, { grant_type: "authorization_code", code: redirect.searchParams.get("code"), redirect_uri: CHATGPT_REDIRECT, client_id: memberClient.client_id, code_verifier: verifier })).json();
    const member = await authenticateIssuedToken({ token: tokens.access_token, repository });
    assert.equal(member.role, "editor");
    assert.equal(member.tenantId, tenantId);
    assert.equal(member.subject, "email:teammate@example.com");

    // Replaying the same sign-in link, or guessing at an unrecognized email, both fail quietly.
    assert.equal((await fetch(signInLink.replace("https://staging.example.com", base))).status, 400);
  });
});

test("an unrecognized email at the sign-in screen gets the same generic reply and no email is sent (no account enumeration)", async () => {
  const fetchImpl = highLevelFetch();
  await withOAuthApp(env(), { fetchImpl }, async (base) => {
    const { body: client } = await register(base);
    const params = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: CHATGPT_REDIRECT, code_challenge: pkce().challenge, code_challenge_method: "S256", state: "s" });
    const choice = await fetch(`${base}/oauth/authorize?${params}`, { redirect: "manual" });
    const s = /\/oauth\/authorize\/highlevel\?s=([^"&]+)/.exec(await choice.text())[1];
    const response = await fetch(`${base}/oauth/authorize/email`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ s, email: "nobody@example.com" }) });
    assert.equal(response.status, 200);
    const page = await response.text();
    assert.match(page, /Check your email/);
    assert.match(page, /var p=/, "an unrecognized email gets the same waiting page, so it can't be told apart");
    assert.equal(fetchImpl.webhookCalls.length, 0, "no email is actually sent for an unrecognized address");
  });
});
