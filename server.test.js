import test from "node:test";
import assert from "node:assert/strict";
import {
  app,
  buildSocialPostBody,
  getSocialStatistics,
  isEligible123GymAccount,
  listMedia,
  listSocialAccounts,
  resolveTenant,
  safeFileName,
  tools,
  uploadMedia,
  validateLocationBinding
} from "./server.js";

const GYM_LOCATION = "pUePVc6UKEUecvZS6EYU";
const TEST_LOCATION = "UwsfBVLmz7XSKJbhuOTS";
const TEST_TENANT_ID = "00000000-0000-4000-8000-000000000124";
const TEST_ACCOUNT_ID = "68c83389c2ef4245a387b54f_UwsfBVLmz7XSKJbhuOTS_112256467241215_page";
const TEST_REGISTRY = JSON.stringify({
  [GYM_LOCATION]: { name: "123 GYM", tokenEnv: "LC_PRIVATE_TOKEN" },
  [TEST_LOCATION]: { name: "Testing Agency", tokenEnv: "LC_PRIVATE_TOKEN_TESTING_AGENCY" }
});

function tenantEnv(overrides = {}) {
  return {
    LC_TENANTS_JSON: TEST_REGISTRY,
    LC_PRIVATE_TOKEN: "gym-secret-token",
    LC_PRIVATE_TOKEN_TESTING_AGENCY: "testing-secret-token",
    DEFAULT_LOCATION_ID: GYM_LOCATION,
    ...overrides
  };
}

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

async function withMockFetch(mock, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

async function withTestServer(fn) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally {
    delete app.locals.auth0Verifier;
    delete app.locals.tenantServices;
    await new Promise((resolve) => server.close(resolve));
  }
}

function draftDebugEnv(overrides = {}) {
  return {
    MCP_DEBUG_TEST_DRAFT_WITHOUT_USERID: "true",
    RENDER_SERVICE_ID: "srv-dapsmt5g1s2s73d9sp7g",
    RENDER_EXTERNAL_HOSTNAME: "uplifting-social-ai-staging.onrender.com",
    RENDER_GIT_BRANCH: "feature/oauth-multitenant-v1",
    AUTH0_ISSUER_BASE_URL: "https://uplifting-test.auth0.com/",
    AUTH0_AUDIENCE: "https://uplifting-social-ai-staging.onrender.com",
    MCP_RESOURCE_URL: "https://uplifting-social-ai-staging.onrender.com",
    ...overrides
  };
}

function draftTestServices(credentialLocationId = TEST_LOCATION) {
  const connection = {
    tenant_id: TEST_TENANT_ID,
    tenant_name: "Testing Agency",
    connection_id: "testing-agency-connection",
    location_id: TEST_LOCATION,
    auth_type: "private_integration_token",
    credential_type: "private_integration_token",
    secret_backend: "environment",
    secret_ref: "env://LC_PRIVATE_TOKEN_TESTING_AGENCY"
  };
  return {
    repository: {
      async resolveUserAuthorization() {
        return {
          id: "testing-user",
          auth_subject: "auth0|testing-user",
          email: "tester@example.com",
          membership_id: "testing-membership",
          role: "tenant_admin",
          tenant_id: TEST_TENANT_ID,
          tenant_name: "Testing Agency"
        };
      },
      async findActiveConnectionByTenantId(tenantId) {
        assert.equal(tenantId, TEST_TENANT_ID);
        return connection;
      }
    },
    credentialProvider: {
      async getAccess(receivedConnection) {
        assert.equal(receivedConnection, connection);
        return { accessToken: "testing-agency-access-token", locationId: credentialLocationId };
      }
    }
  };
}

test("upload tool declares a valid ChatGPT file parameter", () => {
  const upload = tools.find((tool) => tool.name === "upload_leadconnector_media");
  assert.deepEqual(upload._meta["openai/fileParams"], ["file"]);
  assert.deepEqual(upload.inputSchema.properties.file.required, ["download_url", "file_id"]);
  assert.ok(upload.inputSchema.properties.file.properties.mime_type);
  assert.ok(upload.inputSchema.properties.file.properties.file_name);
});

test("safeFileName strips paths and control characters", () => {
  assert.equal(safeFileName("../folder/my\nimage.png", "image/png"), "myimage.png");
});

