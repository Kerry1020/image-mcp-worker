// image-mcp-worker — MCP server (Streamable HTTP / JSON-RPC 2.0) for image
// generation through any OpenAI-compatible `/images/generations` API.
//
// Endpoints:
//   POST /mcp                      MCP JSON-RPC endpoint (tool: generate_image)
//   POST /tools/generate_image     legacy REST endpoint
//   GET  /img/{id}.png             stored image (needs IMAGE_KV binding)
//   GET  /img/{id}.png?format=b64  stored image as base64 JSON
//   GET  /health, GET /            service info
//
// Configuration (priority: request header > env var > default):
//   API_KEY        / X-API-Key       provider API key (secret)
//   API_BASE_URL   / X-API-Base-URL  provider base URL, e.g. https://api.openai.com/v1
//   MODEL          / X-Model         default gpt-image-1
// Optional env:
//   MCP_AUTH_TOKEN       secret; when set, /mcp and /tools/* require `Authorization: Bearer <token>`
//   ALLOW_HEADER_CONFIG  "false" to ignore X-API-Key / X-API-Base-URL headers
//   CORS_ALLOW_ORIGIN    "*" (default) or comma-separated origin allow-list
//   UPSTREAM_TIMEOUT_MS  provider request timeout, default 120000
//   IMAGE_TTL_SECONDS    KV retention, default 3600
//   IMAGE_KV             KV namespace binding for download URLs

import { InvalidParamsError, corsHeaders, createMcpHandler, isAuthorized, json, unauthorized } from "./mcp.js";
import {
  ConfigError,
  DEFAULT_SIZE,
  SIZES,
  UpstreamError,
  generateImage,
  resolveConfig,
  validateArgs,
} from "./provider.js";

export const SERVER_NAME = "image-mcp-worker";
export const SERVER_VERSION = "3.1.0";
const DEFAULT_TTL_SECONDS = 3600;
const EXTRA_CORS_HEADERS = ["x-api-key", "x-api-base-url", "x-model"];

export const TOOL_DEFINITIONS = [
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
          enum: SIZES,
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

const ENDPOINTS = {
  mcp: "POST /mcp",
  png_download: "GET /img/{id}.png",
  base64_json: "GET /img/{id}.png?format=b64",
  health: "GET /health",
};

// ── Helpers ──

// 32-symbol alphabet so `byte & 31` is unbiased; matches /img/[a-z0-9]+.png
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function generateId(length = 16) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let id = "";
  for (const b of bytes) id += ID_ALPHABET[b & 31];
  return id;
}

function ttlSeconds(env) {
  const n = Number.parseInt(env.IMAGE_TTL_SECONDS, 10);
  // KV minimum expirationTtl is 60 seconds.
  return Number.isFinite(n) ? Math.min(Math.max(n, 60), 30 * 24 * 3600) : DEFAULT_TTL_SECONDS;
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Store the image in KV. Returns the download URL, or null if storage is unavailable. */
async function storeImage(req, env, b64, mimeType) {
  if (!env.IMAGE_KV) return { downloadUrl: null, note: "IMAGE_KV not bound; no download URL" };
  const imgId = generateId();
  try {
    await env.IMAGE_KV.put(imgId, b64, { expirationTtl: ttlSeconds(env), metadata: { mimeType } });
  } catch (e) {
    // e.g. KV daily write quota exhausted: still return the image inline.
    return { downloadUrl: null, note: `KV write failed (${e?.message || e}); no download URL` };
  }
  const origin = new URL(req.url).origin;
  return { downloadUrl: `${origin}/img/${imgId}.png`, note: null };
}

function describeTtl(env) {
  const s = ttlSeconds(env);
  return s % 3600 === 0 ? `${s / 3600} hour${s === 3600 ? "" : "s"}` : `${s} seconds`;
}

async function runGeneration(req, env, args) {
  const { prompt, size } = validateArgs(args);
  const cfg = resolveConfig(req, env, args);
  const image = await generateImage(cfg, { prompt, size, model: cfg.model }, env);
  let stored = { downloadUrl: null, note: null };
  if (image.b64) stored = await storeImage(req, env, image.b64, image.mimeType);
  return { prompt, size, model: cfg.model, image, ...stored };
}

// ── MCP ──

async function callTool(name, args, { req, env }) {
  let out;
  try {
    out = await runGeneration(req, env, args);
  } catch (e) {
    if (e instanceof ConfigError) throw new InvalidParamsError(e.message);
    throw e; // UpstreamError and others -> isError tool result
  }
  const { image, downloadUrl, note, size, model, prompt } = out;
  const lines = [`Image generated (${size}, ${model})`, "", `Revised prompt: ${image.revisedPrompt || prompt}`, ""];
  if (downloadUrl) {
    lines.push(
      `Download URL: ${downloadUrl}`,
      "",
      `Direct link valid for ${describeTtl(env)}.`,
      `Base64 JSON: ${downloadUrl}?format=b64`,
    );
  } else if (image.url) {
    lines.push(`Provider image URL: ${image.url}`);
  } else {
    lines.push(`Download URL unavailable: ${note}.`);
  }
  const content = [{ type: "text", text: lines.join("\n") }];
  if (image.b64) content.push({ type: "image", data: image.b64, mimeType: image.mimeType });
  return { content };
}

const handleMcp = createMcpHandler({
  serverInfo: { name: "image-mcp", version: SERVER_VERSION },
  tools: TOOL_DEFINITIONS,
  callTool,
});

// ── Legacy REST ──

async function handleRestGenerate(req, env, cors) {
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400, cors);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "body must be a JSON object" }, 400, cors);
  }
  try {
    const { image, downloadUrl, size, model } = await runGeneration(req, env, body);
    return json(
      {
        result: {
          download_url: downloadUrl ?? image.url ?? null,
          b64_json: image.b64,
          size,
          model,
          revised_prompt: image.revisedPrompt,
        },
      },
      200,
      cors,
    );
  } catch (e) {
    if (e instanceof ConfigError) {
      const message = e.message === "Missing required parameter: prompt" ? "missing prompt" : e.message;
      return json({ error: message }, 400, cors);
    }
    if (e instanceof UpstreamError) {
      return json({ error: "generation_failed", detail: e.message.slice(0, 500) }, e.status === 504 ? 504 : 502, cors);
    }
    return json({ error: String(e?.message || e) }, 500, cors);
  }
}

