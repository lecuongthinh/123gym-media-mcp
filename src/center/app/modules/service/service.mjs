// Nghiệp vụ của module service: đọc/gộp dữ liệu từ GHL, các thao tác (tạo, giao việc, sinh phiếu bảo trì định kỳ,
// kiểm định...) và kiểm tra đầu vào. Không đụng HTTP — index.mjs lo phần đó. Mọi giá trị ghi xuống GHL đều đi qua
// các hàm kiểm tra ở đây (liệt kê cố định các field cho phép, enum chỉ nhận key hợp lệ).
import { OBJ, OPTIONS, isOption, ORDER_CLOSED, INSPECTION_OPEN } from "./schema.mjs";
import { flat, computeDashboard, computeCharts, computeSales, planMaintenance, nextInspectionDate, isDate, cleanText, orderNumber, addMonths } from "./logic.mjs";

export class UserError extends Error { constructor(m, status = 400) { super(m); this.status = status; } }
const need = (cond, msg, status = 400) => { if (!cond) throw new UserError(msg, status); };
const str = (v, max = 200) => cleanText(v, max);
const num = (v, name) => { if (v === "" || v == null) return undefined; const n = Number(v); need(Number.isFinite(n) && n >= 0, `${name} phải là số không âm`); return n; };
const date = (v, name) => { if (!v) return undefined; need(isDate(v), `${name} không hợp lệ (cần YYYY-MM-DD)`); return v; };
const opt = (group, v, name) => { if (v == null || v === "") return undefined; need(isOption(group, v), `${name} không hợp lệ`); return v; };
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ""));

export async function loadAll(ghl, { fresh = false } = {}) {
  const [sites, units, contracts, orders, inspections, projects] = (await Promise.all([OBJ.site, OBJ.unit, OBJ.contract, OBJ.order, OBJ.inspection, OBJ.project].map((k) => ghl.listAll(k, { fresh })))).map((rows) => rows.map(flat));
  return { sites, units, contracts, orders, inspections, projects };
}
export async function getDashboard(ghl, today) { const d = await loadAll(ghl); return { ...computeDashboard(d, today), charts: computeCharts(d, today) }; }

// Dashboard kinh doanh: cơ hội GHL + hợp đồng lắp đặt. Thiếu quyền đọc cơ hội thì vẫn trả phần doanh số từ hợp đồng + cảnh báo rõ.
export async function getSales(ghl, today) {
  const contracts = (await ghl.listAll(OBJ.contract)).map(flat); let opps = [], pipelines = [], warning = null;
  try { [pipelines, opps] = await Promise.all([ghl.pipelines(), ghl.opportunities()]); } catch (e) { warning = "Chưa đọc được cơ hội bán hàng từ GHL (" + String(e.message).slice(0, 120) + "). Kiểm tra app đã được cấp quyền opportunities.readonly chưa."; }
  return { ...computeSales({ opps, pipelines, contracts }, today), warning };
}

const by = (arr) => new Map(arr.map((x) => [x.id, x]));
const label = (group, key) => (OPTIONS[group].find(([k]) => k === key) || [])[1] || key || "";

