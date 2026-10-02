import test from "node:test";
import assert from "node:assert/strict";
import {
  app,
  buildSocialPostBody,
  createSocialPost,
  enforcePostLimit,
  enforceUserLimit,
  getSocialStatistics,
  isEligible123GymAccount,
  listLocationUsers,
  listMedia,
  listSocialAccounts,
  listSocialCategories,
  listSocialTags,
  resetRateLimitStateForTests,
  resolveTenant,
  safeFileName,
  tools,
  uploadMedia,
  validateLocationBinding
} from "./server.js";
import { createTenantServices } from "./src/tenant-services.js";

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

test("upload tool declares a valid ChatGPT file parameter", () => {
  const upload = tools.find((tool) => tool.name === "upload_media");
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
    assert.equal((await accepted.json()).result.serverInfo.version, "3.13.1");

    const rejected = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer correct-admin-secret" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 104, method: "initialize" })
    });
    assert.equal(rejected.status, 401);
  }));
});

test("initialize gives the model process instructions, including the media-library disambiguation and a platform-disclosure refusal", async () => {
  await withProcessEnv({ MCP_ADMIN_API_KEY: "instructions-admin-secret", ENABLE_LEGACY_ADMIN_AUTH: "true" }, () => withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "instructions-admin-secret" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 105, method: "initialize" })
    });
    const payload = await response.json();
    assert.match(payload.result.instructions, /search_media_library/);
    assert.match(payload.result.instructions, /ChatGPT's own uploaded files/);
    assert.match(payload.result.instructions, /connect_social_account/);
    // A live test asked ChatGPT "social planner của hệ thống gì?" and it
    // named HighLevel/GHL from its own background knowledge -- renaming our
    // own strings can't prevent that, only an explicit refusal rule can.
    assert.match(payload.result.instructions, /never name or guess at a third-party platform/);
  }));
});