test("MCP rejects requests when OAuth and legacy admin authentication are unavailable", async () => {
  await withProcessEnv({ MCP_ADMIN_API_KEY: undefined, ENABLE_LEGACY_ADMIN_AUTH: undefined, AUTH0_ISSUER_BASE_URL: undefined, AUTH0_AUDIENCE: undefined, MCP_RESOURCE_URL: undefined }, () => withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 101, method: "initialize" })
    });
    const payload = await response.json();
    assert.equal(response.status, 401);
    assert.equal(payload.error.message, "OAuth authentication required.");
  }));
});

test("MCP rejects missing and incorrect admin keys before tool handling", async () => {
  await withProcessEnv({ MCP_ADMIN_API_KEY: "correct-admin-secret", ENABLE_LEGACY_ADMIN_AUTH: "true" }, () => withTestServer(async (baseUrl) => {
    for (const headers of [
      { "content-type": "application/json" },
      { "content-type": "application/json", "x-api-key": "wrong-admin-secret" }
    ]) {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 102, method: "tools/call", params: { name: "tool-that-must-not-run", arguments: {} } })
      });
      const text = await response.text();
      assert.equal(response.status, 401);
      assert.match(text, /OAuth authentication required/);
      assert.doesNotMatch(text, /correct-admin-secret|wrong-admin-secret|tool-that-must-not-run/);
    }
  }));
});

test("legacy admin key is opt-in, x-api-key only, and not accepted as OAuth Bearer", async () => {
  await withProcessEnv({ MCP_ADMIN_API_KEY: "correct-admin-secret", ENABLE_LEGACY_ADMIN_AUTH: "true" }, () => withTestServer(async (baseUrl) => {
    const accepted = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "correct-admin-secret" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 103, method: "initialize" })
    });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).result.serverInfo.version, "3.3.0");

    const rejected = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer correct-admin-secret" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 104, method: "initialize" })
    });
    assert.equal(rejected.status, 401);
  }));
});

test("health response contains no authentication or tenant secrets", async () => {
  await withProcessEnv({ MCP_ADMIN_API_KEY: "health-admin-secret", ENABLE_LEGACY_ADMIN_AUTH: "true", LC_TENANTS_JSON: TEST_REGISTRY, LC_PRIVATE_TOKEN: "health-tenant-secret" }, () => withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.doesNotMatch(text, /health-admin-secret|health-tenant-secret|LC_TENANTS_JSON|LC_PRIVATE_TOKEN/);
    assert.deepEqual(JSON.parse(text), { status: "healthy", version: "3.3.0" });
  }));
});

test("tool schema debug endpoint is disabled by default", async () => {
  await withProcessEnv({
    MCP_DEBUG_TOOL_SCHEMA: undefined,
    RENDER_SERVICE_ID: "srv-dapsmt5g1s2s73d9sp7g",
    RENDER_EXTERNAL_HOSTNAME: "uplifting-social-ai-staging.onrender.com",
    RENDER_GIT_BRANCH: "feature/oauth-multitenant-v1"
  }, () => withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/debug/tool-schema`);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "");
  }));
});

test("tool schema debug endpoint returns absent required on staging", async () => {
  await withProcessEnv({
    MCP_DEBUG_TOOL_SCHEMA: "true",
    RENDER_SERVICE_ID: "srv-dapsmt5g1s2s73d9sp7g",
    RENDER_EXTERNAL_HOSTNAME: "uplifting-social-ai-staging.onrender.com",
    RENDER_GIT_BRANCH: "feature/oauth-multitenant-v1"
  }, () => withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/debug/tool-schema`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { requiredPresent: false });
    assert.equal(response.headers.get("cache-control"), "no-store");
  }));
});

test("tool schema debug endpoint rejects a different service ID", async () => {
  await withProcessEnv({
    MCP_DEBUG_TOOL_SCHEMA: "true",
    RENDER_SERVICE_ID: "srv-other-service",
    RENDER_EXTERNAL_HOSTNAME: "uplifting-social-ai-staging.onrender.com",
    RENDER_GIT_BRANCH: "feature/oauth-multitenant-v1"
  }, () => withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/debug/tool-schema`);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "");
  }));
});

test("draft diagnostic endpoint is disabled by default", async () => {
  let outboundCreateCount = 0;
  const realFetch = globalThis.fetch;
  await withProcessEnv(draftDebugEnv({ MCP_DEBUG_TEST_DRAFT_WITHOUT_USERID: undefined }), () => withMockFetch(async (url, options) => {
    if (String(url).startsWith("https://services.leadconnectorhq.com/")) outboundCreateCount += 1;
    return realFetch(url, options);
  }, () => withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/debug/test-draft-without-userid`, { method: "POST" });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(outboundCreateCount, 0);
  })));
});