// Danh sách theo loại, đã gắn tên cha (công trình/thang) để hiển thị không cần gọi thêm.
export async function list(ghl, type) {
  const d = await loadAll(ghl); const S = by(d.sites), U = by(d.units), C = by(d.contracts);
  const byDate = (f) => (a, b) => String(b[f] || "").localeCompare(String(a[f] || ""));
  switch (type) {
    case "thang_may": return d.units.map((u) => ({ ...u, site: S.get(u.cong_trinh_id)?.name || "", hop_dong: C.get(u.hop_dong_bao_tri_id)?.name || "", openOrders: d.orders.filter((o) => o.thang_may_id === u.id && !ORDER_CLOSED.includes(o.trang_thai)).length })).sort((a, b) => a.name.localeCompare(b.name));
    case "cong_trinh": return d.sites.map((s) => ({ ...s, units: d.units.filter((u) => u.cong_trinh_id === s.id).length })).sort((a, b) => a.name.localeCompare(b.name));
    case "hop_dong": return d.contracts.map((c) => ({ ...c, site: S.get(c.cong_trinh_id)?.name || "", unitCount: String(c.thang_may_ids || "").split(",").filter(Boolean).length })).sort(byDate("ngay_het_han"));
    case "phieu": return d.orders.map((o) => ({ ...o, unit: U.get(o.thang_may_id)?.name || "", site: S.get(o.cong_trinh_id)?.name || "" })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    case "du_an": return d.projects.map((p) => ({ ...p, site: S.get(p.cong_trinh_id)?.name || "", hop_dong: C.get(p.hop_dong_id)?.name || "" })).sort(byDate("ngay_du_kien_ban_giao"));
    case "kiem_dinh": return d.inspections.map((k) => ({ ...k, unit: U.get(k.thang_may_id)?.name || "" })).sort(byDate("ngay_kiem_dinh"));
    default: throw new UserError("Loại dữ liệu không hợp lệ");
  }
}

export async function detail(ghl, type, id) {
  const d = await loadAll(ghl); const S = by(d.sites), U = by(d.units), C = by(d.contracts);
  const one = { thang_may: d.units, cong_trinh: d.sites, hop_dong: d.contracts, phieu: d.orders, du_an: d.projects, kiem_dinh: d.inspections }[type];
  need(one, "Loại dữ liệu không hợp lệ");
  const rec = one.find((x) => x.id === id); if (!rec) throw new UserError("Không tìm thấy", 404);
  const sortNew = (a) => a.sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));
  const out = { type, record: rec, related: {} };
  if (type === "thang_may") {
    out.related = { site: S.get(rec.cong_trinh_id) || null, hop_dong: C.get(rec.hop_dong_bao_tri_id) || null, phieu: sortNew(d.orders.filter((o) => o.thang_may_id === id)), kiem_dinh: sortNew(d.inspections.filter((k) => k.thang_may_id === id)) };
  } else if (type === "cong_trinh") {
    out.related = { thang_may: d.units.filter((u) => u.cong_trinh_id === id), hop_dong: d.contracts.filter((c) => c.cong_trinh_id === id), du_an: d.projects.filter((p) => p.cong_trinh_id === id), phieu: sortNew(d.orders.filter((o) => o.cong_trinh_id === id)).slice(0, 30) };
  } else if (type === "hop_dong") {
    const ids = String(rec.thang_may_ids || "").split(",").filter(Boolean);
    out.related = { site: S.get(rec.cong_trinh_id) || null, thang_may: ids.map((i) => U.get(i)).filter(Boolean), phieu: sortNew(d.orders.filter((o) => o.hop_dong_id === id)).slice(0, 60), du_an: d.projects.filter((p) => p.hop_dong_id === id) };
  } else if (type === "phieu") {
    out.related = { thang_may: U.get(rec.thang_may_id) || null, site: S.get(rec.cong_trinh_id) || null, hop_dong: C.get(rec.hop_dong_id) || null };
  } else if (type === "du_an") {
    out.related = { site: S.get(rec.cong_trinh_id) || null, hop_dong: C.get(rec.hop_dong_id) || null };
  } else if (type === "kiem_dinh") {
    out.related = { thang_may: U.get(rec.thang_may_id) || null };
  }
  return out;
}

// --- liên kết GHL (best-effort, không chặn thao tác: trường id đã là nguồn chính cho app) --------------------
const bgQueue = []; let bgRunning = false;
export function relateLater(ghl, assocKey, ids, extra) {
  bgQueue.push({ ghl, assocKey, ids, extra });
  if (bgRunning) return; bgRunning = true;
  (async () => {
    while (bgQueue.length) {
      const j = bgQueue.shift();
      try { await j.ghl.relate(j.assocKey, j.ids, j.extra); } catch (e) { console.error(`[service] relate ${j.assocKey} lỗi:`, e.message); }
      await new Promise((r) => setTimeout(r, 250));
    }
    bgRunning = false;
  })();
}
export const pendingRelations = () => bgQueue.length;

