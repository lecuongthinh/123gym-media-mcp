import express from "express";
import { randomUUID } from "crypto";

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 10000;
const LC_PRIVATE_TOKEN = process.env.LC_PRIVATE_TOKEN;

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "123 GYM Media MCP",
    mcp: "/mcp"
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    tokenConfigured: Boolean(LC_PRIVATE_TOKEN)
  });
});

async function uploadMedia(args) {
  if (!LC_PRIVATE_TOKEN) {
    throw new Error("LC_PRIVATE_TOKEN is not configured.");
  }

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
    "https://services.leadconnectorhq.com/medias/upload-file",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LC_PRIVATE_TOKEN}`,
        Version: "2021-07-28"
      },
      body
    }
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(
      `LeadConnector upload failed (${response.status}): ${text}`
    );
  }

  return data;
}

const tools = [
  {
    name: "upload_leadconnector_media",
    description:
      "Upload or import a publicly accessible image or video URL into the LeadConnector Media Library and return the resulting media information.",
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
  }
];

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
            version: "1.0.0"
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
      const args = request.params?.arguments || {};

      if (toolName !== "upload_leadconnector_media") {
        throw new Error(`Unknown tool: ${toolName}`);
      }

      const result = await uploadMedia(args);

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

    return res.json({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Method not found: ${request.method}`
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`123 GYM Media MCP listening on port ${PORT}`);
});
