import express from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  authorizeUserPrincipal,
  authorizeTenantContext,
  authorizeLegacyAdminContext,
  createTenantServices,
  LEGACY_123_GYM_LOCATION_ID,
  TenantAuthorizationError
} from "./src/tenant-services.js";
import {
  AuthenticationError,
  authConfiguration,
  bearerToken,
  createAuth0Verifier,
  oauthChallenge,
  protectedResourceMetadata,
  requireScopes
} from "./src/auth.js";
import { createHighLevelOnboarding } from "./src/highlevel-onboarding.js";
import { authenticateIssuedToken, completeHighLevelLogin, createOAuthRouter, inviteTeamMember } from "./src/oauth-server.js";
import { fetchHighLevelUsers } from "./src/highlevel-users.js";
import { createAdminPanelRouter } from "./src/admin-panel.js";

const app = express();
app.use((req, res, next) => {
  res.on("finish", () => {
    if (req.path === "/health") return;
    console.info(JSON.stringify({ timestamp: new Date().toISOString(), event: "http_request", method: req.method, path: req.path, status: res.statusCode }));
  });
  next();
});
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 10000;
const LC_BASE_URL = "https://services.leadconnectorhq.com";
const DEFAULT_LOCATION_ID = process.env.DEFAULT_LOCATION_ID || LEGACY_123_GYM_LOCATION_ID;
const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const VIDEO_MAX_BYTES = 500 * 1024 * 1024;

const SERVICE_VERSION = "3.15.0";
app.get("/", (req, res) => res.json({ status: "ok", service: "Uplifting Social AI", version: SERVICE_VERSION, mcp: "/mcp" }));
app.get("/health", (req, res) => {
  const configuration = authConfiguration(process.env);
  const configured = configuration.oauthReady || configuration.legacyAdminReady;
  res.status(configured ? 200 : 503).json({ status: configured ? "healthy" : "misconfigured", version: SERVICE_VERSION });
});

app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (req, res) => {
  try { return res.json(protectedResourceMetadata(process.env)); }
  catch { return res.status(503).json({ error: "oauth_not_configured" }); }
});

app.get("/docs", (req, res) => res.json({
  service: "Uplifting Social AI",
  authentication: "OAuth 2.1",
  mcp: "/mcp",
  version: SERVICE_VERSION
}));

app.use(createOAuthRouter({ env: process.env, getRepository: (req) => requestServices(req).repository }));
app.use(createAdminPanelRouter({ env: process.env, getRepository: (req) => requestServices(req).repository }));

// 'YYYY-MM' in UTC -- the period key tenant_usage_counters rows are keyed by.
function currentUsagePeriod() {
  return new Date().toISOString().slice(0, 7);
}

// Usage counting (Phase 1 pricing foundation) must never block the tool
// call that triggered it -- a counter write failing is not the caller's
// problem, so this only logs and swallows the error.
function recordUsage(req, { tenantId, metric, by }) {
  if (!by) return;
  const repository = req.tenantServices?.repository;
  if (typeof repository?.incrementUsage !== "function") return;
  repository.incrementUsage({ tenantId, metric, period: currentUsagePeriod(), by })
    .catch((error) => console.error("[usage] failed to record", { metric, tenantId, errorMessage: error?.message || "Error" }));
}

// Remember which posts the agent created so their results can be compared
// with hand-made posts (migration 012). Best-effort: never blocks the call.
function recordAgentPosts(req, tenantId, results) {
  const repository = req.tenantServices?.repository;
  if (typeof repository?.recordAgentPosts !== "function") return;
  const posts = (results || []).filter((entry) => entry.action === "created" && entry.postId).map((entry) => ({ postId: entry.postId, platform: entry.platform }));
  if (!posts.length) return;
  repository.recordAgentPosts(tenantId, posts)
    .catch((error) => console.error("[agent_posts] failed to record", { tenantId, errorMessage: error?.message || "Error" }));
}

// Plan limits (admin panel, migration 010) are enforced only for real OAuth
// tenants -- legacy_admin has no plan concept and is exempt, same as the
// role checks in authorizeTool. Limits are read fresh every call (not
// cached) so an admin's edit in the panel takes effect immediately.
class PlanLimitError extends Error {
  constructor(message) { super(message); this.code = "PLAN_LIMIT_EXCEEDED"; }
}

async function enforceUserLimit(req) {
  if (req.principal.authType !== "oauth") return;
  const repository = req.tenantServices?.repository;
  if (typeof repository?.getPlanLimits !== "function") return;
  const limits = await repository.getPlanLimits();
  const maxUsers = limits[req.principal.plan]?.maxUsers;
  if (maxUsers == null) return;
  const count = await repository.countActiveMemberships(req.principal.tenantId);
  if (count >= maxUsers) throw new PlanLimitError(`This plan allows up to ${maxUsers} team members. Remove someone or upgrade the plan to invite another.`);
}

async function enforcePostLimit(req) {
  if (req.principal.authType !== "oauth") return;
  const repository = req.tenantServices?.repository;
  if (typeof repository?.getPlanLimits !== "function") return;
  const limits = await repository.getPlanLimits();
  const maxPosts = limits[req.principal.plan]?.maxPostsPerMonth;
  if (maxPosts == null) return;
  const used = await repository.getUsage({ tenantId: req.principal.tenantId, metric: "posts_created", period: currentUsagePeriod() });
  if (used >= maxPosts) throw new PlanLimitError(`This plan allows up to ${maxPosts} AI-created posts per month, and ${used} have already been made this month. Upgrade the plan to create more.`);
}

