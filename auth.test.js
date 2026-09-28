import assert from "node:assert/strict";
import test from "node:test";

import { app } from "./server.js";
import {
  AuthenticationError,
  createAuth0Verifier,
  protectedResourceMetadata,
  requireScopes
} from "./src/auth.js";
import { EnvironmentCredentialProvider, InMemoryConnectionRepository } from "./src/tenant-services.js";

const TEST_TENANT_ID = "00000000-0000-4000-8000-000000000124";
const TEST_LOCATION = "UwsfBVLmz7XSKJbhuOTS";
const GYM_LOCATION = "pUePVc6UKEUecvZS6EYU";

async function withProcessEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try { return await fn(); } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

async function withServer(fn) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally {
    delete app.locals.auth0Verifier;
    delete app.locals.tenantServices;
    await new Promise((resolve) => server.close(resolve));
  }
}

function oauthEnv() {
  return {
    AUTH0_ISSUER_BASE_URL: "https://uplifting-test.auth0.com/",
    AUTH0_AUDIENCE: "https://staging.example.com",
    MCP_RESOURCE_URL: "https://staging.example.com",
    ENABLE_LEGACY_ADMIN_AUTH: undefined,
    MCP_ADMIN_API_KEY: "must-not-authorize-bearer"
  };
}

function testServices(role = "tenant_admin") {
  const base = new InMemoryConnectionRepository([{
    tenant_id: TEST_TENANT_ID,
    tenant_name: "Testing Agency",
    connection_id: "testing-connection",
    location_id: TEST_LOCATION,
    tenant_status: "active",
    connection_status: "active",
    secret_backend: "environment",
    secret_ref: "env://LC_PRIVATE_TOKEN_TESTING_AGENCY",
    scopes: []
  }]);
  const repository = {
    findActiveConnectionByTenantId: (...args) => base.findActiveConnectionByTenantId(...args),
    findActiveConnectionByLocationId: (...args) => base.findActiveConnectionByLocationId(...args),
    async resolveUserAuthorization({ authSubject, tenantIdClaim }) {
      assert.equal(authSubject, "auth0|testing-user");
      if (tenantIdClaim && tenantIdClaim !== TEST_TENANT_ID) throw new Error("User has no active membership for the requested tenant.");
      return {
        id: "user-124", auth_subject: authSubject, email: "tester@example.com",
        membership_id: "membership-124", role,
        tenant_id: TEST_TENANT_ID, tenant_name: "Testing Agency"
      };
    },
    async recordAuditEvent() {},
    async createOAuthState() {}
  };
  return {
    repository,
    credentialProvider: new EnvironmentCredentialProvider({ LC_PRIVATE_TOKEN_TESTING_AGENCY: "testing-token" })
  };
}

test("Auth0 verifier enforces issuer, audience and RS256 through jose", async () => {
  let options;
  const verify = createAuth0Verifier(oauthEnv(), {
    jwks: async () => ({}),
    jwtVerify: async (token, jwks, received) => {
      assert.equal(token, "signed-token");
      options = received;
      return {
        protectedHeader: { kid: "key-1" },
        payload: { sub: "auth0|testing-user", scope: "uplifting:read", aud: received.audience, iss: received.issuer }
      };
    }
  });
  const identity = await verify("signed-token");
  assert.equal(identity.subject, "auth0|testing-user");
  assert.ok(identity.scopes.has("uplifting:read"));
  assert.deepEqual(options.algorithms, ["RS256"]);
  assert.equal(options.audience, "https://staging.example.com");
});

test("protected resource metadata binds ChatGPT OAuth to the staging resource", () => {
  const metadata = protectedResourceMetadata(oauthEnv());
  assert.equal(metadata.resource, "https://staging.example.com");
  assert.deepEqual(metadata.authorization_servers, ["https://uplifting-test.auth0.com/"]);
  assert.ok(metadata.scopes_supported.includes("uplifting:write"));
});

test("scope enforcement rejects write with read-only token", () => {
  assert.throws(
    () => requireScopes({ scopes: new Set(["uplifting:read"]) }, ["uplifting:write"]),
    (error) => error instanceof AuthenticationError && error.code === "insufficient_scope"
  );
});

test("OAuth user can call a read tool only for its membership tenant", async () => {
  await withProcessEnv({ ...oauthEnv(), LC_PRIVATE_TOKEN_TESTING_AGENCY: "testing-token" }, () => withServer(async (baseUrl) => {
    app.locals.auth0Verifier = async () => ({
      subject: "auth0|testing-user", email: "tester@example.com", displayName: "Tester",
      tenantIdClaim: TEST_TENANT_ID, scopes: new Set(["uplifting:read"])
    });
    app.locals.tenantServices = testServices();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith("https://services.leadconnectorhq.com/")) {
        assert.match(String(url), new RegExp(`/social-media-posting/${TEST_LOCATION}/accounts$`));
        assert.equal(options.headers.Authorization, "Bearer testing-token");
        return new Response(JSON.stringify({ results: { accounts: [] } }), { status: 200 });
      }
      return realFetch(url, options);
    };
    try {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer signed-user-token" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_social_accounts", arguments: { locationId: TEST_LOCATION } } })
      });
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.deepEqual(payload.result.structuredContent, { results: { accounts: [] } });
    } finally { globalThis.fetch = realFetch; }
  }));
});

