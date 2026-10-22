// Module "Zalo OA Connector" — app Marketplace riêng (khách cài độc lập, không kéo theo Center Management).
// Đường dẫn (đều dưới /apps/zalo):
//   /install, /go, /oauth/callback      cài app từ GHL (agency hỏi Location ID trước)
//   /                                   Custom Page (page.html) — đăng nhập bằng SSO của GHL mỗi lần mở
//   /api/*                              API cho Custom Page (token phiên riêng của module)
//   /zalo-callback                      Zalo chuyển người dùng về sau khi cấp quyền OA
//   /webhooks/zalo, /webhooks/ghl       webhook sự kiện Zalo / Delivery URL của Conversation Provider
import fs from "fs";
import CryptoJS from "crypto-js";
import { getApp, appConfigured } from "../../marketplace-apps.mjs";
import { buildAuthorizeUrl, handleInstall, isInstalled } from "../../ghl-apps.mjs";
import { createModuleSession, getModuleSession } from "../../module-sessions.mjs";
import { buildConnectUrl, handleConnectCallback, disconnect, handleZaloWebhook, handleGhlOutbound, validGhlSignature, getStats, getLogs, retryLog, handleZnsWebhook, znsKeyValid, znsWebhookUrl } from "../../zalo-oa.mjs";

