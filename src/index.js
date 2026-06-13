// image-mcp-worker — MCP Protocol (Streamable HTTP / JSON-RPC 2.0)
// Tools: generate_image
// Features: KV image storage with direct download URLs + base64 endpoint
//
// Configuration (priority: request header > env var > default):
//   API_KEY       — required, your image API key
//   API_BASE_URL  — required, e.g. https://your-provider.com/v1
//   MODEL         — optional, default: gpt-image-1
//
// Headers (override per-request, for multi-tenant usage):
//   X-API-Key       — same as API_KEY env
//   X-API-Base-URL  — same as API_BASE_URL env
//   X-Model         — same as MODEL env

const DEFAULT_MODEL = "gpt-image-1";
const DEFAULT_SIZE = "1024x1024";

const TOOL_DEFINITIONS = [
  {
    name: "generate_image",
    description:
      "Generate an image from a text prompt. Returns a direct PNG download URL (valid 1 hour) plus base64.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Text description of the image to generate",
        },
        size: {
          type: "string",
          enum: ["1024x1024", "1024x1536", "1536x1024", "auto"],
          default: DEFAULT_SIZE,
          description: "Output image dimensions",
        },
        model: {
          type: "string",
          description: "Model override (also settable via X-Model header or MODEL env)",
        },
      },
      required: ["prompt"],
    },
  },
];

// ── Helpers ──

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-API-Key, X-API-Base-URL, X-Model",
    },
  });
}

function jsonError(id, code, message, status = 400) {
  return jsonResponse(
    { jsonrpc: "2.0", id: id ?? null, error: { code, message } },
    status
  );
}

function generateId() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  for (let i = 0; i < 8; i++) id += chars[arr[i] % chars.length];
  return id;
}

// Resolve config: header > env > error
function resolveConfig(req, env, args) {
  const h = req.headers;
  const apiKey =
    h.get("X-API-Key") || env.API_KEY || "";
  const baseUrl = (
    h.get("X-API-Base-URL") ||
    env.API_BASE_URL ||
    ""
  ).replace(/\/+$/, "");
  const model =
    args?.model ||
    h.get("X-Model") ||
    env.MODEL ||
    DEFAULT_MODEL;

  if (!apiKey)
    return { error: "No API key. Set X-API-Key header or API_KEY env var." };
  if (!baseUrl)
    return {
      error:
        "No API base URL. Set X-API-Base-URL header or API_BASE_URL env var.",
    };

  return { apiKey, baseUrl, model };
}

// ── MCP Handlers ──

async function handleInitialize(id) {
  return jsonResponse({
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "image-mcp", version: "3.0.0" },
    },
  });
}

async function handleToolsList(id) {
  return jsonResponse({
    jsonrpc: "2.0",
    id,
    result: { tools: TOOL_DEFINITIONS },
  });
}

async function handleToolsCall(id, params, req, env) {
  const { name, arguments: args } = params;

  if (name !== "generate_image")
    return jsonError(id, -32601, `Unknown tool: ${name}`);

  const prompt = String(args?.prompt || "").trim();
  if (!prompt)
    return jsonError(id, -32602, "Missing required parameter: prompt");

  const size = ["1024x1024", "1024x1536", "1536x1024", "auto"].includes(
    args?.size
  )
    ? args.size
    : DEFAULT_SIZE;

  const cfg = resolveConfig(req, env, args);
  if (cfg.error) return jsonError(id, -32602, cfg.error);

  try {
    const apiUrl = `${cfg.baseUrl}/images/generations`;
    const resp = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        prompt,
        n: 1,
        size,
        response_format: "b64_json",
      }),
    });

    const data = await resp.json();

    if (!data.data?.[0]?.b64_json) {
      return jsonError(
        id,
        -32603,
        `Image generation failed: ${JSON.stringify(data).slice(0, 400)}`
      );
    }

    const b64 = data.data[0].b64_json;
    const revised = data.data[0].revised_prompt || prompt;
    const imgId = generateId();

    // Build download URL from request origin (works for any deployment)
    const origin = new URL(req.url);
    const baseOrigin = `${origin.protocol}//${origin.host}`;
    const downloadUrl = `${baseOrigin}/img/${imgId}.png`;

    // Store in KV (1h TTL)
    if (env.IMAGE_KV) {
      await env.IMAGE_KV.put(imgId, b64, { expirationTtl: 3600 });
    }

    return jsonResponse({
      jsonrpc: "2.0",
      id,
      result: {
        content: [
          {
            type: "text",
            text: `✅ Image generated (${size}, ${cfg.model})\n\nRevised prompt: ${revised}\n\nDownload URL: ${downloadUrl}\n\nDirect link valid for 1 hour.\nBase64 JSON: ${downloadUrl}?format=b64`,
          },
          { type: "image", data: b64, mimeType: "image/png" },
        ],
      },
    });
  } catch (e) {
    return jsonError(
      id,
      -32603,
      `Image generation error: ${e.message || e}`
    );
  }
}