// Fixed-window per-tenant abuse guard on tools/call, independent of the
// plan/pricing usage counters above -- a runaway automation loop or a
// leaked token should not be able to hammer one Render instance into the
// ground for every other tenant. In-memory only (fine for the current
// single-instance deployment; a multi-instance deployment would need this
// moved to a shared store).
const rateLimitWindows = new Map();
function checkRateLimit(key) {
  const limit = Number(process.env.TENANT_RATE_LIMIT_PER_MINUTE || 60);
  const now = Date.now();
  const windowStart = Math.floor(now / 60_000);
  const entry = rateLimitWindows.get(key);
  if (!entry || entry.windowStart !== windowStart) {
    rateLimitWindows.set(key, { windowStart, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= limit;
}
function resetRateLimitStateForTests() {
  rateLimitWindows.clear();
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function requestServices(req) {
  if (req.app.locals.tenantServices) return req.app.locals.tenantServices;
  if (process.env.DATABASE_URL) {
    if (!req.app.locals.cachedTenantServices) req.app.locals.cachedTenantServices = createTenantServices(process.env);
    return req.app.locals.cachedTenantServices;
  }
  return createTenantServices(process.env);
}

function requestVerifier(req) {
  if (req.app.locals.auth0Verifier) return req.app.locals.auth0Verifier;
  if (!req.app.locals.cachedAuth0Verifier) req.app.locals.cachedAuth0Verifier = createAuth0Verifier(process.env);
  return req.app.locals.cachedAuth0Verifier;
}

const MCP_DIAGNOSTICS_ENABLED =
  process.env.MCP_DIAGNOSTIC_LOG === "true" &&
  process.env.MCP_RESOURCE_URL?.replace(/\/+$/, "") ===
    "https://uplifting-social-ai-staging.onrender.com";

function diagnosticValue(value) {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function diagnosticError(error) {
  // Only controlled messages appear in logs. Never log a raw library/SQL error.
  if (error instanceof AuthenticationError) {
    return { errorClass: "AuthenticationError", errorMessage: error.code };
  }
  if (error instanceof TenantAuthorizationError) {
    return { errorClass: "TenantAuthorizationError", errorMessage: error.code };
  }
  const sqlState = typeof error?.code === "string" &&
    /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null;
  return {
    errorClass: sqlState ? "DatabaseError" : "Error",
    errorMessage: sqlState ? `SQLSTATE ${sqlState}` : "Unexpected error",
    ...(sqlState || typeof error?.message !== "string" ? {} : { errorDetail: redactSecrets(error.message).slice(0, 200) })
  };
}

function mcpDiagnostic(req, event, fields = {}) {
  if (!MCP_DIAGNOSTICS_ENABLED) return;
  console.info(JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    httpMethod: req.method,
    path: req.path,
    rpcMethod: diagnosticValue(req.body?.method),
    rpcId: diagnosticValue(req.body?.id),
    protocolVersion: diagnosticValue(req.body?.params?.protocolVersion),
    ...fields
  }));
}

app.use("/mcp", (req, res, next) => {
  res.on("finish", () => console.info(JSON.stringify({
    timestamp: new Date().toISOString(),
    event: "mcp_request",
    httpMethod: req.method,
    rpcMethod: typeof req.body?.method === "string" ? req.body.method : null,
    bearer: Boolean(bearerToken(req)),
    httpStatus: res.statusCode
  })));
  next();
});

app.use("/mcp", (req, res, next) => {
  if (!MCP_DIAGNOSTICS_ENABLED) return next();
  req.mcpDiagnosticStage = "authentication";
  mcpDiagnostic(req, "request_received");
  res.on("finish", () => mcpDiagnostic(req, "response_finished", {
    stage: req.mcpDiagnosticStage,
    authentication: req.mcpAuthentication || "failure",
    sub: req.mcpAuth0Sub || null,
    tenantId: req.principal?.tenantId || null,
    role: req.principal?.role || null,
    httpStatus: res.statusCode
  }));
  next();
});

async function resolveOAuthPrincipal(req, token) {
  const services = requestServices(req);
  req.tenantServices = services;
  const configuration = authConfiguration(process.env);
  if (configuration.builtInReady) {
    const issued = await authenticateIssuedToken({ token, repository: services.repository });
    if (issued) {
      req.principal = issued;
      return { subject: issued.subject };
    }
  }
  if (!configuration.auth0Ready && !req.app.locals.auth0Verifier) {
    throw new AuthenticationError("Bearer access token is invalid or expired.");
  }
  const identity = await requestVerifier(req)(token);
  req.principal = await authorizeUserPrincipal({
    identity,
    repository: services.repository,
    allowSelfServeProvisioning: process.env.ENABLE_SELF_SERVE_SIGNUP === "true"
  });
  return identity;
}

const PUBLIC_MCP_METHODS = new Set(["initialize", "notifications/initialized", "tools/list"]);

async function authenticateMcpRequest(req, res, next) {
  const id = req.body?.id ?? null;
  const configuration = authConfiguration(process.env);
  try {
    const token = bearerToken(req);
    if (token && configuration.oauthReady) {
      const identity = await resolveOAuthPrincipal(req, token);
      req.mcpAuth0Sub = identity.subject;
      req.mcpDiagnosticStage = "user_authorization";
      mcpDiagnostic(req, "jwt_verified", { sub: identity.subject });
      req.mcpAuthentication = "success";
      req.mcpDiagnosticStage = "mcp_handler";
      mcpDiagnostic(req, "user_authorized", {
        authentication: "success",
        sub: identity.subject,
        tenantId: req.principal.tenantId,
        role: req.principal.role
      });
      return next();
    }
    const suppliedAdminKey = req.get("x-api-key") || "";
    if (configuration.legacyAdminReady && suppliedAdminKey && constantTimeEqual(suppliedAdminKey, process.env.MCP_ADMIN_API_KEY)) {
      req.tenantServices = requestServices(req);
      req.principal = Object.freeze({ authType: "legacy_admin", role: "uplifting_admin", scopes: new Set(["uplifting:admin"]) });
      req.mcpAuthentication = "success";
      req.mcpDiagnosticStage = "mcp_handler";
      mcpDiagnostic(req, "legacy_admin_authorized", {
        authentication: "success", role: "uplifting_admin"
      });
      return next();
    }
    // Tool discovery carries no data, so ChatGPT can list the tools before the
    // user signs in; every tools/call still needs a valid token.
    if (!token && !suppliedAdminKey && configuration.oauthReady && PUBLIC_MCP_METHODS.has(req.body?.method)) {
      req.principal = null;
      req.mcpAuthentication = "anonymous_discovery";
      req.mcpDiagnosticStage = "mcp_handler";
      return next();
    }
    mcpDiagnostic(req, "authentication_failed", {
      stage: "authentication",
      authentication: "failure",
      errorClass: "AuthenticationError",
      errorMessage: "OAuth authentication required"
    });
    const challenge = configuration.oauthReady ? oauthChallenge(process.env, { error: "invalid_token", description: "OAuth login is required." }) : null;
    if (challenge) res.set("WWW-Authenticate", challenge);
    return res.status(401).json({ jsonrpc: "2.0", id, error: { code: -32002, message: "OAuth authentication required." } });
  } catch (error) {
    mcpDiagnostic(req, "authentication_failed", {
      stage: req.mcpDiagnosticStage || "authentication",
      authentication: "failure",
      sub: req.mcpAuth0Sub || null,
      ...diagnosticError(error)
    });
    const expected = error instanceof AuthenticationError || error instanceof TenantAuthorizationError;
    const status = error instanceof AuthenticationError ? error.status : (error instanceof TenantAuthorizationError ? 403 : 503);
    const message = expected ? error.message : "Authentication service unavailable.";
    const challenge = configuration.oauthReady ? oauthChallenge(process.env, { error: error.code || "invalid_token", description: message }) : null;
    if (challenge) res.set("WWW-Authenticate", challenge);
    return res.status(status).json({ jsonrpc: "2.0", id, error: { code: -32002, message } });
  }
}

function tenantRegistry(env = process.env) {
  const registry = {
    [LEGACY_123_GYM_LOCATION_ID]: { name: "123 GYM", tokenEnv: "LC_PRIVATE_TOKEN" }
  };
  if (!env.LC_TENANTS_JSON) return registry;
  let configured;
  try { configured = JSON.parse(env.LC_TENANTS_JSON); } catch { throw new Error("LC_TENANTS_JSON is not valid JSON."); }
  if (!configured || typeof configured !== "object" || Array.isArray(configured)) throw new Error("LC_TENANTS_JSON must be a tenant object.");
  for (const [locationId, tenant] of Object.entries(configured)) {
    if (!locationId || !tenant || typeof tenant !== "object" || typeof tenant.tokenEnv !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(tenant.tokenEnv)) {
      throw new Error("LC_TENANTS_JSON contains an invalid tenant definition.");
    }
    registry[locationId] = { name: String(tenant.name || locationId), tokenEnv: tenant.tokenEnv };
  }
  return registry;
}

function resolveTenant(requestedLocationId, env = process.env) {
  const locationId = requestedLocationId || env.DEFAULT_LOCATION_ID || LEGACY_123_GYM_LOCATION_ID;
  const tenant = tenantRegistry(env)[locationId];
  if (!tenant) throw new Error("Unknown or unauthorized locationId.");
  const token = env[tenant.tokenEnv];
  if (!token) throw new Error(`Credential is not configured for tenant ${tenant.name}.`);
  return { locationId, name: tenant.name, tokenEnv: tenant.tokenEnv, token };
}

function tenantAccess(requestedLocationId, authorizedContext) {
  if (!authorizedContext) return resolveTenant(requestedLocationId);
  if (requestedLocationId && requestedLocationId !== authorizedContext.locationId) {
    throw new Error("Cross-tenant location access blocked.");
  }
  return {
    locationId: authorizedContext.locationId,
    name: authorizedContext.tenantName,
    token: authorizedContext.accessToken,
    tenantId: authorizedContext.tenantId,
    connectionId: authorizedContext.connectionId,
    defaultUserId: authorizedContext.defaultUserId || null
  };
}

async function parseResponse(response) {
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) {
    const detail = Array.isArray(data?.message) ? data.message.join("; ") : (typeof data?.message === "string" ? data.message : data?.error);
    throw new Error(`Upstream request failed (${response.status})${detail ? `: ${redactSecrets(detail).slice(0, 500)}` : ""}`);
  }
  return data;
}

function lcHeaders(token) {
  return { Authorization: `Bearer ${token}`, Version: "2021-07-28", Accept: "application/json" };
}

function redactSecrets(value, env = process.env) {
  let safe = String(value || "").replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]");
  let registry;
  try { registry = tenantRegistry(env); } catch { registry = {}; }
  for (const tenant of Object.values(registry)) {
    const token = env[tenant.tokenEnv];
    if (token) safe = safe.split(token).join("[REDACTED]");
  }
  for (const name of [
    "MCP_ADMIN_API_KEY", "DATABASE_URL", "AUTH0_CLIENT_SECRET", "HIGHLEVEL_CLIENT_SECRET",
    "TENANT_CREDENTIAL_ENCRYPTION_KEY", "LC_PRIVATE_TOKEN", "LC_PRIVATE_TOKEN_TESTING_AGENCY"
  ]) {
    if (env[name]) safe = safe.split(env[name]).join("[REDACTED]");
  }
  return safe;
}

function sanitizeDebugResponse(value, accessToken) {
  if (Array.isArray(value)) return value.map((item) => sanitizeDebugResponse(item, accessToken));
  if (value && typeof value === "object") {
    const safe = {};
    for (const [key, item] of Object.entries(value)) {
      if (/authorization|cookie|token|secret|password|credential/i.test(key)) continue;
      safe[key] = sanitizeDebugResponse(item, accessToken);
    }
    return safe;
  }
  if (typeof value === "string") {
    let safe = redactSecrets(value);
    if (accessToken) safe = safe.split(accessToken).join("[REDACTED]");
    return safe;
  }
  return value;
}

function validateLocationBinding(path, locationId) {
  const url = new URL(path, LC_BASE_URL);
  const socialMatch = url.pathname.match(/^\/social-media-posting\/([^/]+)\//);
  if (socialMatch && decodeURIComponent(socialMatch[1]) !== locationId) throw new Error("Cross-tenant request blocked.");
  const queryLocation = url.searchParams.get("locationId") || url.searchParams.get("altId");
  if (queryLocation && queryLocation !== locationId) throw new Error("Cross-tenant request blocked.");
}

async function tenantRequest(locationId, path, { method = "GET", body, headers = {}, version = "2021-07-28", authorizedContext } = {}) {
  const tenant = tenantAccess(locationId, authorizedContext);
  validateLocationBinding(path, tenant.locationId);
  const response = await fetch(`${LC_BASE_URL}${path}`, {
    method,
    headers: { ...lcHeaders(tenant.token), Version: version, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return await parseResponse(response);
}

async function socialRequest(locationId, suffix, { method = "GET", body, authorizedContext } = {}) {
  const tenant = tenantAccess(locationId, authorizedContext);
  const path = `/social-media-posting/${encodeURIComponent(tenant.locationId)}${suffix}`;
  return await tenantRequest(tenant.locationId, path, { method, body, headers: { "Content-Type": "application/json" }, version: "v3", authorizedContext });
}

function safeFileName(name, mimeType = "") {
  const fallbackExt = mimeType.startsWith("image/") ? mimeType.split("/")[1].replace("jpeg", "jpg") : "bin";
  const fallback = `chatgpt-media-${Date.now()}.${fallbackExt}`;
  const cleaned = String(name || fallback).split(/[\\/]/).pop().replace(/[\r\n\0]/g, "").trim();
  return cleaned || fallback;
}

function maxBytesFor(mimeType) {
  return mimeType?.startsWith("video/") ? VIDEO_MAX_BYTES : IMAGE_MAX_BYTES;
}

async function downloadChatGPTFile(file) {
  if (!file?.download_url || !file?.file_id) {
    throw new Error("file must include download_url and file_id supplied by ChatGPT.");
  }
  const response = await fetch(file.download_url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Unable to download the ChatGPT file (${response.status}).`);
  const mimeType = (file.mime_type || response.headers.get("content-type") || "application/octet-stream").split(";")[0];
  if (!mimeType.startsWith("image/") && !mimeType.startsWith("video/")) {
    throw new Error(`Unsupported media type: ${mimeType}. Only images and videos are accepted.`);
  }
  const contentLength = Number(response.headers.get("content-length") || 0);
  const maxBytes = maxBytesFor(mimeType);
  if (contentLength > maxBytes) throw new Error(`File is too large. Maximum is ${maxBytes / 1024 / 1024} MB for ${mimeType.startsWith("video/") ? "videos" : "images"}.`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > maxBytes) throw new Error(`File is too large. Maximum is ${maxBytes / 1024 / 1024} MB.`);
  return { bytes, mimeType, fileName: safeFileName(file.file_name, mimeType), fileId: file.file_id };
}

async function uploadMedia(args, authorizedContext) {
  const { locationId = DEFAULT_LOCATION_ID, file, fileUrl, fileName, parentId } = args;
  const tenant = tenantAccess(locationId, authorizedContext);
  if (!file && !fileUrl) throw new Error("Provide either file (from ChatGPT or Media Library) or fileUrl.");
  if (file && fileUrl) throw new Error("Provide only one source: file or fileUrl.");

  const body = new FormData();
  let source;
  if (file) {
    const downloaded = await downloadChatGPTFile(file);
    body.append("hosted", "false");
    body.append("file", new Blob([downloaded.bytes], { type: downloaded.mimeType }), safeFileName(fileName || downloaded.fileName, downloaded.mimeType));
    source = { type: "chatgpt_file", fileId: downloaded.fileId };
  } else {
    let parsed;
    try { parsed = new URL(fileUrl); } catch { throw new Error("fileUrl must be a valid HTTPS URL."); }
    if (parsed.protocol !== "https:") throw new Error("fileUrl must use HTTPS.");
    body.append("hosted", "true");
    body.append("fileUrl", fileUrl);
    if (fileName) body.append("name", safeFileName(fileName));
    source = { type: "public_url" };
  }
  if (parentId) body.append("parentId", parentId);

  const response = await fetch(`${LC_BASE_URL}/medias/upload-file`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tenant.token}`, Version: "2021-07-28" },
    body
  });
  return { ...(await parseResponse(response)), source, locationId: tenant.locationId, tenant: tenant.name };
}

async function listMedia(args = {}, authorizedContext) {
  const { locationId = DEFAULT_LOCATION_ID, search = "", mediaType = "all", type = "file", folderId, limit = 50, offset = 0 } = args;
  const tenant = tenantAccess(locationId, authorizedContext);
  const params = new URLSearchParams({ altId: locationId, altType: "location", sortBy: "createdAt", sortOrder: "desc", type, limit: String(Math.min(Number(limit) || 50, 100)), offset: String(Number(offset) || 0) });
  if (search) params.set("query", search);
  if (folderId) params.set("parentId", folderId);
  const path = `/medias/files?${params}`;
  validateLocationBinding(path, tenant.locationId);
  const data = await parseResponse(await fetch(`${LC_BASE_URL}${path}`, { method: "GET", headers: lcHeaders(tenant.token) }));
  let files = data.files || data.data?.files || [];
  if (search) {
    const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
    files = files.filter((file) => terms.some((term) => [file.name, file.searchKey, file.contentType, file.category, file.subCategory].filter(Boolean).join(" ").toLowerCase().includes(term)));
  }
  if (mediaType === "image") files = files.filter((file) => file.contentType?.startsWith("image/"));
  if (mediaType === "video") files = files.filter((file) => file.contentType?.startsWith("video/"));
  return { count: files.length, files: files.map((file) => ({ id: file._id, name: file.name, contentType: file.contentType, url: file.url, width: file.width, height: file.height, size: file.size, createdAt: file.createdAt, thumbnailUrl: file.thumbnail?.url || null, previewUrl: file.preview?.url || null, category: file.category || null, subCategory: file.subCategory || null, folderId: file.parentId || null })) };
}

async function inspectMedia(args, authorizedContext) {
  const { locationId = DEFAULT_LOCATION_ID, url, thumbnailUrl, name = "media" } = args;
  tenantAccess(locationId, authorizedContext);
  const mediaUrl = thumbnailUrl || url;
  if (!mediaUrl) throw new Error("url or thumbnailUrl is required.");
  const response = await fetch(mediaUrl);
  if (!response.ok) throw new Error(`Unable to fetch media (${response.status}).`);
  const contentType = response.headers.get("content-type") || "image/jpeg";
  if (!contentType.startsWith("image/")) throw new Error("inspect_media requires an image or video thumbnail URL.");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > 8 * 1024 * 1024) throw new Error("Image is larger than 8 MB. Use a thumbnail or smaller preview image.");
  return { name, mimeType: contentType.split(";")[0], base64: buffer.toString("base64"), sourceUrl: mediaUrl };
}

async function listLocationUsers(args = {}, authorizedContext) {
  const { locationId = DEFAULT_LOCATION_ID } = args;
  const tenant = tenantAccess(locationId, authorizedContext);
  validateLocationBinding(`/users/?locationId=${encodeURIComponent(tenant.locationId)}`, tenant.locationId);
  const users = await fetchHighLevelUsers({ accessToken: tenant.token, locationId: tenant.locationId });
  return { count: users.length, users };
}

// --------------------------------------------------
// SOCIAL PLANNER
// --------------------------------------------------

async function listSocialAccounts({ locationId = DEFAULT_LOCATION_ID } = {}, authorizedContext) {
  return await socialRequest(locationId, "/accounts", { authorizedContext });
}

// Resolve category/tag names to the real IDs HighLevel requires -- create_social_post
// silently drops an unrecognized categoryId/tag, so the caller must look these up
// first rather than guess. HighLevel had not shipped create/update/delete for these
// at the time this was written, only listing.
async function listSocialCategories({ locationId = DEFAULT_LOCATION_ID, search, limit, skip } = {}, authorizedContext) {
  const params = new URLSearchParams();
  if (search) params.set("searchText", search);
  if (limit !== undefined) params.set("limit", String(Math.min(Math.max(1, Number(limit) || 20), 100)));
  if (skip !== undefined) params.set("skip", String(Math.max(0, Number(skip) || 0)));
  const query = params.toString();
  const data = await socialRequest(locationId, `/categories${query ? `?${query}` : ""}`, { authorizedContext });
  const categories = data?.results?.categories || data?.categories || [];
  return { count: categories.length, categories: categories.map((category) => ({ id: category._id, name: category.name })) };
}

async function listSocialTags({ locationId = DEFAULT_LOCATION_ID, search, limit, skip } = {}, authorizedContext) {
  const params = new URLSearchParams();
  if (search) params.set("searchText", search);
  if (limit !== undefined) params.set("limit", String(Math.min(Math.max(1, Number(limit) || 20), 100)));
  if (skip !== undefined) params.set("skip", String(Math.max(0, Number(skip) || 0)));
  const query = params.toString();
  const data = await socialRequest(locationId, `/tags${query ? `?${query}` : ""}`, { authorizedContext });
  let tags = data?.results?.tags ?? data?.tags ?? [];
  if (!Array.isArray(tags)) {
    // TEMP diagnostic (v3.8.1): field names only, never values, to find the
    // real shape of this undocumented-beyond-changelog response without
    // logging tenant data. Remove once the real shape is confirmed live.
    console.info(JSON.stringify({
      timestamp: new Date().toISOString(), event: "list_social_tags_shape_probe",
      topLevelKeys: Object.keys(data || {}),
      resultsKeys: Object.keys(data?.results || {}),
      tagsType: typeof tags,
      tagsKeys: tags && typeof tags === "object" ? Object.keys(tags) : null
    }));
    tags = Array.isArray(tags?.tags) ? tags.tags : Array.isArray(tags?.items) ? tags.items : [];
  }
  return { count: tags.length, tags: tags.map((tag) => ({ id: tag._id || tag.id, name: tag.name })) };
}

function accountList(data) {
  return data?.results?.accounts || data?.accounts || [];
}

// Only "is this connection still usable" -- no per-tenant or per-platform
// blocking. Which accounts a post goes to is the caller's explicit choice.
function isEligibleSocialAccount(account) {
  return Boolean(account?.id && account.active !== false && !account.isExpired && !account.deleted);
}

async function resolveSocialAccounts(locationId, requestedIds = [], authorizedContext) {
  const accountsData = await listSocialAccounts({ locationId }, authorizedContext);
  const all = accountList(accountsData);
  const eligible = all.filter(isEligibleSocialAccount);
  const requested = Array.isArray(requestedIds) ? requestedIds.filter(Boolean) : [];
  if (!requested.length) return eligible;
  const byId = new Map(all.map((account) => [account.id, account]));
  const unknown = requested.filter((id) => !byId.has(id));
  if (unknown.length) throw new Error(`Unknown social accountIds: ${unknown.join(", ")}`);
  const blocked = requested.map((id) => byId.get(id)).filter((account) => !isEligibleSocialAccount(account));
  if (blocked.length) throw new Error(`Inactive or expired social accounts: ${blocked.map((account) => `${account.name} (${account.id})`).join(", ")}`);
  return requested.map((id) => byId.get(id));
}

function postArray(data) {
  return data?.results?.posts || data?.posts || [];
}

// HighLevel does not hand a post back byte-for-byte as it was created: media
// objects gain extra fields, summaries get whitespace/newline normalized,
// dates are re-serialized. Strict equality therefore never matched a retried
// post that had media, so retries created duplicates. Compare what matters.
// Some platforms (LinkedIn seen live) accept a post but neither return its id
// nor show it in the list right away, so the list-based duplicate check is
// blind to them and every agent retry created another post. Remember what was
// just created, per tenant, and treat the same content within a few minutes as
// already done.
const RECENT_CREATE_TTL_MS = 10 * 60_000;
const recentCreates = new Map();
function resetRecentCreatesForTests() { recentCreates.clear(); }
function recentCreateFor(key) {
  const hit = recentCreates.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > RECENT_CREATE_TTL_MS) { recentCreates.delete(key); return null; }
  return hit;
}
const createdPostId = (data) => data?.results?.post?._id || data?.results?.post?.id || data?.post?._id || data?.results?._id || data?._id || null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeSummary = (text) => String(text || "").replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim();
const mediaKey = (media) => (Array.isArray(media) ? media : [])
  .map((item) => String(item?.url || "").split("?")[0].split("/").pop())
  .filter(Boolean).sort().join("|");
const sameInstant = (a, b) => (!a && !b) || (a && b && Math.abs(new Date(a).getTime() - new Date(b).getTime()) < 60_000);

function isSamePost(post, body, groupIds) {
  return normalizeSummary(post.summary) === normalizeSummary(body.summary)
    && (!body.scheduleDate || sameInstant(post.scheduleDate, body.scheduleDate))
    && groupIds.every((id) => post.accountIds?.includes(id))
    && mediaKey(post.media) === mediaKey(body.media);
}

async function requestSocialPostList({ locationId, status, accountIds, skip, limit, fromDate, toDate, includeUsers, postType }, authorizedContext) {
  const body = {
    type: status,
    accounts: accountIds.join(","),
    skip: String(Math.max(0, Number(skip) || 0)),
    limit: String(Math.min(Math.max(1, Number(limit) || 10), 100)),
    includeUsers: String(Boolean(includeUsers))
  };
  if (fromDate) body.fromDate = fromDate;
  if (toDate) body.toDate = toDate;
  if (postType) body.postType = postType;
  return await socialRequest(locationId, "/posts/list", { method: "POST", body, authorizedContext });
}

async function listSocialPosts(args = {}, authorizedContext) {
  const {
    locationId = DEFAULT_LOCATION_ID,
    status = "all",
    accountIds = [],
    skip = 0,
    limit = 10,
    fromDate,
    toDate,
    includeUsers = true,
    postType
  } = args;
  const accounts = await resolveSocialAccounts(locationId, accountIds, authorizedContext);
  if (!accounts.length) throw new Error("No eligible Facebook or Google accounts are connected.");
  const data = await requestSocialPostList({ locationId, status, accountIds: accounts.map((account) => account.id), skip, limit, fromDate, toDate, includeUsers, postType }, authorizedContext);
  return { ...data, resolvedAccounts: accounts.map(({ id, name, platform, type }) => ({ id, name, platform, type })) };
}

async function getSocialPost({ locationId = DEFAULT_LOCATION_ID, postId, includeRelated = true }, authorizedContext) {
  if (!postId) throw new Error("postId is required.");
  if (!/^[a-f0-9]{24}$/i.test(postId)) throw new Error("postId must be the 24-character _id from list_social_posts; parentPostId UUID values are grouping keys and cannot be fetched by the Get Post endpoint.");
  const data = await socialRequest(locationId, `/posts/${encodeURIComponent(postId)}`, { authorizedContext });
  if (!includeRelated) return data;
  const post = data?.results?.post;
  if (!post) return data;
  const center = new Date(post.scheduleDate || post.displayDate || post.createdAt);
  const fromDate = new Date(center.getTime() - 36 * 60 * 60 * 1000).toISOString();
  const toDate = new Date(center.getTime() + 36 * 60 * 60 * 1000).toISOString();
  const listed = await requestSocialPostList({ locationId, status: "all", accountIds: post.accountIds || [], skip: 0, limit: 100, fromDate, toDate, includeUsers: true }, authorizedContext);
  const related = postArray(listed).filter((item) => item._id === post._id || (post.parentPostId && item.parentPostId === post.parentPostId));
  return { ...data, relation: { parentPostId: post.parentPostId || null, note: "parentPostId is an internal grouping UUID; platform children may only materialize during publishing and are not addressable through Get Post.", listedRecords: related } };
}

const SOCIAL_POST_FIELDS = [
  "accountIds", "summary", "media", "status", "scheduleDate", "selectedBestTime",
  "createdBy", "followUpComment", "ogTagsDetails", "type", "postApprovalDetails",
  "scheduleTimeUpdated", "tags", "categoryId", "applyWatermark", "tiktokPostDetails",
  "gmbPostDetails", "userId", "linkedinPostDetails", "pinterestPostDetails",
  "facebookPostDetails", "instagramPostDetails", "youtubePostDetails", "communityPostDetails"
];

function buildSocialPostBody(args, { partial = false } = {}) {
  const body = {};
  for (const field of SOCIAL_POST_FIELDS) {
    if (args[field] !== undefined) body[field] = args[field];
  }
  if (!partial) {
    body.status ??= "draft";
    body.type ??= "post";
  }
  const status = body.status;
  if (["scheduled", "in_review"].includes(status) && !body.scheduleDate) {
    throw new Error(`scheduleDate is required when status is ${status}.`);
  }
  if (!partial && (!Array.isArray(body.accountIds) || body.accountIds.length === 0)) {
    throw new Error("accountIds must be a non-empty array. Call list_social_accounts first.");
  }
  if (!partial && (typeof body.userId !== "string" || !body.userId.trim())) {
    throw new Error("userId is required to create a social post (drafts are rejected without it too). Pass userId explicitly or configure a tenant default_user_id.");
  }
  if (status === "in_review" && !body.postApprovalDetails?.approver) {
    throw new Error("postApprovalDetails.approver is required for in_review posts.");
  }
  if (body.media && !Array.isArray(body.media)) throw new Error("media must be an array.");
  return body;
}

async function createSocialPost(args = {}, authorizedContext) {
  const { locationId = DEFAULT_LOCATION_ID, verify = true, splitByPlatform = true } = args;
  const tenant = tenantAccess(locationId, authorizedContext);
  const accounts = await resolveSocialAccounts(locationId, args.accountIds || [], authorizedContext);
  if (!(Array.isArray(args.accountIds) && args.accountIds.some(Boolean))) {
    const choices = accounts.map((account) => `${account.name} (${account.platform}, id ${account.id})`).join("; ") || "none connected";
    throw new Error(`The user has not said which social accounts this post should go to. Do not guess or pick for them -- ask which account(s) they want, then call again with accountIds. Available: ${choices}`);
  }
  const userId = args.userId ?? tenant.defaultUserId ?? undefined;
  const body = buildSocialPostBody({ ...args, userId, accountIds: accounts.map((account) => account.id) });
  const grouped = new Map();
  for (const account of accounts) grouped.set(account.platform, [...(grouped.get(account.platform) || []), account]);
  const groups = splitByPlatform ? [...grouped.values()] : [accounts];
  const report = [];
  for (const group of groups) {
    const groupIds = group.map((account) => account.id);
    const platform = group[0]?.platform || "mixed";
    const fingerprint = createHash("sha256").update(JSON.stringify({ locationId, accountIds: [...groupIds].sort(), summary: body.summary || "", media: body.media || [], status: body.status, scheduleDate: body.scheduleDate || null, type: body.type })).digest("hex").slice(0, 20);
    const recentKey = `${authorizedContext?.tenantId || locationId}:${fingerprint}`;
    const recent = recentCreateFor(recentKey);
    if (recent) {
      report.push({ action: "skipped_duplicate", reason: "The same post was created moments ago; HighLevel may not list it yet.", fingerprint, platform, accountIds: groupIds, postId: recent.postId, parentPostId: null, status: body.status, scheduleDate: body.scheduleDate || null, media: [], verified: false });
      continue;
    }
    const target = new Date(body.scheduleDate || Date.now());
    const fromDate = new Date(target.getTime() - 12 * 60 * 60 * 1000).toISOString();
    const toDate = new Date(target.getTime() + 12 * 60 * 60 * 1000).toISOString();
    const existingData = await requestSocialPostList({ locationId, status: body.status || "all", accountIds: groupIds, skip: 0, limit: 100, fromDate, toDate, includeUsers: true, postType: body.type }, authorizedContext);
    const existing = postArray(existingData).find((post) => isSamePost(post, body, groupIds));
    if (existing) {
      report.push({ action: "skipped_duplicate", fingerprint, platform, accountIds: groupIds, postId: existing._id, parentPostId: existing.parentPostId || null, status: existing.status, scheduleDate: existing.scheduleDate, media: existing.media || [], verified: true });
      continue;
    }
    const createdData = await socialRequest(locationId, "/posts", { method: "POST", body: { ...body, accountIds: groupIds }, authorizedContext });
    const created = createdData?.results?.post;
    const newId = createdPostId(createdData);
    // From here on HighLevel has accepted the post: never throw, or the agent
    // retries and creates a duplicate. Remember it before verifying.
    recentCreates.set(recentKey, { postId: newId, at: Date.now() });
    let matched = null;
    if (verify) {
      for (let attempt = 0; attempt < 2 && !matched; attempt += 1) {
        if (attempt > 0) await sleep(1500);
        const verifiedData = await requestSocialPostList({ locationId, status: body.status || "all", accountIds: groupIds, skip: 0, limit: 100, fromDate, toDate, includeUsers: true, postType: body.type }, authorizedContext);
        matched = postArray(verifiedData).find((post) => post._id === newId || isSamePost(post, body, groupIds));
      }
    }
    report.push({ action: "created", fingerprint, platform, accountIds: groupIds, postId: newId || matched?._id || null, parentPostId: created?.parentPostId || matched?.parentPostId || null, status: matched?.status || created?.status || body.status, scheduleDate: matched?.scheduleDate || created?.scheduleDate || body.scheduleDate || null, media: matched?.media || created?.media || [], verified: Boolean(matched), ...(matched ? {} : { warning: `HighLevel accepted this ${platform} post${newId ? "" : " but returned no post id"}, and the list does not show it yet. It was created: do NOT create it again -- check list_social_posts later.` }) });
  }
  return { success: true, message: "Create request completed with duplicate protection and list verification.", results: report };
}

const PLATFORM_DETAIL_FIELDS = {
  tiktok: "tiktokPostDetails", google: "gmbPostDetails", instagram: "instagramPostDetails", facebook: "facebookPostDetails",
  linkedin: "linkedinPostDetails", pinterest: "pinterestPostDetails", youtube: "youtubePostDetails", community: "communityPostDetails"
};

function stripRejectedProperties(body, message) {
  let removed = false;
  for (const match of message.matchAll(/(?:([\w.]+)\.)?property (\w+) should not exist/g)) {
    let target = body;
    for (const key of match[1] ? match[1].split(".") : []) target = target?.[key];
    if (target && typeof target === "object" && match[2] in target) { delete target[match[2]]; removed = true; }
  }
  return removed;
}

// HighLevel's edit endpoint is not a partial update: sending only the
// changed field is rejected with 422 ("accountIds must be an array ... should
// not be empty ... media must be an array"). So load the post as it is now,
// lay the requested changes over it, and send the complete body back.
// Agent vs hand-made posts, by engagement (like + share + comment) from the
// post list's own `insights`. Posts not recorded in agent_posts count as manual.
async function agentPostPerformance(args, authorizedContext, repository) {
  const { locationId = DEFAULT_LOCATION_ID, fromDate, toDate } = args;
  const to = toDate ? new Date(toDate) : new Date();
  const from = fromDate ? new Date(fromDate) : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new Error("fromDate and toDate must be ISO-8601 dates.");
  const accounts = accountList(await listSocialAccounts({ locationId }, authorizedContext)).filter(isEligibleSocialAccount);
  if (!accounts.length) throw new Error("No active social accounts are connected.");
  const posts = [];
  for (let skip = 0; skip < 500; skip += 100) {
    const page = postArray(await requestSocialPostList({ locationId, status: "published", accountIds: accounts.map((a) => a.id), skip, limit: 100, fromDate: from.toISOString(), toDate: to.toISOString(), includeUsers: false }, authorizedContext));
    posts.push(...page);
    if (page.length < 100) break;
  }
  const agentIds = typeof repository?.findAgentPostIds === "function" ? await repository.findAgentPostIds(authorizedContext.tenantId, posts.map((post) => post._id)) : new Set();
  const engagement = (post) => (post.insights?.like || 0) + (post.insights?.share || 0) + (post.insights?.comment || 0);
  const summarize = (list) => ({
    posts: list.length,
    totalEngagement: list.reduce((sum, post) => sum + engagement(post), 0),
    averageEngagementPerPost: list.length ? Math.round((list.reduce((sum, post) => sum + engagement(post), 0) / list.length) * 100) / 100 : 0,
    top: [...list].sort((a, b) => engagement(b) - engagement(a)).slice(0, 3).map((post) => ({ postId: post._id, platform: post.platform, engagement: engagement(post), summary: String(post.summary || "").slice(0, 80) }))
  });
  const byPlatform = {};
  for (const platform of new Set(posts.map((post) => post.platform))) {
    const inPlatform = posts.filter((post) => post.platform === platform);
    byPlatform[platform] = { agent: summarize(inPlatform.filter((p) => agentIds.has(p._id))), manual: summarize(inPlatform.filter((p) => !agentIds.has(p._id))) };
  }
  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    note: "Only published posts. Posts created by the agent before tracking started (v3.15.0) count as manual. Engagement = likes + shares + comments from the post list; some platforms report these late.",
    agent: summarize(posts.filter((p) => agentIds.has(p._id))),
    manual: summarize(posts.filter((p) => !agentIds.has(p._id))),
    byPlatform
  };
}

