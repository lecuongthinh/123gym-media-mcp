const requiredOAuth = ["DATABASE_URL", "AUTH0_ISSUER_BASE_URL", "AUTH0_AUDIENCE", "MCP_RESOURCE_URL"];
const missingOAuth = requiredOAuth.filter((name) => !process.env[name]);
const legacyEnabled = process.env.ENABLE_LEGACY_ADMIN_AUTH === "true";

const report = {
  oauth: missingOAuth.length ? "incomplete" : "configured",
  missingOAuth,
  legacyAdmin: legacyEnabled ? (process.env.MCP_ADMIN_API_KEY ? "configured" : "missing_key") : "disabled",
  testingAgencyPit: process.env.LC_PRIVATE_TOKEN_TESTING_AGENCY ? "configured" : "not_configured",
  highLevelOAuth: ["HIGHLEVEL_CLIENT_ID", "HIGHLEVEL_CLIENT_SECRET", "HIGHLEVEL_REDIRECT_URI", "HIGHLEVEL_INSTALL_URL", "TENANT_CREDENTIAL_ENCRYPTION_KEY"].every((name) => process.env[name]) ? "configured" : "not_configured"
};

// Report gateway (src/report). Names only, never values.
const reportRequired = ["REPORT_GHL_CLIENT_ID", "REPORT_GHL_CLIENT_SECRET", "REPORT_GHL_REDIRECT_URI", "MCP_RESOURCE_URL", "TENANT_CREDENTIAL_ENCRYPTION_KEY", "DATABASE_URL"];
report.reportGateway = {
  enabled: process.env.REPORT_ENABLED === "true",
  missing: process.env.REPORT_ENABLED === "true" ? reportRequired.filter((name) => !process.env[name]) : [],
  dashboard: process.env.REPORT_ADMIN_EMAILS && String(process.env.REPORT_SESSION_SECRET || "").length >= 32 ? "configured" : "not_configured",
  adminEmailWebhook: process.env.REPORT_ADMIN_WEBHOOK_URL || process.env.HIGHLEVEL_INVITE_WEBHOOK_URL ? "configured" : "not_configured"
};

console.log(JSON.stringify(report, null, 2));
if (missingOAuth.length || report.reportGateway.missing.length) process.exitCode = 1;
