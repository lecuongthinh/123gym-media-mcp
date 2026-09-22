import test from "node:test";
import assert from "node:assert/strict";
import { app, buildSocialPostBody, safeFileName, tools } from "./server.js";

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

test("MCP tools/list exposes the file-aware upload schema", async (t) => {
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.result.tools[0].name, "upload_leadconnector_media");
  assert.deepEqual(payload.result.tools[0]._meta["openai/fileParams"], ["file"]);
  assert.equal(payload.result.tools.length, 10);
  assert.ok(payload.result.tools.some((tool) => tool.name === "create_social_post"));
  assert.ok(payload.result.tools.some((tool) => tool.name === "get_social_statistics"));
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
  assert.throws(() => buildSocialPostBody({ summary: "Hello", accountIds: ["a"] }), /userId/);
});

test("scheduled posts require scheduleDate and accounts", () => {
  assert.throws(() => buildSocialPostBody({ status: "scheduled", accountIds: ["a"], userId: "u" }), /scheduleDate/);
  assert.throws(() => buildSocialPostBody({ status: "scheduled", scheduleDate: "2026-09-23T03:00:00Z" }), /accountIds/);
});

test("in-review posts require an approver", () => {
  assert.throws(() => buildSocialPostBody({ status: "in_review", scheduleDate: "2026-09-23T03:00:00Z", accountIds: ["a"], userId: "u" }), /approver/);
});
