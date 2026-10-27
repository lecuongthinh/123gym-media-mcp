// Server đa khách hàng (multi-tenant): 1 tiến trình Render + 1 Marketplace App phục vụ NHIỀU trung tâm,
// mỗi trung tâm là 1 "tenant" (1 location GHL riêng + 1 schema Postgres riêng, xem platform.tenants trong
// db.mjs). Trước đây (bản Candy English gốc) mọi biến trạng thái (candy, overlay, cấu hình...) là biến toàn
// cục nạp 1 LẦN lúc khởi động server, cho ĐÚNG 1 khách hàng — giờ mọi thứ đó nằm trong 1 object AppState
// nạp riêng theo từng locationId (hàm getAppState() bên dưới), tra theo tenant của phiên đăng nhập đang gọi.
import http from "http"; import fs from "fs"; import path from "path"; import { fileURLToPath } from "url";
import { ghlGet } from "./ghl-readonly.mjs";
import { getCoSoOptions, writeAttendance, writerEnabled, getBuoiHoc, setBuoiHocTrangThai, getPhuHuynh, enrollStudent, createHocVien, createLop, renewEnrollment, setLichHoc, setGhiDanhTrangThai, generateSessions, listBuoiHoc, updateBuoiHoc, createGiaoVien, updateGiaoVien, ganGiaoVienChoLop, seedTenantFromGhl, handleOpportunityStageWebhook, getKinhDoanh } from "./ghl-write.mjs";
import { findStaff, listStaff, addStaff, setStaffRole, removeStaff, createSession, getSession, destroySession, getCmlKey, decryptGhlUserData } from "./auth.mjs";
import { kvGet, kvSet, getTenantByLocation, listTenants } from "./db.mjs";
import { handleOAuthInstall, buildAuthorizeUrl } from "./oauth-onboarding.mjs";
import { dispatchModule } from "./modules/index.mjs";
import { logWebhook } from "./webhook-log.mjs";
import { verifyGhlSignature } from "./webhook-signature.mjs";
const DELAY = Number(process.env.MIRROR_DELAY_MS ?? 140); // simulates a remote Supabase round-trip (measured ~140 ms)
// Module "Khách hàng" (demo 123 GYM, dữ liệu thật của 1 khách KHÁC hẳn mọi tenant Center Management) — cố
// tình KHÔNG deploy lên bản thật (data/ bị .gitignore hoàn toàn, không đưa PII lên git). File này chỉ tồn
// tại trên máy cục bộ; thiếu thì tự tắt module này. KHÔNG thuộc mô hình multi-tenant — giữ nguyên là 1 module
// demo cục bộ đơn lẻ, không theo tenant.
const contactsPath = new URL("./data/contacts.json", import.meta.url);
const contactsEnabled = fs.existsSync(contactsPath);
const all = contactsEnabled ? JSON.parse(fs.readFileSync(contactsPath, "utf8")).contacts : [];
const overlay = new Map(); // local-only edits, never sent to GHL

