// Logic thuần (không gọi mạng, không đọc đồng hồ ngầm) của module service — để test được từng quy tắc.
// Ngày luôn là chuỗi "YYYY-MM-DD" theo giờ Việt Nam; KHÔNG dùng toISOString().slice(0,10) (lệch 1 ngày ở UTC+7).
import crypto from "crypto";
import { ORDER_CLOSED, INSPECTION_OPEN, THRESHOLDS } from "./schema.mjs";

// --- ngày ---------------------------------------------------------------------------------------------
export const todayVN = (now = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
const pad = (n) => String(n).padStart(2, "0");
const parse = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || "")); return m ? { y: +m[1], m: +m[2], d: +m[3] } : null; };
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const toStr = ({ y, m, d }) => `${y}-${pad(m)}-${pad(d)}`;
export const isDate = (s) => { const p = parse(s); return !!p && p.m >= 1 && p.m <= 12 && p.d >= 1 && p.d <= daysInMonth(p.y, p.m); };
export function addMonths(s, n) {
  const p = parse(s); if (!p) return null;
  const idx = p.y * 12 + (p.m - 1) + n; const y = Math.floor(idx / 12), m = (idx % 12) + 1;
  return toStr({ y, m, d: Math.min(p.d, daysInMonth(y, m)) });
}
export function addDays(s, n) { const p = parse(s); if (!p) return null; const t = new Date(Date.UTC(p.y, p.m - 1, p.d) + n * 86400000); return toStr({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }); }
export function daysBetween(a, b) { const x = parse(a), y = parse(b); if (!x || !y) return null; return Math.round((Date.UTC(y.y, y.m - 1, y.d) - Date.UTC(x.y, x.m - 1, x.d)) / 86400000); }
export const monthKey = (s) => String(s || "").slice(0, 7);

// --- bảo trì định kỳ ------------------------------------------------------------------------------------
// Từ 1 hợp đồng bảo trì + các thang nó phủ → danh sách phiếu CẦN tạo trong cửa sổ [from, from+months). Chu kỳ = số THÁNG giữa
// 2 lần bảo trì (1 = hằng tháng, 3 = mỗi quý...), tính từ tháng hiệu lực của hợp đồng; ngày hẹn bám ngày hiệu lực. Mỗi (hợp đồng,
// thang, tháng) có 1 "khoá sinh" cố định nên gọi lại nhiều lần không tạo trùng (đã có khoá → bỏ qua).
export const maintenanceCycle = (contract) => Math.max(1, Math.min(12, Math.round(Number(contract.chu_ky_bao_tri_thang) || 1)));
export function planMaintenance({ contract, unitIds, from, months, existingKeys = new Set() }) {
  const out = [];
  const start = contract.ngay_hieu_luc, end = contract.ngay_het_han;
  const cycle = maintenanceCycle(contract);
  const anchor = parse(isDate(start) ? start : from);
  const fromP = parse(from); if (!fromP) throw new Error("Ngày bắt đầu không hợp lệ");
  for (let i = 0; i < months; i++) {
    const first = addMonths(toStr({ ...fromP, d: 1 }), i); const fp = parse(first);
    if ((((fp.y * 12 + fp.m) - (anchor.y * 12 + anchor.m)) % cycle + cycle) % cycle !== 0) continue; // không đúng tháng của chu kỳ
    let date = toStr({ y: fp.y, m: fp.m, d: Math.min(daysInMonth(fp.y, fp.m), Math.min(28, anchor.d)) });
    if (isDate(start) && date < start && monthKey(date) === monthKey(start)) date = start; // ngày hiệu lực 29–31: tháng đầu hẹn đúng ngày hiệu lực, không bị bỏ sót
    if (date < from) continue;
    if (isDate(start) && date < start) continue;
    if (isDate(end) && date > end) continue;
    for (const unitId of unitIds) {
      const key = `PM:${contract.id}:${unitId}:${monthKey(date)}`;
      if (existingKeys.has(key)) continue;
      out.push({ key, unitId, date });
    }
  }
  return out;
}

// SĐT Việt Nam → dạng quốc tế (+84…) để GHL nhận diện/gộp contact; không hợp lệ thì trả null.
export function toE164VN(p) {
  const d = String(p || "").replace(/[^\d+]/g, "").replace(/^\+/, "");
  const n = d.startsWith("84") ? d.slice(2) : d.startsWith("0") ? d.slice(1) : d;
  return /^\d{8,10}$/.test(n) ? "+84" + n : null;
}

