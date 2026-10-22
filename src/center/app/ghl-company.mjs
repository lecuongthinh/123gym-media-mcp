// Token CẤP CÔNG TY (agency) dùng chung cho mọi tenant cài từ giao diện agency — lưu theo CẶP (app, công ty).
//
// Vấn đề thật cần tránh: GHL refresh_token DÙNG 1 LẦN (mỗi lần refresh trả về cái mới, cái cũ chết). Trước
// đây MỖI tenant giữ 1 BẢN SAO riêng của refresh_token công ty trong credential của mình — chạy được với 1-2
// khách, nhưng từ khách thứ 2 trở đi, tenant A refresh xong là bản sao của tenant B chết → `invalid_grant`
// ở một thời điểm bất kỳ sau đó, trông như lỗi không liên quan (bài học đã trả giá ở 123gym-server,
// 2026-09-26: refresh token bị đốt ngoài tầm kiểm soát của server).
//
// Giờ: MỖI (app, công ty) chỉ có ĐÚNG 1 bản refresh_token, lưu ở platform.ghl_company_tokens, refresh qua 1
// cửa duy nhất (single-flight) — mọi tenant cùng công ty dùng chung, token sub-account chỉ là bản mint ra từ
// token công ty. Cài thêm/cài lại → ghi đè bản mới nhất (saveCompanyToken). Hai app Marketplace khác nhau có
// token công ty RIÊNG (client_id khác) nên khoá theo app.
//
// TUYỆT ĐỐI không gọi tay endpoint /oauth/token (curl) để "thử xem" — làm vậy đốt refresh_token ngoài tầm
// kiểm soát của server và gây desync (xem trên).
import { platformQuery } from "./db.mjs";
import { encryptCredential, decryptCredential } from "./credential-crypto.mjs";
import { mintLocationToken } from "./highlevel-location-token.mjs";
import { getApp } from "./marketplace-apps.mjs";

const BASE = "https://services.leadconnectorhq.com";

let ready;
function ensureTable() {
  ready ||= platformQuery(`create table if not exists platform.ghl_company_tokens (
    app_key text not null,
    company_id text not null,
    encrypted_credential bytea not null,
    updated_at timestamptz not null default now(),
    primary key (app_key, company_id)
  )`);
  return ready;
}

async function retry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 300 * (i + 1))); }
  }
  throw last;
}

const cache = new Map(); // `${appKey}|${companyId}` -> { accessToken, refreshToken, expiresAt }
const inflight = new Map(); // single-flight
const ck = (appKey, companyId) => `${appKey}|${companyId}`;

async function persist(appKey, companyId, c) {
  await ensureTable();
  const enc = encryptCredential({ access_token: c.accessToken, refresh_token: c.refreshToken, expires_at: new Date(c.expiresAt).toISOString() });
  await retry(() => platformQuery(
    `insert into platform.ghl_company_tokens (app_key, company_id, encrypted_credential) values ($1,$2,$3)
     on conflict (app_key, company_id) do update set encrypted_credential = excluded.encrypted_credential, updated_at = now()`,
    [appKey, companyId, enc]
  ));
}

// Gọi khi 1 lượt cài OAuth thành công (token công ty mới tinh) — luôn ghi đè: bản mới nhất là bản sống.
export async function saveCompanyToken(appKey, companyId, { access_token, refresh_token, expires_in }) {
  const c = { accessToken: access_token, refreshToken: refresh_token, expiresAt: Date.now() + Number(expires_in || 86400) * 1000 };
  cache.set(ck(appKey, companyId), c); // đặt cache TRƯỚC khi ghi DB: nếu ghi DB lỗi, tiến trình này vẫn dùng được bản sống
  await persist(appKey, companyId, c);
}

async function load(appKey, companyId) {
  const k = ck(appKey, companyId);
  if (cache.has(k)) return cache.get(k);
  await ensureTable();
  const r = await retry(() => platformQuery("select encrypted_credential from platform.ghl_company_tokens where app_key = $1 and company_id = $2", [appKey, companyId]));
  if (!r.rows[0]) return null;
  const d = decryptCredential(r.rows[0].encrypted_credential);
  const c = { accessToken: d.access_token, refreshToken: d.refresh_token, expiresAt: new Date(d.expires_at).getTime() };
  cache.set(k, c);
  return c;
}

// `seedRefreshToken`: tenant cài từ TRƯỚC khi có bảng này vẫn giữ 1 bản sao refresh_token công ty trong
// credential riêng — dùng làm hạt giống lần đầu (nếu chưa có hàng nào cho công ty đó), từ đó về sau chỉ còn 1 bản.
export async function getCompanyAccessToken(appKey, companyId, seedRefreshToken) {
  let c = await load(appKey, companyId);
  if (!c && seedRefreshToken) c = { accessToken: null, refreshToken: seedRefreshToken, expiresAt: 0 };
  if (!c) throw new Error(`Chưa có token công ty ${companyId} cho app ${appKey} — cần cài lại app từ giao diện agency.`);
  if (c.accessToken && c.expiresAt > Date.now() + 60_000) return c.accessToken;
  const k = ck(appKey, companyId);
  if (inflight.has(k)) return inflight.get(k);
  const app = getApp(appKey);
  const p = (async () => {
    const r = await fetch(`${BASE}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Version: "v3" },
      body: new URLSearchParams({ client_id: app.clientId || "", client_secret: app.clientSecret || "", grant_type: "refresh_token", refresh_token: c.refreshToken, user_type: "Company" }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.access_token || !body.refresh_token) throw new Error(`Làm mới token công ty GHL (app ${appKey}) thất bại (HTTP ${r.status}${body.error ? " " + body.error : ""}) — nếu là invalid_grant thì cần cài lại app.`);
    const fresh = { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: Date.now() + Number(body.expires_in || 86400) * 1000 };
    cache.set(k, fresh); // cache TRƯỚC persist — refresh_token cũ đã chết, bản này là bản duy nhất sống
    await persist(appKey, companyId, fresh);
    return fresh.accessToken;
  })().finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

export async function mintLocationAccessToken(appKey, companyId, locationId, seedRefreshToken) {
  const companyAccessToken = await getCompanyAccessToken(appKey, companyId, seedRefreshToken);
  return mintLocationToken({ companyAccessToken, companyId, locationId });
}