async function updateSocialPost(args = {}, authorizedContext) {
  const { locationId = DEFAULT_LOCATION_ID, postId, verify = true } = args;
  if (!postId) throw new Error("postId is required.");
  if (!/^[a-f0-9]{24}$/i.test(postId)) throw new Error("postId must be the 24-character _id, not parentPostId.");
  const changes = {};
  for (const field of SOCIAL_POST_FIELDS) if (args[field] !== undefined) changes[field] = args[field];
  if (Object.keys(changes).length === 0) throw new Error("At least one post field must be provided.");
  if (changes.media && !Array.isArray(changes.media)) throw new Error("media must be an array.");
  if (changes.accountIds) await resolveSocialAccounts(locationId, changes.accountIds, authorizedContext);

  const tenant = tenantAccess(locationId, authorizedContext);
  const accountsForUpdate = await listSocialAccounts({ locationId }, authorizedContext);
  const current = (await getSocialPost({ locationId, postId, includeRelated: false }, authorizedContext))?.results?.post;
  if (!current) throw new Error("Could not load the post to update it. Check the postId with list_social_posts.");
  const body = {};
  for (const field of SOCIAL_POST_FIELDS) {
    if (["scheduleTimeUpdated", "createdBy"].includes(field)) continue;
    if (current[field] !== undefined && current[field] !== null) body[field] = current[field];
  }
  body.media = (Array.isArray(body.media) ? body.media : []).map((item) => ({ url: item.url, type: item.type, ...(item.caption ? { caption: item.caption } : {}) }));
  // GET returns read-only extras (e.g. postApprovalDetails.approverUser) the edit endpoint rejects; keep only the writable key.
  if (body.postApprovalDetails) {
    const approver = body.postApprovalDetails.approver || body.postApprovalDetails.approverUser?.id;
    if (approver) body.postApprovalDetails = { approver }; else delete body.postApprovalDetails;
  }
  // The stored post carries empty detail objects for platforms it is NOT on
  // (gmbPostDetails, tiktokPostDetails ...); sending them back made HighLevel
  // re-classify a Facebook post as Google. Keep only the details belonging to
  // the platforms of this post's own accounts.
  const accountPlatforms = new Set((body.accountIds || []).map((id) => accountList(accountsForUpdate).find((account) => account.id === id)?.platform).filter(Boolean));
  for (const [platform, key] of Object.entries(PLATFORM_DETAIL_FIELDS)) {
    if (!accountPlatforms.has(platform)) delete body[key];
  }
  Object.assign(body, changes);
  if (body.status !== "in_review" && !changes.postApprovalDetails) delete body.postApprovalDetails;
  // The edit endpoint requires userId even when the stored post doesn't hand one back.
  if (!body.userId) body.userId = current.userId || current.createdBy || tenant.defaultUserId || undefined;
  if (changes.scheduleDate) body.scheduleTimeUpdated = true;
  if (!Array.isArray(body.accountIds) || body.accountIds.length === 0) throw new Error("This post has no accountIds to keep; pass accountIds (from list_social_accounts).");
  if (["scheduled", "in_review"].includes(body.status) && !body.scheduleDate) throw new Error(`scheduleDate is required when status is ${body.status}.`);
  if (body.status === "in_review" && !body.postApprovalDetails?.approver) throw new Error("postApprovalDetails.approver is required for in_review posts.");
  if (!body.userId) throw new Error("userId is required to update a post. Pass userId explicitly or configure a tenant default_user_id.");

  // Anything else HighLevel returns but won't accept back is named in its 422
  // ("... property X should not exist"); drop it and retry rather than fail.
  let updated;
  for (let attempt = 0; ; attempt += 1) {
    try {
      updated = await socialRequest(locationId, `/posts/${encodeURIComponent(postId)}`, { method: "PUT", body, authorizedContext });
      break;
    } catch (error) {
      const stripped = attempt < 4 && stripRejectedProperties(body, String(error.message));
      if (!stripped) throw error;
    }
  }
  if (!verify) return updated;
  const fetched = await getSocialPost({ locationId, postId, includeRelated: true }, authorizedContext);
  return { ...updated, verification: fetched };
}