// --- tiến độ công việc (dự án) -----------------------------------------------------------------------
export const TASK_CLOSED = ["hoan_thanh", "huy"];
const taskWeight = (t) => { const d = daysBetween(t.ngay_bat_dau_kh, t.ngay_ket_thuc_kh); return Number.isFinite(d) ? Math.max(1, d + 1) : 1; };
export const isTaskOverdue = (t, today) => !TASK_CLOSED.includes(t.trang_thai) && isDate(t.ngay_ket_thuc_kh) && t.ngay_ket_thuc_kh < today;
// % tiến độ của dự án = trung bình có trọng số theo số ngày kế hoạch (việc dài ảnh hưởng nhiều hơn); việc hủy không tính.
export function taskProgress(tasks, today) {
  const live = tasks.filter((t) => t.trang_thai !== "huy");
  let w = 0, acc = 0, done = 0, doing = 0, overdue = 0, start = null, end = null, nextMilestone = null;
  const order = [], byPhase = new Map();
  const sorted = [...live].sort((x, y) => (Number(x.thu_tu) || 0) - (Number(y.thu_tu) || 0));
  for (const t of sorted) { const g = t.giai_doan || "Khác"; if (!byPhase.has(g)) { byPhase.set(g, []); order.push(g); } byPhase.get(g).push(t); }
  for (const t of live) {
    const pct = t.trang_thai === "hoan_thanh" ? 100 : Math.max(0, Math.min(100, Number(t.phan_tram) || 0));
    const wt = taskWeight(t); w += wt; acc += wt * pct;
    if (t.trang_thai === "hoan_thanh") done++; else if (pct > 0 || t.trang_thai === "dang_lam" || t.trang_thai === "cho_kiem_tra") doing++;
    if (isTaskOverdue(t, today)) overdue++;
    if (isDate(t.ngay_bat_dau_kh) && (!start || t.ngay_bat_dau_kh < start)) start = t.ngay_bat_dau_kh;
    if (isDate(t.ngay_ket_thuc_kh) && (!end || t.ngay_ket_thuc_kh > end)) end = t.ngay_ket_thuc_kh;
    if (t.loai === "moc" && t.trang_thai !== "hoan_thanh" && isDate(t.ngay_ket_thuc_kh) && (!nextMilestone || t.ngay_ket_thuc_kh < nextMilestone.date)) nextMilestone = { name: t.name, date: t.ngay_ket_thuc_kh };
  }
  // Giai đoạn = cấp gom nhóm của công việc: KHÔNG có trạng thái riêng, mọi số liệu cộng dồn từ công việc con.
  const phases = order.map((name) => { const ts = byPhase.get(name); let pw = 0, pa = 0, pd = 0; for (const t of ts) { const wt = taskWeight(t), pct = t.trang_thai === "hoan_thanh" ? 100 : Math.max(0, Math.min(100, Number(t.phan_tram) || 0)); pw += wt; pa += wt * pct; if (t.trang_thai === "hoan_thanh") pd++; } return { name, total: ts.length, done: pd, percent: pw ? Math.round(pa / pw) : 0 }; });
  const currentPhase = phases.find((p) => p.done < p.total) || null;
  return { percent: w ? Math.round(acc / w) : 0, total: live.length, done, doing, overdue, start, end, nextMilestone, phases, currentPhase };
}
// Vòng đời dự án: 4 giá trị chung. Giá trị cũ (10 giai đoạn của thang máy) được ánh xạ để dữ liệu cũ vẫn hiển thị đúng.
export const LIFECYCLE = ["chuan_bi", "dang_thuc_hien", "bao_hanh", "hoan_tat"];
export function projectLifecycle(p) {
  const g = p?.giai_doan || "";
  if (LIFECYCLE.includes(g)) return g;
  return !g || g === "ky_hd" || g === "tam_ung" ? "chuan_bi" : "dang_thuc_hien";
}
// Sức khoẻ dự án (xanh/vàng/đỏ) tự tính từ công việc và hạn bàn giao — không nhập tay.
export function projectHealth(project, progress, today) {
  if (!progress || !progress.total) return null;
  const life = projectLifecycle(project);
  if (life === "bao_hanh" || life === "hoan_tat" || progress.percent === 100) return { level: "green", reasons: [] };
  let level = "green"; const reasons = []; const due = project.ngay_du_kien_ban_giao;
  if (isDate(due)) {
    if (due < today) { level = "red"; reasons.push(`Quá hạn bàn giao ${daysBetween(due, today)} ngày`); }
    else if (isDate(progress.end) && progress.end > due) { level = "red"; reasons.push(`Kế hoạch kết thúc muộn hơn hạn bàn giao ${daysBetween(due, progress.end)} ngày`); }
  }
  if (progress.overdue >= 3 || progress.overdue / progress.total >= 0.2) { level = "red"; reasons.push(`${progress.overdue} việc trễ`); }
  else if (progress.overdue >= 1) { if (level === "green") level = "yellow"; reasons.push(`${progress.overdue} việc trễ`); }
  return { level, reasons };
}
// Quy tắc đồng bộ giữa trạng thái, % và ngày thực tế khi sửa 1 công việc (chỉ trả các field cần ghi).
export function normalizeTaskPatch(cur, patch, today) {
  const p = { ...patch };
  const hasPct = p.phan_tram !== undefined, hasSt = p.trang_thai !== undefined;
  if (hasPct) p.phan_tram = Math.max(0, Math.min(100, Math.round(Number(p.phan_tram) || 0)));
  const curSt = cur.trang_thai || "chua_lam";
  let st = hasSt ? p.trang_thai : curSt;
  if (hasSt && st === "hoan_thanh") p.phan_tram = 100;
  else if (hasPct && p.phan_tram === 100 && st !== "huy") st = "hoan_thanh";
  else if (hasPct && !hasSt) { if (p.phan_tram > 0 && curSt === "chua_lam") st = "dang_lam"; else if (p.phan_tram < 100 && curSt === "hoan_thanh") st = p.phan_tram > 0 ? "dang_lam" : "chua_lam"; }
  if (hasSt && st === "chua_lam" && !hasPct) p.phan_tram = 0;
  if (hasSt && curSt === "hoan_thanh" && st !== "hoan_thanh" && st !== "huy" && !hasPct) p.phan_tram = 90; // mở lại việc đã xong
  if (st !== curSt || hasSt) p.trang_thai = st;
  if (["dang_lam", "cho_kiem_tra", "hoan_thanh"].includes(st) && !cur.ngay_bat_dau_tt && !p.ngay_bat_dau_tt) p.ngay_bat_dau_tt = today;
  if (st === "hoan_thanh" && !cur.ngay_ket_thuc_tt && !p.ngay_ket_thuc_tt) p.ngay_ket_thuc_tt = today;
  return p;
}
// Từ mẫu + ngày khởi công → danh sách công việc cần tạo. Khoá sinh cố định (dự án, mẫu, số thứ tự) nên gọi lại không tạo trùng.
export function planFromTemplate({ template, projectId, start, existingKeys = new Set() }) {
  if (!isDate(start)) throw new Error("Ngày khởi công không hợp lệ");
  const out = [];
  template.items.forEach((it, i) => {
    const key = `TASK:${projectId}:${template.key}:${i + 1}`;
    if (existingKeys.has(key)) return;
    const s = addDays(start, it.offset), e = addDays(s, (it.moc ? 1 : it.days) - 1);
    out.push({ key, props: { name: it.name, giai_doan: it.giai_doan, loai: it.moc ? "moc" : "viec", trang_thai: "chua_lam", phan_tram: 0, ngay_bat_dau_kh: s, ngay_ket_thuc_kh: e, thu_tu: i + 1, khoa_sinh: key, du_an_id: projectId } });
  });
  return out;
}

