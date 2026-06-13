// image-mcp-worker — Standard MCP Protocol (Streamable HTTP / JSON-RPC 2.0)
// Tools: generate_image (via 987xyz gpt-image-2)

const TOOL_DEFINITIONS = [
  {
    name: "generate_image",
    description: "Generate an image from a text prompt. Returns base64 PNG. Keep prompts short and natural.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Short natural language image description" },
        size: {
          type: "string",
          enum: ["1024x1024", "1024x1536", "1536x1024"],
          default: "1024x1024",
          description: "Output image dimensions"
        },
      },
      required: ["prompt"],
    },
  },
];

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

function jsonError(id, code, message, status = 400) {
  return jsonResponse({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  }, status);
}

async function handleInitialize(id) {
  return jsonResponse({
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: {
        name: "image-mcp",
        version: "1.0.0",
      },
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

async function handleToolsCall(id, params, env) {
  const { name, arguments: args } = params;

  if (name === "generate_image") {
    const prompt = String(args?.prompt || "").trim();
    if (!prompt) {
      return jsonError(id, -32602, "Missing required parameter: prompt");
    }
    const size = ["1024x1024", "1024x1536", "1536x1024"].includes(args?.size)
      ? args.size
      : "1024x1024";

    try {
      const resp = await fetch("https://987xyz.com/v1/images/generations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "pro/gpt-image-2",
          prompt,
          n: 1,
          size,
          response_format: "b64_json",
        }),
      });

      const data = await resp.json();

      if (data.data?.[0]?.b64_json) {
        return jsonResponse({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "image",
                data: data.data[0].b64_json,
                mimeType: "image/png",
              },
              {
                type: "text",
                text: `Image generated (${size}). Revised prompt: ${data.data[0].revised_prompt || prompt}`,
              },
            ],
          },
        });
      }

      return jsonError(id, -32603, `Image generation failed: ${JSON.stringify(data).slice(0, 300)}`);
    } catch (e) {
      return jsonError(id, -32603, `Image generation error: ${e.message || e}`);
    }
  }

  return jsonError(id, -32601, `Unknown tool: ${name}`);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // Health check
    if (req.method === "GET" && url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        name: "image-mcp-worker",
        version: "1.0.0",
        tools: ["generate_image"],
        protocol: "MCP Streamable HTTP",
      });
    }

    // MCP endpoint — must be POST
    if (req.method === "POST" && url.pathname === "/mcp") {
      let body;
      try {
        body = await req.json();
      } catch {
        return jsonError(null, -32700, "Parse error: invalid JSON");
      }

      const { jsonrpc, id, method, params } = body;

      // Validate JSON-RPC 2.0
      if (jsonrpc !== "2.0") {
        return jsonError(id, -32600, "Invalid Request: jsonrpc must be '2.0'");
      }

      switch (method) {
        case "initialize":
          return await handleInitialize(id);

        case "notifications/initialized":
          // Client notification — acknowledge with empty result
          return jsonResponse({ jsonrpc: "2.0", id, result: {} });

        case "ping":
          return jsonResponse({ jsonrpc: "2.0", id, result: {} });

        case "tools/list":
          return await handleToolsList(id);

        case "tools/call":
          return await handleToolsCall(id, params, env);

        default:
          return jsonError(id, -32601, `Method not found: ${method}`);
      }
    }

    // Legacy REST endpoint (backward compat)
    if (req.method === "GET" && url.pathname === "/") {
      return jsonResponse({
        name: "image-mcp",
        version: "1.0.0",
        description: "Generate images via gpt-image-2. MCP Streamable HTTP at /mcp",
        tools: TOOL_DEFINITIONS,
        mcp_endpoint: "/mcp",
      });
    }

    // Legacy REST generate
    if (req.method === "POST" && url.pathname === "/tools/generate_image") {
      try {
        const body = await req.json();
        const prompt = String(body.prompt || "").trim();
        if (!prompt) return jsonResponse({ error: "missing prompt" }, 400);
        const size = ["1024x1024", "1024x1536", "1536x1024"].includes(body.size) ? body.size : "1024x1024";

        const resp = await fetch("https://987xyz.com/v1/images/generations", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model: "pro/gpt-image-2", prompt, n: 1, size, response_format: "b64_json" }),
        });

        const data = await resp.json();
        if (data.data?.[0]?.b64_json) {
          return jsonResponse({ result: { b64_json: data.data[0].b64_json, size, revised_prompt: data.data[0].revised_prompt || null } });
        }
        return jsonResponse({ error: "generation_failed", detail: JSON.stringify(data).slice(0, 500) }, 502);
      } catch (e) {
        return jsonResponse({ error: String(e.message || e) }, 500);
      }
    }

    return jsonResponse({ error: "not_found", hint: "Use POST /mcp for MCP protocol or GET /health" }, 404);
  },
};
