import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import express from "express";
import { createReportRouter } from "./src/report/index.js";
import { InMemoryReportStore } from "./src/report/store.js";
import { allRequestedScopes, DEFAULT_ROLE_PACKS, effectivePacks, PACK_IDS, PACKS, PRESETS, roleAllows } from "./src/report/packs.js";
import { maskEmail, maskPhone, publicToolList, TOOL_DEFINITIONS } from "./src/report/tools.js";

const BASE = "https://gw.test";
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";

function baseEnv(extra = {}) {
  return {
    NODE_ENV: "test",
    REPORT_ENABLED: "true",
    MCP_RESOURCE_URL: BASE,
    REPORT_GHL_CLIENT_ID: "app-client",
    REPORT_GHL_CLIENT_SECRET: "app-secret",
    REPORT_GHL_REDIRECT_URI: `${BASE}/report/oauth/callback`,
    TENANT_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    REPORT_ADMIN_EMAILS: "boss@uplifting.test",
    REPORT_SESSION_SECRET: randomBytes(32).toString("hex"),
    REPORT_DEV_LOGIN: "true",
    REPORT_ALLOW_UNKNOWN_INSTALLS: "true",
    ...extra
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Fake HighLevel. Records every call so tests can assert what was sent.
function fakeHighLevel({ locationId = "LOC1TESTLOCATION", userId = "U1", email = "an@example.com" } = {}) {
  const calls = [];
  let refreshCount = 0;
  const impl = async (url, init = {}) => {
    const u = new URL(String(url));
    const headers = init.headers || {};
    calls.push({ method: init.method || "GET", path: u.pathname, search: u.search, authorization: headers.Authorization, body: init.body ? String(init.body) : null });
    if (u.pathname === "/oauth/token") {
      const params = new URLSearchParams(String(init.body));
      if (params.get("grant_type") === "refresh_token") {
        refreshCount += 1;
        return json({ access_token: `ghl_access_r${refreshCount}`, refresh_token: `ghl_refresh_r${refreshCount}`, expires_in: 86400, scope: "contacts.readonly" });
      }
      return json({ access_token: "ghl_access_1", refresh_token: "ghl_refresh_1", expires_in: 86400, locationId, userId, scope: "contacts.readonly" });
    }
    if (u.pathname === "/users/") return json({ users: [{ id: userId, firstName: "An", lastName: "Nguyen", email, roles: { role: "admin" } }] });
    if (u.pathname.startsWith("/locations/")) return json({ location: { name: "Trung tâm A" } });
    if (u.pathname === "/contacts/") {
      return json({ contacts: [{ id: "c1", contactName: "Lan", email: "lan@example.com", phone: "+84901234567", tags: ["vip"], source: "facebook", dateAdded: "2026-10-02T00:00:00Z" }], meta: { total: 1 } });
    }
    if (u.pathname === "/payments/orders") return json({ data: [{ _id: "o1", amount: 100, currency: "VND", status: "paid", createdAt: "2026-10-03T00:00:00Z", contactEmail: "lan@example.com" }], totalCount: 1 });
    return json({ message: "not mocked" }, 404);
  };
  return { impl, calls, get refreshCount() { return refreshCount; } };
}

async function startGateway({ env = baseEnv(), ghl = fakeHighLevel() } = {}) {
  const store = new InMemoryReportStore();
  const app = express();
  app.use(express.json());
  app.locals.reportStore = store;
  app.use(createReportRouter({ env, fetchImpl: ghl.impl }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { store, ghl, env, origin, close: () => new Promise((resolve) => server.close(resolve)) };
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

async function register(g) {
  const res = await fetch(`${g.origin}/report/oauth/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "ChatGPT" })
  });
  assert.equal(res.status, 201);
  return (await res.json()).client_id;
}

async function startAuthorize(g, clientId, challenge) {
  const url = new URL(`${g.origin}/report/oauth/authorize`);
  Object.entries({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "client-state", resource: `${BASE}/report/mcp` })
    .forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { redirect: "manual" });
  assert.equal(res.status, 200);
  const html = await res.text();
  return /oauth\/authorize\/highlevel\?s=([^"]+)"/.exec(html)[1];
}

async function exchange(g, clientId, code, verifier) {
  const res = await fetch(`${g.origin}/report/oauth/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: verifier })
  });
  return { status: res.status, body: await res.json() };
}

// Full HighLevel-admin install: returns the issued tokens.
async function adminConnect(g) {
  const clientId = await register(g);
  const { verifier, challenge } = pkce();
  const state = await startAuthorize(g, clientId, challenge);
  const cb = await fetch(`${g.origin}/report/oauth/callback?code=ghlcode&state=${state}`, { redirect: "manual" });
  assert.equal(cb.status, 302, "callback should redirect back to the client");
  const location = new URL(cb.headers.get("location"));
  assert.equal(location.searchParams.get("state"), "client-state");
  const tokens = await exchange(g, clientId, location.searchParams.get("code"), verifier);
  assert.equal(tokens.status, 200);
  return { clientId, ...tokens.body };
}

async function rpc(g, token, method, params = {}) {
  const res = await fetch(`${g.origin}/report/mcp`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

const callTool = (g, token, name, args = {}) => rpc(g, token, "tools/call", { name, arguments: args });

async function adminSession(g) {
  const login = await fetch(`${g.origin}/report-admin/login`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "boss@uplifting.test" })
  });
  const link = /href="([^"]*verify[^"]*)"/.exec((await login.text()).replace(/&amp;/g, "&"))[1];
  const verify = await fetch(`${g.origin}/report-admin/verify${new URL(link).search}`, { redirect: "manual" });
  assert.equal(verify.status, 302);
  const setCookie = verify.headers.getSetCookie()[0];
  // The sign-in link is opened from an email (cross-site). Strict cookies are dropped on the redirect that follows.
  assert.match(setCookie, /SameSite=Lax/);
  assert.doesNotMatch(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(";")[0];
  const page = async (path) => (await fetch(`${g.origin}${path}`, { headers: { cookie } })).text();
  const post = (path, fields) => fetch(`${g.origin}${path}`, {
    method: "POST", redirect: "manual", headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields)
  });
  const csrfOf = async (path) => /name="csrf" value="([^"]+)"/.exec(await page(path))[1];
  return { cookie, page, post, csrfOf };
}

