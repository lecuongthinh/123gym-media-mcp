// Guarded writer cho module Điểm danh/Ghi danh/Lớp/Giáo viên — ghi THẬT vào GHL, nhưng chỉ vào những bản
// ghi nằm trong allowlist của ĐÚNG khách hàng (location) đang gọi.
//
// Đợt "multi-tenant": trước đây cả file này chỉ phục vụ 1 khách (PIT/location/allowlist đọc 1 LẦN lúc
// module load, dùng chung cho mọi request). Giờ 1 server phục vụ NHIỀU khách hàng cùng lúc — mỗi hàm xuất ra
// nhận thêm `locationId` làm tham số ĐẦU TIÊN, và state riêng của từng khách (PIT, allowlist Ghi danh/Lớp/
// Học viên...) được cache theo locationId trong `tenantStates`, nạp CHẬM (lazy) lần đầu 1 khách nào đó gọi,
// tra `platform.tenants` (xem db.mjs) để biết PIT/schema của khách đó là gì.
//
// Đợt "khách tự cài qua OAuth": 2 thay đổi lớn so với bản chỉ-PIT trước đây —
// (1) ID quan hệ (association) KHÔNG còn ghi cứng: mỗi location có ID quan hệ RIÊNG dù cùng `key` (đã xác
//     nhận thật trên API) — tenant PIT cũ (Candy English) tình cờ khớp ID ghi cứng vì chính nó được dùng để
//     lấy ID đó lúc build ban đầu; một tenant MỚI chắc chắn có ID khác, ghi cứng sẽ gãy ngay. Giờ tra theo
//     `key` (ổn định, không đổi theo location) lúc cần, cache 30 phút/tenant.
// (2) Credential có thể là PIT tĩnh HOẶC token OAuth (hết hạn, tự refresh) — `ghl()` tự chọn đường lấy token
//     đúng theo `tenant.credential_type`, phần còn lại của file không cần biết sự khác biệt này.
import { kvGet, kvSet, getTenantByLocation, updateTenantCredential } from "./db.mjs";
import { decryptCredential, encryptCredential } from "./credential-crypto.mjs";
import { mintLocationAccessToken } from "./ghl-company.mjs";
import fs from "fs";

const ENV_PATH = new URL("./.env", import.meta.url);
const env = {
  ...(fs.existsSync(ENV_PATH)
    ? Object.fromEntries(fs.readFileSync(ENV_PATH, "utf8").split("\n").filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; }))
    : {}),
  ...process.env,
};
// CENTER_-prefixed ưu tiên trước — xem ghi chú tương tự trong oauth-onboarding.mjs.
if (env.CENTER_HIGHLEVEL_CLIENT_ID) env.HIGHLEVEL_CLIENT_ID = env.CENTER_HIGHLEVEL_CLIENT_ID;
if (env.CENTER_HIGHLEVEL_CLIENT_SECRET) env.HIGHLEVEL_CLIENT_SECRET = env.CENTER_HIGHLEVEL_CLIENT_SECRET;

const BASE = "https://services.leadconnectorhq.com";
const HOC_VIEN_KEY = "custom_objects.hoc_vien";
const DIEM_DANH_KEY = "custom_objects.diem_danh";
const BUOI_HOC_KEY = "custom_objects.buoi_hoc";
const GHI_DANH_KEY = "custom_objects.ghi_danh";
const GIAO_VIEN_KEY = "custom_objects.giao_vien";
const LOP_KEY = "custom_objects.lop";
const STATUS_LABEL = { co_mat: "Có mặt", vang_co_phep: "Vắng có phép", vang_khong_phep: "Vắng không phép", den_muon: "Đến muộn" };

// State riêng của 1 khách hàng (locationId): credential/allowlist, cache trong tiến trình — nạp 1 lần, dùng
// lại cho mọi request sau của CÙNG khách đó.
const tenantStates = new Map();
async function getTenantState(locationId) {
  if (tenantStates.has(locationId)) return tenantStates.get(locationId);
  const tenant = await getTenantByLocation(locationId);
  if (!tenant) throw new Error(`Không tìm thấy cấu hình khách hàng cho location ${locationId} — chưa được thêm vào platform.tenants`);
  const candy = await kvGet(tenant.schema_name, "base_snapshot", { students: [], classes: [], attendance_seed: [] });
  const enrollOverlay = await kvGet(tenant.schema_name, "enrollment_overlay", []);
  const classOverlay = await kvGet(tenant.schema_name, "class_overlay", []);
  const allKnownStudents = [...candy.students, ...enrollOverlay];
  const state = {
    tenant, // bản ghi thô từ platform.tenants — giữ nguyên để resolve token (xem getAccessToken)
    LOC: locationId,
    schemaName: tenant.schema_name,
    tokenCache: null, // {accessToken, expiresAt} — chỉ dùng cho tenant OAuth, xem getAccessToken
    assocCache: null, // {at, map: key->id} — xem assocId
    ALLOWED_GHI_DANH: new Set(allKnownStudents.map((s) => s.ghi_danh_id)),
    ALLOWED_LOP: new Map([...candy.classes, ...classOverlay].map((c) => [c.lop, c.lop_id])),
    ALLOWED_HOC_VIEN: new Set(allKnownStudents.map((s) => s.hoc_vien_id)),
    buoiHocCache: new Map(), // `${lop}|${date}` -> {buoiHocId, created}, tránh gọi search lặp lại trong cùng 1 lô
  };
  tenantStates.set(locationId, state);
  return state;
}

