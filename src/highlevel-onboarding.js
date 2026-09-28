import { createHash, randomBytes } from "node:crypto";
import { encryptCredential } from "./credential-provider.js";
import { fetchHighLevelUsers, pickDefaultUserId } from "./highlevel-users.js";

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

export function createHighLevelOnboarding({ env = process.env, repository, fetchImpl = globalThis.fetch } = {}) {
  const callbackUrl = env.HIGHLEVEL_REDIRECT_URI;

  async function start(principal) {
    requireOwner(principal);
    if (!env.HIGHLEVEL_INSTALL_URL || !callbackUrl) throw new Error("HighLevel OAuth onboarding is not configured.");
    const state = randomBytes(32).toString("base64url");
    await repository.createOAuthState({
      stateHash: sha256(state),
      tenantId: principal.tenantId,
      actorUserId: principal.userId,
      expiresAt: new Date(Date.now() + 10 * 60_000)
    });
    const url = new URL(env.HIGHLEVEL_INSTALL_URL);
    url.searchParams.set("state", state);
    return { authorizationUrl: url.toString(), expiresIn: 600 };
  }

  async function callback({ code, state }) {
    if (!code || !state) throw new Error("HighLevel OAuth callback requires code and state.");
    const authorization = await repository.consumeOAuthState(sha256(state));
    if (!authorization) throw new Error("HighLevel OAuth state is invalid, expired, or already used.");
    const response = await fetchImpl(HIGHLEVEL_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Version: "v3" },
      body: new URLSearchParams({
        client_id: env.HIGHLEVEL_CLIENT_ID || "",
        client_secret: env.HIGHLEVEL_CLIENT_SECRET || "",
        grant_type: "authorization_code",
        code,
        user_type: "Location",
        redirect_uri: callbackUrl || ""
      })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`HighLevel OAuth token exchange failed (${response.status}).`);
    if (!body.access_token || !body.refresh_token || !body.locationId) {
      // Key names only -- never log token values or other field contents.
      console.error("[highlevel-onboarding] Incomplete OAuth token response. Keys present:", Object.keys(body));
      throw new Error("HighLevel OAuth response is incomplete.");
    }
    const expiresAt = new Date(Date.now() + Number(body.expires_in || 86400) * 1000).toISOString();
    const secret = {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      location_id: body.locationId,
      scope: body.scope || "",
      expires_at: expiresAt
    };
    let defaultUserId = null;
    try {
      const users = await fetchHighLevelUsers({ accessToken: body.access_token, locationId: body.locationId, fetchImpl });
      defaultUserId = pickDefaultUserId(users);
    } catch {
      // HighLevel's Users API needs its own scope; if the connected app/token
      // does not have it, onboarding still succeeds and an admin can set
      // connections.default_user_id manually afterwards.
      defaultUserId = null;
    }
    await repository.saveHighLevelOAuthConnection({
      tenantId: authorization.tenant_id,
      locationId: body.locationId,
      encryptedPayload: encryptCredential(secret, env),
      expiresAt,
      scopes: String(body.scope || "").split(/\s+/).filter(Boolean),
      defaultUserId
    });
    await repository.recordAuditEvent({
      actorUserId: authorization.actor_user_id,
      tenantId: authorization.tenant_id,
      action: "highlevel.oauth.connected",
      result: "success",
      metadata: { locationId: body.locationId, defaultUserIdResolved: Boolean(defaultUserId) }
    });
    return { connected: true, locationId: body.locationId, defaultUserIdResolved: Boolean(defaultUserId) };
  }

  return { start, callback };
}
