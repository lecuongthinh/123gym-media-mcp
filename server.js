import express from "express";

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 10000;
const LC_PRIVATE_TOKEN = process.env.LC_PRIVATE_TOKEN;
const LC_BASE_URL = "https://services.leadconnectorhq.com";
const DEFAULT_LOCATION_ID = "pUePVc6UKEUecvZS6EYU";
const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const VIDEO_MAX_BYTES = 500 * 1024 * 1024;

app.get("/", (req, res) => res.json({ status: "ok", service: "123 GYM Media MCP", version: "2.1.0", mcp: "/mcp" }));
app.get("/health", (req, res) => res.json({ status: "healthy", version: "2.1.0", tokenConfigured: Boolean(LC_PRIVATE_TOKEN) }));

function checkToken() {
  if (!LC_PRIVATE_TOKEN) throw new Error("LC_PRIVATE_TOKEN is not configured.");
}

async function parseResponse(response) {
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`LeadConnector API failed (${response.status}): ${text}`);
  return data;
}

function lcHeaders() {
  return { Authorization: `Bearer ${LC_PRIVATE_TOKEN}`, Version: "2021-07-28", Accept: "application/json" };
}

function safeFileName(name, mimeType = "") {
  const fallbackExt = mimeType.startsWith("image/") ? mimeType.split("/")[1].replace("jpeg", "jpg") : "bin";
  const fallback = `chatgpt-media-${Date.now()}.${fallbackExt}`;
  const cleaned = String(name || fallback).split(/[\\/]/).pop().replace(/[\r\n\0]/g, "").trim();
  return cleaned || fallback;
}

function maxBytesFor(mimeType) {
  return mimeType?.startsWith("video/") ? VIDEO_MAX_BYTES : IMAGE_MAX_BYTES;
}

