import express from "express";

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 10000;
const LC_PRIVATE_TOKEN = process.env.LC_PRIVATE_TOKEN;

const LC_BASE_URL = "https://services.leadconnectorhq.com";
const DEFAULT_LOCATION_ID = "pUePVc6UKEUecvZS6EYU";

// --------------------------------------------------
// BASIC ROUTES
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "123 GYM Media MCP",
    version: "2.0.0",
    mcp: "/mcp"
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    version: "2.0.0",
    tokenConfigured: Boolean(LC_PRIVATE_TOKEN)
  });
});

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function checkToken() {
  if (!LC_PRIVATE_TOKEN) {
    throw new Error("LC_PRIVATE_TOKEN is not configured.");
  }
}

async function parseResponse(response) {
  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(
      `LeadConnector API failed (${response.status}): ${text}`
    );
  }

  return data;
}

function lcHeaders() {
  return {
    Authorization: `Bearer ${LC_PRIVATE_TOKEN}`,
    Version: "2021-07-28",
    Accept: "application/json"
  };
}

// --------------------------------------------------
// UPLOAD MEDIA
// --------------------------------------------------

async function uploadMedia(args) {
  checkToken();

  const { fileUrl, fileName } = args;

  if (!fileUrl) {
    throw new Error("fileUrl is required.");
  }

  const body = new FormData();

  body.append("hosted", "true");
  body.append("fileUrl", fileUrl);

  if (fileName) {
    body.append("name", fileName);
  }

  const response = await fetch(
    `${LC_BASE_URL}/medias/upload-file`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LC_PRIVATE_TOKEN}`,
        Version: "2021-07-28"
      },
      body
    }
  );

  return await parseResponse(response);
}

// --------------------------------------------------
// LIST / SEARCH MEDIA
// --------------------------------------------------

async function listMedia(args = {}) {
  checkToken();

  const {
    locationId = DEFAULT_LOCATION_ID,
    search = "",
    mediaType = "all",
    limit = 50,
    offset = 0
  } = args;

  const params = new URLSearchParams();

  params.set("altId", locationId);
  params.set("altType", "location");
  params.set("sortBy", "createdAt");
  params.set("sortOrder", "desc");
  params.set("type", "file");
  params.set("limit", String(Math.min(Number(limit) || 50, 100)));
  params.set("offset", String(Number(offset) || 0));

  const response = await fetch(
    `${LC_BASE_URL}/medias/files?${params.toString()}`,
    {
      method: "GET",
      headers: lcHeaders()
    }
  );

  const data = await parseResponse(response);

  let files = data.files || data.data?.files || [];

  if (search) {
    const terms = search
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    files = files.filter((file) => {
      const haystack = [
        file.name,
        file.searchKey,
        file.contentType,
        file.category,
        file.subCategory
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return terms.some((term) => haystack.includes(term));
    });
  }

  if (mediaType === "image") {
    files = files.filter((file) =>
      file.contentType?.startsWith("image/")
    );
  }

  if (mediaType === "video") {
    files = files.filter((file) =>
      file.contentType?.startsWith("video/")
    );
  }

  return {
    count: files.length,
    files: files.map((file) => ({
      id: file._id,
      name: file.name,
      contentType: file.contentType,
      url: file.url,
      width: file.width,
      height: file.height,
      size: file.size,
      createdAt: file.createdAt,

      thumbnailUrl:
        file.thumbnail?.url || null,

      previewUrl:
        file.preview?.url || null,

      category:
        file.category || null,

      subCategory:
        file.subCategory || null
    }))
  };
}

// --------------------------------------------------
// GET MEDIA FOR VISUAL INSPECTION
// --------------------------------------------------

async function inspectMedia(args) {
  const {
    url,
    thumbnailUrl,
    name = "media"
  } = args;

  const mediaUrl = thumbnailUrl || url;

  if (!mediaUrl) {
    throw new Error(
      "url or thumbnailUrl is required."
    );
  }

  const response = await fetch(mediaUrl);

  if (!response.ok) {
    throw new Error(
      `Unable to fetch media (${response.status}).`
    );
  }

  const contentType =
    response.headers.get("content-type") ||
    "image/jpeg";

  // We intentionally inspect images or VIDEO THUMBNAILS.
  // Do not return a complete MP4 as base64 to ChatGPT.
  if (!contentType.startsWith("image/")) {
    throw new Error(
      "inspect_media requires an image or video thumbnail URL. For video, pass thumbnailUrl returned by search_leadconnector_media."
    );
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  // Avoid sending unexpectedly huge images through MCP.
  const maxBytes = 8 * 1024 * 1024;

  if (buffer.length > maxBytes) {
    throw new Error(
      "Image is larger than 8 MB. Use a thumbnail or smaller preview image."
    );
  }

  return {
    name,
    mimeType: contentType.split(";")[0],
    base64: buffer.toString("base64"),
    sourceUrl: mediaUrl
  };
}

// --------------------------------------------------
// MCP TOOLS
// --------------------------------------------------

const tools = [
  {
    name: "upload_leadconnector_media",
    description:
      "Upload or import a publicly accessible image or video URL into the LeadConnector Media Library.",
    inputSchema: {
      type: "object",
      properties: {
        fileUrl: {
          type: "string",
          description:
            "Publicly accessible URL of the image or video to import."
        },
        fileName: {
          type: "string",
          description:
            "Optional filename, for example 123gym-groupx.png."
        }
      },
      required: ["fileUrl"]
    }
  },

  {
    name: "search_leadconnector_media",
    description:
      "Search and list media from the 123 GYM LeadConnector Media Library. Use this first to discover candidate images and videos for social content.",
    inputSchema: {
      type: "object",
      properties: {
        search: {
          type: "string",
          description:
            "Optional keyword such as GroupX, GX, Zumba, Yoga, Gym or Reel."
        },
        mediaType: {
          type: "string",
          enum: ["all", "image", "video"],
          description:
            "Filter by image, video or all media."
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description:
            "Maximum number of recent media items to inspect."
        },
        offset: {
          type: "integer",
          minimum: 0
        },
        locationId: {
          type: "string",
          description:
            "LeadConnector location ID. Defaults to 123 GYM Central Office."
        }
      }
    }
  },

  {
    name: "inspect_media",
    description:
      "Visually inspect an image from the LeadConnector Media Library. For videos, use the thumbnailUrl returned by search_leadconnector_media. The tool returns actual image content to ChatGPT so the media can be evaluated visually instead of relying only on its filename.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "Image URL to inspect."
        },
        thumbnailUrl: {
          type: "string",
          description:
            "For a video, use its thumbnail URL here."
        },
        name: {
          type: "string",
          description:
            "Human-readable media name."
        }
      }
    }
  }
];

// --------------------------------------------------
// MCP ENDPOINT
// --------------------------------------------------

app.post("/mcp", async (req, res) => {
  const request = req.body || {};
  const id = request.id ?? null;

  try {
    if (request.method === "initialize") {
      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: "123gym-media-mcp",
            version: "2.0.0"
          }
        }
      });
    }

    if (request.method === "notifications/initialized") {
      return res.status(202).end();
    }

    if (request.method === "tools/list") {
      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          tools
        }
      });
    }

    if (request.method === "tools/call") {
      const toolName = request.params?.name;
      const args =
        request.params?.arguments || {};

      // --------------------------
      // UPLOAD
      // --------------------------

      if (
        toolName ===
        "upload_leadconnector_media"
      ) {
        const result =
          await uploadMedia(args);

        return res.json({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(result)
              }
            ],
            structuredContent: result
          }
        });
      }

      // --------------------------
      // SEARCH MEDIA
      // --------------------------

      if (
        toolName ===
        "search_leadconnector_media"
      ) {
        const result =
          await listMedia(args);

        return res.json({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(result)
              }
            ],
            structuredContent: result
          }
        });
      }

      // --------------------------
      // VISUAL INSPECTION
      // --------------------------

      if (
        toolName === "inspect_media"
      ) {
        const result =
          await inspectMedia(args);

        return res.json({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text:
                  `Media: ${result.name}\n` +
                  `Source: ${result.sourceUrl}`
              },
              {
                type: "image",
                data: result.base64,
                mimeType: result.mimeType
              }
            ]
          }
        });
      }

      throw new Error(
        `Unknown tool: ${toolName}`
      );
    }

    return res.json({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message:
          `Method not found: ${request.method}`
      }
    });
  } catch (error) {
    return res.json({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: error.message
      }
    });
  }
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `123 GYM Media MCP v2 listening on port ${PORT}`
  );
});
