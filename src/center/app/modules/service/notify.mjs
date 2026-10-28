// Thông báo tự động qua Zalo ZNS cho module service. Workflow của contact trong GHL (đặt lịch, điều kiện, chờ) chỉ gọi
// 1 Webhook thường tới /webhooks/notify kèm template_key; mọi thứ còn lại — tìm phiếu/hợp đồng liên quan, ghép tham số
// theo mẫu, chống gửi trùng, gửi ZNS — do server làm. Nội dung mẫu (id ZNS, ánh xạ tham số, bật/tắt) là CẤU HÌNH lưu DB,
// sửa trên màn hình quản trị, không cần sửa code. Chỉ thêm LOẠI dữ liệu mới / tham số tính toán mới mới phải sửa code.
import crypto from "crypto";
import { OBJ, OPTIONS } from "./schema.mjs";
import { flat, cleanText } from "./logic.mjs";

const label = (group, key) => (OPTIONS[group].find(([k]) => k === key) || [])[1] || key || "";
const digits = (p) => { const d = String(p || "").replace(/\D/g, ""); return d.startsWith("84") ? "0" + d.slice(2) : d; };

// Khoá URL riêng từng sub-account (cùng cách làm với ZNS của module Zalo): không cần lưu DB, không đoán được.
const secret = () => process.env.SERVICE_NOTIFY_KEY_SECRET || process.env.ZALO_ZNS_KEY_SECRET || process.env.TENANT_CREDENTIAL_ENCRYPTION_KEY || (process.env.SERVICE_DEV_LOCATION ? "dev-only-notify-secret" : "");
export const notifyKey = (loc) => { if (!secret()) throw new Error("Server thiếu SERVICE_NOTIFY_KEY_SECRET"); return crypto.createHmac("sha256", secret()).update(`notify:${loc}`).digest("hex").slice(0, 32); };
export const notifyKeyValid = (loc, k) => { try { const a = Buffer.from(notifyKey(loc)), b = Buffer.from(String(k || "")); return a.length === b.length && crypto.timingSafeEqual(a, b); } catch { return false; } };

// Biến dùng được trong tham số mẫu, theo loại dữ liệu. {{ten_bien}} → giá trị; không có thì chuỗi rỗng.
export const SUBJECTS = {
  phieu: {
    label: "Phiếu dịch vụ (khách báo)",
    vars: ["ma_phieu", "loai", "uu_tien", "trang_thai", "mo_ta", "ngay_hen", "thang", "cong_trinh", "nguoi_phu_trach", "nguoi_bao"],
  },
};

// Mẫu mặc định (tắt, chưa có id ZNS): admin chỉ việc điền id ZNS + ánh xạ tham số rồi bật.
export const DEFAULT_TEMPLATES = [
  { key: "phieu_da_nhan", label: "Báo khách: đã nhận phiếu", subject: "phieu", when: { trang_thai: ["moi", "da_giao"] }, zns_template_id: "", params: { ma_phieu: "{{ma_phieu}}", thang: "{{thang}}" }, enabled: false },
  { key: "phieu_dang_xu_ly", label: "Báo khách: kỹ thuật đang xử lý", subject: "phieu", when: { trang_thai: ["dang_xu_ly"] }, zns_template_id: "", params: { ma_phieu: "{{ma_phieu}}", nguoi_phu_trach: "{{nguoi_phu_trach}}" }, enabled: false },
  { key: "phieu_hoan_thanh", label: "Báo khách: đã hoàn thành", subject: "phieu", when: { trang_thai: ["hoan_thanh"] }, zns_template_id: "", params: { ma_phieu: "{{ma_phieu}}", thang: "{{thang}}" }, enabled: false },
];

const render = (tpl, vars) => String(tpl).replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, k) => cleanText(vars[k] ?? "", 200));