// ---------------------------------------------------------------------------

test("packs: pending or suspended customers get nothing; role and grant must both allow", () => {
  const permissions = { grants: { contacts: true, payments: true }, rolePacks: {} };
  assert.deepEqual(effectivePacks({ tenantStatus: "pending", role: "owner", permissions }), []);
  assert.deepEqual(effectivePacks({ tenantStatus: "suspended", role: "owner", permissions }), []);
  assert.deepEqual(effectivePacks({ tenantStatus: "active", role: "owner", permissions }), ["contacts", "payments"]);
  // staff default excludes payments even though the customer has it enabled
  assert.deepEqual(effectivePacks({ tenantStatus: "active", role: "staff", permissions }), ["contacts"]);
  // an explicit per-customer override beats the default
  const override = { grants: permissions.grants, rolePacks: { "staff:payments": true, "staff:contacts": false } };
  assert.deepEqual(effectivePacks({ tenantStatus: "active", role: "staff", permissions: override }), ["payments"]);
  assert.equal(roleAllows({}, "viewer", "payments"), false);
  assert.ok(DEFAULT_ROLE_PACKS.admin.includes("payments"));
});

test("scopes requested by the app are read-only and cover every pack, including custom objects and social planner", () => {
  const scopes = allRequestedScopes();
  assert.ok(scopes.every((scope) => scope.endsWith(".readonly")), `non-readonly scope found: ${scopes.filter((s) => !s.endsWith(".readonly"))}`);
  for (const wanted of ["objects/record.readonly", "objects/schema.readonly", "socialplanner/post.readonly", "contacts.readonly"]) assert.ok(scopes.includes(wanted), wanted);
  assert.ok(PRESETS.basic.packs.every((pack) => PACK_IDS.includes(pack)));
});

