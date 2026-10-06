// Upstream OpenAI-compatible image API: config resolution and the
// POST {base}/images/generations call.

import { assertPublicHttpUrl } from "./url-guard.js";

export const DEFAULT_MODEL = "gpt-image-1";
export const DEFAULT_SIZE = "1024x1024";
export const SIZES = ["1024x1024", "1024x1536", "1536x1024", "auto"];
export const MAX_PROMPT_CHARS = 32_000;
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000;
const MAX_UPSTREAM_BYTES = 64 * 1024 * 1024;

/** Error whose message is safe to show to the caller (input / config problems). */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Upstream failure: returned to MCP clients as an isError tool result. */
export class UpstreamError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
  }
}

function headerConfigAllowed(env) {
  return String(env.ALLOW_HEADER_CONFIG ?? "true").toLowerCase() !== "false";
}

function trimBase(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

export function validateModel(model) {
  if (model == null || model === "") return undefined;
  if (typeof model !== "string" || model.length > 128 || !/^[\w.:\/@+-]+$/.test(model)) {
    throw new ConfigError("Invalid model name");
  }
  return model;
}

/**
 * Resolve provider config. Priority: request header > env var > default.
 *
 * Security: the deployment's own API_KEY is only ever sent to the
 * deployment's own API_BASE_URL. A caller that points X-API-Base-URL at a
 * different host must also bring its own X-API-Key, otherwise anyone could
 * exfiltrate the operator's key by aiming the worker at a server they control.
 * Caller-supplied base URLs must be https and resolve to a public host.
 */
export function resolveConfig(req, env = {}, args = {}) {
  const allowHeaders = headerConfigAllowed(env);
  const h = req.headers;
  const headerKey = allowHeaders ? (h.get("X-API-Key") || "").trim() : "";
  const headerBase = allowHeaders ? trimBase(h.get("X-API-Base-URL")) : "";
  const envKey = String(env.API_KEY || "").trim();
  const envBase = trimBase(env.API_BASE_URL);

  const model = validateModel(args?.model) || validateModel(h.get("X-Model") || undefined) || env.MODEL || DEFAULT_MODEL;

  let baseUrl = envBase;
  let apiKey = headerKey || envKey;

  if (headerBase && headerBase !== envBase) {
    let parsed;
    try {
      parsed = assertPublicHttpUrl(headerBase);
    } catch (e) {
      throw new ConfigError(`X-API-Base-URL not allowed (${e.code || "invalid_url"})`);
    }
    if (parsed.protocol !== "https:") throw new ConfigError("X-API-Base-URL must use https");
    if (!headerKey) {
      throw new ConfigError("X-API-Key header is required when X-API-Base-URL points to a custom provider.");
    }
    baseUrl = trimBase(parsed.toString());
    apiKey = headerKey;
  }

  if (!apiKey) throw new ConfigError("No API key. Set X-API-Key header or API_KEY env var.");
  if (!baseUrl) throw new ConfigError("No API base URL. Set X-API-Base-URL header or API_BASE_URL env var.");
  if (!/^https?:\/\//i.test(baseUrl)) throw new ConfigError("API base URL must start with http:// or https://");

  return { apiKey, baseUrl, model };
}

/** Validate tool / REST arguments. Returns { prompt, size }. */
export function validateArgs(args = {}) {
  if (args.prompt != null && typeof args.prompt !== "string") throw new ConfigError("prompt must be a string");
  const prompt = String(args.prompt || "").trim();
  if (!prompt) throw new ConfigError("Missing required parameter: prompt");
  if (prompt.length > MAX_PROMPT_CHARS) throw new ConfigError(`prompt exceeds ${MAX_PROMPT_CHARS} characters`);
  // Unknown sizes fall back to the default (historic behaviour).
  const size = SIZES.includes(args.size) ? args.size : DEFAULT_SIZE;
  return { prompt, size };
}

function redact(text, secret) {
  let out = String(text);
  if (secret && secret.length >= 4) out = out.split(secret).join("[redacted]");
  return out;
}

export function detectMime(b64) {
  const head = b64.slice(0, 24);
  if (head.startsWith("iVBORw0KGgo")) return "image/png";
  if (head.startsWith("/9j/")) return "image/jpeg";
  if (head.startsWith("UklGR") && atob(head.slice(0, 16)).slice(8, 12) === "WEBP") return "image/webp";
  if (head.startsWith("R0lGOD")) return "image/gif";
  return "image/png";
}

async function readText(res) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_UPSTREAM_BYTES) {
      await reader.cancel().catch(() => {});
      throw new UpstreamError("Upstream response too large", res.status);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Call the provider. Returns { b64, url, revisedPrompt, mimeType }.
 * Exactly one of b64 / url is set.
 */
export async function generateImage(cfg, { prompt, size, model }, env = {}) {
  const timeoutMs = Math.min(
    Math.max(Number.parseInt(env.UPSTREAM_TIMEOUT_MS, 10) || DEFAULT_UPSTREAM_TIMEOUT_MS, 5000),
    600_000,
  );
  const signal = AbortSignal.timeout(timeoutMs);
  let resp;
  let text;
  try {
    resp = await fetch(`${cfg.baseUrl}/images/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ model: model || cfg.model, prompt, n: 1, size, response_format: "b64_json" }),
      redirect: "manual",
      signal,
    });
    if (resp.status >= 300 && resp.status < 400) {
      await resp.body?.cancel().catch(() => {});
      throw new UpstreamError(`Upstream returned redirect (HTTP ${resp.status}); check API base URL`, resp.status);
    }
    text = await readText(resp);
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      throw new UpstreamError(`Upstream timed out after ${timeoutMs}ms`, 504);
    }
    throw new UpstreamError(redact(`Upstream request failed: ${e?.message || e}`, cfg.apiKey), 502);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new UpstreamError(
      redact(`Upstream returned non-JSON response (HTTP ${resp.status}): ${text.slice(0, 200)}`, cfg.apiKey),
      502,
    );
  }

  const item = data?.data?.[0];
  if (!resp.ok || (!item?.b64_json && !item?.url)) {
    const detail = data?.error?.message || JSON.stringify(data);
    throw new UpstreamError(
      redact(`Image generation failed (HTTP ${resp.status}): ${String(detail).slice(0, 400)}`, cfg.apiKey),
      resp.ok ? 502 : resp.status,
    );
  }

  if (item.b64_json) {
    const b64 = String(item.b64_json).replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new UpstreamError("Upstream returned invalid base64 image data", 502);
    return { b64, url: null, revisedPrompt: item.revised_prompt || null, mimeType: detectMime(b64) };
  }
  return { b64: null, url: String(item.url), revisedPrompt: item.revised_prompt || null, mimeType: null };
}
