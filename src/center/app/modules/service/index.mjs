// Module "Project & Service Management" (khách đầu tiên: ELUX — thang máy). Là 1 app Marketplace riêng, chạy trong
// cùng service Render với các module khác. Đường dẫn (đều dưới /apps/service):
//   /install, /go, /oauth/callback   cài app từ GHL
//   /                                Custom Page (page.html) — đăng nhập bằng SSO của GHL mỗi lần mở
//   /api/*                           API cho Custom Page (token phiên riêng của module)
//   /q, /q/submit                    trang CÔNG KHAI quét QR trong cabin để báo sự cố (không cần đăng nhập, có chữ ký)
// Chạy thử cục bộ không cần Marketplace app: SERVICE_DEV_LOCATION + SERVICE_DEV_PIT (chỉ nhận từ 127.0.0.1) — xem README_SERVICE.md.
import fs from "fs";
import crypto from "crypto";
import CryptoJS from "crypto-js";
import { getApp, appConfigured } from "../../marketplace-apps.mjs";
import { OPTIONS, THRESHOLDS } from "./schema.mjs";
import { createGhl } from "./ghl.mjs";
import { todayVN, qrSign, qrVerify, makeLimiter, cleanText, flat } from "./logic.mjs";
import * as svc from "./service.mjs";
import * as notify from "./notify.mjs";
import * as ttpl from "./templates.mjs";
import * as rpt from "./reports.mjs";

// Chạy thử cục bộ (SERVICE_DEV_LOCATION) dùng kho trong bộ nhớ, không đụng database.
let notifyStore; const store = () => (notifyStore ||= (devLocation() ? notify.memoryStore() : notify.dbStore()));
let reportStore; const repStore = () => (reportStore ||= (devLocation() ? rpt.memoryReportStore() : rpt.dbReportStore()));
let taskTplStore; const tplStore = () => (taskTplStore ||= (devLocation() ? ttpl.memoryStore() : ttpl.dbStore()));

const APP = "service";
const PAGE = new URL("./page.html", import.meta.url);
const readBody = async (req, max = 200_000) => { let b = ""; for await (const ch of req) { b += ch; if (b.length > max) throw new svc.UserError("Dữ liệu gửi lên quá lớn", 413); } return b; };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const html = (res, code, body) => { res.writeHead(code, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); res.end(body); };
const shell = (title, inner) => `<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f5f9;font:16px/1.5 system-ui,-apple-system,sans-serif;color:#161b26"><div style="max-width:460px;width:100%;padding:24px;box-sizing:border-box">${inner}</div></body></html>`;

// --- cấu hình / chế độ chạy thử -----------------------------------------------------------------------------
const env = () => process.env;
const devLocation = () => env().SERVICE_DEV_LOCATION || null;
const isLoopback = (req) => !req.headers["x-forwarded-for"] && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket?.remoteAddress);
const qrSecret = () => {
  const s = env().SERVICE_QR_SECRET || (devLocation() ? "dev-only-qr-secret" : null);
  if (!s) throw new Error("Server thiếu SERVICE_QR_SECRET");
  return s;
};

// Phiên: production dùng bảng platform.module_sessions (nạp lười để chạy thử cục bộ không đụng database); chạy thử dùng bộ nhớ.
const devSessions = new Map();
async function newSession(info) {
  if (devLocation() && info.dev) { const t = "dev_" + crypto.randomBytes(18).toString("hex"); devSessions.set(t, info); return t; }
  const { createModuleSession } = await import("../../module-sessions.mjs");
  return createModuleSession(APP, info);
}
async function readSession(token) {
  if (!token) return null;
  if (token.startsWith("dev_")) return devSessions.get(token) || null;
  const { getModuleSession } = await import("../../module-sessions.mjs");
  return getModuleSession(APP, token);
}

