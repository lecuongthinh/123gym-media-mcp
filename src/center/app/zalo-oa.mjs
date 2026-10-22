// Module Zalo OA đa khách hàng: mỗi trung tâm (tenant = 1 sub-account GHL) tự kết nối Zalo OA của mình
// (bấm nút → trang cấp quyền chính thức của Zalo, đăng nhập bằng QR/điện thoại ở đó), rồi tin nhắn đi 2 chiều
// giữa Zalo OA và tab Conversations của GHL.
//
// Dựng lại từ bản đã chạy thật ở 123gym-server (src/lib/ghlOAuth.js, routes/oaEvents.js,
// routes/zaloConversationOutbound.js) — những bài học đã trả giá được giữ nguyên:
//  - refresh_token của Zalo cũng XOAY (mỗi lần refresh trả cái mới): lưu cái mới TRƯỚC khi dùng, 1 cửa duy
//    nhất (single-flight) cho mỗi OA, không bao giờ giữ bản duy nhất trong bộ nhớ.
//  - inbound lên GHL dùng type:"Custom" (tài liệu ghi "SMS" là sai), altId để chống trùng.
//  - Zalo bắn `oa_send_text` cho CẢ tin nhân viên gõ trên Web OA LẪN tin do chính API mình gửi; chỉ tin Web OA
//    mới có `sender.admin_id` → lọc theo đó để không bị bong bóng trùng.
//  - Webhook luôn trả 200 (Zalo chỉ cần vậy để chấp nhận URL); chữ ký chỉ quyết định có XỬ LÝ hay không.
//  - Mọi nhánh bỏ qua đều ghi log — không để "im lặng bỏ qua" che lỗi.
import fs from "fs";
import crypto from "crypto";
import { platformQuery } from "./db.mjs";
import { encryptCredential, decryptCredential } from "./credential-crypto.mjs";
import { publicBaseUrl } from "./marketplace-apps.mjs";
import { getAppLocationToken } from "./ghl-apps.mjs";

const ENV_PATH = new URL("./.env", import.meta.url);
const env = {
  ...(fs.existsSync(ENV_PATH)
    ? Object.fromEntries(fs.readFileSync(ENV_PATH, "utf8").split("\n").filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; }))
    : {}),
  ...process.env,
};
// CENTER_-prefixed ưu tiên trước — xem ghi chú tương tự trong oauth-onboarding.mjs.
if (env.CENTER_TENANT_CREDENTIAL_ENCRYPTION_KEY) env.TENANT_CREDENTIAL_ENCRYPTION_KEY = env.CENTER_TENANT_CREDENTIAL_ENCRYPTION_KEY;
const GHL = "https://services.leadconnectorhq.com";
const ZALO_OAUTH = "https://oauth.zaloapp.com/v4/oa";
const ZALO_API = "https://openapi.zalo.me";
const WINDOW_MS = 7 * 86400_000; // cửa sổ "tin tư vấn" 7 ngày

// App Zalo dùng chung của nền tảng. Một tenant có app Zalo riêng (ví dụ có Mini App riêng) thì ghi đè bằng
// cred.app_id / cred.app_secret / cred.webhook_secret trong credential mã hoá của chính tenant đó.
const platformApp = () => ({ appId: env.ZALO_APP_ID || "", appSecret: env.ZALO_APP_SECRET || "", webhookSecret: env.ZALO_OA_WEBHOOK_SECRET || "" });
const appOf = (cred) => { const p = platformApp(); return { appId: cred.app_id || p.appId, appSecret: cred.app_secret || p.appSecret, webhookSecret: cred.webhook_secret || p.webhookSecret }; };
export const zaloConfigured = () => Boolean(platformApp().appId && platformApp().appSecret);

// App Zalo RIÊNG của 1 khách (ví dụ khách có Mini App: Mini App và OA phải đi qua cùng 1 app Zalo, giống 123 GYM).
// Lưu trước khi kết nối OA (nên không thể nằm trong credential của kết nối — lúc đó chưa có). Khách nào không
// có cấu hình riêng thì dùng app chung của nền tảng.
export async function setTenantZaloApp(locationId, { appId, appSecret, webhookSecret }) {
  if (!locationId || !appId || !appSecret) throw new Error("Cần locationId, appId, appSecret");
  await q(
    `insert into platform.zalo_app_configs (location_id, encrypted_config) values ($1,$2)
     on conflict (location_id) do update set encrypted_config = excluded.encrypted_config, updated_at = now()`,
    [locationId, encryptCredential({ app_id: String(appId), app_secret: appSecret, webhook_secret: webhookSecret || "" })]
  );
}
export async function clearTenantZaloApp(locationId) { await q("delete from platform.zalo_app_configs where location_id=$1", [locationId]); }
async function appForLocation(locationId) {
  const r = (await q("select encrypted_config from platform.zalo_app_configs where location_id=$1", [locationId])).rows[0];
  if (r) { const c = decryptCredential(r.encrypted_config); return { appId: c.app_id, appSecret: c.app_secret, webhookSecret: c.webhook_secret, source: "tenant" }; }
  return { ...platformApp(), source: "platform" };
}
export const providerConfigured = () => Boolean(env.GHL_ZALO_CONVERSATION_PROVIDER_ID);

// --- Bảng ------------------------------------------------------------------------------------------------
let ready;
export function ensureZaloTables() {
  ready ||= (async () => {
    await platformQuery(`create table if not exists platform.zalo_connections (
      location_id text primary key,
      oa_id text unique,
      oa_name text,
      encrypted_credential bytea,
      status text not null default 'disconnected',
      last_error text,
      followers int,
      uid_field_id text,
      connected_at timestamptz,
      updated_at timestamptz not null default now()
    )`);
    await platformQuery(`create table if not exists platform.zalo_app_configs (
      location_id text primary key, encrypted_config bytea not null, updated_at timestamptz not null default now()
    )`);
    await platformQuery(`create table if not exists platform.zalo_oauth_states (
      state text primary key, location_id text not null, verifier text not null, created_at timestamptz not null default now()
    )`);
    await platformQuery(`create table if not exists platform.zalo_contacts (
      location_id text not null, zalo_uid text not null, ghl_contact_id text not null, name text,
      last_interaction_at timestamptz, created_at timestamptz not null default now(),
      primary key (location_id, zalo_uid)
    )`);
    await platformQuery("create index if not exists zalo_contacts_ghl on platform.zalo_contacts (location_id, ghl_contact_id)");
    await platformQuery(`create table if not exists platform.zalo_sync_log (
      id bigserial primary key, location_id text not null, at timestamptz not null default now(),
      direction text not null, kind text not null, status text not null, detail text,
      zalo_uid text, ghl_contact_id text, retry jsonb, resolved boolean not null default false
    )`);
    await platformQuery("create index if not exists zalo_sync_log_loc_at on platform.zalo_sync_log (location_id, at desc)");
  })();
  return ready;
}
const q = async (sql, params) => { await ensureZaloTables(); return platformQuery(sql, params); };