test("tools: every tool belongs to exactly one pack (or is get_my_permissions), is read-only and has no locationId parameter", () => {
  const packed = PACK_IDS.flatMap((id) => PACKS[id].tools);
  assert.equal(new Set(packed).size, packed.length);
  assert.deepEqual([...TOOL_DEFINITIONS.map((t) => t.name)].sort(), [...packed, "get_my_permissions"].sort());
  for (const tool of publicToolList()) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.inputSchema.properties.locationId, undefined, `${tool.name} must not accept locationId`);
  }
  assert.equal(maskEmail("lan@example.com"), "l***@example.com");
  assert.equal(maskPhone("+84901234567"), "*********567");
});

test("the module is invisible (404) unless REPORT_ENABLED=true", async () => {
  const g = await startGateway({ env: baseEnv({ REPORT_ENABLED: "false" }) });
  try {
    for (const path of ["/report/mcp", "/report/oauth/authorize", "/report-admin", "/.well-known/oauth-authorization-server/report"]) {
      const res = await fetch(`${g.origin}${path}`);
      assert.equal(res.status, 404, path);
    }
  } finally { await g.close(); }
});

test("discovery documents point at the /report endpoints; tools/list needs no token; tools/call needs one", async () => {
  const g = await startGateway();
  try {
    const as = await (await fetch(`${g.origin}/.well-known/oauth-authorization-server/report`)).json();
    assert.equal(as.issuer, `${BASE}/report`);
    assert.equal(as.token_endpoint, `${BASE}/report/oauth/token`);
    const pr = await (await fetch(`${g.origin}/.well-known/oauth-protected-resource/report/mcp`)).json();
    assert.equal(pr.resource, `${BASE}/report/mcp`);
    const list = await rpc(g, null, "tools/list");
    assert.equal(list.status, 200);
    assert.ok(list.body.result.tools.length >= 15);
    const unauth = await callTool(g, null, "crm_search_contacts");
    assert.equal(unauth.status, 401);
    assert.match(unauth.headers.get("www-authenticate"), /resource_metadata="https:\/\/gw\.test\/\.well-known\/oauth-protected-resource\/report\/mcp"/);
  } finally { await g.close(); }
});