// --- tạo mới --------------------------------------------------------------------------------------------
export async function createSite(ghl, i) {
  const name = str(i.name, 150); need(name, "Cần tên công trình");
  const rec = await ghl.createRecord(OBJ.site, clean({ name, dia_chi: str(i.dia_chi), tinh_thanh: str(i.tinh_thanh, 60), loai_cong_trinh: opt("siteType", i.loai_cong_trinh, "Loại công trình"), so_tang: num(i.so_tang, "Số tầng"), ten_chu_dau_tu: str(i.ten_chu_dau_tu), nguoi_lien_he: str(i.nguoi_lien_he, 100), sdt_lien_he: str(i.sdt_lien_he, 30), ghi_chu: str(i.ghi_chu, 1000) }));
  return { id: rec.id };
}

export async function createUnit(ghl, i) {
  const name = str(i.name, 60); need(name, "Cần mã thang");
  const d = await loadAll(ghl);
  need(!d.units.some((u) => u.name.toLowerCase() === name.toLowerCase()), `Mã thang "${name}" đã tồn tại`);
  const site = d.sites.find((s) => s.id === i.cong_trinh_id); need(site, "Chọn công trình");
  const ngayBanGiao = date(i.ngay_ban_giao, "Ngày bàn giao");
  const hetBH = date(i.het_bao_hanh, "Hết bảo hành") || (ngayBanGiao && Number(i.bao_hanh_thang) > 0 ? addMonths(ngayBanGiao, Number(i.bao_hanh_thang)) : undefined);
  const chuKy = num(i.chu_ky_kiem_dinh_thang, "Chu kỳ kiểm định");
  const props = clean({
    name, cong_trinh_id: site.id, hang: str(i.hang, 60) || "ELUX", model: str(i.model, 60), so_serial: str(i.so_serial, 60), vi_tri: str(i.vi_tri, 100),
    loai: opt("unitType", i.loai, "Loại thang"), tai_trong_kg: num(i.tai_trong_kg, "Tải trọng"), so_diem_dung: num(i.so_diem_dung, "Số điểm dừng"), toc_do_m_s: num(i.toc_do_m_s, "Tốc độ"),
    ngay_ban_giao: ngayBanGiao, het_bao_hanh: hetBH, chu_ky_kiem_dinh_thang: chuKy, ngay_kiem_dinh_ke_tiep: date(i.ngay_kiem_dinh_ke_tiep, "Ngày kiểm định kế tiếp"),
    trang_thai: opt("unitStatus", i.trang_thai, "Trạng thái") || (ngayBanGiao ? "dang_bao_hanh" : "chua_ban_giao"),
  });
  const rec = await ghl.createRecord(OBJ.unit, props);
  relateLater(ghl, "thang_may_cong_trinh", { [OBJ.unit]: rec.id, [OBJ.site]: site.id });
  return { id: rec.id };
}