// Xoá cache của 1 tenant — gọi sau khi provision/seed dữ liệu lần đầu, để lần đọc kế tiếp thấy ngay dữ liệu
// mới thay vì đợi tiến trình khởi động lại.
export function invalidateTenantState(locationId) {
  tenantStates.delete(locationId);
}

function writerConfigured(tenant) {
  return tenant.credential_type === "oauth" ? Boolean(tenant.encrypted_credential) : Boolean(tenant.ghl_pit);
}
export async function writerEnabled(locationId) {
  try { const t = await getTenantState(locationId); return writerConfigured(t.tenant); }
  catch { return false; }
}
function assertWriterEnabled(t) {
  if (!writerConfigured(t.tenant)) throw new Error("Chưa kết nối GHL cho trung tâm này — chưa bật ghi thật");
}

// Lấy access token hiện dùng được: PIT tĩnh thì trả thẳng; token OAuth thì refresh trước khi hết hạn (chừa
// 1 phút) rồi lưu lại bản mã hoá mới vào Postgres — tenant khác KHÔNG bị ảnh hưởng vì mỗi tenant tự quản lý
// token/refresh_token riêng của chính họ.
async function getAccessToken(t) {
  if (t.tenant.credential_type !== "oauth") return t.tenant.ghl_pit;
  if (t.tokenCache && t.tokenCache.expiresAt > Date.now() + 60_000) return t.tokenCache.accessToken;
  if (!t.tenant.encrypted_credential) throw new Error("Chưa kết nối GHL cho trung tâm này — chưa bật ghi thật");
  let cred = decryptCredential(t.tenant.encrypted_credential);
  const expiresAt = cred.expires_at ? new Date(cred.expires_at).getTime() : 0;
  if (expiresAt <= Date.now() + 60_000) {
    if (cred.auth_mode === "company") {
      // Cài từ cấp AGENCY: token sub-account mint ra không có refresh_token riêng — hết hạn thì phải refresh
      // token CÔNG TY trước (grant_type=refresh_token/user_type=Company), rồi mint lại token sub-account từ
      // token công ty vừa làm mới (xem highlevel-location-token.mjs).
      // Token công ty giờ do ghl-company.mjs giữ DUY NHẤT 1 bản/công ty (refresh_token dùng 1 lần — nhiều
      // tenant mỗi người giữ 1 bản sao sẽ đốt token của nhau). `company_refresh_token` còn trong credential
      // của tenant cài từ trước chỉ dùng làm hạt giống lần đầu.
      if (!cred.company_id) throw new Error(`Token agency của ${t.LOC} thiếu company_id — cần cài lại app.`);
      const minted = await mintLocationAccessToken("center", cred.company_id, t.LOC, cred.company_refresh_token);
      cred = {
        auth_mode: "company", company_id: cred.company_id,
        access_token: minted.accessToken, location_id: t.LOC,
        expires_at: new Date(Date.now() + minted.expiresIn * 1000).toISOString(),
      };
    } else {
      if (!cred.refresh_token) throw new Error(`Token GHL của ${t.LOC} đã hết hạn và không có refresh_token — cần cài lại app.`);
      const r = await fetch(`${BASE}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Version: "v3" },
        body: new URLSearchParams({ client_id: env.HIGHLEVEL_CLIENT_ID || "", client_secret: env.HIGHLEVEL_CLIENT_SECRET || "", grant_type: "refresh_token", refresh_token: cred.refresh_token, user_type: "Location" }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body.access_token) throw new Error(`Làm mới token GHL thất bại cho ${t.LOC} (HTTP ${r.status})`);
      cred = { auth_mode: "location", access_token: body.access_token, refresh_token: body.refresh_token || cred.refresh_token, location_id: t.LOC, expires_at: new Date(Date.now() + Number(body.expires_in || 86400) * 1000).toISOString() };
    }
    t.tenant.encrypted_credential = encryptCredential(cred);
    await updateTenantCredential(t.LOC, t.tenant.encrypted_credential);
  }
  t.tokenCache = { accessToken: cred.access_token, expiresAt: new Date(cred.expires_at).getTime() };
  return cred.access_token;
}

async function ghl(t, method, path, body) {
  const accessToken = await getAccessToken(t);
  const H = { Authorization: `Bearer ${accessToken}`, Version: "2021-07-28", "Content-Type": "application/json", Accept: "application/json" };
  const r = await fetch(BASE + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`GHL ${method} ${path.replace(/\/records\/[^/]+/, "/records/<id>")} -> ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

// Tra ID quan hệ theo `key` (ổn định giữa các location) thay vì ghi cứng ID (riêng từng location) — xem giải
// thích ở đầu file. Cache 30 phút/tenant vì danh sách quan hệ gần như không đổi sau lúc tạo object model.
async function getAssocMap(t) {
  if (t.assocCache && Date.now() - t.assocCache.at < 30 * 60_000) return t.assocCache.map;
  const j = await ghl(t, "GET", `/associations/?locationId=${t.LOC}&skip=0&limit=100`);
  const map = new Map((j.associations || []).map((a) => [a.key, a.id]));
  t.assocCache = { at: Date.now(), map };
  return map;
}
async function assocId(t, key) {
  const map = await getAssocMap(t);
  const id = map.get(key);
  if (!id) throw new Error(`Không tìm thấy quan hệ "${key}" trên GHL của trung tâm này — kiểm tra Snapshot đã nạp đủ các object/quan hệ chưa.`);
  return id;
}

// Danh sách cơ sở (key + nhãn hiển thị) đọc THẲNG từ field `co_so` của object Lớp trên GHL của từng trung
// tâm — nguồn sự thật duy nhất. Trước đây tên cơ sở nằm cứng trong code frontend: đổi nhãn trong CRM thì app
// không đổi theo, và khách mới sẽ thấy tên cơ sở của Candy English. Cache 5 phút/tenant để không gọi GHL mỗi
// lần mở trang; nếu GHL lỗi thì trả lại bản cache cũ (nếu có) thay vì làm hỏng cả màn hình.
export async function getCoSoOptions(locationId) {
  const t = await getTenantState(locationId);
  if (t.coSoCache && Date.now() - t.coSoCache.at < 5 * 60_000) return t.coSoCache.options;
  try {
    const j = await ghl(t, "GET", `/objects/${LOP_KEY}?locationId=${t.LOC}&fetchProperties=true`);
    const field = (j.fields || []).find((f) => /(^|\.)co_so$/.test(f.fieldKey || ""));
    const options = (field?.options || []).map((o) => ({ key: o.key, label: o.label }));
    t.coSoCache = { at: Date.now(), options };
    return options;
  } catch (e) {
    console.error(`[${t.schemaName}] Đọc danh sách cơ sở từ GHL thất bại:`, e.message);
    return t.coSoCache?.options || [];
  }
}

// Buổi học = 1 real session of 1 Lớp on 1 date. Find-or-create so marking attendance twice for the
// same lớp+ngày never creates a duplicate session record — the search is the idempotency check.
async function findOrCreateBuoiHoc(t, { lop, date }) {
  const lopId = t.ALLOWED_LOP.get(lop);
  if (!lopId) throw new Error(`Chặn: ${lop} không nằm trong danh sách Lớp test được phép`);
  const cacheKey = `${lop}|${date}`;
  if (t.buoiHocCache.has(cacheKey)) return t.buoiHocCache.get(cacheKey);
  const name = `Buổi ${lop} ${date}`;
  const search = await ghl(t, "POST", `/objects/${BUOI_HOC_KEY}/records/search`, { locationId: t.LOC, page: 1, pageLimit: 5, query: name });
  const found = (search.records || []).find((r) => r.properties?.name === name);
  let buoiHocId, created;
  if (found) {
    buoiHocId = found.id; created = false;
  } else {
    const rec = await ghl(t, "POST", `/objects/${BUOI_HOC_KEY}/records`, { locationId: t.LOC, properties: { name, ngay: date, trang_thai: "binh_thuong" } });
    buoiHocId = rec.record.id; created = true;
    await ghl(t, "POST", `/associations/relations`, { locationId: t.LOC, associationId: await assocId(t, "lop_buoi_hoc"), firstRecordId: buoiHocId, secondRecordId: lopId });
  }
  const result = { buoiHocId, created };
  t.buoiHocCache.set(cacheKey, result);
  return result;
}

export async function generateSessions(locationId, { lop, dates }) {
  const t = await getTenantState(locationId);
  assertWriterEnabled(t);
  const results = [];
  for (const date of dates) {
    const { buoiHocId, created } = await findOrCreateBuoiHoc(t, { lop, date });
    results.push({ date, buoiHocId, created });
  }
  return results;
}

// Đồng bộ CRM: mỗi Học viên đã được nối với 1 Contact (phụ huynh) — read-only, no side effects.
export async function getPhuHuynh(locationId, { hocVienId }) {
  const t = await getTenantState(locationId);
  if (!t.ALLOWED_HOC_VIEN.has(hocVienId)) throw new Error(`Chặn: ${hocVienId} không nằm trong danh sách Học viên test được phép`);
  const rel = await ghl(t, "GET", `/associations/relations/${hocVienId}?locationId=${t.LOC}`);
  const contactRel = (rel.relations || []).find((r) => r.firstObjectKey === "contact");
  if (!contactRel) return null;
  const c = await ghl(t, "GET", `/contacts/${contactRel.firstRecordId}`);
  const contact = c.contact;
  if (!contact) return null;
  return { id: contact.id, name: `${contact.firstName || ""} ${contact.lastName || ""}`.trim(), phone: contact.phone || "", email: contact.email || "", tags: contact.tags || [] };
}

export async function getBuoiHoc(locationId, { lop, date }) {
  const t = await getTenantState(locationId);
  if (!t.ALLOWED_LOP.has(lop)) throw new Error(`Chặn: ${lop} không nằm trong danh sách Lớp test được phép`);
  const name = `Buổi ${lop} ${date}`;
  const search = await ghl(t, "POST", `/objects/${BUOI_HOC_KEY}/records/search`, { locationId: t.LOC, page: 1, pageLimit: 5, query: name });
  const found = (search.records || []).find((r) => r.properties?.name === name);
  if (!found) return null;
  return { id: found.id, ngay: found.properties?.ngay, trang_thai: found.properties?.trang_thai, giao_vien_day: found.properties?.giao_vien_day || "" };
}

export async function listBuoiHoc(locationId, { lop }) {
  const t = await getTenantState(locationId);
  if (!t.ALLOWED_LOP.has(lop)) throw new Error(`Chặn: ${lop} không nằm trong danh sách Lớp test được phép`);
  const prefix = `Buổi ${lop} `;
  const search = await ghl(t, "POST", `/objects/${BUOI_HOC_KEY}/records/search`, { locationId: t.LOC, page: 1, pageLimit: 100, query: lop });
  return (search.records || [])
    .filter((r) => (r.properties?.name || "").startsWith(prefix))
    .map((r) => ({ id: r.id, ngay: r.properties?.ngay || "", trang_thai: r.properties?.trang_thai || "binh_thuong", giao_vien_day: r.properties?.giao_vien_day || "" }))
    .sort((a, b) => a.ngay.localeCompare(b.ngay));
}

export async function updateBuoiHoc(locationId, { buoiHocId, trangThai, giaoVienDay }) {
  const t = await getTenantState(locationId);
  assertWriterEnabled(t);
  const props = {};
  if (trangThai) {
    if (!["binh_thuong", "huy", "hoc_bu"].includes(trangThai)) throw new Error(`Trạng thái không hợp lệ: ${trangThai}`);
    props.trang_thai = trangThai;
  }
  if (giaoVienDay !== undefined) props.giao_vien_day = giaoVienDay;
  if (!Object.keys(props).length) throw new Error("Không có gì để cập nhật");
  await ghl(t, "PUT", `/objects/${BUOI_HOC_KEY}/records/${buoiHocId}?locationId=${t.LOC}`, { properties: props });
  return { buoiHocId, ...props };
}

export async function setBuoiHocTrangThai(locationId, { lop, date, trangThai }) {
  const t = await getTenantState(locationId);
  assertWriterEnabled(t);
  if (!["binh_thuong", "huy", "hoc_bu"].includes(trangThai)) throw new Error(`Trạng thái không hợp lệ: ${trangThai}`);
  const { buoiHocId } = await findOrCreateBuoiHoc(t, { lop, date });
  await ghl(t, "PUT", `/objects/${BUOI_HOC_KEY}/records/${buoiHocId}?locationId=${t.LOC}`, { properties: { trang_thai: trangThai } });
  return { id: buoiHocId, trang_thai: trangThai };
}

// Tạo 1 Học viên hoàn toàn mới trên GHL (chưa nối Contact phụ huynh — đồng bộ CRM phụ huynh vẫn cần làm tay
// nếu cần). Object mới hoàn toàn do chính app tạo nên không cần allowlist theo id — nhưng vẫn thêm ngay vào
// ALLOWED_HOC_VIEN sau khi tạo để ghi danh theo sau (cùng 1 request) dùng được ngay.
export async function createHocVien(locationId, { name, ngaySinh, coSo }) {
  const t = await getTenantState(locationId);
  assertWriterEnabled(t);
  if (!name || !name.trim()) throw new Error("Cần tên học viên");
  const props = { name: name.trim(), trang_thai: "dang_hoc" };
  if (ngaySinh) props.ngay_sinh = ngaySinh;
  if (coSo) props.co_so = coSo;
  const rec = await ghl(t, "POST", `/objects/${HOC_VIEN_KEY}/records`, { locationId: t.LOC, properties: props });
  const hocVienId = rec.record.id;
  t.ALLOWED_HOC_VIEN.add(hocVienId);
  return { hocVienId };
}

// Tạo Contact phụ huynh (API Contacts chuẩn của GHL, không phải custom object) + nối sang 1 Học viên qua
// association "contact_hoc_vien" — dùng cho import hàng loạt (vd danh sách học viên từ Excel) khi phụ huynh
// chưa tồn tại sẵn trong CRM. Không có trong app UI (chưa cần), chỉ phục vụ script/import.
export async function createPhuHuynh(locationId, { name, phone, address1, tags }) {
  const t = await getTenantState(locationId);
  assertWriterEnabled(t);
  if (!name || !name.trim()) throw new Error("Cần tên phụ huynh");
  const body = { locationId: t.LOC, firstName: name.trim() };
  if (phone) body.phone = phone;
  if (address1) body.address1 = address1;
  if (tags && tags.length) body.tags = tags;
  const rec = await ghl(t, "POST", "/contacts/", body);
  return { contactId: rec.contact.id };
}

export async function lienKetPhuHuynhHocVien(locationId, { contactId, hocVienId }) {
  const t = await getTenantState(locationId);
  assertWriterEnabled(t);
  await ghl(t, "POST", "/associations/relations", { locationId: t.LOC, associationId: await assocId(t, "contact_hoc_vien"), firstRecordId: contactId, secondRecordId: hocVienId });
}

// Xếp lớp / ghi danh: tạo 1 Ghi danh thật và nối vào Học viên + Lớp.
export async function enrollStudent(locationId, { hocVienId, studentName, lop, ngayBatDau, ngayHetHan, tongSoBuoi, hocPhi, tienGiaoCu }) {
  const t = await getTenantState(locationId);
  assertWriterEnabled(t);
  if (!t.ALLOWED_HOC_VIEN.has(hocVienId)) throw new Error(`Chặn: ${hocVienId} không nằm trong danh sách Học viên test được phép`);
  const lopId = t.ALLOWED_LOP.get(lop);
  if (!lopId) throw new Error(`Chặn: ${lop} không nằm trong danh sách Lớp test được phép`);
  const name = `GD ${studentName} - ${lop}`;
  const props = { name, ngay_bat_dau: ngayBatDau, trang_thai: "dang_hoc", so_buoi_da_hoc: 0 };
  if (ngayHetHan) props.ngay_het_han = ngayHetHan;
  if (tongSoBuoi) props.tong_so_buoi = tongSoBuoi;
  if (tienGiaoCu) props.tien_giao_cu = tienGiaoCu;
  if (hocPhi) props.ghi_chu = `Học phí: ${Number(hocPhi).toLocaleString("vi-VN")} đ (nhập qua app, chưa qua ô tiền tệ chuẩn)`;
  const rec = await ghl(t, "POST", `/objects/${GHI_DANH_KEY}/records`, { locationId: t.LOC, properties: props });
  const ghiDanhId = rec.record.id;
  await ghl(t, "POST", `/associations/relations`, { locationId: t.LOC, associationId: await assocId(t, "hoc_vien_ghi_danh"), firstRecordId: ghiDanhId, secondRecordId: hocVienId });
  await ghl(t, "POST", `/associations/relations`, { locationId: t.LOC, associationId: await assocId(t, "lop_ghi_danh"), firstRecordId: ghiDanhId, secondRecordId: lopId });
  // ALLOWED_GHI_DANH nạp 1 lần lúc getTenantState() đầu tiên — thêm ngay ở đây để ghi danh vừa tạo dùng được
  // NGAY LẬP TỨC (điểm danh/gia hạn) trong CÙNG phiên chạy, không cần đợi cache tenant bị dọn/nạp lại.
  t.ALLOWED_GHI_DANH.add(ghiDanhId);
  return { ghiDanhId, lopId, name };
}

const ALLOWED_GD_TRANG_THAI = new Set(["dang_hoc", "tam_nghi", "da_chuyen_lop", "hoan_thanh", "da_nghi"]);

export async function setGhiDanhTrangThai(locationId, { ghiDanhId, trangThai }) {
  const t = await getTenantState(locationId);
  assertWriterEnabled(t);
  if (!t.ALLOWED_GHI_DANH.has(ghiDanhId)) throw new Error(`Chặn: ${ghiDanhId} không nằm trong danh sách Ghi danh test được phép`);
  if (!ALLOWED_GD_TRANG_THAI.has(trangThai)) throw new Error(`Trạng thái không hợp lệ: ${trangThai}`);
  await ghl(t, "PUT", `/objects/${GHI_DANH_KEY}/records/${ghiDanhId}?locationId=${t.LOC}`, { properties: { trang_thai: trangThai } });
  return { ghiDanhId, trang_thai: trangThai };
}

export async function setLichHoc(locationId, { lop, cacThuHoc, gioBatDau, gioKetThuc }) {
  const t = await getTenantState(locationId);
  assertWriterEnabled(t);
  const lopId = t.ALLOWED_LOP.get(lop);
  if (!lopId) throw new Error(`Chặn: ${lop} không nằm trong danh sách Lớp test được phép`);
  const props = { cac_thu_hoc: (cacThuHoc || []).join(","), gio_bat_dau: gioBatDau || "", gio_ket_thuc: gioKetThuc || "" };
  await ghl(t, "PUT", `/objects/${LOP_KEY}/records/${lopId}?locationId=${t.LOC}`, { properties: props });
  return { lopId, ...props };
}

// Giáo viên: object hoàn toàn mới trên GHL — mọi bản ghi đều do chính app tạo ra, không cần allowlist theo id.
export async function createGiaoVien(locationId, { name, phone, email, ghiChu }) {
  const t = await getTenantState(locationId);
  assertWriterEnabled(t);
  if (!name || !name.trim()) throw new Error("Cần tên giáo viên");
  const props = { name: name.trim(), trang_thai: "dang_day" };
  if (phone) props.so_dien_thoai = phone;
  if (email) props.email = email;
  if (ghiChu) props.ghi_chu = ghiChu;
  const rec = await ghl(t, "POST", `/objects/${GIAO_VIEN_KEY}/records`, { locationId: t.LOC, properties: props });
  return { id: rec.record.id };
}

export async function updateGiaoVien(locationId, { giaoVienId, name, phone, email, trangThai, ghiChu }) {
  const t = await getTenantState(locationId);
  assertWriterEnabled(t);
  const props = {};
  if (name !== undefined) props.name = name;
  if (phone !== undefined) props.so_dien_thoai = phone;
  if (email !== undefined) props.email = email;
  if (trangThai !== undefined) {
    if (!["dang_day", "tam_nghi", "da_nghi"].includes(trangThai)) throw new Error(`Trạng thái không hợp lệ: ${trangThai}`);
    props.trang_thai = trangThai;
  }
  if (ghiChu !== undefined) props.ghi_chu = ghiChu;
  if (!Object.keys(props).length) throw new Error("Không có gì để cập nhật");
  await ghl(t, "PUT", `/objects/${GIAO_VIEN_KEY}/records/${giaoVienId}?locationId=${t.LOC}`, { properties: props });
  return { giaoVienId, ...props };
}

// Gán GV cho lớp: xoá quan hệ Lớp↔Giáo viên CŨ của lớp đó trước khi tạo quan hệ mới, giữ đúng mô hình
// "1 lớp 1 GV chính".
export async function ganGiaoVienChoLop(locationId, { giaoVienId, lop }) {
  const t = await getTenantState(locationId);
  assertWriterEnabled(t);
  const lopId = t.ALLOWED_LOP.get(lop);
  if (!lopId) throw new Error(`Chặn: ${lop} không nằm trong danh sách Lớp test được phép`);
  try {
    const existing = await ghl(t, "GET", `/associations/relations/${lopId}?locationId=${t.LOC}`);
    const lopGiaoVienId = await assocId(t, "lop_giao_vien");
    const olds = (existing.relations || []).filter((r) => r.associationId === lopGiaoVienId);
    for (const rel of olds) {
      try { await ghl(t, "DELETE", `/associations/relations/${rel.id}?locationId=${t.LOC}`); } catch { /* best-effort */ }
    }
  } catch { /* không đọc được quan hệ cũ — vẫn tiếp tục gán quan hệ mới */ }
  await ghl(t, "POST", `/associations/relations`, { locationId: t.LOC, associationId: await assocId(t, "lop_giao_vien"), firstRecordId: giaoVienId, secondRecordId: lopId });
  return { giaoVienId, lop };
}

// Gia hạn: PATCH thẳng ngày hết hạn / tổng số buổi trên Ghi danh đã có.
export async function renewEnrollment(locationId, { ghiDanhId, ngayHetHanMoi, tongSoBuoiMoi }) {
  const t = await getTenantState(locationId);
  assertWriterEnabled(t);
  if (!t.ALLOWED_GHI_DANH.has(ghiDanhId)) throw new Error(`Chặn: ${ghiDanhId} không nằm trong danh sách Ghi danh test được phép`);
  const props = {};
  if (ngayHetHanMoi) props.ngay_het_han = ngayHetHanMoi;
  if (tongSoBuoiMoi) props.tong_so_buoi = tongSoBuoiMoi;
  if (!Object.keys(props).length) throw new Error("Cần ít nhất ngày hết hạn mới hoặc tổng số buổi mới");
  await ghl(t, "PUT", `/objects/${GHI_DANH_KEY}/records/${ghiDanhId}?locationId=${t.LOC}`, { properties: props });
  return { ghiDanhId, ...props };
}

const ATTENDED_STATUSES = new Set(["co_mat", "den_muon"]);

async function bumpSoBuoiDaHoc(t, ghiDanhId) {
  const cur = await ghl(t, "GET", `/objects/${GHI_DANH_KEY}/records/${ghiDanhId}?locationId=${t.LOC}`);
  const now = Number(cur.record?.properties?.so_buoi_da_hoc) || 0;
  const next = now + 1;
  await ghl(t, "PUT", `/objects/${GHI_DANH_KEY}/records/${ghiDanhId}?locationId=${t.LOC}`, { properties: { so_buoi_da_hoc: next } });
  return next;
}

// Create ONE real Điểm danh record for a student's session, link it to their Ghi danh AND to the
// Buổi học (session) it belongs to.
export async function writeAttendance(locationId, { studentName, ghiDanhId, lop, date, status, note }) {
  const t = await getTenantState(locationId);
  assertWriterEnabled(t);
  if (!t.ALLOWED_GHI_DANH.has(ghiDanhId)) throw new Error(`Chặn: ${ghiDanhId} không nằm trong danh sách Ghi danh test được phép`);
  const { buoiHocId } = await findOrCreateBuoiHoc(t, { lop, date });
  const name = `ĐD ${studentName} ${date}`;
  const props = { name, ngay: date, trang_thai: status };
  if (note) props.ghi_chu = note;
  const rec = await ghl(t, "POST", `/objects/${DIEM_DANH_KEY}/records`, { locationId: t.LOC, properties: props });
  const diemDanhId = rec.record.id;
  await ghl(t, "POST", `/associations/relations`, { locationId: t.LOC, associationId: await assocId(t, "ghi_danh_diem_danh"), firstRecordId: diemDanhId, secondRecordId: ghiDanhId });
  await ghl(t, "POST", `/associations/relations`, { locationId: t.LOC, associationId: await assocId(t, "buoi_hoc_diem_danh"), firstRecordId: buoiHocId, secondRecordId: diemDanhId });
  let soBuoiDaHoc;
  if (ATTENDED_STATUSES.has(status)) {
    try { soBuoiDaHoc = await bumpSoBuoiDaHoc(t, ghiDanhId); }
    catch (e) { console.error(`Cộng dồn so_buoi_da_hoc thất bại cho ${ghiDanhId}:`, e.message); }
  }
  return { diemDanhId, buoiHocId, name, status: STATUS_LABEL[status] || status, soBuoiDaHoc };
}

// Backfill một lần cho các Ghi danh đã có điểm danh thật TRƯỚC KHI bug cộng dồn trên được sửa.
export async function backfillSoBuoiDaHoc(locationId, ghiDanhIds) {
  const t = await getTenantState(locationId);
  assertWriterEnabled(t);
  const results = [];
  const ghiDanhDiemDanhId = await assocId(t, "ghi_danh_diem_danh");
  for (const ghiDanhId of ghiDanhIds) {
    if (!t.ALLOWED_GHI_DANH.has(ghiDanhId)) { results.push({ ghiDanhId, error: "không nằm trong allowlist" }); continue; }
    const rel = await ghl(t, "GET", `/associations/relations/${ghiDanhId}?locationId=${t.LOC}`);
    const diemDanhIds = (rel.relations || [])
      .filter((r) => r.associationId === ghiDanhDiemDanhId)
      .map((r) => (r.firstRecordId === ghiDanhId ? r.secondRecordId : r.firstRecordId));
    let attended = 0;
    for (const id of diemDanhIds) {
      const rec = await ghl(t, "GET", `/objects/${DIEM_DANH_KEY}/records/${id}?locationId=${t.LOC}`);
      if (ATTENDED_STATUSES.has(rec.record?.properties?.trang_thai)) attended++;
    }
    const cur = await ghl(t, "GET", `/objects/${GHI_DANH_KEY}/records/${ghiDanhId}?locationId=${t.LOC}`);
    const before = Number(cur.record?.properties?.so_buoi_da_hoc) || 0;
    if (before !== attended) {
      await ghl(t, "PUT", `/objects/${GHI_DANH_KEY}/records/${ghiDanhId}?locationId=${t.LOC}`, { properties: { so_buoi_da_hoc: attended } });
    }
    results.push({ ghiDanhId, total_diem_danh: diemDanhIds.length, attended, before, changed: before !== attended });
  }
  return results;
}

// Liệt kê TOÀN BỘ record của 1 object (không lọc) — search API trả idempotent theo trang, lặp tới khi đủ
// `total` đã báo. pageLimit 100 (mức tối đa GHL cho phép) để tránh quá nhiều vòng gọi với trung tâm lớn.
async function listAllRecords(t, key) {
  const all = [];
  let page = 1;
  for (;;) {
    const j = await ghl(t, "POST", `/objects/${key}/records/search`, { locationId: t.LOC, page, pageLimit: 100 });
    const records = j.records || [];
    all.push(...records);
    if (!records.length || all.length >= (j.total || 0)) break;
    page++;
  }
  return all;
}

// Dựng base_snapshot ban đầu cho 1 tenant MỚI từ chính dữ liệu Lớp/Học viên/Ghi danh ĐÃ CÓ SẴN trên GHL của
// họ (ví dụ khách đã dùng GHL quản lý lớp bằng tay trước khi cài app, hoặc GHL Snapshot kèm theo dữ liệu mẫu)
// — thay vì bắt mọi tenant mới bắt đầu từ con số 0. Ghi danh không nối đủ cả 2 đầu (Học viên + Lớp) bị bỏ
// qua (mồ côi dữ liệu — không suy đoán/bịa). Không kéo lịch sử Điểm danh (attendance_seed để trống) — việc
// đó nằm ngoài phạm vi "dựng danh sách lớp/học viên ban đầu", điểm danh mới tính từ lúc dùng app trở đi.
export async function seedTenantFromGhl(locationId) {
  const t = await getTenantState(locationId);
  const [lopRecords, hocVienRecords, ghiDanhRecords] = await Promise.all([
    listAllRecords(t, LOP_KEY),
    listAllRecords(t, HOC_VIEN_KEY),
    listAllRecords(t, GHI_DANH_KEY),
  ]);
  const hocVienById = new Map(hocVienRecords.map((r) => [r.id, r]));
  const classes = lopRecords.map((r) => ({
    lop: r.properties?.name || r.id,
    lop_id: r.id,
    co_so: r.properties?.co_so || "",
    trang_thai: r.properties?.trang_thai || "",
    cap_do: r.properties?.cap_do || "",
    si_so_toi_da: r.properties?.si_so_toi_da || "",
    cac_thu_hoc: r.properties?.cac_thu_hoc || "",
    gio_bat_dau: r.properties?.gio_bat_dau || "",
    gio_ket_thuc: r.properties?.gio_ket_thuc || "",
    students: [],
  }));
  const classByLopId = new Map(classes.map((c) => [c.lop_id, c]));

  let n = 1;
  const students = [];
  for (const gd of ghiDanhRecords) {
    const hvRel = (gd.relations || []).find((r) => r.objectKey === HOC_VIEN_KEY);
    const lopRel = (gd.relations || []).find((r) => r.objectKey === LOP_KEY);
    const hv = hvRel && hocVienById.get(hvRel.recordId);
    const cls = lopRel && classByLopId.get(lopRel.recordId);
    if (!hv || !cls) continue; // ghi danh thiếu liên kết Học viên hoặc Lớp — bỏ qua, không bịa dữ liệu
    const row = {
      n: n++,
      name: hv.properties?.name || "",
      hoc_vien_id: hv.id,
      ghi_danh_id: gd.id,
      lop: cls.lop,
      lop_id: cls.lop_id,
      co_so: hv.properties?.co_so || cls.co_so || "",
      sessions_total: gd.properties?.tong_so_buoi || "",
      fee: 0, // học phí chưa từng lưu dạng số sạch trên GHL (field tiền tệ bị lỗi, xem ghi chú lịch sử) — không suy đoán từ ghi_chu dạng text
      so_buoi_da_hoc: Number(gd.properties?.so_buoi_da_hoc) || 0,
      gd_trang_thai: gd.properties?.trang_thai || "dang_hoc",
      ngay_sinh: hv.properties?.ngay_sinh || "",
      hv_trang_thai: hv.properties?.trang_thai || "dang_hoc",
      tien_giao_cu: Number(gd.properties?.tien_giao_cu) || 0,
      ngay_bat_dau: gd.properties?.ngay_bat_dau || "",
      ngay_het_han: gd.properties?.ngay_het_han || "",
    };
    students.push(row);
    cls.students.push(row.n);
  }
  // Danh sách TOÀN BỘ Học viên (kể cả chưa ghi danh vào lớp nào) — `students` ở trên chỉ build từ Ghi danh
  // nên bỏ sót người chưa xếp lớp; bắt thật khi import 125 học viên EIM có 4 em chưa có lớp, hoàn toàn
  // không hiện ở đâu trong app vì chưa có trang "Học viên" độc lập khỏi Lớp. Xem GET /api/candy/hoc-vien-ds.
  const allHocVien = hocVienRecords.map((hv) => ({
    hoc_vien_id: hv.id,
    name: hv.properties?.name || "",
    ngay_sinh: hv.properties?.ngay_sinh || "",
    co_so: hv.properties?.co_so || "",
    trang_thai: hv.properties?.trang_thai || "dang_hoc",
  }));
  await kvSet(t.schemaName, "base_snapshot", { students, classes, attendance_seed: [], all_hoc_vien: allHocVien });
  invalidateTenantState(locationId); // bắt buộc — nếu không, state đang cache (rỗng, nạp trước lúc seed) vẫn được dùng tới khi tiến trình khởi động lại
  return { classes: classes.length, students: students.length };
}

// Tạo 1 Lớp hoàn toàn mới trên GHL — khách mới không có sẵn lớp nào trong GHL (hoặc muốn mở thêm lớp) cần
// đường này, trước đây app chỉ XEM/sửa lớp đã có, chưa từng tạo lớp mới được.
export async function createLop(locationId, { name, coSo, capDo, siSoToiDa }) {
  const t = await getTenantState(locationId);
  assertWriterEnabled(t);
  if (!name || !name.trim()) throw new Error("Cần tên lớp");
  const props = { name: name.trim(), trang_thai: "dang_mo" };
  if (coSo) props.co_so = coSo;
  if (capDo) props.cap_do = capDo.trim();
  if (siSoToiDa) props.si_so_toi_da = Number(siSoToiDa) || undefined;
  const rec = await ghl(t, "POST", `/objects/${LOP_KEY}/records`, { locationId: t.LOC, properties: props });
  const lopId = rec.record.id;
  // Lớp vừa tạo cần dùng được NGAY cho "Ghi danh"/"Thời khoá biểu" trong cùng phiên — thêm thẳng vào allowlist,
  // cùng lý do đã áp dụng cho createHocVien/enrollStudent.
  t.ALLOWED_LOP.set(name.trim(), lopId);
  return { lopId, lop: name.trim(), co_so: coSo || "", cap_do: capDo || "", si_so_toi_da: siSoToiDa || "" };
}

// Tạo pipeline bán hàng (Opportunity) cho 1 tenant — việc onboard 1 khách mới (chưa có pipeline nào trong
// GHL) để nối Opportunity→Ghi danh theo đúng mô hình đã validate qua ELUX (xem reference_ghl_app_management_
// pattern). Endpoint này KHÔNG nằm trong tài liệu GHL public API chính thức (không có trong registry chuẩn),
// nhưng đã xác nhận hoạt động thật khi gọi trực tiếp — dùng y hệt cách ELUX đã làm.
export async function createPipeline(locationId, { name, stages, showInFunnel = true }) {
  const t = await getTenantState(locationId);
  assertWriterEnabled(t);
  if (!name || !name.trim()) throw new Error("Cần tên pipeline");
  if (!Array.isArray(stages) || stages.length === 0) throw new Error("Cần ít nhất 1 giai đoạn (stage)");
  const body = { locationId: t.LOC, name: name.trim(), showInFunnel, stages: stages.map((s, i) => ({ name: s, position: i })) };
  const r = await ghl(t, "POST", "/opportunities/pipelines", body);
  return r.pipeline || r;
}

const GHI_DANH_STAGE_NAME = "Đã ghi danh";

// Tên giai đoạn (stage) không nằm trong payload webhook OpportunityStageUpdate (chỉ có pipelineStageId) — tra
// lại qua GET /opportunities/pipelines, gộp tất cả pipeline của tenant vào 1 map id->tên. Khớp theo TÊN (không
// ghi cứng ID) vì mỗi tenant tự tạo pipeline riêng, ID chắc chắn khác nhau.
async function getPipelineStageNames(t) {
  if (t.pipelineStageCache && Date.now() - t.pipelineStageCache.at < 30 * 60_000) return t.pipelineStageCache.map;
  const j = await ghl(t, "GET", `/opportunities/pipelines?locationId=${t.LOC}`);
  const map = new Map();
  for (const p of j.pipelines || []) for (const s of p.stages || []) map.set(s.id, s.name);
  t.pipelineStageCache = { at: Date.now(), map };
  return map;
}

// Hand-off Opportunity → Ghi danh (xem reference_ghl_app_management_pattern: Opportunity là phễu 1 chiều,
// bàn giao DUY NHẤT 1 lần khi tới đích): webhook OpportunityStageUpdate gọi hàm này mỗi lần 1 deal đổi giai
// đoạn; chỉ xử lý khi đổi ĐÚNG sang giai đoạn tên "Đã ghi danh". Chỉ tạo Học Viên (tên lấy từ tên deal — quy
// ước nhân viên đặt tên deal theo tên học viên) + nối Contact của deal làm Phụ huynh + nối Opportunity↔Học
// Viên để truy vết. CHƯA xếp lớp/tạo Ghi danh thật ở đây vì lúc Won chưa chắc đã biết lớp cụ thể — nhân viên
// xếp lớp/ghi danh thủ công qua app như hiện tại (xem enrollStudent). Idempotent: webhook có thể gọi lại
// nhiều lần cho cùng 1 lần đổi giai đoạn — kiểm tra quan hệ Opportunity↔Học Viên đã có chưa trước khi tạo mới.
export async function handleOpportunityStageWebhook(locationId, { opportunityId, pipelineStageId, contactId, name }) {
  const t = await getTenantState(locationId);
  if (!writerConfigured(t.tenant)) return { skipped: "writer_disabled" };
  const stageNames = await getPipelineStageNames(t);
  if (stageNames.get(pipelineStageId) !== GHI_DANH_STAGE_NAME) return { skipped: "not_ghi_danh_stage" };

  const relAssocId = await assocId(t, "opportunity_hoc_vien").catch(() => null);
  if (relAssocId) {
    const rel = await ghl(t, "GET", `/associations/relations/${opportunityId}?associationIds=${relAssocId}&locationId=${t.LOC}`).catch(() => null);
    if (rel && (rel.relations || []).length) return { skipped: "already_handled", hocVienId: rel.relations[0].firstRecordId };
  }

  const studentName = (name || "").trim();
  if (!studentName) return { skipped: "no_name" };

  const { hocVienId } = await createHocVien(locationId, { name: studentName });
  if (contactId) {
    await lienKetPhuHuynhHocVien(locationId, { contactId, hocVienId })
      .catch((e) => console.error(`[opportunity-handoff] Không nối được phụ huynh (${contactId}) cho học viên ${hocVienId}:`, e.message));
  }
  if (relAssocId) {
    await ghl(t, "POST", "/associations/relations", { locationId: t.LOC, associationId: relAssocId, firstRecordId: hocVienId, secondRecordId: opportunityId })
      .catch((e) => console.error(`[opportunity-handoff] Không nối được Opportunity↔Học viên:`, e.message));
  }
  return { hocVienId, contactId, studentName };
}