async function deleteSocialPost({ locationId = DEFAULT_LOCATION_ID, postId }, authorizedContext) {
  if (!postId) throw new Error("postId is required.");
  if (!/^[a-f0-9]{24}$/i.test(String(postId).trim())) {
    throw new Error("postId must be a post's 24-character _id (from create_social_post's results[].postId or list_social_posts), not a parentPostId, account id or link. To remove a duplicate, find its _id with list_social_posts and delete each one by its own _id.");
  }
  postId = String(postId).trim();
  return await socialRequest(locationId, `/posts/${encodeURIComponent(postId)}`, { method: "DELETE", authorizedContext });
}

async function getSocialStatistics(args = {}, authorizedContext) {
  const { locationId = DEFAULT_LOCATION_ID, profileIds, platforms, currentRange, prevRange } = args;
  if (!Array.isArray(profileIds) || profileIds.length === 0) throw new Error("profileIds must be a non-empty array.");
  if (profileIds.length > 100) throw new Error("profileIds supports at most 100 accounts.");
  const body = { profileIds };
  if (platforms) body.platforms = platforms;
  if (currentRange) body.currentRange = currentRange;
  if (prevRange) body.prevRange = prevRange;
  const tenant = tenantAccess(locationId, authorizedContext);
  const path = `/social-media-posting/statistics?${new URLSearchParams({ locationId: tenant.locationId })}`;
  return await tenantRequest(tenant.locationId, path, { method: "POST", body, headers: { "Content-Type": "application/json" }, version: "v3", authorizedContext });
}

