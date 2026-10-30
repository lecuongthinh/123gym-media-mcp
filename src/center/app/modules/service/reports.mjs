// Biên bản làm việc của phiếu: checklist theo mẫu, ảnh, chữ ký khách, giờ bắt đầu. Lưu ở DB riêng của module (không đổi lược đồ GHL,
// không cần cài lại app). Mẫu checklist là CẤU HÌNH theo từng khách (sửa trên màn hình quản trị), gán theo loại phiếu — ngành khác chỉ cần mẫu khác.
// Biên bản giữ BẢN CHỤP của mẫu lúc bắt đầu điền, nên sửa mẫu sau này không làm đổi các biên bản cũ.
import crypto from "crypto";
import { cleanText } from "./logic.mjs";
import { isOption } from "./schema.mjs";
import { UserError } from "./service.mjs";

export const RESULTS = ["dat", "khong_dat", "na"];
export const MAX_PHOTOS = 12, MAX_PHOTO_BYTES = 150_000, MAX_SIGN_BYTES = 60_000;
const it = (g, t, req = true) => ({ g, t, req });

// Mẫu mặc định cho thang máy: điểm khởi đầu để sửa, CHƯA xác minh với quy trình của khách cụ thể.
export const DEFAULT_CHECKLISTS = [
  { key: "bao_tri_dinh_ky", label: "Bảo trì định kỳ", types: ["bao_tri_dinh_ky"], min_photos: 1, need_signature: true, items: [
    it("Phòng máy", "Vệ sinh phòng máy, kiểm tra tủ điều khiển và dây dẫn"), it("Phòng máy", "Kiểm tra máy kéo, phanh, độ ồn và rung"),
    it("Hố thang", "Vệ sinh hố thang, kiểm tra nước và độ khô"), it("Hố thang", "Kiểm tra giảm chấn, cáp và bộ hạn chế tốc độ"),
    it("Nóc cabin", "Kiểm tra công tắc an toàn, ray dẫn hướng, bôi trơn"), it("Nóc cabin", "Kiểm tra bộ điều khiển cửa"),
    it("Trong cabin", "Kiểm tra nút bấm, đèn, quạt, chuông và liên lạc khẩn cấp"), it("Trong cabin", "Kiểm tra độ bằng tầng khi dừng"),
    it("Cửa tầng", "Kiểm tra cửa tầng, khoá cửa và công tắc cửa"), it("An toàn", "Thử cứu hộ và các thiết bị an toàn", false),
  ] },
  { key: "su_co", label: "Xử lý sự cố / sửa chữa", types: ["su_co", "sua_chua", "bao_hanh"], min_photos: 1, need_signature: true, items: [
    it("Xử lý", "Đã xác định nguyên nhân"), it("Xử lý", "Đã khắc phục hoặc thay thế (ghi rõ vật tư ở ô ghi chú)"), it("Xử lý", "Đã chạy thử nhiều lần sau khi sửa"),
    it("Bàn giao", "Thang hoạt động bình thường"), it("Bàn giao", "Đã thông báo cho khách"),
  ] },
];

