import express from "express";

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 10000;
const LC_PRIVATE_TOKEN = process.env.LC_PRIVATE_TOKEN;
const LC_BASE_URL = "https://services.leadconnectorhq.com";
const DEFAULT_LOCATION_ID = "pUePVc6UKEUecvZS6EYU";
const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const VIDEO_MAX_BYTES = 500 * 1024 * 1024;

app.get("/", (req, res) => res.json({ status: "ok", service: "123 GYM Social Media Agent", version: "3.0.0", mcp: "/mcp" }));
app.get("/health", (req, res) => res.json({ status: "healthy", version: "3.0.0", tokenConfigured: Boolean(LC_PRIVATE_TOKEN) }));

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

function socialHeaders() {
  return {
    Authorization: `Bearer ${LC_PRIVATE_TOKEN}`,
    Version: "v3",
    Accept: "application/json",
    "Content-Type": "application/json"
  };
}

async function socialRequest(path, { method = "GET", body } = {}) {
  checkToken();
  const response = await fetch(`${LC_BASE_URL}${path}`, {
    method,
    headers: socialHeaders(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return await parseResponse(response);
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

// --------------------------------------------------
// SOCIAL PLANNER
// --------------------------------------------------

async function listSocialAccounts({ locationId = DEFAULT_LOCATION_ID } = {}) {
  return await socialRequest(`/social-media-posting/${encodeURIComponent(locationId)}/accounts`);
}

async function listSocialPosts(args = {}) {
  const {
    locationId = DEFAULT_LOCATION_ID,
    status = "all",
    accountIds = [],
    skip = 0,
    limit = 10,
    fromDate,
    toDate,
    includeUsers = true,
    postType
  } = args;
  const body = {
    type: status,
    accounts: Array.isArray(accountIds) ? accountIds.join(",") : String(accountIds || ""),
    skip: String(Math.max(0, Number(skip) || 0)),
    limit: String(Math.min(Math.max(1, Number(limit) || 10), 100)),
    includeUsers: String(Boolean(includeUsers))
  };
  if (fromDate) body.fromDate = fromDate;
  if (toDate) body.toDate = toDate;
  if (postType) body.postType = postType;
  return await socialRequest(`/social-media-posting/${encodeURIComponent(locationId)}/posts/list`, { method: "POST", body });
}

async function getSocialPost({ locationId = DEFAULT_LOCATION_ID, postId }) {
  if (!postId) throw new Error("postId is required.");
  return await socialRequest(`/social-media-posting/${encodeURIComponent(locationId)}/posts/${encodeURIComponent(postId)}`);
}

const SOCIAL_POST_FIELDS = [
  "accountIds", "summary", "media", "status", "scheduleDate", "selectedBestTime",
  "createdBy", "followUpComment", "ogTagsDetails", "type", "postApprovalDetails",
  "scheduleTimeUpdated", "tags", "categoryId", "applyWatermark", "tiktokPostDetails",
  "gmbPostDetails", "userId", "linkedinPostDetails", "pinterestPostDetails",
  "facebookPostDetails", "instagramPostDetails", "youtubePostDetails", "communityPostDetails"
];

function buildSocialPostBody(args, { partial = false } = {}) {
  const body = {};
  for (const field of SOCIAL_POST_FIELDS) {
    if (args[field] !== undefined) body[field] = args[field];
  }
  if (!partial) {
    body.status ??= "draft";
    body.type ??= "post";
  }
  const status = body.status;
  if (["scheduled", "in_review"].includes(status) && !body.scheduleDate) {
    throw new Error(`scheduleDate is required when status is ${status}.`);
  }
  if (status && status !== "draft" && (!Array.isArray(body.accountIds) || body.accountIds.length === 0)) {
    throw new Error("accountIds must be a non-empty array for non-draft posts.");
  }
  if (status === "in_review" && !body.postApprovalDetails?.approver) {
    throw new Error("postApprovalDetails.approver is required for in_review posts.");
  }
  if (body.media && !Array.isArray(body.media)) throw new Error("media must be an array.");
  return body;
}

async function createSocialPost(args = {}) {
  const { locationId = DEFAULT_LOCATION_ID } = args;
  const body = buildSocialPostBody(args);
  return await socialRequest(`/social-media-posting/${encodeURIComponent(locationId)}/posts`, { method: "POST", body });
}

async function updateSocialPost(args = {}) {
  const { locationId = DEFAULT_LOCATION_ID, postId } = args;
  if (!postId) throw new Error("postId is required.");
  const body = buildSocialPostBody(args, { partial: true });
  if (Object.keys(body).length === 0) throw new Error("At least one post field must be provided.");
  return await socialRequest(`/social-media-posting/${encodeURIComponent(locationId)}/posts/${encodeURIComponent(postId)}`, { method: "PUT", body });
}

async function deleteSocialPost({ locationId = DEFAULT_LOCATION_ID, postId }) {
  if (!postId) throw new Error("postId is required.");
  return await socialRequest(`/social-media-posting/${encodeURIComponent(locationId)}/posts/${encodeURIComponent(postId)}`, { method: "DELETE" });
}

async function getSocialStatistics(args = {}) {
  const { locationId = DEFAULT_LOCATION_ID, profileIds, platforms, currentRange, prevRange } = args;
  if (!Array.isArray(profileIds) || profileIds.length === 0) throw new Error("profileIds must be a non-empty array.");
  if (profileIds.length > 100) throw new Error("profileIds supports at most 100 accounts.");
  const params = new URLSearchParams({ locationId });
  const body = { profileIds };
  if (platforms) body.platforms = platforms;
  if (currentRange) body.currentRange = currentRange;
  if (prevRange) body.prevRange = prevRange;
  return await socialRequest(`/social-media-posting/statistics?${params}`, { method: "POST", body });
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

const mediaItemSchema = {
  type: "object",
  properties: {
    url: { type: "string", description: "LeadConnector or public HTTPS media URL." },
    type: { type: "string", description: "MIME type such as image/png or video/mp4." },
    caption: { type: "string" }
  },
  required: ["url", "type"],
  additionalProperties: true
};

const socialPostProperties = {
  locationId: { type: "string", description: "LeadConnector location ID. Defaults to 123 GYM Central Office." },
  accountIds: { type: "array", items: { type: "string" }, description: "Connected account IDs from list_social_accounts." },
  summary: { type: "string", description: "Post caption/content." },
  media: { type: "array", items: mediaItemSchema },
  status: { type: "string", enum: ["draft", "scheduled", "in_review", "published"], description: "Use draft unless the user explicitly asks to schedule, review, or publish." },
  scheduleDate: { type: "string", description: "ISO-8601 UTC date; required for scheduled and in_review." },
  selectedBestTime: { type: "string" },
  createdBy: { type: "string" },
  followUpComment: { type: "string" },
  ogTagsDetails: { type: "object", additionalProperties: true },
  type: { type: "string", enum: ["post", "story", "reel", "short"] },
  postApprovalDetails: { type: "object", additionalProperties: true },
  scheduleTimeUpdated: { type: "boolean" },
  tags: { type: "array", items: { type: "string" } },
  categoryId: { type: "string" },
  applyWatermark: { type: "boolean" },
  tiktokPostDetails: { type: "object", additionalProperties: true },
  gmbPostDetails: { type: "object", additionalProperties: true },
  userId: { type: "string" },
  linkedinPostDetails: { type: "object", additionalProperties: true },
  pinterestPostDetails: { type: "object", additionalProperties: true },
  facebookPostDetails: { type: "object", additionalProperties: true },
  instagramPostDetails: { type: "object", additionalProperties: true },
  youtubePostDetails: { type: "object", additionalProperties: true },
  communityPostDetails: { type: "object", additionalProperties: true }
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
  },
  {
    name: "list_social_accounts",
    title: "List connected social accounts",
    description: "List social accounts and groups connected to LeadConnector Social Planner. Use before creating or filtering posts.",
    inputSchema: { type: "object", properties: { locationId: socialPostProperties.locationId } },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "list_social_posts",
    title: "List social posts",
    description: "List drafts, scheduled, published, failed, review, or other Social Planner posts.",
    inputSchema: { type: "object", properties: {
      locationId: socialPostProperties.locationId,
      status: { type: "string", enum: ["recent", "all", "scheduled", "draft", "failed", "in_review", "published", "in_progress", "pending", "deleted"] },
      accountIds: { type: "array", items: { type: "string" } },
      skip: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      fromDate: { type: "string" }, toDate: { type: "string" }, includeUsers: { type: "boolean" },
      postType: { type: "string", enum: ["post", "story", "reel"] }
    } },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "get_social_post",
    title: "Get social post",
    description: "Get one Social Planner post by ID.",
    inputSchema: { type: "object", properties: { locationId: socialPostProperties.locationId, postId: { type: "string" } }, required: ["postId"] },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: "create_social_post",
    title: "Create social post",
    description: "Create a LeadConnector Social Planner post. Defaults to draft. Only use scheduled, in_review, or published when explicitly requested by the user.",
    inputSchema: { type: "object", properties: socialPostProperties },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    _meta: { "openai/toolInvocation/invoking": "Creating social post…", "openai/toolInvocation/invoked": "Social post created" }
  },
  {
    name: "update_social_post",
    title: "Update social post",
    description: "Update an existing LeadConnector Social Planner post.",
    inputSchema: { type: "object", properties: { postId: { type: "string" }, ...socialPostProperties }, required: ["postId"] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  },
  {
    name: "delete_social_post",
    title: "Delete social post",
    description: "Delete a Social Planner post by ID. Use only after explicit user confirmation.",
    inputSchema: { type: "object", properties: { locationId: socialPostProperties.locationId, postId: { type: "string" } }, required: ["postId"] },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  },
  {
    name: "get_social_statistics",
    title: "Get social statistics",
    description: "Retrieve Social Planner analytics for connected accounts and optional date ranges.",
    inputSchema: { type: "object", properties: {
      locationId: socialPostProperties.locationId,
      profileIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100 },
      platforms: { type: "array", items: { type: "string", enum: ["facebook", "instagram", "linkedin", "google", "pinterest", "youtube", "tiktok"] } },
      currentRange: { type: "object", additionalProperties: true }, prevRange: { type: "object", additionalProperties: true }
    }, required: ["profileIds"] },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }
];

app.post("/mcp", async (req, res) => {
  const request = req.body || {};
  const id = request.id ?? null;
  try {
    if (request.method === "initialize") return res.json({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "123gym-social-media-agent", version: "3.0.0" } } });
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
      const socialHandlers = {
        list_social_accounts: listSocialAccounts,
        list_social_posts: listSocialPosts,
        get_social_post: getSocialPost,
        create_social_post: createSocialPost,
        update_social_post: updateSocialPost,
        delete_social_post: deleteSocialPost,
        get_social_statistics: getSocialStatistics
      };
      if (socialHandlers[toolName]) {
        const result = await socialHandlers[toolName](args);
        return res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } });
      }
      throw new Error(`Unknown tool: ${toolName}`);
    }
    return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${request.method}` } });
  } catch (error) {
    return res.json({ jsonrpc: "2.0", id, error: { code: -32000, message: error.message } });
  }
});

const isMainModule = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMainModule) app.listen(PORT, "0.0.0.0", () => console.log(`123 GYM Social Media Agent v3 listening on port ${PORT}`));

export { app, buildSocialPostBody, downloadChatGPTFile, safeFileName, tools };