const APP = "zalo";
const PAGE = new URL("./page.html", import.meta.url);
const readBody = async (req) => { let b = ""; for await (const ch of req) b += ch; return b; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const html = (res, code, body) => { res.writeHead(code, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); res.end(body); };
const shell = (title, inner) => `<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f5f9;font:15px/1.5 system-ui,-apple-system,sans-serif;color:#161b26"><div style="max-width:440px;width:100%;padding:32px;box-sizing:border-box">${inner}</div></body></html>`;

// Giải mã gói SSO GHL ký cho Custom Page — dùng Shared Secret của CHÍNH app này (mỗi app Marketplace có 1 khoá riêng).
function decryptSso(encryptedData) {
  const secret = getApp(APP).sharedSecret;
  if (!secret) throw new Error("Server thiếu ZALO_CONNECTOR_SHARED_SECRET");
  const t = CryptoJS.AES.decrypt(encryptedData, secret).toString(CryptoJS.enc.Utf8);
  if (!t) throw new Error("Giải mã thất bại — sai Shared Secret hoặc dữ liệu không hợp lệ");
  return JSON.parse(t);
}
const isAdminPayload = (p) => p.role === "admin" || p.type === "agency" || p.isAgencyOwner === true;

export default {
  async handle({ req, res, u, sub, json }) {
    // --- cài app ---
    if (req.method === "GET" && sub === "/install") {
      const err = u.searchParams.get("error");
      return html(res, 200, shell("Cài Zalo OA Connector", `<h2 style="margin:0 0 8px">Cài Zalo OA Connector</h2>
<p style="color:#667085;margin:0 0 20px">Dán Location ID của sub-account cần kết nối (GHL: sub-account &gt; Settings &gt; Business Profile).</p>
${err ? `<p style="background:#fde8e8;color:#c22;padding:10px 14px;border-radius:8px">${esc(err)}</p>` : ""}
<form method="GET" action="/apps/zalo/go"><input name="location_id" placeholder="Location ID" required style="width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #d0d5dd;border-radius:8px;font-size:15px;margin-bottom:12px">
<button style="width:100%;padding:12px;border:none;border-radius:8px;background:#3457e0;color:#fff;font-size:15px;font-weight:600;cursor:pointer">Tiếp tục tới GHL</button></form>`));
    }
    if (req.method === "GET" && sub === "/go") {
      const loc = String(u.searchParams.get("location_id") || "").trim();
      if (!appConfigured(APP)) return html(res, 500, shell("Chưa cấu hình", "Server thiếu ZALO_CONNECTOR_CLIENT_ID/SECRET."));
      res.writeHead(302, { Location: loc ? buildAuthorizeUrl(APP, loc) : "/apps/zalo/install?error=" + encodeURIComponent("Cần nhập Location ID") });
      return res.end();
    }
    if (req.method === "GET" && sub === "/oauth/callback") {
      if (u.searchParams.get("error") || !u.searchParams.get("code")) return html(res, 400, shell("Không thể cài", "GHL báo huỷ hoặc thiếu mã xác thực. Thử cài lại."));
      try {
        await handleInstall(APP, { code: u.searchParams.get("code"), state: u.searchParams.get("state") || null });
        return html(res, 200, shell("Đã cài Zalo OA Connector", "Vào sub-account trong GHL, mở menu Zalo OA Connector để kết nối Zalo OA."));
      } catch (e) { return html(res, 400, shell("Không thể cài", esc(e.message))); }
    }

    // --- Zalo chuyển về sau khi cấp quyền OA ---
    if (req.method === "GET" && sub === "/zalo-callback") {
      const page = (title, msg, ok) => shell(title, `<div style="text-align:center"><h2 style="margin:0 0 8px;color:${ok ? "#12805c" : "#c22"}">${esc(title)}</h2><p style="color:#667085">${esc(msg)}</p></div>
<script>try{window.opener&&window.opener.postMessage({zaloConnect:${ok}},"*")}catch(e){}${ok ? "setTimeout(function(){window.close()},1500)" : ""}</script>`);
      if (u.searchParams.get("error") || !u.searchParams.get("code")) return html(res, 400, page("Chưa kết nối được", "Zalo báo huỷ hoặc không cấp quyền. Đóng cửa sổ này và thử lại từ nút “Kết nối Zalo OA”.", false));
      try {
        const r = await handleConnectCallback({ code: u.searchParams.get("code"), state: u.searchParams.get("state"), oaIdFromQuery: u.searchParams.get("oa_id") });
        return html(res, 200, page("Đã kết nối Zalo OA", `Kết nối “${r.oaName || r.oaId}” thành công. Cửa sổ này tự đóng.`, true));
      } catch (e) { return html(res, 400, page("Chưa kết nối được", e.message, false)); }
    }

    // --- webhook (công khai, tự xác thực) ---
    if (req.method === "POST" && sub === "/webhooks/zalo") {
      const raw = await readBody(req);
      res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"success":true}'); // Zalo chỉ cần 200; chữ ký kiểm trong handler
      let payload; try { payload = JSON.parse(raw); } catch { return true; }
      console.log("[zalo-oa] event:", payload.event_name, "oa:", payload.oa_id || payload.recipient?.id || payload.sender?.id);
      handleZaloWebhook({ payload, rawBody: raw, headers: req.headers }).catch((e) => console.error("[zalo-oa] webhook lỗi:", e.message));
      return true;
    }
    if (req.method === "POST" && sub === "/webhooks/ghl") {
      const raw = await readBody(req);
      if (!validGhlSignature(raw, req.headers["x-ghl-signature"])) { console.log("[zalo-oa] webhooks/ghl: chữ ký không hợp lệ"); return json(res, { message: "invalid signature" }, 401), true; }
      json(res, { ok: true });
      let body; try { body = JSON.parse(raw); } catch { return true; }
      handleGhlOutbound(body).catch((e) => console.error("[zalo-oa] outbound lỗi:", e.message));
      return true;
    }

    // ZNS từ Webhook action của GHL Workflow: xác thực bằng khoá riêng của từng trung tâm trong URL; trả mã để GHL biết có thử lại không.
    if (req.method === "POST" && sub === "/webhooks/zns") {
      const loc = u.searchParams.get("loc");
      if (!loc || !znsKeyValid(loc, u.searchParams.get("k"))) return json(res, { error: "Sai khoá hoặc trung tâm" }, 401), true;
      let payload; try { payload = JSON.parse(await readBody(req)); } catch { return json(res, { ok: false, permanent: true, error: "invalid json" }, 200), true; }
      const r = await handleZnsWebhook(loc, payload);
      return json(res, r.body, r.http), true;
    }

    // --- Custom Page ---
    if (req.method === "GET" && (sub === "/" || sub === "/page")) {
      let page; try { page = fs.readFileSync(PAGE, "utf8"); } catch { return html(res, 500, shell("Lỗi", "Thiếu page.html")); }
      return html(res, 200, page), true;
    }
    // Đăng nhập: LUÔN dựa vào gói SSO mới của GHL — location lấy từ gói đó, không từ client. Trang không lưu
    // token lâu dài (bài học rò rỉ chéo trung tâm của app gốc: token còn hạn ≠ token thuộc đúng trung tâm).
    if (req.method === "POST" && sub === "/api/sso") {
      let input; try { input = JSON.parse(await readBody(req)); } catch { return json(res, { error: "invalid json" }, 400), true; }
      let p; try { p = decryptSso(input.encryptedData); } catch (e) { return json(res, { error: "Không xác thực được dữ liệu từ GHL: " + e.message }, 400), true; }
      if (!p.activeLocation) return json(res, { error: "Hãy mở Zalo OA Connector từ bên trong sub-account (không phải giao diện agency)." }, 400), true;
      if (!(await isInstalled(APP, p.activeLocation))) return json(res, { error: "Sub-account này chưa cài Zalo OA Connector." }, 403), true;
      const role = isAdminPayload(p) ? "admin" : "user";
      const token = await createModuleSession(APP, { locationId: p.activeLocation, email: p.email, name: p.userName || p.name, role });
      return json(res, { ok: true, token, role, name: p.userName || p.name || p.email }), true;
    }

    if (sub.startsWith("/api/")) {
      const auth = req.headers["authorization"] || "";
      const sess = await getModuleSession(APP, auth.startsWith("Bearer ") ? auth.slice(7) : null);
      if (!sess) return json(res, { error: "Chưa đăng nhập" }, 401), true;
      const adminOnly = ["/api/connect-url", "/api/disconnect", "/api/retry", "/api/zns-setup"].includes(sub);
      if (adminOnly && sess.role !== "admin") return json(res, { error: "Chỉ quản trị mới được thực hiện thao tác này" }, 403), true;
      try {
        if (sub === "/api/status") return json(res, await getStats(sess.locationId)), true;
        if (sub === "/api/zns-setup") return json(res, { url: znsWebhookUrl(sess.locationId) }), true;
        if (sub === "/api/logs") return json(res, await getLogs(sess.locationId, { status: u.searchParams.get("status") || undefined })), true;
        if (req.method === "POST" && sub === "/api/connect-url") return json(res, { url: await buildConnectUrl(sess.locationId) }), true;
        if (req.method === "POST" && sub === "/api/disconnect") { await disconnect(sess.locationId); return json(res, { ok: true }), true; }
        if (req.method === "POST" && sub === "/api/retry") {
          let input; try { input = JSON.parse(await readBody(req)); } catch { return json(res, { error: "invalid json" }, 400), true; }
          await retryLog(sess.locationId, Number(input.id)); return json(res, { ok: true }), true;
        }
      } catch (e) { return json(res, { error: String(e.message) }, 400), true; }
    }
    return false;
  },
};