test("install -> pending (nothing usable) -> admin approves -> packs work and are enforced", async () => {
  const g = await startGateway();
  try {
    const { access_token: token } = await adminConnect(g);

    // The install requested only read-only scopes from HighLevel.
    const consent = await fetch(`${g.origin}/report/oauth/authorize/highlevel?s=x`, { redirect: "manual" });
    const consentScope = new URL(consent.headers.get("location")).searchParams.get("scope");
    assert.ok(consentScope.split(" ").every((s) => s.endsWith(".readonly")));

    const me = (await callTool(g, token, "get_my_permissions")).body.result.structuredContent;
    assert.equal(me.tenantStatus, "pending");
    assert.equal(me.role, "owner");
    assert.deepEqual(me.allowedTools, ["get_my_permissions"]);

    const denied = (await callTool(g, token, "crm_search_contacts")).body.result;
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /chờ Uplifting duyệt/);
    assert.equal(g.ghl.calls.some((c) => c.path === "/contacts/"), false, "a pending customer must never reach HighLevel data");

    const admin = await adminSession(g);
    const tenantId = (await g.store.listTenants())[0].id;
    const dashboard = await admin.page("/report-admin");
    assert.match(dashboard, /Trung tâm A/);
    assert.match(dashboard, /Chờ duyệt/);

    // Missing/forged CSRF is refused and changes nothing.
    const forged = await admin.post(`/report-admin/tenants/${tenantId}/approve`, { preset: "basic", csrf: "nope" });
    assert.equal(forged.status, 403);
    assert.equal((await g.store.getTenant(tenantId)).status, "pending");

    const csrf = await admin.csrfOf(`/report-admin/tenants/${tenantId}`);
    const approved = await admin.post(`/report-admin/tenants/${tenantId}/approve`, { preset: "basic", csrf });
    assert.equal(approved.status, 303);
    assert.equal((await g.store.getTenant(tenantId)).status, "active");

    const contacts = (await callTool(g, token, "crm_search_contacts", { query: "lan", locationId: "SOMEONE-ELSE" })).body.result.structuredContent;
    assert.equal(contacts.contacts[0].email, "l***@example.com", "email is masked by default");
    assert.equal(contacts.contacts[0].phone.endsWith("567"), true);
    const call = g.ghl.calls.find((c) => c.path === "/contacts/");
    assert.match(call.search, /locationId=LOC1TESTLOCATION/);
    assert.doesNotMatch(call.search, /SOMEONE-ELSE/, "a model-supplied locationId must be ignored");
    assert.equal(call.authorization, "Bearer ghl_access_1");

    const unmasked = (await callTool(g, token, "crm_search_contacts", { includePii: true })).body.result.structuredContent;
    assert.equal(unmasked.contacts[0].email, "lan@example.com");

    // Payments is not in the basic preset.
    const payments = (await callTool(g, token, "crm_list_orders")).body.result;
    assert.equal(payments.isError, true);
    assert.match(payments.content[0].text, /chưa được bật/);
    assert.equal(g.ghl.calls.some((c) => c.path === "/payments/orders"), false);

    // Turn payments on for the customer: now it works.
    const grantsCsrf = await admin.csrfOf(`/report-admin/tenants/${tenantId}`);
    await admin.post(`/report-admin/tenants/${tenantId}/grants`, { csrf: grantsCsrf, grant_contacts: "on", grant_payments: "on" });
    const orders = (await callTool(g, token, "crm_list_orders")).body.result.structuredContent;
    assert.equal(orders.orders[0].contactEmail, "l***@example.com");
    const revenue = (await callTool(g, token, "crm_revenue_summary")).body.result.structuredContent;
    assert.equal(revenue.totalAmount, 100);
    // ...and contacts still works while opportunities (no longer ticked) does not.
    assert.equal((await callTool(g, token, "crm_list_pipelines")).body.result.isError, true);

    const audit = await g.store.listAudit({ tenantId, limit: 100 });
    assert.ok(audit.some((a) => a.action === "tenant.approved" && a.actor === "boss@uplifting.test"));
    assert.ok(audit.some((a) => a.tool === "crm_search_contacts" && a.result === "denied"));
    assert.ok(audit.some((a) => a.tool === "crm_search_contacts" && a.result === "success"));
    assert.equal(JSON.stringify(audit).includes("ghl_access_1"), false, "audit must never hold tokens");
    assert.equal(JSON.stringify(audit).includes("lan@example.com"), false, "audit must not hold customer data");
  } finally { await g.close(); }
});