// 1 client GHL / trung tâm (giữ cache giữa các request).
const ghlByLoc = new Map();
function ghlFor(locationId) {
  let g = ghlByLoc.get(locationId);
  if (!g) {
    const getToken = devLocation() === locationId && env().SERVICE_DEV_PIT
      ? async () => env().SERVICE_DEV_PIT
      : async () => (await import("../../ghl-apps.mjs")).getAppLocationToken(APP, locationId);
    g = createGhl({ locationId, getToken }); ghlByLoc.set(locationId, g);
  }
  return g;
}
async function installed(locationId) {
  if (devLocation() === locationId) return true;
  return (await import("../../ghl-apps.mjs")).isInstalled(APP, locationId);
}

function decryptSso(encryptedData) {
  const secret = getApp(APP).sharedSecret;
  if (!secret) throw new Error("Server thiếu SERVICE_SHARED_SECRET");
  const t = CryptoJS.AES.decrypt(encryptedData, secret).toString(CryptoJS.enc.Utf8);
  if (!t) throw new Error("Giải mã thất bại — sai Shared Secret hoặc dữ liệu không hợp lệ");
  return JSON.parse(t);
}
const isAdminPayload = (p) => p.role === "admin" || p.type === "agency" || p.isAgencyOwner === true;

// Ảnh lên Media Library nếu app đã có scope medias.write; gặp 401/403 thì tạm tắt 10 phút (ảnh tự về DB), tránh thử lại mỗi lần chụp.
const mediaOff = new Map();
const mediaFor = (ghl, loc) => (Date.now() < (mediaOff.get(loc) || 0) ? null : {
  upload: async (f) => { try { return await ghl.uploadMedia(f); } catch (e) { if (e.status === 401 || e.status === 403) mediaOff.set(loc, Date.now() + 600_000); throw e; } },
  remove: (id) => ghl.deleteMedia(id),
});
const pubLimit = makeLimiter(5, 3600_000), pubLimitUnit = makeLimiter(30, 3600_000);
// Tiền tố đường dẫn: khi app bị gắn dưới 1 tiền tố (vd Express app.use("/center", ...) ở host gộp uplifting-social-ai), Express
// cắt tiền tố khỏi req.url nhưng để lại ở req.baseUrl — mọi link/redirect tuyệt đối phải ghép lại, nếu không trỏ trật ra gốc domain.
const prefixOf = (req, u) => req.baseUrl || u.pathname.replace(/\/apps\/service(\/.*)?$/, "");
const baseOf = (u, req) => prefixOf(req, u) + "/apps/service";
// Địa chỉ công khai đầy đủ của module (dùng cho link QR in dán cabin). PUBLIC_BASE_URL (nếu đặt) đã gồm tiền tố của host.
const publicModuleUrl = (req, u) => {
  const pre = req.baseUrl || "", pb = String(env().PUBLIC_BASE_URL || "").replace(/\/$/, "");
  // PUBLIC_BASE_URL của host dùng chung có thể chỉ là tên miền trần → tự ghép tiền tố mount (/center) nếu thiếu.
  const root = pb ? (pre && !pb.endsWith(pre) ? pb + pre : pb) : `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host}${baseOf(u, req).replace(/\/apps\/service$/, "")}`;
  return root + "/apps/service";
};