test("draft diagnostic endpoint fails closed on a wrong Render service", async () => {
  let outboundCreateCount = 0;
  const realFetch = globalThis.fetch;
  await withProcessEnv(draftDebugEnv({ RENDER_SERVICE_ID: "srv-not-staging" }), () => withMockFetch(async (url, options) => {
    if (String(url).startsWith("https://services.leadconnectorhq.com/")) outboundCreateCount += 1;
    return realFetch(url, options);
  }, () => withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/debug/test-draft-without-userid`, { method: "POST" });
    assert.equal(response.status, 404);
    assert.equal(outboundCreateCount, 0);
  })));
});

test("draft diagnostic endpoint fails closed on credential location mismatch", async () => {
  let outboundCreateCount = 0;
  const realFetch = globalThis.fetch;
  await withProcessEnv(draftDebugEnv(), () => withMockFetch(async (url, options) => {
    if (String(url).startsWith("https://services.leadconnectorhq.com/")) outboundCreateCount += 1;
    return realFetch(url, options);
  }, () => withTestServer(async (baseUrl) => {
    app.locals.auth0Verifier = async () => ({
      subject: "auth0|testing-user",
      tenantIdClaim: TEST_TENANT_ID,
      scopes: new Set(["uplifting:write"])
    });
    app.locals.tenantServices = draftTestServices("wrong-staging-location");
    const response = await fetch(`${baseUrl}/debug/test-draft-without-userid`, {
      method: "POST",
      headers: { authorization: "Bearer signed-user-token" }
    });
    assert.equal(response.status, 412);
    assert.deepEqual(await response.json(), { error: "testing_agency_credential_precondition_failed" });
    assert.equal(outboundCreateCount, 0);
  })));
});

test("draft diagnostic sends one fixed request and is one-shot per process", async () => {
  let outboundCreateCount = 0;
  const realFetch = globalThis.fetch;
  await withProcessEnv(draftDebugEnv(), () => withMockFetch(async (url, options) => {
    if (!String(url).startsWith("https://services.leadconnectorhq.com/")) return realFetch(url, options);
    outboundCreateCount += 1;
    assert.equal(String(url), `https://services.leadconnectorhq.com/social-media-posting/${TEST_LOCATION}/posts`);
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Version, "v3");
    assert.equal(options.headers.Authorization, "Bearer testing-agency-access-token");
    const body = JSON.parse(options.body);
    assert.deepEqual(body, {
      accountIds: [TEST_ACCOUNT_ID],
      summary: "[STAGING TEST] Kiểm tra tạo bài nháp không cần userId. Không xuất bản.",
      status: "draft",
      type: "post"
    });
    assert.equal(Object.hasOwn(body, "userId"), false);
    assert.equal(Object.hasOwn(body, "scheduleDate"), false);
    assert.equal(Object.hasOwn(body, "postApprovalDetails"), false);
    return new Response(JSON.stringify({
      _id: "staging-draft-id",
      status: "draft",
      access_token: "must-not-be-returned",
      message: "testing-agency-access-token"
    }), { status: 201 });
  }, () => withTestServer(async (baseUrl) => {
    app.locals.auth0Verifier = async () => ({
      subject: "auth0|testing-user",
      tenantIdClaim: TEST_TENANT_ID,
      scopes: new Set(["uplifting:write"])
    });
    app.locals.tenantServices = draftTestServices();
    const request = () => fetch(`${baseUrl}/debug/test-draft-without-userid`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer signed-user-token" },
      body: JSON.stringify({ userId: "ignored", scheduleDate: "ignored", postApprovalDetails: { ignored: true } })
    });

    const first = await request();
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("cache-control"), "no-store");
    assert.deepEqual(await first.json(), {
      highLevelHttpStatus: 201,
      response: { _id: "staging-draft-id", status: "draft", message: "[REDACTED]" },
      postId: "staging-draft-id",
      status: "draft"
    });
    assert.equal(outboundCreateCount, 1);

    const second = await request();
    assert.equal(second.status, 409);
    assert.deepEqual(await second.json(), { error: "draft_diagnostic_already_attempted" });
    assert.equal(outboundCreateCount, 1);
  })));
});