test("a staff access code gets the staff role: packs the role lacks stay closed even when the customer has them", async () => {
  const g = await startGateway();
  try {
    const owner = await adminConnect(g);
    const tenantId = (await g.store.listTenants())[0].id;
    await g.store.setTenantStatus(tenantId, "active");
    for (const pack of ["contacts", "payments"]) await g.store.setPackGrant(tenantId, pack, true, "test");

    const admin = await adminSession(g);
    const csrf = await admin.csrfOf(`/report-admin/tenants/${tenantId}`);
    const invite = await admin.post(`/report-admin/tenants/${tenantId}/invites`, { csrf, email: "Staff@Example.com", role: "staff" });
    const code = /class="code">(rac_[^<]+)</.exec(await invite.text())[1];

    const clientId = await register(g);
    const attempt = async (email, accessCode) => {
      const { verifier, challenge } = pkce();
      const state = await startAuthorize(g, clientId, challenge);
      const res = await fetch(`${g.origin}/report/oauth/authorize/code`, {
        method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ s: state, email, code: accessCode })
      });
      return { res, verifier };
    };

    const wrongEmail = await attempt("other@example.com", code);
    assert.equal(wrongEmail.res.status, 403);
    const good = await attempt("staff@example.com", code);
    assert.equal(good.res.status, 302);
    const staffTokens = await exchange(g, clientId, new URL(good.res.headers.get("location")).searchParams.get("code"), good.verifier);
    const staffToken = staffTokens.body.access_token;

    const reuse = await attempt("staff@example.com", code);
    assert.equal(reuse.res.status, 403, "an access code works once");

    const me = (await callTool(g, staffToken, "get_my_permissions")).body.result.structuredContent;
    assert.equal(me.role, "staff");
    assert.equal((await callTool(g, staffToken, "crm_search_contacts")).body.result.isError, undefined);
    const noPayments = (await callTool(g, staffToken, "crm_list_orders")).body.result;
    assert.equal(noPayments.isError, true);
    assert.match(noPayments.content[0].text, /Vai trò "staff"/);
    // The owner, same customer, still can.
    assert.equal((await callTool(g, owner.access_token, "crm_list_orders")).body.result.isError, undefined);

    // Revoking the member cuts them off immediately, mid-session, and blocks refresh.
    const members = await g.store.listMembers(tenantId);
    const staff = members.find((m) => m.email === "staff@example.com");
    const revokeCsrf = await admin.csrfOf(`/report-admin/tenants/${tenantId}`);
    await admin.post(`/report-admin/tenants/${tenantId}/members/${staff.userId}/revoke`, { csrf: revokeCsrf });
    assert.equal((await callTool(g, staffToken, "crm_search_contacts")).status, 401);
    const refreshed = await fetch(`${g.origin}/report/oauth/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: staffTokens.body.refresh_token })
    });
    assert.equal(refreshed.status, 400);
  } finally { await g.close(); }
});

test("suspending a customer cuts every session; a replayed refresh token kills its whole family", async () => {
  const g = await startGateway();
  try {
    const owner = await adminConnect(g);
    const tenantId = (await g.store.listTenants())[0].id;
    await g.store.setTenantStatus(tenantId, "active");
    await g.store.setPackGrant(tenantId, "contacts", true, "test");
    assert.equal((await callTool(g, owner.access_token, "crm_search_contacts")).body.result.isError, undefined);

    const refresh = (token) => fetch(`${g.origin}/report/oauth/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: owner.clientId, refresh_token: token })
    });
    const first = await refresh(owner.refresh_token);
    assert.equal(first.status, 200);
    const next = await first.json();
    assert.equal((await refresh(owner.refresh_token)).status, 400, "an already-used refresh token is rejected");
    assert.equal((await refresh(next.refresh_token)).status, 400, "...and its replacement is revoked with the family");
    assert.equal((await callTool(g, next.access_token, "crm_search_contacts")).status, 401);

    const fresh = await adminConnect(g);
    const admin = await adminSession(g);
    const csrf = await admin.csrfOf(`/report-admin/tenants/${tenantId}`);
    await admin.post(`/report-admin/tenants/${tenantId}/status`, { csrf, status: "suspended" });
    assert.equal((await callTool(g, fresh.access_token, "crm_search_contacts")).status, 401);
  } finally { await g.close(); }
});

test("an agency-wide grant (no locationId) is refused instead of guessing a customer", async () => {
  const ghl = fakeHighLevel({ locationId: null });
  const g = await startGateway({ ghl });
  try {
    const clientId = await register(g);
    const state = await startAuthorize(g, clientId, pkce().challenge);
    const cb = await fetch(`${g.origin}/report/oauth/callback?code=ghlcode&state=${state}`, { redirect: "manual" });
    assert.equal(cb.status, 403);
    assert.equal((await g.store.listTenants()).length, 0);
  } finally { await g.close(); }
});