const openAIFileSchema = {
  type: "object",
  properties: {
    download_url: { type: "string" },
    file_id: { type: "string" },
    mime_type: { type: "string" },
    file_name: { type: "string" }
  },
  required: ["download_url", "file_id"],
  additionalProperties: false
};

const mediaItemSchema = {
  type: "object",
  properties: {
    url: { type: "string", description: "A media library or public HTTPS media URL." },
    type: { type: "string", description: "MIME type such as image/png or video/mp4." },
    caption: { type: "string" }
  },
  required: ["url", "type"],
  additionalProperties: true
};

const socialPostProperties = {
  locationId: { type: "string", description: "Optional. Leave this out in almost every call -- the server already knows which tenant/location you are authorized for and uses it automatically. Only pass this if the user explicitly names a different sub-account location ID than the one you are currently connected to; passing your own tenant's location ID, or guessing one, will be rejected as cross-tenant access." },
  accountIds: { type: "array", items: { type: "string" }, description: "Connected account IDs from list_social_accounts." },
  summary: { type: "string", description: "Post caption/content." },
  media: { type: "array", items: mediaItemSchema },
  status: { type: "string", enum: ["draft", "scheduled", "in_review", "published"], description: "Use draft unless the user explicitly asks to schedule, review, or publish." },
  scheduleDate: { type: "string", description: "ISO-8601 UTC date; required for scheduled and in_review." },
  selectedBestTime: { type: "string" },
  createdBy: { type: "string" },
  followUpComment: { type: "string" },
  ogTagsDetails: { type: "object", additionalProperties: true },
  type: { type: "string", enum: ["post", "story", "reel", "short"] },
  postApprovalDetails: { type: "object", additionalProperties: true },
  scheduleTimeUpdated: { type: "boolean" },
  tags: { type: "array", items: { type: "string" }, description: "Tag IDs, not names. Call list_social_tags first to resolve a tag's name to its id; an unrecognized value is silently dropped." },
  categoryId: { type: "string", description: "A category's id, not its name. Call list_social_categories first to resolve the name the user gave you to its id; an unrecognized value is silently dropped." },
  applyWatermark: { type: "boolean" },
  tiktokPostDetails: { type: "object", additionalProperties: true },
  gmbPostDetails: { type: "object", additionalProperties: true },
  userId: { type: "string", description: "The account's user ID creating the post." },
  linkedinPostDetails: { type: "object", additionalProperties: true },
  pinterestPostDetails: { type: "object", additionalProperties: true },
  facebookPostDetails: { type: "object", additionalProperties: true },
  instagramPostDetails: { type: "object", additionalProperties: true },
  youtubePostDetails: { type: "object", additionalProperties: true },
  communityPostDetails: { type: "object", additionalProperties: true }
};

