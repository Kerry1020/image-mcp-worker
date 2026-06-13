# image-mcp-worker

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) compatible image generation worker that runs on Cloudflare Workers. Generate images from text prompts with direct download URLs and base64 support.

## Features

- **MCP Protocol** — Streamable HTTP / JSON-RPC 2.0, works with any MCP client
- **Bring Your Own Provider** — Pass any OpenAI-compatible image API via headers or env vars
- **Direct Download URLs** — Generated images served as raw PNG via `/img/{id}.png`
- **Base64 JSON** — Also available via `/img/{id}.png?format=b64`
- **Cloudflare KV Storage** — Images cached 1 hour, auto-expiring
- **Multi-tenant Ready** — Per-request header overrides for API key, base URL, and model

## Quick Start

### Deploy to Cloudflare Workers

1. Fork this repo
2. Create a KV namespace:
   ```bash
   wrangler kv namespace create IMAGE_KV
   ```
3. Set your secrets:
   ```bash
   wrangler secret put API_KEY
   wrangler secret put API_BASE_URL    # e.g. https://your-provider.com/v1
   wrangler secret put MODEL           # optional, default: gpt-image-1
   ```
4. Deploy:
   ```bash
   wrangler deploy
   ```

### Configuration

All config can be set via **env vars** (deployment-level) or **request headers** (per-request override):

| Env Var | Header | Required | Default | Description |
|---|---|---|---|---|
| `API_KEY` | `X-API-Key` | ✅ | — | API key for your image provider |
| `API_BASE_URL` | `X-API-Base-URL` | ✅ | — | Provider base URL (e.g. `https://api.example.com/v1`) |
| `MODEL` | `X-Model` | ❌ | `gpt-image-1` | Model name |

**Priority: header > env var > default**

This means you can deploy with env vars for your own use, and also let other users pass their own credentials via headers.

## API Endpoints

### `POST /mcp` — MCP Protocol

Standard MCP Streamable HTTP endpoint. Supports `initialize`, `tools/list`, `tools/call`, `ping`.

**Tool: `generate_image`**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "generate_image",
    "arguments": {
      "prompt": "A samurai cat in a neon-lit cyberpunk city",
      "size": "1024x1024"
    }
  }
}
```

Response includes both a download URL and inline base64:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "✅ Image generated (1024x1024, gpt-image-1)\n\nDownload URL: https://your-worker.example.com/img/abc123.png\n\nDirect link valid for 1 hour.\nBase64 JSON: https://your-worker.example.com/img/abc123.png?format=b64"
      },
      {
        "type": "image",
        "data": "iVBORw0KGgo...",
        "mimeType": "image/png"
      }
    ]
  }
}
```

**With per-request headers (multi-tenant):**

```bash
curl -X POST https://your-worker.example.com/mcp \
  -H "Content-Type: application/json" \
  -H "X-API-Key: sk-your-key" \
  -H "X-API-Base-URL: https://your-provider.com/v1" \
  -H "X-Model: dall-e-3" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"generate_image","arguments":{"prompt":"sunset over mountains"}}}'
```

### `GET /img/{id}.png` — Direct PNG Download

Returns raw PNG binary. Valid for 1 hour after generation.

```bash
curl -o image.png https://your-worker.example.com/img/abc123.png
```

### `GET /img/{id}.png?format=b64` — Base64 JSON

Returns base64-encoded image as JSON:

```json
{
  "id": "abc123",
  "mime_type": "image/png",
  "data": "iVBORw0KGgo..."
}
```

### `POST /tools/generate_image` — REST Endpoint (Legacy)

Non-MCP REST interface for simple integrations:

```bash
curl -X POST https://your-worker.example.com/tools/generate_image \
  -H "Content-Type: application/json" \
  -H "X-API-Key: sk-your-key" \
  -H "X-API-Base-URL: https://your-provider.com/v1" \
  -d '{"prompt":"a red panda eating bamboo","size":"1024x1024"}'
```

### `GET /health` — Health Check

```json
{
  "ok": true,
  "name": "image-mcp-worker",
  "version": "3.0.0",
  "tools": ["generate_image"],
  "protocol": "MCP Streamable HTTP",
  "endpoints": { ... }
}
```

## Connect to MCP Clients

### Claude Desktop / Claude Code

Add to your MCP client config:

```json
{
  "mcpServers": {
    "image-gen": {
      "url": "https://your-worker.example.com/mcp",
      "headers": {
        "X-API-Key": "sk-your-key",
        "X-API-Base-URL": "https://your-provider.com/v1"
      }
    }
  }
}
```

### Hermes Agent

```bash
hermes mcp add image-gen --transport http --url https://your-worker.example.com/mcp \
  --header "X-API-Key: sk-your-key" \
  --header "X-API-Base-URL: https://your-provider.com/v1"
```

## Supported Sizes

| Size | Aspect Ratio |
|---|---|
| `1024x1024` | 1:1 (default) |
| `1024x1536` | 2:3 (portrait) |
| `1536x1024` | 3:2 (landscape) |
| `auto` | Provider decides |

## Cloudflare KV Free Tier Limits

| Resource | Free Limit |
|---|---|
| Reads | 100,000 / day |
| **Writes** | **1,000 / day** (limits daily image generations) |
| Storage | 1 GB |
| List operations | 1,000 / day |

Images auto-expire after 1 hour via TTL, so storage is self-cleaning.

## License

MIT