export async function logSync(locationId, { direction, kind, status, detail, uid, contactId, retry }) {
  try {
    await q(
      "insert into platform.zalo_sync_log (location_id, direction, kind, status, detail, zalo_uid, ghl_contact_id, retry) values ($1,$2,$3,$4,$5,$6,$7,$8)",
      [locationId, direction, kind, status, detail ? String(detail).slice(0, 500) : null, uid || null, contactId || null, retry ? JSON.stringify(retry) : null]
    );
  } catch (e) { console.error("[zalo-oa] không ghi được sync log:", e.message); }
  if (status !== "ok") console.error(`[zalo-oa] ${direction}/${kind} ${status} (${locationId}): ${detail || ""}`);
}

// --- Kết nối ---------------------------------------------------------------------------------------------
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function redirectUri() {
  return env.ZALO_REDIRECT_URI || `${publicBaseUrl()}/apps/zalo/zalo-callback`;
}

// Bước 1: dựng link trang cấp quyền của Zalo. `state` ngẫu nhiên, gắn với đúng 1 locationId + code_verifier
// (PKCE) lưu ở DB — callback tra ngược để biết đang kết nối cho trung tâm nào và chặn giả mạo/trộn trung tâm.
export async function buildConnectUrl(locationId) {
  const app = await appForLocation(locationId);
  if (!app.appId || !app.appSecret) throw new Error("Chưa cấu hình app Zalo cho trung tâm này (và server thiếu ZALO_APP_ID/ZALO_APP_SECRET dùng chung).");
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(24));
  await q("delete from platform.zalo_oauth_states where created_at < now() - interval '1 hour'");
  await q("insert into platform.zalo_oauth_states (state, location_id, verifier) values ($1,$2,$3)", [state, locationId, verifier]);
  const p = new URLSearchParams({ app_id: app.appId, redirect_uri: redirectUri(), code_challenge: challenge, code_challenge_method: "S256", state });
  return `${ZALO_OAUTH}/permission?${p.toString()}`;
}