test("the HighLevel credential is stored encrypted and refreshed when it expires", async () => {
  const ghl = fakeHighLevel();
  const g = await startGateway({ ghl });
  try {
    const owner = await adminConnect(g);
    const tenantId = (await g.store.listTenants())[0].id;
    await g.store.setTenantStatus(tenantId, "active");
    await g.store.setPackGrant(tenantId, "contacts", true, "test");
    const stored = await g.store.getConnection(tenantId);
    assert.equal(stored.encrypted_payload.includes(Buffer.from("ghl_access_1")), false, "token must not be readable in storage");

    // Force expiry: the next call must refresh once and use the new token.
    const { decryptCredential, encryptCredential } = await import("./src/credential-provider.js");
    const credential = decryptCredential(stored.encrypted_payload, g.env);
    await g.store.updateConnectionCredential(tenantId, encryptCredential({ ...credential, expires_at: new Date(Date.now() - 1000).toISOString() }, g.env), new Date(Date.now() - 1000));
    await callTool(g, owner.access_token, "crm_search_contacts");
    assert.equal(ghl.refreshCount, 1);
    assert.equal(ghl.calls.filter((c) => c.path === "/contacts/").pop().authorization, "Bearer ghl_access_r1");
    await callTool(g, owner.access_token, "crm_search_contacts");
    assert.equal(ghl.refreshCount, 1, "a fresh token is reused, not refreshed again");
  } finally { await g.close(); }
});

test("dashboard: no session means redirect to login; non-allow-listed email gets no usable link", async () => {
  const g = await startGateway();
  try {
    const anon = await fetch(`${g.origin}/report-admin`, { redirect: "manual" });
    assert.equal(anon.status, 302);
    assert.match(anon.headers.get("location"), /report-admin\/login/);
    const stranger = await fetch(`${g.origin}/report-admin/login`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "stranger@example.com" })
    });
    const html = await stranger.text();
    assert.equal(stranger.status, 200);
    assert.doesNotMatch(html, /verify\?token/);
    assert.equal((await fetch(`${g.origin}/report-admin/verify?token=forged`, { redirect: "manual" })).status, 400);
    const forgedCookie = await fetch(`${g.origin}/report-admin`, { redirect: "manual", headers: { cookie: "report_admin=e30.AAAA" } });
    assert.equal(forgedCookie.status, 302);
  } finally { await g.close(); }
});

test("without a session secret or admin list the dashboard does not exist", async () => {
  const g = await startGateway({ env: baseEnv({ REPORT_SESSION_SECRET: "short" }) });
  try {
    assert.equal((await fetch(`${g.origin}/report-admin/login`)).status, 404);
  } finally { await g.close(); }
});

test("pause switch: stops every tool call at once, from the dashboard, with no deploy; resume restores it", async () => {
  const g = await startGateway();
  try {
    const owner = await adminConnect(g);
    const tenantId = (await g.store.listTenants())[0].id;
    await g.store.setTenantStatus(tenantId, "active");
    await g.store.setPackGrant(tenantId, "contacts", true, "test");
    assert.equal((await callTool(g, owner.access_token, "crm_search_contacts")).body.result.isError, undefined);

    const admin = await adminSession(g);
    const forged = await admin.post("/report-admin/pause", { csrf: "nope", paused: "true" });
    assert.equal(forged.status, 403);
    assert.equal(await g.store.getSetting("paused"), null);

    const csrf = await admin.csrfOf("/report-admin");
    assert.equal((await admin.post("/report-admin/pause", { csrf, paused: "true" })).status, 303);
    assert.equal(await g.store.getSetting("paused"), "true");
    const before = g.ghl.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 5100)); // the switch is cached for 5s
    const paused = (await callTool(g, owner.access_token, "crm_search_contacts")).body.result;
    assert.equal(paused.isError, true);
    assert.match(paused.content[0].text, /tạm dừng/);
    assert.equal(g.ghl.calls.length, before, "no HighLevel call while paused");
    assert.match(await admin.page("/report-admin"), /Đang tạm dừng/);

    assert.equal((await admin.post("/report-admin/pause", { csrf, paused: "false" })).status, 303);
    await new Promise((resolve) => setTimeout(resolve, 5100));
    assert.equal((await callTool(g, owner.access_token, "crm_search_contacts")).body.result.isError, undefined);
    const audit = await g.store.listAudit({ limit: 100 });
    assert.ok(audit.some((a) => a.action === "system.paused"));
    assert.ok(audit.some((a) => a.action === "system.resumed"));
  } finally { await g.close(); }
});

