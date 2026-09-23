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

console.log(JSON.stringify(report, null, 2));
if (missingOAuth.length) process.exitCode = 1;