// Văn bản ↔ danh sách mục (để sửa trên màn hình): mỗi dòng  Nhóm | Nội dung | tuỳ chọn   (cột cuối trống = bắt buộc)
export const itemsToText = (items) => items.map((i) => [i.g, i.t, i.req ? "" : "tuỳ chọn"].join(" | ").replace(/ \| $/, "")).join("\n");
const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").toLowerCase().replace(/\s+/g, "");
export function textToItems(text) {
  const out = [];
  String(text || "").split("\n").forEach((ln, idx) => {
    if (!ln.trim()) return;
    const c = ln.split("|").map((x) => x.trim());
    const err = (m) => Object.assign(new Error(`Dòng ${idx + 1}: ${m}`), { status: 400 });
    if (c.length < 2 || !c[1]) throw err("cần dạng  Nhóm | Nội dung | tuỳ chọn");
    out.push({ g: cleanText(c[0], 60) || "Chung", t: cleanText(c[1], 160), req: !["tuychon", "optional"].includes(fold(c[2])) });
  });
  if (!out.length) throw Object.assign(new Error("Mẫu cần ít nhất 1 mục"), { status: 400 });
  if (out.length > 60) throw Object.assign(new Error("Tối đa 60 mục/mẫu"), { status: 400 });
  return out;
}
export function validateChecklist(i) {
  const key = String(i?.key || "").trim();
  if (!/^[a-z0-9_]{2,40}$/.test(key)) throw Object.assign(new Error("Khoá mẫu chỉ gồm chữ thường, số, gạch dưới (2–40 ký tự)"), { status: 400 });
  const types = [...new Set([].concat(i.types || []).filter((t) => isOption("orderType", t)))];
  if (!types.length) throw Object.assign(new Error("Chọn ít nhất một loại phiếu áp dụng"), { status: 400 });
  const min = Number(i.min_photos ?? 0);
  if (!Number.isInteger(min) || min < 0 || min > 10) throw Object.assign(new Error("Số ảnh tối thiểu từ 0 đến 10"), { status: 400 });
  return { key, label: cleanText(i.label, 100) || key, types, min_photos: min, need_signature: !!i.need_signature, items: textToItems(i.text ?? itemsToText(i.items || [])) };
}
export const effectiveChecklists = async (store, loc) => {
  const saved = new Map((await store.list(loc)).map((t) => [t.key, t]));
  return [...DEFAULT_CHECKLISTS.map((d) => saved.get(d.key) || d), ...[...saved.values()].filter((t) => !DEFAULT_CHECKLISTS.some((d) => d.key === t.key))];
};
// Mẫu áp dụng cho 1 loại phiếu (mẫu không có mục nào = không yêu cầu gì).
export const templateFor = (list, type) => list.find((t) => t.types.includes(type) && t.items.length) || null;
const snapshot = (t) => ({ key: t.key, label: t.label, min_photos: t.min_photos, need_signature: t.need_signature, items: t.items.map((x) => ({ g: x.g, t: x.t, req: x.req })) });

// --- quy tắc đủ/thiếu -------------------------------------------------------------------------------------
export function missing(report) {
  const tpl = report?.tpl; if (!tpl) return [];
  const out = [], ans = report.answers || [];
  tpl.items.forEach((x, i) => {
    const a = ans[i] || {};
    if (x.req && !a.r) out.push(`Chưa trả lời: ${x.t}`);
    else if (a.r === "khong_dat" && !cleanText(a.note, 300)) out.push(`Ghi chú mục không đạt: ${x.t}`);
  });
  const photos = (report.photos || []).length;
  if (photos < (tpl.min_photos || 0)) out.push(`Cần thêm ${tpl.min_photos - photos} ảnh (tối thiểu ${tpl.min_photos})`);
  if (tpl.need_signature && !report.signature && !report.no_sign) out.push("Cần khách ký (hoặc chọn “khách không có mặt”)");
  return out;
}
export function summary(report) {
  const ans = report?.answers || [], n = (r) => ans.filter((a) => a && a.r === r).length;
  const parts = [`Checklist: ${n("dat")} đạt, ${n("khong_dat")} không đạt, ${n("na")} không áp dụng`];
  if ((report.photos || []).length) parts.push(`${report.photos.length} ảnh`);
  parts.push(report.signature ? `khách ${report.signature.signer ? report.signature.signer + " " : ""}đã ký` : report.no_sign ? `khách không có mặt${report.no_sign.reason ? " (" + report.no_sign.reason + ")" : ""}` : "chưa có chữ ký");
  return parts.join(" · ");
}

// --- tệp ảnh / chữ ký -------------------------------------------------------------------------------------
export function parseImage(dataUrl, { png = false, max }) {
  const m = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || "")); if (!m) throw new UserError("Ảnh không hợp lệ");
  const bytes = Buffer.from(m[2], "base64"); if (!bytes.length) throw new UserError("Ảnh rỗng");
  if (bytes.length > max) throw new UserError(`Ảnh quá lớn (tối đa ${Math.round(max / 1000)} KB sau khi nén)`, 413);
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff, isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (png ? !isPng : !(isJpg || isPng)) throw new UserError("Ảnh không đúng định dạng");
  return { mime: isPng ? "image/png" : "image/jpeg", bytes };
}

