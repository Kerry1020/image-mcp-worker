# image-mcp-worker

[![CI](https://github.com/Kerry1020/image-mcp-worker/actions/workflows/ci.yml/badge.svg)](https://github.com/Kerry1020/image-mcp-worker/actions/workflows/ci.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-6E56CF)](https://modelcontextprotocol.io)

English | [简体中文](README.zh-CN.md)

An [MCP](https://modelcontextprotocol.io/) image generation server on Cloudflare Workers. It forwards prompts to any OpenAI-compatible `POST /images/generations` API (e.g. `gpt-image-1`) and returns the image inline as base64, plus an optional direct download URL.

## Features

- **MCP over Streamable HTTP** (JSON-RPC 2.0) at `POST /mcp`: `initialize`, `ping`, `tools/list`, `tools/call`, notifications and batches. Stateless, JSON responses only.
- **Bring your own provider**: configure the provider with env vars, or per request with headers (multi-tenant).
- **Direct download URLs** via optional Cloudflare KV (`/img/{id}.png`, `?format=b64`), auto-expiring.
- **Safe by default**: the deployment's own `API_KEY` is only ever sent to its own `API_BASE_URL`; caller-supplied base URLs must be public `https` hosts and must come with the caller's own key. Optional bearer auth (`MCP_AUTH_TOKEN`).
- **Robust upstream handling**: timeout, clear errors for non-JSON / non-2xx / redirect responses, API key redacted from error messages, KV failures never lose a generated image.

## Quick start

```bash
git clone https://github.com/Kerry1020/image-mcp-worker.git
cd image-mcp-worker
npm install
npx wrangler secret put API_KEY
npx wrangler secret put API_BASE_URL     # e.g. https://api.openai.com/v1
npx wrangler secret put MCP_AUTH_TOKEN   # recommended
npx wrangler deploy
```

Then connect a client (see [MCP client config](#mcp-client-config)) to `https://<your-worker>.workers.dev/mcp`.

## Tools

| Tool | Arguments | Description |
|------|-----------|-------------|
| `generate_image` | `prompt` (string, required, up to 32000 chars), `size` (`1024x1024` default, `1024x1536`, `1536x1024`, `auto`), `model` (optional override) | Generates one image. Returns a text block (size, model, revised prompt, download URL when KV is bound) and an `image` content block with base64 data. |

Unknown `size` values fall back to `1024x1024`. If the provider returns a URL instead of base64, the text block contains the provider URL and no `image` block is sent.

**Errors:** a missing/invalid `prompt` or `model`, missing provider config, or a disallowed `X-API-Base-URL` returns JSON-RPC error `-32602`. Provider failures (HTTP errors, timeouts, bad responses) return a normal result with `isError: true` and the reason in the text content.

### HTTP endpoints

| Method | Path | Auth* | Description |
|--------|------|-------|-------------|
| `POST` | `/mcp` | yes | MCP JSON-RPC endpoint |
| `POST` | `/tools/generate_image` | yes | Legacy REST endpoint: `{prompt, size?, model?}` -> `{result: {download_url, b64_json, size, model, revised_prompt}}` |
| `GET` | `/img/{id}.png` | no | Stored image bytes (needs `IMAGE_KV`) |
| `GET` | `/img/{id}.png?format=b64` | no | `{id, mime_type, data}` |
| `GET` | `/health` | no | Health check |
| `GET` | `/` | no | Service info and tool schema |

\* Only when `MCP_AUTH_TOKEN` is set.

Other methods on `/mcp` (e.g. `GET`) return `405` (no SSE stream). Without `IMAGE_KV`, `/img/*` returns `500 KV not configured` and generation responses contain no download URL. Expired images return `404`.

### curl examples

```bash
URL=http://localhost:8787   # or https://<your-worker>.workers.dev
AUTH=(-H "Authorization: Bearer $MCP_AUTH_TOKEN")   # or AUTH=() if auth is disabled

curl -s $URL/health

curl -s $URL/mcp "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

curl -s $URL/mcp "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"generate_image","arguments":{"prompt":"A samurai cat in a neon-lit cyberpunk city","size":"1024x1024"}}}'

# Bring your own provider (multi-tenant)
curl -s $URL/mcp "${AUTH[@]}" -H 'content-type: application/json' \
  -H "X-API-Key: sk-your-key" \
  -H "X-API-Base-URL: https://your-provider.example.com/v1" \
  -H "X-Model: gpt-image-1" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"generate_image","arguments":{"prompt":"sunset over mountains"}}}'

# Legacy REST endpoint
curl -s -X POST $URL/tools/generate_image "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"prompt":"a red panda eating bamboo","size":"1024x1024"}'

# Download a stored image
curl -o image.png $URL/img/<id>.png
```

Example `tools/call` result:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Image generated (1024x1024, gpt-image-1)\n\nRevised prompt: ...\n\nDownload URL: https://<your-worker>.workers.dev/img/abcd1234efgh5678.png\n\nDirect link valid for 1 hour.\nBase64 JSON: https://<your-worker>.workers.dev/img/abcd1234efgh5678.png?format=b64"
      },
      { "type": "image", "data": "iVBORw0KGgo...", "mimeType": "image/png" }
    ]
  }
}
```

## Configuration

Provider settings can come from env vars (deployment-level) or request headers (per request). **Priority: header > env var > default.** For `model`, the tool argument wins over both.

| Name | Required | Secret | Default | Description |
|---|---|---|---|---|
| `API_KEY` | yes, unless every caller sends `X-API-Key` | yes | — | Provider API key. Header: `X-API-Key`. |
| `API_BASE_URL` | yes, unless every caller sends `X-API-Base-URL` | recommended | — | Provider base URL, e.g. `https://api.openai.com/v1`. Header: `X-API-Base-URL`. |
| `MODEL` | no | no | `gpt-image-1` | Default model. Header: `X-Model`. |
| `MCP_AUTH_TOKEN` | no (recommended) | yes | unset | Require `Authorization: Bearer <token>` on `/mcp` and `/tools/*`. |
| `ALLOW_HEADER_CONFIG` | no | no | `true` | Set `false` to ignore `X-API-Key` / `X-API-Base-URL` (single-tenant mode). `X-Model` still applies. |
| `CORS_ALLOW_ORIGIN` | no | no | `*` | `*` or comma-separated origin allow-list. |
| `UPSTREAM_TIMEOUT_MS` | no | no | `120000` | Provider request timeout, clamped to 5000-600000. |
| `IMAGE_TTL_SECONDS` | no | no | `3600` | How long images stay in KV, clamped to 60 s - 30 days. |
| `IMAGE_KV` | no | — (KV binding) | unset | Enables download URLs. |

If `X-API-Base-URL` differs from `API_BASE_URL`, the request **must** also send `X-API-Key`, and the URL must be `https` on a public host. This prevents callers from redirecting the operator's key to a server they control.

For local development copy `.dev.vars.example` to `.dev.vars` (git-ignored).

## MCP client config

Claude Code:

```bash
claude mcp add --transport http image-gen https://<your-worker>.workers.dev/mcp

# with MCP_AUTH_TOKEN set on the worker
claude mcp add --transport http image-gen https://<your-worker>.workers.dev/mcp \
  --header "Authorization: Bearer <token>"
```

Claude Desktop / generic JSON via [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

```json
{
  "mcpServers": {
    "image-gen": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://<your-worker>.workers.dev/mcp",
        "--header",
        "Authorization: Bearer ${AUTH_TOKEN}"
      ],
      "env": {
        "AUTH_TOKEN": "<token>"
      }
    }
  }
}
```

To bring your own provider, add more `--header` pairs (e.g. `"X-API-Key: ${PROVIDER_KEY}"`, `"X-API-Base-URL: https://your-provider.example.com/v1"`). Clients with native remote MCP support (e.g. Cursor) can use `"url"` plus a `"headers"` object instead.

Hermes Agent:

```bash
hermes mcp add image-gen --transport http --url https://<your-worker>.workers.dev/mcp \
  --header "Authorization: Bearer <token>"
```

## Security notes

- **Set `MCP_AUTH_TOKEN` for any public deployment** (`npx wrangler secret put MCP_AUTH_TOKEN`), especially when `API_KEY` is set. Without it, anyone who finds the URL can call `/mcp` and `/tools/generate_image` and spend your provider credits.
- The token is compared in constant time (SHA-256 digests). Failed auth returns `401` with `WWW-Authenticate: Bearer`.
- `/health`, `/` and `/img/*` are always unauthenticated. Image URLs are meant to be shareable; ids are 16 random characters and expire after `IMAGE_TTL_SECONDS`.
- The operator's `API_KEY` is never sent to a caller-supplied base URL; custom base URLs must use `https` and are rejected if they name a private, loopback, link-local or metadata host (SSRF guard; hostnames are not DNS-resolved). Set `ALLOW_HEADER_CONFIG=false` to disable per-request provider headers entirely.
- Upstream redirects are not followed, and the API key is redacted from error messages.

## Development

Requires Node.js 20+.

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in, git-ignored
npm test                          # node:test, fetch and KV mocked
npm run dev                       # wrangler dev, http://localhost:8787
npm run check                     # bundle dry-run, does not deploy
```

Project layout:

```
src/
  index.js       Worker entry, routing, tool, REST and image endpoints
  provider.js    Provider config resolution and upstream call
  mcp.js         JSON-RPC / MCP protocol, CORS, bearer auth
  url-guard.js   SSRF host/IP validation for caller-supplied base URLs
test/            node:test suites
```

## Deploy

1. Fork/clone the repo and `npm install`.
2. (Optional) create a KV namespace, then uncomment the `[[kv_namespaces]]` block in `wrangler.toml` and paste the returned id:
   ```bash
   npx wrangler kv namespace create IMAGE_KV
   ```
3. Set secrets:
   ```bash
   npx wrangler secret put API_KEY
   npx wrangler secret put API_BASE_URL     # e.g. https://api.openai.com/v1
   npx wrangler secret put MCP_AUTH_TOKEN   # recommended
   ```
4. Deploy with `npm run deploy` (or `npx wrangler deploy`).

### Cloudflare KV free tier

| Resource | Free limit |
|---|---|
| Reads | 100,000 / day |
| **Writes** | **1,000 / day** (one per generated image) |
| Storage | 1 GB |

When the write quota is exhausted the image is still returned inline, just without a download URL.

## Related projects

- [time-mcp-worker](https://github.com/Kerry1020/time-mcp-worker) — time zone lookup, conversion and time differences
- [geo-mcp-worker](https://github.com/Kerry1020/geo-mcp-worker) — geocoding, POI search and routing via OpenStreetMap services
- [memory-mcp-worker](https://github.com/Kerry1020/memory-mcp-worker) — persistent KV-backed memory for agents
- [webhook-inbox-mcp-worker](https://github.com/Kerry1020/webhook-inbox-mcp-worker) — receive webhooks into KV and read them as MCP tools
- [summarize-mcp-worker](https://github.com/Kerry1020/summarize-mcp-worker) — web page extraction and extractive summarization
- [calc-mcp-worker](https://github.com/Kerry1020/calc-mcp-worker) — math: expressions, calculus, matrices, statistics
- [search-mcp-worker](https://github.com/Kerry1020/search-mcp-worker) — multi-engine web search with open, auditable ranking

## License

GNU General Public License v3.0, see [LICENSE](LICENSE).
