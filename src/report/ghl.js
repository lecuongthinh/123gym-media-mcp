import { decryptCredential, encryptCredential } from "../credential-provider.js";

const LC_BASE_URL = "https://services.leadconnectorhq.com";
const REQUEST_TIMEOUT_MS = 20_000;

export class UpstreamError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "UpstreamError";
    this.code = "UPSTREAM_ERROR";
    this.status = status;
  }
}

// Env for the REPORT Marketplace app. Deliberately separate variables from the
// social-posting app (HIGHLEVEL_*): a different app, different scopes.
export function reportAppEnv(env = process.env) {
  return {
    clientId: env.REPORT_GHL_CLIENT_ID || "",
    clientSecret: env.REPORT_GHL_CLIENT_SECRET || "",
    redirectUri: env.REPORT_GHL_REDIRECT_URI || "",
    versionId: env.REPORT_GHL_VERSION_ID || "",
    // White-label host: customers must never see the underlying platform name, and the login session
    // of a white-labeled agency lives on this domain, not on marketplace.gohighlevel.com.
    authorizeUrl: env.REPORT_GHL_AUTHORIZE_URL || "https://marketplace.leadconnectorhq.com/oauth/chooselocation",
    apiVersion: env.REPORT_GHL_API_VERSION || "v3"
  };
}

export async function exchangeCode({ env, code, fetchImpl = globalThis.fetch }) {
  const app = reportAppEnv(env);
  const response = await fetchImpl(`${LC_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Version: "v3" },
    body: new URLSearchParams({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      grant_type: "authorization_code",
      code,
      user_type: "Location",
      redirect_uri: app.redirectUri
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new UpstreamError(`Đổi mã ủy quyền thất bại (${response.status}).`, response.status);
  if (!body.access_token || !body.refresh_token) throw new UpstreamError("Phản hồi ủy quyền không đầy đủ.", 502);
  return body;
}

async function refreshCredential({ env, credential, fetchImpl }) {
  const app = reportAppEnv(env);
  if (!credential.refresh_token) throw new UpstreamError("Thiếu refresh token. Cần cài đặt lại ứng dụng.", 401);
  const response = await fetchImpl(`${LC_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Version: "v3" },
    body: new URLSearchParams({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      grant_type: "refresh_token",
      refresh_token: credential.refresh_token,
      user_type: "Location"
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw new UpstreamError(`Làm mới quyền truy cập thất bại (${response.status}). Có thể ứng dụng đã bị gỡ cài đặt.`, response.status);
  return {
    ...credential,
    access_token: body.access_token,
    refresh_token: body.refresh_token || credential.refresh_token,
    scope: body.scope || credential.scope,
    expires_at: new Date(Date.now() + Number(body.expires_in || 86400) * 1000).toISOString()
  };
}

// Returns a usable access token for the tenant's one location, refreshing
// (and re-encrypting) it when it is about to expire.
export async function accessTokenFor({ store, env, tenantId, fetchImpl = globalThis.fetch }) {
  const connection = await store.getConnection(tenantId);
  if (!connection) throw new UpstreamError("Chưa có kết nối HighLevel cho tài khoản này. Cần cài đặt lại ứng dụng.", 409);
  let credential = decryptCredential(connection.encrypted_payload, env);
  const expiresAt = credential.expires_at ? new Date(credential.expires_at).getTime() : 0;
  if (expiresAt <= Date.now() + 60_000) {
    credential = await refreshCredential({ env, credential, fetchImpl });
    await store.updateConnectionCredential(tenantId, encryptCredential(credential, env), credential.expires_at);
  }
  if (!credential.access_token || credential.location_id !== connection.location_id) {
    throw new UpstreamError("Thông tin kết nối không khớp location.", 409);
  }
  return { accessToken: credential.access_token, locationId: connection.location_id };
}

function assertSameLocation(url, locationId) {
  const bound = url.searchParams.get("locationId") || url.searchParams.get("location_id") || url.searchParams.get("altId");
  if (bound && bound !== locationId) throw new UpstreamError("Yêu cầu bị chặn: sai location.", 403);
  const social = url.pathname.match(/^\/social-media-posting\/([^/]+)\//);
  if (social && decodeURIComponent(social[1]) !== locationId) throw new UpstreamError("Yêu cầu bị chặn: sai location.", 403);
}

function readableUpstreamMessage(status, body) {
  if (status === 401) return "HighLevel từ chối: phiên kết nối hết hạn hoặc ứng dụng đã bị gỡ. Cần cài đặt lại.";
  if (status === 403) return "HighLevel từ chối: ứng dụng chưa được cấp scope cho dữ liệu này.";
  if (status === 404) return "HighLevel không tìm thấy dữ liệu yêu cầu.";
  if (status === 429) return "HighLevel đang giới hạn tần suất. Thử lại sau ít phút.";
  const detail = typeof body?.message === "string" ? body.message : Array.isArray(body?.message) ? body.message.join("; ") : "";
  return `HighLevel báo lỗi (${status})${detail ? `: ${detail.slice(0, 160)}` : ""}.`;
}

// Read-only client bound to one tenant. Every tool goes through here, so the
// location check and the redaction live in one place.
export function createGhlClient({ store, env = process.env, tenantId, fetchImpl = globalThis.fetch }) {
  const app = reportAppEnv(env);

  async function request(path, { method = "GET", query, body } = {}) {
    const { accessToken, locationId } = await accessTokenFor({ store, env, tenantId, fetchImpl });
    const url = new URL(path, LC_BASE_URL);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    assertSameLocation(url, locationId);
    if (body && typeof body === "object" && body.locationId && body.locationId !== locationId) throw new UpstreamError("Yêu cầu bị chặn: sai location.", 403);

    const send = async (version) => {
      const response = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`, Version: version, Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      const text = await response.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
      return { response, data };
    };

    let { response, data } = await send(app.apiVersion);
    // HighLevel's endpoints disagree about the Version header; retry once with
    // the other well-known value only when the error names the header.
    if ([400, 404, 422].includes(response.status) && /version/i.test(JSON.stringify(data)) && app.apiVersion !== "2021-07-28") {
      ({ response, data } = await send("2021-07-28"));
    }
    if (!response.ok) throw new UpstreamError(readableUpstreamMessage(response.status, data), response.status);
    return data;
  }

  return {
    locationId: async () => (await accessTokenFor({ store, env, tenantId, fetchImpl })).locationId,
    get: (path, query) => request(path, { query }),
    post: (path, body, query) => request(path, { method: "POST", body, query })
  };
}