// ── Image serving ──

async function handleImage(url, env, cors) {
  const match = url.pathname.match(/^\/img\/([a-z0-9]{1,64})\.png$/);
  if (!match) return json({ error: "invalid image URL format" }, 404, cors);
  if (!env.IMAGE_KV) return json({ error: "KV not configured" }, 500, cors);
  const imgId = match[1];

  let b64;
  let metadata;
  if (typeof env.IMAGE_KV.getWithMetadata === "function") {
    ({ value: b64, metadata } = await env.IMAGE_KV.getWithMetadata(imgId));
  } else {
    b64 = await env.IMAGE_KV.get(imgId);
  }
  if (!b64) return json({ error: "image not found or expired" }, 404, cors);
  const mimeType = metadata?.mimeType || "image/png";

  if (url.searchParams.get("format") === "b64") {
    return json({ id: imgId, mime_type: mimeType, data: b64 }, 200, cors);
  }

  return new Response(base64ToBytes(b64), {
    headers: {
      ...cors,
      "Content-Type": mimeType,
      "Cache-Control": "public, max-age=3600",
      "Content-Disposition": `inline; filename="${imgId}.png"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// ── Router ──

export default {
  async fetch(req, env = {}) {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env, EXTRA_CORS_HEADERS);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (req.method === "GET" && url.pathname.startsWith("/img/")) {
      return handleImage(url, env, cors);
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return json(
        {
          ok: true,
          name: SERVER_NAME,
          version: SERVER_VERSION,
          tools: TOOL_DEFINITIONS.map((t) => t.name),
          protocol: "MCP Streamable HTTP",
          endpoints: ENDPOINTS,
          kv_configured: Boolean(env.IMAGE_KV),
          auth_required: Boolean(env.MCP_AUTH_TOKEN),
        },
        200,
        cors,
      );
    }

    if (url.pathname === "/mcp") {
      if (req.method !== "POST") {
        return json({ error: "method_not_allowed" }, 405, { ...cors, allow: "POST, OPTIONS" });
      }
      if (!(await isAuthorized(req, env.MCP_AUTH_TOKEN))) return unauthorized(cors);
      return handleMcp(req, { req, env }, cors);
    }

    if (req.method === "GET" && url.pathname === "/") {
      return json(
        {
          name: SERVER_NAME,
          version: SERVER_VERSION,
          description: "MCP-compatible image generation worker. Bring your own API key via headers or env vars.",
          tools: TOOL_DEFINITIONS,
          endpoints: { mcp: ENDPOINTS.mcp, health: ENDPOINTS.health, png_download: ENDPOINTS.png_download, base64_json: ENDPOINTS.base64_json },
          config_headers: ["X-API-Key", "X-API-Base-URL", "X-Model"],
        },
        200,
        cors,
      );
    }

    if (req.method === "POST" && url.pathname === "/tools/generate_image") {
      if (!(await isAuthorized(req, env.MCP_AUTH_TOKEN))) return json({ error: "unauthorized" }, 401, cors);
      return handleRestGenerate(req, env, cors);
    }

    return json(
      {
        error: "not_found",
        hint: "POST /mcp for MCP, GET /health, GET /img/{id}.png for images",
      },
      404,
      cors,
    );
  },
};