test("MCP tools/list exposes the file-aware upload schema", async (t) => {
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  const response = await withProcessEnv({ MCP_ADMIN_API_KEY: "schema-test-admin-key", ENABLE_LEGACY_ADMIN_AUTH: "true" }, () => fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "schema-test-admin-key" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  }));
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.result.tools[0].name, "upload_leadconnector_media");
  assert.deepEqual(payload.result.tools[0]._meta["openai/fileParams"], ["file"]);
  assert.equal(payload.result.tools[0].inputSchema.properties.locationId.type, "string");
  assert.equal(payload.result.tools.length, 10);
  assert.ok(payload.result.tools.some((tool) => tool.name === "create_social_post"));
  assert.ok(payload.result.tools.some((tool) => tool.name === "get_social_statistics"));
  assert.deepEqual(payload.result.tools.find((tool) => tool.name === "list_social_accounts").securitySchemes, [{ type: "oauth2", scopes: ["uplifting:read"] }]);
  const create = payload.result.tools.find((tool) => tool.name === "create_social_post");
  assert.equal(create.inputSchema.required?.includes("userId") ?? false, false);
  assert.equal(create.inputSchema.properties.splitByPlatform.type, "boolean");
});

test("brand account rules keep only eligible 123 GYM Facebook and Google accounts", () => {
  const base = { id: "x", active: true, isExpired: false, deleted: false, platform: "facebook", name: "123 GYM Fitness & Yoga Center" };
  assert.equal(isEligible123GymAccount(base), true);
  assert.equal(isEligible123GymAccount({ ...base, platform: "google", name: "123 GYM 97 Bạch Đằng" }), true);
  assert.equal(isEligible123GymAccount({ ...base, name: "123 GYM 56 Tô Hiệu" }), false);
  assert.equal(isEligible123GymAccount({ ...base, name: "123 Gym Tuyển dụng" }), false);
  assert.equal(isEligible123GymAccount({ ...base, name: "Balance Fit" }), false);
  assert.equal(isEligible123GymAccount({ ...base, name: "La Charme Health Club" }), true);
  assert.equal(isEligible123GymAccount({ ...base, platform: "instagram" }), false);
});

test("social posts default to a safe draft", () => {
  assert.deepEqual(buildSocialPostBody({ summary: "Hello", accountIds: ["a"], userId: "u" }), {
    summary: "Hello",
    accountIds: ["a"],
    userId: "u",
    status: "draft",
    type: "post"
  });
  assert.throws(() => buildSocialPostBody({ summary: "Hello" }), /accountIds/);
  assert.deepEqual(buildSocialPostBody({ summary: "Hello", accountIds: ["a"], status: "draft" }), {
    summary: "Hello",
    accountIds: ["a"],
    status: "draft",
    type: "post"
  });
});

test("non-draft social posts still require userId", () => {
  assert.throws(() => buildSocialPostBody({ status: "published", accountIds: ["a"] }), /userId/);
});

test("scheduled posts require scheduleDate and accounts", () => {
  assert.throws(() => buildSocialPostBody({ status: "scheduled", accountIds: ["a"], userId: "u" }), /scheduleDate/);
  assert.throws(() => buildSocialPostBody({ status: "scheduled", scheduleDate: "2026-09-23T03:00:00Z" }), /accountIds/);
});

test("in-review posts require an approver", () => {
  assert.throws(() => buildSocialPostBody({ status: "in_review", scheduleDate: "2026-09-23T03:00:00Z", accountIds: ["a"], userId: "u" }), /approver/);
});

test("tenant resolver preserves the 123 GYM legacy credential", () => {
  const tenant = resolveTenant(undefined, tenantEnv());
  assert.deepEqual(tenant, {
    locationId: GYM_LOCATION,
    name: "123 GYM",
    tokenEnv: "LC_PRIVATE_TOKEN",
    token: "gym-secret-token"
  });
});

test("tenant resolver selects the Testing Agency credential", () => {
  const tenant = resolveTenant(TEST_LOCATION, tenantEnv());
  assert.equal(tenant.locationId, TEST_LOCATION);
  assert.equal(tenant.tokenEnv, "LC_PRIVATE_TOKEN_TESTING_AGENCY");
  assert.equal(tenant.token, "testing-secret-token");
});