// --- kho lưu (DB thật, hoặc bộ nhớ khi chạy thử/test) ------------------------------------------------------
export function memoryReportStore() {
  const reports = new Map(), files = new Map(), tpls = new Map();
  return {
    async list(loc) { return [...(tpls.get(loc) || new Map()).values()]; },
    async save(loc, t) { (tpls.get(loc) || tpls.set(loc, new Map()).get(loc)).set(t.key, t); },
    async get(loc, id) { const r = reports.get(`${loc}|${id}`); return r ? JSON.parse(JSON.stringify(r)) : null; },
    async put(loc, id, data) { reports.set(`${loc}|${id}`, JSON.parse(JSON.stringify(data))); },
    async addFile(loc, f) { files.set(`${loc}|${f.id}`, f); },
    async getFile(loc, id) { return files.get(`${loc}|${id}`) || null; },
    async delFile(loc, id) { files.delete(`${loc}|${id}`); },
  };
}
let ready;
export function dbReportStore() {
  const q = async (sql, p) => (await import("../../db.mjs")).platformQuery(sql, p);
  const ensure = () => (ready ||= q(`create table if not exists platform.service_checklist_templates (location_id text not null, key text not null, config jsonb not null, updated_at timestamptz not null default now(), primary key (location_id, key))`)
    .then(() => q(`create table if not exists platform.service_reports (location_id text not null, phieu_id text not null, data jsonb not null, updated_at timestamptz not null default now(), primary key (location_id, phieu_id))`))
    .then(() => q(`create table if not exists platform.service_files (location_id text not null, id text not null, phieu_id text not null, kind text not null, mime text not null, bytes bytea not null, created_at timestamptz not null default now(), primary key (location_id, id))`)));
  return {
    async list(loc) { await ensure(); return (await q("select config from platform.service_checklist_templates where location_id=$1", [loc])).rows.map((r) => r.config); },
    async save(loc, t) { await ensure(); await q("insert into platform.service_checklist_templates (location_id, key, config) values ($1,$2,$3) on conflict (location_id, key) do update set config=$3, updated_at=now()", [loc, t.key, JSON.stringify(t)]); },
    async get(loc, id) { await ensure(); return (await q("select data from platform.service_reports where location_id=$1 and phieu_id=$2", [loc, id])).rows[0]?.data || null; },
    async put(loc, id, data) { await ensure(); await q("insert into platform.service_reports (location_id, phieu_id, data) values ($1,$2,$3) on conflict (location_id, phieu_id) do update set data=$3, updated_at=now()", [loc, id, JSON.stringify(data)]); },
    async addFile(loc, f) { await ensure(); await q("insert into platform.service_files (location_id, id, phieu_id, kind, mime, bytes) values ($1,$2,$3,$4,$5,$6)", [loc, f.id, f.phieuId, f.kind, f.mime, f.bytes]); },
    async getFile(loc, id) { await ensure(); const r = (await q("select id, phieu_id, kind, mime, bytes from platform.service_files where location_id=$1 and id=$2", [loc, id])).rows[0]; return r ? { id: r.id, phieuId: r.phieu_id, kind: r.kind, mime: r.mime, bytes: r.bytes } : null; },
    async delFile(loc, id) { await ensure(); await q("delete from platform.service_files where location_id=$1 and id=$2", [loc, id]); },
  };
}

// --- thao tác trên biên bản ---------------------------------------------------------------------------------
const blank = () => ({ tpl: null, answers: [], photos: [], signature: null, no_sign: null, started_at: null });
async function load(store, loc, order, templates) {
  const report = (await store.get(loc, order.id)) || blank();
  if (!report.tpl) { const t = templateFor(templates, order.loai); if (t) report.tpl = snapshot(t); }
  return report;
}
// Cái màn hình cần: mẫu đang áp dụng + biên bản + danh sách còn thiếu.
export async function view({ store, loc, order, templates }) {
  const report = await load(store, loc, order, templates);
  return { tpl: report.tpl, report: { answers: report.answers, photos: report.photos, signature: report.signature, no_sign: report.no_sign, started_at: report.started_at }, missing: missing(report) };
}
const open = (order) => { if (["hoan_thanh", "huy"].includes(order.trang_thai)) throw new UserError("Phiếu đã đóng, không sửa được biên bản", 403); };

