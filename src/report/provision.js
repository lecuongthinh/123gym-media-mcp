import { createHash, timingSafeEqual } from "node:crypto";
import express from "express";
import { PACK_IDS, PRESETS } from "./packs.js";
import { reportOAuthEnabled } from "./oauth.js";

// Pre-provisioning: a customer is created and given their packs BEFORE they
// connect (sold -> permissions set -> customer connects). Used by the
// dashboard's "Thêm khách" form and by the provisioning webhook.

const LOCATION_ID = /^[A-Za-z0-9]{10,40}$/;

export function validLocationId(value) {
  return typeof value === "string" && LOCATION_ID.test(value);
}

// Pack list from a preset key or an explicit array; null when invalid.
export function resolvePacks({ preset, packs }) {
  if (Array.isArray(packs)) return packs.every((p) => PACK_IDS.includes(p)) ? [...new Set(packs)] : null;
  if (preset === undefined || preset === null || preset === "") return PRESETS.basic.packs;
  return PRESETS[preset]?.packs ?? null;
}

// Creates the customer (if new) and switches it on with the given packs.
// Existing customers are left alone unless update=true, and a suspended
// customer is never reactivated here.
export async function provisionCustomer({ store, locationId, name, packs, update = false, actor, actorType }) {
  const result = await store.provisionTenant({ locationId, name });
  const apply = result.created || (update && result.status !== "suspended");
  if (apply) {
    for (const pack of PACK_IDS) await store.setPackGrant(result.id, pack, packs.includes(pack), actor);
    if (result.status === "pending") await store.setTenantStatus(result.id, "active");
  }
  await store.recordAudit({
    tenantId: result.id, actorType, actor, action: result.created ? "tenant.provisioned" : (apply ? "tenant.reprovisioned" : "tenant.provision_skipped"),
    result: "success", metadata: { packs: apply ? packs : undefined, status: result.status }
  }).catch(() => {});
  return { tenantId: result.id, created: result.created, applied: apply, status: result.created ? "active" : result.status };
}

function safeEqual(a, b) {
  const left = createHash("sha256").update(String(a)).digest();
  const right = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(left, right);
}

export function provisionWebhookEnabled(env = process.env) {
  return reportOAuthEnabled(env) && String(env.REPORT_PROVISION_SECRET || "").length >= 32;
}

// POST /report/provision  (Authorization: Bearer <REPORT_PROVISION_SECRET>)
// { "locationId": "...", "name": "Trung tâm A", "preset": "basic" | "packs": ["contacts", ...], "update": false }
// Meant for a HighLevel workflow ("Custom Webhook" action) fired when a customer buys.
export function createProvisionRouter({ env = process.env, getStore, now = () => Date.now() } = {}) {
  const router = express.Router();
  const attempts = [];

  router.post("/report/provision", async (req, res) => {
    if (!provisionWebhookEnabled(env)) return res.status(404).end();
    res.set("Cache-Control", "no-store");
    const cutoff = now() - 60_000;
    while (attempts.length && attempts[0] < cutoff) attempts.shift();
    attempts.push(now());
    if (attempts.length > 60) return res.status(429).json({ error: "rate_limited" });

    const header = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") || "")?.[1] || "";
    if (!header || !safeEqual(header, env.REPORT_PROVISION_SECRET)) return res.status(401).json({ error: "unauthorized" });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    if (!validLocationId(body.locationId)) return res.status(400).json({ error: "invalid_locationId" });
    const packs = resolvePacks({ preset: body.preset, packs: body.packs });
    if (!packs) return res.status(400).json({ error: "invalid_preset_or_packs", allowedPacks: PACK_IDS, allowedPresets: Object.keys(PRESETS) });
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";

    const out = await provisionCustomer({
      store: getStore(req), locationId: body.locationId, name, packs, update: body.update === true, actor: "webhook", actorType: "system"
    });
    return res.status(out.created ? 201 : 200).json({ ok: true, ...out });
  });

  return router;
}
