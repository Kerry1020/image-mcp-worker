import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, ENV, PNG_B64, generate, memoryKV, mockFetch, okImage, rpc, worker } from "./helpers.js";

test("GET /health and / return service info", async () => {
  const health = await (await worker.fetch(new Request(`${BASE}/health`), {})).json();
  assert.equal(health.ok, true);
  assert.equal(health.name, "image-mcp-worker");
  assert.deepEqual(health.tools, ["generate_image"]);
  assert.equal(health.kv_configured, false);
  const root = await (await worker.fetch(new Request(`${BASE}/`), {})).json();
  assert.equal(root.tools[0].name, "generate_image");
  assert.deepEqual(root.config_headers, ["X-API-Key", "X-API-Base-URL", "X-Model"]);
});

test("CORS preflight allows provider headers", async () => {
  const res = await worker.fetch(new Request(`${BASE}/mcp`, { method: "OPTIONS" }), {});
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(res.headers.get("access-control-allow-headers"), /x-api-base-url/);
  assert.match(res.headers.get("access-control-allow-headers"), /authorization/);
});

test("404 and 405", async () => {
  assert.equal((await worker.fetch(new Request(`${BASE}/nope`), {})).status, 404);
  assert.equal((await worker.fetch(new Request(`${BASE}/mcp`), {})).status, 405);
});

test("initialize, ping, tools/list", async () => {
  const init = (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })).body;
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.equal(init.result.serverInfo.name, "image-mcp");
  assert.deepEqual((await rpc({ jsonrpc: "2.0", id: 2, method: "ping" })).body.result, {});
  const list = (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" })).body.result.tools;
  assert.equal(list[0].name, "generate_image");
  assert.deepEqual(list[0].inputSchema.required, ["prompt"]);
});

test("notifications return 202 without body", async () => {
  const r = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(r.status, 202);
  assert.equal(r.body, null);
});

test("JSON-RPC error codes", async () => {
  assert.equal((await rpc("nope")).body.error.code, -32700);
  assert.equal((await rpc({ id: 1, method: "ping" })).body.error.code, -32600);
  assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "resources/list" })).body.error.code, -32601);
  assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope" } })).body.error.code, -32602);
  assert.equal((await generate({})).error.code, -32602);
  assert.equal((await generate({ prompt: "x" }, { env: {} })).error.code, -32602);
});

test("generate_image calls provider and stores in KV", async (t) => {
  const calls = mockFetch(t, () => okImage());
  const kv = memoryKV();
  const body = await generate({ prompt: "a cat", size: "1024x1536" }, { env: { ...ENV, IMAGE_KV: kv } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://provider.example.com/v1/images/generations");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-env-secret");
  assert.equal(calls[0].init.redirect, "manual");
  assert.ok(calls[0].init.signal);
  assert.deepEqual(calls[0].body, { model: "gpt-image-1", prompt: "a cat", n: 1, size: "1024x1536", response_format: "b64_json" });

  const [text, image] = body.result.content;
  assert.match(text.text, /^Image generated \(1024x1536, gpt-image-1\)/);
  assert.match(text.text, /Revised prompt: a revised prompt/);
  const url = text.text.match(/Download URL: (\S+)/)[1];
  assert.match(url, /^https:\/\/worker\.test\/img\/[a-z2-7]{16}\.png$/);
  assert.deepEqual(image, { type: "image", data: PNG_B64, mimeType: "image/png" });

  const id = url.match(/img\/(\w+)\.png/)[1];
  assert.equal(kv.store.get(id).opts.expirationTtl, 3600);

  const png = await worker.fetch(new Request(url), { IMAGE_KV: kv });
  assert.equal(png.status, 200);
  assert.equal(png.headers.get("content-type"), "image/png");
  const bytes = new Uint8Array(await png.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

  const b64 = await (await worker.fetch(new Request(`${url}?format=b64`), { IMAGE_KV: kv })).json();
  assert.deepEqual(b64, { id, mime_type: "image/png", data: PNG_B64 });
});

test("image endpoint errors", async () => {
  assert.equal((await worker.fetch(new Request(`${BASE}/img/../x.png`), {})).status, 404);
  assert.equal((await worker.fetch(new Request(`${BASE}/img/abc.png`), {})).status, 500);
  assert.equal((await worker.fetch(new Request(`${BASE}/img/abc.png`), { IMAGE_KV: memoryKV() })).status, 404);
  assert.equal((await worker.fetch(new Request(`${BASE}/img/ABC.png`), { IMAGE_KV: memoryKV() })).status, 404);
});

test("without KV no broken download URL is returned", async (t) => {
  mockFetch(t, () => okImage());
  const body = await generate({ prompt: "a cat" });
  assert.doesNotMatch(body.result.content[0].text, /Download URL: http/);
  assert.match(body.result.content[0].text, /IMAGE_KV not bound/);
  assert.equal(body.result.content[1].data, PNG_B64);
});

test("KV write failure still returns the image", async (t) => {
  mockFetch(t, () => okImage());
  const body = await generate({ prompt: "a cat" }, { env: { ...ENV, IMAGE_KV: memoryKV({ failPut: true }) } });
  assert.equal(body.result.isError, undefined);
  assert.match(body.result.content[0].text, /KV write failed/);
  assert.equal(body.result.content[1].type, "image");
});

test("upstream errors become isError results and never leak the key", async (t) => {
  mockFetch(t, () => Response.json({ error: { message: "bad key sk-env-secret" } }, { status: 401 }));
  const body = await generate({ prompt: "a cat" });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /HTTP 401/);
  assert.doesNotMatch(JSON.stringify(body), /sk-env-secret/);
});

test("upstream non-JSON, redirect, network error and timeout", async (t) => {
  let mode = "html";
  mockFetch(t, (url, init) => {
    if (mode === "html") return new Response("<html>502 Bad Gateway</html>", { status: 502 });
    if (mode === "redirect") return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } });
    if (mode === "network") throw new TypeError("connection refused");
    return new Promise((resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error("abort never fired")), 10_000);
      init.signal.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        reject(init.signal.reason);
      });
    });
  });
  assert.match((await generate({ prompt: "x" })).result.content[0].text, /non-JSON/);
  mode = "redirect";
  assert.match((await generate({ prompt: "x" })).result.content[0].text, /redirect/);
  mode = "network";
  assert.match((await generate({ prompt: "x" })).result.content[0].text, /connection refused/);
  mode = "timeout";
  const r = (await generate({ prompt: "x" }, { env: { ...ENV, UPSTREAM_TIMEOUT_MS: "5000" } })).result;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /timed out after 5000ms/);
});