// Sent once in the MCP `initialize` response as soft process guidance for
// the model -- new customers don't know what this connector can/can't do or
// what order to do things in, and a live test showed the model answering
// "find my media library" from ChatGPT's own file history instead of
// calling search_media_library. Critical rules also live in each tool's own
// description (that's what actually gates behavior); this is an overview a
// tool description alone can't give, since it needs to compare across tools.
const MCP_INSTRUCTIONS = `This connects to the customer's own social media / CRM account (posts, media, accounts, stats) -- it is a separate system from ChatGPT itself.

First-time setup: if a tool fails saying no connection exists, call connect_social_account first (owner/admin only) -- every other tool needs a connection.

Media library rule: "my media library", "our gallery", "photos we already have", or anything the user says is already in their account means their CONNECTED account's media library -- call search_media_library. Never answer this from ChatGPT's own uploaded files, generated images, or ChatGPT's Media Library; those are a completely different, unrelated place. Use upload_media only to add something new to their account. If the user names a specific folder, resolve its id first (search_media_library with type "folder") before filtering by folderId -- don't just search by name across the whole library and call it done.

Posts: default to draft unless the user explicitly says to schedule or publish. category/tag fields need real ids, not names typed by the user -- call list_social_categories / list_social_tags first to resolve them. If create_social_post errors or times out, check list_social_posts before trying again -- the post may already exist, and creating it a second time makes a duplicate. To remove a duplicate, delete it by its own 24-character _id (from list_social_posts), not a parentPostId.\n\nNever choose posting accounts for the user: if they haven't said which account(s) a post goes to, call list_social_accounts and ask them, then pass accountIds explicitly.

Team members who are not the account's Admin cannot connect it themselves (the platform only allows an Admin to do that) -- use invite_team_member for them instead of asking them to run connect_social_account.

If asked what system, platform, software or vendor this runs on, what "Social Planner" is, or anything about the technology underneath -- never name or guess at a third-party platform, even if you believe you know it. Answer only that this is Uplifting Social AI's own social media management system for the customer's connected accounts. This applies even to direct or repeated questions.`;