// --- kiểm định ------------------------------------------------------------------------------------------
// Chu kỳ lấy từ field của TỪNG thang (chưa xác minh với văn bản pháp luật — xem ghi chú dự án), không hardcode.
export const nextInspectionDate = (doneDate, cycleMonths) => (isDate(doneDate) && Number(cycleMonths) > 0 ? addMonths(doneDate, Math.round(Number(cycleMonths))) : null);

// --- chuẩn hoá bản ghi GHL ------------------------------------------------------------------------------
export const flat = (r) => ({ id: r.id, createdAt: r.createdAt, ...(r.properties || {}) });
const open = (o) => !ORDER_CLOSED.includes(o.trang_thai);

// --- bảng "cần chú ý hôm nay" ---------------------------------------------------------------------------
export function computeDashboard({ units, contracts, orders, inspections, projects, sites }, today, th = THRESHOLDS) {
  const unitName = new Map(units.map((u) => [u.id, u.name]));
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const U = (id) => unitName.get(id) || "—";
  const openOrders = orders.filter(open);

  const overdueOrders = openOrders.filter((o) => isDate(o.ngay_hen) && o.ngay_hen < today)
    .map((o) => ({ id: o.id, name: o.name, unit: U(o.thang_may_id), unitId: o.thang_may_id, ngay_hen: o.ngay_hen, daysLate: daysBetween(o.ngay_hen, today), uu_tien: o.uu_tien, loai: o.loai }))
    .sort((a, b) => b.daysLate - a.daysLate);
  const urgent = openOrders.filter((o) => o.uu_tien === "khan_cap")
    .map((o) => ({ id: o.id, name: o.name, unit: U(o.thang_may_id), unitId: o.thang_may_id, trang_thai: o.trang_thai, nguoi_phu_trach: o.nguoi_phu_trach || "", createdAt: o.createdAt, mo_ta: o.mo_ta || "" }));
  const unassigned = openOrders.filter((o) => (o.trang_thai || "moi") === "moi" && !o.nguoi_phu_trach)
    .map((o) => ({ id: o.id, name: o.name, unit: U(o.thang_may_id), unitId: o.thang_may_id, loai: o.loai, uu_tien: o.uu_tien }));

  const openInspUnits = new Set(inspections.filter((k) => INSPECTION_OPEN.includes(k.trang_thai)).map((k) => k.thang_may_id));
  const inspectionsDue = units.filter((u) => u.trang_thai !== "ngung_hoat_dong" && isDate(u.ngay_kiem_dinh_ke_tiep))
    .map((u) => ({ id: u.id, name: u.name, site: siteName.get(u.cong_trinh_id) || "", due: u.ngay_kiem_dinh_ke_tiep, daysLeft: daysBetween(today, u.ngay_kiem_dinh_ke_tiep), scheduled: openInspUnits.has(u.id) }))
    .filter((x) => x.daysLeft <= th.inspectionDays).sort((a, b) => a.daysLeft - b.daysLeft);

  const contractsExpiring = contracts.filter((c) => c.loai === "bao_tri" && c.trang_thai === "hieu_luc" && isDate(c.ngay_het_han))
    .map((c) => ({ id: c.id, name: c.name, khach: c.ten_khach_hang || "", site: siteName.get(c.cong_trinh_id) || "", ngay_het_han: c.ngay_het_han, daysLeft: daysBetween(today, c.ngay_het_han), gia_tri: Number(c.gia_tri) || 0 }))
    .filter((x) => x.daysLeft <= th.contractDays).sort((a, b) => a.daysLeft - b.daysLeft);

  // Cơ hội bán bảo trì: hết/sắp hết bảo hành mà chưa có hợp đồng bảo trì.
  const maintenanceUpsell = units.filter((u) => u.trang_thai === "dang_bao_hanh" && !u.hop_dong_bao_tri_id && isDate(u.het_bao_hanh))
    .map((u) => ({ id: u.id, name: u.name, site: siteName.get(u.cong_trinh_id) || "", het_bao_hanh: u.het_bao_hanh, daysLeft: daysBetween(today, u.het_bao_hanh) }))
    .filter((x) => x.daysLeft <= th.warrantyDays).sort((a, b) => a.daysLeft - b.daysLeft);

  const projectsLate = projects.filter((p) => p.giai_doan !== "hoan_tat" && isDate(p.ngay_du_kien_ban_giao) && p.ngay_du_kien_ban_giao < today)
    .map((p) => ({ id: p.id, name: p.name, giai_doan: p.giai_doan, due: p.ngay_du_kien_ban_giao, daysLate: daysBetween(p.ngay_du_kien_ban_giao, today) }));
  const projectsByStage = {};
  for (const p of projects) { const k = projectLifecycle(p); projectsByStage[k] = (projectsByStage[k] || 0) + 1; } // theo vòng đời dự án

  // KPI tháng hiện tại
  const mk = monthKey(today);
  const pmThisMonth = orders.filter((o) => o.loai === "bao_tri_dinh_ky" && o.trang_thai !== "huy" && monthKey(o.ngay_hen) === mk);
  const pmDone = pmThisMonth.filter((o) => o.trang_thai === "hoan_thanh").length;
  const incidents = orders.filter((o) => o.loai === "su_co" && o.trang_thai !== "huy" && isDate(o.createdAt?.slice(0, 10)));
  // Sự cố lặp lại: cùng 1 thang có ≥2 sự cố cách nhau ≤30 ngày (chỉ báo chất lượng bảo trì).
  const byUnit = new Map();
  for (const o of incidents) { const d = String(o.createdAt).slice(0, 10); (byUnit.get(o.thang_may_id) || byUnit.set(o.thang_may_id, []).get(o.thang_may_id)).push(d); }
  let repeat = 0;
  for (const [, ds] of byUnit) { ds.sort(); for (let i = 1; i < ds.length; i++) if (daysBetween(ds[i - 1], ds[i]) <= 30) { repeat++; break; } }
  const kpi = {
    openOrders: openOrders.length,
    pmThisMonth: pmThisMonth.length, pmDone, pmRate: pmThisMonth.length ? Math.round((pmDone / pmThisMonth.length) * 100) : null,
    repeatUnits: repeat,
    unitsTotal: units.length, unitsMaintained: units.filter((u) => !!u.hop_dong_bao_tri_id).length,
    activeMaintenanceContracts: contracts.filter((c) => c.loai === "bao_tri" && c.trang_thai === "hieu_luc").length,
    recurringRevenue: contracts.filter((c) => c.loai === "bao_tri" && c.trang_thai === "hieu_luc").reduce((s, c) => s + (Number(c.gia_tri) || 0), 0),
  };
  return { today, kpi, overdueOrders, urgent, unassigned, inspectionsDue, contractsExpiring, maintenanceUpsell, projectsLate, projectsByStage };
}