test("provider returning a URL instead of b64", async (t) => {
  mockFetch(t, () => Response.json({ data: [{ url: "https://cdn.provider.example/img.png" }] }));
  const body = await generate({ prompt: "x" });
  assert.match(body.result.content[0].text, /Provider image URL: https:\/\/cdn\.provider\.example\/img\.png/);
  assert.equal(body.result.content.length, 1);
});

test("multi-tenant headers route to caller's provider", async (t) => {
  const calls = mockFetch(t, () => okImage());
  await generate(
    { prompt: "x" },
    { env: {}, headers: { "x-api-key": "sk-user", "x-api-base-url": "https://user-provider.example/v1", "x-model": "dall-e-3" } },
  );
  assert.equal(calls[0].url, "https://user-provider.example/v1/images/generations");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-user");
  assert.equal(calls[0].body.model, "dall-e-3");
});

test("operator key is not sent to a caller-chosen base URL", async (t) => {
  const calls = mockFetch(t, () => okImage());
  const body = await generate({ prompt: "x" }, { headers: { "x-api-base-url": "https://attacker.example/v1" } });
  assert.equal(body.error.code, -32602);
  assert.equal(calls.length, 0);
});

test("SSRF: private X-API-Base-URL is rejected", async (t) => {
  const calls = mockFetch(t, () => okImage());
  const body = await generate({ prompt: "x" }, { env: {}, headers: { "x-api-key": "k", "x-api-base-url": "https://169.254.169.254/v1" } });
  assert.equal(body.error.code, -32602);
  assert.equal(calls.length, 0);
});

test("MCP_AUTH_TOKEN protects /mcp and REST but not health or images", async (t) => {
  mockFetch(t, () => okImage());
  const env = { ...ENV, MCP_AUTH_TOKEN: "tok" };
  assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { env })).status, 401);
  assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { env, headers: { authorization: "Bearer tok" } })).status, 200);
  const rest = await worker.fetch(new Request(`${BASE}/tools/generate_image`, { method: "POST", body: '{"prompt":"x"}' }), env);
  assert.equal(rest.status, 401);
  assert.equal((await worker.fetch(new Request(`${BASE}/health`), env)).status, 200);
});

test("legacy REST endpoint", async (t) => {
  const calls = mockFetch(t, () => okImage());
  const post = (body, env = ENV) =>
    worker.fetch(new Request(`${BASE}/tools/generate_image`, { method: "POST", headers: { "content-type": "application/json" }, body }), env);

  const ok = await post(JSON.stringify({ prompt: "panda", size: "1536x1024", model: "m1" }), { ...ENV, IMAGE_KV: memoryKV() });
  assert.equal(ok.status, 200);
  const { result } = await ok.json();
  assert.match(result.download_url, /^https:\/\/worker\.test\/img\/\w+\.png$/);
  assert.equal(result.b64_json, PNG_B64);
  assert.equal(result.size, "1536x1024");
  assert.equal(result.model, "m1");
  assert.equal(result.revised_prompt, "a revised prompt");
  assert.equal(calls[0].body.model, "m1");

  assert.equal((await post("{bad")).status, 400);
  const missing = await post("{}");
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { error: "missing prompt" });
  assert.equal((await post('{"prompt":"x"}', {})).status, 400);
});

test("legacy REST upstream failure is 502", async (t) => {
  mockFetch(t, () => Response.json({ error: { message: "quota" } }, { status: 429 }));
  const res = await worker.fetch(new Request(`${BASE}/tools/generate_image`, { method: "POST", body: '{"prompt":"x"}' }), ENV);
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error, "generation_failed");
  assert.match(body.detail, /quota/);
});
