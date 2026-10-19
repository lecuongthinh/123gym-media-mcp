import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import express from "express";
import { createAccessCode, reportBase, reportOAuthEnabled } from "./oauth.js";
import { allRequestedScopes, PACK_IDS, PACKS, PRESETS, ROLES, roleAllows } from "./packs.js";
import { provisionCustomer, provisionWebhookEnabled, resolvePacks, validLocationId } from "./provision.js";

// Permission dashboard for Uplifting admins: approve new customers, switch
// packs per customer and per role, manage people, read the audit trail.
// Sign-in is a one-time emailed link for an allow-listed address; the session
// is a signed, HttpOnly, SameSite=Lax cookie (Strict would drop it when the emailed
// link, a cross-site navigation, redirects into the dashboard), and every change is
// CSRF-protected and audited with the admin's email.

const SESSION_TTL_MS = 8 * 3600_000;
const LOGIN_LINK_TTL_MS = 15 * 60_000;
const COOKIE = "report_admin";
const INVITE_ROLES = ["admin", "manager", "staff", "viewer"];
const STATUS_LABELS = { pending: "Chờ duyệt", active: "Đang hoạt động", suspended: "Tạm khóa" };
const ROLE_LABELS = { owner: "Chủ sở hữu", admin: "Quản trị", manager: "Quản lý", staff: "Nhân viên", viewer: "Chỉ xem" };

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

export function adminEnabled(env = process.env) {
  return reportOAuthEnabled(env) && Boolean(env.REPORT_ADMIN_EMAILS) && String(env.REPORT_SESSION_SECRET || "").length >= 32;
}

function allowedEmails(env) {
  return String(env.REPORT_ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
}

function signSession(env, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", env.REPORT_SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function readSession(env, req) {
  const raw = /(?:^|;\s*)report_admin=([^;]+)/.exec(req.headers.cookie || "")?.[1];
  if (!raw) return null;
  const [body, mac] = raw.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", env.REPORT_SESSION_SECRET).update(body).digest("base64url");
  if (!safeEqual(mac, expected)) return null;
  try {
    const session = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!session.e || !session.c || session.x <= Date.now()) return null;
    if (!allowedEmails(env).includes(session.e)) return null;
    return { email: session.e, csrf: session.c };
  } catch { return null; }
}

