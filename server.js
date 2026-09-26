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

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 10000;
const LC_BASE_URL = "https://services.leadconnectorhq.com";
const DEFAULT_LOCATION_ID = process.env.DEFAULT_LOCATION_ID || LEGACY_123_GYM_LOCATION_ID;
const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const VIDEO_MAX_BYTES = 500 * 1024 * 1024;

const SERVICE_VERSION = "3.3.0";
const TESTING_AGENCY_TENANT_ID = "00000000-0000-4000-8000-000000000124";
const TEST_DRAFT_LOCATION_ID = "UwsfBVLmz7XSKJbhuOTS";
const TEST_DRAFT_ACCOUNT_ID = "68c83389c2ef4245a387b54f_UwsfBVLmz7XSKJbhuOTS_112256467241215_page";
const TEST_DRAFT_BODY = Object.freeze({
  accountIds: Object.freeze([TEST_DRAFT_ACCOUNT_ID]),
  summary: "[STAGING TEST] Kiểm tra tạo bài nháp không cần userId. Không xuất bản.",
  status: "draft",
  type: "post"
});
let draftDiagnosticAttempted = false;
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
    errorMessage: sqlState ? `SQLSTATE ${sqlState}` : "Unexpected error"
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
  const identity = await requestVerifier(req)(token);
  const services = requestServices(req);
  req.tenantServices = services;
  req.principal = await authorizeUserPrincipal({ identity, repository: services.repository });
  return identity;
}

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
  if (!token) throw new Error(`LeadConnector credential is not configured for tenant ${tenant.name}.`);
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
    connectionId: authorizedContext.connectionId
  };
}

