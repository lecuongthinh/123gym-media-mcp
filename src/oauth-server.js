import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import express from "express";
import { AuthenticationError, builtInOAuthEnabled } from "./auth.js";
import { encryptCredential } from "./credential-provider.js";
import { exchangeHighLevelCode } from "./highlevel-onboarding.js";
import { fetchHighLevelLocationName, fetchHighLevelUsers, pickDefaultUserId } from "./highlevel-users.js";
import { TenantAuthorizationError } from "./tenant-services.js";

const LOGIN_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 5 * 60_000;
const ACCESS_TTL_SECONDS = 3600;
const REFRESH_TTL_MS = 30 * 24 * 3600_000;
const ACCESS_PREFIX = "uat_";
const DEFAULT_REDIRECT_HOSTS = ["chatgpt.com", "chat.openai.com", "platform.openai.com"];
const PKCE_VALUE = /^[A-Za-z0-9\-._~]{43,128}$/;

// Every scope selected on the Marketplace app; HighLevel rejects a scope the app does not have.
const DEFAULT_HIGHLEVEL_SCOPES = [
  "medias.readonly", "medias.write", "users.readonly",
  ...["oauth.readonly", "oauth.write", "post.readonly", "post.write", "account.readonly", "account.write",
    "csv.readonly", "csv.write", "category.readonly", "category.write", "tag.readonly", "tag.write",
    "statistics.readonly", "comments.readonly", "comments.write", "watermarks.readonly", "watermarks.write"]
    .map((name) => `socialplanner/${name}`)
];

const EMAIL_LOGIN_TTL_MS = 15 * 60_000;
const INVITE_TTL_MS = 7 * 24 * 3600_000;

class LoginError extends Error {}

function oauthLog(event, fields = {}) {
  console.info(JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields }));
}

// The one GHL Workflow ("Inbound Webhook" -> Create Contact -> Send Email) in
// Uplifting's own CRM location that both invite and sign-in links go
// through; it is not tied to any customer's location. A misconfigured or
// missing URL must not break anything else, so failures are only logged.
async function sendSystemEmail(env, { fetchImpl = globalThis.fetch, email, inviteLink, tenantName, inviterName }) {
  const url = env.HIGHLEVEL_INVITE_WEBHOOK_URL;
  if (!url) { oauthLog("system_email_skipped", { reason: "no_webhook_url_configured" }); return; }
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, inviteLink, tenantName: tenantName || "", inviterName: inviterName || "" })
    });
    oauthLog("system_email_sent", { status: response.status });
  } catch (error) {
    oauthLog("system_email_failed", { errorMessage: error?.message || "Error" });
  }
}

function infoPage(title, message) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>` +
    `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem"><h1 style="font-size:1.25rem">${escapeHtml(title)}</h1>` +
    `<p>${message}</p></body>`;
}

