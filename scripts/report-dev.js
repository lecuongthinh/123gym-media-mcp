// Local preview of the report gateway dashboard with seeded in-memory data.
// Nothing here touches a database or HighLevel: run `node scripts/report-dev.js`
// and open the printed URL. Never use this in production.
import { randomBytes } from "node:crypto";
import express from "express";
import { createReportRouter } from "../src/report/index.js";
import { InMemoryReportStore } from "../src/report/store.js";
import { encryptCredential } from "../src/credential-provider.js";

const port = Number(process.env.PORT || 4010);
const env = {
  NODE_ENV: "development",
  REPORT_ENABLED: "true",
  MCP_RESOURCE_URL: `http://localhost:${port}`,
  REPORT_GHL_CLIENT_ID: "dev-client",
  REPORT_GHL_CLIENT_SECRET: "dev-secret",
  REPORT_GHL_REDIRECT_URI: `http://localhost:${port}/report/oauth/callback`,
  TENANT_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  REPORT_ADMIN_EMAILS: "admin@example.com",
  REPORT_SESSION_SECRET: randomBytes(32).toString("hex"),
  REPORT_DEV_LOGIN: "true"
};

const store = new InMemoryReportStore();
const dummy = (token) => encryptCredential({ access_token: token, refresh_token: "r", location_id: "x", expires_at: new Date(Date.now() + 86400_000).toISOString() }, env);
const a = await store.provisionLogin({ subject: "s1", email: "chu@trungtam-a.vn", displayName: "Chủ TT A", locationId: "LOC_A", locationName: "Trung tâm Anh ngữ A", encryptedPayload: dummy("a"), expiresAt: new Date(Date.now() + 86400_000).toISOString(), scopes: [] });
await store.provisionLogin({ subject: "s2", email: "chu@phong-gym-b.vn", displayName: "Chủ B", locationId: "LOC_B", locationName: "Phòng gym B (chờ duyệt)", encryptedPayload: dummy("b"), expiresAt: new Date(Date.now() + 86400_000).toISOString(), scopes: [] });
await store.setTenantStatus(a.tenantId, "active");
for (const pack of ["contacts", "opportunities", "calendar"]) await store.setPackGrant(a.tenantId, pack, true, "seed");
await store.recordAudit({ tenantId: a.tenantId, actorType: "mcp", actor: "chu@trungtam-a.vn", action: "tool.call", tool: "crm_search_contacts", pack: "contacts", result: "success" });
await store.recordAudit({ tenantId: a.tenantId, actorType: "mcp", actor: "chu@trungtam-a.vn", action: "tool.call", tool: "crm_list_orders", pack: "payments", result: "denied" });

const app = express();
app.use(express.json());
app.locals.reportStore = store;
app.use(createReportRouter({ env, fetchImpl: async () => { throw new Error("no network in dev preview"); } }));
app.listen(port, "127.0.0.1", () => console.log(`Report dashboard preview: http://localhost:${port}/report-admin/login  (sign in as admin@example.com; the link is shown on the page)`));