// ── Export ──

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, Authorization, X-API-Key, X-API-Base-URL, X-Model",
        },
      });
    }

    // ── Image serving: GET /img/{id}.png ──
    if (req.method === "GET" && url.pathname.startsWith("/img/")) {
      const match = url.pathname.match(/^\/img\/([a-z0-9]+)\.png$/);
      if (!match)
        return jsonResponse({ error: "invalid image URL format" }, 404);
      const imgId = match[1];

      // ?format=b64 → JSON
      if (url.searchParams.get("format") === "b64") {
        if (!env.IMAGE_KV)
          return jsonResponse({ error: "KV not configured" }, 500);
        const b64 = await env.IMAGE_KV.get(imgId);
        if (!b64)
          return jsonResponse({ error: "image not found or expired" }, 404);
        return jsonResponse({ id: imgId, mime_type: "image/png", data: b64 });
      }

      // Raw PNG
      if (!env.IMAGE_KV)
        return jsonResponse({ error: "KV not configured" }, 500);
      const b64 = await env.IMAGE_KV.get(imgId);
      if (!b64)
        return jsonResponse({ error: "image not found or expired" }, 404);

      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++)
        bytes[i] = binary.charCodeAt(i);

      return new Response(bytes, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=3600",
          "Content-Disposition": `inline; filename="${imgId}.png"`,
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // ── Health ──
    if (req.method === "GET" && url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        name: "image-mcp-worker",
        version: "3.0.0",
        tools: ["generate_image"],
        protocol: "MCP Streamable HTTP",
        endpoints: {
          mcp: "POST /mcp",
          png_download: "GET /img/{id}.png",
          base64_json: "GET /img/{id}.png?format=b64",
          health: "GET /health",
        },
      });
    }

    // ── MCP endpoint ──
    if (req.method === "POST" && url.pathname === "/mcp") {
      let body;
      try {
        body = await req.json();
      } catch {
        return jsonError(null, -32700, "Parse error: invalid JSON");
      }

      const { jsonrpc, id, method, params } = body;
      if (jsonrpc !== "2.0")
        return jsonError(
          id,
          -32600,
          "Invalid Request: jsonrpc must be '2.0'"
        );

      switch (method) {
        case "initialize":
          return await handleInitialize(id);
        case "notifications/initialized":
          return jsonResponse({ jsonrpc: "2.0", id, result: {} });
        case "ping":
          return jsonResponse({ jsonrpc: "2.0", id, result: {} });
        case "tools/list":
          return await handleToolsList(id);
        case "tools/call":
          return await handleToolsCall(id, params, req, env);
        default:
          return jsonError(id, -32601, `Method not found: ${method}`);
      }
    }

    // ── Root: service info ──
    if (req.method === "GET" && url.pathname === "/") {
      return jsonResponse({
        name: "image-mcp-worker",
        version: "3.0.0",
        description:
          "MCP-compatible image generation worker. Bring your own API key via headers or env vars.",
        tools: TOOL_DEFINITIONS,
        endpoints: {
          mcp: "POST /mcp",
          health: "GET /health",
          png_download: "GET /img/{id}.png",
          base64_json: "GET /img/{id}.png?format=b64",
        },
        config_headers: ["X-API-Key", "X-API-Base-URL", "X-Model"],
      });
    }

    // ── Legacy REST generate ──
    if (req.method === "POST" && url.pathname === "/tools/generate_image") {
      try {
        const body = await req.json();
        const prompt = String(body.prompt || "").trim();
        if (!prompt)
          return jsonResponse({ error: "missing prompt" }, 400);
        const size = ["1024x1024", "1024x1536", "1536x1024", "auto"].includes(
          body.size
        )
          ? body.size
          : DEFAULT_SIZE;

        const cfg = resolveConfig(req, env, body);
        if (cfg.error)
          return jsonResponse({ error: cfg.error }, 400);

        const resp = await fetch(`${cfg.baseUrl}/images/generations`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${cfg.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: body.model || cfg.model,
            prompt,
            n: 1,
            size,
            response_format: "b64_json",
          }),
        });

        const data = await resp.json();
        if (!data.data?.[0]?.b64_json)
          return jsonResponse(
            {
              error: "generation_failed",
              detail: JSON.stringify(data).slice(0, 500),
            },
            502
          );

        const b64 = data.data[0].b64_json;
        const revised = data.data[0].revised_prompt || null;
        const imgId = generateId();
        const origin = new URL(req.url);
        const baseOrigin = `${origin.protocol}//${origin.host}`;
        const downloadUrl = `${baseOrigin}/img/${imgId}.png`;

        if (env.IMAGE_KV)
          await env.IMAGE_KV.put(imgId, b64, { expirationTtl: 3600 });

        return jsonResponse({
          result: {
            download_url: downloadUrl,
            b64_json: b64,
            size,
            model: body.model || cfg.model,
            revised_prompt: revised,
          },
        });
      } catch (e) {
        return jsonResponse({ error: String(e.message || e) }, 500);
      }
    }

    return jsonResponse(
      {
        error: "not_found",
        hint: "POST /mcp for MCP, GET /health, GET /img/{id}.png for images",
      },
      404
    );
  },
};