export async function createContract(ghl, i, today) {
  const name = str(i.name, 80); need(name, "Cần số hợp đồng");
  const loai = opt("contractType", i.loai, "Loại hợp đồng"); need(loai, "Chọn loại hợp đồng");
  const d = await loadAll(ghl);
  need(!d.contracts.some((c) => c.name.toLowerCase() === name.toLowerCase()), `Số hợp đồng "${name}" đã tồn tại`);
  const site = i.cong_trinh_id ? d.sites.find((s) => s.id === i.cong_trinh_id) : null; if (i.cong_trinh_id) need(site, "Công trình không tồn tại");
  const unitIds = [...new Set([].concat(i.thang_may_ids || []).filter(Boolean))];
  const units = unitIds.map((id) => d.units.find((u) => u.id === id)); need(units.every(Boolean), "Có thang không tồn tại");
  const ngayHL = date(i.ngay_hieu_luc, "Ngày hiệu lực"), ngayHH = date(i.ngay_het_han, "Ngày hết hạn");
  if (ngayHL && ngayHH) need(ngayHH >= ngayHL, "Ngày hết hạn phải sau ngày hiệu lực");
  if (loai === "bao_tri") need(unitIds.length > 0 && ngayHL && ngayHH, "Hợp đồng bảo trì cần chọn thang + ngày hiệu lực + ngày hết hạn");
  const status = opt("contractStatus", i.trang_thai, "Trạng thái") || "hieu_luc";
  if (loai === "bao_tri" && status === "hieu_luc") for (const u of units) if (u.hop_dong_bao_tri_id) { const old = d.contracts.find((c) => c.id === u.hop_dong_bao_tri_id); if (old && old.trang_thai === "hieu_luc") throw new UserError(`Thang ${u.name} đã thuộc hợp đồng bảo trì ${old.name} đang hiệu lực`); }
  const rec = await ghl.createRecord(OBJ.contract, clean({
    name, loai, trang_thai: status, gia_tri: num(i.gia_tri, "Giá trị"), ngay_hieu_luc: ngayHL, ngay_het_han: ngayHH,
    pham_vi_bao_tri: opt("contractScope", i.pham_vi_bao_tri, "Phạm vi"), tan_suat_bao_tri_thang: num(i.tan_suat_bao_tri_thang, "Tần suất"), sla_phan_hoi_gio: num(i.sla_phan_hoi_gio, "SLA"),
    ten_khach_hang: str(i.ten_khach_hang, 150), cong_trinh_id: site?.id, thang_may_ids: unitIds.join(","), so_hoa_don_ghl: str(i.so_hoa_don_ghl, 60),
  }));
  if (site) relateLater(ghl, "hop_dong_cong_trinh", { [OBJ.contract]: rec.id, [OBJ.site]: site.id });
  for (const u of units) {
    relateLater(ghl, "hop_dong_thang_may", { [OBJ.contract]: rec.id, [OBJ.unit]: u.id });
    if (loai === "bao_tri" && status === "hieu_luc") await ghl.updateRecord(OBJ.unit, u.id, { hop_dong_bao_tri_id: rec.id, trang_thai: "dang_bao_tri" });
  }
  let projectId = null;
  if (loai === "mua_ban_lap_dat" && i.tao_du_an !== false) {
    const p = await ghl.createRecord(OBJ.project, clean({ name: `Lắp đặt — ${name}`, giai_doan: "ky_hd", ngay_du_kien_ban_giao: date(i.ngay_du_kien_ban_giao, "Ngày dự kiến bàn giao"), quan_ly_du_an: str(i.quan_ly_du_an, 100), cong_trinh_id: site?.id, hop_dong_id: rec.id }));
    projectId = p.id; relateLater(ghl, "du_an_hop_dong", { [OBJ.project]: p.id, [OBJ.contract]: rec.id });
    if (site) relateLater(ghl, "du_an_cong_trinh", { [OBJ.project]: p.id, [OBJ.site]: site.id });
  }
  return { id: rec.id, projectId };
}