test("bulkhead: only N tool calls run at once, a short queue waits, the rest are refused immediately", async () => {
  const ghl = fakeHighLevel();
  const inner = ghl.impl;
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  ghl.impl = async (url, init) => {
    if (new URL(String(url)).pathname === "/contacts/") await gate;
    return inner(url, init);
  };
  const g = await startGateway({ ghl, env: baseEnv({ REPORT_MAX_CONCURRENT: "1", REPORT_MAX_QUEUE: "1" }) });
  try {
    const owner = await adminConnect(g);
    const tenantId = (await g.store.listTenants())[0].id;
    await g.store.setTenantStatus(tenantId, "active");
    await g.store.setPackGrant(tenantId, "contacts", true, "test");
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const first = callTool(g, owner.access_token, "crm_search_contacts");
    await wait(80);
    const second = callTool(g, owner.access_token, "crm_search_contacts");
    await wait(80);
    const third = (await callTool(g, owner.access_token, "crm_search_contacts")).body.result;
    assert.equal(third.isError, true);
    assert.match(third.content[0].text, /đang bận/);

    // The posting app's traffic is not in this queue; here we only prove the report side drains correctly.
    open();
    assert.equal((await first).body.result.isError, undefined);
    assert.equal((await second).body.result.isError, undefined);
    assert.equal((await callTool(g, owner.access_token, "crm_search_contacts")).body.result.isError, undefined, "slots are released after use");
    const audit = await g.store.listAudit({ tenantId, limit: 100 });
    assert.ok(audit.some((a) => a.result === "busy"));
  } finally { open(); await g.close(); }
});

test("graceful shutdown: SIGTERM lets the server exit cleanly instead of being killed", async () => {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, PORT: "0", ENABLE_LEGACY_ADMIN_AUTH: "true", MCP_ADMIN_API_KEY: "shutdown-test-key", DATABASE_URL: "", REPORT_ENABLED: "false" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 8000);
    const check = () => (/listening on port/.test(out) ? (clearTimeout(timer), resolve()) : setTimeout(check, 50));
    check();
  });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  child.kill("SIGTERM");
  const result = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve({ code: "timeout" }), 6000))]);
  if (result.code === "timeout") child.kill("SIGKILL");
  assert.equal(result.code, 0);
  assert.match(out, /"event":"shutdown"/);
});

const LOC_ID = "LOC1TESTLOCATION"; // the location the fake HighLevel grants

test("pre-provisioning: unknown sub-accounts cannot connect by default", async () => {
  const g = await startGateway({ env: baseEnv({ REPORT_ALLOW_UNKNOWN_INSTALLS: "false" }) });
  try {
    const clientId = await register(g);
    const state = await startAuthorize(g, clientId, pkce().challenge);
    const cb = await fetch(`${g.origin}/report/oauth/callback?code=ghlcode&state=${state}`, { redirect: "manual" });
    assert.equal(cb.status, 403);
    assert.match(await cb.text(), /chưa được Uplifting kích hoạt/);
    assert.equal((await g.store.listTenants()).length, 0, "no customer is created by an unknown install");
    const audit = await g.store.listAudit({ limit: 20 });
    const rejected = audit.find((a) => a.action === "install.rejected");
    assert.equal(rejected.metadata.locationId, LOC_ID, "the admin can see which location tried");
  } finally { await g.close(); }
});

