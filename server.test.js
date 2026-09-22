import test from "node:test";
import assert from "node:assert/strict";
import { app, safeFileName, tools } from "./server.js";

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
});