// --- QR báo sự cố công khai -----------------------------------------------------------------------------
// Chữ ký HMAC gắn (trung tâm, thang) → không đoán/đổi sang thang khác được; không cần đăng nhập vẫn an toàn.
export const qrSign = (secret, locationId, unitId) => crypto.createHmac("sha256", secret).update(`${locationId}.${unitId}`).digest("base64url").slice(0, 22);
export function qrVerify(secret, locationId, unitId, sig) {
  const want = Buffer.from(qrSign(secret, locationId, unitId)), got = Buffer.from(String(sig || ""));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// Giới hạn tốc độ đơn giản trong bộ nhớ (cửa sổ trượt) — chặn spam form công khai.
export function makeLimiter(max, windowMs, now = () => Date.now()) {
  const hits = new Map();
  return (key) => {
    const t = now(), arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
    if (arr.length >= max) { hits.set(key, arr); return false; }
    arr.push(t); hits.set(key, arr); return true;
  };
}
export const cleanText = (s, max) => String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);
export const orderNumber = (today, rand = () => Math.random().toString(36).slice(2, 6).toUpperCase()) => `PDV-${today.slice(2, 4)}${today.slice(5, 7)}${today.slice(8, 10)}-${rand()}`;

// --- dữ liệu cho biểu đồ ----------------------------------------------------------------------------------
const dateOf = (iso) => (iso ? todayVN(new Date(iso)) : null);
const weekStart = (s) => { const p = parse(s); const dow = (new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() + 6) % 7; return addDays(s, -dow); };
const personName = (s) => String(s || "").replace(/\s*<.*>/, "").trim();

