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
  if (!response.ok) throw new Error(`HighLevel OAuth token exchange failed (${response.status}).`);
  if (!body.access_token || !body.refresh_token) {
    console.error("[highlevel-onboarding] Incomplete OAuth token response. Keys present:", Object.keys(body));
    throw new Error("HighLevel OAuth response is incomplete.");
  }
  return body;
}

export function createHighLevelOnboarding({ env = process.env, repository, fetchImpl = globalThis.fetch } = {}) {
  const callbackUrl = env.HIGHLEVEL_REDIRECT_URI;

  async function start(principal, { locationId } = {}) {
    requireOwner(principal);
    if (!env.HIGHLEVEL_INSTALL_URL || !callbackUrl) throw new Error("HighLevel OAuth onboarding is not configured.");
    // A tenant created from an invite that names a sub-account may connect
    // only that one; otherwise the caller must say which one.
    const invitedLocationId = await repository.findInvitedLocationId?.(principal.tenantId);
    if (invitedLocationId && locationId && locationId !== invitedLocationId) {
      throw new Error("This account is assigned to a different HighLevel sub-account than the one requested.");
    }
    locationId = locationId || invitedLocationId;
    if (!locationId) throw new Error("connect_highlevel requires locationId: the HighLevel sub-account to connect.");
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
    if (!code || !state) throw new Error("HighLevel OAuth callback requires code and state.");
    const authorization = await repository.consumeOAuthState(sha256(state));
    if (!authorization) throw new Error("HighLevel OAuth state is invalid, expired, or already used.");
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
        throw new Error(`HighLevel granted sub-account ${body.locationId}, not the requested ${intendedLocationId}. Reconnect and pick the intended one.`);
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
      if (!body.companyId) throw new Error("HighLevel OAuth response is incomplete.");
      if (!intendedLocationId) throw new Error("This HighLevel install granted company-wide access; connect_highlevel must be called with locationId.");
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
