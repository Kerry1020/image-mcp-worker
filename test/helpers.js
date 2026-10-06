import worker from "../src/index.js";

export const BASE = "https://worker.test";
// 1x1 transparent PNG
export const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export function mockFetch(t, handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    return handler(url, init, calls.length);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

export function okImage(extra = {}) {
  return Response.json({ data: [{ b64_json: PNG_B64, revised_prompt: "a revised prompt", ...extra }] });
}

export function memoryKV({ failPut = false } = {}) {
  const store = new Map();
  return {
    store,
    async put(key, value, opts) {
      if (failPut) throw new Error("KV put() limit exceeded for the day");
      store.set(key, { value, opts });
    },
    async get(key) {
      return store.get(key)?.value ?? null;
    },
    async getWithMetadata(key) {
      const e = store.get(key);
      return { value: e?.value ?? null, metadata: e?.opts?.metadata ?? null };
    },
  };
}

export const ENV = { API_KEY: "sk-env-secret", API_BASE_URL: "https://provider.example.com/v1/" };

export async function rpc(body, { env = ENV, headers = {} } = {}) {
  const res = await worker.fetch(
    new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    env,
  );
  const text = await res.text();
  return { res, status: res.status, body: text ? JSON.parse(text) : null };
}

export async function generate(args, opts) {
  return (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "generate_image", arguments: args } }, opts)).body;
}

export { worker };
