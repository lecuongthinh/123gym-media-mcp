import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import express from "express";
import { encryptCredential } from "../credential-provider.js";
import { fetchHighLevelLocationName, fetchHighLevelUsers } from "../highlevel-users.js";
import { exchangeCode, reportAppEnv } from "./ghl.js";
import { allRequestedScopes } from "./packs.js";
import { ReportAccessError } from "./store.js";

// OAuth 2.1 authorization server for the report MCP, mounted under /report.
// ChatGPT/Claude register dynamically, then the user either authorizes the
// Marketplace app in HighLevel (admins) or enters an access code an Uplifting
// admin created for them (staff). One approval = sign-in + connection.

const LOGIN_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 5 * 60_000;
const ACCESS_TTL_SECONDS = 3600;
const REFRESH_TTL_MS = 30 * 24 * 3600_000;
const INVITE_TTL_MS = 7 * 24 * 3600_000;
const ACCESS_PREFIX = "rpt_";
export const MCP_SCOPE = "report:read";
const DEFAULT_REDIRECT_HOSTS = ["chatgpt.com", "chat.openai.com", "platform.openai.com", "claude.ai", "claude.com"];
const PKCE_VALUE = /^[A-Za-z0-9\-._~]{43,128}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function secret(prefix, bytes = 32) {
  return `${prefix}${randomBytes(bytes).toString("base64url")}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function log(event, fields = {}) {
  console.info(JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields }));
}

export function reportBase(env = process.env) {
  return `${String(env.MCP_RESOURCE_URL || "").replace(/\/+$/, "")}/report`;
}

export function reportOAuthEnabled(env = process.env) {
  // Without a database the module would silently fall back to an in-memory store
  // that forgets every customer on restart, so production requires DATABASE_URL.
  const storageReady = Boolean(env.DATABASE_URL) || env.NODE_ENV !== "production";
  return env.REPORT_ENABLED === "true" && storageReady && Boolean(env.MCP_RESOURCE_URL && env.REPORT_GHL_CLIENT_ID && env.REPORT_GHL_CLIENT_SECRET &&
    env.REPORT_GHL_REDIRECT_URI && env.TENANT_CREDENTIAL_ENCRYPTION_KEY);
}

export function authorizationServerMetadata(env = process.env) {
  const issuer = reportBase(env);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [MCP_SCOPE]
  };
}

export function protectedResourceMetadata(env = process.env) {
  const base = reportBase(env);
  return { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: [MCP_SCOPE], bearer_methods_supported: ["header"] };
}

export function resourceMetadataUrl(env = process.env) {
  return `${String(env.MCP_RESOURCE_URL || "").replace(/\/+$/, "")}/.well-known/oauth-protected-resource/report/mcp`;
}

function redirectUriAllowed(value, env) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.hash) return false;
  if (url.protocol === "http:") return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:") return false;
  const extra = String(env.REPORT_ALLOWED_REDIRECT_HOSTS || "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
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

function page(title, body) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>` +
    `<body style="font-family:system-ui,sans-serif;max-width:28rem;margin:12vh auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.25rem">${escapeHtml(title)}</h1>${body}</body>`;
}

function choosePage(state, message = "") {
  const s = escapeHtml(state);
  return page("Kết nối dữ liệu CRM", `${message ? `<p style="color:#b00020">${escapeHtml(message)}</p>` : ""}` +
    `<p>Ứng dụng này chỉ <strong>đọc</strong> dữ liệu, không sửa hay xóa.</p>` +
    `<p><a href="/report/oauth/authorize/highlevel?s=${encodeURIComponent(state)}" style="display:block;text-align:center;padding:0.75rem;background:#111;color:#fff;border-radius:0.5rem;text-decoration:none">Tiếp tục với tài khoản quản trị CRM</a></p>` +
    `<p style="color:#666;text-align:center;margin:1.25rem 0">hoặc, nếu quản trị viên đã cấp mã truy cập cho bạn</p>` +
    `<form method="post" action="/report/oauth/authorize/code"><input type="hidden" name="s" value="${s}">` +
    `<input type="email" name="email" required placeholder="email của bạn" style="width:100%;box-sizing:border-box;padding:0.6rem;border:1px solid #ccc;border-radius:0.5rem;margin-bottom:0.5rem">` +
    `<input type="text" name="code" required autocomplete="off" placeholder="mã truy cập" style="width:100%;box-sizing:border-box;padding:0.6rem;border:1px solid #ccc;border-radius:0.5rem;margin-bottom:0.75rem">` +
    `<button type="submit" style="width:100%;padding:0.75rem;border:1px solid #111;background:#fff;border-radius:0.5rem;cursor:pointer">Dùng mã truy cập</button></form>`);
}