const tools = [
  {
    name: "upload_media",
    title: "Upload media to the account's media library",
    description: "Upload an image or video -- from the current ChatGPT conversation, a ChatGPT-generated image, ChatGPT's own Media Library, or a public HTTPS URL -- into the customer's own connected media library (used for social posts). Prefer file for ChatGPT-generated and ChatGPT-Library media.",
    inputSchema: {
      type: "object",
      properties: {
        locationId: socialPostProperties.locationId,
        file: openAIFileSchema,
        fileUrl: { type: "string", description: "Optional public HTTPS image/video URL. Use only when no ChatGPT file is available." },
        fileName: { type: "string", description: "Optional destination filename." },
        parentId: { type: "string", description: "Optional destination folder ID in the account's media library." }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    _meta: { "openai/fileParams": ["file"], "openai/toolInvocation/invoking": "Uploading media…", "openai/toolInvocation/invoked": "Media uploaded" }
  },
  {
    name: "search_media_library",
    title: "Search the account's media library",
    description: "Search and list media already stored in the customer's own connected account -- this is NOT ChatGPT's own uploaded files, generated images, or ChatGPT's Media Library. Always call this tool (never answer from ChatGPT's own file/image history) whenever the user refers to their media library, gallery, existing photos/videos, or asks to find/reuse something already in their account. The library can be organized into folders: if the user names a folder (e.g. \"ảnh trong thư mục Tháng 10\"), first call with type \"folder\" and search set to the folder name to find its id, then call again with that id as folderId to list what's inside. Each returned file also reports its own folderId.",
    inputSchema: { type: "object", properties: {
      search: { type: "string", description: "Filter by name/filename. Matched both server-side and again locally." },
      mediaType: { type: "string", enum: ["all", "image", "video"] },
      type: { type: "string", enum: ["file", "folder"], description: "What kind of item to list. Defaults to file. Use folder to find a folder's id by name before browsing it with folderId." },
      folderId: { type: "string", description: "Only list items inside this specific folder. Omit to search the whole library regardless of folder. Get this id from a prior call with type \"folder\"." },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      offset: { type: "integer", minimum: 0 },
      locationId: socialPostProperties.locationId
    } },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "inspect_media",
    description: "Visually inspect an image for an allowlisted tenant. For videos, pass thumbnailUrl.",
    inputSchema: { type: "object", properties: { locationId: socialPostProperties.locationId, url: { type: "string" }, thumbnailUrl: { type: "string" }, name: { type: "string" } } },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
  },
  {
    name: "connect_social_account",
    title: "Connect a sub-account",
    description: "Start Uplifting OAuth for the caller's own tenant, for one specific sub-account (locationId). Returns a URL for the user to open in a browser and approve; the callback stores the connection automatically. Only tenant_owner/tenant_admin/uplifting_admin may call this. Use this first for a brand-new tenant that has no connection yet -- every other tool needs one. If the call fails saying locationId is required, ask the user for the sub-account ID to connect.",
    inputSchema: { type: "object", properties: { locationId: { type: "string", description: "The sub-account (location) ID to connect. Optional when Uplifting already assigned one to this account; required otherwise." } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  },
  {
    name: "invite_team_member",
    title: "Invite a teammate to this tenant",
    description: "Invite someone by email to use Uplifting Social AI for this tenant, without them needing to be an Admin (only an Admin can approve the connection themselves). They get an email with a link that adds them; they then add the connector in ChatGPT and choose \"Email me a sign-in link\" using this same address. Only tenant_owner/tenant_admin/uplifting_admin may call this.",
    inputSchema: {
      type: "object",
      properties: {
        email: { type: "string", description: "The teammate's email address." },
        role: { type: "string", enum: ["tenant_admin", "editor", "viewer"], description: "What they can do. editor can create/schedule posts; viewer is read-only; tenant_admin can also invite others and manage the sub-account connection." }
      },
      required: ["email", "role"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "list_location_users",
    title: "List users for this location",
    description: "List staff/users of the allowlisted tenant's sub-account. Use to find a userId for create_social_post (userId is required for every post status) or for postApprovalDetails.approver.",
    inputSchema: { type: "object", properties: { locationId: socialPostProperties.locationId } },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "list_social_accounts",
    title: "List connected social accounts",
    description: "List social accounts and groups connected to this account. Use before creating or filtering posts.",
    inputSchema: { type: "object", properties: { locationId: socialPostProperties.locationId } },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "list_social_categories",
    title: "List post categories",
    description: "List this tenant's post categories, with their real ids. Call this before passing categoryId to create_social_post or update_social_post -- the field needs the id, not the name the user says.",
    inputSchema: { type: "object", properties: { locationId: socialPostProperties.locationId, search: { type: "string", description: "Filter by category name." }, limit: { type: "integer", minimum: 1, maximum: 100 }, skip: { type: "integer", minimum: 0 } } },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "list_social_tags",
    title: "List post tags",
    description: "List this tenant's post tags, with their real ids. Call this before passing tags to create_social_post or update_social_post -- the field needs ids, not the names the user says.",
    inputSchema: { type: "object", properties: { locationId: socialPostProperties.locationId, search: { type: "string", description: "Filter by tag name." }, limit: { type: "integer", minimum: 1, maximum: 100 }, skip: { type: "integer", minimum: 0 } } },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "get_agent_post_performance",
    title: "Compare agent posts with manual posts",
    description: "Measure how the posts created through Uplifting Social AI perform against posts made by hand in the same period and channels: post count, total and average engagement (likes + shares + comments), best posts, per platform. Only published posts; only posts the agent created after tracking began are counted as agent posts. Use when the user asks how well the agent's posts are doing or how they compare with manual posting.",
    inputSchema: { type: "object", properties: { locationId: socialPostProperties.locationId, fromDate: { type: "string", description: "ISO-8601 start of the period. Defaults to 30 days before toDate." }, toDate: { type: "string", description: "ISO-8601 end of the period. Defaults to now." } } },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "list_social_posts",
    title: "List social posts",
    description: "List posts. If accountIds is omitted, lists across all active connected accounts.",
    inputSchema: { type: "object", properties: {
      locationId: socialPostProperties.locationId,
      status: { type: "string", enum: ["recent", "all", "scheduled", "draft", "failed", "in_review", "published", "in_progress", "pending", "deleted"] },
      accountIds: { type: "array", items: { type: "string" } },
      skip: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      fromDate: { type: "string" }, toDate: { type: "string" }, includeUsers: { type: "boolean" },
      postType: { type: "string", enum: ["post", "story", "reel"] }
    } },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "get_social_post",
    title: "Get social post",
    description: "Get one post by its 24-character _id and optionally resolve related records sharing its parent grouping key.",
    inputSchema: { type: "object", properties: { locationId: socialPostProperties.locationId, postId: { type: "string" }, includeRelated: { type: "boolean", description: "Also inspect list results for records sharing parentPostId. Defaults true." } }, required: ["postId"] },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "create_social_post",
    title: "Create social post",
    description: "Create a brand-safe social post. Defaults to draft. accountIds is required: if the user has not said which accounts to post to, ASK them (use list_social_accounts) -- never choose for them. Splits platforms into separate requests, prevents exact retries, and verifies the result through list_social_posts.",
    inputSchema: { type: "object", properties: { ...socialPostProperties, verify: { type: "boolean", description: "Verify creation through the list endpoint. Defaults true." }, splitByPlatform: { type: "boolean", description: "Split Facebook and Google into separate create requests. Defaults true." } } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    _meta: { "openai/toolInvocation/invoking": "Creating social post…", "openai/toolInvocation/invoked": "Social post created" }
  },
  {
    name: "update_social_post",
    title: "Update social post",
    description: "Update a post record by its 24-character _id and verify it by fetching the record and its parent grouping relationship.",
    inputSchema: { type: "object", properties: { postId: { type: "string" }, ...socialPostProperties, verify: { type: "boolean", description: "Fetch and verify after update. Defaults true." } }, required: ["postId"] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  },
  {
    name: "delete_social_post",
    title: "Delete social post",
    description: "Delete one post by its 24-character _id (the postId in create_social_post results, or _id from list_social_posts) -- never a parentPostId or account id. Duplicates are separate posts: find each one with list_social_posts and delete them individually. Use only after explicit user confirmation.",
    inputSchema: { type: "object", properties: { locationId: socialPostProperties.locationId, postId: { type: "string", description: "The post's 24-character _id." } }, required: ["postId"] },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  },
  {
    name: "get_social_statistics",
    title: "Get social statistics",
    description: "Retrieve posting analytics for connected accounts and optional date ranges.",
    inputSchema: { type: "object", properties: {
      locationId: socialPostProperties.locationId,
      profileIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100 },
      platforms: { type: "array", items: { type: "string", enum: ["facebook", "instagram", "linkedin", "google", "pinterest", "youtube", "tiktok"] } },
      currentRange: { type: "object", additionalProperties: true }, prevRange: { type: "object", additionalProperties: true }
    }, required: ["profileIds"] },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }
];

const READ_ONLY_TOOLS = new Set([
  "search_media_library", "inspect_media", "get_agent_post_performance", "list_location_users", "list_social_accounts", "list_social_posts",
  "list_social_categories", "list_social_tags", "get_social_post", "get_social_statistics"
]);
const DELETE_TOOLS = new Set(["delete_social_post"]);

function toolOAuthScopes(toolName) {
  return READ_ONLY_TOOLS.has(toolName) ? ["uplifting:read"] : ["uplifting:write"];
}

function authorizeTool(principal, toolName) {
  if (principal.authType === "legacy_admin") return;
  const role = principal.role;
  if (READ_ONLY_TOOLS.has(toolName)) return;
  if (DELETE_TOOLS.has(toolName) && !["tenant_owner", "tenant_admin", "uplifting_admin"].includes(role)) {
    const error = new Error("Tenant administrator permission is required for this action.");
    error.code = "TENANT_ROLE_FORBIDDEN";
    throw error;
  }
  if (!["tenant_owner", "tenant_admin", "editor", "uplifting_admin"].includes(role)) {
    const error = new Error("This membership role is read-only.");
    error.code = "TENANT_ROLE_FORBIDDEN";
    throw error;
  }
}

for (const tool of tools) {
  const securitySchemes = [{ type: "oauth2", scopes: toolOAuthScopes(tool.name) }];
  tool.securitySchemes = securitySchemes;
  tool._meta = { ...(tool._meta || {}), securitySchemes };
}

async function requestTenantContext(req, requestedLocationId) {
  req.mcpDiagnosticStage = "tenant_resolution";
  const services = req.tenantServices || requestServices(req);
  if (req.principal.authType === "legacy_admin") {
    const context = await authorizeLegacyAdminContext({ requestedLocationId, defaultLocationId: DEFAULT_LOCATION_ID, ...services });
    mcpDiagnostic(req, "tenant_resolved", { tenantId: context.tenantId, role: req.principal.role });
    return context;
  }
  const context = await authorizeTenantContext({
    tenantId: req.principal.tenantId,
    requestedLocationId,
    actor: { type: "user", userId: req.principal.userId, role: req.principal.role },
    ...services
  });
  mcpDiagnostic(req, "tenant_resolved", { tenantId: context.tenantId, role: req.principal.role });
  return context;
}

async function auditTool(req, values) {
  const repository = req.tenantServices?.repository;
  if (!repository?.recordAuditEvent) return;
  await repository.recordAuditEvent({
    actorUserId: req.principal?.userId || null,
    tenantId: req.principal?.tenantId || values.tenantId || null,
    requestId: req.body?.id == null ? null : String(req.body.id),
    ...values
  });
}

app.post("/onboarding/highlevel/start", authenticateMcpRequest, async (req, res) => {
  try {
    if (req.principal.authType !== "oauth") return res.status(403).json({ error: "oauth_user_required" });
    const result = await createHighLevelOnboarding({ env: process.env, repository: req.tenantServices.repository }).start(req.principal, { locationId: req.body?.locationId });
    return res.json(result);
  } catch (error) {
    return res.status(error.status || 400).json({ error: redactSecrets(error.message) });
  }
});

app.get("/oauth/callback/social-crm", async (req, res) => {
  const services = requestServices(req);
  try {
    const login = await completeHighLevelLogin({ query: req.query, repository: services.repository, env: process.env });
    if (login?.redirectUrl) return res.redirect(302, login.redirectUrl);
    if (login) return res.status(login.status).type("html").send(login.html);
    const result = await createHighLevelOnboarding({ env: process.env, repository: services.repository }).callback(req.query);
    return res.json(result);
  } catch (error) {
    return res.status(400).json({ error: redactSecrets(error.message) });
  }
});

app.get("/debug/tool-schema", (req, res) => {
  const enabled =
    process.env.MCP_DEBUG_TOOL_SCHEMA === "true" &&
    process.env.RENDER_SERVICE_ID === "srv-dapsmt5g1s2s73d9sp7g" &&
    process.env.RENDER_EXTERNAL_HOSTNAME === "uplifting-social-ai-staging.onrender.com" &&
    process.env.RENDER_GIT_BRANCH === "feature/oauth-multitenant-v1";

  if (!enabled) return res.status(404).end();

  const schema = tools.find((tool) => tool.name === "create_social_post")?.inputSchema;
  if (!schema) return res.status(404).end();

  res.set("Cache-Control", "no-store");
  return res.json(Object.hasOwn(schema, "required")
    ? { requiredPresent: true, required: schema.required }
    : { requiredPresent: false });
});

app.use("/mcp", authenticateMcpRequest);

app.post("/mcp", async (req, res) => {
  const request = req.body || {};
  const id = request.id ?? null;
  if (!req.principal && !PUBLIC_MCP_METHODS.has(request.method)) {
    return res.status(401).json({ jsonrpc: "2.0", id, error: { code: -32002, message: "OAuth authentication required." } });
  }
  try {
    if (request.method === "initialize") {
      mcpDiagnostic(req, "initialize_handled");
      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "uplifting-social-ai", version: SERVICE_VERSION },
          instructions: MCP_INSTRUCTIONS
        }
      });
    }
    if (request.method === "notifications/initialized") {
      mcpDiagnostic(req, "initialized_notification_handled");
      return res.status(202).end();
    }
    if (request.method === "tools/list") {
      mcpDiagnostic(req, "tools_list_handled", { toolCount: tools.length });
      return res.json({ jsonrpc: "2.0", id, result: { tools } });
    }
    if (request.method === "tools/call") {
      const toolName = request.params?.name;
      let args = request.params?.arguments || {};
      const tool = tools.find((item) => item.name === toolName);
      if (!tool) throw new Error(`Unknown tool: ${toolName}`);
      authorizeTool(req.principal, toolName);
      const rateLimitKey = req.principal.tenantId || req.principal.userId || req.ip;
      if (!checkRateLimit(rateLimitKey)) {
        mcpDiagnostic(req, "rate_limited", { toolName });
        return res.json({ jsonrpc: "2.0", id, error: { code: -32029, message: "Too many requests. Please wait a moment and try again." } });
      }
      if (toolName === "connect_social_account") {
        if (req.principal.authType !== "oauth") throw new Error("connect_social_account requires an OAuth user.");
        const onboardingResult = await createHighLevelOnboarding({ env: process.env, repository: req.tenantServices.repository }).start(req.principal, { locationId: args.locationId });
        await auditTool(req, { tenantId: req.principal.tenantId, toolName, action: "tool.call", result: "success", metadata: { locationId: args.locationId } });
        return res.json({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `Mở link này để kết nối: ${onboardingResult.authorizationUrl}` }],
            structuredContent: onboardingResult
          }
        });
      }
      if (toolName === "invite_team_member") {
        if (req.principal.authType !== "oauth") throw new Error("invite_team_member requires an OAuth user.");
        if (!["tenant_owner", "tenant_admin", "uplifting_admin"].includes(req.principal.role)) {
          throw new Error("Tenant owner or administrator permission is required to invite a teammate.");
        }
        await enforceUserLimit(req);
        const invited = await inviteTeamMember({
          repository: req.tenantServices.repository,
          env: process.env,
          tenantId: req.principal.tenantId,
          tenantName: req.principal.tenantName,
          invitedByUserId: req.principal.userId,
          inviterName: req.principal.email || req.principal.subject,
          email: args.email,
          role: args.role
        });
        await auditTool(req, { tenantId: req.principal.tenantId, toolName, action: "tool.call", result: "success", metadata: { role: args.role } });
        return res.json({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: `Đã gửi lời mời tới ${args.email}.` }], structuredContent: invited }
        });
      }
      const authorizedContext = await requestTenantContext(req, args.locationId);
      // requestTenantContext already rejected any caller-supplied locationId
      // that isn't this tenant's own. Pin every handler to that location so
      // an omitted locationId can never fall back to the global 123 GYM
      // default baked into the handlers' own parameter defaults.
      args = { ...args, locationId: authorizedContext.locationId };
      let result;
      if (toolName === "upload_media") {
        result = await uploadMedia(args, authorizedContext);
        await auditTool(req, { tenantId: authorizedContext.tenantId, toolName, action: "tool.call", result: "success", metadata: { locationId: authorizedContext.locationId } });
        return res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Uploaded: ${result.url || result.fileId || "success"}` }], structuredContent: result } });
      }
      if (toolName === "search_media_library") {
        result = await listMedia(args, authorizedContext);
        await auditTool(req, { tenantId: authorizedContext.tenantId, toolName, action: "tool.call", result: "success", metadata: { locationId: authorizedContext.locationId } });
        return res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } });
      }
      if (toolName === "get_agent_post_performance") {
        result = await agentPostPerformance(args, authorizedContext, req.tenantServices.repository);
        await auditTool(req, { tenantId: authorizedContext.tenantId, toolName, action: "tool.call", result: "success", metadata: { locationId: authorizedContext.locationId } });
        return res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } });
      }
      if (toolName === "inspect_media") {
        result = await inspectMedia(args, authorizedContext);
        await auditTool(req, { tenantId: authorizedContext.tenantId, toolName, action: "tool.call", result: "success", metadata: { locationId: authorizedContext.locationId } });
        return res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Media: ${result.name}\nSource: ${result.sourceUrl}` }, { type: "image", data: result.base64, mimeType: result.mimeType }] } });
      }
      const socialHandlers = {
        list_location_users: listLocationUsers,
        list_social_accounts: listSocialAccounts,
        list_social_categories: listSocialCategories,
        list_social_tags: listSocialTags,
        list_social_posts: listSocialPosts,
        get_social_post: getSocialPost,
        create_social_post: createSocialPost,
        update_social_post: updateSocialPost,
        delete_social_post: deleteSocialPost,
        get_social_statistics: getSocialStatistics
      };
      if (socialHandlers[toolName]) {
        if (toolName === "create_social_post") await enforcePostLimit(req);
        result = await socialHandlers[toolName](args, authorizedContext);
        if (toolName === "create_social_post") {
          const createdCount = (result.results || []).filter((entry) => entry.action === "created").length;
          recordUsage(req, { tenantId: authorizedContext.tenantId, metric: "posts_created", by: createdCount });
          recordAgentPosts(req, authorizedContext.tenantId, result.results);
        }
        await auditTool(req, { tenantId: authorizedContext.tenantId, toolName, action: "tool.call", result: "success", metadata: { locationId: authorizedContext.locationId } });
        return res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } });
      }
      throw new Error(`Unknown tool: ${toolName}`);
    }
    return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${request.method}` } });
  } catch (error) {
    mcpDiagnostic(req, "mcp_handler_failed", {
      stage: req.mcpDiagnosticStage,
      ...diagnosticError(error)
    });
    await auditTool(req, { toolName: request.params?.name || null, action: "tool.call", result: "failure", metadata: { errorCode: error.code || "TOOL_ERROR" } }).catch(() => {});
    if (error instanceof AuthenticationError && error.code === "insufficient_scope") {
      const challenge = oauthChallenge(process.env, { error: "insufficient_scope", description: error.message, scope: toolOAuthScopes(request.params?.name).join(" ") });
      return res.json({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: error.message }], _meta: { "mcp/www_authenticate": [challenge] } } });
    }
    return res.json({ jsonrpc: "2.0", id, error: { code: -32000, message: redactSecrets(error.message) } });
  }
});

const isMainModule = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMainModule) {
  const configuration = authConfiguration(process.env);
  if (!configuration.oauthReady && !configuration.legacyAdminReady) {
    console.error("OAuth is not configured and legacy admin authentication is not explicitly enabled; refusing to start.");
    process.exitCode = 1;
  } else {
    app.listen(PORT, "0.0.0.0", () => console.log(`Uplifting Social AI v${SERVICE_VERSION} listening on port ${PORT}`));
  }
}

export {
  app,
  updateSocialPost,
  deleteSocialPost,
  authenticateMcpRequest,
  buildSocialPostBody,
  createSocialPost,
  downloadChatGPTFile,
  enforcePostLimit,
  enforceUserLimit,
  getSocialStatistics,
  isEligibleSocialAccount,
  listLocationUsers,
  listMedia,
  listSocialAccounts,
  listSocialCategories,
  listSocialTags,
  agentPostPerformance,
  resetRateLimitStateForTests,
  resetRecentCreatesForTests,
  resolveTenant,
  safeFileName,
  tenantRegistry,
  tools,
  uploadMedia,
  validateLocationBinding
};
