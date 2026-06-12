# image-mcp-worker

MCP server on Cloudflare Workers for image generation (gpt-image-2).

## Tools

### generate_image
```
POST /tools/generate_image
{"prompt": "a cat on a windowsill", "size": "1024x1024"}
```

Returns `{ "result": { "b64_json": "...", "size": "1024x1024" } }`

### Health
```
GET /health
```