const THU_LABEL = { T2: "Thứ 2", T3: "Thứ 3", T4: "Thứ 4", T5: "Thứ 5", T6: "Thứ 6", T7: "Thứ 7", CN: "Chủ nhật" };
const THU_ORDER = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"];
// 2 khung giờ overlap khi start1 < end2 VÀ start2 < end1 (chuẩn kiểm tra chồng lấn khoảng thời gian).
const gioOverlap = (s1, e1, s2, e2) => s1 && e1 && s2 && e2 && s1 < e2 && s2 < e1;
// Dùng chung cho cả 2 hướng có thể gây trùng lịch dạy: (1) sửa lịch học của 1 lớp đã có GV, (2) gán GV cho
// 1 lớp đã có lịch học. `classes` = allClasses() của ĐÚNG tenant đang gọi — hàm này giờ thuần tuý (pure),
// không tự đọc trạng thái nào, để không phải biết tenant là gì.
function findTeacherConflict(classes, { lop, giaoVienTen, cacThuHoc, gioBatDau, gioKetThuc }) {
  const days = typeof cacThuHoc === "string" ? cacThuHoc.split(",").filter(Boolean) : (cacThuHoc || []);
  if (!giaoVienTen || !days.length || !gioBatDau || !gioKetThuc) return null;
  return classes.find((c) =>
    c.lop !== lop && c.giao_vien === giaoVienTen &&
    (c.cac_thu_hoc || "").split(",").some((t) => days.includes(t)) &&
    gioOverlap(gioBatDau, gioKetThuc, c.gio_bat_dau, c.gio_ket_thuc));
}
const teacherConflictMsg = (giaoVienTen, cacThuHoc, conflict) => {
  const days = typeof cacThuHoc === "string" ? cacThuHoc.split(",").filter(Boolean) : cacThuHoc;
  return `Trùng lịch: GV ${giaoVienTen} đã dạy lớp ${conflict.lop} vào ${THU_LABEL[days.find((t) => (conflict.cac_thu_hoc || "").split(",").includes(t))] || ""} ${conflict.gio_bat_dau}-${conflict.gio_ket_thuc}`;
};
const JS_DAY_TO_THU = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"]; // Date.getDay(): 0=CN...6=T7
// Server chạy giờ Asia/Saigon (UTC+7) — toISOString() luôn lùi lại 1 ngày (00:00 giờ VN = 17:00 UTC hôm
// TRƯỚC) nên KHÔNG BAO GIỜ dùng nó để lấy chuỗi yyyy-mm-dd theo lịch địa phương. Dùng hàm này thay thế.
const toLocalISODate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function datesForThu(cacThuHocStr, fromDate, toDate) {
  const wanted = new Set((cacThuHocStr || "").split(",").filter(Boolean));
  const dates = [];
  const d = new Date(fromDate + "T00:00:00"), end = new Date(toDate + "T00:00:00");
  while (d <= end) {
    if (wanted.has(JS_DAY_TO_THU[d.getDay()])) dates.push(toLocalISODate(d));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

// Quy tắc học bù mặc định cho 1 tenant MỚI (chưa từng lưu "config" riêng) — số buổi tối đa + loại vắng được
// bù do admin của TỪNG trung tâm tự chỉnh trong UI (Cấu hình), giá trị dưới đây chỉ là khởi điểm.
const DEFAULT_CONFIG = { hoc_bu: { so_buoi_toi_da: 4, loai_vang_duoc_bu: ["vang_co_phep"], cung_cap_do: true, han_dung: "ngay_het_han" } };
const ATT_STATUS = { co_mat: "Có mặt", vang_co_phep: "Vắng có phép", vang_khong_phep: "Vắng không phép", den_muon: "Đến muộn" };

// --- Trạng thái theo từng khách hàng (tenant), cache trong tiến trình theo locationId ------------------------
// Mỗi tenant có 8 khối trạng thái riêng (candy snapshot + 7 overlay/cấu hình) — TRƯỚC đây là 8 biến toàn cục
// nạp 1 lần lúc khởi động server cho ĐÚNG 1 khách; giờ gói chung vào 1 object, nạp lần đầu 1 khách nào đó gọi,
// tra đúng schema Postgres của khách đó (tenant.schema_name). Bộ nhớ trong tiến trình vẫn là nguồn đọc chính
// (đồng bộ, không cần chờ Postgres mỗi lần đọc) — save*() ghi nền (fire-and-forget) xuống Postgres.
const appStates = new Map(); // locationId -> AppState

// --- Đồng bộ lại khi GHL báo dữ liệu đổi (webhook, xem route /webhooks/ghl bên dưới) -------------------------
// Dồn nhiều webhook liên tiếp của CÙNG 1 tenant (ví dụ 1 đợt import/sửa hàng loạt bên GHL) thành ĐÚNG 1 lần
// đọc lại từ GHL, thay vì gọi seedTenantFromGhl ngay mỗi webhook — tốn API GHL vô ích và không cần thiết vì
// chỉ cần bản mới nhất sau khi đã "yên" 1 nhịp. Hẹn giờ theo từng tiến trình (không qua Postgres) — đủ dùng vì
// Render chỉ chạy 1 instance cho app này.
//
// Bug thật (bắt được 2026-10-19, test với tenant EIM thật): webhook GHL gửi gần như NGAY khi sửa, nhưng API
// mà seedTenantFromGhl dùng để ĐỌC LẠI toàn bộ record (listAllRecords, qua search index của GHL) có độ trễ
// riêng — có lúc đọc lại 8-13s sau khi sửa vẫn thấy field VỪA SỬA (vd Cơ sở) chưa cập nhật trong kết quả tìm
// kiếm, dù chính webhook đã báo đúng giá trị mới. Tăng debounce không chắc ăn (độ trễ index của GHL không cố
// định) — thay vào đó, sau lần đọc lại ĐẦU TIÊN (nhanh, đáp ứng tốt đa số trường hợp), hẹn thêm 1 lần đọc lại
// THỨ HAI muộn hơn để "tự sửa" nếu lần đầu dính đúng lúc index GHL chưa kịp — không lặp lại vô hạn, chỉ 1 lần.
const RESYNC_DEBOUNCE_MS = 8000;
const RESYNC_CATCHUP_MS = 20000; // chạy thêm sau lần đọc lại đầu, để bắt kịp index GHL nếu lần đầu bị trễ
const resyncTimers = new Map(); // locationId -> Timeout
const catchupTimers = new Map(); // locationId -> Timeout
function doResync(locationId, label) {
  return (async () => {
    try {
      await seedTenantFromGhl(locationId);
      appStates.delete(locationId); // bắt getAppState() đọc lại base_snapshot mới từ Postgres ở lần gọi kế tiếp
      console.log(`[webhook] Đã đồng bộ lại ${locationId} sau thay đổi từ GHL (${label})`);
    } catch (e) { console.error(`[webhook] Lỗi đồng bộ lại ${locationId} (${label}):`, e.message); }
  })();
}
function scheduleResync(locationId) {
  clearTimeout(resyncTimers.get(locationId));
  resyncTimers.set(locationId, setTimeout(async () => {
    resyncTimers.delete(locationId);
    await doResync(locationId, "lần 1");
    clearTimeout(catchupTimers.get(locationId));
    catchupTimers.set(locationId, setTimeout(() => {
      catchupTimers.delete(locationId);
      doResync(locationId, "lần 2, bắt kịp index GHL");
    }, RESYNC_CATCHUP_MS));
  }, RESYNC_DEBOUNCE_MS));
}

async function getAppState(tenant) {
  const locationId = tenant.location_id;
  if (appStates.has(locationId)) return appStates.get(locationId);
  const schema = tenant.schema_name;
  const onSaveErr = (label) => (e) => console.error(`[${schema}] Lưu ${label} vào Postgres thất bại:`, e.message);
  const t = {
    locationId, schema, tenant,
    candy: await kvGet(schema, "base_snapshot", { students: [], classes: [], attendance_seed: [] }),
    attOverlay: await kvGet(schema, "attendance_overlay", {}), // key: `${lop}|${date}` -> {studentN: {status, note}}
    enrollOverlay: await kvGet(schema, "enrollment_overlay", []),
    classOverlay: await kvGet(schema, "class_overlay", []), // Lớp tạo MỚI qua app (xem /api/candy/lop-tao) — base_snapshot là ảnh chụp/seed ban đầu, không tự thêm lớp mới vào đó
    ghOverrides: await kvGet(schema, "ghidanh_overrides", {}), // ghi_danh_id -> {ngay_het_han?, sessions_total?, ...}
    lopOverrides: await kvGet(schema, "lop_overrides", {}), // lop name -> {cac_thu_hoc?, gio_bat_dau?, gio_ket_thuc?, giao_vien?, giao_vien_id?}
    giaoVienList: await kvGet(schema, "giao_vien_list", []),
    candyConfig: await kvGet(schema, "config", DEFAULT_CONFIG),
    hocBuOverlay: await kvGet(schema, "hocbu_overlay", []),
  };
  t.saveAttOverlay = () => kvSet(schema, "attendance_overlay", t.attOverlay).catch(onSaveErr("attendance_overlay"));
  t.saveEnrollOverlay = () => kvSet(schema, "enrollment_overlay", t.enrollOverlay).catch(onSaveErr("enrollment_overlay"));
  t.nextEnrollN = () => 1000 + t.enrollOverlay.length;
  t.saveGhOverrides = () => kvSet(schema, "ghidanh_overrides", t.ghOverrides).catch(onSaveErr("ghidanh_overrides"));
  t.applyOverride = (s) => (t.ghOverrides[s.ghi_danh_id] ? { ...s, ...t.ghOverrides[s.ghi_danh_id] } : s);
  t.allStudents = () => [...t.candy.students, ...t.enrollOverlay].map(t.applyOverride);
  t.saveLopOverrides = () => kvSet(schema, "lop_overrides", t.lopOverrides).catch(onSaveErr("lop_overrides"));
  t.saveClassOverlay = () => kvSet(schema, "class_overlay", t.classOverlay).catch(onSaveErr("class_overlay"));
  t.allClasses = () => [...t.candy.classes, ...t.classOverlay].map((c) => ({
    ...c, ...(t.lopOverrides[c.lop] || {}),
    students: [...c.students, ...t.enrollOverlay.filter((e) => e.lop === c.lop).map((e) => e.n)],
  }));
  t.saveGiaoVien = () => kvSet(schema, "giao_vien_list", t.giaoVienList).catch(onSaveErr("giao_vien_list"));
  t.saveConfig = () => kvSet(schema, "config", t.candyConfig).catch(onSaveErr("config"));
  t.saveHocBuOverlay = () => kvSet(schema, "hocbu_overlay", t.hocBuOverlay).catch(onSaveErr("hocbu_overlay"));
  appStates.set(locationId, t);
  return t;
}

const dist = fileURLToPath(new URL("./dist/", import.meta.url));
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase();
const idx = all.map((c) => ({ c, key: fold(c.name) + " " + c.phone.replace(/\D/g, "") }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withOverlay = (c) => (overlay.has(c.id) ? { ...c, tags: [...new Set([...c.tags, ...overlay.get(c.id)])] } : c);
// Bug thật bắt được qua crash log thật (2026-10-21, ERR_HTTP_HEADERS_SENT): có đường nào đó response ĐÃ gửi
// xong rồi mà code vẫn cố gửi tiếp (vd catch-all ở cuối bắt 1 lỗi xảy ra SAU khi 1 nhánh khác đã trả lời) —
// Node ném lỗi cứng, làm sập luôn cả tiến trình (mọi request khác đang chạy cùng lúc cũng mất theo), không
// phải chỉ lỗi 1 request. Chặn tại nguồn: không gọi writeHead/end lần 2 lên cùng 1 response.
const json = (res, obj, code = 200) => {
  if (res.headersSent) { console.error("[json] Bỏ qua — response đã gửi trước đó rồi (double-response); xem log ngay trước dòng này để biết lỗi gốc."); return; }
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj));
};
const num = (v) => Number(String(v ?? "").replace(/[^\d.-]/g, "")) || 0;
// Thương hiệu mặc định cho MÀN HÌNH CHƯA ĐĂNG NHẬP — lúc này chưa biết đang phục vụ trung tâm nào (URL dùng
// chung cho mọi khách), nên hiện tên trung lập của chính nền tảng. Sau khi đăng nhập xong (biết tenant), UI
// tự đổi sang tên/logo riêng của trung tâm đó (đọc từ platform.tenants, không còn là 1 file JSON tĩnh nữa).
const DEFAULT_BRAND = { brandName: "Center Management", brandMark: "CM", orgLabel: "Trung tâm", menuLabel: "Vận hành" };
const brandOf = (tenant) => (tenant ? { brandName: tenant.brand_name, brandMark: tenant.brand_mark, orgLabel: tenant.org_label, menuLabel: tenant.menu_label } : DEFAULT_BRAND);
const notLoggedInPage = (brand, msg) => `<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${brand.brandName} · Vận hành</title>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f5f9;font:15px/1.5 system-ui,-apple-system,sans-serif;color:#161b26">
<div style="max-width:420px;padding:32px;text-align:center">
<div style="width:44px;height:44px;margin:0 auto 16px;border-radius:12px;background:linear-gradient(135deg,#3457e0,#7c5cff);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800">${brand.brandMark}</div>
<h2 style="margin:0 0 8px">Chưa đăng nhập</h2><p style="color:#667085">${msg}</p></div></body></html>`;
const ZALO_DOMAIN_TOKENS = ["HDsy29Ru62HVxRWyj9iB5N6hY0gTtLDNDJKm" /* OA Chat Connector */, "KuUHAOdv6ILxvvGRWiqa4GZ7z37aiIziCpWm" /* Anh ngữ EIM Lê Hồng Phong */, ...String(process.env.ZALO_DOMAIN_TOKENS || "").split(",").map((x) => x.trim()).filter(Boolean)];
// Hàm xử lý request xuất ra (export) để 1 app khác có thể "gắn" app này vào làm 1 route con của họ (vd
// app.use('/center', requestHandler) kiểu Express) thay vì phải tự chạy riêng 1 service Render — xem khối
// if dưới cùng file: chỉ tự khởi động http.createServer() khi file này được CHẠY TRỰC TIẾP (node server.mjs),
// không tự chạy khi bị import từ nơi khác.
export async function requestHandler(req, res) {
  const u = new URL(req.url, "http://x");
  try {
    // Xác thực domain cho Zalo Developers: mỗi app Zalo yêu cầu 1 file /zalo_verifier<mã>.html ở gốc domain.
    // Mã công khai (không bí mật) — chỉ phục vụ mã nằm trong danh sách (env ZALO_DOMAIN_TOKENS thêm được mà không cần sửa code).
    const zv = u.pathname.match(/^\/zalo_verifier([A-Za-z0-9]{20,64})\.html$/);
    if (zv && ZALO_DOMAIN_TOKENS.includes(zv[1])) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(`<!DOCTYPE html>\n<html lang="en">\n\n<head>\n    <meta property="zalo-platform-site-verification" content="${zv[1]}" />\n</head>\n\n<body>\nThere Is No Limit To What You Can Accomplish Using Zalo!\n</body>\n\n</html>\n`);
    }
    // Các module/app Marketplace khác (Zalo OA Connector...) nằm dưới /apps/<key>/ — xem modules/index.mjs.
    if (u.pathname.startsWith("/apps/") && await dispatchModule({ req, res, u, json })) return;
    // Webhook GHL báo dữ liệu đổi ngay trong CRM (vd nhân viên sửa trực tiếp trong GHL, không qua app) — xem
    // Marketplace App > Advanced Settings > Webhooks. Kiểm tra chữ ký Ed25519 (X-GHL-Signature) trên ĐÚNG byte
    // thô nhận được (không parse-rồi-stringify-lại, vì thứ tự field/khoảng trắng có thể khác bản gốc GHL ký) —
    // xem webhook-signature.mjs. Đã xác nhận THẬT (webhook thật từ GHL verify đúng, request tự gọi tay không
    // chữ ký verify sai) nên giờ CHẶN HẲN request chữ ký sai — không đồng bộ, không ghi "unknown"/"ping" linh
    // tinh vào nhật ký. Luôn trả 200 ngay khi chữ ký hợp lệ, không chờ đồng bộ xong.
    if (req.method === "POST" && u.pathname === "/webhooks/ghl") {
      let raw = ""; for await (const ch of req) raw += ch;
      const signatureValid = verifyGhlSignature(raw, req.headers["x-ghl-signature"]);
      if (!signatureValid) {
        console.warn("[webhook] Chữ ký không hợp lệ — từ chối request.");
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "invalid signature" }));
      }
      let body = null; try { body = JSON.parse(raw); } catch {}
      const type = (body && body.type) || "unknown";
      const locationId = (body && body.locationId) || null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      logWebhook({ type, locationId, headers: req.headers, body, signatureValid }).catch((e) => console.error("[webhook] Lưu nhật ký thất bại:", e.message));
      if (locationId && /^(Record|Relation)/.test(type)) scheduleResync(locationId);
      // Hand-off Opportunity → Ghi danh (xem ghl-write.mjs:handleOpportunityStageWebhook) — chạy nền, không
      // chặn phản hồi 200 cho GHL (đã trả ở trên).
      if (locationId && type === "OpportunityStageUpdate" && body?.id && body?.pipelineStageId) {
        handleOpportunityStageWebhook(locationId, { opportunityId: body.id, pipelineStageId: body.pipelineStageId, contactId: body.contactId, name: body.name })
          .then((r) => { if (!r.skipped) console.log(`[opportunity-handoff] Tạo học viên ${r.hocVienId} ("${r.studentName}") từ Opportunity ${body.id} (${locationId})`); })
          .catch((e) => console.error(`[opportunity-handoff] Lỗi xử lý Opportunity ${body.id} (${locationId}):`, e.message));
      }
      return;
    }
    // Công khai, không cần đăng nhập — nếu đã có token hợp lệ (Bearer) thì trả thương hiệu ĐÚNG của tenant
    // đó; chưa có/không hợp lệ thì trả thương hiệu trung lập của nền tảng (xem DEFAULT_BRAND ở trên).
    if (u.pathname === "/api/branding") {
      const authHeader0 = req.headers["authorization"] || "";
      const token0 = authHeader0.startsWith("Bearer ") ? authHeader0.slice(7) : null;
      const sess0 = token0 ? await getSession(token0) : null;
      const tenant0 = sess0 ? await getTenantByLocation(sess0.locationId) : null;
      return json(res, { ...brandOf(tenant0), khachHangEnabled: contactsEnabled });
    }
    // Đăng nhập qua GHL Custom Menu Link (Tầng 1): URL phải mang cả email VÀ location_id (2 merge field GHL
    // tự thay bằng dữ liệu thật — {{user.email}} và {{location.id}}) để biết CHÍNH XÁC đang đăng nhập vào
    // trung tâm nào, vì giờ 1 URL/server phục vụ nhiều trung tâm cùng lúc. ĐÃ XÁC NHẬN THỰC TẾ (test
    // 2026-09-24): dù chọn "Open in a New Browser Tab", GHL vẫn mở 1 trang do CHÍNH GHL host rồi nhúng app
    // của mình vào BÊN TRONG qua iframe — cookie bị chặn, nên dùng token qua localStorage + Authorization thay.
    if (req.method === "GET" && !u.pathname.startsWith("/api/") && u.searchParams.get("email")) {
      const locationId = u.searchParams.get("location_id");
      const tenant = locationId ? await getTenantByLocation(locationId) : null;
      // Bắt buộc kèm đúng khoá bí mật (?k=) chỉ nằm trong URL đã lưu ở Custom Menu Link trên GHL — chặn kiểu
      // giả mạo "biết domain + biết đúng 1 email nhân viên là tự gõ URL đăng nhập luôn, không cần qua GHL".
      const row = (tenant && u.searchParams.get("k") === getCmlKey()) ? await findStaff(tenant.schema_name, u.searchParams.get("email")) : null;
      if (!row) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(notLoggedInPage(brandOf(tenant), "Liên kết không hợp lệ hoặc bạn chưa được cấp quyền truy cập. Liên hệ quản lý để được hỗ trợ."));
      }
      const sid = await createSession({ locationId, email: row.email, name: row.name, role: row.role });
      let html;
      try { html = fs.readFileSync(path.join(dist, "index.html"), "utf8"); }
      catch { return res.end(notLoggedInPage(brandOf(tenant), "Lỗi tải ứng dụng — chưa build (npm run build)?")); }
      html = html.replace("<head>", `<head><script>window.__CANDY_TOKEN__=${JSON.stringify(sid)};</script>`);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    // Điểm vào cho người cài ở CẤP AGENCY: GHL không trả locationId khi cài từ giao diện agency (xác nhận
    // thật trên API, không phải do chọn sai lúc consent) — nên phải hỏi TRƯỚC đang định cài cho sub-account
    // nào, nhét vào `state`, GHL echo lại đúng nguyên giá trị này tới /oauth/callback. Chỉ cần cho người
    // cài biết Location ID của sub-account cần dùng (xem trong GHL: Settings > Business Profile, hoặc URL
    // của sub-account dạng .../location/<id>/...).
    if (req.method === "GET" && u.pathname === "/oauth/start") {
      const err = u.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(`<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kết nối Center Management</title>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f5f9;font:15px/1.5 system-ui,-apple-system,sans-serif;color:#161b26">
<div style="max-width:440px;width:100%;padding:32px">
<h2 style="margin:0 0 8px">Kết nối Center Management</h2>
<p style="color:#667085;margin:0 0 20px">Bạn đang cài từ giao diện AGENCY — GHL cần biết trước đang kết nối cho sub-account nào. Dán Location ID của sub-account đó (Settings &gt; Business Profile trong sub-account, hoặc nhìn trong URL dạng .../location/&lt;id&gt;/...).</p>
${err ? `<p style="background:#fde8e8;color:#c22;padding:10px 14px;border-radius:8px;margin:0 0 16px">${err}</p>` : ""}
<form method="GET" action="go">
<input name="location_id" placeholder="Location ID" required style="width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #d0d5dd;border-radius:8px;font-size:15px;margin-bottom:12px">
<button type="submit" style="width:100%;padding:12px 14px;border:none;border-radius:8px;background:linear-gradient(135deg,#3457e0,#7c5cff);color:#fff;font-size:15px;font-weight:600;cursor:pointer">Tiếp tục tới GHL</button>
</form>
</div></body></html>`);
    }
    if (req.method === "GET" && u.pathname === "/oauth/go") {
      const locationId = String(u.searchParams.get("location_id") || "").trim();
      if (!locationId) {
        res.writeHead(302, { Location: "start?error=" + encodeURIComponent("Cần nhập Location ID") });
        return res.end();
      }
      res.writeHead(302, { Location: buildAuthorizeUrl(locationId) });
      return res.end();
    }
    // Khách TỰ CÀI app qua OAuth của Marketplace (thay cho PIT tay + 2 lệnh node) — GHL gọi lại route này
    // ngay sau khi người dùng bấm Install/Allow trên subaccount của họ. Toàn bộ việc đổi code lấy token, tạo
    // tenant, đặt admin đầu tiên, dựng dữ liệu ban đầu nằm trong oauth-onboarding.mjs; route này chỉ gọi và
    // hiện kết quả bằng 1 trang HTML đơn giản (không phải JSON — đây là trình duyệt GHL chuyển hướng tới,
    // không phải fetch từ app).
    if (req.method === "GET" && u.pathname === "/oauth/callback") {
      const page = (title, msg, ok) => `<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f5f9;font:15px/1.5 system-ui,-apple-system,sans-serif;color:#161b26">
<div style="max-width:440px;padding:32px;text-align:center">
<div style="width:44px;height:44px;margin:0 auto 16px;border-radius:12px;background:${ok ? "linear-gradient(135deg,#3457e0,#7c5cff)" : "#e5484d"};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800">${ok ? "✓" : "!"}</div>
<h2 style="margin:0 0 8px">${title}</h2><p style="color:#667085">${msg}</p></div></body></html>`;
      if (u.searchParams.get("error")) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(page("Không thể kết nối", "GHL báo huỷ hoặc từ chối cấp quyền. Thử lại từ Marketplace nếu đây là nhầm lẫn.", false));
      }
      const code = u.searchParams.get("code");
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(page("Thiếu mã xác thực", "URL chuyển hướng từ GHL thiếu ?code= — thử cài lại từ Marketplace.", false));
      }
      const state = u.searchParams.get("state") || null;
      try {
        const r = await handleOAuthInstall({ code, state });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(page(
          "Đã kết nối!",
          r.reconnected
            ? `Đã làm mới kết nối GHL cho "${r.brandName || r.schemaName}". Vào lại GHL và bấm menu/Custom Page để tiếp tục dùng.`
            : `Đã tạo tài khoản cho "${r.brandName}"${r.adminEmail ? ` — ${r.adminEmail} là quản lý đầu tiên` : ""}${r.seeded?.classes ? `, đã lấy sẵn ${r.seeded.classes} lớp/${r.seeded.students} học viên từ GHL` : ""}. Vào GHL và bấm menu/Custom Page của app để bắt đầu dùng.`,
          true,
        ));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(page("Không thể kết nối", String(e.message), false));
      }
    }
    // Tầng 2 — Custom Page trong Marketplace App (postMessage): trang gửi encryptedData nhận được từ GHL lên
    // đây để giải mã Ở PHÍA SERVER. Gói dữ liệu GHL trả về có `activeLocation` — CHÍNH LÀ locationId của
    // trung tâm mà người này đang bấm vào Custom Page, tự nhiên đã multi-tenant-sẵn (không cần thêm gì ở
    // phía GHL) — chỉ cần tra platform.tenants bằng giá trị này để biết đang phục vụ ai.
    if (req.method === "POST" && u.pathname === "/api/candy/sso-verify") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      let payload;
      try { payload = decryptGhlUserData(input.encryptedData); }
      catch (e) { return json(res, { error: "Không xác thực được dữ liệu từ GHL: " + e.message }, 400); }
      // GHL chỉ gửi `activeLocation` khi trang được mở từ NGỮ CẢNH SUB-ACCOUNT; mở từ giao diện agency thì
      // payload không có trường này (xác nhận theo tài liệu GHL "user context"). Khi đó chỉ tự chọn trung tâm
      // nếu email này là nhân viên của ĐÚNG 1 trung tâm (không yếu hơn bản 1-khách cũ vốn chỉ tra theo email);
      // thuộc nhiều trung tâm thì không đoán — báo rõ để mở lại từ trong sub-account cần dùng.
      let locationId = payload.activeLocation;
      let tenant = locationId ? await getTenantByLocation(locationId) : null;
      if (!locationId) {
        const matches = [];
        for (const t0 of await listTenants()) if (await findStaff(t0.schema_name, payload.email)) matches.push(t0);
        if (matches.length === 1) { tenant = await getTenantByLocation(matches[0].location_id); locationId = tenant.location_id; }
        else if (matches.length > 1) return json(res, { error: "Tài khoản này thuộc nhiều trung tâm — hãy mở app từ bên trong sub-account của trung tâm cần dùng." }, 400);
        else { console.error("[sso-verify] payload không có activeLocation, keys:", Object.keys(payload).join(",")); return json(res, { error: "Không xác định được trung tâm từ dữ liệu GHL — hãy mở app từ bên trong sub-account." }, 400); }
      }
      if (!tenant) return json(res, { error: "Trung tâm này chưa được cấp phép sử dụng hệ thống. Liên hệ quản trị để được thêm vào." }, 403);
      const row = await findStaff(tenant.schema_name, payload.email);
      if (!row) return json(res, { error: "Tài khoản chưa được cấp quyền truy cập. Liên hệ quản lý để được thêm vào danh sách nhân viên." }, 403);
      const sid = await createSession({ locationId, email: row.email, name: row.name, role: row.role });
      return json(res, { ok: true, token: sid });
    }
    const authHeader = req.headers["authorization"] || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const sess = await getSession(token);
    const tenant = sess ? await getTenantByLocation(sess.locationId) : null;
    // Lấy VAI TRÒ hiện tại từ danh sách nhân viên CỦA ĐÚNG TENANT (findStaff), không tin vai trò lưu sẵn
    // trong session lúc đăng nhập — nếu chỉ tin session, 1 quản lý xoá quyền/hạ vai trò của ai đó thì người
    // đó vẫn giữ quyền CŨ cho tới khi tự đăng xuất, làm cho tính năng "phân quyền" gần như vô nghĩa.
    const liveStaff = sess && tenant ? await findStaff(tenant.schema_name, sess.email) : null;
    const user = liveStaff ? { email: sess.email, name: liveStaff.name || sess.name, role: liveStaff.role, locationId: sess.locationId } : null;
    if (u.pathname.startsWith("/api/")) {
      if (!user) {
        if (sess) await destroySession(token); // nhân viên đã bị xoá khỏi danh sách, hoặc tenant không còn tồn tại — dọn luôn session cũ
        return json(res, { error: "Chưa đăng nhập" }, 401);
      }
      if (u.pathname === "/api/candy/me") return json(res, user);
      if (req.method === "POST" && u.pathname === "/api/candy/logout") {
        await destroySession(token);
        return json(res, { ok: true });
      }
    }
    // Chặn thao tác quản trị (quản lý giáo viên, sửa quy tắc, quản lý nhân viên) ở đúng route ghi dữ liệu —
    // ẩn nút trên UI không phải là bảo mật thật, phải chặn tại đây thì mới không bypass được bằng cách gọi
    // thẳng API.
    const ADMIN_ONLY = new Set(["/api/candy/giao-vien", "/api/candy/giao-vien-sua", "/api/candy/config", "/api/candy/staff-add", "/api/candy/staff-role", "/api/candy/staff-remove"]);
    if (req.method === "POST" && ADMIN_ONLY.has(u.pathname) && user.role !== "admin") {
      return json(res, { error: "Chỉ quản lý (admin) mới được thực hiện thao tác này" }, 403);
    }
    if (u.pathname === "/api/candy/staff-list") {
      if (user.role !== "admin") return json(res, { error: "Chỉ quản lý (admin) mới xem được danh sách nhân viên" }, 403);
      return json(res, await listStaff(tenant.schema_name));
    }
    if (req.method === "POST" && u.pathname === "/api/candy/staff-add") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      try { return json(res, { ok: true, staff: await addStaff(tenant.schema_name, input) }); } catch (e) { return json(res, { error: String(e.message) }, 400); }
    }
    if (req.method === "POST" && u.pathname === "/api/candy/staff-role") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      try { return json(res, { ok: true, staff: await setStaffRole(tenant.schema_name, input.email, input.role) }); } catch (e) { return json(res, { error: String(e.message) }, 400); }
    }
    if (req.method === "POST" && u.pathname === "/api/candy/staff-remove") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      if (String(input.email || "").trim().toLowerCase() === String(user.email || "").trim().toLowerCase()) return json(res, { error: "Không thể tự xoá chính mình khỏi danh sách" }, 400);
      return json(res, { ok: await removeStaff(tenant.schema_name, input.email) });
    }
    if (u.pathname === "/api/contacts") {
      await sleep(DELAY);
      const q = fold(u.searchParams.get("q")).trim(), tag = u.searchParams.get("tag"), sort = u.searchParams.get("sort") || "recent";
      const page = Math.max(1, Number(u.searchParams.get("page")) || 1), size = 100;
      let rows = idx.filter((x) => (!q || x.key.includes(q)) && (!tag || x.c.tags.includes(tag))).map((x) => withOverlay(x.c));
      if (sort === "xu") rows.sort((a, b) => num(b.fields["Xu tích luỹ"]) - num(a.fields["Xu tích luỹ"]));
      else if (sort === "name") rows.sort((a, b) => a.name.localeCompare(b.name, "vi"));
      else rows.sort((a, b) => String(b.lastActivity).localeCompare(String(a.lastActivity)));
      return json(res, { total: rows.length, page, size, rows: rows.slice((page - 1) * size, page * size) });
    }
    if (u.pathname === "/api/tags") {
      await sleep(DELAY); const n = {}; for (const c of all) for (const t of c.tags) n[t] = (n[t] || 0) + 1;
      return json(res, Object.entries(n).sort((a, b) => b[1] - a[1]).slice(0, 40));
    }
    let m;
    if ((m = u.pathname.match(/^\/api\/contact\/([\w-]+)$/))) {
      await sleep(DELAY); const c = all.find((x) => x.id === m[1]); if (!c) return json(res, { error: "not found" }, 404);
      return json(res, withOverlay(c));
    }
    if ((m = u.pathname.match(/^\/api\/contact\/([\w-]+)\/notes$/))) {
      const j = await ghlGet(`/contacts/${m[1]}/notes`); // read-only, live
      return json(res, (j.notes || []).slice(0, 5).map((n) => ({ at: n.dateAdded, body: String(n.body || "").slice(0, 300) })));
    }
    if (req.method === "POST" && (m = u.pathname.match(/^\/api\/contact\/([\w-]+)\/tag$/))) {
      let body = ""; for await (const ch of req) body += ch; const tag = String(JSON.parse(body).tag || "").trim().slice(0, 40);
      if (tag) overlay.set(m[1], [...(overlay.get(m[1]) || []), tag]); // LOCAL ONLY
      return json(res, { ok: true, localOnly: true });
    }
    // Mọi route bên dưới đây thao tác dữ liệu của 1 trung tâm cụ thể — nạp/lấy đúng AppState của tenant
    // đang đăng nhập. Đứng SAU nhóm route "Khách hàng"/"nhân viên" ở trên vì những route đó hoặc không cần
    // AppState, hoặc (staff-*) chỉ cần tenant.schema_name (đã có sẵn từ block xác thực).
    // Bug thật bắt được lúc test: TRƯỚC đây gọi getAppState(tenant) KHÔNG điều kiện — request tải file JS/CSS
    // tĩnh (/assets/*.js, không mang Authorization) cũng chạy TỚI ĐÂY (không khớp route nào trước đó), lúc
    // đó `tenant` là null (chưa đăng nhập cho request đó) → getAppState(null) crash → toàn bộ asset trả 500,
    // app trắng trang. Chỉ nạp AppState khi THẬT SỰ cần (đường dẫn /api/candy/* VÀ đã có user).
    const t = (user && u.pathname.startsWith("/api/candy/")) ? await getAppState(tenant) : null;
    // Danh sách cơ sở (key + nhãn) lấy thẳng từ GHL của trung tâm đang đăng nhập — xem getCoSoOptions.
    if (u.pathname === "/api/candy/co-so") return json(res, { options: await getCoSoOptions(user.locationId) });
    if (u.pathname === "/api/candy/classes") {
      await sleep(DELAY);
      return json(res, t.allClasses().map((c) => ({ lop: c.lop, co_so: c.co_so, siso: c.students.length, trang_thai: c.trang_thai, cap_do: c.cap_do || "", giao_vien: c.giao_vien || "", si_so_toi_da: c.si_so_toi_da || "", cac_thu_hoc: c.cac_thu_hoc || "", gio_bat_dau: c.gio_bat_dau || "", gio_ket_thuc: c.gio_ket_thuc || "" })));
    }
    // Toàn bộ Học viên (kể cả chưa ghi danh vào lớp nào) — trước đây app chỉ xem học viên QUA từng Lớp, nên
    // 1 học viên chưa xếp lớp hoàn toàn không hiện ở đâu cả (bắt thật lúc import EIM: 4/125 em rơi vào
    // trường hợp này). `all_hoc_vien` do seedTenantFromGhl() dựng trực tiếp từ object Học viên trên GHL,
    // không qua Ghi danh — join thêm (các) lớp đang học nếu có.
    if (u.pathname === "/api/candy/hoc-vien-ds") {
      await sleep(DELAY);
      const enrolledByHv = new Map();
      for (const s of t.allStudents()) {
        if (!enrolledByHv.has(s.hoc_vien_id)) enrolledByHv.set(s.hoc_vien_id, []);
        enrolledByHv.get(s.hoc_vien_id).push({ lop: s.lop, gd_trang_thai: s.gd_trang_thai });
      }
      const rows = (t.candy.all_hoc_vien || []).map((hv) => ({
        ...hv,
        ghi_danh: enrolledByHv.get(hv.hoc_vien_id) || [],
      }));
      return json(res, rows);
    }
    // Tạo lớp mới — trước đây app chỉ xem/sửa lớp có sẵn; khách mới (đặc biệt qua OAuth tự cài) có thể
    // chưa có lớp nào trên GHL để bắt đầu.
    if (req.method === "POST" && u.pathname === "/api/candy/lop-tao") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      const { name, coSo, capDo, siSoToiDa } = input || {};
      if (!name || !name.trim()) return json(res, { error: "Cần tên lớp" }, 400);
      if (t.allClasses().find((c) => c.lop === name.trim())) return json(res, { error: `Đã có lớp tên "${name.trim()}" rồi` }, 400);
      if (!(await writerEnabled(user.locationId))) return json(res, { error: "Chưa bật ghi thật (chưa kết nối GHL)" }, 400);
      try {
        const r = await createLop(user.locationId, { name, coSo, capDo, siSoToiDa });
        const row = { lop: r.lop, lop_id: r.lopId, co_so: r.co_so, trang_thai: "dang_mo", cap_do: r.cap_do, si_so_toi_da: r.si_so_toi_da, cac_thu_hoc: "", gio_bat_dau: "", gio_ket_thuc: "", students: [] };
        t.classOverlay.push(row);
        t.saveClassOverlay();
        return json(res, { ok: true, lop: row });
      } catch (e) {
        return json(res, { error: String(e.message) }, 400);
      }
    }
    if ((m = u.pathname.match(/^\/api\/candy\/class\/([^/]+)$/))) {
      await sleep(DELAY);
      const lop = decodeURIComponent(m[1]);
      const date = u.searchParams.get("date") || "";
      const cls = t.allClasses().find((c) => c.lop === lop);
      if (!cls) return json(res, { error: "not found" }, 404);
      const key = `${lop}|${date}`;
      const overlayForDate = t.attOverlay[key] || {};
      const students = t.allStudents();
      const roster = cls.students.map((n) => {
        const s = students.find((x) => x.n === n);
        const seeded = t.candy.attendance_seed.find((a) => a.student_n === n && a.date === date);
        const ov = overlayForDate[n];
        const marked = ov || (seeded ? { status: seeded.status, note: seeded.note || "", real: true } : null);
        return { n: s.n, name: s.name, ghi_danh_id: s.ghi_danh_id, sessions_total: s.sessions_total, marked };
      });
      return json(res, { lop, co_so: cls.co_so, date, roster, statusLabels: ATT_STATUS });
    }
    if (u.pathname === "/api/candy/lop") {
      await sleep(DELAY);
      const lop = u.searchParams.get("lop");
      const cls = t.allClasses().find((c) => c.lop === lop);
      if (!cls) return json(res, { error: "not found" }, 404);
      const students = t.allStudents();
      const roster = cls.students.map((n) => students.find((s) => s.n === n));
      return json(res, { ...cls, roster });
    }
    // Danh sách học viên (allowlist) để chọn khi xếp lớp — kèm các lớp đang/đã học để UI có thể gợi ý loại
    // trừ (không ghi danh trùng vào 1 lớp đã có ghi danh "đang học").
    if (u.pathname === "/api/candy/hoc-vien-test") {
      await sleep(DELAY);
      const byHocVien = new Map();
      for (const s of t.allStudents()) {
        if (!byHocVien.has(s.hoc_vien_id)) byHocVien.set(s.hoc_vien_id, { hoc_vien_id: s.hoc_vien_id, name: s.name, lops: [] });
        byHocVien.get(s.hoc_vien_id).lops.push({ lop: s.lop, gd_trang_thai: s.gd_trang_thai });
      }
      return json(res, [...byHocVien.values()].sort((a, b) => a.name.localeCompare(b.name, "vi")));
    }
    if (req.method === "POST" && u.pathname === "/api/candy/ghi-danh") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      // "newStudent" (thay vì hocVienId): xếp lớp cho 1 học viên HOÀN TOÀN MỚI, tạo Học viên trên GHL rồi
      // ghi danh luôn trong cùng 1 thao tác.
      const { hocVienId, newStudent, lop, ngayBatDau, ngayHetHan, tongSoBuoi, hocPhi, tienGiaoCu } = input || {};
      let student = null;
      if (!newStudent) {
        student = t.allStudents().find((s) => s.hoc_vien_id === hocVienId);
        if (!student) return json(res, { error: "Không tìm thấy học viên" }, 400);
        if (student.lop === lop && student.gd_trang_thai === "dang_hoc") return json(res, { error: `${student.name} đã đang học lớp ${lop} rồi` }, 400);
      } else if (!newStudent.name || !newStudent.name.trim()) {
        return json(res, { error: "Cần tên học viên mới" }, 400);
      }
      const cls = t.allClasses().find((c) => c.lop === lop);
      if (!cls) return json(res, { error: "Không tìm thấy lớp" }, 400);
      const maxSiSo = Number(cls.si_so_toi_da) || 0;
      if (maxSiSo && cls.students.length >= maxSiSo) return json(res, { error: `Lớp ${lop} đã đủ sĩ số tối đa (${maxSiSo}), không thể xếp thêm` }, 400);
      if (!(await writerEnabled(user.locationId))) return json(res, { error: "Chưa bật ghi thật (thiếu GHL_PIT)" }, 400);
      try {
        let finalHocVienId = hocVienId, studentName, ngaySinh, hvTrangThai;
        if (newStudent) {
          const created = await createHocVien(user.locationId, { name: newStudent.name, ngaySinh: newStudent.ngaySinh, coSo: newStudent.coSo || cls.co_so });
          finalHocVienId = created.hocVienId;
          studentName = newStudent.name.trim();
          ngaySinh = newStudent.ngaySinh || "";
          hvTrangThai = "dang_hoc";
        } else {
          studentName = student.name; ngaySinh = student.ngay_sinh; hvTrangThai = student.hv_trang_thai;
        }
        const r = await enrollStudent(user.locationId, { hocVienId: finalHocVienId, studentName, lop, ngayBatDau, ngayHetHan, tongSoBuoi, hocPhi, tienGiaoCu });
        const row = {
          n: t.nextEnrollN(), name: studentName, hoc_vien_id: finalHocVienId, ghi_danh_id: r.ghiDanhId,
          lop, lop_id: r.lopId, co_so: cls.co_so, sessions_total: tongSoBuoi || "", fee: Number(hocPhi) || 0,
          so_buoi_da_hoc: 0, gd_trang_thai: "dang_hoc", ngay_sinh: ngaySinh, hv_trang_thai: hvTrangThai,
          tien_giao_cu: Number(tienGiaoCu) || 0, ngay_bat_dau: ngayBatDau, ngay_het_han: ngayHetHan || "",
        };
        t.enrollOverlay.push(row);
        t.saveEnrollOverlay();
        return json(res, { ok: true, ghi_danh_id: r.ghiDanhId, row });
      } catch (e) {
        return json(res, { error: String(e.message) }, 400);
      }
    }
    // Đóng vòng đời ghi danh: đổi thẳng trạng thái (Tạm nghỉ/Tiếp tục học/Hoàn thành/Đã nghỉ). KHÔNG nhận
    // "da_chuyen_lop" ở đây — trạng thái đó chỉ set được như tác dụng phụ của /chuyen-lop bên dưới.
    if (req.method === "POST" && u.pathname === "/api/candy/ghi-danh-trang-thai") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      const { ghiDanhId, trangThai } = input || {};
      if (trangThai === "da_chuyen_lop") return json(res, { error: "Dùng \"Chuyển lớp\" thay vì đổi trạng thái trực tiếp — cần tạo ghi danh mới đi kèm" }, 400);
      if (!(await writerEnabled(user.locationId))) return json(res, { error: "Chưa bật ghi thật (thiếu GHL_PIT)" }, 400);
      try {
        await setGhiDanhTrangThai(user.locationId, { ghiDanhId, trangThai });
        t.ghOverrides[ghiDanhId] = { ...(t.ghOverrides[ghiDanhId] || {}), gd_trang_thai: trangThai };
        t.saveGhOverrides();
        return json(res, { ok: true, ghi_danh_id: ghiDanhId, gd_trang_thai: trangThai });
      } catch (e) {
        return json(res, { error: String(e.message) }, 400);
      }
    }
    // Chuyển lớp: tạo 1 Ghi danh MỚI ở lớp mới (tái dùng enrollStudent) rồi đóng Ghi danh CŨ (trạng thái
    // "Đã chuyển lớp") — giữ nguyên lịch sử thay vì sửa đè.
    if (req.method === "POST" && u.pathname === "/api/candy/chuyen-lop") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      const { ghiDanhIdCu, hocVienId, lopMoi, ngayBatDau, ngayHetHan, tongSoBuoi, hocPhi, tienGiaoCu } = input || {};
      const student = t.allStudents().find((s) => s.hoc_vien_id === hocVienId);
      if (!student) return json(res, { error: "Không tìm thấy học viên" }, 400);
      if (student.lop === lopMoi) return json(res, { error: `Học viên đang ở lớp ${lopMoi} rồi, chọn lớp khác` }, 400);
      const cls = t.allClasses().find((c) => c.lop === lopMoi);
      if (!cls) return json(res, { error: "Không tìm thấy lớp mới" }, 400);
      const maxSiSo = Number(cls.si_so_toi_da) || 0;
      if (maxSiSo && cls.students.length >= maxSiSo) return json(res, { error: `Lớp ${lopMoi} đã đủ sĩ số tối đa (${maxSiSo}), không thể chuyển sang` }, 400);
      if (!(await writerEnabled(user.locationId))) return json(res, { error: "Chưa bật ghi thật (thiếu GHL_PIT)" }, 400);
      try {
        const r = await enrollStudent(user.locationId, { hocVienId, studentName: student.name, lop: lopMoi, ngayBatDau, ngayHetHan, tongSoBuoi, hocPhi, tienGiaoCu });
        const row = {
          n: t.nextEnrollN(), name: student.name, hoc_vien_id: hocVienId, ghi_danh_id: r.ghiDanhId,
          lop: lopMoi, lop_id: r.lopId, co_so: cls.co_so, sessions_total: tongSoBuoi || "", fee: Number(hocPhi) || 0,
          so_buoi_da_hoc: 0, gd_trang_thai: "dang_hoc", ngay_sinh: student.ngay_sinh, hv_trang_thai: student.hv_trang_thai,
          tien_giao_cu: Number(tienGiaoCu) || 0, ngay_bat_dau: ngayBatDau, ngay_het_han: ngayHetHan || "",
        };
        t.enrollOverlay.push(row);
        t.saveEnrollOverlay();
        try {
          await setGhiDanhTrangThai(user.locationId, { ghiDanhId: ghiDanhIdCu, trangThai: "da_chuyen_lop" });
          t.ghOverrides[ghiDanhIdCu] = { ...(t.ghOverrides[ghiDanhIdCu] || {}), gd_trang_thai: "da_chuyen_lop" };
          t.saveGhOverrides();
        } catch (e2) {
          return json(res, { ok: true, partial: true, ghi_danh_id_moi: r.ghiDanhId, row, warning: `Đã ghi danh lớp mới thành công, nhưng KHÔNG đóng được ghi danh cũ (${String(e2.message)}) — vào lớp cũ tự đổi trạng thái.` });
        }
        return json(res, { ok: true, ghi_danh_id_moi: r.ghiDanhId, row });
      } catch (e) {
        return json(res, { error: String(e.message) }, 400);
      }
    }
    // Gia hạn: cập nhật ngay_het_han/tong_so_buoi trên 1 Ghi danh đã có, ghi THẬT vào GHL rồi lưu override
    // cục bộ để mọi route đọc allStudents() thấy ngay giá trị mới (không cần fetch lại từ GHL).
    if (req.method === "POST" && u.pathname === "/api/candy/gia-han") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      const { ghiDanhId, ngayHetHanMoi, tongSoBuoiMoi } = input || {};
      if (!(await writerEnabled(user.locationId))) return json(res, { error: "Chưa bật ghi thật (thiếu GHL_PIT)" }, 400);
      try {
        await renewEnrollment(user.locationId, { ghiDanhId, ngayHetHanMoi, tongSoBuoiMoi });
        const patch = {};
        if (ngayHetHanMoi) patch.ngay_het_han = ngayHetHanMoi;
        if (tongSoBuoiMoi) patch.sessions_total = tongSoBuoiMoi;
        t.ghOverrides[ghiDanhId] = { ...(t.ghOverrides[ghiDanhId] || {}), ...patch };
        t.saveGhOverrides();
        return json(res, { ok: true, ghi_danh_id: ghiDanhId, ...patch });
      } catch (e) {
        return json(res, { error: String(e.message) }, 400);
      }
    }
    // Thời khoá biểu: lưu lịch học có cấu trúc cho 1 lớp, kiểm tra trùng lịch dạy của giáo viên TRƯỚC khi
    // ghi — đây là "brain" ở backend, GHL chỉ là "hands".
    if (req.method === "POST" && u.pathname === "/api/candy/lich-hoc") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      const { lop, cacThuHoc, gioBatDau, gioKetThuc } = input || {};
      const cls = t.allClasses().find((c) => c.lop === lop);
      if (!cls) return json(res, { error: "Không tìm thấy lớp" }, 400);
      {
        const conflict = findTeacherConflict(t.allClasses(), { lop, giaoVienTen: cls.giao_vien, cacThuHoc, gioBatDau, gioKetThuc });
        if (conflict) return json(res, { error: teacherConflictMsg(cls.giao_vien, cacThuHoc, conflict) }, 400);
      }
      if (!(await writerEnabled(user.locationId))) return json(res, { error: "Chưa bật ghi thật (thiếu GHL_PIT)" }, 400);
      try {
        await setLichHoc(user.locationId, { lop, cacThuHoc, gioBatDau, gioKetThuc });
        t.lopOverrides[lop] = { cac_thu_hoc: (cacThuHoc || []).join(","), gio_bat_dau: gioBatDau || "", gio_ket_thuc: gioKetThuc || "" };
        t.saveLopOverrides();
        return json(res, { ok: true, lop, ...t.lopOverrides[lop] });
      } catch (e) {
        return json(res, { error: String(e.message) }, 400);
      }
    }
    // Sinh lịch buổi học trước: tạo Buổi học cho N tuần sắp tới dựa trên cac_thu_hoc, thay vì chỉ tạo
    // phản ứng lúc điểm danh.
    if (req.method === "POST" && u.pathname === "/api/candy/sinh-lich-buoi-hoc") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      const { lop, soTuan } = input || {};
      const weeks = Math.min(Math.max(Number(soTuan) || 4, 1), 8); // chặn tối đa 8 tuần/lần — tránh dồn quá nhiều lệnh ghi 1 lúc
      const cls = t.allClasses().find((c) => c.lop === lop);
      if (!cls) return json(res, { error: "Không tìm thấy lớp" }, 400);
      if (!cls.cac_thu_hoc) return json(res, { error: `Lớp ${lop} chưa có lịch học — vào "Quản lý lớp" nhập lịch trước` }, 400);
      const today = toLocalISODate(new Date());
      const toDate = toLocalISODate(new Date(Date.now() + weeks * 7 * 86400000));
      const dates = datesForThu(cls.cac_thu_hoc, today, toDate);
      if (!dates.length) return json(res, { error: "Không có ngày nào khớp lịch học trong khoảng đã chọn" }, 400);
      if (!(await writerEnabled(user.locationId))) return json(res, { error: "Chưa bật ghi thật (thiếu GHL_PIT)" }, 400);
      try {
        const results = await generateSessions(user.locationId, { lop, dates });
        const createdCount = results.filter((r) => r.created).length;
        return json(res, { ok: true, total: results.length, created: createdCount, existing: results.length - createdCount, dates: results });
      } catch (e) {
        return json(res, { error: String(e.message) }, 400);
      }
    }
    // Danh sách Buổi học của 1 lớp.
    if (u.pathname === "/api/candy/buoi-hoc-list") {
      await sleep(DELAY);
      const lop = u.searchParams.get("lop");
      if (!t.allClasses().find((c) => c.lop === lop)) return json(res, { error: "Không tìm thấy lớp" }, 400);
      if (!(await writerEnabled(user.locationId))) return json(res, { lop, items: [], writerEnabled: false });
      try { return json(res, { lop, items: await listBuoiHoc(user.locationId, { lop }), writerEnabled: true }); }
      catch (e) { return json(res, { error: String(e.message) }, 400); }
    }
    // Cập nhật 1 Buổi học từ danh sách trên — trạng thái và/hoặc GV dạy thay.
    if (req.method === "POST" && u.pathname === "/api/candy/buoi-hoc-update") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      const { buoiHocId, lop, trangThai, giaoVienDay } = input || {};
      if (!t.allClasses().find((c) => c.lop === lop)) return json(res, { error: "Không tìm thấy lớp" }, 400);
      if (!(await writerEnabled(user.locationId))) return json(res, { error: "Chưa bật ghi thật (thiếu GHL_PIT)" }, 400);
      try { return json(res, { ok: true, ...(await updateBuoiHoc(user.locationId, { buoiHocId, trangThai, giaoVienDay })) }); }
      catch (e) { return json(res, { error: String(e.message) }, 400); }
    }
    // Giáo viên: danh sách + số lớp đang dạy (tính từ allClasses(), không lưu số này — luôn tính lại để
    // không bao giờ lệch với thực tế gán ở đâu đó khác).
    if (u.pathname === "/api/candy/giao-vien-list") {
      await sleep(DELAY);
      const classes = t.allClasses();
      return json(res, t.giaoVienList.map((gv) => ({ ...gv, soLopDangDay: classes.filter((c) => c.giao_vien_id === gv.id).length })));
    }
    if ((m = u.pathname.match(/^\/api\/candy\/giao-vien\/([^/]+)$/))) {
      await sleep(DELAY);
      const gv = t.giaoVienList.find((x) => x.id === m[1]);
      if (!gv) return json(res, { error: "Không tìm thấy giáo viên" }, 404);
      const lops = t.allClasses().filter((c) => c.giao_vien_id === gv.id).map((c) => ({ lop: c.lop, co_so: c.co_so, siso: c.students.length, cac_thu_hoc: c.cac_thu_hoc || "", gio_bat_dau: c.gio_bat_dau || "", gio_ket_thuc: c.gio_ket_thuc || "" }));
      return json(res, { ...gv, lops });
    }
    if (req.method === "POST" && u.pathname === "/api/candy/giao-vien") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      const { name, phone, email, ghiChu } = input || {};
      if (!name || !name.trim()) return json(res, { error: "Cần tên giáo viên" }, 400);
      if (!(await writerEnabled(user.locationId))) return json(res, { error: "Chưa bật ghi thật (thiếu GHL_PIT)" }, 400);
      try {
        const r = await createGiaoVien(user.locationId, { name, phone, email, ghiChu });
        const row = { id: r.id, name: name.trim(), phone: phone || "", email: email || "", trang_thai: "dang_day", ghi_chu: ghiChu || "" };
        t.giaoVienList.push(row);
        t.saveGiaoVien();
        return json(res, { ok: true, giaoVien: row });
      } catch (e) {
        return json(res, { error: String(e.message) }, 400);
      }
    }
    if (req.method === "POST" && u.pathname === "/api/candy/giao-vien-sua") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      const { giaoVienId, name, phone, email, trangThai, ghiChu } = input || {};
      const gv = t.giaoVienList.find((x) => x.id === giaoVienId);
      if (!gv) return json(res, { error: "Không tìm thấy giáo viên" }, 400);
      if (!(await writerEnabled(user.locationId))) return json(res, { error: "Chưa bật ghi thật (thiếu GHL_PIT)" }, 400);
      try {
        await updateGiaoVien(user.locationId, { giaoVienId, name, phone, email, trangThai, ghiChu });
        Object.assign(gv, { ...(name !== undefined && { name }), ...(phone !== undefined && { phone }), ...(email !== undefined && { email }), ...(trangThai !== undefined && { trang_thai: trangThai }), ...(ghiChu !== undefined && { ghi_chu: ghiChu }) });
        t.saveGiaoVien();
        // Đổi tên GV thì mọi lớp đang hiện tên cũ (đã denormalize vào lopOverrides.giao_vien) cần cập nhật theo.
        if (name !== undefined) { for (const lop in t.lopOverrides) if (t.lopOverrides[lop].giao_vien_id === giaoVienId) t.lopOverrides[lop].giao_vien = gv.name; t.saveLopOverrides(); }
        return json(res, { ok: true, giaoVien: gv });
      } catch (e) {
        return json(res, { error: String(e.message) }, 400);
      }
    }
    // Gán GV cho 1 lớp — xoá quan hệ cũ (nếu GHL hỗ trợ), tạo quan hệ mới, rồi ghi tên+id GV vào
    // lopOverrides để mọi nơi đọc c.giao_vien (bảng lớp, thời khoá biểu, chặn trùng lịch) thấy ngay.
    if (req.method === "POST" && u.pathname === "/api/candy/lop-giao-vien") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      const { lop, giaoVienId } = input || {};
      const cls = t.allClasses().find((c) => c.lop === lop);
      if (!cls) return json(res, { error: "Không tìm thấy lớp" }, 400);
      const gv = t.giaoVienList.find((x) => x.id === giaoVienId);
      if (!gv) return json(res, { error: "Không tìm thấy giáo viên" }, 400);
      {
        const conflict = findTeacherConflict(t.allClasses(), { lop, giaoVienTen: gv.name, cacThuHoc: cls.cac_thu_hoc, gioBatDau: cls.gio_bat_dau, gioKetThuc: cls.gio_ket_thuc });
        if (conflict) return json(res, { error: teacherConflictMsg(gv.name, cls.cac_thu_hoc, conflict) }, 400);
      }
      if (!(await writerEnabled(user.locationId))) return json(res, { error: "Chưa bật ghi thật (thiếu GHL_PIT)" }, 400);
      try {
        await ganGiaoVienChoLop(user.locationId, { giaoVienId, lop });
        t.lopOverrides[lop] = { ...(t.lopOverrides[lop] || {}), giao_vien: gv.name, giao_vien_id: giaoVienId };
        t.saveLopOverrides();
        return json(res, { ok: true, lop, giao_vien: gv.name });
      } catch (e) {
        return json(res, { error: String(e.message) }, 400);
      }
    }
    // Thời khoá biểu dạng lịch tuần — chỉ những lớp ĐÃ có lịch (cac_thu_hoc) mới lên lịch.
    if (u.pathname === "/api/candy/thoi-khoa-bieu") {
      await sleep(DELAY);
      const byThu = Object.fromEntries(THU_ORDER.map((t2) => [t2, []]));
      for (const c of t.allClasses()) {
        if (!c.cac_thu_hoc) continue;
        for (const th of c.cac_thu_hoc.split(",")) {
          if (!byThu[th]) continue;
          byThu[th].push({ lop: c.lop, co_so: c.co_so, cap_do: c.cap_do || "", giao_vien: c.giao_vien || "", gio_bat_dau: c.gio_bat_dau, gio_ket_thuc: c.gio_ket_thuc, siso: c.students.length });
        }
      }
      for (const th of THU_ORDER) byThu[th].sort((a, b) => (a.gio_bat_dau || "").localeCompare(b.gio_bat_dau || ""));
      return json(res, { thuOrder: THU_ORDER, thuLabel: THU_LABEL, byThu });
    }
    // Hồ sơ học viên xuyên suốt nhiều lớp.
    if ((m = u.pathname.match(/^\/api\/candy\/hoc-vien\/([^/]+)$/))) {
      await sleep(DELAY);
      const hocVienId = decodeURIComponent(m[1]);
      const rows = t.allStudents().filter((s) => s.hoc_vien_id === hocVienId);
      if (!rows.length) return json(res, { error: "not found" }, 404);
      const enrollments = rows.map((s) => {
        const attendance = [];
        for (const seed of t.candy.attendance_seed) if (seed.student_n === s.n) attendance.push({ date: seed.date, status: seed.status, real: true });
        for (const key in t.attOverlay) {
          const [lop] = key.split("|");
          if (lop !== s.lop) continue;
          const date = key.slice(lop.length + 1);
          const mark = t.attOverlay[key][s.n];
          if (mark) attendance.push({ date, status: mark.status, real: !!mark.real });
        }
        attendance.sort((a, b) => (a.date < b.date ? 1 : -1));
        return { ...s, attendance };
      });
      return json(res, { hoc_vien_id: hocVienId, name: rows[0].name, enrollments });
    }
    if (req.method === "GET" && u.pathname === "/api/candy/config") {
      await sleep(DELAY);
      return json(res, t.candyConfig);
    }
    if (req.method === "POST" && u.pathname === "/api/candy/config") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      const soBuoi = Number(input?.hoc_bu?.so_buoi_toi_da);
      if (!Number.isInteger(soBuoi) || soBuoi < 0 || soBuoi > 20) return json(res, { error: "Số buổi học bù phải là số nguyên 0-20" }, 400);
      const loai = Array.isArray(input?.hoc_bu?.loai_vang_duoc_bu) ? input.hoc_bu.loai_vang_duoc_bu.filter((x) => ["vang_co_phep", "vang_khong_phep"].includes(x)) : [];
      t.candyConfig = { hoc_bu: { ...t.candyConfig.hoc_bu, so_buoi_toi_da: soBuoi, loai_vang_duoc_bu: loai } };
      t.saveConfig();
      return json(res, t.candyConfig);
    }
    if (u.pathname === "/api/candy/dashboard") {
      await sleep(DELAY);
      const students = t.allStudents();
      const classes = t.allClasses();
      // Ghi danh đã đóng (chuyển lớp/hoàn thành/nghỉ hẳn) không còn "active" — loại khỏi số liệu tổng hợp.
      const TERMINAL = new Set(["da_chuyen_lop", "hoan_thanh", "da_nghi"]);
      const isActive = (s) => !TERMINAL.has(s.gd_trang_thai);
      const activeStudents = students.filter(isActive);
      const totalStudents = new Set(activeStudents.map((s) => s.hoc_vien_id)).size; // đếm NGƯỜI, không đếm dòng ghi danh
      const byCoSo = {};
      for (const s of activeStudents) byCoSo[s.co_so] = (byCoSo[s.co_so] || 0) + 1;
      let realAtt = 0, demoAtt = 0, absentCount = 0;
      const statusCount = {};
      for (const seed of t.candy.attendance_seed) { realAtt++; statusCount[seed.status] = (statusCount[seed.status] || 0) + 1; if (seed.status.startsWith("vang")) absentCount++; }
      for (const key in t.attOverlay) for (const n in t.attOverlay[key]) {
        const mark = t.attOverlay[key][n];
        if (mark.real) continue;
        demoAtt++; statusCount[mark.status] = (statusCount[mark.status] || 0) + 1;
        if (mark.status.startsWith("vang")) absentCount++;
      }
      const totalPhi = activeStudents.reduce((sum, s) => sum + (Number(s.fee) || 0), 0);

      const TODAY = new Date();
      const expiringSoon = activeStudents
        .map((s) => ({ name: s.name, lop: s.lop, hoc_vien_id: s.hoc_vien_id, ngay_het_han: s.ngay_het_han, daysLeft: s.ngay_het_han ? Math.floor((new Date(s.ngay_het_han) - TODAY) / 86400000) : null }))
        .filter((x) => x.daysLeft !== null && x.daysLeft <= 30)
        .sort((a, b) => a.daysLeft - b.daysLeft);

      const byStudent = {};
      for (const a of t.candy.attendance_seed) (byStudent[a.student_n] ||= []).push({ date: a.date, status: a.status });
      for (const key in t.attOverlay) {
        const date = key.split("|")[1];
        for (const n in t.attOverlay[key]) (byStudent[n] ||= []).push({ date, status: t.attOverlay[key][n].status });
      }
      const absentStreak = [];
      for (const [nStr, marks] of Object.entries(byStudent)) {
        const n = Number(nStr);
        const sorted = [...marks].sort((a, b) => (a.date < b.date ? 1 : -1)); // mới nhất trước
        let streak = 0;
        for (const mk of sorted) { if (mk.status.startsWith("vang")) streak++; else break; }
        if (streak >= 2) {
          const s = students.find((x) => x.n === n);
          absentStreak.push({ name: s.name, lop: s.lop, hoc_vien_id: s.hoc_vien_id, streak });
        }
      }
      absentStreak.sort((a, b) => b.streak - a.streak);

      const todayThu = JS_DAY_TO_THU[new Date().getDay()];
      const todaySessions = classes
        .filter((c) => c.cac_thu_hoc && c.cac_thu_hoc.split(",").includes(todayThu))
        .map((c) => ({ lop: c.lop, co_so: c.co_so, gio_bat_dau: c.gio_bat_dau, gio_ket_thuc: c.gio_ket_thuc, giao_vien: c.giao_vien || "", siso: c.students.length }))
        .sort((a, b) => (a.gio_bat_dau || "").localeCompare(b.gio_bat_dau || ""));

      const activeClasses = classes.filter((c) => c.students.length > 0);
      const lopChuaCoGV = activeClasses.filter((c) => !c.giao_vien).map((c) => c.lop);
      const lopChuaCoLich = activeClasses.filter((c) => !c.cac_thu_hoc).map((c) => c.lop);

      return json(res, {
        totalStudents, totalClasses: classes.length, classesWithStudents: classes.filter((c) => c.students.length).length, byCoSo,
        attendance: { real: realAtt, demo: demoAtt, statusCount, absentCount },
        totalPhi, expiringSoon, absentStreak, todaySessions, todayThu, thuLabel: THU_LABEL,
        lopChuaCoGV, lopChuaCoLich, tongHocBuDaDat: t.hocBuOverlay.length,
      });
    }
    // Tab "Kinh doanh" (xem ghl-write.mjs:getKinhDoanh) — phễu bán hàng + danh sách "học viên mới, chưa xếp
    // lớp". Đọc trực tiếp GHL mỗi lần gọi (Opportunity là dữ liệu CRM sống), không qua base_snapshot/overlay.
    if (u.pathname === "/api/candy/kinh-doanh") {
      if (!(await writerEnabled(user.locationId))) return json(res, { funnel: [], chuaXepLop: [], writerEnabled: false });
      try { return json(res, { ...(await getKinhDoanh(user.locationId)), writerEnabled: true }); }
      catch (e) { return json(res, { error: String(e.message) }, 400); }
    }
    if ((m = u.pathname.match(/^\/api\/candy\/phu-huynh\/([^/]+)$/))) {
      await sleep(DELAY);
      if (!(await writerEnabled(user.locationId))) return json(res, { phuHuynh: null, writerEnabled: false });
      try { return json(res, { phuHuynh: await getPhuHuynh(user.locationId, { hocVienId: decodeURIComponent(m[1]) }), writerEnabled: true }); }
      catch (e) { return json(res, { error: String(e.message) }, 400); }
    }
    if (req.method === "GET" && u.pathname === "/api/candy/buoi-hoc") {
      const lop = u.searchParams.get("lop"), date = u.searchParams.get("date");
      if (!(await writerEnabled(user.locationId))) return json(res, { buoiHoc: null, writerEnabled: false });
      try { return json(res, { buoiHoc: await getBuoiHoc(user.locationId, { lop, date }), writerEnabled: true }); }
      catch (e) { return json(res, { error: String(e.message) }, 400); }
    }
    if (req.method === "POST" && u.pathname === "/api/candy/buoi-hoc") {
      let body = ""; for await (const ch of req) body += ch;
      const { lop, date, trang_thai } = JSON.parse(body);
      try { return json(res, await setBuoiHocTrangThai(user.locationId, { lop, date, trangThai: trang_thai })); }
      catch (e) { return json(res, { error: String(e.message) }, 400); }
    }
    if (req.method === "POST" && u.pathname === "/api/candy/attendance") {
      let body = ""; for await (const ch of req) body += ch;
      const { lop, date, marks } = JSON.parse(body); // marks: {studentN: {status, note}}
      const key = `${lop}|${date}`;
      const results = [];
      const merged = { ...(t.attOverlay[key] || {}) };
      const writerOn = await writerEnabled(user.locationId);
      for (const [nStr, mark] of Object.entries(marks)) {
        const n = Number(nStr);
        const existing = merged[n];
        if (existing?.real) { results.push({ n, status: "skipped_already_real" }); continue; } // never re-write an already-confirmed real record
        const seeded = t.candy.attendance_seed.find((a) => a.student_n === n && a.date === date);
        if (seeded) { merged[n] = { ...mark, real: true }; results.push({ n, status: "already_real_seed" }); continue; }
        const student = t.allStudents().find((s) => s.n === n);
        if (writerOn) {
          try {
            const r = await writeAttendance(user.locationId, { studentName: student.name, ghiDanhId: student.ghi_danh_id, lop, date, status: mark.status, note: mark.note || "" });
            merged[n] = { status: mark.status, note: mark.note || "", real: true, diem_danh_id: r.diemDanhId, buoi_hoc_id: r.buoiHocId };
            // writeAttendance() vừa cộng dồn so_buoi_da_hoc thật trên GHL (nếu Có mặt/Muộn) — nhưng allStudents()
            // đọc field này từ snapshot tĩnh + ghOverrides, không đọc live từ GHL, nên phải ghi đè vào đây thì
            // "Đã học/Tổng buổi" trên UI mới khớp giá trị thật vừa cập nhật.
            if (r.soBuoiDaHoc !== undefined) { t.ghOverrides[student.ghi_danh_id] = { ...(t.ghOverrides[student.ghi_danh_id] || {}), so_buoi_da_hoc: r.soBuoiDaHoc }; t.saveGhOverrides(); }
            results.push({ n, status: "written", diem_danh_id: r.diemDanhId });
          } catch (e) {
            merged[n] = { ...mark, real: false, error: String(e.message) };
            results.push({ n, status: "error", error: String(e.message) });
          }
        } else {
          merged[n] = { ...mark, real: false };
          results.push({ n, status: "local_only_no_token" });
        }
      }
      t.attOverlay[key] = merged;
      t.saveAttOverlay();
      const written = results.filter((r) => r.status === "written").length;
      const errors = results.filter((r) => r.status === "error");
      return json(res, { ok: true, writerEnabled: writerOn, written, total: results.length, results, errors });
    }
    // Quota học bù của 1 Ghi danh: đã dùng bao nhiêu / tối đa bao nhiêu (theo Cấu hình), kèm danh sách các
    // lượt đã đặt.
    if (u.pathname === "/api/candy/hoc-bu") {
      await sleep(DELAY);
      const ghiDanhId = u.searchParams.get("ghiDanhId");
      const bookings = t.hocBuOverlay.filter((b) => b.ghiDanhId === ghiDanhId);
      return json(res, { used: bookings.length, max: t.candyConfig.hoc_bu.so_buoi_toi_da, loaiVangDuocBu: t.candyConfig.hoc_bu.loai_vang_duoc_bu, bookings });
    }
    // Lớp cùng cấp độ với 1 lớp gốc — để chọn lớp bù.
    if (u.pathname === "/api/candy/lop-cung-cap-do") {
      await sleep(DELAY);
      const lop = u.searchParams.get("lop");
      const clsGoc = t.allClasses().find((c) => c.lop === lop);
      if (!clsGoc) return json(res, { error: "Không tìm thấy lớp" }, 400);
      const list = t.allClasses().filter((c) => c.lop !== lop && c.cap_do && c.cap_do === clsGoc.cap_do && c.cac_thu_hoc);
      return json(res, { capDo: clsGoc.cap_do || "", list });
    }
    // Đặt lịch học bù thực tế.
    if (req.method === "POST" && u.pathname === "/api/candy/dat-hoc-bu") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      const { ghiDanhId, ngayVang, loaiVang, lopGoc, lopBu, ngayBu } = input || {};
      const student = t.allStudents().find((s) => s.ghi_danh_id === ghiDanhId);
      if (!student) return json(res, { error: "Không tìm thấy ghi danh" }, 400);
      if (t.candyConfig.hoc_bu.loai_vang_duoc_bu.length && !t.candyConfig.hoc_bu.loai_vang_duoc_bu.includes(loaiVang)) {
        return json(res, { error: `Loại vắng "${ATT_STATUS[loaiVang] || loaiVang}" không được phép học bù theo quy tắc hiện tại (xem tab Cấu hình)` }, 400);
      }
      if (t.hocBuOverlay.find((b) => b.ghiDanhId === ghiDanhId && b.ngayVang === ngayVang)) {
        return json(res, { error: "Buổi vắng này đã được đặt học bù rồi" }, 400);
      }
      if (student.ngay_het_han && ngayBu > student.ngay_het_han) {
        return json(res, { error: `Ngày bù phải trước ngày hết hạn gói học (${student.ngay_het_han})` }, 400);
      }
      const daDat = t.hocBuOverlay.filter((b) => b.ghiDanhId === ghiDanhId).length;
      if (daDat >= t.candyConfig.hoc_bu.so_buoi_toi_da) {
        return json(res, { error: `Đã dùng hết ${t.candyConfig.hoc_bu.so_buoi_toi_da} buổi học bù cho phép mỗi kỳ ghi danh (xem tab Cấu hình)` }, 400);
      }
      const clsGoc = t.allClasses().find((c) => c.lop === lopGoc);
      const clsBu = t.allClasses().find((c) => c.lop === lopBu);
      if (!clsBu) return json(res, { error: "Không tìm thấy lớp bù" }, 400);
      if (clsGoc?.cap_do && clsBu.cap_do !== clsGoc.cap_do) {
        return json(res, { error: `Lớp bù phải cùng cấp độ (${clsGoc.cap_do}) với lớp gốc — ${lopBu} là "${clsBu.cap_do || "chưa có cấp độ"}"` }, 400);
      }
      if (clsBu.cac_thu_hoc) {
        const thuBu = JS_DAY_TO_THU[new Date(ngayBu + "T00:00:00").getDay()];
        if (!clsBu.cac_thu_hoc.split(",").includes(thuBu)) {
          return json(res, { error: `Lớp ${lopBu} không học vào ${THU_LABEL[thuBu]} — chọn ngày khác đúng lịch của lớp (${clsBu.cac_thu_hoc.split(",").map((t2) => THU_LABEL[t2]).join(", ")})` }, 400);
        }
      }
      if (!(await writerEnabled(user.locationId))) return json(res, { error: "Chưa bật ghi thật (thiếu GHL_PIT)" }, 400);
      try {
        const r = await writeAttendance(user.locationId, { studentName: student.name, ghiDanhId, lop: lopBu, date: ngayBu, status: "co_mat", note: `Học bù cho buổi vắng ngày ${ngayVang} tại lớp ${lopGoc}` });
        if (r.soBuoiDaHoc !== undefined) { t.ghOverrides[ghiDanhId] = { ...(t.ghOverrides[ghiDanhId] || {}), so_buoi_da_hoc: r.soBuoiDaHoc }; t.saveGhOverrides(); }
        const row = { id: `hb_${Date.now()}`, ghiDanhId, hocVienId: student.hoc_vien_id, ten: student.name, lopGoc, ngayVang, lopBu, ngayBu, diemDanhBuId: r.diemDanhId, taoLuc: new Date().toISOString() };
        t.hocBuOverlay.push(row);
        t.saveHocBuOverlay();
        return json(res, { ok: true, booking: row });
      } catch (e) {
        return json(res, { error: String(e.message) }, 400);
      }
    }
    let f = path.join(dist, u.pathname === "/" ? "index.html" : u.pathname);
    if (!f.startsWith(dist) || !fs.existsSync(f)) f = path.join(dist, "index.html");
    res.writeHead(200, { "Content-Type": types[path.extname(f)] || "application/octet-stream" });
    // Khách đóng tab/mất mạng giữa chừng lúc đang tải file tĩnh là chuyện bình thường, không phải lỗi — nhưng
    // nếu không bắt sự kiện 'error' của stream thì Node coi là lỗi chưa xử lý và sập cả tiến trình.
    fs.createReadStream(f).on("error", (e) => console.error("[static] Lỗi đọc/gửi file tĩnh:", f, e.message)).pipe(res);
  } catch (e) { console.error("[server] Lỗi chưa bắt được khi xử lý request:", e); json(res, { error: String(e.message || e) }, 500); }
}
// Chỉ tự khởi động server khi file này được chạy trực tiếp (node server.mjs / npm start) — khi bị app khác
// import requestHandler để gắn vào tiến trình của họ, họ tự có listen() riêng, không cần (và không nên) mở
// thêm 1 cổng nữa ở đây.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  // Cục bộ: cố định 127.0.0.1:5178 (chỉ máy này truy cập, khớp preview server đang dùng lúc dev). Trên
  // Render (hay host thật khác): PHẢI nghe đúng cổng do host cấp qua biến PORT + mở cho kết nối từ ngoài
  // (0.0.0.0) — cố định 127.0.0.1 sẽ khiến Render không bao giờ kết nối được vào app, deploy coi như hỏng.
  http.createServer(requestHandler).listen(process.env.PORT ? Number(process.env.PORT) : 5178, process.env.PORT ? "0.0.0.0" : "127.0.0.1",
    () => console.log(`Demo: nghe cổng ${process.env.PORT || 5178}${process.env.PORT ? "" : " (chỉ máy này truy cập được)"}`));
}