// --- tìm dữ liệu liên quan tới contact ---------------------------------------------------------------------
// Hiện khớp theo SĐT người báo ghi trên phiếu (đã có sẵn). Khi có association Phiếu–Contact thì thay bằng tra liên kết.
export async function findPhieuForContact(ghl, { phone, contactId }, tpl) {
  const want = digits(phone); if (!want && !contactId) return null;
  const [orders, units, sites] = await Promise.all([OBJ.order, OBJ.unit, OBJ.site].map((k) => ghl.listAll(k))).then((r) => r.map((rows) => rows.map(flat)));
  const states = tpl?.when?.trang_thai;
  const mine = orders.filter((o) => (want && digits(o.sdt_nguoi_bao) === want) && (!states?.length || states.includes(o.trang_thai)))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const o = mine[0]; if (!o) return null;
  const unit = units.find((u) => u.id === o.thang_may_id), site = sites.find((s) => s.id === (o.cong_trinh_id || unit?.cong_trinh_id));
  return {
    subjectId: o.id, state: o.trang_thai,
    vars: { ma_phieu: o.name, loai: label("orderType", o.loai), uu_tien: label("orderPriority", o.uu_tien), trang_thai: label("orderStatus", o.trang_thai), mo_ta: o.mo_ta, ngay_hen: o.ngay_hen, thang: unit?.name, cong_trinh: site?.name, nguoi_phu_trach: o.nguoi_phu_trach, nguoi_bao: o.nguoi_bao },
  };
}
const FINDERS = { phieu: findPhieuForContact };

// --- lưu cấu hình + nhật ký (DB thật, hoặc bộ nhớ khi test) ----------------------------------------------------
export function memoryStore() {
  const tpls = new Map(), log = new Map();
  return {
    async list(loc) { return [...(tpls.get(loc) || new Map()).values()]; },
    async get(loc, key) { return tpls.get(loc)?.get(key) || null; },
    async save(loc, t) { (tpls.get(loc) || tpls.set(loc, new Map()).get(loc)).set(t.key, t); },
    async claim(loc, dedupeKey) { const k = `${loc}|${dedupeKey}`; if (log.has(k)) return false; log.set(k, "claimed"); return true; },
    async release(loc, dedupeKey) { log.delete(`${loc}|${dedupeKey}`); },
  };
}
let ready;
export function dbStore() {
  const q = async (sql, p) => (await import("../../db.mjs")).platformQuery(sql, p);
  const ensure = () => (ready ||= q(`create table if not exists platform.service_notify_templates (location_id text not null, key text not null, config jsonb not null, updated_at timestamptz not null default now(), primary key (location_id, key))`)
    .then(() => q(`create table if not exists platform.service_notify_log (location_id text not null, dedupe_key text not null, at timestamptz not null default now(), primary key (location_id, dedupe_key))`)));
  return {
    async list(loc) { await ensure(); return (await q("select config from platform.service_notify_templates where location_id=$1", [loc])).rows.map((r) => r.config); },
    async get(loc, key) { await ensure(); return (await q("select config from platform.service_notify_templates where location_id=$1 and key=$2", [loc, key])).rows[0]?.config || null; },
    async save(loc, t) { await ensure(); await q("insert into platform.service_notify_templates (location_id, key, config) values ($1,$2,$3) on conflict (location_id, key) do update set config=$3, updated_at=now()", [loc, t.key, JSON.stringify(t)]); },
    // Chiếm chỗ nguyên tử: chỉ 1 request thắng → webhook GHL bị gọi lặp (retry) không gửi 2 lần.
    async claim(loc, dedupeKey) { await ensure(); return (await q("insert into platform.service_notify_log (location_id, dedupe_key) values ($1,$2) on conflict do nothing", [loc, dedupeKey])).rowCount === 1; },
    async release(loc, dedupeKey) { await ensure(); await q("delete from platform.service_notify_log where location_id=$1 and dedupe_key=$2", [loc, dedupeKey]); },
  };
}

