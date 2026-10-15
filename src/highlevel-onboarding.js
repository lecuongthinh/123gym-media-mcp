import { createHash, randomBytes } from "node:crypto";
import { encryptCredential } from "./credential-provider.js";
import { fetchHighLevelUsers, pickDefaultUserId } from "./highlevel-users.js";
import { mintLocationToken } from "./highlevel-location-token.js";

const HIGHLEVEL_TOKEN_URL = "https://services.leadconnectorhq.com/oauth/token";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireOwner(principal) {
  if (!principal || !["tenant_owner", "tenant_admin", "uplifting_admin"].includes(principal.role)) {
    const error = new Error("Tenant owner or administrator permission is required.");
    error.status = 403;
    throw error;
  }
}

export class ConnectionConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConnectionConflictError";
    this.status = 409;
  }
}

// One tenant owns exactly one sub-account, and a sub-account belongs to exactly
// one tenant. Refuse anything else up front instead of letting the database
// constraint (or an upsert that silently swaps the connection) decide.
async function assertConnectable(repository, tenantId, locationId) {
  const current = await repository.findConnectedLocationId?.(tenantId);
  if (current && current !== locationId) {
    throw new ConnectionConflictError(
      `This account is already connected to sub-account ${current}. Each account connects exactly one sub-account, so ${locationId} cannot be added. Sign in with the account that owns ${locationId} instead.`
    );
  }
  const owner = await repository.findLocationOwnerTenantId?.(locationId);
  if (owner && owner !== tenantId) {
    throw new ConnectionConflictError(
      `Sub-account ${locationId} already belongs to a different account, so it cannot be connected here. Sign in with the account that owns it instead.`
    );
  }
}

export function friendlyOnboardingError(error, redact = (text) => text) {
  const message = String(error?.message || "");
  if (error instanceof ConnectionConflictError || /connections_provider_external_location_id_key|connections_tenant_id_provider_key/.test(message)) {
    return "Sub-account này đã thuộc một tài khoản khác, hoặc tài khoản của anh/chị đã kết nối một sub-account khác. Mỗi tài khoản chỉ kết nối một sub-account: hãy đăng nhập bằng tài khoản sở hữu sub-account đó.";
  }
  if (/state is invalid, expired, or already used/.test(message)) {
    return "Link kết nối đã hết hạn (10 phút) hoặc đã được dùng rồi. Nếu đã kết nối xong thì không cần làm gì thêm; nếu chưa, hãy nhờ trợ lý tạo link mới và chỉ mở nó một lần.";
  }
  return redact(message);
}

export function onboardingResultPage({ ok, message }) {
  const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const title = ok ? "Kết nối thành công" : "Chưa kết nối được";
  const hint = ok ? "Anh/chị có thể đóng tab này và quay lại ChatGPT." : "Quay lại ChatGPT và nhờ trợ lý tạo link mới nếu cần. Mỗi link chỉ dùng được một lần.";
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.5}h1{font-size:1.4rem}.d{color:#555}</style></head><body><h1>${ok ? "✅" : "⚠️"} ${title}</h1><p>${escape(message)}</p><p class="d">${hint}</p></body></html>`;
}