async function parseResponse(response) {
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) {
    const detail = Array.isArray(data?.message) ? data.message.join("; ") : (typeof data?.message === "string" ? data.message : data?.error);
    throw new Error(`LeadConnector API failed (${response.status})${detail ? `: ${redactSecrets(detail).slice(0, 500)}` : ""}`);
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
  if (socialMatch && decodeURIComponent(socialMatch[1]) !== locationId) throw new Error("Cross-tenant LeadConnector request blocked.");
  const queryLocation = url.searchParams.get("locationId") || url.searchParams.get("altId");
  if (queryLocation && queryLocation !== locationId) throw new Error("Cross-tenant LeadConnector request blocked.");
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
  const { locationId = DEFAULT_LOCATION_ID, search = "", mediaType = "all", limit = 50, offset = 0 } = args;
  const tenant = tenantAccess(locationId, authorizedContext);
  const params = new URLSearchParams({ altId: locationId, altType: "location", sortBy: "createdAt", sortOrder: "desc", type: "file", limit: String(Math.min(Number(limit) || 50, 100)), offset: String(Number(offset) || 0) });
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
  return { count: files.length, files: files.map((file) => ({ id: file._id, name: file.name, contentType: file.contentType, url: file.url, width: file.width, height: file.height, size: file.size, createdAt: file.createdAt, thumbnailUrl: file.thumbnail?.url || null, previewUrl: file.preview?.url || null, category: file.category || null, subCategory: file.subCategory || null })) };
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

// --------------------------------------------------
// SOCIAL PLANNER
// --------------------------------------------------

async function listSocialAccounts({ locationId = DEFAULT_LOCATION_ID } = {}, authorizedContext) {
  return await socialRequest(locationId, "/accounts", { authorizedContext });
}

const BLOCKED_ACCOUNT_PATTERN = /t[oô] hi[eệ]u|56\s*t[oô]\s*hi[eệ]u|tuy[eể]n\s*d[uụ]ng|balance\s*fit/i;
const ALLOWED_SOCIAL_PLATFORMS = new Set(["facebook", "google"]);

function accountList(data) {
  return data?.results?.accounts || data?.accounts || [];
}

function isEligible123GymAccount(account) {
  const identity = [account?.name, account?.meta?.storeCode, ...(account?.meta?.storefrontAddress?.addressLines || [])].filter(Boolean).join(" ");
  return Boolean(account?.id && account.active !== false && !account.isExpired && !account.deleted && ALLOWED_SOCIAL_PLATFORMS.has(account.platform) && !BLOCKED_ACCOUNT_PATTERN.test(identity));
}

function isEligibleSocialAccount(account, locationId) {
  const active = Boolean(account?.id && account.active !== false && !account.isExpired && !account.deleted);
  return locationId === LEGACY_123_GYM_LOCATION_ID ? isEligible123GymAccount(account) : active;
}

async function resolveSocialAccounts(locationId, requestedIds = [], authorizedContext) {
  const accountsData = await listSocialAccounts({ locationId }, authorizedContext);
  const all = accountList(accountsData);
  const eligible = all.filter((account) => isEligibleSocialAccount(account, locationId));
  const requested = Array.isArray(requestedIds) ? requestedIds.filter(Boolean) : [];
  if (!requested.length) return eligible;
  const byId = new Map(all.map((account) => [account.id, account]));
  const unknown = requested.filter((id) => !byId.has(id));
  if (unknown.length) throw new Error(`Unknown Social Planner accountIds: ${unknown.join(", ")}`);
  const blocked = requested.map((id) => byId.get(id)).filter((account) => !isEligibleSocialAccount(account, locationId));
  if (blocked.length) throw new Error(`Inactive or tenant-blocked Social Planner accounts: ${blocked.map((account) => `${account.name} (${account.id})`).join(", ")}`);
  return requested.map((id) => byId.get(id));
}

function postArray(data) {
  return data?.results?.posts || data?.posts || [];
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
  if (!accounts.length) throw new Error("No eligible 123 GYM Facebook or Google accounts are connected.");
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
  if (!partial && status !== "draft" && (typeof body.userId !== "string" || !body.userId.trim())) {
    throw new Error("userId is required to create a Social Planner post.");
  }
  if (status === "in_review" && !body.postApprovalDetails?.approver) {
    throw new Error("postApprovalDetails.approver is required for in_review posts.");
  }
  if (body.media && !Array.isArray(body.media)) throw new Error("media must be an array.");
  return body;
}

async function createSocialPost(args = {}, authorizedContext) {
  const { locationId = DEFAULT_LOCATION_ID, verify = true, splitByPlatform = true } = args;
  const accounts = await resolveSocialAccounts(locationId, args.accountIds || [], authorizedContext);
  const body = buildSocialPostBody({ ...args, accountIds: accounts.map((account) => account.id) });
  const grouped = new Map();
  for (const account of accounts) grouped.set(account.platform, [...(grouped.get(account.platform) || []), account]);
  const groups = splitByPlatform ? [...grouped.values()] : [accounts];
  const report = [];
  for (const group of groups) {
    const groupIds = group.map((account) => account.id);
    const platform = group[0]?.platform || "mixed";
    const fingerprint = createHash("sha256").update(JSON.stringify({ locationId, accountIds: [...groupIds].sort(), summary: body.summary || "", media: body.media || [], status: body.status, scheduleDate: body.scheduleDate || null, type: body.type })).digest("hex").slice(0, 20);
    const target = new Date(body.scheduleDate || Date.now());
    const fromDate = new Date(target.getTime() - 12 * 60 * 60 * 1000).toISOString();
    const toDate = new Date(target.getTime() + 12 * 60 * 60 * 1000).toISOString();
    const existingData = await requestSocialPostList({ locationId, status: body.status || "all", accountIds: groupIds, skip: 0, limit: 100, fromDate, toDate, includeUsers: true, postType: body.type }, authorizedContext);
    const existing = postArray(existingData).find((post) => post.summary === (body.summary || "") && (!body.scheduleDate || post.scheduleDate === body.scheduleDate) && groupIds.every((id) => post.accountIds?.includes(id)) && JSON.stringify(post.media || []) === JSON.stringify(body.media || []));
    if (existing) {
      report.push({ action: "skipped_duplicate", fingerprint, platform, accountIds: groupIds, postId: existing._id, parentPostId: existing.parentPostId || null, status: existing.status, scheduleDate: existing.scheduleDate, media: existing.media || [], verified: true });
      continue;
    }
    const createdData = await socialRequest(locationId, "/posts", { method: "POST", body: { ...body, accountIds: groupIds }, authorizedContext });
    const created = createdData?.results?.post;
    let matched = null;
    if (verify) {
      const verifiedData = await requestSocialPostList({ locationId, status: body.status || "all", accountIds: groupIds, skip: 0, limit: 100, fromDate, toDate, includeUsers: true, postType: body.type }, authorizedContext);
      matched = postArray(verifiedData).find((post) => post._id === created?._id || (post.summary === body.summary && (!body.scheduleDate || post.scheduleDate === body.scheduleDate) && groupIds.every((id) => post.accountIds?.includes(id))));
      if (!matched) throw new Error(`Post creation returned success but verification failed for ${platform} accounts (${groupIds.join(",")}).`);
    }
    report.push({ action: "created", fingerprint, platform, accountIds: groupIds, postId: created?._id || matched?._id, parentPostId: created?.parentPostId || matched?.parentPostId || null, status: matched?.status || created?.status, scheduleDate: matched?.scheduleDate || created?.scheduleDate, media: matched?.media || created?.media || [], verified: Boolean(matched) });
  }
  return { success: true, message: "Create request completed with duplicate protection and list verification.", results: report };
}

async function updateSocialPost(args = {}, authorizedContext) {
  const { locationId = DEFAULT_LOCATION_ID, postId, verify = true } = args;
  if (!postId) throw new Error("postId is required.");
  if (!/^[a-f0-9]{24}$/i.test(postId)) throw new Error("postId must be the 24-character _id, not parentPostId.");
  const body = buildSocialPostBody(args, { partial: true });
  if (Object.keys(body).length === 0) throw new Error("At least one post field must be provided.");
  if (body.accountIds) await resolveSocialAccounts(locationId, body.accountIds, authorizedContext);
  const updated = await socialRequest(locationId, `/posts/${encodeURIComponent(postId)}`, { method: "PUT", body, authorizedContext });
  if (!verify) return updated;
  const fetched = await getSocialPost({ locationId, postId, includeRelated: true }, authorizedContext);
  return { ...updated, verification: fetched };
}

async function deleteSocialPost({ locationId = DEFAULT_LOCATION_ID, postId }, authorizedContext) {
  if (!postId) throw new Error("postId is required.");
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
    url: { type: "string", description: "LeadConnector or public HTTPS media URL." },
    type: { type: "string", description: "MIME type such as image/png or video/mp4." },
    caption: { type: "string" }
  },
  required: ["url", "type"],
  additionalProperties: true
};