test("sold -> permissions set -> customer connects: a provisioned customer works at once, no approval step", async () => {
  const g = await startGateway({ env: baseEnv({ REPORT_ALLOW_UNKNOWN_INSTALLS: "false" }) });
  try {
    const admin = await adminSession(g);
    const csrf = await admin.csrfOf("/report-admin");
    const added = await admin.post("/report-admin/tenants", { csrf, locationId: LOC_ID, name: "Khách A", preset: "basic" });
    assert.equal(added.status, 303);
    const tenants = await g.store.listTenants();
    assert.equal(tenants.length, 1);
    assert.equal(tenants[0].status, "active");
    assert.equal(tenants[0].connected, false);
    assert.match(await admin.page("/report-admin"), /Chờ khách kết nối/);

    const owner = await adminConnect(g);
    const me = (await callTool(g, owner.access_token, "get_my_permissions")).body.result.structuredContent;
    assert.equal(me.tenantStatus, "active");
    assert.equal(me.tenant, "Khách A", "the name the admin typed is kept");
    assert.equal(me.packs.filter((p) => p.allowed).map((p) => p.id).sort().join(), "calendar,contacts,opportunities");
    assert.equal((await callTool(g, owner.access_token, "crm_search_contacts")).body.result.isError, undefined);
    assert.equal((await callTool(g, owner.access_token, "crm_list_orders")).body.result.isError, true, "packs outside the preset stay closed");
    assert.equal((await g.store.listTenants())[0].connected, true);
    assert.doesNotMatch(await admin.page("/report-admin"), /Chờ khách kết nối/);

    const bad = await admin.post("/report-admin/tenants", { csrf, locationId: "bad id!", preset: "basic" });
    assert.equal(bad.status, 400);
    const forged = await admin.post("/report-admin/tenants", { csrf: "nope", locationId: "ANOTHERLOC1TESTLOCATION2345", preset: "basic" });
    assert.equal(forged.status, 403);
  } finally { await g.close(); }
});

test("provisioning webhook: authenticated, validated, idempotent, never reactivates a suspended customer", async () => {
  const secret = randomBytes(32).toString("hex");
  const off = await startGateway();
  try {
    assert.equal((await fetch(`${off.origin}/report/provision`, { method: "POST" })).status, 404, "off without REPORT_PROVISION_SECRET");
  } finally { await off.close(); }

  const g = await startGateway({ env: baseEnv({ REPORT_ALLOW_UNKNOWN_INSTALLS: "false", REPORT_PROVISION_SECRET: secret }) });
  try {
    const call = (body, token = secret) => fetch(`${g.origin}/report/provision`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body)
    });
    assert.equal((await call({ locationId: LOC_ID }, null)).status, 401);
    assert.equal((await call({ locationId: LOC_ID }, "wrong-secret")).status, 401);
    assert.equal((await call({ locationId: "x" })).status, 400);
    assert.equal((await call({ locationId: LOC_ID, preset: "nope" })).status, 400);
    assert.equal((await call({ locationId: LOC_ID, packs: ["contacts", "hack"] })).status, 400);
    assert.equal((await g.store.listTenants()).length, 0, "rejected calls create nothing");

    const created = await call({ locationId: LOC_ID, name: "Khách B", packs: ["contacts", "social_planner"] });
    assert.equal(created.status, 201);
    const body = await created.json();
    assert.equal(body.created, true);
    const tenantId = body.tenantId;
    assert.equal((await g.store.getTenant(tenantId)).status, "active");
    assert.equal((await g.store.getPermissions(tenantId)).grants.social_planner, true);

    // The same webhook fired again must not change an existing customer ...
    await g.store.setPackGrant(tenantId, "contacts", false, "admin-edit");
    const again = await call({ locationId: LOC_ID, preset: "full" });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).applied, false);
    assert.equal((await g.store.getPermissions(tenantId)).grants.contacts, false, "an admin's edit survives a repeated webhook");
    // ... unless it asks to update.
    await call({ locationId: LOC_ID, packs: ["contacts"], update: true });
    assert.deepEqual(Object.entries((await g.store.getPermissions(tenantId)).grants).filter(([, v]) => v).map(([k]) => k), ["contacts"]);

    await g.store.setTenantStatus(tenantId, "suspended");
    await call({ locationId: LOC_ID, preset: "full", update: true });
    assert.equal((await g.store.getTenant(tenantId)).status, "suspended", "never reactivated by the webhook");

    await g.store.setTenantStatus(tenantId, "active");
    const owner = await adminConnect(g);
    assert.equal((await callTool(g, owner.access_token, "crm_search_contacts")).body.result.isError, undefined);
    const audit = await g.store.listAudit({ tenantId, limit: 50 });
    assert.ok(audit.some((a) => a.action === "tenant.provisioned" && a.actor === "webhook"));
    assert.equal(JSON.stringify(audit).includes(secret), false, "the webhook secret is never logged");
  } finally { await g.close(); }
});