export function highLevelAuthorizeUrl(env, state) {
  const app = reportAppEnv(env);
  const url = new URL(app.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", app.redirectUri);
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("scope", env.REPORT_GHL_SCOPES || allRequestedScopes().join(" "));
  if (app.versionId) url.searchParams.set("version_id", app.versionId);
  url.searchParams.set("state", state);
  return url.toString();
}

async function issueTokens(store, { familyId, clientId, userId, tenantId }) {
  const accessToken = secret(ACCESS_PREFIX);
  const refreshToken = secret("rrt_");
  await store.insertToken({ tokenHash: sha256(accessToken), kind: "access", familyId, clientId, userId, tenantId, expiresAt: new Date(Date.now() + ACCESS_TTL_SECONDS * 1000) });
  await store.insertToken({ tokenHash: sha256(refreshToken), kind: "refresh", familyId, clientId, userId, tenantId, expiresAt: new Date(Date.now() + REFRESH_TTL_MS) });
  return { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TTL_SECONDS, refresh_token: refreshToken, scope: MCP_SCOPE };
}

// Resolves an access token to a principal, re-checking membership and tenant
// status in the database on EVERY call, so a revoked person or suspended
// customer loses access immediately.
export async function authenticateReportToken({ token, store }) {
  if (!token || !token.startsWith(ACCESS_PREFIX)) return null;
  const row = await store.findAccessToken(sha256(token));
  if (!row) return null;
  return await store.resolvePrincipal(row.user_id, row.tenant_id);
}

export function newAccessCode() {
  return secret("rac_", 12);
}

export async function createAccessCode({ store, tenantId, email, role, createdBy }) {
  const code = newAccessCode();
  await store.createInvite({ tokenHash: sha256(code), tenantId, email: String(email).trim().toLowerCase(), role, createdBy, expiresAt: new Date(Date.now() + INVITE_TTL_MS) });
  return code;
}

export function createReportOAuthRouter({ env = process.env, getStore, fetchImpl = globalThis.fetch } = {}) {
  const router = express.Router();
  const registrations = [];

  const enabled = (req, res, next) => (reportOAuthEnabled(env) ? next() : res.status(404).end());
  router.use("/report/oauth", enabled);
  router.use(["/.well-known/oauth-authorization-server/report", "/report/.well-known/oauth-authorization-server"], enabled);
  router.use(["/.well-known/oauth-protected-resource/report/mcp", "/report/.well-known/oauth-protected-resource"], enabled);

  router.get(["/.well-known/oauth-authorization-server/report", "/report/.well-known/oauth-authorization-server"], (req, res) => {
    res.json(authorizationServerMetadata(env));
  });
  router.get(["/.well-known/oauth-protected-resource/report/mcp", "/report/.well-known/oauth-protected-resource"], (req, res) => {
    res.json(protectedResourceMetadata(env));
  });

  router.post("/report/oauth/register", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const cutoff = Date.now() - 3600_000;
    while (registrations.length && registrations[0] < cutoff) registrations.shift();
    if (registrations.length >= 60) return res.status(429).json({ error: "temporarily_unavailable", error_description: "Too many registrations." });
    const { redirect_uris: redirectUris, client_name: clientName } = req.body || {};
    if (!Array.isArray(redirectUris) || redirectUris.length < 1 || redirectUris.length > 5 ||
        !redirectUris.every((uri) => typeof uri === "string" && redirectUriAllowed(uri, env))) {
      return res.status(400).json({ error: "invalid_redirect_uri", error_description: "Every redirect_uri must be https on an allowed host." });
    }
    const name = typeof clientName === "string" ? clientName.slice(0, 100) : null;
    const clientId = secret("rmc_");
    try { await getStore(req).registerClient({ clientId, clientName: name, redirectUris }); }
    catch { return res.status(503).json({ error: "temporarily_unavailable", error_description: "Registration is unavailable." }); }
    registrations.push(Date.now());
    return res.status(201).json({
      client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none"
    });
  });

  router.get("/report/oauth/authorize", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const q = req.query;
    const store = getStore(req);
    const client = typeof q.client_id === "string" ? await store.findClient(q.client_id).catch(() => null) : null;
    if (!client || typeof q.redirect_uri !== "string" || !client.redirect_uris.includes(q.redirect_uri)) {
      return res.status(400).type("text/plain").send("Invalid client_id or redirect_uri.");
    }
    const fail = (error, description) => res.redirect(302, redirectWith(q.redirect_uri, { error, error_description: description, state: typeof q.state === "string" ? q.state : undefined }));
    if (q.response_type !== "code") return fail("unsupported_response_type", "response_type must be code.");
    if (q.code_challenge_method !== "S256" || !PKCE_VALUE.test(String(q.code_challenge || ""))) return fail("invalid_request", "PKCE S256 is required.");
    const base = reportBase(env);
    if (q.resource !== undefined && q.resource !== base && q.resource !== `${base}/mcp`) return fail("invalid_target", "Unknown resource.");
    const state = randomBytes(32).toString("base64url");
    await store.createLoginRequest({
      stateHash: sha256(state), clientId: client.client_id, redirectUri: q.redirect_uri, codeChallenge: q.code_challenge,
      clientState: typeof q.state === "string" ? q.state : null, expiresAt: new Date(Date.now() + LOGIN_TTL_MS)
    });
    return res.type("html").send(choosePage(state));
  });

  router.get("/report/oauth/authorize/highlevel", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (typeof req.query.s !== "string" || !req.query.s) return res.status(400).type("text/plain").send("Missing state.");
    return res.redirect(302, highLevelAuthorizeUrl(env, req.query.s));
  });

  // Staff path: email + one-time access code created by an admin.
  router.post("/report/oauth/authorize/code", express.urlencoded({ extended: false }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    const { s, email, code } = req.body || {};
    if (typeof s !== "string" || !s || typeof email !== "string" || typeof code !== "string") return res.status(400).type("text/plain").send("Missing fields.");
    const store = getStore(req);
    const cleanEmail = email.trim().toLowerCase();
    // The login request is single-use; on a wrong code a fresh one is issued (renew) so the person can retry.
    const request = await store.consumeLoginRequest(sha256(s));
    if (!request) return res.status(400).type("html").send(page("Liên kết đã hết hạn", "<p>Quay lại ChatGPT/Claude và thử kết nối lại.</p>"));
    const retryState = randomBytes(32).toString("base64url");
    const renew = async () => {
      await store.createLoginRequest({ stateHash: sha256(retryState), clientId: request.client_id, redirectUri: request.redirect_uri, codeChallenge: request.code_challenge, clientState: request.client_state, expiresAt: new Date(Date.now() + LOGIN_TTL_MS) });
    };
    if (!EMAIL.test(cleanEmail)) { await renew(); return res.status(400).type("html").send(choosePage(retryState, "Email không hợp lệ.")); }
    let accepted = null;
    try { accepted = await store.acceptInvite({ tokenHash: sha256(code.trim()), email: cleanEmail }); }
    catch (error) {
      if (!(error instanceof ReportAccessError)) throw error;
      await renew();
      return res.status(403).type("html").send(choosePage(retryState, error.message));
    }
    if (!accepted) {
      await store.recordAudit({ actorType: "system", action: "access_code.rejected", result: "failure", metadata: {} }).catch(() => {});
      await renew();
      return res.status(403).type("html").send(choosePage(retryState, "Mã truy cập không đúng, đã dùng hoặc hết hạn."));
    }
    const authCode = secret("rac2_");
    await store.createAuthCode({
      codeHash: sha256(authCode), clientId: request.client_id, redirectUri: request.redirect_uri, codeChallenge: request.code_challenge,
      userId: accepted.userId, tenantId: accepted.tenantId, expiresAt: new Date(Date.now() + CODE_TTL_MS)
    });
    await store.recordAudit({ tenantId: accepted.tenantId, actorType: "mcp", actor: cleanEmail, action: "login.access_code", result: "success", metadata: { role: accepted.role } }).catch(() => {});
    return res.redirect(302, redirectWith(request.redirect_uri, { code: authCode, state: request.client_state }));
  });

  // HighLevel sends the admin back here after consent.
  router.get("/report/oauth/callback", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const store = getStore(req);
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const request = state ? await store.consumeLoginRequest(sha256(state)) : null;
    if (!request) return res.status(400).type("html").send(page("Liên kết đã hết hạn", "<p>Quay lại ChatGPT/Claude và thử kết nối lại.</p>"));
    if (req.query.error) {
      return res.redirect(302, redirectWith(request.redirect_uri, { error: "access_denied", error_description: "Authorization was declined.", state: request.client_state }));
    }
    let attemptedLocation = null;
    try {
      if (typeof req.query.code !== "string" || !req.query.code) throw new ReportAccessError("Không nhận được mã ủy quyền.");
      const body = await exchangeCode({ env, code: req.query.code, fetchImpl });
      attemptedLocation = typeof body.locationId === "string" ? body.locationId : null;
      if (!body.locationId) {
        throw new ReportAccessError("Lần cài này cấp quyền cho cả agency. Hãy đăng nhập vào đúng sub-account của khách (không phải giao diện agency) rồi thử lại.");
      }
      const locationId = body.locationId;
      let users = [];
      try { users = await fetchHighLevelUsers({ accessToken: body.access_token, locationId, fetchImpl }); } catch { users = []; }
      const me = body.userId ? users.find((user) => user.id === body.userId) : null;
      const locationName = await fetchHighLevelLocationName({ accessToken: body.access_token, locationId, fetchImpl }).catch(() => null);
      const expiresAt = new Date(Date.now() + Number(body.expires_in || 86400) * 1000).toISOString();
      const provisioned = await store.provisionLogin({
        subject: body.userId ? `highlevel-report:${body.userId}` : `highlevel-report:location:${locationId}`,
        email: me?.email || null, displayName: me?.name || null, locationId, locationName,
        encryptedPayload: encryptCredential({
          auth_mode: "location", access_token: body.access_token, refresh_token: body.refresh_token,
          location_id: locationId, scope: body.scope || "", expires_at: expiresAt
        }, env),
        expiresAt, scopes: String(body.scope || "").split(/\s+/).filter(Boolean),
        // Default: only customers an admin (or the provisioning webhook) already created may connect.
        allowCreate: env.REPORT_ALLOW_UNKNOWN_INSTALLS === "true"
      });
      const authCode = secret("rac2_");
      await store.createAuthCode({
        codeHash: sha256(authCode), clientId: request.client_id, redirectUri: request.redirect_uri, codeChallenge: request.code_challenge,
        userId: provisioned.userId, tenantId: provisioned.tenantId, expiresAt: new Date(Date.now() + CODE_TTL_MS)
      });
      await store.recordAudit({
        tenantId: provisioned.tenantId, actorType: "mcp", actor: me?.email || body.userId || null,
        action: provisioned.created ? "tenant.installed" : "login.highlevel", result: "success",
        metadata: { role: provisioned.role, tenantStatus: provisioned.tenantStatus, grantedScopes: String(body.scope || "").split(/\s+/).filter(Boolean).length }
      }).catch(() => {});
      log("report_login", { result: "code_issued", created: provisioned.created, role: provisioned.role });
      return res.redirect(302, redirectWith(request.redirect_uri, { code: authCode, state: request.client_state }));
    } catch (error) {
      const expected = error instanceof ReportAccessError;
      if (error?.code === "NOT_PROVISIONED") await store.recordAudit({ actorType: "system", action: "install.rejected", result: "denied", metadata: { reason: "not_provisioned", locationId: attemptedLocation } }).catch(() => {});
      console.error("[report-login] failed:", expected ? error.message : (error?.code || error?.name || "Error"));
      return res.status(expected ? 403 : 500).type("html").send(page("Không kết nối được",
        `<p>${escapeHtml(expected ? error.message : "Kết nối thất bại. Thử lại, hoặc liên hệ Uplifting nếu vẫn lỗi.")}</p><p style="color:#666">Bạn có thể đóng cửa sổ này và thử lại từ ChatGPT/Claude.</p>`));
    }
  });

  router.post("/report/oauth/token", express.urlencoded({ extended: false }), async (req, res) => {
    res.set({ "Cache-Control": "no-store", Pragma: "no-cache" });
    const params = req.body || {};
    const basic = /^Basic\s+(.+)$/i.exec(req.get("authorization") || "");
    const clientId = params.client_id || (basic ? Buffer.from(basic[1], "base64").toString().split(":")[0] : "");
    const store = getStore(req);
    const bad = (status, error, description) => res.status(status).json({ error, error_description: description });
    try {
      let owner;
      if (params.grant_type === "authorization_code") {
        if (!params.code || !params.redirect_uri || !params.code_verifier || !clientId) return bad(400, "invalid_request", "code, redirect_uri, client_id and code_verifier are required.");
        const row = await store.consumeAuthCode(sha256(String(params.code)));
        if (!row || row.client_id !== clientId || row.redirect_uri !== params.redirect_uri || !pkceMatches(params.code_verifier, row.code_challenge)) {
          return bad(400, "invalid_grant", "Authorization code is invalid, expired, or already used.");
        }
        owner = { familyId: randomUUID(), clientId: row.client_id, userId: row.user_id, tenantId: row.tenant_id };
      } else if (params.grant_type === "refresh_token") {
        if (!params.refresh_token || !clientId) return bad(400, "invalid_request", "refresh_token and client_id are required.");
        const row = await store.consumeRefreshToken(sha256(String(params.refresh_token)));
        if (!row || row.client_id !== clientId) return bad(400, "invalid_grant", "Refresh token is invalid, expired, or already used.");
        // A revoked person or suspended customer must not be able to refresh.
        if (!(await store.resolvePrincipal(row.user_id, row.tenant_id))) return bad(400, "invalid_grant", "Access has been revoked.");
        owner = { familyId: row.family_id, clientId: row.client_id, userId: row.user_id, tenantId: row.tenant_id };
      } else {
        return bad(400, "unsupported_grant_type", "Supported grant types: authorization_code, refresh_token.");
      }
      const tokens = await issueTokens(store, owner);
      store.deleteExpired?.().catch(() => {});
      return res.json(tokens);
    } catch {
      return bad(500, "server_error", "Token service unavailable.");
    }
  });

  return router;
}
