// Luồng OAuth cài app (thay cho tạo PIT tay + 2 lệnh node): khách bấm Install trên subaccount của họ, GHL
// gọi lại /oauth/callback với ?code= — đổi code lấy token, tự tạo tenant nếu chưa có, đặt NGƯỜI VỪA CÀI làm
// admin đầu tiên (không cần ai gõ email tay), rồi dựng dữ liệu ban đầu từ Lớp/Học viên/Ghi danh đã có sẵn
// trên GHL của họ (nếu có — xem seedTenantFromGhl). Cài lại (đã có tenant) chỉ cập nhật token, không tạo
// trùng, không đổi schema/thương hiệu đã có.
//
// Tham khảo cách làm của "Uplifting Social AI" (`Documents/Claude/Projects/123gym-media-mcp`) — cùng mẫu
// exchangeHighLevelCode/fetchImpl-injectable để test được mà không cần gọi mạng thật.
import fs from "fs";
import { getTenantByLocation, ensureTenantSchema, upsertOAuthTenant, updateTenantCredential, addStaff, listTenants } from "./db.mjs";
import { encryptCredential } from "./credential-crypto.mjs";
import { seedTenantFromGhl } from "./ghl-write.mjs";
import { saveCompanyToken, mintLocationAccessToken } from "./ghl-company.mjs";

const ENV_PATH = new URL("./.env", import.meta.url);
const env = {
  ...(fs.existsSync(ENV_PATH)
    ? Object.fromEntries(fs.readFileSync(ENV_PATH, "utf8").split("\n").filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; }))
    : {}),
  ...process.env,
};
// CENTER_-prefixed ưu tiên trước — cần khi chạy chung tiến trình với 1 app khác cũng tự nhận các tên biến
// HIGHLEVEL_CLIENT_ID/SECRET/REDIRECT_URI này (vd Uplifting Social AI), để không đọc nhầm app GHL của họ.
if (env.CENTER_HIGHLEVEL_CLIENT_ID) env.HIGHLEVEL_CLIENT_ID = env.CENTER_HIGHLEVEL_CLIENT_ID;
if (env.CENTER_HIGHLEVEL_CLIENT_SECRET) env.HIGHLEVEL_CLIENT_SECRET = env.CENTER_HIGHLEVEL_CLIENT_SECRET;
if (env.CENTER_HIGHLEVEL_REDIRECT_URI) env.HIGHLEVEL_REDIRECT_URI = env.CENTER_HIGHLEVEL_REDIRECT_URI;
const BASE = "https://services.leadconnectorhq.com";

export function oauthConfigured() {
  return Boolean(env.HIGHLEVEL_CLIENT_ID && env.HIGHLEVEL_CLIENT_SECRET && env.HIGHLEVEL_REDIRECT_URI);
}

// Giống hệt link cài đặt công khai trong OAUTH_INSTALL_LINK.md (client_id/scope/version_id không phải bí
// mật) — tách thành hàm để /oauth/start (trang chọn sub-account cho người cài cấp AGENCY) dựng lại được,
// chỉ khác là gắn thêm `state` = locationId người đó chọn trước khi chuyển sang GHL.
const BASE_SCOPES = "contacts.readonly contacts.write objects/schema.readonly objects/schema.write objects/record.readonly objects/record.write associations.write associations.readonly associations/relation.readonly associations/relation.write users.readonly locations.readonly opportunities.readonly opportunities.write locations/customFields.readonly locations/customFields.write";
const SCOPES = BASE_SCOPES;
const VERSION_ID = "6ae085531ce4ebeec304a375";
export function buildAuthorizeUrl(state) {
  const p = new URLSearchParams({
    response_type: "code",
    redirect_uri: env.HIGHLEVEL_REDIRECT_URI || "",
    client_id: env.HIGHLEVEL_CLIENT_ID || "",
    scope: SCOPES,
    version_id: VERSION_ID,
  });
  if (state) p.set("state", state);
  return `https://marketplace.gohighlevel.com/v2/oauth/chooselocation?${p.toString()}`;
}

