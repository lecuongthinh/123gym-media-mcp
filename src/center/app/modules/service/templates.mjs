// Mẫu công việc (tiến độ dự án): bộ giai đoạn + công việc chuẩn, sinh sẵn khi tạo dự án. Mẫu là CẤU HÌNH theo từng khách (lưu DB,
// sửa trên màn hình quản trị), không phải code — ngành khác chỉ cần mẫu khác. Mẫu mặc định cho thang máy CHƯA xác minh với quy
// trình thật của ELUX: chỉ là điểm khởi đầu để sửa.
import { cleanText } from "./logic.mjs";

// Mỗi dòng: [giai đoạn, tên, ngày bắt đầu (cách ngày khởi công), số ngày, là mốc?]
const row = (gd, name, offset, days, moc = false) => ({ giai_doan: gd, name, offset, days, moc });
export const DEFAULT_TASK_TEMPLATES = [
  {
    key: "lap_dat_thang_may", label: "Lắp đặt thang máy",
    items: [
      row("Ký hợp đồng", "Ký hợp đồng", 0, 1, true), row("Ký hợp đồng", "Thu tạm ứng", 0, 7),
      row("Đặt hàng", "Chốt thông số kỹ thuật", 3, 5), row("Đặt hàng", "Đặt hàng nhà máy", 8, 3), row("Đặt hàng", "Sản xuất và vận chuyển", 11, 60),
      row("Giao hàng", "Giao hàng về công trình", 71, 1, true),
      row("Lắp đặt", "Kiểm tra hố thang", 71, 3), row("Lắp đặt", "Lắp ray và khung", 74, 10), row("Lắp đặt", "Lắp máy kéo và cabin", 84, 10), row("Lắp đặt", "Đấu nối điện, điều khiển", 94, 7),
      row("Chạy thử", "Chạy thử và tự kiểm tra", 101, 5), row("Chạy thử", "Khắc phục tồn đọng (punch list)", 106, 3),
      row("Kiểm định", "Nộp hồ sơ kiểm định", 109, 3), row("Kiểm định", "Kiểm định bởi đơn vị có thẩm quyền", 115, 1, true),
      row("Nghiệm thu", "Nghiệm thu bàn giao", 118, 1, true), row("Nghiệm thu", "Đào tạo vận hành cho khách", 118, 1),
      row("Bảo hành", "Bắt đầu bảo hành", 119, 1, true),
    ],
  },
];

// Văn bản ↔ danh sách (để sửa trên màn hình): mỗi dòng  Giai đoạn | Tên | Bắt đầu (+ngày) | Số ngày | moc
export const itemsToText = (items) => items.map((i) => [i.giai_doan, i.name, i.offset, i.days, i.moc ? "moc" : ""].join(" | ").replace(/ \| $/, "")).join("\n");
export function textToItems(text) {
  const out = [];
  String(text || "").split("\n").forEach((ln, idx) => {
    if (!ln.trim()) return;
    const c = ln.split("|").map((x) => x.trim());
    const err = (m) => Object.assign(new Error(`Dòng ${idx + 1}: ${m}`), { status: 400 });
    if (c.length < 4) throw err("cần dạng  Giai đoạn | Tên | Bắt đầu (số ngày) | Số ngày | moc");
    const offset = Number(c[2]), days = Number(c[3]);
    if (!c[1]) throw err("thiếu tên công việc");
    if (!Number.isInteger(offset) || offset < 0 || offset > 3650) throw err("ngày bắt đầu phải là số nguyên 0–3650");
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw err("số ngày phải là số nguyên 1–3650");
    out.push({ giai_doan: cleanText(c[0], 60), name: cleanText(c[1], 120), offset, days, moc: (c[4] || "").toLowerCase() === "moc" });
  });
  if (!out.length) throw Object.assign(new Error("Mẫu cần ít nhất 1 công việc"), { status: 400 });
  if (out.length > 200) throw Object.assign(new Error("Tối đa 200 công việc/mẫu"), { status: 400 });
  return out;
}
export function validateTaskTemplate(i) {
  const key = String(i?.key || "").trim();
  if (!/^[a-z0-9_]{2,40}$/.test(key)) throw Object.assign(new Error("Khoá mẫu chỉ gồm chữ thường, số, gạch dưới (2–40 ký tự)"), { status: 400 });
  return { key, label: cleanText(i.label, 100) || key, items: Array.isArray(i.items) ? textToItems(itemsToText(i.items)) : textToItems(i.text) };
}

// --- lưu cấu hình (DB thật, hoặc bộ nhớ khi test) ---------------------------------------------------------
export function memoryStore() {
  const m = new Map();
  return { async list(loc) { return [...(m.get(loc) || new Map()).values()]; }, async save(loc, t) { (m.get(loc) || m.set(loc, new Map()).get(loc)).set(t.key, t); } };
}
let ready;
export function dbStore() {
  const q = async (sql, p) => (await import("../../db.mjs")).platformQuery(sql, p);
  const ensure = () => (ready ||= q(`create table if not exists platform.service_task_templates (location_id text not null, key text not null, config jsonb not null, updated_at timestamptz not null default now(), primary key (location_id, key))`));
  return {
    async list(loc) { await ensure(); return (await q("select config from platform.service_task_templates where location_id=$1", [loc])).rows.map((r) => r.config); },
    async save(loc, t) { await ensure(); await q("insert into platform.service_task_templates (location_id, key, config) values ($1,$2,$3) on conflict (location_id, key) do update set config=$3, updated_at=now()", [loc, t.key, JSON.stringify(t)]); },
  };
}
// Mẫu hiệu lực = mẫu mặc định chồng mẫu khách đã lưu.
export async function effectiveTaskTemplates(store, loc) {
  const saved = new Map((await store.list(loc)).map((t) => [t.key, t]));
  return [...DEFAULT_TASK_TEMPLATES.map((d) => saved.get(d.key) || d), ...[...saved.values()].filter((t) => !DEFAULT_TASK_TEMPLATES.some((d) => d.key === t.key))];
}