export async function createOrder(ghl, i, { today, source = "ung_dung", actor = "" } = {}) {
  const unit = (await ghl.listAll(OBJ.unit)).map(flat).find((u) => u.id === i.thang_may_id); need(unit, "Chọn thang máy");
  const loai = opt("orderType", i.loai, "Loại phiếu") || "su_co";
  const uuTien = opt("orderPriority", i.uu_tien, "Ưu tiên") || "binh_thuong";
  const moTa = str(i.mo_ta, 2000); need(moTa || loai === "bao_tri_dinh_ky", "Cần mô tả sự cố/công việc");
  const rec = await ghl.createRecord(OBJ.order, clean({
    name: orderNumber(today), loai, uu_tien: uuTien, trang_thai: "moi", mo_ta: moTa, ngay_hen: date(i.ngay_hen, "Ngày hẹn") || (uuTien === "khan_cap" ? today : undefined),
    thang_may_id: unit.id, cong_trinh_id: unit.cong_trinh_id, hop_dong_id: unit.hop_dong_bao_tri_id, nguon: opt("orderSource", source, "Nguồn"),
    nguoi_bao: str(i.nguoi_bao, 100) || actor, sdt_nguoi_bao: str(i.sdt_nguoi_bao, 30),
  }));
  relateLater(ghl, "phieu_thang_may", { [OBJ.order]: rec.id, [OBJ.unit]: unit.id });
  if (unit.hop_dong_bao_tri_id) relateLater(ghl, "phieu_hop_dong", { [OBJ.order]: rec.id, [OBJ.contract]: unit.hop_dong_bao_tri_id });
  return { id: rec.id, name: rec.properties?.name };
}

// Quyền cập nhật phiếu: quản trị sửa mọi thứ; nhân viên thường chỉ sửa phiếu của mình hoặc phiếu chưa ai nhận (để nhận việc).
export async function updateOrder(ghl, id, patch, { today, isAdmin, me }) {
  const cur = (await ghl.listAll(OBJ.order)).map(flat).find((o) => o.id === id); need(cur, "Không tìm thấy phiếu", 404);
  const mine = !cur.nguoi_phu_trach || (me.email && String(cur.nguoi_phu_trach).toLowerCase().includes(me.email.toLowerCase())) || (me.name && String(cur.nguoi_phu_trach).toLowerCase().includes(me.name.toLowerCase()));
  if (!isAdmin) need(mine, "Phiếu này đã giao cho người khác", 403);
  const set = {};
  if (patch.trang_thai !== undefined) {
    set.trang_thai = opt("orderStatus", patch.trang_thai, "Trạng thái"); need(set.trang_thai, "Trạng thái không hợp lệ");
    if (set.trang_thai === "huy") need(isAdmin, "Chỉ quản trị mới được huỷ phiếu", 403);
    if (set.trang_thai === "hoan_thanh") { set.ngay_hoan_thanh = today; need(str(patch.ket_qua ?? cur.ket_qua, 2000), "Cần ghi kết quả xử lý trước khi hoàn thành"); }
    if (ORDER_CLOSED.includes(cur.trang_thai) && !isAdmin) throw new UserError("Phiếu đã đóng", 403);
  }
  if (patch.ket_qua !== undefined) set.ket_qua = str(patch.ket_qua, 2000);
  if (patch.nguoi_phu_trach !== undefined) { need(isAdmin || !cur.nguoi_phu_trach, "Chỉ quản trị mới được đổi người phụ trách", 403); set.nguoi_phu_trach = str(patch.nguoi_phu_trach, 120); if (set.nguoi_phu_trach && !patch.trang_thai && (cur.trang_thai || "moi") === "moi") set.trang_thai = "da_giao"; }
  if (patch.ngay_hen !== undefined) { need(isAdmin, "Chỉ quản trị mới được đổi ngày hẹn", 403); set.ngay_hen = date(patch.ngay_hen, "Ngày hẹn"); }
  if (patch.uu_tien !== undefined) { need(isAdmin, "Chỉ quản trị mới được đổi mức ưu tiên", 403); set.uu_tien = opt("orderPriority", patch.uu_tien, "Ưu tiên"); }
  need(Object.keys(set).length, "Không có gì để cập nhật");
  await ghl.updateRecord(OBJ.order, id, set);
  return { ok: true, set };
}

