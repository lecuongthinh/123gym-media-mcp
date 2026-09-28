import { createRemoteJWKSet, jwtVerify } from "jose";

export class AuthenticationError extends Error {
  constructor(message, { code = "invalid_token", status = 401 } = {}) {
    super(message);
    this.name = "AuthenticationError";
    this.code = code;
    this.status = status;
  }
}

export function normalizeIssuer(value) {
  const issuer = String(value || "").trim();
  return issuer ? `${issuer.replace(/\/+$/, "")}/` : "";
}

export function bearerToken(req) {
  const authorization = req.get("authorization") || "";
  return authorization.match(/^Bearer\s+([^\s]+)$/i)?.[1] || "";
}

export function tokenScopes(payload = {}) {
  const result = new Set();
  for (const raw of [payload.scope, payload.scp, payload.permissions]) {
    const values = Array.isArray(raw) ? raw : String(raw || "").split(/\s+/);
    for (const value of values) if (typeof value === "string" && value) result.add(value);
  }
  return result;
}

export function createAuth0Verifier(env = process.env, overrides = {}) {
  const issuer = normalizeIssuer(env.AUTH0_ISSUER_BASE_URL);
  const audience = String(env.AUTH0_AUDIENCE || "").trim();
  if (!issuer || !audience) throw new Error("AUTH0_ISSUER_BASE_URL and AUTH0_AUDIENCE are required for OAuth mode.");
  const jwks = overrides.jwks || createRemoteJWKSet(new URL(".well-known/jwks.json", issuer));
  const verify = overrides.jwtVerify || jwtVerify;

  return async function verifyAccessToken(token) {
    if (!token) throw new AuthenticationError("Bearer access token is required.");
    try {
      const { payload, protectedHeader } = await verify(token, jwks, {
        issuer,
        audience,
        algorithms: ["RS256"]
      });
      if (!payload.sub) throw new AuthenticationError("Access token is missing its subject.");
      return Object.freeze({
        subject: payload.sub,
        email: typeof payload.email === "string" ? payload.email : null,
        emailVerified: typeof payload.email_verified === "boolean" ? payload.email_verified : undefined,
        displayName: typeof payload.name === "string" ? payload.name : null,
        tenantIdClaim: payload[env.AUTH0_TENANT_CLAIM || "https://uplifting.vn/tenant_id"] || null,
        scopes: tokenScopes(payload),
        claims: payload,
        keyId: protectedHeader?.kid || null
      });
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      throw new AuthenticationError("Bearer access token is invalid or expired.");
    }
  };
}

// The built-in authorization server (see oauth-server.js) signs users in
// through HighLevel instead of an external identity provider.
export function builtInOAuthEnabled(env = process.env) {
  return env.OAUTH_SERVER_ENABLED === "true" && Boolean(
    String(env.MCP_RESOURCE_URL || "").trim() && env.HIGHLEVEL_INSTALL_URL && env.HIGHLEVEL_REDIRECT_URI &&
    env.HIGHLEVEL_CLIENT_ID && env.HIGHLEVEL_CLIENT_SECRET && env.TENANT_CREDENTIAL_ENCRYPTION_KEY
  );
}

export function authConfiguration(env = process.env) {
  const issuer = normalizeIssuer(env.AUTH0_ISSUER_BASE_URL);
  const resource = String(env.MCP_RESOURCE_URL || "").replace(/\/+$/, "");
  const auth0Ready = Boolean(issuer && env.AUTH0_AUDIENCE && resource);
  const builtInReady = builtInOAuthEnabled(env);
  const legacyAdminReady = env.ENABLE_LEGACY_ADMIN_AUTH === "true" && Boolean(env.MCP_ADMIN_API_KEY);
  return { issuer, resource, oauthReady: auth0Ready || builtInReady, auth0Ready, builtInReady, legacyAdminReady };
}

export function protectedResourceMetadata(env = process.env) {
  const { issuer, resource, oauthReady, builtInReady } = authConfiguration(env);
  if (!oauthReady) throw new Error("OAuth protected resource metadata is not configured.");
  if (builtInReady) {
    return {
      resource,
      authorization_servers: [resource],
      bearer_methods_supported: ["header"],
      resource_documentation: env.MCP_DOCUMENTATION_URL || `${resource}/docs`
    };
  }
  return {
    resource,
    authorization_servers: [issuer],
    scopes_supported: ["uplifting:read", "uplifting:write", "uplifting:admin"],
    bearer_methods_supported: ["header"],
    resource_documentation: env.MCP_DOCUMENTATION_URL || `${resource}/docs`
  };
}

export function oauthChallenge(env = process.env, { error, description, scope } = {}) {
  const resource = String(env.MCP_RESOURCE_URL || "").replace(/\/+$/, "");
  const metadataUrl = `${resource}/.well-known/oauth-protected-resource`;
  const values = [`resource_metadata="${metadataUrl}"`];
  if (scope) values.push(`scope="${scope}"`);
  if (error) values.push(`error="${error}"`);
  if (description) values.push(`error_description="${String(description).replace(/["\r\n]/g, "")}"`);
  return `Bearer ${values.join(", ")}`;
}

export function requireScopes(principal, required = []) {
  if (principal?.authType === "legacy_admin") return;
  const scopes = principal?.scopes || new Set();
  if (scopes.has("uplifting:admin")) return;
  const missing = required.filter((scope) => !scopes.has(scope));
  if (missing.length) {
    throw new AuthenticationError("Access token does not grant the required scope.", {
      code: "insufficient_scope",
      status: 403
    });
  }
}