// Cấu hình hiệu lực = mẫu mặc định chồng mẫu admin đã lưu.
export async function effectiveTemplates(store, loc) {
  const saved = new Map((await store.list(loc)).map((t) => [t.key, t]));
  return [...DEFAULT_TEMPLATES.map((d) => ({ ...d, ...(saved.get(d.key) || {}) })), ...[...saved.values()].filter((t) => !DEFAULT_TEMPLATES.some((d) => d.key === t.key))];
}
export function validateTemplate(i) {
  const key = String(i?.key || "").trim(); if (!/^[a-z0-9_]{2,40}$/.test(key)) throw Object.assign(new Error("Khoá mẫu chỉ gồm chữ thường, số, gạch dưới (2–40 ký tự)"), { status: 400 });
  if (!SUBJECTS[i.subject]) throw Object.assign(new Error("Loại dữ liệu không hợp lệ"), { status: 400 });
  const params = {}; for (const [k, v] of Object.entries(i.params || {})) { if (!/^[A-Za-z0-9_]{1,40}$/.test(k)) throw Object.assign(new Error(`Tên tham số ZNS không hợp lệ: ${k}`), { status: 400 }); params[k] = cleanText(v, 200); }
  const states = [].concat(i.when?.trang_thai || []).filter((s) => OPTIONS.orderStatus.some(([k]) => k === s));
  return { key, label: cleanText(i.label, 100) || key, subject: i.subject, when: { trang_thai: states }, zns_template_id: cleanText(i.zns_template_id, 40), params, enabled: !!i.enabled };
}

// --- xử lý webhook ---------------------------------------------------------------------------------------
// Trả { http, body } như handleZnsWebhook: 200 = xong/lỗi vĩnh viễn (không thử lại), 502 = lỗi tạm thời (GHL tự thử lại).
export async function handleNotify({ loc, payload, ghl, store, sendZns, now = () => new Date() }) {
  const cd = payload.customData || {};
  const pick = (...ks) => { for (const k of ks) { const v = cd[k] ?? payload[k]; if (v !== undefined && v !== null && v !== "") return v; } };
  const key = String(pick("template_key", "templateKey") || "");
  const phone = pick("phone", "number"), contactId = pick("contact_id", "contactId");
  const fail = (error, extra = {}) => ({ http: 200, body: { ok: false, permanent: true, error, ...extra } });
  if (!key) return fail("Thiếu template_key");
  const tpl = (await effectiveTemplates(store, loc)).find((t) => t.key === key);
  if (!tpl) return fail(`Không có mẫu "${key}"`);
  if (!tpl.enabled) return { http: 200, body: { ok: true, skipped: "Mẫu đang tắt" } };
  if (!tpl.zns_template_id) return fail(`Mẫu "${key}" chưa có id mẫu ZNS`);
  if (!phone) return fail("Contact không có số điện thoại");
  const found = await FINDERS[tpl.subject](ghl, { phone, contactId }, tpl);
  if (!found) return { http: 200, body: { ok: true, skipped: "Không có dữ liệu phù hợp để gửi (không phiếu nào khớp SĐT và điều kiện)" } };
  // 1 mẫu chỉ gửi 1 lần cho mỗi (đối tượng, trạng thái): workflow chạy lại / webhook bị gọi lặp không làm khách nhận trùng.
  const dedupeKey = `${key}|${found.subjectId}|${found.state}`;
  if (!(await store.claim(loc, dedupeKey))) return { http: 200, body: { ok: true, skipped: "Đã gửi trước đó cho trạng thái này" } };
  const data = Object.fromEntries(Object.entries(tpl.params).map(([k, v]) => [k, render(v, found.vars)]));
  let r;
  try { r = await sendZns(loc, { template_id: tpl.zns_template_id, template_data: data, phone, contact_id: contactId }); }
  catch (e) { await store.release(loc, dedupeKey); return { http: 502, body: { ok: false, permanent: false, error: e.message } }; }
  if (!r?.body?.ok) await store.release(loc, dedupeKey); // gửi hỏng thì cho phép thử lại lần sau
  return { http: r?.http ?? 200, body: { ...(r?.body || {}), key, subjectId: found.subjectId } };
}

// Gửi thật: dùng lại đường gửi ZNS của module Zalo (đã có xử lý lỗi Zalo, log đồng bộ, ghi vào Conversations).
export const defaultSendZns = async (loc, body) => (await import("../../zalo-oa.mjs")).handleZnsWebhook(loc, body);