export async function exchangeHighLevelCode({ env = process.env, code, fetchImpl = globalThis.fetch }) {
  const response = await fetchImpl(HIGHLEVEL_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Version: "v3" },
    body: new URLSearchParams({
      client_id: env.HIGHLEVEL_CLIENT_ID || "",
      client_secret: env.HIGHLEVEL_CLIENT_SECRET || "",
      grant_type: "authorization_code",
      code,
      user_type: "Location",
      redirect_uri: env.HIGHLEVEL_REDIRECT_URI || ""
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Uplifting OAuth token exchange failed (${response.status}).`);
  if (!body.access_token || !body.refresh_token) {
    console.error("[highlevel-onboarding] Incomplete OAuth token response. Keys present:", Object.keys(body));
    throw new Error("Uplifting OAuth response is incomplete.");
  }
  return body;
}

export function createHighLevelOnboarding({ env = process.env, repository, fetchImpl = globalThis.fetch } = {}) {
  const callbackUrl = env.HIGHLEVEL_REDIRECT_URI;

  async function start(principal, { locationId } = {}) {
    requireOwner(principal);
    if (!env.HIGHLEVEL_INSTALL_URL || !callbackUrl) throw new Error("Uplifting OAuth onboarding is not configured.");
    // A tenant created from an invite that names a sub-account may connect
    // only that one; otherwise the caller must say which one.
    const invitedLocationId = await repository.findInvitedLocationId?.(principal.tenantId);
    if (invitedLocationId && locationId && locationId !== invitedLocationId) {
      throw new Error("This account is assigned to a different sub-account than the one requested.");
    }
    locationId = locationId || invitedLocationId;
    if (!locationId) throw new Error("connect_social_account requires locationId: the sub-account to connect.");
    await assertConnectable(repository, principal.tenantId, locationId);
    const state = randomBytes(32).toString("base64url");
    await repository.createOAuthState({
      stateHash: sha256(state),
      tenantId: principal.tenantId,
      actorUserId: principal.userId,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      intendedLocationId: locationId
    });
    const url = new URL(env.HIGHLEVEL_INSTALL_URL);
    url.searchParams.set("state", state);
    return { authorizationUrl: url.toString(), expiresIn: 600 };
  }

  async function callback({ code, state }) {
    if (!code || !state) throw new Error("Uplifting OAuth callback requires code and state.");
    const authorization = await repository.consumeOAuthState(sha256(state));
    if (!authorization) throw new Error("Uplifting OAuth state is invalid, expired, or already used.");
    const body = await exchangeHighLevelCode({ env, code, fetchImpl });

    const intendedLocationId = authorization.intended_location_id;
    let secret;
    let locationId;

    if (body.locationId) {
      // A genuine per-location grant (the authorizing HighLevel user has
      // access to only one sub-account). Verified this branch is reachable
      // only for non-agency users; our own agency admins always land in the
      // company branch below, even after picking one sub-account.
      if (intendedLocationId && body.locationId !== intendedLocationId) {
        throw new Error(`Granted sub-account ${body.locationId}, not the requested ${intendedLocationId}. Reconnect and pick the intended one.`);
      }
      locationId = body.locationId;
      secret = {
        auth_mode: "location",
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        location_id: locationId,
        scope: body.scope || "",
        expires_at: new Date(Date.now() + Number(body.expires_in || 86400) * 1000).toISOString()
      };
    } else {
      // Company (agency) grant: HighLevel does not name a single location
      // here even when the authorizing user picked exactly one sub-account
      // during consent -- confirmed against the real API 2026-09-28. Mint a
      // location-scoped token for the sub-account the caller asked for.
      if (!body.companyId) throw new Error("Uplifting OAuth response is incomplete.");
      if (!intendedLocationId) throw new Error("This install granted company-wide access; connect_social_account must be called with locationId.");
      const minted = await mintLocationToken({ companyAccessToken: body.access_token, companyId: body.companyId, locationId: intendedLocationId, fetchImpl });
      locationId = intendedLocationId;
      secret = {
        auth_mode: "company",
        company_id: body.companyId,
        company_refresh_token: body.refresh_token,
        location_id: locationId,
        access_token: minted.accessToken,
        scope: body.scope || "",
        expires_at: new Date(Date.now() + minted.expiresIn * 1000).toISOString()
      };
    }

    await assertConnectable(repository, authorization.tenant_id, locationId);

    let defaultUserId = null;
    try {
      const users = await fetchHighLevelUsers({ accessToken: secret.access_token, locationId, fetchImpl });
      defaultUserId = pickDefaultUserId(users);
    } catch {
      // HighLevel's Users API needs its own scope; if the connected app/token
      // does not have it, onboarding still succeeds and an admin can set
      // connections.default_user_id manually afterwards.
      defaultUserId = null;
    }
    await repository.saveHighLevelOAuthConnection({
      tenantId: authorization.tenant_id,
      locationId,
      encryptedPayload: encryptCredential(secret, env),
      expiresAt: secret.expires_at,
      scopes: String(body.scope || "").split(/\s+/).filter(Boolean),
      defaultUserId
    });
    await repository.recordAuditEvent({
      actorUserId: authorization.actor_user_id,
      tenantId: authorization.tenant_id,
      action: "highlevel.oauth.connected",
      result: "success",
      metadata: { locationId, authMode: secret.auth_mode, defaultUserIdResolved: Boolean(defaultUserId) }
    });
    return { connected: true, locationId, defaultUserIdResolved: Boolean(defaultUserId) };
  }

  return { start, callback };
}