async function downloadChatGPTFile(file) {
  if (!file?.download_url || !file?.file_id) {
    throw new Error("file must include download_url and file_id supplied by ChatGPT.");
  }
  const response = await fetch(file.download_url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Unable to download the ChatGPT file (${response.status}).`);
  const mimeType = (file.mime_type || response.headers.get("content-type") || "application/octet-stream").split(";")[0];
  if (!mimeType.startsWith("image/") && !mimeType.startsWith("video/")) {
    throw new Error(`Unsupported media type: ${mimeType}. Only images and videos are accepted.`);
  }
  const contentLength = Number(response.headers.get("content-length") || 0);
  const maxBytes = maxBytesFor(mimeType);
  if (contentLength > maxBytes) throw new Error(`File is too large. Maximum is ${maxBytes / 1024 / 1024} MB for ${mimeType.startsWith("video/") ? "videos" : "images"}.`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > maxBytes) throw new Error(`File is too large. Maximum is ${maxBytes / 1024 / 1024} MB.`);
  return { bytes, mimeType, fileName: safeFileName(file.file_name, mimeType), fileId: file.file_id };
}

async function uploadMedia(args) {
  checkToken();
  const { file, fileUrl, fileName, parentId } = args;
  if (!file && !fileUrl) throw new Error("Provide either file (from ChatGPT or Media Library) or fileUrl.");
  if (file && fileUrl) throw new Error("Provide only one source: file or fileUrl.");

  const body = new FormData();
  let source;
  if (file) {
    const downloaded = await downloadChatGPTFile(file);
    body.append("hosted", "false");
    body.append("file", new Blob([downloaded.bytes], { type: downloaded.mimeType }), safeFileName(fileName || downloaded.fileName, downloaded.mimeType));
    source = { type: "chatgpt_file", fileId: downloaded.fileId };
  } else {
    let parsed;
    try { parsed = new URL(fileUrl); } catch { throw new Error("fileUrl must be a valid HTTPS URL."); }
    if (parsed.protocol !== "https:") throw new Error("fileUrl must use HTTPS.");
    body.append("hosted", "true");
    body.append("fileUrl", fileUrl);
    if (fileName) body.append("name", safeFileName(fileName));
    source = { type: "public_url" };
  }
  if (parentId) body.append("parentId", parentId);

  const response = await fetch(`${LC_BASE_URL}/medias/upload-file`, {
    method: "POST",
    headers: { Authorization: `Bearer ${LC_PRIVATE_TOKEN}`, Version: "2021-07-28" },
    body
  });
  return { ...(await parseResponse(response)), source };
}

async function listMedia(args = {}) {
  checkToken();
  const { locationId = DEFAULT_LOCATION_ID, search = "", mediaType = "all", limit = 50, offset = 0 } = args;
  const params = new URLSearchParams({ altId: locationId, altType: "location", sortBy: "createdAt", sortOrder: "desc", type: "file", limit: String(Math.min(Number(limit) || 50, 100)), offset: String(Number(offset) || 0) });
  const data = await parseResponse(await fetch(`${LC_BASE_URL}/medias/files?${params}`, { method: "GET", headers: lcHeaders() }));
  let files = data.files || data.data?.files || [];
  if (search) {
    const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
    files = files.filter((file) => terms.some((term) => [file.name, file.searchKey, file.contentType, file.category, file.subCategory].filter(Boolean).join(" ").toLowerCase().includes(term)));
  }
  if (mediaType === "image") files = files.filter((file) => file.contentType?.startsWith("image/"));
  if (mediaType === "video") files = files.filter((file) => file.contentType?.startsWith("video/"));
  return { count: files.length, files: files.map((file) => ({ id: file._id, name: file.name, contentType: file.contentType, url: file.url, width: file.width, height: file.height, size: file.size, createdAt: file.createdAt, thumbnailUrl: file.thumbnail?.url || null, previewUrl: file.preview?.url || null, category: file.category || null, subCategory: file.subCategory || null })) };
}

async function inspectMedia(args) {
  const { url, thumbnailUrl, name = "media" } = args;
  const mediaUrl = thumbnailUrl || url;
  if (!mediaUrl) throw new Error("url or thumbnailUrl is required.");
  const response = await fetch(mediaUrl);
  if (!response.ok) throw new Error(`Unable to fetch media (${response.status}).`);
  const contentType = response.headers.get("content-type") || "image/jpeg";
  if (!contentType.startsWith("image/")) throw new Error("inspect_media requires an image or video thumbnail URL.");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > 8 * 1024 * 1024) throw new Error("Image is larger than 8 MB. Use a thumbnail or smaller preview image.");
  return { name, mimeType: contentType.split(";")[0], base64: buffer.toString("base64"), sourceUrl: mediaUrl };
}

const openAIFileSchema = {
  type: "object",
  properties: {
    download_url: { type: "string" },
    file_id: { type: "string" },
    mime_type: { type: "string" },
    file_name: { type: "string" }
  },
  required: ["download_url", "file_id"],
  additionalProperties: false
};

const tools = [
  {
    name: "upload_leadconnector_media",
    title: "Upload media to LeadConnector",
    description: "Upload an image or video from the current ChatGPT conversation, generated images, ChatGPT Media Library, or import a public HTTPS URL into LeadConnector Media Library. Prefer file for ChatGPT-generated and Library media.",
    inputSchema: {
      type: "object",
      properties: {
        file: openAIFileSchema,
        fileUrl: { type: "string", description: "Optional public HTTPS image/video URL. Use only when no ChatGPT file is available." },
        fileName: { type: "string", description: "Optional destination filename." },
        parentId: { type: "string", description: "Optional LeadConnector destination folder ID." }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    _meta: { "openai/fileParams": ["file"], "openai/toolInvocation/invoking": "Uploading media…", "openai/toolInvocation/invoked": "Media uploaded" }
  },
  {
    name: "search_leadconnector_media",
    description: "Search and list media from the 123 GYM LeadConnector Media Library.",
    inputSchema: { type: "object", properties: { search: { type: "string" }, mediaType: { type: "string", enum: ["all", "image", "video"] }, limit: { type: "integer", minimum: 1, maximum: 100 }, offset: { type: "integer", minimum: 0 }, locationId: { type: "string" } } },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "inspect_media",
    description: "Visually inspect an image from LeadConnector Media Library. For videos, pass thumbnailUrl.",
    inputSchema: { type: "object", properties: { url: { type: "string" }, thumbnailUrl: { type: "string" }, name: { type: "string" } } },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
  }
];

app.post("/mcp", async (req, res) => {
  const request = req.body || {};
  const id = request.id ?? null;
  try {
    if (request.method === "initialize") return res.json({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "123gym-media-mcp", version: "2.1.0" } } });
    if (request.method === "notifications/initialized") return res.status(202).end();
    if (request.method === "tools/list") return res.json({ jsonrpc: "2.0", id, result: { tools } });
    if (request.method === "tools/call") {
      const toolName = request.params?.name;
      const args = request.params?.arguments || {};
      if (toolName === "upload_leadconnector_media") {
        const result = await uploadMedia(args);
        return res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Uploaded to LeadConnector: ${result.url || result.fileId || "success"}` }], structuredContent: result } });
      }
      if (toolName === "search_leadconnector_media") {
        const result = await listMedia(args);
        return res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } });
      }
      if (toolName === "inspect_media") {
        const result = await inspectMedia(args);
        return res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Media: ${result.name}\nSource: ${result.sourceUrl}` }, { type: "image", data: result.base64, mimeType: result.mimeType }] } });
      }
      throw new Error(`Unknown tool: ${toolName}`);
    }
    return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${request.method}` } });
  } catch (error) {
    return res.json({ jsonrpc: "2.0", id, error: { code: -32000, message: error.message } });
  }
});

const isMainModule = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMainModule) app.listen(PORT, "0.0.0.0", () => console.log(`123 GYM Media MCP v2.1 listening on port ${PORT}`));

export { app, downloadChatGPTFile, safeFileName, tools };
