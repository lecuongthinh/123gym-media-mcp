// Cài đặt + token GHL cho các app Marketplace NGOÀI app gốc "center" (hiện là app "zalo"). Mỗi lượt cài là 1
// dòng trong platform.app_installs, khoá (app_key, location_id) — đây cũng chính là bảng "khách nào đang bật
// module nào". Cài app này KHÔNG tạo schema/dữ liệu trung tâm nào cả (khác app "center").
//
// Cùng cách xử lý token như app gốc (xem ghl-company.mjs): token công ty dùng chung 1 bản/(app,công ty),
// token sub-account chỉ là bản mint ra; refresh single-flight, cache trước khi ghi DB.
import { platformQuery } from "./db.mjs";
import { encryptCredential, decryptCredential } from "./credential-crypto.mjs";
import { getApp } from "./marketplace-apps.mjs";
import { saveCompanyToken, mintLocationAccessToken } from "./ghl-company.mjs";

const BASE = "https://services.leadconnectorhq.com";

let ready;
const ensure = () => (ready ||= platformQuery(`create table if not exists platform.app_installs (
  app_key text not null, location_id text not null, company_id text,
  encrypted_credential bytea not null,
  installed_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key (app_key, location_id)
)`));
const q = async (sql, p) => { await ensure(); return platformQuery(sql, p); };

export function buildAuthorizeUrl(appKey, state) {
  const app = getApp(appKey);
  const p = new URLSearchParams({ response_type: "code", redirect_uri: app.redirectUri, client_id: app.clientId || "", scope: app.scopes, version_id: app.versionId || "" });
  if (state) p.set("state", state);
  return `https://marketplace.gohighlevel.com/v2/oauth/chooselocation?${p.toString()}`;
}

async function exchangeCode(appKey, code) {
  const app = getApp(appKey);
  const r = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Version: "v3" },
    body: new URLSearchParams({ client_id: app.clientId || "", client_secret: app.clientSecret || "", grant_type: "authorization_code", code, user_type: "Location", redirect_uri: app.redirectUri }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Đổi mã OAuth lấy token thất bại (HTTP ${r.status}) — kiểm tra Client ID/Secret và Redirect URL của app.`);
  if (!body.access_token || !body.refresh_token) throw new Error("Phản hồi OAuth từ GHL thiếu access_token/refresh_token.");
  return body;
}

const save = (appKey, locationId, companyId, cred) => q(
  `insert into platform.app_installs (app_key, location_id, company_id, encrypted_credential) values ($1,$2,$3,$4)
   on conflict (app_key, location_id) do update set company_id = excluded.company_id, encrypted_credential = excluded.encrypted_credential, updated_at = now()`,
  [appKey, locationId, companyId || null, encryptCredential(cred)]
);

// Gọi từ route callback. Cài ngay trong sub-account → GHL trả locationId; cài từ giao diện agency → không trả,
// phải biết trước qua `state` (xem trang /apps/<app>/install hỏi Location ID).
export async function handleInstall(appKey, { code, state }) {
  const body = await exchangeCode(appKey, code);
  let locationId = body.locationId, cred;
  if (locationId) {
    cred = { auth_mode: "location", access_token: body.access_token, refresh_token: body.refresh_token, expires_at: new Date(Date.now() + Number(body.expires_in || 86400) * 1000).toISOString() };
  } else {
    if (!body.companyId) throw new Error("Phản hồi OAuth thiếu cả locationId lẫn companyId — không xác định được đang cài cho ai.");
    if (!state) throw new Error("Lượt cài này cấp quyền toàn agency nhưng không rõ cho sub-account nào — hãy mở link cài qua trang /apps/" + appKey + "/install (có ô nhập Location ID).");
    locationId = state;
    await saveCompanyToken(appKey, body.companyId, body);
    const m = await mintLocationAccessToken(appKey, body.companyId, locationId);
    cred = { auth_mode: "company", company_id: body.companyId, access_token: m.accessToken, expires_at: new Date(Date.now() + m.expiresIn * 1000).toISOString() };
  }
  await save(appKey, locationId, body.companyId, cred);
  tokenCache.delete(`${appKey}|${locationId}`);
  return { locationId };
}

export async function isInstalled(appKey, locationId) {
  return (await q("select 1 from platform.app_installs where app_key=$1 and location_id=$2", [appKey, locationId])).rowCount > 0;
}

const tokenCache = new Map(); // `${appKey}|${locationId}` -> { accessToken, expiresAt }
const inflight = new Map();

export async function getAppLocationToken(appKey, locationId) {
  const k = `${appKey}|${locationId}`;
  const hit = tokenCache.get(k);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.accessToken;
  if (inflight.has(k)) return inflight.get(k);
  const p = (async () => {
    const row = (await q("select company_id, encrypted_credential from platform.app_installs where app_key=$1 and location_id=$2", [appKey, locationId])).rows[0];
    if (!row) throw new Error(`Sub-account ${locationId} chưa cài app ${appKey}.`);
    let cred = decryptCredential(row.encrypted_credential);
    if (new Date(cred.expires_at).getTime() <= Date.now() + 60_000) {
      if (cred.auth_mode === "company") {
        const m = await mintLocationAccessToken(appKey, cred.company_id, locationId);
        cred = { auth_mode: "company", company_id: cred.company_id, access_token: m.accessToken, expires_at: new Date(Date.now() + m.expiresIn * 1000).toISOString() };
      } else {
        const app = getApp(appKey);
        const r = await fetch(`${BASE}/oauth/token`, {
          method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Version: "v3" },
          body: new URLSearchParams({ client_id: app.clientId || "", client_secret: app.clientSecret || "", grant_type: "refresh_token", refresh_token: cred.refresh_token, user_type: "Location" }),
        });
        const b = await r.json().catch(() => ({}));
        if (!r.ok || !b.access_token) throw new Error(`Làm mới token GHL (app ${appKey}, ${locationId}) thất bại (HTTP ${r.status}) — cần cài lại app.`);
        cred = { auth_mode: "location", access_token: b.access_token, refresh_token: b.refresh_token || cred.refresh_token, expires_at: new Date(Date.now() + Number(b.expires_in || 86400) * 1000).toISOString() };
      }
      tokenCache.set(k, { accessToken: cred.access_token, expiresAt: new Date(cred.expires_at).getTime() }); // cache TRƯỚC khi ghi DB (refresh_token cũ đã chết)
      await save(appKey, locationId, row.company_id, cred);
    }
    tokenCache.set(k, { accessToken: cred.access_token, expiresAt: new Date(cred.expires_at).getTime() });
    return cred.access_token;
  })().finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}