test("OAuth user cannot switch locationId to 123 GYM", async () => {
  await withProcessEnv(oauthEnv(), () => withServer(async (baseUrl) => {
    app.locals.auth0Verifier = async () => ({ subject: "auth0|testing-user", tenantIdClaim: TEST_TENANT_ID, scopes: new Set(["uplifting:read"]) });
    app.locals.tenantServices = testServices();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer signed-user-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_social_accounts", arguments: { locationId: GYM_LOCATION } } })
    });
    const payload = await response.json();
    assert.match(payload.error.message, /Cross-tenant location access blocked/);
  }));
});

test("viewer role is blocked from write tools by database role, even with a token that carries every scope", async () => {
  await withProcessEnv(oauthEnv(), () => withServer(async (baseUrl) => {
    app.locals.auth0Verifier = async () => ({
      subject: "auth0|testing-user", tenantIdClaim: TEST_TENANT_ID,
      scopes: new Set(["uplifting:read", "uplifting:write", "uplifting:admin"])
    });
    app.locals.tenantServices = testServices("viewer");
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer signed-user-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create_social_post", arguments: { locationId: TEST_LOCATION } } })
    });
    const payload = await response.json();
    assert.match(payload.error.message, /read-only/);
  }));
});

test("editor role can be blocked from delete tools while still allowed to create posts", async () => {
  await withProcessEnv(oauthEnv(), () => withServer(async (baseUrl) => {
    app.locals.auth0Verifier = async () => ({ subject: "auth0|testing-user", tenantIdClaim: TEST_TENANT_ID, scopes: new Set() });
    app.locals.tenantServices = testServices("editor");
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer signed-user-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "delete_social_post", arguments: { locationId: TEST_LOCATION, postId: "507f1f77bcf86cd799439011" } } })
    });
    const payload = await response.json();
    assert.match(payload.error.message, /administrator permission is required/);
  }));
});

test("connect_highlevel starts onboarding without requiring an existing HighLevel connection", async () => {
  await withProcessEnv({
    ...oauthEnv(),
    HIGHLEVEL_INSTALL_URL: "https://marketplace.gohighlevel.com/oauth/chooselocation?client_id=test-client",
    HIGHLEVEL_REDIRECT_URI: "https://staging.example.com/oauth/callback/highlevel"
  }, () => withServer(async (baseUrl) => {
    app.locals.auth0Verifier = async () => ({ subject: "auth0|testing-user", tenantIdClaim: TEST_TENANT_ID, scopes: new Set() });
    const services = testServices("tenant_owner");
    services.repository.findActiveConnectionByTenantId = () => { throw new Error("must not be called for connect_highlevel"); };
    app.locals.tenantServices = services;
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer signed-user-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "connect_highlevel", arguments: { locationId: TEST_LOCATION } } })
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.ok(payload.result.structuredContent.authorizationUrl.startsWith("https://marketplace.gohighlevel.com/"));
  }));
});

test("connect_highlevel rejects a non-owner tenant role", async () => {
  await withProcessEnv({
    ...oauthEnv(),
    HIGHLEVEL_INSTALL_URL: "https://marketplace.gohighlevel.com/oauth/chooselocation?client_id=test-client",
    HIGHLEVEL_REDIRECT_URI: "https://staging.example.com/oauth/callback/highlevel"
  }, () => withServer(async (baseUrl) => {
    app.locals.auth0Verifier = async () => ({ subject: "auth0|testing-user", tenantIdClaim: TEST_TENANT_ID, scopes: new Set() });
    app.locals.tenantServices = testServices("editor");
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer signed-user-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "connect_highlevel", arguments: {} } })
    });
    const payload = await response.json();
    assert.match(payload.error.message, /owner or administrator/);
  }));
});

test("unexpected authentication backend errors do not expose database secrets", async () => {
  await withProcessEnv({ ...oauthEnv(), DATABASE_URL: "postgresql://user:super-secret-password@db.example/postgres" }, () => withServer(async (baseUrl) => {
    app.locals.auth0Verifier = async () => ({ subject: "auth0|testing-user", tenantIdClaim: TEST_TENANT_ID, scopes: new Set(["uplifting:read"]) });
    app.locals.tenantServices = {
      repository: { async resolveUserAuthorization() { throw new Error("connection failed: super-secret-password"); } },
      credentialProvider: {}
    };
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer signed-user-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "initialize" })
    });
    const text = await response.text();
    assert.equal(response.status, 503);
    assert.match(text, /Authentication service unavailable/);
    assert.doesNotMatch(text, /super-secret-password|postgresql:\/\//);
  }));
});