async function zaloTokenCall(app, params) {
  const r = await fetch(`${ZALO_OAUTH}/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", secret_key: app.appSecret },
    body: new URLSearchParams({ app_id: app.appId, ...params }),
  });
  const body = await r.json().catch(() => ({}));
  if (!body.access_token) throw new Error(`Zalo từ chối token (${body.error_name || body.error || r.status}): ${body.error_description || body.message || ""}`.trim());
  return { access_token: body.access_token, refresh_token: body.refresh_token, expires_at: new Date(Date.now() + Number(body.expires_in || 3600) * 1000).toISOString() };
}

async function zaloGet(accessToken, path) {
  const r = await fetch(`${ZALO_API}${path}`, { headers: { access_token: accessToken } });
  const j = await r.json().catch(() => ({}));
  if (j.error && j.error !== 0) { const e = new Error(`Zalo ${path}: ${j.message || j.error}`); e.zaloErrorCode = j.error; throw e; }
  return j.data || j;
}

// Bước 2: Zalo gọi lại /zalo/callback?code&state(&oa_id) — đổi code lấy token, đọc thông tin OA, lưu mã hoá.
export async function handleConnectCallback({ code, state, oaIdFromQuery }) {
  const st = (await q("delete from platform.zalo_oauth_states where state = $1 returning location_id, verifier, created_at", [state || ""])).rows[0];
  if (!st || Date.now() - new Date(st.created_at).getTime() > 3600_000) throw new Error("Phiên kết nối đã hết hạn hoặc không hợp lệ — hãy bấm lại nút “Kết nối Zalo OA” từ trong app.");
  const locationId = st.location_id;
  const app = await appForLocation(locationId);
  const tokens = await zaloTokenCall(app, { code, grant_type: "authorization_code", code_verifier: st.verifier });
  const oa = await zaloGet(tokens.access_token, "/v2.0/oa/getoa");
  const oaId = String(oa.oa_id || oaIdFromQuery || "");
  if (!oaId) throw new Error("Zalo không trả về mã OA — thử kết nối lại.");
  const owner = (await q("select location_id from platform.zalo_connections where oa_id = $1 and status = 'connected'", [oaId])).rows[0];
  if (owner && owner.location_id !== locationId) throw new Error("OA này đang được kết nối với trung tâm khác. Ngắt kết nối bên đó trước, hoặc liên hệ quản trị.");
  await q(
    `insert into platform.zalo_connections (location_id, oa_id, oa_name, encrypted_credential, status, last_error, followers, connected_at, updated_at)
     values ($1,$2,$3,$4,'connected',null,$5,now(),now())
     on conflict (location_id) do update set oa_id=excluded.oa_id, oa_name=excluded.oa_name, encrypted_credential=excluded.encrypted_credential,
       status='connected', last_error=null, followers=excluded.followers, connected_at=now(), updated_at=now()`,
    [locationId, oaId, oa.name || null, encryptCredential(app.source === "tenant" ? { ...tokens, app_id: app.appId, app_secret: app.appSecret, webhook_secret: app.webhookSecret } : tokens), Number(oa.num_follower ?? oa.followers) || null]
  );
  await logSync(locationId, { direction: "system", kind: "connect", status: "ok", detail: `Đã kết nối OA ${oa.name || oaId}` });
  // Chờ tạo trường "Zalo UID" (vài trăm ms) thay vì chạy ngầm: chạy ngầm sau khi trang đã trả về có thể bị rơi, không ai biết.
  await ensureUidField(locationId).catch((e) => logSync(locationId, { direction: "system", kind: "uid_field", status: "failed", detail: e.message }));
  return { locationId, oaId, oaName: oa.name || null };
}

export async function disconnect(locationId) {
  await q("update platform.zalo_connections set status='disconnected', encrypted_credential=null, last_error=null, updated_at=now() where location_id=$1", [locationId]);
  inflight.delete(locationId); cache.delete(locationId);
  await logSync(locationId, { direction: "system", kind: "disconnect", status: "ok", detail: "Đã ngắt kết nối Zalo OA" });
}

export async function getConnection(locationId) {
  const r = await q("select location_id, oa_id, oa_name, status, last_error, followers, uid_field_id, connected_at, encrypted_credential is not null as has_cred from platform.zalo_connections where location_id=$1", [locationId]);
  return r.rows[0] || null;
}
export async function getConnectionByOa(oaId) {
  const r = await q("select location_id, oa_id, status, encrypted_credential from platform.zalo_connections where oa_id=$1 and status='connected'", [String(oaId)]);
  return r.rows[0] || null;
}

// --- Token OA (xoay refresh_token — lưu bản mới TRƯỚC khi dùng) ---------------------------------------------
const cache = new Map(); // locationId -> credential
const inflight = new Map();
async function persistCred(locationId, cred) {
  let last;
  for (let i = 0; i < 3; i++) {
    try { await q("update platform.zalo_connections set encrypted_credential=$2, updated_at=now() where location_id=$1", [locationId, encryptCredential(cred)]); return; }
    catch (e) { last = e; await new Promise((r) => setTimeout(r, 300 * (i + 1))); }
  }
  throw last;
}
async function markError(locationId, msg) {
  await q("update platform.zalo_connections set status='error', last_error=$2, updated_at=now() where location_id=$1", [locationId, String(msg).slice(0, 300)]).catch(() => {});
}
export async function getOaAccessToken(locationId) {
  let cred = cache.get(locationId);
  if (!cred) {
    const row = (await q("select encrypted_credential, status from platform.zalo_connections where location_id=$1", [locationId])).rows[0];
    if (!row?.encrypted_credential) throw new Error("Trung tâm này chưa kết nối Zalo OA.");
    cred = decryptCredential(row.encrypted_credential);
    cache.set(locationId, cred);
  }
  if (new Date(cred.expires_at).getTime() > Date.now() + 120_000) return cred.access_token;
  if (inflight.has(locationId)) return inflight.get(locationId);
  const p = (async () => {
    try {
      const fresh = await zaloTokenCall(appOf(cred), { grant_type: "refresh_token", refresh_token: cred.refresh_token });
      const next = { ...cred, ...fresh, refresh_token: fresh.refresh_token || cred.refresh_token };
      cache.set(locationId, next); // cache TRƯỚC persist: refresh_token cũ đã chết
      await persistCred(locationId, next);
      return next.access_token;
    } catch (e) {
      cache.delete(locationId);
      await markError(locationId, `Cần kết nối lại Zalo OA: ${e.message}`);
      throw e;
    }
  })().finally(() => inflight.delete(locationId));
  inflight.set(locationId, p);
  return p;
}

// --- GHL -------------------------------------------------------------------------------------------------
async function ghlFetch(locationId, method, path, body, version = "2021-07-28") {
  const token = await getAppLocationToken("zalo", locationId);
  const r = await fetch(GHL + path, { method, headers: { Authorization: `Bearer ${token}`, Version: version, "Content-Type": "application/json", Accept: "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j; try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
  if (!r.ok) { const e = new Error(`GHL ${method} ${path.split("?")[0]} -> ${r.status} ${text.slice(0, 200)}`); e.status = r.status; throw e; }
  return j;
}

// Tạo (nếu chưa có) custom field "Zalo UID" trên sub-account để nhân viên thấy UID ngay trong hồ sơ contact
// và workflow dùng được. Thiếu quyền → ghi log, không làm hỏng việc kết nối.
export async function ensureUidField(locationId) {
  const j = await ghlFetch(locationId, "GET", `/locations/${locationId}/customFields?model=contact`);
  let f = (j.customFields || []).find((x) => x.fieldKey === "contact.zalo_uid" || /^zalo uid$/i.test(x.name || ""));
  if (!f) {
    const c = await ghlFetch(locationId, "POST", `/locations/${locationId}/customFields`, { name: "Zalo UID", dataType: "TEXT", model: "contact" });
    f = c.customField || c;
  }
  if (f?.id) await q("update platform.zalo_connections set uid_field_id=$2 where location_id=$1", [locationId, f.id]);
  return f?.id || null;
}

// --- Khớp Zalo UID <-> contact GHL -------------------------------------------------------------------------
const toE164 = (p) => { const d = String(p || "").replace(/\D/g, ""); return !d ? "" : d.startsWith("84") ? `+${d}` : d.startsWith("0") ? `+84${d.slice(1)}` : `+${d}`; };
const splitName = (name, uid) => {
  // GHL từ chối contact không có email/SĐT/firstName/lastName — trường `name` đơn lẻ KHÔNG được tính (HTTP 422).
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  return { firstName: parts.length > 1 ? parts.slice(0, -1).join(" ") : parts[0] || "Zalo", lastName: parts.length > 1 ? parts.at(-1) : parts.length ? "" : String(uid).slice(-6) };
};

async function findContactByPhone(locationId, phone) {
  const num = toE164(phone);
  if (!num) return null;
  try { const dup = await ghlFetch(locationId, "GET", `/contacts/search/duplicate?locationId=${locationId}&number=${encodeURIComponent(num)}`); return dup.contact?.id || null; }
  catch { return null; } // không có thì coi như chưa có
}

// Connection kèm trường "Zalo UID" — tạo bù ngay nếu thiếu (bước tạo lúc kết nối từng bị rơi), để contact không thiếu UID.
async function connWithUidField(locationId) {
  let conn = await getConnection(locationId);
  if (conn && !conn.uid_field_id) {
    const id = await ensureUidField(locationId).catch((e) => { logSync(locationId, { direction: "system", kind: "uid_field", status: "failed", detail: e.message }); return null; });
    if (id) conn = { ...conn, uid_field_id: id };
  }
  return conn;
}
async function writeUidField(locationId, contactId, uid, conn) {
  if (!conn?.uid_field_id) return;
  await ghlFetch(locationId, "PUT", `/contacts/${contactId}`, { customFields: [{ id: conn.uid_field_id, field_value: uid }] }).catch((e) => logSync(locationId, { direction: "system", kind: "uid_field", status: "failed", detail: `Không ghi được Zalo UID vào contact ${contactId}: ${e.message}`, uid, contactId }));
}
const saveMapping = (locationId, uid, contactId, name) => q(
  "insert into platform.zalo_contacts (location_id, zalo_uid, ghl_contact_id, name) values ($1,$2,$3,$4) on conflict (location_id, zalo_uid) do update set ghl_contact_id=excluded.ghl_contact_id, name=coalesce(excluded.name, platform.zalo_contacts.name)",
  [locationId, uid, contactId, name || null]);

async function readProfile(locationId, uid, { quiet } = {}) {
  try {
    const d = await zaloGet(await getOaAccessToken(locationId), `/v3.0/oa/user/detail?data=${encodeURIComponent(JSON.stringify({ user_id: uid }))}`);
    return { name: d.display_name || d.user_alias || null, phone: d.shared_info?.phone || d.phone || null };
  } catch (e) {
    if (!quiet) await logSync(locationId, { direction: "in", kind: "profile", status: "skipped", detail: `Không đọc được hồ sơ Zalo ${uid}: ${e.message}`, uid });
    return null;
  }
}

// Contact đã tạo lúc chưa đọc được hồ sơ (OA gói thấp / app chưa đăng ký API) mang tên tạm — thử lại khi khách nhắn tiếp
// (tối đa 1 lần/giờ/khách) và đổi tên + SĐT trên GHL khi đọc được.
const profileTried = new Map();
async function refreshProfile(locationId, uid, contactId) {
  const k = `${locationId}|${uid}`;
  if (Date.now() - (profileTried.get(k) || 0) < 3600_000) return;
  profileTried.set(k, Date.now());
  const prof = await readProfile(locationId, uid, { quiet: true });
  if (!prof?.name) return;
  const body = { ...splitName(prof.name, uid) };
  if (!body.lastName) delete body.lastName;
  if (prof.phone) body.phone = toE164(prof.phone);
  await ghlFetch(locationId, "PUT", `/contacts/${contactId}`, body).catch((e) => logSync(locationId, { direction: "system", kind: "profile", status: "failed", detail: `Không cập nhật được tên contact: ${e.message}`, uid, contactId }));
  await q("update platform.zalo_contacts set name=$3 where location_id=$1 and zalo_uid=$2", [locationId, uid, prof.name]);
  await logSync(locationId, { direction: "in", kind: "profile", status: "ok", detail: "Đã cập nhật tên khách từ hồ sơ Zalo", uid, contactId });
}

// Bù tên cho TẤT CẢ contact Zalo đang mang tên tạm của 1 trung tâm (chạy 1 lần sau khi app được Zalo duyệt API đọc hồ sơ).
export async function backfillPlaceholderNames(locationId) {
  const rows = (await q("select zalo_uid, ghl_contact_id from platform.zalo_contacts where location_id=$1 and name is null", [locationId])).rows;
  let updated = 0;
  for (const r of rows) {
    await refreshProfile(locationId, r.zalo_uid, r.ghl_contact_id).catch(() => {});
    const after = (await q("select name from platform.zalo_contacts where location_id=$1 and zalo_uid=$2", [locationId, r.zalo_uid])).rows[0];
    if (after?.name) updated++;
    await new Promise((res) => setTimeout(res, 300));
  }
  return { checked: rows.length, updated };
}

// Khi khách bấm thẻ "chia sẻ thông tin", sự kiện `user_submit_info` KHÔNG tới webhook đặt ngoài Việt Nam (đã kiểm chứng ở OA EIM
// 2026-10-17: nhật ký không có sự kiện nào), nhưng Zalo gửi kèm 1 TIN NHẮN THƯỜNG "Bạn đã gửi thông tin cho OA …: Họ Tên / Số điện
// thoại / Địa chỉ" (tới bình thường) và hồ sơ khách (`user/detail`) trả `shared_info.phone` đầy đủ — nên lấy SĐT từ hồ sơ, không
// được thì đọc thẳng từ tin nhắn đó, rồi khớp với contact như `user_submit_info`.
const SHARED_INFO_TEXT = /^\s*Bạn đã gửi thông tin cho OA/i;
async function syncPhoneAfterShare(locationId, uid, text) {
  const prof = await readProfile(locationId, uid, { quiet: true });
  let phone = prof?.phone, name = prof?.name;
  if (!phone) {
    phone = (String(text).match(/Số điện thoại:\s*([+\d][\d\s.-]{7,})/i) || [])[1];
    name = name || (String(text).match(/Họ Tên:\s*(.+)/i) || [])[1]?.trim();
  }
  if (!phone) { await logSync(locationId, { direction: "in", kind: "user_submit_info", status: "skipped", detail: "Khách đã chia sẻ thông tin nhưng không đọc được số điện thoại", uid }); return; }
  const { contactId, hint } = await linkUidByPhone(locationId, uid, phone, name);
  await logSync(locationId, { direction: "in", kind: "user_submit_info", status: "ok", detail: hint || "Đã khớp SĐT khách chia sẻ với contact và gắn Zalo UID", uid, contactId });
}

// Tìm hoặc tạo contact GHL cho 1 Zalo UID. Thứ tự: bảng ánh xạ → (nếu Zalo cho SĐT) trùng SĐT → tạo mới.
export async function resolveContact(locationId, uid, hintName) {
  const m = (await q("select ghl_contact_id, name from platform.zalo_contacts where location_id=$1 and zalo_uid=$2", [locationId, uid])).rows[0];
  if (m) {
    if (!m.name) await refreshProfile(locationId, uid, m.ghl_contact_id).catch(() => {});
    return m.ghl_contact_id;
  }
  const prof = await readProfile(locationId, uid);
  const name = prof?.name || hintName;
  let contactId = prof?.phone ? await findContactByPhone(locationId, prof.phone) : null;
  const conn = await connWithUidField(locationId);
  if (!contactId) {
    const body = { locationId, ...splitName(name, uid), source: "Zalo OA", tags: ["zalo-oa"] };
    if (!body.lastName) delete body.lastName;
    if (prof?.phone) body.phone = toE164(prof.phone);
    if (conn?.uid_field_id) body.customFields = [{ id: conn.uid_field_id, field_value: uid }];
    const c = await ghlFetch(locationId, "POST", "/contacts/", body);
    contactId = c.contact?.id || c.id;
  } else await writeUidField(locationId, contactId, uid, conn);
  if (!contactId) throw new Error("GHL không trả về contact id khi tạo contact từ Zalo.");
  await saveMapping(locationId, uid, contactId, name);
  return contactId;
}

// Khách bấm thẻ "chia sẻ số điện thoại" (user_submit_info): có UID + SĐT trong cùng 1 sự kiện → gắn UID vào ĐÚNG contact có
// SĐT đó (nhân viên đã tạo từ trước), thay vì để 1 contact tạm. Nếu khách đã có contact tạm từ trước thì chuyển ánh xạ sang
// contact thật và ghi log để nhân viên gộp contact tạm (GHL có sẵn chức năng gộp).
export async function linkUidByPhone(locationId, uid, phone, name) {
  const conn = await connWithUidField(locationId);
  const existing = (await q("select ghl_contact_id from platform.zalo_contacts where location_id=$1 and zalo_uid=$2", [locationId, uid])).rows[0];
  let contactId = await findContactByPhone(locationId, phone);
  let hint;
  if (contactId) {
    if (existing && existing.ghl_contact_id !== contactId) hint = `Khách đã có contact tạm ${existing.ghl_contact_id} — hãy gộp vào contact ${contactId}`;
    await writeUidField(locationId, contactId, uid, conn);
  } else if (existing) {
    contactId = existing.ghl_contact_id; // chưa có contact nào theo SĐT này: dùng contact Zalo hiện có, bổ sung SĐT
    await ghlFetch(locationId, "PUT", `/contacts/${contactId}`, { phone: toE164(phone) }).catch((e) => logSync(locationId, { direction: "system", kind: "profile", status: "failed", detail: `Không bổ sung được SĐT cho contact ${contactId}: ${e.message}`, uid, contactId }));
  } else {
    const body = { locationId, ...splitName(name, uid), phone: toE164(phone), source: "Zalo OA", tags: ["zalo-oa"] };
    if (!body.lastName) delete body.lastName;
    if (conn?.uid_field_id) body.customFields = [{ id: conn.uid_field_id, field_value: uid }];
    const c = await ghlFetch(locationId, "POST", "/contacts/", body);
    contactId = c.contact?.id || c.id;
  }
  if (!contactId) throw new Error("GHL không trả về contact id khi khớp SĐT từ Zalo.");
  await saveMapping(locationId, uid, contactId, name);
  return { contactId, hint };
}

// Đẩy 1 tin vào Conversations. Mất kết nối GHL / provider chưa cấu hình → lỗi rõ ràng (được log + có nút gửi lại).
export async function pushToConversation(locationId, { contactId, message, altId, direction = "inbound", attachments, fallbackMessage }) {
  if (!providerConfigured()) throw new Error("Thiếu GHL_ZALO_CONVERSATION_PROVIDER_ID trên server.");
  const base = { type: "Custom", conversationProviderId: env.GHL_ZALO_CONVERSATION_PROVIDER_ID, contactId, direction, altId };
  const send = (extra) => ghlFetch(locationId, "POST", "/conversations/messages/inbound", { ...base, ...extra }, "2021-04-15");
  if (attachments?.length) {
    try { return await send({ ...(message ? { message } : {}), attachments }); }
    catch (e) { if (e.status !== 400) throw e; return send({ message: fallbackMessage ?? message ?? "(tệp đính kèm)" }); }
  }
  return send({ message });
}

// --- Chiều Zalo -> GHL (webhook của Zalo) ------------------------------------------------------------------
const MEDIA_LABELS = { user_send_image: "🖼️ Ảnh", user_send_gif: "🎞️ GIF", user_send_sticker: "😀 Sticker", user_send_file: "📎 Tệp", user_send_audio: "🎤 Tin nhắn thoại", user_send_location: "📍 Vị trí", user_send_video: "🎬 Video", user_send_link: "🔗 Liên kết" };
function collectUrls(v, out = []) {
  if (typeof v === "string") { if (/^https?:\/\//i.test(v)) out.push(v); }
  else if (Array.isArray(v)) v.forEach((x) => collectUrls(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => collectUrls(x, out));
  return out;
}
const oaIdOf = (p) => String(p.oa_id || (String(p.event_name || "").startsWith("user_") ? p.recipient?.id : p.sender?.id) || "");

function validSignature(app, rawBody, timestamp, signature, payload) {
  if (!signature || !timestamp || !app.webhookSecret) return false;
  const expected = crypto.createHash("sha256").update(`${payload.app_id}${rawBody}${timestamp}${app.webhookSecret}`).digest("hex");
  const got = signature.startsWith("mac=") ? signature.slice(4) : signature;
  return expected.length === got.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got));
}

// Trả luôn về sớm — route đã trả 200 cho Zalo; hàm này chạy phần xử lý thật, tự bắt mọi lỗi.
export async function handleZaloWebhook({ payload, rawBody, headers }) {
  const oaId = oaIdOf(payload);
  const conn = oaId ? await getConnectionByOa(oaId) : null;
  if (!conn) { console.log(`[zalo-oa] sự kiện ${payload.event_name} cho OA ${oaId || "?"} — chưa có trung tâm nào kết nối OA này, bỏ qua`); return; }
  const locationId = conn.location_id;
  const cred = decryptCredential(conn.encrypted_credential);
  const timestamp = headers["x-zevent-timestamp"] || payload.timestamp;
  if (!validSignature(appOf(cred), rawBody, timestamp, headers["x-zevent-signature"], payload)) {
    await logSync(locationId, { direction: "in", kind: payload.event_name || "?", status: "skipped", detail: "Chữ ký webhook không hợp lệ (kiểm tra ZALO_OA_WEBHOOK_SECRET)" });
    return;
  }
  try { await processEvent(locationId, payload); }
  catch (e) {
    const ev = payload.event_name || "?";
    // Sự kiện tin nhắn lỗi giữa chừng (vd GHL từ chối tạo contact) → giữ lại payload để nhân viên bấm "Gửi lại" sau khi sửa nguyên nhân.
    await logSync(locationId, { direction: "in", kind: ev, status: "failed", detail: e.message, retry: String(ev).startsWith("user_send_") || ev === "oa_send_text" ? { type: "event", payload } : undefined });
  }
}

// Xử lý 1 sự kiện Zalo đã được xác thực. Ném lỗi nếu hỏng giữa chừng (nơi gọi quyết định log/retry); riêng lỗi đẩy vào
// Conversations tự log + có retry kiểu "push".
async function processEvent(locationId, payload) {
  const ev = payload.event_name;
  {
    if (ev === "follow") {
      // Khách follow OA → đồng bộ UID ngay (tạo contact kèm UID, hoặc khớp theo SĐT nếu Zalo cho đọc), không đợi tin nhắn đầu tiên.
      const uid = payload.follower?.id;
      if (!uid) { await logSync(locationId, { direction: "in", kind: "follow", status: "skipped", detail: "Thiếu UID người theo dõi trong payload" }); return; }
      const contactId = await resolveContact(locationId, uid);
      await logSync(locationId, { direction: "in", kind: "follow", status: "ok", detail: "Đã đồng bộ Zalo UID vào contact", uid, contactId });
      return;
    }
    if (ev === "user_submit_info") {
      const uid = payload.sender?.id, info = payload.info || {};
      if (!uid || !info.phone) { await logSync(locationId, { direction: "in", kind: "user_submit_info", status: "skipped", detail: "Thiếu UID hoặc SĐT trong thông tin khách chia sẻ" }); return; }
      const { contactId, hint } = await linkUidByPhone(locationId, uid, info.phone, info.name);
      await q("update platform.zalo_contacts set last_interaction_at=now() where location_id=$1 and zalo_uid=$2", [locationId, uid]); // thẻ này mở cửa sổ tin tư vấn 7 ngày
      await logSync(locationId, { direction: "in", kind: "user_submit_info", status: "ok", detail: hint || "Đã khớp SĐT khách chia sẻ với contact và gắn Zalo UID", uid, contactId });
      return;
    }
    if (ev === "unfollow") { await logSync(locationId, { direction: "in", kind: "unfollow", status: "ok", uid: payload.follower?.id }); return; }

    let uid, direction, label;
    if (ev.startsWith("user_send_")) { uid = payload.sender?.id; direction = "inbound"; }
    else if (ev === "oa_send_text" && payload.sender?.admin_id) { uid = payload.recipient?.id; direction = "outbound"; } // chỉ tin gõ tay trên Web OA
    else return; // delivery receipt, tin do chính API mình gửi, các sự kiện khác

    if (!uid) { await logSync(locationId, { direction: "in", kind: ev, status: "skipped", detail: "Thiếu UID người gửi/nhận trong payload" }); return; }
    const contactId = await resolveContact(locationId, uid);
    if (direction === "inbound") await q("update platform.zalo_contacts set last_interaction_at=now() where location_id=$1 and zalo_uid=$2", [locationId, uid]);
    const msgId = payload.message?.msg_id || `${ev}_${payload.timestamp}`;
    const altId = `zalo_${msgId}`;
    let params;
    if (ev === "user_send_text" || ev === "oa_send_text") params = { message: payload.message?.text || "" };
    else {
      label = MEDIA_LABELS[ev] || `Tin nhắn (${ev})`;
      const urls = [...new Set(collectUrls(payload.message?.attachments ?? payload.message))];
      const caption = payload.message?.text ? ` ${payload.message.text}` : "";
      params = urls.length
        ? { message: payload.message?.text || undefined, attachments: urls, fallbackMessage: `${label}${caption}\n${urls.join("\n")}` }
        : { message: `${label}${caption}` };
    }
    const push = { contactId, altId, direction, ...params };
    try {
      await pushToConversation(locationId, push);
      await logSync(locationId, { direction: "in", kind: ev, status: "ok", uid, contactId });
    } catch (e) {
      await logSync(locationId, { direction: "in", kind: ev, status: "failed", detail: e.message, uid, contactId, retry: { type: "push", push } });
    }
    if (ev === "user_send_text" && SHARED_INFO_TEXT.test(payload.message?.text || "")) {
      await syncPhoneAfterShare(locationId, uid, payload.message.text).catch((e) => logSync(locationId, { direction: "in", kind: "user_submit_info", status: "failed", detail: e.message, uid }));
    }
  }
}

// --- Chiều GHL -> Zalo (webhook Delivery URL của Conversation Provider) ----------------------------------------
const GHL_ED25519_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=
-----END PUBLIC KEY-----`;
export function validGhlSignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  try { return crypto.verify(null, Buffer.from(rawBody, "utf8"), GHL_ED25519_PUBLIC_KEY, Buffer.from(signatureHeader, "base64")); }
  catch { return false; }
}

async function zaloSendCs(locationId, uid, { text, imageUrl }) {
  const token = await getOaAccessToken(locationId);
  const message = imageUrl
    ? { attachment: { type: "template", payload: { template_type: "media", elements: [{ media_type: "image", url: imageUrl }] } } }
    : { text };
  const r = await fetch(`${ZALO_API}/v3.0/oa/message/cs`, { method: "POST", headers: { access_token: token, "Content-Type": "application/json" }, body: JSON.stringify({ recipient: { user_id: uid }, message }) });
  const j = await r.json().catch(() => ({}));
  if (j.error && j.error !== 0) { const e = new Error(`Zalo ${j.error}: ${j.message || ""}`); e.zaloErrorCode = j.error; throw e; }
  return j;
}
// Mã lỗi Zalo thường gặp, dịch ra tiếng người để nhân viên hiểu ngay (-232: ngoài cửa sổ 7 ngày).
const humanZaloError = (e) => e.zaloErrorCode === -232 ? "Ngoài cửa sổ 7 ngày kể từ lần khách nhắn gần nhất — Zalo không cho gửi tin tư vấn (dùng ZNS)." : e.message;

// Gửi thẻ "chia sẻ số điện thoại" (request_user_info) cho 1 khách — khách bấm thì Zalo bắn sự kiện `user_submit_info`
// (UID + SĐT) về webhook. Miễn phí trong khung tin tư vấn; ảnh thẻ mặc định lấy từ ảnh đại diện của chính OA.
export async function sendRequestInfoCard(locationId, uid, { title, subtitle, imageUrl } = {}) {
  const token = await getOaAccessToken(locationId);
  const oa = await zaloGet(token, "/v2.0/oa/getoa").catch(() => ({}));
  const el = { title: title || oa.name || "Chia sẻ thông tin", subtitle: subtitle || "Chia sẻ số điện thoại để được hỗ trợ và nhận thông báo nhanh hơn.", image_url: imageUrl || oa.avatar || oa.cover };
  const r = await fetch(`${ZALO_API}/v3.0/oa/message/cs`, { method: "POST", headers: { access_token: token, "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { user_id: uid }, message: { attachment: { type: "template", payload: { template_type: "request_user_info", elements: [el] } } } }) });
  const j = await r.json().catch(() => ({}));
  if (j.error && j.error !== 0) { const e = new Error(`Zalo ${j.error}: ${j.message || ""}`); e.zaloErrorCode = j.error; throw e; }
  await logSync(locationId, { direction: "out", kind: "request_info", status: "ok", detail: "Đã gửi thẻ xin số điện thoại", uid });
  return j;
}

export async function sendToZalo(locationId, uid, { text, attachments = [] }) {
  for (const url of attachments) await zaloSendCs(locationId, uid, { imageUrl: url });
  if (text) await zaloSendCs(locationId, uid, { text });
}

export async function handleGhlOutbound(body) {
  const locationId = body.locationId;
  const contactId = body.contactId;
  const text = body.message || body.body || "";
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  if (!locationId || !contactId || (!text && !attachments.length)) { console.error("[zalo-oa] outbound thiếu locationId/contactId/nội dung:", JSON.stringify(body).slice(0, 300)); return; }
  const conn = await getConnection(locationId);
  if (!conn || conn.status === "disconnected") { await logSync(locationId, { direction: "out", kind: "ghl_reply", status: "skipped", detail: "Trung tâm chưa kết nối Zalo OA", contactId }); return; }
  const m = (await q("select zalo_uid from platform.zalo_contacts where location_id=$1 and ghl_contact_id=$2 order by last_interaction_at desc nulls last limit 1", [locationId, contactId])).rows[0];
  let uid = m?.zalo_uid;
  if (!uid && conn.uid_field_id) {
    try {
      const c = await ghlFetch(locationId, "GET", `/contacts/${contactId}`);
      uid = (c.contact?.customFields || []).find((f) => f.id === conn.uid_field_id)?.value;
    } catch { /* xử lý ở dưới */ }
  }
  if (!uid) { await logSync(locationId, { direction: "out", kind: "ghl_reply", status: "failed", detail: "Contact này chưa có Zalo UID — không gửi được", contactId }); return; }
  try {
    await sendToZalo(locationId, uid, { text, attachments });
    await logSync(locationId, { direction: "out", kind: "ghl_reply", status: "ok", uid, contactId });
  } catch (e) {
    await logSync(locationId, { direction: "out", kind: "ghl_reply", status: "failed", detail: humanZaloError(e), uid, contactId, retry: { type: "send", uid, text, attachments } });
  }
}


// --- ZNS: GHL Workflow (Webhook action) -> gửi thông báo theo mẫu qua OA của trung tâm ---------------------------
// Mỗi trung tâm có 1 URL riêng (kèm khoá dẫn xuất từ locationId bằng HMAC — không cần lưu DB, không đoán được). Admin lấy
// URL này trên Custom Page rồi dán vào Webhook action của Workflow. Mẫu ZNS do từng OA tự đăng ký và được Zalo duyệt.
const znsSecret = () => env.ZALO_ZNS_KEY_SECRET || env.TENANT_CREDENTIAL_ENCRYPTION_KEY || "";
export const znsKey = (locationId) => crypto.createHmac("sha256", znsSecret()).update(`zns:${locationId}`).digest("hex").slice(0, 32);
export const znsKeyValid = (locationId, k) => { try { const a = Buffer.from(znsKey(locationId)), b = Buffer.from(String(k || "")); return a.length === b.length && crypto.timingSafeEqual(a, b); } catch { return false; } };
export const znsWebhookUrl = (locationId) => `${publicBaseUrl()}/apps/zalo/webhooks/zns?loc=${encodeURIComponent(locationId)}&k=${znsKey(locationId)}`;

const ZNS_ERRORS = { "-108": "Số điện thoại sai định dạng", "-109": "Mẫu ZNS sai hoặc chưa được duyệt", "-131": "Mẫu ZNS sai hoặc chưa được duyệt", "-110": "Zalo của người nhận quá cũ, không nhận được ZNS", "-115": "Hết hạn mức hoặc số dư ZNS của OA", "-118": "Tài khoản Zalo không tồn tại hoặc không nhận được tin", "-119": "Tài khoản Zalo không tồn tại hoặc không nhận được tin", "-114": "Người nhận từ chối nhận tin hoặc đang dùng Zalo bản cũ" };
const znsErrText = (e) => ZNS_ERRORS[String(e.zaloErrorCode)] ? `${ZNS_ERRORS[String(e.zaloErrorCode)]} (mã ${e.zaloErrorCode})` : e.message;
const toZaloPhone = (p) => { const d = String(p || "").replace(/\D/g, ""); return !d ? "" : d.startsWith("84") ? d : d.startsWith("0") ? `84${d.slice(1)}` : d; };
const maskPhone = (p) => (p ? `***${String(p).slice(-3)}` : "");

async function postZalo(url, token, body) {
  const r = await fetch(url, { method: "POST", headers: { access_token: token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (j.error && j.error !== 0) { const e = new Error(`Zalo ${j.error}: ${j.message || ""}`); e.zaloErrorCode = j.error; throw e; }
  return j;
}

// Nhận payload của Webhook action trong GHL: contact_id/phone/location phẳng ở gốc, dữ liệu mình truyền nằm ở `customData`
// (hoặc gốc nếu workflow đặt phẳng). Trả { http, body } để route trả đúng mã cho GHL: 200 (xong hoặc lỗi vĩnh viễn — thử lại
// vô ích), 502 (lỗi mạng/tạm thời — GHL tự thử lại).
export async function handleZnsWebhook(locationId, payload) {
  const cd = payload.customData || {};
  const pick = (...k) => { for (const x of k) { const v = cd[x] ?? payload[x]; if (v !== undefined && v !== null && v !== "") return v; } };
  const templateId = String(pick("template_id", "templateId") || "");
  let data = pick("template_data", "templateData", "params");
  if (typeof data === "string") { try { data = JSON.parse(data); } catch { data = null; } }
  const contactId = pick("contact_id", "contactId");
  const sendBy = String(pick("send_by", "sendBy") || "phone").toLowerCase();
  if (!templateId || !data || typeof data !== "object") {
    await logSync(locationId, { direction: "out", kind: "zns", status: "failed", detail: "Thiếu template_id hoặc template_data (phải là JSON) trong Webhook action", contactId });
    return { http: 200, body: { ok: false, permanent: true, error: "Thiếu template_id hoặc template_data" } };
  }
  const conn = await getConnection(locationId);
  if (!conn || conn.status === "disconnected") {
    await logSync(locationId, { direction: "out", kind: "zns", status: "skipped", detail: "Trung tâm chưa kết nối Zalo OA", contactId });
    return { http: 200, body: { ok: false, permanent: true, error: "Chưa kết nối Zalo OA" } };
  }
  const phone = toZaloPhone(pick("phone", "number"));
  let uid = pick("zalo_uid", "uid");
  if (sendBy === "uid" && !uid && contactId) uid = (await q("select zalo_uid from platform.zalo_contacts where location_id=$1 and ghl_contact_id=$2 limit 1", [locationId, contactId])).rows[0]?.zalo_uid;
  if (sendBy === "uid" ? !uid : !phone) {
    await logSync(locationId, { direction: "out", kind: "zns", status: "failed", detail: sendBy === "uid" ? "Contact chưa có Zalo UID" : "Thiếu số điện thoại người nhận", contactId });
    return { http: 200, body: { ok: false, permanent: true, error: sendBy === "uid" ? "Chưa có Zalo UID" : "Thiếu số điện thoại" } };
  }
  const who = sendBy === "uid" ? `UID …${String(uid).slice(-4)}` : maskPhone(phone);
  try {
    const token = await getOaAccessToken(locationId);
    if (sendBy === "uid") await postZalo(`${ZALO_API}/v3.0/oa/message/template`, token, { user_id: uid, template_id: templateId, template_data: data });
    else await postZalo("https://business.openapi.zalo.me/message/template", token, { phone, template_id: templateId, template_data: data });
  } catch (e) {
    const permanent = e.zaloErrorCode != null; // Zalo đã trả mã lỗi cụ thể → thử lại vô ích; chỉ lỗi mạng mới có cơ hội tự khỏi
    await logSync(locationId, { direction: "out", kind: "zns", status: "failed", detail: `Mẫu ${templateId} → ${who}: ${znsErrText(e)}`, uid: uid || undefined, contactId });
    return { http: permanent ? 200 : 502, body: { ok: false, permanent, error: znsErrText(e) } };
  }
  await logSync(locationId, { direction: "out", kind: "zns", status: "ok", detail: `Mẫu ${templateId} → ${who}`, uid: uid || undefined, contactId });
  // Ghi ZNS vào Conversations của contact (best-effort — không làm hỏng việc đã gửi xong).
  try {
    const cid = contactId || (phone ? await findContactByPhone(locationId, phone) : null);
    if (cid && providerConfigured()) {
      const lines = Object.entries(data).map(([k, v]) => `${k}: ${v}`).join("\n");
      await pushToConversation(locationId, { contactId: cid, direction: "outbound", altId: `zns_${templateId}_${Date.now()}`, message: `📩 ZNS (mẫu ${templateId})\n${lines}` });
    }
  } catch (e) { await logSync(locationId, { direction: "out", kind: "zns", status: "skipped", detail: `Đã gửi ZNS nhưng chưa ghi được vào Conversations: ${e.message}`, contactId }); }
  return { http: 200, body: { ok: true } };
}

// --- Dashboard -------------------------------------------------------------------------------------------
export async function getStats(locationId) {
  const conn = await getConnection(locationId);
  const appSource = (await q("select 1 from platform.zalo_app_configs where location_id=$1", [locationId])).rowCount ? "tenant" : "platform";
  const day = async (days) => (await q(
    `select direction, status, count(*)::int n from platform.zalo_sync_log
     where location_id=$1 and at > now() - ($2 || ' days')::interval and direction in ('in','out') group by 1,2`, [locationId, String(days)])).rows;
  const fold = (rows) => { const o = { in: { ok: 0, failed: 0, skipped: 0 }, out: { ok: 0, failed: 0, skipped: 0 } }; for (const r of rows) o[r.direction][r.status] = r.n; return o; };
  const perDay = (await q(
    `select to_char(date_trunc('day', at at time zone 'Asia/Ho_Chi_Minh'), 'YYYY-MM-DD') d, direction, count(*)::int n
     from platform.zalo_sync_log where location_id=$1 and at > now() - interval '14 days' and direction in ('in','out') and status='ok' group by 1,2 order by 1`, [locationId])).rows;
  const contacts = (await q("select count(*)::int total, count(*) filter (where last_interaction_at > now() - interval '7 days')::int in_window from platform.zalo_contacts where location_id=$1", [locationId])).rows[0];
  const lastOk = (await q("select max(at) t from platform.zalo_sync_log where location_id=$1 and status='ok' and direction in ('in','out')", [locationId])).rows[0]?.t || null;
  const failedOpen = (await q("select count(*)::int n from platform.zalo_sync_log where location_id=$1 and status='failed' and resolved=false and retry is not null", [locationId])).rows[0].n;
  return {
    connection: conn && { oaId: conn.oa_id, oaName: conn.oa_name, status: conn.status, lastError: conn.last_error, followers: conn.followers, connectedAt: conn.connected_at, uidField: Boolean(conn.uid_field_id) },
    platform: { zaloConfigured: zaloConfigured() || appSource === "tenant", providerConfigured: providerConfigured() },
    appSource,
    last7: fold(await day(7)), last30: fold(await day(30)), perDay, contacts, lastOk, failedOpen,
  };
}
export async function getLogs(locationId, { status, limit = 50 } = {}) {
  const r = await q(
    `select id, at, direction, kind, status, detail, zalo_uid, ghl_contact_id, (retry is not null and not resolved) as can_retry
     from platform.zalo_sync_log where location_id=$1 ${status ? "and status=$3" : ""} order by at desc limit $2`,
    status ? [locationId, Math.min(limit, 200), status] : [locationId, Math.min(limit, 200)]);
  return r.rows;
}

// Gửi lại 1 mục thất bại (từ nút "Gửi lại" trên dashboard). Chỉ chạy được nếu mục còn dữ liệu retry và chưa xử lý.
export async function retryLog(locationId, id) {
  const row = (await q("select retry, resolved, zalo_uid, ghl_contact_id from platform.zalo_sync_log where id=$1 and location_id=$2", [id, locationId])).rows[0];
  if (!row?.retry || row.resolved) throw new Error("Mục này không còn gửi lại được.");
  const r = row.retry;
  if (r.type === "push") await pushToConversation(locationId, r.push);
  else if (r.type === "event") await processEvent(locationId, r.payload);
  else if (r.type === "send") await sendToZalo(locationId, r.uid, { text: r.text, attachments: r.attachments || [] });
  else throw new Error("Loại mục không hỗ trợ gửi lại.");
  await q("update platform.zalo_sync_log set resolved=true where id=$1", [id]);
  await logSync(locationId, { direction: r.type === "send" ? "out" : "in", kind: "retry", status: "ok", uid: row.zalo_uid, contactId: row.ghl_contact_id });
}