const socialPostProperties = {
  locationId: { type: "string", description: "Allowlisted LeadConnector tenant location ID. Defaults to 123 GYM for backward compatibility." },
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
  tags: { type: "array", items: { type: "string" } },
  categoryId: { type: "string" },
  applyWatermark: { type: "boolean" },
  tiktokPostDetails: { type: "object", additionalProperties: true },
  gmbPostDetails: { type: "object", additionalProperties: true },
  userId: { type: "string", description: "LeadConnector user ID creating the post." },
  linkedinPostDetails: { type: "object", additionalProperties: true },
  pinterestPostDetails: { type: "object", additionalProperties: true },
  facebookPostDetails: { type: "object", additionalProperties: true },
  instagramPostDetails: { type: "object", additionalProperties: true },
  youtubePostDetails: { type: "object", additionalProperties: true },
  communityPostDetails: { type: "object", additionalProperties: true }
};

const tools = [
  {
    name: "upload_leadconnector_media",
    title: "Upload media to LeadConnector",
    description: "Upload an image or video from the current ChatGPT conversation, generated images, ChatGPT Media Library, or import a public HTTPS URL into LeadConnector Media Library. Prefer file for ChatGPT-generated and Library media.",
    inputSchema: {
      type: "object",
      properties: {
        locationId: socialPostProperties.locationId,
        file: openAIFileSchema,
        fileUrl: { type: "string", description: "Optional public HTTPS image/video URL. Use only when no ChatGPT file is available." },
        fileName: { type: "string", description: "Optional destination filename." },
        parentId: { type: "string", description: "Optional LeadConnector destination folder ID." }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    _meta: { "openai/fileParams": ["file"], "openai/toolInvocation/invoking": "Uploading media…", "openai/toolInvocation/invoked": "Media uploaded" }
  },
  {
    name: "search_leadconnector_media",
    description: "Search and list media from the selected allowlisted tenant's LeadConnector Media Library.",
    inputSchema: { type: "object", properties: { search: { type: "string" }, mediaType: { type: "string", enum: ["all", "image", "video"] }, limit: { type: "integer", minimum: 1, maximum: 100 }, offset: { type: "integer", minimum: 0 }, locationId: { type: "string" } } },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "inspect_media",
    description: "Visually inspect an image for an allowlisted tenant. For videos, pass thumbnailUrl.",
    inputSchema: { type: "object", properties: { locationId: socialPostProperties.locationId, url: { type: "string" }, thumbnailUrl: { type: "string" }, name: { type: "string" } } },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
  },
  {
    name: "list_social_accounts",
    title: "List connected social accounts",
    description: "List social accounts and groups connected to LeadConnector Social Planner. Use before creating or filtering posts.",
    inputSchema: { type: "object", properties: { locationId: socialPostProperties.locationId } },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "list_social_posts",
    title: "List social posts",
    description: "List Social Planner posts. If accountIds is omitted, automatically uses eligible 123 GYM/La Charme Facebook and Google accounts while excluding Tô Hiệu, recruitment and Balance Fit accounts.",
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
    description: "Get one Social Planner post by its 24-character _id and optionally resolve related records sharing its parent grouping key.",
    inputSchema: { type: "object", properties: { locationId: socialPostProperties.locationId, postId: { type: "string" }, includeRelated: { type: "boolean", description: "Also inspect list results for records sharing parentPostId. Defaults true." } }, required: ["postId"] },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "create_social_post",
    title: "Create social post",
    description: "Create a brand-safe LeadConnector Social Planner post. Defaults to draft, auto-selects eligible 123 GYM accounts when omitted, splits Facebook and Google, prevents exact retries, and verifies the result through list_social_posts.",
    inputSchema: { type: "object", properties: { ...socialPostProperties, verify: { type: "boolean", description: "Verify creation through the list endpoint. Defaults true." }, splitByPlatform: { type: "boolean", description: "Split Facebook and Google into separate create requests. Defaults true." } } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    _meta: { "openai/toolInvocation/invoking": "Creating social post…", "openai/toolInvocation/invoked": "Social post created" }
  },
  {
    name: "update_social_post",
    title: "Update social post",
    description: "Update a Social Planner record by its 24-character _id and verify it by fetching the record and its parent grouping relationship.",
    inputSchema: { type: "object", properties: { postId: { type: "string" }, ...socialPostProperties, verify: { type: "boolean", description: "Fetch and verify after update. Defaults true." } }, required: ["postId"] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  },
  {
    name: "delete_social_post",
    title: "Delete social post",
    description: "Delete a Social Planner post by ID. Use only after explicit user confirmation.",
    inputSchema: { type: "object", properties: { locationId: socialPostProperties.locationId, postId: { type: "string" } }, required: ["postId"] },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  },
  {
    name: "get_social_statistics",
    title: "Get social statistics",
    description: "Retrieve Social Planner analytics for connected accounts and optional date ranges.",
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
  "search_leadconnector_media", "inspect_media", "list_social_accounts", "list_social_posts",
  "get_social_post", "get_social_statistics"
]);
const DELETE_TOOLS = new Set(["delete_social_post"]);

function toolOAuthScopes(toolName) {
  return READ_ONLY_TOOLS.has(toolName) ? ["uplifting:read"] : ["uplifting:write"];
}

function authorizeTool(principal, toolName) {
  requireScopes(principal, toolOAuthScopes(toolName));
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
    requireScopes(req.principal, ["uplifting:write"]);
    const result = await createHighLevelOnboarding({ env: process.env, repository: req.tenantServices.repository }).start(req.principal);
    return res.json(result);
  } catch (error) {
    return res.status(error.status || 400).json({ error: redactSecrets(error.message) });
  }
});

app.get("/oauth/callback/highlevel", async (req, res) => {
  const services = requestServices(req);
  try {
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

function requireDraftDebugStaging(req, res, next) {
  res.set("Cache-Control", "no-store");
  const enabled =
    process.env.MCP_DEBUG_TEST_DRAFT_WITHOUT_USERID === "true" &&
    process.env.RENDER_SERVICE_ID === "srv-dapsmt5g1s2s73d9sp7g" &&
    process.env.RENDER_EXTERNAL_HOSTNAME === "uplifting-social-ai-staging.onrender.com" &&
    process.env.RENDER_GIT_BRANCH === "feature/oauth-multitenant-v1";
  if (!enabled) return res.status(404).end();
  return next();
}

async function authenticateDebugOAuthRequest(req, res, next) {
  const configuration = authConfiguration(process.env);
  try {
    const token = bearerToken(req);
    if (!configuration.oauthReady || !token) throw new AuthenticationError("OAuth authentication required.");
    await resolveOAuthPrincipal(req, token);
    return next();
  } catch (error) {
    const expected = error instanceof AuthenticationError || error instanceof TenantAuthorizationError;
    const status = error instanceof AuthenticationError ? error.status : (error instanceof TenantAuthorizationError ? 403 : 503);
    const message = expected ? error.message : "Authentication service unavailable.";
    if (configuration.oauthReady) {
      res.set("WWW-Authenticate", oauthChallenge(process.env, { error: error.code || "invalid_token", description: message }));
    }
    return res.status(status).json({ error: error.code || "authentication_failed", message });
  }
}

app.post("/debug/test-draft-without-userid", requireDraftDebugStaging, authenticateDebugOAuthRequest, async (req, res) => {
  let accessToken;
  try {
    if (req.principal?.authType !== "oauth" || req.principal?.tenantId !== TESTING_AGENCY_TENANT_ID) {
      return res.status(403).json({ error: "testing_agency_oauth_required" });
    }
    authorizeTool(req.principal, "create_social_post");

    const services = req.tenantServices || requestServices(req);
    const connection = await services.repository.findActiveConnectionByTenantId(TESTING_AGENCY_TENANT_ID);
    if (
      !connection ||
      connection.tenant_id !== TESTING_AGENCY_TENANT_ID ||
      connection.location_id !== TEST_DRAFT_LOCATION_ID ||
      connection.auth_type !== "private_integration_token" ||
      connection.credential_type !== "private_integration_token" ||
      connection.secret_backend !== "environment" ||
      connection.secret_ref !== "env://LC_PRIVATE_TOKEN_TESTING_AGENCY"
    ) {
      return res.status(412).json({ error: "testing_agency_connection_precondition_failed" });
    }

    const credential = await services.credentialProvider.getAccess(connection);
    if (
      credential?.locationId !== TEST_DRAFT_LOCATION_ID ||
      typeof credential?.accessToken !== "string" ||
      credential.accessToken.length === 0
    ) {
      return res.status(412).json({ error: "testing_agency_credential_precondition_failed" });
    }
    accessToken = credential.accessToken;

    const body = TEST_DRAFT_BODY;
    if (
      body.status !== "draft" ||
      body.type !== "post" ||
      body.accountIds.length !== 1 ||
      body.accountIds[0] !== TEST_DRAFT_ACCOUNT_ID ||
      Object.hasOwn(body, "userId") ||
      Object.hasOwn(body, "scheduleDate") ||
      Object.hasOwn(body, "postApprovalDetails")
    ) {
      return res.status(412).json({ error: "draft_body_precondition_failed" });
    }

    const path = `/social-media-posting/${encodeURIComponent(TEST_DRAFT_LOCATION_ID)}/posts`;
    validateLocationBinding(path, TEST_DRAFT_LOCATION_ID);

    if (draftDiagnosticAttempted) return res.status(409).json({ error: "draft_diagnostic_already_attempted" });
    draftDiagnosticAttempted = true;

    const highLevelResponse = await fetch(`${LC_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        Version: "v3",
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const responseText = await highLevelResponse.text();
    let responseBody;
    try { responseBody = JSON.parse(responseText); } catch { responseBody = { raw: responseText }; }
    const sanitizedResponse = sanitizeDebugResponse(responseBody, credential.accessToken);
    const post = responseBody?.post || responseBody?.data || responseBody;
    const postId = typeof (post?._id || post?.id) === "string" ? post._id || post.id : null;
    const actualStatus = typeof post?.status === "string" ? post.status : null;

    return res.status(highLevelResponse.ok ? 200 : 502).json({
      highLevelHttpStatus: highLevelResponse.status,
      response: sanitizedResponse,
      ...(postId ? { postId } : {}),
      ...(actualStatus ? { status: actualStatus } : {})
    });
  } catch (error) {
    return res.status(502).json({
      error: "draft_test_failed",
      message: sanitizeDebugResponse(error?.message, accessToken)
    });
  }
});

app.use("/mcp", authenticateMcpRequest);

app.post("/mcp", async (req, res) => {
  const request = req.body || {};
  const id = request.id ?? null;
  try {
    if (request.method === "initialize") {
      mcpDiagnostic(req, "initialize_handled");
      return res.json({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "uplifting-social-ai", version: SERVICE_VERSION } } });
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
      const args = request.params?.arguments || {};
      const tool = tools.find((item) => item.name === toolName);
      if (!tool) throw new Error(`Unknown tool: ${toolName}`);
      authorizeTool(req.principal, toolName);
      const authorizedContext = await requestTenantContext(req, args.locationId);
      let result;
      if (toolName === "upload_leadconnector_media") {
        result = await uploadMedia(args, authorizedContext);
        await auditTool(req, { tenantId: authorizedContext.tenantId, toolName, action: "tool.call", result: "success", metadata: { locationId: authorizedContext.locationId } });
        return res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Uploaded to LeadConnector: ${result.url || result.fileId || "success"}` }], structuredContent: result } });
      }
      if (toolName === "search_leadconnector_media") {
        result = await listMedia(args, authorizedContext);
        await auditTool(req, { tenantId: authorizedContext.tenantId, toolName, action: "tool.call", result: "success", metadata: { locationId: authorizedContext.locationId } });
        return res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } });
      }
      if (toolName === "inspect_media") {
        result = await inspectMedia(args, authorizedContext);
        await auditTool(req, { tenantId: authorizedContext.tenantId, toolName, action: "tool.call", result: "success", metadata: { locationId: authorizedContext.locationId } });
        return res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Media: ${result.name}\nSource: ${result.sourceUrl}` }, { type: "image", data: result.base64, mimeType: result.mimeType }] } });
      }
      const socialHandlers = {
        list_social_accounts: listSocialAccounts,
        list_social_posts: listSocialPosts,
        get_social_post: getSocialPost,
        create_social_post: createSocialPost,
        update_social_post: updateSocialPost,
        delete_social_post: deleteSocialPost,
        get_social_statistics: getSocialStatistics
      };
      if (socialHandlers[toolName]) {
        result = await socialHandlers[toolName](args, authorizedContext);
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
  authenticateMcpRequest,
  buildSocialPostBody,
  downloadChatGPTFile,
  getSocialStatistics,
  isEligible123GymAccount,
  listMedia,
  listSocialAccounts,
  resolveTenant,
  safeFileName,
  tenantRegistry,
  tools,
  uploadMedia,
  validateLocationBinding
};