// 12 tuần gần nhất (tuần bắt đầu thứ Hai), cơ cấu phiếu, trạng thái thang, hợp đồng lớn nhất, tải của từng người,
// và các mốc sắp tới trong 45 ngày. Mọi thứ suy ra từ chính dữ liệu — không có số liệu "lịch sử" riêng.
export function computeCharts({ units, contracts, orders, projects, sites, inspections }, today, weeks = 12, horizon = 45) {
  const w0 = addDays(weekStart(today), -7 * (weeks - 1));
  const weekly = Array.from({ length: weeks }, (_, i) => ({ start: addDays(w0, 7 * i), created: 0, done: 0, backlog: 0 }));
  const idx = (d) => (d && d >= w0 ? Math.min(weeks - 1, Math.floor(daysBetween(w0, d) / 7)) : -1);
  const live = orders.filter((o) => o.trang_thai !== "huy");
  for (const o of live) {
    const c = dateOf(o.createdAt), ci = idx(c), di = o.trang_thai === "hoan_thanh" ? idx(o.ngay_hoan_thanh) : -1;
    if (ci >= 0) weekly[ci].created++;
    if (di >= 0) weekly[di].done++;
    // tồn đọng cuối mỗi tuần = đã tạo nhưng chưa xong tại thời điểm đó
    for (let i = 0; i < weeks; i++) { const end = addDays(weekly[i].start, 6); if (c && c <= end && !(o.trang_thai === "hoan_thanh" && o.ngay_hoan_thanh && o.ngay_hoan_thanh <= end)) weekly[i].backlog++; }
  }
  const lastN = (n) => addDays(today, -n);
  const created7 = live.filter((o) => dateOf(o.createdAt) > lastN(7)).length, createdPrev7 = live.filter((o) => { const d = dateOf(o.createdAt); return d > lastN(14) && d <= lastN(7); }).length;
  const done = live.filter((o) => o.trang_thai === "hoan_thanh" && isDate(o.ngay_hoan_thanh));
  const done7 = done.filter((o) => o.ngay_hoan_thanh > lastN(7)).length, donePrev7 = done.filter((o) => o.ngay_hoan_thanh > lastN(14) && o.ngay_hoan_thanh <= lastN(7)).length;
  const dur = done.filter((o) => o.ngay_hoan_thanh > lastN(30) && dateOf(o.createdAt)).map((o) => Math.max(0, daysBetween(dateOf(o.createdAt), o.ngay_hoan_thanh)));
  const typeCount = {}; for (const o of live) if (dateOf(o.createdAt) > lastN(90)) typeCount[o.loai || "su_co"] = (typeCount[o.loai || "su_co"] || 0) + 1;
  const unitStatus = {}; for (const u of units) unitStatus[u.trang_thai || "chua_ban_giao"] = (unitStatus[u.trang_thai || "chua_ban_giao"] || 0) + 1;
  const topContracts = contracts.filter((c) => c.loai === "bao_tri" && c.trang_thai === "hieu_luc").map((c) => ({ id: c.id, name: c.name, khach: c.ten_khach_hang || "", gia_tri: Number(c.gia_tri) || 0 })).sort((a, b) => b.gia_tri - a.gia_tri).slice(0, 6);
  const wl = new Map(); let unassigned = 0;
  for (const o of orders.filter(open)) { const n = personName(o.nguoi_phu_trach); if (!n) { unassigned++; continue; } const w = wl.get(n) || { name: n, open: 0, overdue: 0 }; w.open++; if (isDate(o.ngay_hen) && o.ngay_hen < today) w.overdue++; wl.set(n, w); }
  const workload = [...wl.values()].sort((a, b) => b.open - a.open);
  const siteName = new Map(sites.map((s) => [s.id, s.name])), unitName = new Map(units.map((u) => [u.id, u.name]));
  const end = addDays(today, horizon), up = [];
  const add = (date, kind, title, sub, type, id) => { if (isDate(date) && date >= today && date <= end) up.push({ date, days: daysBetween(today, date), kind, title, sub, type, id }); };
  const openInsp = new Set(inspections.filter((k) => INSPECTION_OPEN.includes(k.trang_thai)).map((k) => k.thang_may_id));
  for (const u of units) if (u.trang_thai !== "ngung_hoat_dong") { add(u.ngay_kiem_dinh_ke_tiep, "kiem_dinh", `Kiểm định ${u.name}`, (openInsp.has(u.id) ? "Đã lên lịch" : "Chưa lên lịch") + (siteName.get(u.cong_trinh_id) ? " · " + siteName.get(u.cong_trinh_id) : ""), "thang_may", u.id); add(u.het_bao_hanh, "bao_hanh", `Hết bảo hành ${u.name}`, u.hop_dong_bao_tri_id ? "Đã có hợp đồng bảo trì" : "Chưa có hợp đồng bảo trì", "thang_may", u.id); }
  for (const c of contracts) if (c.loai === "bao_tri" && c.trang_thai === "hieu_luc") add(c.ngay_het_han, "hop_dong", `Hợp đồng ${c.name} hết hạn`, c.ten_khach_hang || "", "hop_dong", c.id);
  for (const o of orders.filter(open)) add(o.ngay_hen, "phieu", `${o.name} · ${unitName.get(o.thang_may_id) || ""}`, "Phiếu đến hẹn", "phieu", o.id);
  for (const p of projects) if (p.giai_doan !== "hoan_tat") add(p.ngay_du_kien_ban_giao, "du_an", `Bàn giao ${p.name}`, "Dự kiến", "du_an", p.id);
  up.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
  // Phiếu đến hẹn rất nhiều nên dễ lấn át các mốc quan trọng hơn (kiểm định, bảo hành, hợp đồng, bàn giao) → chỉ giữ 3 phiếu sớm nhất.
  let np = 0; const trimmed = up.filter((x) => x.kind !== "phieu" || ++np <= 3);
  return { weekly, created7, createdPrev7, done7, donePrev7, avgResolveDays: dur.length ? Math.round((dur.reduce((a, b) => a + b, 0) / dur.length) * 10) / 10 : null, typeCount, unitStatus, topContracts, workload, unassigned, upcoming: trimmed.slice(0, 14), upcomingTotal: up.length };
}

