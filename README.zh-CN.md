# image-mcp-worker

[![CI](https://github.com/Kerry1020/image-mcp-worker/actions/workflows/ci.yml/badge.svg)](https://github.com/Kerry1020/image-mcp-worker/actions/workflows/ci.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-6E56CF)](https://modelcontextprotocol.io)

[English](README.md) | 简体中文

运行在 Cloudflare Workers 上的 [MCP](https://modelcontextprotocol.io/) 图像生成服务。它把提示词转发到任意 OpenAI 兼容的 `POST /images/generations` 接口（如 `gpt-image-1`），以 base64 内联返回图片，并可选提供直接下载链接。

## 功能特性

- **MCP Streamable HTTP**（JSON-RPC 2.0），端点 `POST /mcp`：支持 `initialize`、`ping`、`tools/list`、`tools/call`、通知与批量请求。无状态，仅返回 JSON。
- **自带服务商**：通过环境变量配置，或按请求通过请求头配置（多租户）。
- **直接下载链接**：可选 Cloudflare KV（`/img/{id}.png`、`?format=b64`），到期自动删除。
- **默认安全**：部署自身的 `API_KEY` 只会发往部署自身的 `API_BASE_URL`；调用方自定义的 base URL 必须是公网 `https` 主机，且必须同时提供调用方自己的 Key。可选 Bearer 鉴权（`MCP_AUTH_TOKEN`）。
- **健壮的上游处理**：超时控制；对非 JSON、非 2xx、重定向响应给出明确错误；错误信息中屏蔽 API Key；KV 写入失败也不会丢失已生成的图片。

## 快速开始

```bash
git clone https://github.com/Kerry1020/image-mcp-worker.git
cd image-mcp-worker
npm install
npx wrangler secret put API_KEY
npx wrangler secret put API_BASE_URL     # 例如 https://api.openai.com/v1
npx wrangler secret put MCP_AUTH_TOKEN   # 建议设置
npx wrangler deploy
```

然后在客户端中接入 `https://<your-worker>.workers.dev/mcp`（见 [MCP 客户端配置](#mcp-客户端配置)）。

## 工具列表

| 工具 | 参数 | 说明 |
|------|------|------|
| `generate_image` | `prompt`（字符串，必填，最长 32000 字符）、`size`（默认 `1024x1024`，可选 `1024x1536`、`1536x1024`、`auto`）、`model`（可选，覆盖默认模型） | 生成一张图片。返回一段文本（尺寸、模型、改写后的提示词、绑定 KV 时的下载链接）和一个包含 base64 数据的 `image` 内容块。 |

未知的 `size` 会回退为 `1024x1024`。如果服务商返回的是图片 URL 而不是 base64，文本中会给出该 URL，且不附带 `image` 内容块。

**错误处理：** 缺少或非法的 `prompt` / `model`、缺少服务商配置、`X-API-Base-URL` 不被允许时，返回 JSON-RPC 错误 `-32602`。服务商侧失败（HTTP 错误、超时、响应异常）返回 `isError: true` 的正常结果，原因写在文本内容里。

### HTTP 端点

| 方法 | 路径 | 鉴权* | 说明 |
|------|------|-------|------|
| `POST` | `/mcp` | 是 | MCP JSON-RPC 端点 |
| `POST` | `/tools/generate_image` | 是 | 旧版 REST：`{prompt, size?, model?}` -> `{result: {download_url, b64_json, size, model, revised_prompt}}` |
| `GET` | `/img/{id}.png` | 否 | 已存储的图片（需要 `IMAGE_KV`） |
| `GET` | `/img/{id}.png?format=b64` | 否 | `{id, mime_type, data}` |
| `GET` | `/health` | 否 | 健康检查 |
| `GET` | `/` | 否 | 服务信息与工具定义 |

\* 仅在设置了 `MCP_AUTH_TOKEN` 时需要。

对 `/mcp` 使用其他方法（如 `GET`）返回 `405`（不提供 SSE 流）。未绑定 `IMAGE_KV` 时 `/img/*` 返回 `500 KV not configured`，生成结果中也不会有下载链接。过期图片返回 `404`。

### curl 示例

```bash
URL=http://localhost:8787   # 或 https://<your-worker>.workers.dev
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
  -H "X-Model: gpt-image-1" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"generate_image","arguments":{"prompt":"山间日落"}}}'

# 旧版 REST 接口
curl -s -X POST $URL/tools/generate_image "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"prompt":"吃竹子的小熊猫","size":"1024x1024"}'

# 下载已存储的图片
curl -o image.png $URL/img/<id>.png
```

## 配置

服务商配置可以来自环境变量（部署级）或请求头（单次请求）。**优先级：请求头 > 环境变量 > 默认值。** 对于 `model`，工具参数的优先级最高。

| 名称 | 必填 | Secret | 默认值 | 说明 |
|---|---|---|---|---|
| `API_KEY` | 是（除非所有调用方都带 `X-API-Key`） | 是 | — | 服务商 API Key。对应请求头 `X-API-Key`。 |
| `API_BASE_URL` | 是（除非所有调用方都带 `X-API-Base-URL`） | 建议 | — | 服务商 base URL，如 `https://api.openai.com/v1`。对应请求头 `X-API-Base-URL`。 |
| `MODEL` | 否 | 否 | `gpt-image-1` | 默认模型。对应请求头 `X-Model`。 |
| `MCP_AUTH_TOKEN` | 否（建议设置） | 是 | 未设置 | 要求 `/mcp` 与 `/tools/*` 携带 `Authorization: Bearer <token>`。 |
| `ALLOW_HEADER_CONFIG` | 否 | 否 | `true` | 设为 `false` 时忽略 `X-API-Key` / `X-API-Base-URL`（单租户模式），`X-Model` 仍然生效。 |
| `CORS_ALLOW_ORIGIN` | 否 | 否 | `*` | `*` 或以逗号分隔的允许来源列表。 |
| `UPSTREAM_TIMEOUT_MS` | 否 | 否 | `120000` | 服务商请求超时，限定在 5000-600000 之间。 |
| `IMAGE_TTL_SECONDS` | 否 | 否 | `3600` | 图片在 KV 中的保留时间，限定在 60 秒到 30 天之间。 |
| `IMAGE_KV` | 否 | —（KV 绑定） | 未设置 | 启用下载链接。 |

当 `X-API-Base-URL` 与 `API_BASE_URL` 不同时，请求**必须**同时携带 `X-API-Key`，且该 URL 必须是公网主机上的 `https` 地址，以防调用方把运营者的 Key 引到自己控制的服务器上。

本地开发时把 `.dev.vars.example` 复制为 `.dev.vars`（已被 git 忽略）。

## MCP 客户端配置

Claude Code：

```bash
claude mcp add --transport http image-gen https://<your-worker>.workers.dev/mcp

# worker 设置了 MCP_AUTH_TOKEN 时
claude mcp add --transport http image-gen https://<your-worker>.workers.dev/mcp \
  --header "Authorization: Bearer <token>"
```

Claude Desktop / 通用 JSON 配置（通过 [`mcp-remote`](https://www.npmjs.com/package/mcp-remote)）：

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

如需使用自己的服务商，再追加几组 `--header`（如 `"X-API-Key: ${PROVIDER_KEY}"`、`"X-API-Base-URL: https://your-provider.example.com/v1"`）。原生支持远程 MCP 的客户端（如 Cursor）也可以直接用 `"url"` 加 `"headers"` 对象配置。

Hermes Agent：

```bash
hermes mcp add image-gen --transport http --url https://<your-worker>.workers.dev/mcp \
  --header "Authorization: Bearer <token>"
```

## 安全说明

- **公开部署务必设置 `MCP_AUTH_TOKEN`**（`npx wrangler secret put MCP_AUTH_TOKEN`），配置了 `API_KEY` 时尤其如此。否则任何知道 URL 的人都能调用 `/mcp` 和 `/tools/generate_image`，消耗你的服务商额度。
- Token 比较是常数时间的（比较 SHA-256 摘要）。鉴权失败返回 `401` 并带 `WWW-Authenticate: Bearer`。
- `/health`、`/` 和 `/img/*` 始终无需鉴权。图片链接本身就是为了分享，id 为 16 位随机字符，并在 `IMAGE_TTL_SECONDS` 后过期。
- 运营者的 `API_KEY` 不会发往调用方指定的 base URL；自定义 base URL 必须使用 `https`，并且指向私网、回环、链路本地或云元数据主机时会被拒绝（SSRF 防护；不做 DNS 解析）。设置 `ALLOW_HEADER_CONFIG=false` 可完全关闭按请求配置服务商。
- 不跟随上游重定向，错误信息中会屏蔽 API Key。

## 开发

需要 Node.js 20+。

```bash
npm install
cp .dev.vars.example .dev.vars   # 填写配置，已被 git 忽略
npm test                          # node:test，fetch 与 KV 均已 mock
npm run dev                       # wrangler dev，http://localhost:8787
npm run check                     # 打包演练，不会部署
```

项目结构：

```
src/
  index.js       Worker 入口、路由、工具、REST 与图片端点
  provider.js    服务商配置解析与上游调用
  mcp.js         JSON-RPC / MCP 协议、CORS、Bearer 鉴权
  url-guard.js   对调用方提供的 base URL 做 SSRF 校验
test/            node:test 测试
```

## 部署

1. Fork/克隆仓库并执行 `npm install`。
2. （可选）创建 KV 命名空间，然后在 `wrangler.toml` 中取消 `[[kv_namespaces]]` 的注释并填入返回的 id：
   ```bash
   npx wrangler kv namespace create IMAGE_KV
   ```
3. 设置密钥：
   ```bash
   npx wrangler secret put API_KEY
   npx wrangler secret put API_BASE_URL     # 例如 https://api.openai.com/v1
   npx wrangler secret put MCP_AUTH_TOKEN   # 建议设置
   ```
4. 执行 `npm run deploy`（或 `npx wrangler deploy`）部署。

### Cloudflare KV 免费额度

| 资源 | 免费额度 |
|---|---|
| 读取 | 100,000 次/天 |
| **写入** | **1,000 次/天**（每生成一张图写入一次） |
| 存储 | 1 GB |

写入额度用完后图片仍会内联返回，只是没有下载链接。

## 相关项目

- [time-mcp-worker](https://github.com/Kerry1020/time-mcp-worker) — 时区查询、时间换算与时间差计算
- [geo-mcp-worker](https://github.com/Kerry1020/geo-mcp-worker) — 基于 OpenStreetMap 服务的地理编码、POI 搜索与路线规划
- [memory-mcp-worker](https://github.com/Kerry1020/memory-mcp-worker) — 基于 KV 的 Agent 持久化记忆
- [webhook-inbox-mcp-worker](https://github.com/Kerry1020/webhook-inbox-mcp-worker) — 把 Webhook 收进 KV，再通过 MCP 工具读取
- [summarize-mcp-worker](https://github.com/Kerry1020/summarize-mcp-worker) — 网页正文提取与抽取式摘要
- [calc-mcp-worker](https://github.com/Kerry1020/calc-mcp-worker) — 数学计算：表达式、微积分、矩阵与统计
- [search-mcp-worker](https://github.com/Kerry1020/search-mcp-worker) — 多引擎网页搜索，排序规则公开可审计

## 许可证

本项目基于 GNU General Public License v3.0 发布，详见 [LICENSE](LICENSE)。
