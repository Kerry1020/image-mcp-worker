# image-mcp-worker

[![CI](https://github.com/Kerry1020/image-mcp-worker/actions/workflows/ci.yml/badge.svg)](https://github.com/Kerry1020/image-mcp-worker/actions/workflows/ci.yml)

[English](README.md) | 简体中文

运行在 Cloudflare Workers 上的 [MCP](https://modelcontextprotocol.io/) 图像生成服务。它把提示词转发到任意 OpenAI 兼容的 `POST /images/generations` 接口（如 `gpt-image-1`），以 base64 内联返回图片，并可选提供直接下载链接。

## 功能

- **MCP Streamable HTTP**（JSON-RPC 2.0），端点 `POST /mcp`：支持 `initialize`、`ping`、`tools/list`、`tools/call`、通知与批量请求。无状态，仅返回 JSON。
- **自带服务商**：通过环境变量配置，或按请求通过请求头配置（多租户）。
- **直接下载链接**：可选 Cloudflare KV（`/img/{id}.png`、`?format=b64`），到期自动删除。
- **默认安全**：部署自身的 `API_KEY` 只会发送到部署自身的 `API_BASE_URL`；调用方自定义的 base URL 必须是公网 `https` 主机且必须同时提供调用方自己的 Key。可选 Bearer 鉴权（`MCP_AUTH_TOKEN`）。
- **健壮的上游处理**：超时控制；对非 JSON、非 2xx、重定向响应给出明确错误；错误信息中屏蔽 API Key；KV 写入失败不会丢失已生成的图片。

## MCP 工具

| 工具 | 参数 | 说明 |
|------|------|------|
| `generate_image` | `prompt`（字符串，必填，最长 32000 字符）、`size`（默认 `1024x1024`，可选 `1024x1536`、`1536x1024`、`auto`）、`model`（可选） | 生成一张图片。返回一段文本（尺寸、模型、改写后的提示词、绑定 KV 时的下载链接）和一个包含 base64 数据的 `image` 内容块。 |

未知的 `size` 会回退为 `1024x1024`。

**错误处理：** 缺少/非法的 `prompt` 或 `model`、缺少服务商配置、`X-API-Base-URL` 不被允许时返回 JSON-RPC 错误 `-32602`。服务商侧失败（HTTP 错误、超时、响应异常）返回 `isError: true` 的正常结果，原因写在文本内容中。

## HTTP 端点

| 方法 | 路径 | 鉴权* | 说明 |
|------|------|-------|------|
| `POST` | `/mcp` | 是 | MCP JSON-RPC 端点 |
| `POST` | `/tools/generate_image` | 是 | 旧版 REST：`{prompt, size?, model?}` -> `{result: {download_url, b64_json, size, model, revised_prompt}}` |
| `GET` | `/img/{id}.png` | 否 | 已存储的图片（需要 `IMAGE_KV`） |
| `GET` | `/img/{id}.png?format=b64` | 否 | `{id, mime_type, data}` |
| `GET` | `/health` | 否 | 健康检查 |
| `GET` | `/` | 否 | 服务信息与工具定义 |

\* 仅在设置了 `MCP_AUTH_TOKEN` 时。图片链接保持公开以便分享，id 为 16 位随机字符。

`GET /mcp` 返回 `405`（不提供 SSE 流）。未绑定 `IMAGE_KV` 时 `/img/*` 返回 `500 KV not configured`，生成结果中也不会给出下载链接。过期图片返回 `404`。

## 配置

服务商配置可来自环境变量（部署级）或请求头（单次请求）。**优先级：请求头 > 环境变量 > 默认值。** `model` 的工具参数优先级最高。

| 环境变量 | 请求头 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `API_KEY`（secret） | `X-API-Key` | 是 | — | 服务商 API Key |
| `API_BASE_URL`（secret 或 var） | `X-API-Base-URL` | 是 | — | 服务商 base URL，如 `https://api.openai.com/v1` |
| `MODEL` | `X-Model` | 否 | `gpt-image-1` | 模型名 |

当 `X-API-Base-URL` 与 `API_BASE_URL` 不同时，请求**必须**同时携带 `X-API-Key`，且该 URL 必须是公网主机上的 `https` 地址。这样可以防止调用方把运营者的 Key 引导到自己控制的服务器。

其他可选配置：

| 名称 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `MCP_AUTH_TOKEN` | secret | 未设置 | `/mcp` 与 `/tools/*` 需要 `Authorization: Bearer <token>`。**设置了 `API_KEY` 时强烈建议开启**，否则任何知道 URL 的人都能消耗你的额度。 |
| `ALLOW_HEADER_CONFIG` | var | `true` | 设为 `false` 时忽略 `X-API-Key` / `X-API-Base-URL`（单租户模式），`X-Model` 仍然生效。 |
| `CORS_ALLOW_ORIGIN` | var | `*` | `*` 或以逗号分隔的允许来源列表。 |
| `UPSTREAM_TIMEOUT_MS` | var | `120000` | 服务商请求超时（5000-600000）。 |
| `IMAGE_TTL_SECONDS` | var | `3600` | 图片在 KV 中的保留时间（60 秒 - 30 天）。 |
| `IMAGE_KV` | KV 绑定 | 未设置 | 启用下载链接。 |

## 部署到 Cloudflare Workers

1. Fork/克隆仓库并执行 `npm install`。
2. （可选）创建 KV 命名空间，并在 `wrangler.toml` 中取消 `[[kv_namespaces]]` 的注释、填入返回的 id：
   ```bash
   npx wrangler kv namespace create IMAGE_KV
   ```
3. 设置密钥：
   ```bash
   npx wrangler secret put API_KEY
   npx wrangler secret put API_BASE_URL     # 例如 https://api.openai.com/v1
   npx wrangler secret put MCP_AUTH_TOKEN   # 建议设置
   ```
4. 部署：
   ```bash
   npx wrangler deploy
   ```

## 接入 MCP 客户端

Claude Code：

```bash
claude mcp add --transport http image-gen https://image-mcp-worker.<your-subdomain>.workers.dev/mcp \
  --header "Authorization: Bearer $MCP_AUTH_TOKEN"
```

JSON 配置（仅在使用自己的服务商时需要提供 `X-API-*` 请求头）：

```json
{
  "mcpServers": {
    "image-gen": {
      "url": "https://image-mcp-worker.<your-subdomain>.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_AUTH_TOKEN>",
        "X-API-Key": "sk-your-key",
        "X-API-Base-URL": "https://your-provider.example.com/v1"
      }
    }
  }
}
```

## curl 示例

```bash
URL=http://localhost:8787   # 或已部署的 worker 地址
AUTH=(-H "Authorization: Bearer $MCP_AUTH_TOKEN")   # 未开启鉴权时 AUTH=()

curl -s $URL/health

curl -s $URL/mcp "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

curl -s $URL/mcp "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"generate_image","arguments":{"prompt":"霓虹灯下的赛博朋克武士猫","size":"1024x1024"}}}'

# 使用自己的服务商（多租户）
curl -s $URL/mcp "${AUTH[@]}" -H 'content-type: application/json' \
  -H "X-API-Key: sk-your-key" \
  -H "X-API-Base-URL: https://your-provider.example.com/v1" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"generate_image","arguments":{"prompt":"山间日落"}}}'

# 旧版 REST 接口
curl -s -X POST $URL/tools/generate_image "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"prompt":"吃竹子的小熊猫"}'

# 下载已存储的图片
curl -o image.png $URL/img/<id>.png
```

## 开发

需要 Node.js 20+。

```bash
npm install
cp .dev.vars.example .dev.vars   # 填写配置，已被 git 忽略
npm test                          # node:test，fetch 与 KV 均已 mock
npm run dev                       # wrangler dev
npm run check                     # 打包演练，不会部署
```

## Cloudflare KV 免费额度

| 资源 | 免费额度 |
|---|---|
| 读取 | 100,000 次/天 |
| **写入** | **1,000 次/天**（每生成一张图写入一次） |
| 存储 | 1 GB |

写入额度用完后图片仍会内联返回，只是没有下载链接。

## 项目结构

```
src/
  index.js       Worker 入口、路由、工具、REST 与图片端点
  provider.js    服务商配置解析与上游调用
  mcp.js         JSON-RPC / MCP 协议、CORS、Bearer 鉴权
  url-guard.js   对调用方提供的 base URL 做 SSRF 校验
test/            node:test 测试
```

## 许可证

本项目基于 GNU General Public License v3.0 发布，详见 [LICENSE](LICENSE)。