test("tenant resolver rejects unknown tenants without legacy fallback", () => {
  assert.throws(() => resolveTenant("unknown-location", tenantEnv()), /Unknown or unauthorized locationId/);
});

test("tenant resolver fails closed when the selected token is missing", () => {
  assert.throws(() => resolveTenant(TEST_LOCATION, tenantEnv({ LC_PRIVATE_TOKEN_TESTING_AGENCY: undefined })), /credential is not configured for tenant Testing Agency/);
});

test("media upload uses the selected tenant token and returns its location", async () => {
  await withProcessEnv(tenantEnv(), async () => {
    await withMockFetch(async (url, options) => {
      assert.equal(url, "https://services.leadconnectorhq.com/medias/upload-file");
      assert.equal(options.headers.Authorization, "Bearer testing-secret-token");
      assert.equal(options.method, "POST");
      assert.equal(options.body.get("hosted"), "true");
      assert.equal(options.body.get("fileUrl"), "https://example.com/test.png");
      return new Response(JSON.stringify({ success: true, url: "https://cdn.example/test.png" }), { status: 200, headers: { "content-type": "application/json" } });
    }, async () => {
      const result = await uploadMedia({ locationId: TEST_LOCATION, fileUrl: "https://example.com/test.png" });
      assert.equal(result.locationId, TEST_LOCATION);
      assert.equal(result.tenant, "Testing Agency");
    });
  });
});

test("media listing binds altId and Authorization to the same tenant", async () => {
  await withProcessEnv(tenantEnv(), async () => {
    await withMockFetch(async (url, options) => {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("altId"), TEST_LOCATION);
      assert.equal(options.headers.Authorization, "Bearer testing-secret-token");
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }, async () => {
      const result = await listMedia({ locationId: TEST_LOCATION });
      assert.equal(result.count, 0);
    });
  });
});

test("social account discovery uses the token matching the URL location", async () => {
  await withProcessEnv(tenantEnv(), async () => {
    await withMockFetch(async (url, options) => {
      assert.equal(url, `https://services.leadconnectorhq.com/social-media-posting/${TEST_LOCATION}/accounts`);
      assert.equal(options.headers.Authorization, "Bearer testing-secret-token");
      return new Response(JSON.stringify({ success: true, results: { accounts: [] } }), { status: 200 });
    }, async () => {
      await listSocialAccounts({ locationId: TEST_LOCATION });
    });
  });
});

test("statistics binds query location and credential to the selected tenant", async () => {
  await withProcessEnv(tenantEnv(), async () => {
    await withMockFetch(async (url, options) => {
      const parsed = new URL(url);
      assert.equal(parsed.pathname, "/social-media-posting/statistics");
      assert.equal(parsed.searchParams.get("locationId"), TEST_LOCATION);
      assert.equal(options.headers.Authorization, "Bearer testing-secret-token");
      return new Response(JSON.stringify({ success: true, results: {} }), { status: 200 });
    }, async () => {
      await getSocialStatistics({ locationId: TEST_LOCATION, profileIds: ["profile-1"] });
    });
  });
});

test("cross-tenant URL and query bindings are blocked", () => {
  assert.throws(() => validateLocationBinding(`/social-media-posting/${TEST_LOCATION}/accounts`, GYM_LOCATION), /Cross-tenant/);
  assert.throws(() => validateLocationBinding(`/medias/files?altId=${TEST_LOCATION}`, GYM_LOCATION), /Cross-tenant/);
  assert.throws(() => validateLocationBinding(`/social-media-posting/statistics?locationId=${GYM_LOCATION}`, TEST_LOCATION), /Cross-tenant/);
});

test("upstream errors redact tenant tokens and Authorization values", async () => {
  await withProcessEnv(tenantEnv(), async () => {
    await withMockFetch(async () => new Response(JSON.stringify({ message: "Bearer exposed-header testing-secret-token" }), { status: 401 }), async () => {
      await assert.rejects(() => listSocialAccounts({ locationId: TEST_LOCATION }), (error) => {
        assert.doesNotMatch(error.message, /testing-secret-token|exposed-header/);
        assert.match(error.message, /Bearer \[REDACTED\]/);
        return true;
      });
    });
  });
});