export async function saveAnswers({ store, loc, order, templates, answers }) {
  open(order); const report = await load(store, loc, order, templates); if (!report.tpl) throw new UserError("Loại phiếu này không có checklist");
  const list = Array.isArray(answers) ? answers : []; if (list.length > report.tpl.items.length) throw new UserError("Số mục trả lời vượt mẫu");
  report.answers = report.tpl.items.map((_, i) => { const a = list[i] || {}; const r = RESULTS.includes(a.r) ? a.r : ""; return r ? { r, note: cleanText(a.note, 300) } : {}; });
  await store.put(loc, order.id, report); return { ok: true, missing: missing(report) };
}
// Ảnh ưu tiên lên Media Library của GHL (không tốn DB, văn phòng xem được trong GHL). `media` = { upload, remove } hoặc null;
// chưa có scope / upload lỗi thì tự lưu vào DB của module — thợ không bị chặn việc vì cấu hình.
export async function addPhoto({ store, loc, order, templates, dataUrl, media = null }) {
  open(order); const report = await load(store, loc, order, templates);
  if (report.photos.length >= MAX_PHOTOS) throw new UserError(`Tối đa ${MAX_PHOTOS} ảnh mỗi phiếu`);
  const { mime, bytes } = parseImage(dataUrl, { max: MAX_PHOTO_BYTES }); const at = new Date().toISOString(); let entry;
  if (media) {
    try { const m = await media.upload({ bytes, mime, name: `${order.name || order.id}-${Date.now()}.${mime === "image/png" ? "png" : "jpg"}` }); entry = { id: m.id, at, url: m.url, media: true }; }
    catch (e) { console.error("[service] upload Media Library lỗi, lưu vào DB:", e.message); }
  }
  if (!entry) { const id = crypto.randomUUID(); await store.addFile(loc, { id, phieuId: order.id, kind: "photo", mime, bytes }); entry = { id, at }; }
  report.photos.push(entry); await store.put(loc, order.id, report); return { id: entry.id, url: entry.url || null, missing: missing(report) };
}
export async function removePhoto({ store, loc, order, templates, id, media = null }) {
  open(order); const report = await load(store, loc, order, templates);
  const p = report.photos.find((x) => x.id === id); if (!p) throw new UserError("Không tìm thấy ảnh", 404);
  report.photos = report.photos.filter((x) => x.id !== id); await store.put(loc, order.id, report);
  if (p.media) { if (media) await media.remove(id).catch((e) => console.error("[service] xoá ảnh Media Library lỗi:", e.message)); } else await store.delFile(loc, id);
  return { ok: true, missing: missing(report) };
}
export async function setSignature({ store, loc, order, templates, dataUrl, signer }) {
  open(order); const report = await load(store, loc, order, templates);
  const { mime, bytes } = parseImage(dataUrl, { png: true, max: MAX_SIGN_BYTES }); const id = crypto.randomUUID();
  await store.addFile(loc, { id, phieuId: order.id, kind: "signature", mime, bytes });
  if (report.signature) await store.delFile(loc, report.signature.id);
  report.signature = { id, signer: cleanText(signer, 100), at: new Date().toISOString() }; report.no_sign = null;
  await store.put(loc, order.id, report); return { id, missing: missing(report) };
}
export async function setNoSign({ store, loc, order, templates, reason }) {
  open(order); const report = await load(store, loc, order, templates);
  if (report.signature) { await store.delFile(loc, report.signature.id); report.signature = null; }
  report.no_sign = reason === null ? null : { reason: cleanText(reason, 200) }; await store.put(loc, order.id, report); return { ok: true, missing: missing(report) };
}
// Thợ bấm "Đã đến, bắt đầu": ghi giờ bắt đầu (chỉ ghi lần đầu).
export async function markStarted({ store, loc, order, templates, at = new Date().toISOString() }) {
  const report = await load(store, loc, order, templates); if (report.started_at) return report.started_at;
  report.started_at = at; await store.put(loc, order.id, report); return at;
}
// Chặn hoàn thành khi biên bản chưa đủ. Quản trị có thể bỏ qua (skip) nhưng phải ghi kết quả bằng chữ (service.updateOrder đã bắt buộc).
// Biên bản đủ mà chưa gõ kết quả → tự điền bản tóm tắt (đỡ phải gõ lại).
export async function guardComplete({ store, loc, order, templates, patch, skip = false }) {
  const tpl = templateFor(templates, order.loai); if (!tpl) return;
  const report = await load(store, loc, order, templates); const miss = missing(report);
  if (miss.length && !skip) throw new UserError("Chưa đủ biên bản: " + miss.slice(0, 3).join("; ") + (miss.length > 3 ? ` (và ${miss.length - 3} mục nữa)` : ""), 409);
  if (!miss.length && !String(patch.ket_qua ?? order.ket_qua ?? "").trim()) patch.ket_qua = summary(report);
}