function chooseLoginMethodPage(s) {
  const state = escapeHtml(s);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to Uplifting Social AI</title>` +
    `<body style="font-family:system-ui,sans-serif;max-width:26rem;margin:12vh auto;padding:0 1rem">` +
    `<h1 style="font-size:1.25rem">Sign in to Uplifting Social AI</h1>` +
    `<p><a href="/oauth/authorize/highlevel?s=${encodeURIComponent(s)}" style="display:block;text-align:center;padding:0.75rem;background:#111;color:#fff;border-radius:0.5rem;text-decoration:none;margin-bottom:1rem">Continue with HighLevel</a></p>` +
    `<p style="color:#666;text-align:center;margin:1rem 0">or, if a teammate invited you</p>` +
    `<form method="post" action="/oauth/authorize/email">` +
    `<input type="hidden" name="s" value="${state}">` +
    `<input type="email" name="email" required placeholder="you@example.com" style="width:100%;box-sizing:border-box;padding:0.6rem;border:1px solid #ccc;border-radius:0.5rem;margin-bottom:0.75rem">` +
    `<button type="submit" style="width:100%;padding:0.75rem;border:1px solid #111;background:#fff;border-radius:0.5rem;cursor:pointer">Email me a sign-in link</button>` +
    `</form></body>`;
}

// The standard OAuth consent URL works for any HighLevel user, including
// sub-account users; the Marketplace "Install link" does not carry `state`
// or the redirect for them and drops them into the normal dashboard.
export function highLevelAuthorizeUrl(env, state) {
  const url = new URL(env.HIGHLEVEL_AUTHORIZE_URL || "https://marketplace.gohighlevel.com/oauth/chooselocation");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", env.HIGHLEVEL_REDIRECT_URI);
  url.searchParams.set("client_id", env.HIGHLEVEL_CLIENT_ID);
  url.searchParams.set("scope", env.HIGHLEVEL_OAUTH_SCOPES || DEFAULT_HIGHLEVEL_SCOPES.join(" "));
  const versionId = env.HIGHLEVEL_VERSION_ID || /\/versions\/([A-Za-z0-9]+)/.exec(env.HIGHLEVEL_INSTALL_URL || "")?.[1];
  if (versionId) url.searchParams.set("version_id", versionId);
  url.searchParams.set("state", state);
  return url.toString();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function secret(prefix) {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

export { builtInOAuthEnabled };

export function oauthIssuer(env = process.env) {
  return String(env.MCP_RESOURCE_URL || "").replace(/\/+$/, "");
}

export function authorizationServerMetadata(env = process.env) {
  const issuer = oauthIssuer(env);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"]
  };
}

function redirectUriAllowed(value, env) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.hash) return false;
  if (url.protocol === "http:") return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:") return false;
  const extra = String(env.OAUTH_ALLOWED_REDIRECT_HOSTS || "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  return [...DEFAULT_REDIRECT_HOSTS, ...extra].includes(url.hostname.toLowerCase());
}

function redirectWith(base, params) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) url.searchParams.set(key, value);
  return url.toString();
}

function pkceMatches(verifier, challenge) {
  if (!PKCE_VALUE.test(String(verifier || ""))) return false;
  const computed = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const expected = Buffer.from(String(challenge));
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

function tokenError(res, status, error, description) {
  oauthLog("oauth_token", { result: "error", error, status });
  return res.status(status).json({ error, error_description: description });
}

async function issueTokens(repository, { familyId, clientId, userId, tenantId }) {
  const accessToken = secret(ACCESS_PREFIX);
  const refreshToken = secret("urt_");
  await repository.insertOAuthToken({
    tokenHash: sha256(accessToken), kind: "access", familyId, clientId, userId, tenantId,
    expiresAt: new Date(Date.now() + ACCESS_TTL_SECONDS * 1000)
  });
  await repository.insertOAuthToken({
    tokenHash: sha256(refreshToken), kind: "refresh", familyId, clientId, userId, tenantId,
    expiresAt: new Date(Date.now() + REFRESH_TTL_MS)
  });
  return { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TTL_SECONDS, refresh_token: refreshToken };
}

export async function authenticateIssuedToken({ token, repository }) {
  if (!token.startsWith(ACCESS_PREFIX)) return null;
  const row = await repository.findAccessToken(sha256(token));
  const record = row && await repository.resolvePrincipalForUserTenant(row.user_id, row.tenant_id);
  if (!record) throw new AuthenticationError("Bearer access token is invalid or expired.");
  return Object.freeze({
    authType: "oauth",
    userId: record.id,
    subject: record.auth_subject,
    email: record.email,
    tenantId: record.tenant_id,
    tenantName: record.tenant_name,
    membershipId: record.membership_id,
    role: record.role,
    scopes: new Set()
  });
}

// Finishes a login that started at /oauth/authorize: HighLevel has sent the
// user back with a code. Returns null when `state` is not a login request
// (so the caller can treat it as a plain HighLevel reconnect).
export async function completeHighLevelLogin({ query, repository, env = process.env, fetchImpl = globalThis.fetch }) {
  const state = typeof query.state === "string" ? query.state : "";
  if (!state) return null;
  const request = await repository.consumeLoginRequest(sha256(state));
  if (!request) return null;

  if (query.error) {
    return { redirectUrl: redirectWith(request.redirect_uri, { error: "access_denied", error_description: "HighLevel authorization was declined.", state: request.client_state }) };
  }
  try {
    if (typeof query.code !== "string" || !query.code) throw new LoginError("HighLevel did not return an authorization code.");
    const body = await exchangeHighLevelCode({ env, code: query.code, fetchImpl });
    if (!body.locationId) {
      throw new LoginError("This install granted agency-wide access. Open the install link while signed in to the customer's HighLevel sub-account (not the agency view) and try again.");
    }
    const locationId = body.locationId;
    let users = [];
    try { users = await fetchHighLevelUsers({ accessToken: body.access_token, locationId, fetchImpl }); } catch { users = []; }
    const me = body.userId ? users.find((user) => user.id === body.userId) : null;
    oauthLog("oauth_admin_detection", { usersCount: users.length, meFoundInUsersList: Boolean(me) });
    const locationName = await fetchHighLevelLocationName({ accessToken: body.access_token, locationId, fetchImpl }).catch(() => null);
    const expiresAt = new Date(Date.now() + Number(body.expires_in || 86400) * 1000).toISOString();

    // HighLevel's per-location Users list only names people explicitly added
    // to that sub-account -- an agency-level Admin with inherited access to
    // many sub-accounts (confirmed live 2026-09-30, thinh.seafarer@gmail.com
    // on "123 GYM Central Office") completes this OAuth grant successfully
    // but never appears in it, so `me` above is unreliable as an admin gate.
    // The real gate is HighLevel itself: this Marketplace app is Sub-Account
    // type, and HighLevel only lets a sub-account Admin reach this consent
    // screen at all (confirmed earlier in this project) -- reaching this
    // line with a per-location grant already proves Admin access, so anyone
    // joining an existing tenant this way becomes tenant_admin, not editor.
    const provisioned = await repository.provisionHighLevelLogin({
      subject: body.userId ? `highlevel:${body.userId}` : `highlevel:location:${locationId}`,
      email: me?.email || null,
      displayName: me?.name || null,
      locationId,
      newMemberRole: "tenant_admin",
      tenantName: locationName || `HighLevel ${locationId}`,
      allowCreateTenant: env.ENABLE_SELF_SERVE_SIGNUP === "true",
      encryptedPayload: encryptCredential({
        auth_mode: "location",
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        location_id: locationId,
        scope: body.scope || "",
        expires_at: expiresAt
      }, env),
      expiresAt,
      scopes: String(body.scope || "").split(/\s+/).filter(Boolean),
      defaultUserId: pickDefaultUserId(users)
    });

    const code = secret("uac_");
    await repository.createAuthCode({
      codeHash: sha256(code),
      clientId: request.client_id,
      redirectUri: request.redirect_uri,
      codeChallenge: request.code_challenge,
      userId: provisioned.userId,
      tenantId: provisioned.tenantId,
      expiresAt: new Date(Date.now() + CODE_TTL_MS)
    });
    oauthLog("oauth_login", { result: "code_issued", created: provisioned.created, role: provisioned.role });
    return { redirectUrl: redirectWith(request.redirect_uri, { code, state: request.client_state }) };
  } catch (error) {
    const expected = error instanceof LoginError || error instanceof TenantAuthorizationError;
    console.error("[oauth-login] failed:", expected ? error.message : (error?.code || error?.name || "Error"));
    return {
      status: expected ? 403 : 500,
      html: errorPage(expected ? error.message : "Sign-in failed. Please try again, or contact Uplifting if it keeps happening.")
    };
  }
}

function errorPage(message) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign-in problem</title>` +
    `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem"><h1 style="font-size:1.25rem">Could not sign you in</h1>` +
    `<p>${escapeHtml(message)}</p><p style="color:#666">You can close this window and try again from ChatGPT.</p></body>`;
}