test("health response contains no authentication or tenant secrets", async () => {
  await withProcessEnv({ MCP_ADMIN_API_KEY: "health-admin-secret", ENABLE_LEGACY_ADMIN_AUTH: "true", LC_TENANTS_JSON: TEST_REGISTRY, LC_PRIVATE_TOKEN: "health-tenant-secret" }, () => withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.doesNotMatch(text, /health-admin-secret|health-tenant-secret|LC_TENANTS_JSON|LC_PRIVATE_TOKEN/);
    assert.deepEqual(JSON.parse(text), { status: "healthy", version: "3.13.1" });
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
  assert.equal(payload.result.tools[0].name, "upload_media");
  assert.deepEqual(payload.result.tools[0]._meta["openai/fileParams"], ["file"]);
  assert.equal(payload.result.tools[0].inputSchema.properties.locationId.type, "string");
  assert.equal(payload.result.tools.length, 15);
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
});

test("drafts require userId too, because HighLevel rejects userId-less posts regardless of status", () => {
  assert.throws(() => buildSocialPostBody({ summary: "Hello", accountIds: ["a"], status: "draft" }), /userId/);
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
  assert.throws(() => resolveTenant(TEST_LOCATION, tenantEnv({ LC_PRIVATE_TOKEN_TESTING_AGENCY: undefined })), /Credential is not configured for tenant Testing Agency/);
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

test("media listing passes folderId and search through to the upstream API as parentId/query, and reports each file's folderId", async () => {
  await withProcessEnv(tenantEnv(), async () => {
    await withMockFetch(async (url) => {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("parentId"), "folder-123");
      assert.equal(parsed.searchParams.get("query"), "logo");
      return new Response(JSON.stringify({ files: [
        { _id: "file-1", name: "logo.png", contentType: "image/png", parentId: "folder-123" }
      ] }), { status: 200 });
    }, async () => {
      const result = await listMedia({ locationId: TEST_LOCATION, folderId: "folder-123", search: "logo" });
      assert.equal(result.count, 1);
      assert.equal(result.files[0].folderId, "folder-123");
    });
  });
});

test("media listing can list folders themselves by passing type: folder", async () => {
  await withProcessEnv(tenantEnv(), async () => {
    await withMockFetch(async (url) => {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("type"), "folder");
      return new Response(JSON.stringify({ files: [{ _id: "folder-123", name: "Tháng 10" }] }), { status: 200 });
    }, async () => {
      const result = await listMedia({ locationId: TEST_LOCATION, type: "folder", search: "Tháng 10" });
      assert.equal(result.files[0].id, "folder-123");
    });
  });
});

test("list_location_users binds locationId and token to the selected tenant, and flags admin/owner candidates", async () => {
  await withProcessEnv(tenantEnv(), async () => {
    await withMockFetch(async (url, options) => {
      const parsed = new URL(url);
      assert.equal(parsed.pathname, "/users/");
      assert.equal(parsed.searchParams.get("locationId"), TEST_LOCATION);
      assert.equal(options.headers.Authorization, "Bearer testing-secret-token");
      return new Response(JSON.stringify({ users: [
        { id: "user-1", firstName: "An", lastName: "Nguyen", email: "an@example.com", roles: { role: "admin", type: "account" } },
        { id: "user-2", firstName: "Binh", lastName: "Tran", email: "binh@example.com", roles: { role: "user", type: "account" } }
      ] }), { status: 200 });
    }, async () => {
      const result = await listLocationUsers({ locationId: TEST_LOCATION });
      assert.equal(result.count, 2);
      assert.deepEqual(result.users[0], { id: "user-1", name: "An Nguyen", email: "an@example.com", role: "admin", type: "account", isDefaultUserIdCandidate: true });
      assert.equal(result.users[1].isDefaultUserIdCandidate, false);
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

test("list_social_categories resolves names to the real HighLevel ids, so create_social_post is never called with a guessed categoryId", async () => {
  await withProcessEnv(tenantEnv(), async () => {
    await withMockFetch(async (url) => {
      const parsed = new URL(url);
      assert.equal(parsed.pathname, `/social-media-posting/${TEST_LOCATION}/categories`);
      assert.equal(parsed.searchParams.get("searchText"), "Khuyến mãi");
      return new Response(JSON.stringify({ success: true, results: { categories: [
        { _id: "cat-1", name: "Khuyến mãi", primaryColor: "#fff", locationId: TEST_LOCATION }
      ] } }), { status: 200 });
    }, async () => {
      const result = await listSocialCategories({ locationId: TEST_LOCATION, search: "Khuyến mãi" });
      assert.deepEqual(result, { count: 1, categories: [{ id: "cat-1", name: "Khuyến mãi" }] });
    });
  });
});

test("list_social_tags resolves names to the real HighLevel ids", async () => {
  await withProcessEnv(tenantEnv(), async () => {
    await withMockFetch(async (url) => {
      const parsed = new URL(url);
      assert.equal(parsed.pathname, `/social-media-posting/${TEST_LOCATION}/tags`);
      return new Response(JSON.stringify({ success: true, results: { tags: [{ _id: "tag-1", name: "gym" }] } }), { status: 200 });
    }, async () => {
      const result = await listSocialTags({ locationId: TEST_LOCATION });
      assert.deepEqual(result, { count: 1, tags: [{ id: "tag-1", name: "gym" }] });
    });
  });
});

test("createSocialPost auto-fills userId from the tenant's default_user_id when the caller omits it", async () => {
  const authorizedContext = {
    locationId: TEST_LOCATION,
    tenantName: "Testing Agency",
    accessToken: "testing-secret-token",
    tenantId: TEST_TENANT_ID,
    connectionId: "testing-agency-connection",
    defaultUserId: "tenant-default-user-id"
  };
  let postsListCalls = 0;
  await withMockFetch(async (url, options) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === `/social-media-posting/${TEST_LOCATION}/accounts`) {
      return new Response(JSON.stringify({ success: true, results: { accounts: [
        { id: TEST_ACCOUNT_ID, platform: "facebook", active: true, isExpired: false, deleted: false }
      ] } }), { status: 200 });
    }
    if (parsed.pathname === `/social-media-posting/${TEST_LOCATION}/posts/list`) {
      postsListCalls += 1;
      if (postsListCalls === 1) return new Response(JSON.stringify({ success: true, results: { posts: [] } }), { status: 200 });
      return new Response(JSON.stringify({ success: true, results: { posts: [
        { _id: "new-post-id", summary: "Hello auto-userid", accountIds: [TEST_ACCOUNT_ID], status: "draft" }
      ] } }), { status: 200 });
    }
    if (parsed.pathname === `/social-media-posting/${TEST_LOCATION}/posts`) {
      const body = JSON.parse(options.body);
      assert.equal(body.userId, "tenant-default-user-id");
      return new Response(JSON.stringify({ success: true, results: { post: { _id: "new-post-id", status: "draft" } } }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${url}`);
  }, async () => {
    const result = await createSocialPost({ locationId: TEST_LOCATION, summary: "Hello auto-userid" }, authorizedContext);
    assert.equal(result.results[0].action, "created");
    assert.equal(result.results[0].verified, true);
  });
});

test("createSocialPost still requires userId when the tenant has no default configured", async () => {
  const authorizedContext = {
    locationId: TEST_LOCATION,
    tenantName: "Testing Agency",
    accessToken: "testing-secret-token",
    tenantId: TEST_TENANT_ID,
    connectionId: "testing-agency-connection",
    defaultUserId: null
  };
  await withMockFetch(async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === `/social-media-posting/${TEST_LOCATION}/accounts`) {
      return new Response(JSON.stringify({ success: true, results: { accounts: [
        { id: TEST_ACCOUNT_ID, platform: "facebook", active: true, isExpired: false, deleted: false }
      ] } }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${url}`);
  }, async () => {
    await assert.rejects(
      () => createSocialPost({ locationId: TEST_LOCATION, summary: "Hello" }, authorizedContext),
      /userId is required/
    );
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

function legacyRepositoryFor(locationId, tenantId, tenantName, tokenEnv, incrementUsage) {
  return {
    async findActiveConnectionByLocationId(requested) {
      if (requested !== locationId) return null;
      return {
        tenant_id: tenantId, tenant_name: tenantName, connection_id: `connection:${tenantId}`,
        location_id: locationId, tenant_status: "active", connection_status: "active",
        secret_backend: "environment", secret_ref: `env://${tokenEnv}`,
        credential_type: "private_integration_token", scopes: ["social:read"], default_user_id: "tenant-default-user-id"
      };
    },
    async findActiveConnectionByTenantId(requested) {
      return requested === tenantId ? this.findActiveConnectionByLocationId(locationId) : null;
    },
    incrementUsage
  };
}

test("create_social_post via /mcp records how many posts were actually created, in the tenant's usage counter", async () => {
  resetRateLimitStateForTests();
  const usageCalls = [];
  const repository = legacyRepositoryFor(TEST_LOCATION, TEST_TENANT_ID, "Testing Agency", "LC_PRIVATE_TOKEN_TESTING_AGENCY", async (call) => { usageCalls.push(call); });
  await withProcessEnv({ MCP_ADMIN_API_KEY: "usage-admin-secret", ENABLE_LEGACY_ADMIN_AUTH: "true", ...tenantEnv() }, async () => {
    app.locals.tenantServices = createTenantServices(process.env, { repository });
    let postsListCalls = 0;
    const realFetch = globalThis.fetch;
    // Both this test's own HTTP call to the local test server AND that
    // server's own outbound call to LeadConnector go through the same
    // process-global fetch, so the mock must pass the local one through
    // untouched and only intercept the upstream LeadConnector paths.
    const upstream = async (url, options) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === `/social-media-posting/${TEST_LOCATION}/accounts`) {
        return new Response(JSON.stringify({ success: true, results: { accounts: [
          { id: TEST_ACCOUNT_ID, platform: "facebook", active: true, isExpired: false, deleted: false }
        ] } }), { status: 200 });
      }
      if (parsed.pathname === `/social-media-posting/${TEST_LOCATION}/posts/list`) {
        postsListCalls += 1;
        if (postsListCalls === 1) return new Response(JSON.stringify({ success: true, results: { posts: [] } }), { status: 200 });
        return new Response(JSON.stringify({ success: true, results: { posts: [
          { _id: "new-post-id", summary: "Hello usage counter", accountIds: [TEST_ACCOUNT_ID], status: "draft" }
        ] } }), { status: 200 });
      }
      if (parsed.pathname === `/social-media-posting/${TEST_LOCATION}/posts`) {
        return new Response(JSON.stringify({ success: true, results: { post: { _id: "new-post-id", status: "draft" } } }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    await withTestServer(async (baseUrl) => {
      globalThis.fetch = (url, options) => (String(url).startsWith(baseUrl) ? realFetch(url, options) : upstream(url, options));
      try {
        const response = await realFetch(`${baseUrl}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": "usage-admin-secret" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_social_post", arguments: { locationId: TEST_LOCATION, summary: "Hello usage counter" } } })
        });
        const payload = await response.json();
        assert.equal(payload.result.structuredContent.results[0].action, "created");
        assert.equal(usageCalls.length, 1);
        assert.equal(usageCalls[0].tenantId, TEST_TENANT_ID);
        assert.equal(usageCalls[0].metric, "posts_created");
        assert.equal(usageCalls[0].by, 1);
        assert.match(usageCalls[0].period, /^\d{4}-\d{2}$/);
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });
});

test("tools/call rate-limits a tenant after too many requests in one minute, independent of what the tool itself does", async () => {
  resetRateLimitStateForTests();
  await withProcessEnv({ MCP_ADMIN_API_KEY: "rate-limit-admin-secret", ENABLE_LEGACY_ADMIN_AUTH: "true", TENANT_RATE_LIMIT_PER_MINUTE: "3", ...tenantEnv() }, () => withTestServer(async (baseUrl) => {
    const call = () => fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "rate-limit-admin-secret" },
      // invite_team_member rejects a legacy_admin caller synchronously,
      // before any tenant lookup or upstream fetch -- no mock needed, and it
      // proves the rate limit is checked regardless of what the tool call
      // itself would have done.
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "invite_team_member", arguments: {} } })
    }).then((response) => response.json());
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await call());
    for (const result of results.slice(0, 3)) assert.notEqual(result.error?.code, -32029);
    assert.equal(results[3].error.code, -32029);
    assert.match(results[3].error.message, /Too many requests/);
  }));
});

function reqWithRepository(repository, overrides = {}) {
  return { principal: { authType: "oauth", tenantId: "tenant-1", plan: "trial", ...overrides }, tenantServices: { repository } };
}

test("enforceUserLimit is a no-op for non-oauth callers, and when the repository/plan has no limit", async () => {
  await enforceUserLimit({ principal: { authType: "legacy_admin" } });
  await enforceUserLimit(reqWithRepository({}));
  await enforceUserLimit(reqWithRepository({ async getPlanLimits() { return {}; }, async countActiveMemberships() { return 999; } }));
});

test("enforceUserLimit rejects inviting past the plan's max_users, and allows it under the limit", async () => {
  const repository = {
    async getPlanLimits() { return { trial: { maxUsers: 3, maxPostsPerMonth: null } }; },
    async countActiveMemberships() { return 3; }
  };
  await assert.rejects(() => enforceUserLimit(reqWithRepository(repository)), /up to 3 team members/);
  repository.countActiveMemberships = async () => 2;
  await enforceUserLimit(reqWithRepository(repository));
});

test("enforcePostLimit is a no-op for non-oauth callers, and when the repository/plan has no limit", async () => {
  await enforcePostLimit({ principal: { authType: "legacy_admin" } });
  await enforcePostLimit(reqWithRepository({}));
  await enforcePostLimit(reqWithRepository({ async getPlanLimits() { return {}; }, async getUsage() { return 999; } }));
});

test("enforcePostLimit rejects creating posts past the plan's max_posts_per_month, and allows it under the limit", async () => {
  const repository = {
    async getPlanLimits() { return { trial: { maxUsers: null, maxPostsPerMonth: 10 } }; },
    async getUsage() { return 10; }
  };
  await assert.rejects(() => enforcePostLimit(reqWithRepository(repository)), /up to 10 AI-created posts per month/);
  repository.getUsage = async () => 9;
  await enforcePostLimit(reqWithRepository(repository));
});

function adminRepositoryFor(overrides = {}) {
  return {
    tenants: [{ id: "tenant-1", display_name: "Acme", plan: "standard", status: "active" }],
    planLimits: { trial: { maxUsers: 3, maxPostsPerMonth: 10 }, standard: { maxUsers: 10, maxPostsPerMonth: 100 }, pro: { maxUsers: null, maxPostsPerMonth: null } },
    async listTenantsForAdmin() { return this.tenants.map((t) => ({ id: t.id, displayName: t.display_name, plan: t.plan, status: t.status, memberCount: 2, postsThisPeriod: 5 })); },
    async getPlanLimits() { return this.planLimits; },
    async setTenantPlan(tenantId, plan) { const t = this.tenants.find((x) => x.id === tenantId); if (t) t.plan = plan; },
    async setPlanLimit({ plan, maxUsers, maxPostsPerMonth }) { this.planLimits[plan] = { maxUsers, maxPostsPerMonth }; },
    ...overrides
  };
}

test("admin panel is disabled (404) unless ADMIN_PANEL_KEY is configured", async () => {
  await withProcessEnv({ ADMIN_PANEL_KEY: undefined }, () => withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin?key=anything`);
    assert.equal(response.status, 404);
  }));
});

test("admin panel rejects a missing or wrong key, and accepts the right one", async () => {
  await withProcessEnv({ ADMIN_PANEL_KEY: "the-real-key" }, () => withTestServer(async (baseUrl) => {
    app.locals.tenantServices = createTenantServices(process.env, { repository: adminRepositoryFor() });
    const noKey = await fetch(`${baseUrl}/admin`);
    assert.equal(noKey.status, 403);
    const wrongKey = await fetch(`${baseUrl}/admin?key=nope`);
    assert.equal(wrongKey.status, 403);
    const rightKey = await fetch(`${baseUrl}/admin?key=the-real-key`);
    assert.equal(rightKey.status, 200);
    const text = await rightKey.text();
    assert.match(text, /Acme/);
    assert.match(text, /Uplifting Social AI -- Admin/);
  }));
});

test("admin panel can change a tenant's plan and a plan's limits, both take effect immediately", async () => {
  await withProcessEnv({ ADMIN_PANEL_KEY: "the-real-key" }, () => withTestServer(async (baseUrl) => {
    const repository = adminRepositoryFor();
    app.locals.tenantServices = createTenantServices(process.env, { repository });

    const planResponse = await fetch(`${baseUrl}/admin/tenants/tenant-1/plan?key=the-real-key`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "plan=pro", redirect: "manual"
    });
    assert.equal(planResponse.status, 302);
    assert.equal(repository.tenants[0].plan, "pro");

    const limitResponse = await fetch(`${baseUrl}/admin/plan-limits/standard?key=the-real-key`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "maxUsers=20&maxPostsPerMonth=", redirect: "manual"
    });
    assert.equal(limitResponse.status, 302);
    assert.deepEqual(repository.planLimits.standard, { maxUsers: 20, maxPostsPerMonth: null });
  }));
});