// --- dashboard KINH DOANH (bán thang mới) -----------------------------------------------------------------
// Nguồn: cơ hội GHL (pipeline/giai đoạn/giá trị/trạng thái/đối thủ...) + hợp đồng lắp đặt (doanh số đã ký). Thuần hàm → test được.
const monthOf = (iso) => (iso ? todayVN(new Date(iso)).slice(0, 7) : null);
const TOP = (counts, n) => Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n).map(([label, value]) => ({ label, value }));
export function computeSales({ opps, pipelines, contracts }, today, months = 12) {
  const main = pipelines.find((p) => /bán/i.test(p.name)) || pipelines[0] || { id: null, name: "", stages: [] };
  const stageName = new Map(), stageProb = new Map();
  for (const p of pipelines) for (const st of p.stages) { stageName.set(st.id, st.name); stageProb.set(st.id, st.prob / 100); }
  const open = opps.filter((o) => o.status === "open"), won = opps.filter((o) => o.status === "won"), lost = opps.filter((o) => o.status === "lost" || o.status === "abandoned");
  const dAgo = (n) => addDays(today, -n);
  const since = (iso, d) => { const x = iso ? todayVN(new Date(iso)) : null; return x && x > dAgo(d); };
  const pipes = pipelines.map((p) => {
    const mine = open.filter((o) => o.pipelineId === p.id);
    return { id: p.id, name: p.name, open: mine.length, value: mine.reduce((a, o) => a + o.value, 0), weighted: Math.round(mine.reduce((a, o) => a + o.value * (stageProb.get(o.stageId) || 0), 0)),
      stages: p.stages.map((st) => { const x = mine.filter((o) => o.stageId === st.id); return { id: st.id, name: st.name, count: x.length, value: x.reduce((a, o) => a + o.value, 0) }; }) };
  });
  const mainP = pipes.find((p) => p.id === main.id) || { stages: [], open: 0, value: 0, weighted: 0 };
  const won90 = won.filter((o) => since(o.lastStatusChangeAt, 90)).length, lost90 = lost.filter((o) => since(o.lastStatusChangeAt, 90)).length;
  const cycle = won.filter((o) => since(o.lastStatusChangeAt, 365) && o.createdAt && o.lastStatusChangeAt).map((o) => Math.max(0, daysBetween(todayVN(new Date(o.createdAt)), todayVN(new Date(o.lastStatusChangeAt)))));
  const won12 = won.filter((o) => since(o.lastStatusChangeAt, 365));
  const monthKeys = Array.from({ length: months }, (_, i) => addMonths(`${today.slice(0, 7)}-01`, i - (months - 1)).slice(0, 7));
  const monthly = monthKeys.map((m) => ({ month: m, won: 0, wonValue: 0, lost: 0, created: 0, booked: 0, units: 0, contracts: 0 }));
  const mi = new Map(monthKeys.map((m, i) => [m, i]));
  for (const o of won) { const i = mi.get(monthOf(o.lastStatusChangeAt)); if (i != null) { monthly[i].won++; monthly[i].wonValue += o.value; } }
  for (const o of lost) { const i = mi.get(monthOf(o.lastStatusChangeAt)); if (i != null) monthly[i].lost++; }
  for (const o of opps) { const i = mi.get(monthOf(o.createdAt)); if (i != null) monthly[i].created++; }
  const sales = contracts.filter((c) => c.loai === "mua_ban_lap_dat" && c.trang_thai !== "huy");
  for (const c of sales) { const i = mi.get(String(c.ngay_hieu_luc || "").slice(0, 7)); if (i != null) { monthly[i].booked += Number(c.gia_tri) || 0; monthly[i].contracts++; monthly[i].units += String(c.thang_may_ids || "").split(",").filter(Boolean).length; } }
  const bookings12m = monthly.reduce((a, m) => a + m.booked, 0), contracts12m = monthly.reduce((a, m) => a + m.contracts, 0), units12m = monthly.reduce((a, m) => a + m.units, 0);
  const count = (arr, key) => { const c = {}; for (const o of arr) { const v = String(o[key] || "").trim(); if (v) c[v] = (c[v] || 0) + 1; } return c; };
  const compCount = {}; for (const o of [...open, ...lost]) { const v = String(o.doi_thu || "").trim(); if (v) for (const n of v.split(/[,;/]/).map((x) => x.trim()).filter(Boolean)) compCount[n] = (compCount[n] || 0) + 1; }
  const stalled = open.map((o) => ({ o, d: daysBetween(todayVN(new Date(o.lastStageChangeAt || o.createdAt || today)), today) })).filter((x) => x.d >= 14).sort((a, b) => b.d - a.d).slice(0, 8)
    .map(({ o, d }) => ({ id: o.id, name: o.name, stage: stageName.get(o.stageId) || "", value: o.value, days: d, contact: o.contact }));
  const withStage = (o) => ({ id: o.id, name: o.name, stage: stageName.get(o.stageId) || "", value: o.value, contact: o.contact, form: o.hinh_thuc || "" });
  return {
    today, pipelines: pipes, main: { id: main.id, name: main.name, stages: mainP.stages, open: mainP.open, value: mainP.value, weighted: mainP.weighted },
    totals: { openCount: open.length, openValue: open.reduce((a, o) => a + o.value, 0), weighted: pipes.reduce((a, p) => a + p.weighted, 0), new30: opps.filter((o) => since(o.createdAt, 30)).length, new30Prev: opps.filter((o) => { const d = o.createdAt ? todayVN(new Date(o.createdAt)) : null; return d && d > dAgo(60) && d <= dAgo(30); }).length,
      won30: won.filter((o) => since(o.lastStatusChangeAt, 30)).length, wonValue30: won.filter((o) => since(o.lastStatusChangeAt, 30)).reduce((a, o) => a + o.value, 0),
      winRate90: won90 + lost90 ? Math.round((won90 / (won90 + lost90)) * 100) : null, won90, lost90, avgCycleDays: cycle.length ? Math.round(cycle.reduce((a, b) => a + b, 0) / cycle.length) : null,
      avgDeal: won12.length ? Math.round(won12.reduce((a, o) => a + o.value, 0) / won12.length) : (contracts12m ? Math.round(bookings12m / contracts12m) : 0), bookings12m, contracts12m, units12m },
    monthly, byForm: TOP(count(open, "hinh_thuc"), 5), byType: TOP(count(open, "loai_thang"), 5), bySource: TOP(count(opps.filter((o) => since(o.createdAt, 180)), "source"), 6), byStageProject: TOP(count(open, "giai_doan_ct"), 5),
    competitors: TOP(compCount, 6), stalled, topDeals: [...open].sort((a, b) => b.value - a.value).slice(0, 6).map(withStage), closing: open.filter((o) => { const st = pipelines.flatMap((p) => p.stages).find((x) => x.id === o.stageId); const p = pipelines.find((x) => x.id === o.pipelineId); return st && p && p.stages.length > 1 && st.position === p.stages[p.stages.length - 1].position; }).slice(0, 6).map(withStage),
    recentWins: [...won].sort((a, b) => String(b.lastStatusChangeAt).localeCompare(String(a.lastStatusChangeAt))).slice(0, 5).map((o) => ({ id: o.id, name: o.name, value: o.value, at: todayVN(new Date(o.lastStatusChangeAt || today)) })),
  };
}