// Called from the MCP invite_team_member tool. Never reveals whether the
// email was already a member elsewhere; a tenant_owner/tenant_admin invites
// blind and the invite link itself explains what happens.
export async function inviteTeamMember({ repository, env = process.env, fetchImpl = globalThis.fetch, tenantId, tenantName, invitedByUserId, inviterName, email, role }) {
  if (!["tenant_admin", "editor", "viewer"].includes(role)) {
    throw new Error("role must be one of: tenant_admin, editor, viewer.");
  }
  const token = secret("inv_");
  await repository.createTeamInvite({
    tokenHash: sha256(token),
    tenantId,
    email,
    role,
    invitedByUserId,
    expiresAt: new Date(Date.now() + INVITE_TTL_MS)
  });
  await sendSystemEmail(env, {
    fetchImpl,
    email,
    inviteLink: `${oauthIssuer(env)}/invite/accept?token=${token}`,
    tenantName,
    inviterName
  });
  oauthLog("team_invite_created", { role });
  return { invited: true, email, role };
}

export function createOAuthRouter({ env = process.env, getRepository, fetchImpl = globalThis.fetch } = {}) {
  const router = express.Router();
  const registrations = [];

  const ownPaths = [
    "/oauth/register", "/oauth/authorize", "/oauth/authorize/highlevel", "/oauth/authorize/email",
    "/oauth/email-login/verify", "/oauth/token", "/invite/accept",
    "/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"
  ];
  router.use(ownPaths, (req, res, next) => (builtInOAuthEnabled(env) ? next() : res.status(404).end()));

  router.get(["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"], (req, res) => {
    res.json(authorizationServerMetadata(env));
  });

  router.post("/oauth/register", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const cutoff = Date.now() - 3600_000;
    while (registrations.length && registrations[0] < cutoff) registrations.shift();
    if (registrations.length >= 60) return tokenError(res, 429, "temporarily_unavailable", "Too many registrations; try again later.");
    const { redirect_uris: redirectUris, client_name: clientName } = req.body || {};
    if (!Array.isArray(redirectUris) || redirectUris.length < 1 || redirectUris.length > 5 ||
        !redirectUris.every((uri) => typeof uri === "string" && redirectUriAllowed(uri, env))) {
      return tokenError(res, 400, "invalid_redirect_uri", "Every redirect_uri must be an https URL on an allowed host.");
    }
    const name = typeof clientName === "string" ? clientName.slice(0, 100) : null;
    const clientId = secret("mcp_");
    try {
      await getRepository(req).registerOAuthClient({ clientId, clientName: name, redirectUris });
    } catch {
      return tokenError(res, 503, "temporarily_unavailable", "Registration is unavailable.");
    }
    registrations.push(Date.now());
    oauthLog("oauth_register", { redirectHosts: redirectUris.map((uri) => new URL(uri).host) });
    return res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    });
  });

  router.get("/oauth/authorize", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const q = req.query;
    const repository = getRepository(req);
    const client = typeof q.client_id === "string" ? await repository.findOAuthClient(q.client_id).catch(() => null) : null;
    // Until the client and redirect_uri are proven valid, never redirect.
    if (!client || typeof q.redirect_uri !== "string" || !client.redirect_uris.includes(q.redirect_uri)) {
      oauthLog("oauth_authorize_rejected", { reason: "unknown_client_or_redirect" });
      return res.status(400).type("text/plain").send("Invalid client_id or redirect_uri.");
    }
    const fail = (error, description) => res.redirect(302, redirectWith(q.redirect_uri, { error, error_description: description, state: typeof q.state === "string" ? q.state : undefined }));
    if (q.response_type !== "code") return fail("unsupported_response_type", "response_type must be code.");
    if (q.code_challenge_method !== "S256" || !PKCE_VALUE.test(String(q.code_challenge || ""))) {
      return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
    }
    const issuer = oauthIssuer(env);
    if (q.resource !== undefined && q.resource !== issuer && q.resource !== `${issuer}/mcp`) {
      return fail("invalid_target", "Unknown resource.");
    }
    const highLevelState = randomBytes(32).toString("base64url");
    await repository.createLoginRequest({
      stateHash: sha256(highLevelState),
      clientId: client.client_id,
      redirectUri: q.redirect_uri,
      codeChallenge: q.code_challenge,
      clientState: typeof q.state === "string" ? q.state : null,
      resource: typeof q.resource === "string" ? q.resource : null,
      expiresAt: new Date(Date.now() + LOGIN_TTL_MS)
    });
    oauthLog("oauth_authorize", { redirectHost: new URL(q.redirect_uri).host, hasResource: typeof q.resource === "string" });
    return res.type("html").send(chooseLoginMethodPage(highLevelState));
  });

  // "Continue with HighLevel": the login request from /oauth/authorize above
  // is not consumed here -- it stays valid until the HighLevel callback (or
  // the email path below) actually uses it, so picking a method costs the
  // user nothing if they change their mind.
  router.get("/oauth/authorize/highlevel", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (typeof req.query.s !== "string" || !req.query.s) return res.status(400).type("text/plain").send("Missing state.");
    return res.redirect(302, highLevelAuthorizeUrl(env, req.query.s));
  });

  // "Email me a sign-in link": only works for an email a tenant owner/admin
  // already invited (see /invite/accept) -- this never creates a tenant or
  // membership itself.
  router.post("/oauth/authorize/email", express.urlencoded({ extended: false }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    const { s, email } = req.body || {};
    if (typeof s !== "string" || !s || typeof email !== "string" || !email) {
      return res.status(400).type("text/plain").send("Missing state or email.");
    }
    const repository = getRepository(req);
    const request = await repository.consumeLoginRequest(sha256(s));
    if (!request) return res.status(400).type("html").send(infoPage("Link expired", "This sign-in attempt expired. Go back to ChatGPT and try adding the connector again."));
    const membership = await repository.findSoleMembershipByEmail(email);
    if (!membership) {
      oauthLog("email_login_requested", { result: "not_found" });
      return res.type("html").send(infoPage("Check your email", "If that email has been invited to an Uplifting Social AI account, a sign-in link is on its way."));
    }
    const token = secret("elt_");
    await repository.createEmailLoginToken({
      tokenHash: sha256(token),
      clientId: request.client_id,
      redirectUri: request.redirect_uri,
      codeChallenge: request.code_challenge,
      clientState: request.client_state,
      userId: membership.user_id,
      tenantId: membership.tenant_id,
      expiresAt: new Date(Date.now() + EMAIL_LOGIN_TTL_MS)
    });
    await sendSystemEmail(env, {
      fetchImpl,
      email,
      inviteLink: `${oauthIssuer(env)}/oauth/email-login/verify?token=${token}`,
      tenantName: membership.tenant_name
    });
    oauthLog("email_login_requested", { result: "sent" });
    return res.type("html").send(infoPage("Check your email", "We sent a sign-in link to your email. Open it on this device to finish connecting ChatGPT."));
  });

  router.get("/oauth/email-login/verify", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const token = req.query.token;
    if (typeof token !== "string" || !token) return res.status(400).type("text/plain").send("Missing token.");
    const repository = getRepository(req);
    const login = await repository.consumeEmailLoginToken(sha256(token));
    if (!login) return res.status(400).type("html").send(infoPage("Link expired", "This sign-in link is invalid or already used. Ask for a new one from ChatGPT."));
    const principal = await repository.resolvePrincipalForUserTenant(login.user_id, login.tenant_id);
    if (!principal) return res.status(403).type("html").send(infoPage("Access revoked", "Your access to this account is no longer active."));
    const code = secret("uac_");
    await repository.createAuthCode({
      codeHash: sha256(code),
      clientId: login.client_id,
      redirectUri: login.redirect_uri,
      codeChallenge: login.code_challenge,
      userId: login.user_id,
      tenantId: login.tenant_id,
      expiresAt: new Date(Date.now() + CODE_TTL_MS)
    });
    oauthLog("email_login_verified", { role: principal.role });
    return res.redirect(302, redirectWith(login.redirect_uri, { code, state: login.client_state }));
  });

  // A tenant_owner/tenant_admin inviting a teammate by email -- see server.js
  // for the invite_team_member tool that calls this.
  router.get("/invite/accept", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const token = req.query.token;
    if (typeof token !== "string" || !token) return res.status(400).type("text/plain").send("Missing token.");
    const repository = getRepository(req);
    const accepted = await repository.acceptTeamInvite(sha256(token));
    if (!accepted) return res.status(400).type("html").send(infoPage("Invite expired", "This invite link is invalid, expired, or already used. Ask whoever invited you to send a new one."));
    oauthLog("team_invite_accepted", { role: accepted.role });
    return res.type("html").send(infoPage(
      "You're in!",
      `You now have access to <strong>${escapeHtml(accepted.tenantName || "Uplifting Social AI")}</strong>. ` +
      `Add the Uplifting Social AI connector in ChatGPT, then choose "Email me a sign-in link" using this same email address.`
    ));
  });

  router.post("/oauth/token", express.urlencoded({ extended: false }), async (req, res) => {
    res.set({ "Cache-Control": "no-store", Pragma: "no-cache" });
    const params = req.body || {};
    const basic = /^Basic\s+(.+)$/i.exec(req.get("authorization") || "");
    const clientId = params.client_id || (basic ? Buffer.from(basic[1], "base64").toString().split(":")[0] : "");
    const repository = getRepository(req);
    try {
      let owner;
      if (params.grant_type === "authorization_code") {
        if (!params.code || !params.redirect_uri || !params.code_verifier || !clientId) {
          return tokenError(res, 400, "invalid_request", "code, redirect_uri, client_id and code_verifier are required.");
        }
        const row = await repository.consumeAuthCode(sha256(String(params.code)));
        if (!row || row.client_id !== clientId || row.redirect_uri !== params.redirect_uri || !pkceMatches(params.code_verifier, row.code_challenge)) {
          return tokenError(res, 400, "invalid_grant", "Authorization code is invalid, expired, or already used.");
        }
        owner = { familyId: randomUUID(), clientId: row.client_id, userId: row.user_id, tenantId: row.tenant_id };
      } else if (params.grant_type === "refresh_token") {
        if (!params.refresh_token || !clientId) return tokenError(res, 400, "invalid_request", "refresh_token and client_id are required.");
        const row = await repository.consumeRefreshToken(sha256(String(params.refresh_token)));
        if (!row || row.client_id !== clientId) return tokenError(res, 400, "invalid_grant", "Refresh token is invalid, expired, or already used.");
        owner = { familyId: row.family_id, clientId: row.client_id, userId: row.user_id, tenantId: row.tenant_id };
      } else {
        return tokenError(res, 400, "unsupported_grant_type", "Supported grant types: authorization_code, refresh_token.");
      }
      const tokens = await issueTokens(repository, owner);
      oauthLog("oauth_token", { grant: params.grant_type, result: "issued" });
      repository.deleteExpiredOAuthArtifacts?.().catch(() => {});
      return res.json(tokens);
    } catch {
      return tokenError(res, 500, "server_error", "Token service unavailable.");
    }
  });

  return router;
}