function layout(title, body, { email } = {}) {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--text:#1a1a1a;--muted:#666;--line:#e2e2de;--accent:#111;--ok:#1b7f3b;--warn:#a15c00;--bad:#b00020}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--card:#202020;--text:#eee;--muted:#a0a0a0;--line:#343434;--accent:#eee;--ok:#5ad17c;--warn:#f0b050;--bad:#ff7a8a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,sans-serif}
header{display:flex;justify-content:space-between;align-items:center;padding:.75rem 1rem;border-bottom:1px solid var(--line);background:var(--card)}
main{max-width:64rem;margin:0 auto;padding:1rem}a{color:inherit}h1{font-size:1.3rem;margin:.5rem 0 1rem}h2{font-size:1.05rem;margin:0 0 .6rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:.6rem;padding:1rem;margin-bottom:1rem;overflow-x:auto}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.4rem .5rem;border-bottom:1px solid var(--line);vertical-align:middle}th{font-weight:600;color:var(--muted);font-size:.85rem}
.badge{display:inline-block;padding:.1rem .5rem;border-radius:1rem;font-size:.8rem;border:1px solid var(--line)}.pending{color:var(--warn)}.active{color:var(--ok)}.suspended{color:var(--bad)}
button,select,input[type=text],input[type=email]{font:inherit;padding:.4rem .7rem;border:1px solid var(--line);border-radius:.4rem;background:var(--card);color:var(--text)}
button{cursor:pointer}button.primary{background:var(--accent);color:var(--card);border-color:var(--accent)}button.danger{color:var(--bad);border-color:var(--bad)}
.row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}.muted{color:var(--muted)}.code{font-family:ui-monospace,monospace;background:var(--bg);padding:.5rem;border-radius:.4rem;word-break:break-all}
.center{text-align:center}code{font-family:ui-monospace,monospace}
</style></head><body>
<header><strong><a href="/report-admin" style="text-decoration:none">Quản lý quyền CRM</a></strong><span class="muted">${email ? `${escapeHtml(email)} · <a href="/report-admin/setup">Cài đặt</a> · <a href="/report-admin/logout">Đăng xuất</a>` : ""}</span></header>
<main>${body}</main></body></html>`;
}

async function sendLoginEmail(env, { email, link, fetchImpl }) {
  const url = env.REPORT_ADMIN_WEBHOOK_URL || env.HIGHLEVEL_INVITE_WEBHOOK_URL;
  if (!url) return false;
  try {
    const response = await fetchImpl(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, inviteLink: link, tenantName: "Quản lý quyền CRM", inviterName: "Uplifting" })
    });
    return response.ok;
  } catch { return false; }
}

export function createReportAdminRouter({ env = process.env, getStore, fetchImpl = globalThis.fetch } = {}) {
  const router = express.Router();
  const form = express.urlencoded({ extended: false, limit: "20kb" });
  const loginAttempts = new Map();

  router.use("/report-admin", (req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" });
    return adminEnabled(env) ? next() : res.status(404).end();
  });

  const secureCookie = () => (env.NODE_ENV === "production" || String(env.MCP_RESOURCE_URL || "").startsWith("https://") ? "; Secure" : "");

  function requireSession(req, res, next) {
    const session = readSession(env, req);
    if (!session) return res.redirect(302, "/report-admin/login");
    req.admin = session;
    return next();
  }

  function requireCsrf(req, res, next) {
    if (!safeEqual(req.body?.csrf || "", req.admin.csrf)) return res.status(403).type("html").send(layout("Từ chối", "<p>Phiên làm việc không hợp lệ. Tải lại trang và thử lại.</p>", req.admin));
    return next();
  }

  const csrfField = (req) => `<input type="hidden" name="csrf" value="${escapeHtml(req.admin.csrf)}">`;
  const audit = (store, req, tenantId, action, metadata = {}) =>
    store.recordAudit({ tenantId, actorType: "admin", actor: req.admin.email, action, result: "success", metadata }).catch(() => {});

  // ---- sign-in -----------------------------------------------------------
  router.get("/report-admin/login", (req, res) => {
    res.type("html").send(layout("Đăng nhập", `<div class="card"><h2>Đăng nhập</h2><form method="post" action="/report-admin/login" class="row">
      <input type="email" name="email" required placeholder="email quản trị" style="min-width:16rem"><button class="primary">Gửi liên kết đăng nhập</button></form>
      <p class="muted">Chỉ các email được cấp quyền mới nhận được liên kết.</p></div>`));
  });

  router.post("/report-admin/login", form, async (req, res) => {
    const ip = req.ip || "unknown";
    const windowStart = Date.now() - 10 * 60_000;
    const attempts = (loginAttempts.get(ip) || []).filter((t) => t > windowStart);
    attempts.push(Date.now());
    loginAttempts.set(ip, attempts);
    const email = String(req.body?.email || "").trim().toLowerCase();
    let devLink = "";
    if (attempts.length <= 5 && allowedEmails(env).includes(email)) {
      const token = randomBytes(32).toString("base64url");
      await getStore(req).createAdminLoginToken({ tokenHash: sha256(token), email, expiresAt: new Date(Date.now() + LOGIN_LINK_TTL_MS) });
      const link = `${reportBase(env)}-admin/verify?token=${token}`;
      const sent = await sendLoginEmail(env, { email, link, fetchImpl });
      if (!sent && env.NODE_ENV !== "production" && env.REPORT_DEV_LOGIN === "true") devLink = link;
      if (!sent && !devLink) console.error("[report-admin] login email not sent: no webhook configured or it failed");
    }
    // Same response whether or not the email is allowed, to avoid enumeration.
    res.type("html").send(layout("Kiểm tra email", `<div class="card"><h2>Kiểm tra email</h2><p>Nếu email này được cấp quyền, một liên kết đăng nhập (hiệu lực 15 phút) đang được gửi.</p>${devLink ? `<p class="code"><a href="${escapeHtml(devLink)}">${escapeHtml(devLink)}</a></p><p class="muted">Chế độ phát triển: liên kết hiện trực tiếp.</p>` : ""}</div>`));
  });

  router.get("/report-admin/verify", async (req, res) => {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    const row = token ? await getStore(req).consumeAdminLoginToken(sha256(token)) : null;
    if (!row || !allowedEmails(env).includes(row.email)) {
      return res.status(400).type("html").send(layout("Liên kết hết hạn", `<div class="card"><p>Liên kết không hợp lệ, đã dùng hoặc hết hạn.</p><p><a href="/report-admin/login">Đăng nhập lại</a></p></div>`));
    }
    const session = signSession(env, { e: row.email, c: randomBytes(16).toString("base64url"), x: Date.now() + SESSION_TTL_MS });
    res.set("Set-Cookie", `${COOKIE}=${session}; HttpOnly; SameSite=Lax; Path=/report-admin; Max-Age=${SESSION_TTL_MS / 1000}${secureCookie()}`);
    await getStore(req).recordAudit({ actorType: "admin", actor: row.email, action: "admin.login", result: "success" }).catch(() => {});
    return res.redirect(302, "/report-admin");
  });

  router.get("/report-admin/logout", (req, res) => {
    res.set("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/report-admin; Max-Age=0${secureCookie()}`);
    res.redirect(302, "/report-admin/login");
  });

  // ---- pages -------------------------------------------------------------
  router.get("/report-admin", requireSession, async (req, res) => {
    const tenants = await getStore(req).listTenants();
    const order = { pending: 0, active: 1, suspended: 2 };
    tenants.sort((a, b) => order[a.status] - order[b.status] || String(a.name).localeCompare(String(b.name)));
    const rows = tenants.map((t) => `<tr><td><a href="/report-admin/tenants/${t.id}"><strong>${escapeHtml(t.name)}</strong></a><div class="muted"><code>${escapeHtml(t.locationId)}</code></div></td>
      <td>${t.status === "active" && !t.connected ? `<span class="badge pending">Chờ khách kết nối</span>` : `<span class="badge ${t.status}">${STATUS_LABELS[t.status]}</span>`}</td><td>${t.memberCount}</td><td><a href="/report-admin/tenants/${t.id}">Mở</a></td></tr>`).join("");
    const paused = (await getStore(req).getSetting("paused")) === "true";
    const pauseCard = `<div class="card"><div class="row" style="justify-content:space-between"><div>${paused
      ? `<strong style="color:var(--bad)">Đang tạm dừng:</strong> mọi lệnh gọi dữ liệu của khách đều bị từ chối. Đăng nhập vẫn hoạt động.`
      : `<strong>Hệ thống đang hoạt động.</strong> <span class="muted">Dùng nút bên cạnh để dừng ngay mọi truy cập dữ liệu (không cần deploy).</span>`}</div>
      <form method="post" action="/report-admin/pause">${csrfField(req)}<input type="hidden" name="paused" value="${paused ? "false" : "true"}">
      <button class="${paused ? "primary" : "danger"}">${paused ? "Bật lại" : "Tạm dừng tất cả"}</button></form></div></div>`;
    const addCard = `<div class="card"><h2>Thêm khách mới (cấp quyền trước khi khách kết nối)</h2>
      <form method="post" action="/report-admin/tenants" class="row">${csrfField(req)}
        <input type="text" name="locationId" required placeholder="Location ID của sub-account" pattern="[A-Za-z0-9]{10,40}" style="min-width:17rem">
        <input type="text" name="name" placeholder="Tên khách" maxlength="100">
        <select name="preset">${Object.entries(PRESETS).map(([key, p]) => `<option value="${key}" ${key === "basic" ? "selected" : ""}>${escapeHtml(p.label)}</option>`).join("")}</select>
        <button class="primary">Thêm và bật gói</button></form>
      <p class="muted">Khách chỉ kết nối được khi sub-account của họ đã nằm trong danh sách này. Location ID lấy ở HighLevel (Settings → Business Profile, hoặc trong URL của sub-account).</p></div>`;
    res.type("html").send(layout("Khách hàng", `<h1>Khách hàng</h1>${pauseCard}${addCard}
      <div class="card"><table><tr><th>Khách (sub-account)</th><th>Trạng thái</th><th>Thành viên</th><th></th></tr>
      ${rows || `<tr><td colspan="4" class="muted">Chưa có khách nào cài ứng dụng.</td></tr>`}</table></div>`, req.admin));
  });

  router.post("/report-admin/pause", requireSession, form, requireCsrf, async (req, res) => {
    const store = getStore(req);
    const paused = req.body.paused === "true";
    await store.setSetting("paused", paused ? "true" : "false", req.admin.email);
    await store.recordAudit({ actorType: "admin", actor: req.admin.email, action: paused ? "system.paused" : "system.resumed", result: "success" }).catch(() => {});
    res.redirect(303, "/report-admin");
  });

  router.post("/report-admin/tenants", requireSession, form, requireCsrf, async (req, res) => {
    const locationId = String(req.body.locationId || "").trim();
    const packs = resolvePacks({ preset: req.body.preset });
    if (!validLocationId(locationId) || !packs) {
      return res.status(400).type("html").send(layout("Không thêm được", `<div class="card"><p>Location ID không hợp lệ (10-40 ký tự chữ và số) hoặc gói không đúng.</p><p><a href="/report-admin">← Quay lại</a></p></div>`, req.admin));
    }
    const store = getStore(req);
    const out = await provisionCustomer({
      store, locationId, name: String(req.body.name || "").trim().slice(0, 100), packs, actor: req.admin.email, actorType: "admin"
    });
    return res.redirect(303, `/report-admin/tenants/${out.tenantId}`);
  });

  router.get("/report-admin/setup", requireSession, (req, res) => {
    const scopes = allRequestedScopes();
    const base = reportBase(env);
    res.type("html").send(layout("Cài đặt", `<h1>Cài đặt kết nối</h1>
      <div class="card"><h2>Địa chỉ MCP (khách dán vào ChatGPT/Claude)</h2><p class="code">${escapeHtml(base)}/mcp</p>
        <p class="muted">ChatGPT: bật Developer mode → Settings → Apps → Create. Claude: Settings → Connectors → Add custom connector.</p></div>
      <div class="card"><h2>Redirect URL của Marketplace app</h2><p class="code">${escapeHtml(env.REPORT_GHL_REDIRECT_URI || `${base}/oauth/callback`)}</p></div>
      <div class="card"><h2>Cấp quyền tự động khi khách mua (webhook)</h2>${provisionWebhookEnabled(env)
        ? `<p class="code">POST ${escapeHtml(base)}/provision<br>Authorization: Bearer &lt;REPORT_PROVISION_SECRET&gt;</p>
           <p class="code">{"locationId":"...","name":"Tên khách","preset":"basic"}</p>
           <p class="muted">preset: ${Object.keys(PRESETS).join(", ")}; hoặc "packs": [${PACK_IDS.map((p) => `"${p}"`).join(", ")}]. Tạo mới nếu chưa có, không đổi khách đã có (thêm "update": true để áp lại gói). Dùng action Custom Webhook trong workflow HighLevel.</p>`
        : `<p class="muted">Đang tắt. Đặt biến <code>REPORT_PROVISION_SECRET</code> (32+ ký tự ngẫu nhiên) trên Render để bật.</p>`}</div>
      <div class="card"><h2>Scope cần chọn trên Marketplace app (${scopes.length}, chỉ đọc)</h2><p class="code">${scopes.map(escapeHtml).join("<br>")}</p>
        <p class="muted">Loại app: Sub-Account. Listing → Who can install = Everyone. Không chọn scope ghi.</p></div>`, req.admin));
  });

  router.get("/report-admin/tenants/:id", requireSession, async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).end();
    const store = getStore(req);
    const tenant = await store.getTenant(req.params.id);
    if (!tenant) return res.status(404).type("html").send(layout("Không tìm thấy", "<p>Không có khách này.</p>", req.admin));
    const [permissions, members, invites, auditRows] = await Promise.all([
      store.getPermissions(tenant.id), store.listMembers(tenant.id), store.listInvites(tenant.id), store.listAudit({ tenantId: tenant.id, limit: 40 })
    ]);
    const csrf = csrfField(req);
    const id = tenant.id;

    const statusBlock = tenant.status === "pending"
      ? `<form method="post" action="/report-admin/tenants/${id}/approve" class="row">${csrf}<select name="preset">${Object.entries(PRESETS).map(([key, p]) => `<option value="${key}" ${key === "basic" ? "selected" : ""}>${escapeHtml(p.label)}</option>`).join("")}</select><button class="primary">Duyệt và bật gói</button></form>`
      : tenant.status === "active"
        ? `<form method="post" action="/report-admin/tenants/${id}/status" class="row">${csrf}<input type="hidden" name="status" value="suspended"><button class="danger">Tạm khóa (thu hồi mọi phiên)</button></form>`
        : `<form method="post" action="/report-admin/tenants/${id}/status" class="row">${csrf}<input type="hidden" name="status" value="active"><button class="primary">Mở khóa</button></form>`;

    const grantRows = PACK_IDS.map((pack) => `<tr><td><label><input type="checkbox" name="grant_${pack}" ${permissions.grants[pack] === true ? "checked" : ""}> <strong>${escapeHtml(PACKS[pack].label)}</strong></label>
      <div class="muted">${PACKS[pack].tools.map((t) => `<code>${t}</code>`).join(" ")}</div></td></tr>`).join("");

    const matrixHead = ROLES.map((r) => `<th class="center">${ROLE_LABELS[r]}</th>`).join("");
    const matrixRows = PACK_IDS.map((pack) => `<tr><td>${escapeHtml(PACKS[pack].label)}</td>${ROLES.map((role) =>
      `<td class="center"><input type="checkbox" name="rp_${role}_${pack}" ${roleAllows(permissions, role, pack) ? "checked" : ""}></td>`).join("")}</tr>`).join("");

    const memberRows = members.map((m) => `<tr><td>${escapeHtml(m.email || m.displayName || m.userId)}</td><td>${m.status === "active" ? `
      <form method="post" action="/report-admin/tenants/${id}/members/${m.userId}/role" class="row">${csrf}<select name="role">${ROLES.map((r) => `<option value="${r}" ${r === m.role ? "selected" : ""}>${ROLE_LABELS[r]}</option>`).join("")}</select><button>Đổi</button></form>` : `<span class="badge suspended">Đã thu hồi</span>`}</td>
      <td>${m.status === "active" ? `<form method="post" action="/report-admin/tenants/${id}/members/${m.userId}/revoke">${csrf}<button class="danger">Thu hồi</button></form>` : ""}</td></tr>`).join("");

    const inviteRows = invites.map((i) => `<tr><td>${escapeHtml(i.email)}</td><td>${ROLE_LABELS[i.role]}</td><td>${i.consumed ? "Đã dùng" : `Hết hạn ${escapeHtml(new Date(i.expiresAt).toISOString().slice(0, 10))}`}</td></tr>`).join("");

    const auditList = auditRows.map((a) => `<tr><td class="muted">${escapeHtml(new Date(a.created_at).toISOString().replace("T", " ").slice(0, 19))}</td><td>${escapeHtml(a.actor || "")}</td><td>${escapeHtml(a.action)}${a.tool ? ` · <code>${escapeHtml(a.tool)}</code>` : ""}</td><td>${escapeHtml(a.result)}</td></tr>`).join("");

    res.type("html").send(layout(tenant.name, `<p><a href="/report-admin">← Khách hàng</a></p>
      <h1>${escapeHtml(tenant.name)} <span class="badge ${tenant.status}">${STATUS_LABELS[tenant.status]}</span></h1>
      <p class="muted"><code>${escapeHtml(tenant.locationId)}</code></p>
      <div class="card"><h2>Trạng thái</h2>${statusBlock}</div>
      <div class="card"><h2>Gói dữ liệu khách được dùng</h2><form method="post" action="/report-admin/tenants/${id}/grants">${csrf}<table>${grantRows}</table><p><button class="primary">Lưu gói</button></p></form></div>
      <div class="card"><h2>Gói theo vai trò</h2><p class="muted">Một người dùng được gói nào khi cả hai điều kiện đúng: khách được dùng gói đó và vai trò của người đó được tick ở đây.</p>
        <form method="post" action="/report-admin/tenants/${id}/role-matrix">${csrf}<table><tr><th>Gói</th>${matrixHead}</tr>${matrixRows}</table><p><button class="primary">Lưu vai trò</button></p></form></div>
      <div class="card"><h2>Thành viên</h2><table><tr><th>Người dùng</th><th>Vai trò</th><th></th></tr>${memberRows || `<tr><td colspan="3" class="muted">Chưa có.</td></tr>`}</table></div>
      <div class="card"><h2>Cấp mã truy cập cho nhân viên</h2><p class="muted">Dành cho người không thể tự cài ứng dụng (chỉ Admin CRM mới cài được). Mã dùng một lần, hết hạn sau 7 ngày, chỉ hiện một lần.</p>
        <form method="post" action="/report-admin/tenants/${id}/invites" class="row">${csrf}<input type="email" name="email" required placeholder="email nhân viên"><select name="role">${INVITE_ROLES.map((r) => `<option value="${r}" ${r === "staff" ? "selected" : ""}>${ROLE_LABELS[r]}</option>`).join("")}</select><button class="primary">Tạo mã</button></form>
        ${inviteRows ? `<table style="margin-top:.8rem"><tr><th>Email</th><th>Vai trò</th><th>Trạng thái</th></tr>${inviteRows}</table>` : ""}</div>
      <div class="card"><h2>Nhật ký gần đây</h2><table><tr><th>Lúc (UTC)</th><th>Ai</th><th>Hành động</th><th>Kết quả</th></tr>${auditList || `<tr><td colspan="4" class="muted">Chưa có.</td></tr>`}</table></div>`, req.admin));
  });

  // ---- actions -----------------------------------------------------------
  const tenantAction = (path, handler) => router.post(`/report-admin/tenants/:id${path}`, requireSession, form, requireCsrf, async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).end();
    const store = getStore(req);
    const tenant = await store.getTenant(req.params.id);
    if (!tenant) return res.status(404).end();
    const next = await handler({ req, res, store, tenant });
    if (!res.headersSent) res.redirect(303, next || `/report-admin/tenants/${tenant.id}`);
  });

  tenantAction("/approve", async ({ req, store, tenant }) => {
    const preset = PRESETS[req.body.preset];
    if (!preset || tenant.status !== "pending") return;
    for (const pack of PACK_IDS) await store.setPackGrant(tenant.id, pack, preset.packs.includes(pack), req.admin.email);
    await store.setTenantStatus(tenant.id, "active");
    await audit(store, req, tenant.id, "tenant.approved", { preset: req.body.preset, packs: preset.packs });
  });

  tenantAction("/status", async ({ req, store, tenant }) => {
    const status = req.body.status;
    if (!["active", "suspended"].includes(status) || tenant.status === "pending") return;
    await store.setTenantStatus(tenant.id, status);
    if (status === "suspended") await store.revokeTokens({ tenantId: tenant.id });
    await audit(store, req, tenant.id, `tenant.${status}`);
  });

  tenantAction("/grants", async ({ req, store, tenant }) => {
    const changed = {};
    for (const pack of PACK_IDS) {
      const enabled = req.body[`grant_${pack}`] === "on";
      await store.setPackGrant(tenant.id, pack, enabled, req.admin.email);
      changed[pack] = enabled;
    }
    await audit(store, req, tenant.id, "grants.updated", { grants: changed });
  });

  tenantAction("/role-matrix", async ({ req, store, tenant }) => {
    for (const role of ROLES) for (const pack of PACK_IDS) {
      await store.setRolePack(tenant.id, role, pack, req.body[`rp_${role}_${pack}`] === "on", req.admin.email);
    }
    await audit(store, req, tenant.id, "role_matrix.updated");
  });

  tenantAction("/members/:userId/role", async ({ req, store, tenant }) => {
    if (!UUID.test(req.params.userId) || !ROLES.includes(req.body.role)) return;
    if (await store.setMembershipRole(tenant.id, req.params.userId, req.body.role)) {
      await audit(store, req, tenant.id, "member.role_changed", { userId: req.params.userId, role: req.body.role });
    }
  });

  tenantAction("/members/:userId/revoke", async ({ req, store, tenant }) => {
    if (!UUID.test(req.params.userId)) return;
    if (await store.setMembershipStatus(tenant.id, req.params.userId, "revoked")) {
      await store.revokeTokens({ tenantId: tenant.id, userId: req.params.userId });
      await audit(store, req, tenant.id, "member.revoked", { userId: req.params.userId });
    }
  });

  tenantAction("/invites", async ({ req, res, store, tenant }) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!/^[^\s@]{1,64}@[^\s@]{1,255}$/.test(email) || !INVITE_ROLES.includes(req.body.role) || tenant.status === "suspended") return;
    const code = await createAccessCode({ store, tenantId: tenant.id, email, role: req.body.role, createdBy: req.admin.email });
    await audit(store, req, tenant.id, "invite.created", { email, role: req.body.role });
    res.type("html").send(layout("Mã truy cập", `<div class="card"><h2>Mã truy cập cho ${escapeHtml(email)}</h2>
      <p class="code">${escapeHtml(code)}</p>
      <p>Gửi mã này cho nhân viên qua kênh riêng. Khi kết nối ChatGPT/Claude, họ chọn "Dùng mã truy cập", nhập email này và mã. Mã chỉ hiện một lần, dùng một lần, hết hạn sau 7 ngày.</p>
      <p><a href="/report-admin/tenants/${tenant.id}">← Quay lại</a></p></div>`, req.admin));
  });

  return router;
}
