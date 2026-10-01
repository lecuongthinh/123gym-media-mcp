import express from "express";

const PLANS = ["trial", "standard", "pro"];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function page(title, body) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>` +
    `<body style="font-family:system-ui,sans-serif;max-width:60rem;margin:3rem auto;padding:0 1rem;color:#111">` +
    `<h1 style="font-size:1.25rem">${escapeHtml(title)}</h1>${body}</body>`;
}

function toIntOrNull(value) {
  if (value === "" || value === undefined || value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

// Internal-only admin panel: set a tenant's plan and tune each plan's
// quantity limits (users, AI-created posts/month) without touching the
// database or redeploying. Gated behind a single static key in the query
// string (ADMIN_PANEL_KEY) rather than a full login -- intended to be
// opened from a HighLevel Custom Menu Link the agency's own team sees, not
// a customer-facing surface. Off entirely (404) unless that env var is set.
export function createAdminPanelRouter({ env = process.env, getRepository } = {}) {
  const router = express.Router();

  function requireKey(req, res, next) {
    const configured = env.ADMIN_PANEL_KEY;
    if (!configured) return res.status(404).end();
    if (req.query.key !== configured) return res.status(403).send("Forbidden");
    next();
  }

  router.get("/admin", requireKey, async (req, res) => {
    const repository = getRepository(req);
    const period = new Date().toISOString().slice(0, 7);
    const [tenants, limits] = await Promise.all([repository.listTenantsForAdmin(period), repository.getPlanLimits()]);
    const key = encodeURIComponent(req.query.key);

    const limitRows = PLANS.map((plan) => {
      const limit = limits[plan] || {};
      return `<tr>
        <td>${plan}</td>
        <td><form method="post" action="/admin/plan-limits/${plan}?key=${key}" style="display:flex;gap:0.5rem;align-items:center">
          <label>Max users <input type="number" min="1" name="maxUsers" value="${limit.maxUsers ?? ""}" placeholder="unlimited" style="width:6rem"></label>
          <label>Max posts/mo <input type="number" min="1" name="maxPostsPerMonth" value="${limit.maxPostsPerMonth ?? ""}" placeholder="unlimited" style="width:7rem"></label>
          <button type="submit">Save</button>
        </form></td>
      </tr>`;
    }).join("");

    const tenantRows = tenants.map((tenant) => `<tr>
        <td>${escapeHtml(tenant.displayName)}</td>
        <td>${escapeHtml(tenant.status)}</td>
        <td><form method="post" action="/admin/tenants/${encodeURIComponent(tenant.id)}/plan?key=${key}" style="display:flex;gap:0.5rem">
          <select name="plan">${PLANS.map((plan) => `<option value="${plan}" ${plan === tenant.plan ? "selected" : ""}>${plan}</option>`).join("")}</select>
          <button type="submit">Save</button>
        </form></td>
        <td>${tenant.memberCount}</td>
        <td>${tenant.postsThisPeriod}</td>
      </tr>`).join("");

    res.type("html").send(page("Uplifting Social AI -- Admin", `
      <h2 style="font-size:1rem">Plan limits</h2>
      <p style="color:#666">Leave a field blank for unlimited. Changes apply immediately -- no redeploy.</p>
      <table border="1" cellpadding="8" style="border-collapse:collapse;margin-bottom:2.5rem">
        <tr><th>Plan</th><th>Limits</th></tr>
        ${limitRows}
      </table>
      <h2 style="font-size:1rem">Tenants (this period: ${period})</h2>
      <table border="1" cellpadding="8" style="border-collapse:collapse">
        <tr><th>Tenant</th><th>Status</th><th>Plan</th><th>Members</th><th>Posts this month</th></tr>
        ${tenantRows || '<tr><td colspan="5">No tenants yet.</td></tr>'}
      </table>
    `));
  });

  router.post("/admin/tenants/:tenantId/plan", requireKey, express.urlencoded({ extended: false }), async (req, res) => {
    const plan = req.body?.plan;
    if (!PLANS.includes(plan)) return res.status(400).send("Invalid plan.");
    await getRepository(req).setTenantPlan(req.params.tenantId, plan);
    res.redirect(`/admin?key=${encodeURIComponent(req.query.key)}`);
  });

  router.post("/admin/plan-limits/:plan", requireKey, express.urlencoded({ extended: false }), async (req, res) => {
    const plan = req.params.plan;
    if (!PLANS.includes(plan)) return res.status(400).send("Invalid plan.");
    await getRepository(req).setPlanLimit({
      plan,
      maxUsers: toIntOrNull(req.body?.maxUsers),
      maxPostsPerMonth: toIntOrNull(req.body?.maxPostsPerMonth)
    });
    res.redirect(`/admin?key=${encodeURIComponent(req.query.key)}`);
  });

  return router;
}
