// Minimal, stateless MCP server over Streamable HTTP (JSON responses only).
// Spec: https://modelcontextprotocol.io/specification
//
// - POST /mcp accepts a JSON-RPC 2.0 request, notification, or batch.
// - Notifications and client responses are acknowledged with 202 Accepted.
// - Tool execution failures are returned as CallToolResult with isError: true;
//   protocol problems use JSON-RPC error codes.

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const MAX_REQUEST_BYTES = 1_000_000;

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
};

/** Throw from a tool handler to produce a JSON-RPC -32602 error. */
export class InvalidParamsError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidParamsError";
  }
}

const BASE_ALLOW_HEADERS = ["content-type", "authorization", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"];

export function corsHeaders(req, env = {}, extraAllowHeaders = []) {
  const configured = String(env.CORS_ALLOW_ORIGIN ?? "*").trim() || "*";
  const headers = {
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": [...BASE_ALLOW_HEADERS, ...extraAllowHeaders].join(", "),
    "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
    "access-control-max-age": "86400",
  };
  if (configured === "*") {
    headers["access-control-allow-origin"] = "*";
  } else {
    const allowed = configured.split(",").map((s) => s.trim()).filter(Boolean);
    const origin = req?.headers?.get("origin");
    if (origin && allowed.includes(origin)) headers["access-control-allow-origin"] = origin;
    headers.vary = "Origin";
  }
  return headers;
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error };
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/**
 * Optional bearer auth. When `expected` is empty, every request is allowed.
 * Returns true when the request carries `Authorization: Bearer <expected>`.
 */
export async function isAuthorized(req, expected) {
  if (!expected) return true;
  const header = req.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  // Compare digests so the comparison time doesn't depend on the secret.
  const [a, b] = await Promise.all([sha256(match[1].trim()), sha256(String(expected))]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function unauthorized(headers = {}) {
  return json(rpcError(null, ErrorCode.InvalidRequest, "Unauthorized"), 401, {
    "www-authenticate": 'Bearer realm="mcp"',
    ...headers,
  });
}

function negotiateVersion(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {object} server
 * @param {{name: string, version: string}} server.serverInfo
 * @param {string} [server.instructions]
 * @param {Array} server.tools                      tool definitions (tools/list)
 * @param {(name: string, args: object, ctx: any) => Promise<object>} server.callTool
 *        must return a CallToolResult; throw InvalidParamsError for bad input,
 *        any other error becomes an isError result.
 */
export function createMcpHandler(server) {
  const toolNames = new Set(server.tools.map((t) => t.name));

  async function handleMessage(msg, ctx) {
    if (!isPlainObject(msg)) return rpcError(null, ErrorCode.InvalidRequest, "Invalid Request");
    const hasId = Object.prototype.hasOwnProperty.call(msg, "id");
    const id = hasId ? msg.id : null;
    if (hasId && id !== null && typeof id !== "string" && typeof id !== "number") {
      return rpcError(null, ErrorCode.InvalidRequest, "Invalid Request: id must be a string or number");
    }
    if (msg.jsonrpc !== "2.0") {
      return hasId ? rpcError(id, ErrorCode.InvalidRequest, "Invalid Request: jsonrpc must be '2.0'") : null;
    }
    if (typeof msg.method !== "string") {
      // A response from the client (to a server request we never send) - acknowledge.
      if (!("method" in msg) && ("result" in msg || "error" in msg)) return null;
      return rpcError(id, ErrorCode.InvalidRequest, "Invalid Request: method must be a string");
    }
    // Notifications (no id) never get a response.
    if (!hasId) return null;

    const params = msg.params ?? {};
    if (!isPlainObject(params)) return rpcError(id, ErrorCode.InvalidParams, "params must be an object");

    try {
      switch (msg.method) {
        case "initialize":
          return rpcResult(id, {
            protocolVersion: negotiateVersion(params.protocolVersion),
            capabilities: { tools: { listChanged: false } },
            serverInfo: server.serverInfo,
            ...(server.instructions ? { instructions: server.instructions } : {}),
          });
        case "ping":
          return rpcResult(id, {});
        case "tools/list":
          return rpcResult(id, { tools: server.tools });
        case "tools/call": {
          const { name } = params;
          const args = params.arguments ?? {};
          if (typeof name !== "string" || !name) return rpcError(id, ErrorCode.InvalidParams, "params.name must be a string");
          if (!toolNames.has(name)) return rpcError(id, ErrorCode.InvalidParams, `Unknown tool: ${name}`);
          if (!isPlainObject(args)) return rpcError(id, ErrorCode.InvalidParams, "params.arguments must be an object");
          try {
            return rpcResult(id, await server.callTool(name, args, ctx));
          } catch (e) {
            if (e instanceof InvalidParamsError) return rpcError(id, ErrorCode.InvalidParams, e.message);
            const message = String(e?.message || e);
            return rpcResult(id, {
              content: [{ type: "text", text: `Error: ${message}` }],
              isError: true,
            });
          }
        }
        default:
          return rpcError(id, ErrorCode.MethodNotFound, `Method not found: ${msg.method}`);
      }
    } catch (e) {
      return rpcError(id, ErrorCode.InternalError, "Internal error", { message: String(e?.message || e) });
    }
  }

  /** Handle POST /mcp. `headers` are merged into every response (e.g. CORS). */
  return async function handlePost(req, ctx, headers = {}) {
    const declared = Number(req.headers.get("content-length") || 0);
    if (declared > MAX_REQUEST_BYTES) {
      return json(rpcError(null, ErrorCode.InvalidRequest, "Request body too large"), 413, headers);
    }
    const raw = await req.text();
    if (raw.length > MAX_REQUEST_BYTES) {
      return json(rpcError(null, ErrorCode.InvalidRequest, "Request body too large"), 413, headers);
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(rpcError(null, ErrorCode.ParseError, "Parse error"), 400, headers);
    }

    if (Array.isArray(body)) {
      if (body.length === 0) return json(rpcError(null, ErrorCode.InvalidRequest, "Invalid Request: empty batch"), 400, headers);
      const responses = (await Promise.all(body.map((m) => handleMessage(m, ctx)))).filter(Boolean);
      if (responses.length === 0) return new Response(null, { status: 202, headers });
      return json(responses, 200, headers);
    }

    const response = await handleMessage(body, ctx);
    if (!response) return new Response(null, { status: 202, headers });
    const status = response.error?.code === ErrorCode.InvalidRequest ? 400 : 200;
    return json(response, status, headers);
  };
}