export async function exchangeHighLevelCode(code, fetchImpl = globalThis.fetch) {
  const r = await fetchImpl(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Version: "v3" },
    body: new URLSearchParams({
      client_id: env.HIGHLEVEL_CLIENT_ID || "",
      client_secret: env.HIGHLEVEL_CLIENT_SECRET || "",
      grant_type: "authorization_code",
      code,
      user_type: "Location",
      redirect_uri: env.HIGHLEVEL_REDIRECT_URI || "",
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Đổi mã OAuth lấy token thất bại (HTTP ${r.status}).`);
  if (!body.access_token || !body.refresh_token) throw new Error("Phản hồi OAuth từ GHL thiếu access_token/refresh_token.");
  return body;
}

async function fetchLocationName(accessToken, locationId, fetchImpl) {
  try {
    const r = await fetchImpl(`${BASE}/locations/${encodeURIComponent(locationId)}`, { headers: { Authorization: `Bearer ${accessToken}`, Version: "2021-07-28", Accept: "application/json" } });
    if (!r.ok) return null;
    const j = await r.json().catch(() => ({}));
    const name = j.location?.name || j.name;
    return typeof name === "string" && name.trim() ? name.trim() : null;
  } catch { return null; }
}

// Xác định đúng người VỪA bấm Install để đặt họ làm admin đầu tiên — không cần ai gõ email tay. `userId`
// trong phản hồi token là người thực hiện OAuth; tra ngược qua API Users của chính location đó để lấy email.
async function fetchInstaller(accessToken, locationId, userId, fetchImpl) {
  if (!userId) return null;
  try {
    const r = await fetchImpl(`${BASE}/users/?locationId=${encodeURIComponent(locationId)}`, { headers: { Authorization: `Bearer ${accessToken}`, Version: "2021-07-28", Accept: "application/json" } });
    if (!r.ok) return null;
    const j = await r.json().catch(() => ({}));
    const users = j.users || j.data?.users || [];
    const me = users.find((u) => (u.id || u._id) === userId);
    if (!me) return null;
    return { email: me.email || null, name: [me.firstName, me.lastName].filter(Boolean).join(" ") || me.name || null };
  } catch { return null; }
}

function slugify(name, fallback) {
  const base = String(name || fallback || "trung_tam").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  // db.mjs đòi tên schema PHẢI bắt đầu bằng chữ cái (SCHEMA_RE: /^[a-z][a-z0-9_]{1,50}$/ — ràng buộc giống
  // Postgres, định danh không-quote không được bắt đầu bằng số) — tên trung tâm bắt đầu bằng số (ví dụ
  // "123 GYM Test") sẽ ra slug bắt đầu bằng số, gãy ngay lúc ensureTenantSchema(). Phát hiện thật khi test
  // luồng cài đặt cấp agency (2026-10-12).
  const safe = /^[a-z]/.test(base) ? base : `tt_${base}`;
  return (safe || "trung_tam").slice(0, 40);
}
function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "CM";
  return (parts[0][0] + (parts[1]?.[0] || "")).toUpperCase();
}

export async function handleOAuthInstall({ code, state, fetchImpl = globalThis.fetch }) {
  if (!oauthConfigured()) throw new Error("Server chưa cấu hình OAuth (thiếu HIGHLEVEL_CLIENT_ID/CLIENT_SECRET/REDIRECT_URI).");
  const body = await exchangeHighLevelCode(code, fetchImpl);
  let locationId = body.locationId;
  let credential;
  let accessTokenForLookups; // token dùng để gọi các API theo-location bên dưới (tên trung tâm, danh sách nhân viên...)

  if (locationId) {
    // Cài trực tiếp từ bên trong 1 sub-account — GHL tự cho biết locationId, không cần thêm bước nào.
    const expiresAt = new Date(Date.now() + Number(body.expires_in || 86400) * 1000).toISOString();
    credential = { auth_mode: "location", access_token: body.access_token, refresh_token: body.refresh_token, location_id: locationId, expires_at: expiresAt };
    accessTokenForLookups = body.access_token;
  } else {
    // Cài từ giao diện AGENCY — GHL không trả locationId dù đã chọn đúng 1 sub-account lúc consent (xác nhận
    // thật trên API, không phải giả định). Buộc phải biết TRƯỚC đang định cài cho sub-account nào — lấy từ
    // `state` (do /oauth/start gắn vào trước khi chuyển sang GHL) — rồi đổi token công ty sang token riêng
    // cho đúng sub-account đó.
    if (!body.companyId) throw new Error("Phản hồi OAuth từ GHL thiếu cả locationId lẫn companyId — không xác định được đang cài cho ai.");
    if (!state) throw new Error("Lượt cài này cấp quyền toàn agency, không rõ đang cài cho sub-account nào — hãy mở link cài đặt qua /oauth/start (có ô nhập Location ID) khi cài từ agency.");
    locationId = state;
    console.error(`[oauth-onboarding] Agency install: companyId=${body.companyId}, state(locationId)=${state}, userType=${body.userType || "?"}, scope=${body.scope || "?"}`);
    // Token công ty lưu DUY NHẤT 1 bản/công ty (ghl-company.mjs) — không còn nhét 1 bản sao vào credential của
    // từng tenant (refresh_token dùng 1 lần: nhiều bản sao sẽ đốt token của nhau).
    await saveCompanyToken("center", body.companyId, body);
    const minted = await mintLocationAccessToken("center", body.companyId, locationId);
    credential = {
      auth_mode: "company", company_id: body.companyId,
      access_token: minted.accessToken, location_id: locationId,
      expires_at: new Date(Date.now() + minted.expiresIn * 1000).toISOString(),
    };
    accessTokenForLookups = minted.accessToken;
  }

  const existing = await getTenantByLocation(locationId);
  if (existing) {
    await updateTenantCredential(locationId, encryptCredential(credential));
    return { locationId, schemaName: existing.schema_name, brandName: existing.brand_name, reconnected: true };
  }

  const locationName = await fetchLocationName(accessTokenForLookups, locationId, fetchImpl);
  const installer = await fetchInstaller(accessTokenForLookups, locationId, body.userId, fetchImpl);
  const brandName = locationName || `Trung tâm ${locationId.slice(0, 6)}`;
  const existingTenants = await listTenants();
  let schemaName = slugify(locationName, locationId);
  if (existingTenants.some((t) => t.schema_name === schemaName)) schemaName = `${schemaName}_${locationId.slice(0, 4).toLowerCase()}`;

  await ensureTenantSchema(schemaName);
  await upsertOAuthTenant({ locationId, schemaName, encryptedCredential: encryptCredential(credential), brandName, brandMark: initials(brandName), orgLabel: brandName, menuLabel: `${brandName} — Vận hành` });

  if (installer?.email) {
    try { await addStaff(schemaName, { email: installer.email, name: installer.name, role: "admin" }); }
    catch (e) { console.error(`[oauth-onboarding] Không thêm được admin đầu tiên (${installer.email}) cho ${schemaName}:`, e.message); }
  } else {
    console.error(`[oauth-onboarding] Không xác định được email người cài cho ${schemaName} (${locationId}) — chưa có ai đăng nhập được, cần thêm admin tay (add-first-admin.mjs).`);
  }

  let seeded = { classes: 0, students: 0 };
  try { seeded = await seedTenantFromGhl(locationId); }
  catch (e) { console.error(`[oauth-onboarding] Dựng dữ liệu ban đầu từ GHL thất bại cho ${schemaName}:`, e.message); }

  return { locationId, schemaName, brandName, reconnected: false, adminEmail: installer?.email || null, seeded };
}