export async function setProjectStage(ghl, id, stage) {
  need(isOption("projectStage", stage), "Giai đoạn không hợp lệ");
  const cur = (await ghl.listAll(OBJ.project)).map(flat).find((p) => p.id === id); need(cur, "Không tìm thấy dự án", 404);
  if (cur.giai_doan === stage) return { ok: true, unchanged: true };
  await ghl.updateRecord(OBJ.project, id, { giai_doan: stage });
  // Dự án bàn giao xong → các thang của hợp đồng chuyển sang "đang bảo hành" (có hạn bảo hành từ ngày bàn giao).
  return { ok: true };
}

// Bàn giao dự án: đặt ngày bàn giao + bảo hành cho các thang của hợp đồng, rồi chuyển giai đoạn "nghiệm thu bàn giao".
export async function handoverProject(ghl, id, { ngay, bao_hanh_thang }, today) {
  const d = await loadAll(ghl);
  const p = d.projects.find((x) => x.id === id); need(p, "Không tìm thấy dự án", 404);
  const c = d.contracts.find((x) => x.id === p.hop_dong_id); need(c, "Dự án chưa gắn hợp đồng");
  const handDate = date(ngay, "Ngày bàn giao") || today; const months = num(bao_hanh_thang, "Bảo hành (tháng)") ?? 12;
  const unitIds = String(c.thang_may_ids || "").split(",").filter(Boolean); need(unitIds.length, "Hợp đồng chưa chọn thang nào");
  let n = 0;
  for (const uid of unitIds) {
    const u = d.units.find((x) => x.id === uid); if (!u) continue;
    const patch = { ngay_ban_giao: handDate, het_bao_hanh: addMonths(handDate, months), trang_thai: "dang_bao_hanh" };
    const cycle = Number(u.chu_ky_kiem_dinh_thang); if (!u.ngay_kiem_dinh_ke_tiep && cycle > 0) patch.ngay_kiem_dinh_ke_tiep = addMonths(handDate, cycle);
    await ghl.updateRecord(OBJ.unit, uid, patch); n++;
  }
  await ghl.updateRecord(OBJ.project, id, { giai_doan: "bao_hanh" });
  return { ok: true, units: n, het_bao_hanh: addMonths(handDate, months) };
}

// Sinh phiếu bảo trì định kỳ cho 1 hợp đồng. Idempotent theo "khoá sinh". Mỗi lần gọi tạo tối đa MAX phiếu để
// request không quá dài (GHL ~0.5s/lần ghi); còn dư thì trả `remaining` để bấm tiếp.
const MAX_GENERATE = 40;
export async function generateMaintenance(ghl, contractId, { from, months }, today) {
  const d = await loadAll(ghl);
  const c = d.contracts.find((x) => x.id === contractId); need(c, "Không tìm thấy hợp đồng", 404);
  need(c.loai === "bao_tri", "Chỉ hợp đồng bảo trì mới sinh phiếu định kỳ"); need(c.trang_thai === "hieu_luc", "Hợp đồng chưa hiệu lực");
  const m = Math.round(Number(months) || 3); need(m >= 1 && m <= 12, "Số tháng từ 1 đến 12");
  const start = date(from, "Từ ngày") || today;
  const unitIds = String(c.thang_may_ids || "").split(",").filter((id) => d.units.some((u) => u.id === id));
  need(unitIds.length, "Hợp đồng chưa có thang hợp lệ");
  const existing = new Set(d.orders.map((o) => o.khoa_sinh).filter(Boolean));
  const plan = planMaintenance({ contract: c, unitIds, from: start, months: m, existingKeys: existing });
  const batch = plan.slice(0, MAX_GENERATE); let created = 0; const failed = [];
  for (let i = 0; i < batch.length; i += 3) {
    await Promise.all(batch.slice(i, i + 3).map(async (p) => {
      const u = d.units.find((x) => x.id === p.unitId);
      try {
        const rec = await ghl.createRecord(OBJ.order, clean({
          name: orderNumber(today), loai: "bao_tri_dinh_ky", uu_tien: "binh_thuong", trang_thai: "moi", nguon: "dinh_ky", ngay_hen: p.date, khoa_sinh: p.key,
          mo_ta: `Bảo trì định kỳ tháng ${p.date.slice(5, 7)}/${p.date.slice(0, 4)} — ${u.name}`, thang_may_id: u.id, cong_trinh_id: u.cong_trinh_id, hop_dong_id: c.id,
        }));
        relateLater(ghl, "phieu_thang_may", { [OBJ.order]: rec.id, [OBJ.unit]: u.id }); relateLater(ghl, "phieu_hop_dong", { [OBJ.order]: rec.id, [OBJ.contract]: c.id });
        created++;
      } catch (e) { failed.push({ key: p.key, error: e.message }); }
    }));
  }
  return { created, remaining: plan.length - batch.length + failed.length, planned: plan.length, failed };
}

