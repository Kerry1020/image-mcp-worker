# image-mcp-worker

Cloudflare Worker 上运行的 MCP 图像生成服务，通过 OpenAI 兼容网关调用 gpt-image-2 模型。

## 协议

标准 MCP Streamable HTTP / JSON-RPC 2.0。MCP 端点为 `/mcp`，请求方式为 POST + `Content-Type: application/json`。

## 工具

### `generate_image`

从文本提示生成图像，返回 base64 PNG。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prompt` | string | 是 | 自然语言图像描述 |
| `size` | string | 否 | 输出尺寸，默认 `1024x1024`。可选：`1024x1024`、`1024x1536`、`1536x1024` |

**返回：**

`content` 数组包含：
- `{ type: "image", data: "<base64>", mimeType: "image/png" }` — PNG 图片
- `{ type: "text", text: "Image generated (...). Revised prompt: ..." }` — 元信息

## 接口示例

将 `<YOUR_WORKER_URL>` 替换为你的 Worker 部署地址。

### MCP JSON-RPC

```bash
curl -X POST <YOUR_WORKER_URL>/mcp \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "generate_image",
      "arguments": {
        "prompt": "a cat on a windowsill",
        "size": "1024x1024"
      }
    }
  }'
```

### 初始化握手

```bash
curl -X POST <YOUR_WORKER_URL>/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "initialize"}'
```

### 工具列表

```bash
curl -X POST <YOUR_WORKER_URL>/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}'
```

### 健康检查

```bash
curl <YOUR_WORKER_URL>/health
```

### Legacy REST（向后兼容）

```bash
curl -X POST <YOUR_WORKER_URL>/tools/generate_image \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "a cat", "size": "1024x1024"}'
```

## 支持的 MCP 方法

| 方法 | 说明 |
|------|------|
| `initialize` | MCP 握手，返回 serverInfo + protocolVersion |
| `notifications/initialized` | 客户端通知，返回空结果 |
| `ping` | 心跳 |
| `tools/list` | 返回工具定义 |
| `tools/call` | 调用工具 |

## 环境变量

| 变量 | 说明 |
|------|------|
| `API_KEY` | OpenAI 兼容网关的 API Key（在 CF Worker Settings -> Secrets 中配置） |

## 部署

```bash
npx wrangler deploy
```

Worker 名称：`image-mcp-worker`

## 许可

MIT