export default {
  async handle({ req, res, u, sub, json }) {
    const j = (data, code = 200) => (json(res, data, code), true);
    try {
      // --- cài app -------------------------------------------------------------------------------------------
      if (req.method === "GET" && sub === "/install") {
        const err = u.searchParams.get("error");
        return html(res, 200, shell("Cài Service Management", `<h2 style="margin:0 0 8px">Cài Project &amp; Service Management</h2>
<p style="color:#667085;margin:0 0 20px">Dán Location ID của sub-account cần cài (GHL: sub-account &gt; Settings &gt; Business Profile).</p>
${err ? `<p style="background:#fde8e8;color:#c22;padding:10px 14px;border-radius:8px">${esc(err)}</p>` : ""}
<form method="GET" action="${esc(baseOf(u, req))}/go"><input name="location_id" placeholder="Location ID" required style="width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #d0d5dd;border-radius:8px;font-size:15px;margin-bottom:12px">
<button style="width:100%;padding:12px;border:none;border-radius:8px;background:#3457e0;color:#fff;font-size:15px;font-weight:600;cursor:pointer">Tiếp tục tới GHL</button></form>`)), true;
      }
      if (req.method === "GET" && sub === "/go") {
        const loc = String(u.searchParams.get("location_id") || "").trim();
        if (!appConfigured(APP)) return html(res, 500, shell("Chưa cấu hình", "Server thiếu SERVICE_CLIENT_ID/SECRET.")), true;
        const { buildAuthorizeUrl } = await import("../../ghl-apps.mjs");
        res.writeHead(302, { Location: loc ? buildAuthorizeUrl(APP, loc) : `${baseOf(u, req)}/install?error=${encodeURIComponent("Cần nhập Location ID")}` }); res.end(); return true;
      }
      if (req.method === "GET" && sub === "/oauth/callback") {
        if (u.searchParams.get("error") || !u.searchParams.get("code")) return html(res, 400, shell("Không thể cài", "GHL báo huỷ hoặc thiếu mã xác thực. Thử cài lại.")), true;
        try { const { handleInstall } = await import("../../ghl-apps.mjs"); await handleInstall(APP, { code: u.searchParams.get("code"), state: u.searchParams.get("state") || null }); return html(res, 200, shell("Đã cài", "Vào sub-account trong GHL, mở menu của app để bắt đầu.")), true; }
        catch (e) { return html(res, 400, shell("Không thể cài", esc(e.message))), true; }
      }

      // --- trang QR công khai ----------------------------------------------------------------------------------
      if (sub === "/q" || sub === "/q/submit") {
        const loc = cleanText(u.searchParams.get("l") ?? "", 40), unitId = cleanText(u.searchParams.get("u") ?? "", 40), sig = u.searchParams.get("s") || "";
        let body = null;
        if (req.method === "POST") { try { body = JSON.parse(await readBody(req)); } catch { return j({ error: "Dữ liệu không hợp lệ" }, 400); } }
        const L = body ? cleanText(body.l, 40) : loc, U = body ? cleanText(body.u, 40) : unitId, S = body ? String(body.s || "") : sig;
        if (!L || !U || !qrVerify(qrSecret(), L, U, S)) return req.method === "GET" ? (html(res, 403, shell("Mã QR không hợp lệ", "<p>Mã QR này không hợp lệ hoặc đã bị chỉnh sửa. Vui lòng gọi trực tiếp số hotline.</p>")), true) : j({ error: "Mã QR không hợp lệ" }, 403);
        if (!(await installed(L))) return j({ error: "Dịch vụ chưa được kích hoạt" }, 403);
        const ghl = ghlFor(L);
        const unit = (await ghl.listAll("custom_objects.thang_may")).map(flat).find((x) => x.id === U);
        if (!unit) return req.method === "GET" ? (html(res, 404, shell("Không tìm thấy thang", "<p>Không tìm thấy thang máy này.</p>")), true) : j({ error: "Không tìm thấy thang" }, 404);
        if (req.method === "GET") {
          return html(res, 200, shell(`Báo sự cố thang ${unit.name}`, `<h2 style="margin:0 0 4px">Báo sự cố thang máy</h2><p style="margin:0 0 16px;color:#667085">Thang <b>${esc(unit.name)}</b>${unit.vi_tri ? ` — ${esc(unit.vi_tri)}` : ""}</p>
<form id="f"><label style="display:block;margin-bottom:12px">Mô tả sự cố<textarea name="mo_ta" required rows="3" maxlength="1000" style="width:100%;box-sizing:border-box;padding:12px;border:1px solid #d0d5dd;border-radius:8px;font:inherit"></textarea></label>
<label style="display:flex;gap:10px;align-items:center;margin-bottom:12px;background:#fef3f2;padding:10px 12px;border-radius:8px"><input type="checkbox" name="ket" style="width:20px;height:20px"> <span><b>Có người bị kẹt trong thang</b></span></label>
<label style="display:block;margin-bottom:12px">Tên của bạn<input name="nguoi_bao" maxlength="100" style="width:100%;box-sizing:border-box;padding:12px;border:1px solid #d0d5dd;border-radius:8px;font:inherit"></label>
<label style="display:block;margin-bottom:16px">Số điện thoại<input name="sdt" type="tel" maxlength="30" style="width:100%;box-sizing:border-box;padding:12px;border:1px solid #d0d5dd;border-radius:8px;font:inherit"></label>
<button style="width:100%;padding:14px;border:none;border-radius:8px;background:#c22;color:#fff;font-size:16px;font-weight:700">Gửi báo cáo</button><p id="m" style="margin-top:12px"></p></form>
<script>document.getElementById("f").addEventListener("submit",function(e){e.preventDefault();var d=new FormData(e.target),m=document.getElementById("m"),b=e.target.querySelector("button");b.disabled=true;m.textContent="Đang gửi…";
fetch(location.pathname.replace(/\\/q$/,"")+"/q/submit",{method:"POST",body:JSON.stringify({l:${JSON.stringify(L)},u:${JSON.stringify(U)},s:${JSON.stringify(S)},mo_ta:d.get("mo_ta"),ket:!!d.get("ket"),nguoi_bao:d.get("nguoi_bao"),sdt:d.get("sdt")})}).then(function(r){return r.json()}).then(function(j){if(j.error)throw new Error(j.error);e.target.style.display="none";document.body.firstChild.insertAdjacentHTML("beforeend","<div style='text-align:center'><h2 style='color:#067647'>Đã gửi báo cáo</h2><p>Mã phiếu: <b>"+j.name+"</b></p><p>Nhân viên sẽ liên hệ sớm nhất. Nếu có người bị kẹt, vui lòng giữ bình tĩnh và gọi hotline.</p></div>")}).catch(function(x){b.disabled=false;m.style.color="#c22";m.textContent=x.message})});</script>`)), true;
        }
        // POST /q/submit
        const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "?").split(",")[0].trim();
        if (!pubLimit(`${ip}|${U}`) || !pubLimitUnit(U)) return j({ error: "Gửi quá nhiều lần. Vui lòng gọi hotline." }, 429);
        const moTa = cleanText(body.mo_ta, 1000); if (!moTa) return j({ error: "Cần mô tả sự cố" }, 400);
        const r = await svc.createOrder(ghl, { thang_may_id: U, loai: "su_co", uu_tien: body.ket ? "khan_cap" : "binh_thuong", mo_ta: (body.ket ? "[CÓ NGƯỜI KẸT] " : "") + moTa, nguoi_bao: cleanText(body.nguoi_bao, 100), sdt_nguoi_bao: cleanText(body.sdt, 30) }, { today: todayVN(), source: "qr", actor: "Khách quét QR" });
        return j({ ok: true, name: r.name });
      }

      // --- Webhook thông báo: workflow contact của GHL gọi vào (khoá riêng từng sub-account trong URL) ---------------------
      if (req.method === "POST" && sub === "/webhooks/notify") {
        const loc = u.searchParams.get("loc");
        if (!loc || !notify.notifyKeyValid(loc, u.searchParams.get("k"))) return j({ error: "Sai khoá hoặc trung tâm" }, 401);
        if (!(await installed(loc))) return j({ ok: false, permanent: true, error: "Sub-account chưa cài app" });
        let payload; try { payload = JSON.parse(await readBody(req)); } catch { return j({ ok: false, permanent: true, error: "invalid json" }); }
        const r = await notify.handleNotify({ loc, payload, ghl: ghlFor(loc), store: store(), sendZns: notify.defaultSendZns });
        return j(r.body, r.http);
      }

      // --- Custom Page -----------------------------------------------------------------------------------------
      if (req.method === "GET" && (sub === "/" || sub === "/page")) {
        let page; try { page = fs.readFileSync(PAGE, "utf8"); } catch { return html(res, 500, shell("Lỗi", "Thiếu page.html")), true; }
        return html(res, 200, page), true;
      }
      if (req.method === "POST" && sub === "/api/sso") {
        let input; try { input = JSON.parse(await readBody(req)); } catch { return j({ error: "invalid json" }, 400); }
        let p; try { p = decryptSso(input.encryptedData); } catch (e) { return j({ error: "Không xác thực được dữ liệu từ GHL: " + e.message }, 400); }
        if (!p.activeLocation) return j({ error: "Hãy mở app từ bên trong sub-account (không phải giao diện agency)." }, 400);
        if (!(await installed(p.activeLocation))) return j({ error: "Sub-account này chưa cài app." }, 403);
        const role = isAdminPayload(p) ? "admin" : "user";
        const name = p.userName || p.name || p.email;
        const token = await newSession({ locationId: p.activeLocation, email: p.email, name, role });
        return j({ ok: true, token, role, name });
      }
      // Chạy thử cục bộ: chỉ khi đặt SERVICE_DEV_LOCATION, chỉ nhận từ máy này, không qua proxy.
      if (req.method === "POST" && sub === "/api/dev-login") {
        if (!devLocation() || !isLoopback(req)) return j({ error: "Không có đường dẫn này" }, 404);
        let input = {}; try { input = JSON.parse((await readBody(req)) || "{}"); } catch {}
        const role = input.role === "user" ? "user" : "admin";
        const token = await newSession({ dev: true, locationId: devLocation(), email: cleanText(input.email, 80) || "dev@local", name: cleanText(input.name, 60) || "Dev", role });
        return j({ ok: true, token, role, name: cleanText(input.name, 60) || "Dev", dev: true });
      }

      // --- API (cần phiên) -------------------------------------------------------------------------------------
      if (sub.startsWith("/api/")) {
        const auth = req.headers["authorization"] || "";
        const sess = await readSession(auth.startsWith("Bearer ") ? auth.slice(7) : null);
        if (!sess) return j({ error: "Chưa đăng nhập" }, 401);
        const ghl = ghlFor(sess.locationId), today = todayVN(), isAdmin = sess.role === "admin", me = { email: sess.email || "", name: sess.name || "" };
        const adminOnly = (m = "Chỉ quản trị mới được thực hiện thao tác này") => { if (!isAdmin) throw new svc.UserError(m, 403); };
        const body = async (max) => { try { return JSON.parse((await readBody(req, max)) || "{}"); } catch (e) { if (e instanceof svc.UserError) throw e; throw new svc.UserError("Dữ liệu không hợp lệ"); } };

        if (req.method === "GET") {
          if (sub === "/api/meta") return j({ options: OPTIONS, thresholds: THRESHOLDS, role: sess.role, me, today, users: await ghl.users(), dev: !!devLocation() });
          if (sub === "/api/dashboard") return j(await svc.getDashboard(ghl, today));
          if (sub === "/api/sales") return j(await svc.getSales(ghl, today));
          if (sub === "/api/list") return j({ rows: await svc.list(ghl, u.searchParams.get("type")) });
          if (sub === "/api/detail") return j(await svc.detail(ghl, u.searchParams.get("type"), u.searchParams.get("id")));
          if (sub === "/api/my-orders") {
            const rows = await svc.list(ghl, "phieu"); const e = me.email.toLowerCase(), n = me.name.toLowerCase();
            const mine = (o) => { const p = String(o.nguoi_phu_trach || "").toLowerCase(); return p && ((e && p.includes(e)) || (n && p.includes(n))); };
            return j({ mine: rows.filter((o) => mine(o) && !["hoan_thanh", "huy"].includes(o.trang_thai)), unassigned: rows.filter((o) => !o.nguoi_phu_trach && !["hoan_thanh", "huy"].includes(o.trang_thai)), doneToday: rows.filter((o) => mine(o) && o.ngay_hoan_thanh === today).length });
          }
          if (sub === "/api/qr") {
            adminOnly(); const id = cleanText(u.searchParams.get("unitId"), 40); if (!id) return j({ error: "Thiếu unitId" }, 400);
            const sig = qrSign(qrSecret(), sess.locationId, id);
            return j({ url: `${publicModuleUrl(req, u)}/q?l=${encodeURIComponent(sess.locationId)}&u=${encodeURIComponent(id)}&s=${sig}` });
          }
          if (sub === "/api/tasks") return j(await svc.listTasks(ghl, cleanText(u.searchParams.get("projectId") ?? "", 40)));
          if (sub === "/api/task-templates") {
            const list = await ttpl.effectiveTaskTemplates(tplStore(), sess.locationId);
            return j({ templates: list.map((t) => ({ key: t.key, label: t.label, text: ttpl.itemsToText(t.items), count: t.items.length })) });
          }
          if (sub === "/api/notify/templates") {
            adminOnly();
            return j({ templates: await notify.effectiveTemplates(store(), sess.locationId), subjects: notify.SUBJECTS, statuses: OPTIONS.orderStatus, webhookUrl: `${publicModuleUrl(req, u)}/webhooks/notify?loc=${encodeURIComponent(sess.locationId)}&k=${notify.notifyKey(sess.locationId)}` });
          }
          if (sub === "/api/checklists") {
            adminOnly(); const list = await rpt.effectiveChecklists(repStore(), sess.locationId);
            return j({ templates: list.map((t) => ({ key: t.key, label: t.label, types: t.types, min_photos: t.min_photos, need_signature: t.need_signature, text: rpt.itemsToText(t.items), count: t.items.length })) });
          }
          if (sub === "/api/report") {
            const order = await svc.getOrder(ghl, cleanText(u.searchParams.get("phieuId") ?? "", 40));
            const v = await rpt.view({ store: repStore(), loc: sess.locationId, order, templates: await rpt.effectiveChecklists(repStore(), sess.locationId) });
            return j({ ...v, canEdit: !["hoan_thanh", "huy"].includes(order.trang_thai) && svc.canWorkOn(order, { isAdmin, me }) });
          }
          if (sub === "/api/file") {
            const f = await repStore().getFile(sess.locationId, cleanText(u.searchParams.get("id") ?? "", 60)); if (!f) return j({ error: "Không tìm thấy tệp" }, 404);
            res.writeHead(200, { "Content-Type": f.mime, "Cache-Control": "private, max-age=86400", "Content-Length": f.bytes.length }); res.end(f.bytes); return true;
          }
          if (sub === "/api/maintenance/due") { adminOnly(); return j(await svc.maintenanceDue(ghl, today)); }
          if (sub === "/api/health") return j({ ok: true, pendingRelations: svc.pendingRelations() });
        }
        if (req.method === "POST") {
          const b = await body(sub === "/api/report/photo" || sub === "/api/report/signature" ? 300_000 : undefined);
          if (sub.startsWith("/api/report/")) {
            // Biên bản của phiếu: người làm được phiếu (hoặc quản trị) mới sửa; đã đóng phiếu thì khoá.
            const order = await svc.getOrder(ghl, cleanText(b.phieuId, 40)); if (!svc.canWorkOn(order, { isAdmin, me })) throw new svc.UserError("Phiếu này đã giao cho người khác", 403);
            const ctx = { store: repStore(), loc: sess.locationId, order, templates: await rpt.effectiveChecklists(repStore(), sess.locationId) };
            if (sub === "/api/report/save") return j(await rpt.saveAnswers({ ...ctx, answers: b.answers }));
            if (sub === "/api/report/photo") return j(await rpt.addPhoto({ ...ctx, dataUrl: b.data, media: mediaFor(ghl, sess.locationId) }));
            if (sub === "/api/report/photo/delete") return j(await rpt.removePhoto({ ...ctx, id: cleanText(b.id, 60), media: mediaFor(ghl, sess.locationId) }));
            if (sub === "/api/report/signature") return j(await rpt.setSignature({ ...ctx, dataUrl: b.data, signer: b.signer }));
            if (sub === "/api/report/nosign") return j(await rpt.setNoSign({ ...ctx, reason: b.reason === null ? null : String(b.reason ?? "") }));
          }
          if (sub === "/api/site") { adminOnly(); return j(await svc.createSite(ghl, b)); }
          if (sub === "/api/unit") { adminOnly(); return j(await svc.createUnit(ghl, b)); }
          if (sub === "/api/contract") { adminOnly(); return j(await svc.createContract(ghl, b, today)); }
          if (sub === "/api/order") return j(await svc.createOrder(ghl, b, { today, source: "ung_dung", actor: me.name }));
          if (sub === "/api/order/update") {
            const id = cleanText(b.id, 40), patch = b.patch || {};
            const needsGuard = patch.trang_thai === "hoan_thanh", starts = patch.trang_thai === "dang_xu_ly";
            const order = needsGuard || starts ? await svc.getOrder(ghl, id) : null;
            const templates = order ? await rpt.effectiveChecklists(repStore(), sess.locationId) : null;
            if (needsGuard && svc.canWorkOn(order, { isAdmin, me })) await rpt.guardComplete({ store: repStore(), loc: sess.locationId, order, templates, patch, skip: isAdmin && b.skipChecklist === true });
            const r = await svc.updateOrder(ghl, id, patch, { today, isAdmin, me });
            if (starts && order.trang_thai !== "dang_xu_ly") await rpt.markStarted({ store: repStore(), loc: sess.locationId, order, templates }).catch((e) => console.error("[service] ghi giờ bắt đầu lỗi:", e.message));
            return j(r);
          }
          if (sub === "/api/checklist") {
            adminOnly(); let t; try { t = rpt.validateChecklist(b); } catch (e) { throw new svc.UserError(e.message, e.status || 400); }
            await repStore().save(sess.locationId, t); return j({ ok: true });
          }
          if (sub === "/api/maintenance/generate-all") { adminOnly(); return j(await svc.generateAllDue(ghl, today)); }
          if (sub === "/api/project/stage") { adminOnly(); return j(await svc.setProjectStage(ghl, cleanText(b.id, 40), b.stage)); }
          if (sub === "/api/project/handover") { adminOnly(); return j(await svc.handoverProject(ghl, cleanText(b.id, 40), b, today)); }
          if (sub === "/api/contract/generate") { adminOnly(); return j(await svc.generateMaintenance(ghl, cleanText(b.id, 40), b, today)); }
          if (sub === "/api/inspection/schedule") { adminOnly(); return j(await svc.scheduleInspection(ghl, cleanText(b.unitId, 40), b)); }
          if (sub === "/api/inspection/record") { adminOnly(); return j(await svc.recordInspection(ghl, cleanText(b.id, 40), b)); }
          if (sub === "/api/task") { adminOnly(); return j(await svc.createTask(ghl, b, { today })); }
          if (sub === "/api/task/update") return j(await svc.updateTask(ghl, cleanText(b.id, 40), b.patch || {}, { today, isAdmin, me }));
          if (sub === "/api/tasks/generate") { adminOnly(); return j(await svc.generateTasks(ghl, cleanText(b.projectId, 40), b, today, await ttpl.effectiveTaskTemplates(tplStore(), sess.locationId))); }
          if (sub === "/api/task-template") {
            adminOnly(); let t; try { t = ttpl.validateTaskTemplate(b); } catch (e) { throw new svc.UserError(e.message, e.status || 400); }
            await tplStore().save(sess.locationId, t); return j({ ok: true });
          }
          if (sub === "/api/notify/template") {
            adminOnly(); let t; try { t = notify.validateTemplate(b); } catch (e) { throw new svc.UserError(e.message, e.status || 400); }
            await store().save(sess.locationId, t); return j({ ok: true, template: t });
          }
          if (sub === "/api/refresh") { ghl.invalidate(); return j({ ok: true }); }
        }
      }
    } catch (e) {
      if (e instanceof svc.UserError) return j({ error: e.message }, e.status);
      console.error("[service] lỗi:", e);
      return j({ error: "Lỗi hệ thống: " + String(e.message).slice(0, 200) }, e.status && e.status >= 400 && e.status < 600 ? 502 : 500);
    }
    return false;
  },
};