// Kiểm định: lên lịch / ghi kết quả. Kết quả đạt → tự tính ngày kiểm định kế tiếp theo chu kỳ riêng của thang.
export async function scheduleInspection(ghl, unitId, { ngay, don_vi_kiem_dinh }) {
  const u = (await ghl.listAll(OBJ.unit)).map(flat).find((x) => x.id === unitId); need(u, "Không tìm thấy thang", 404);
  const ngayKD = date(ngay, "Ngày kiểm định"); need(ngayKD, "Chọn ngày kiểm định");
  const open = (await ghl.listAll(OBJ.inspection)).map(flat).find((k) => k.thang_may_id === unitId && INSPECTION_OPEN.includes(k.trang_thai));
  need(!open, "Thang này đã có đợt kiểm định đang mở");
  const rec = await ghl.createRecord(OBJ.inspection, clean({ name: `KD-${u.name}-${ngayKD}`, trang_thai: "len_lich", ngay_kiem_dinh: ngayKD, don_vi_kiem_dinh: str(don_vi_kiem_dinh, 120), thang_may_id: unitId }));
  relateLater(ghl, "kiem_dinh_thang_may", { [OBJ.inspection]: rec.id, [OBJ.unit]: unitId });
  return { id: rec.id };
}
export async function recordInspection(ghl, id, i) {
  const k = (await ghl.listAll(OBJ.inspection)).map(flat).find((x) => x.id === id); need(k, "Không tìm thấy đợt kiểm định", 404);
  const u = (await ghl.listAll(OBJ.unit)).map(flat).find((x) => x.id === k.thang_may_id);
  const status = opt("inspectionStatus", i.trang_thai, "Trạng thái"); const result = opt("inspectionResult", i.ket_qua, "Kết quả");
  const ngay = date(i.ngay_kiem_dinh, "Ngày kiểm định") || k.ngay_kiem_dinh;
  const set = clean({ trang_thai: status, ket_qua: result, ngay_kiem_dinh: ngay, don_vi_kiem_dinh: i.don_vi_kiem_dinh !== undefined ? str(i.don_vi_kiem_dinh, 120) : undefined, ghi_chu: i.ghi_chu !== undefined ? str(i.ghi_chu, 1000) : undefined });
  let next = null;
  if (result === "dat" || result === "dat_co_dieu_kien") {
    need(ngay, "Cần ngày kiểm định");
    next = u ? nextInspectionDate(ngay, u.chu_ky_kiem_dinh_thang) : null;
    if (u) need(next, `Thang ${u.name} chưa có chu kỳ kiểm định (tháng) — cập nhật chu kỳ trước`);
    set.trang_thai = "hoan_tat"; set.ngay_het_han = next;
  }
  need(Object.keys(set).length, "Không có gì để cập nhật");
  await ghl.updateRecord(OBJ.inspection, id, set);
  if (next && u) await ghl.updateRecord(OBJ.unit, u.id, { ngay_kiem_dinh_ke_tiep: next });
  return { ok: true, next };
}
