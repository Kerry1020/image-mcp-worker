import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, detectMime, resolveConfig, validateArgs } from "../src/provider.js";

const req = (headers = {}) => new Request("https://w.test/mcp", { method: "POST", headers });
const ENV = { API_KEY: "sk-env", API_BASE_URL: "https://provider.example.com/v1/" };

test("env config, trailing slash trimmed, default model", () => {
  assert.deepEqual(resolveConfig(req(), ENV), { apiKey: "sk-env", baseUrl: "https://provider.example.com/v1", model: "gpt-image-1" });
});

test("model priority: args > X-Model > env > default", () => {
  assert.equal(resolveConfig(req({ "x-model": "h" }), { ...ENV, MODEL: "e" }, { model: "a" }).model, "a");
  assert.equal(resolveConfig(req({ "x-model": "h" }), { ...ENV, MODEL: "e" }).model, "h");
  assert.equal(resolveConfig(req(), { ...ENV, MODEL: "e" }).model, "e");
  assert.throws(() => resolveConfig(req(), ENV, { model: "bad model\n" }), ConfigError);
});

test("header key alone is used with env base URL", () => {
  assert.equal(resolveConfig(req({ "x-api-key": "sk-user" }), ENV).apiKey, "sk-user");
});

test("custom base URL never receives the env API_KEY", () => {
  assert.throws(() => resolveConfig(req({ "x-api-base-url": "https://attacker.example/v1" }), ENV), /X-API-Key header is required/);
  const cfg = resolveConfig(req({ "x-api-base-url": "https://other.example/v1", "x-api-key": "sk-user" }), ENV);
  assert.deepEqual([cfg.apiKey, cfg.baseUrl], ["sk-user", "https://other.example/v1"]);
});

test("same base URL as env may use env key", () => {
  assert.equal(resolveConfig(req({ "x-api-base-url": "https://provider.example.com/v1" }), ENV).apiKey, "sk-env");
});

test("custom base URL must be public https", () => {
  for (const base of ["http://other.example/v1", "https://127.0.0.1/v1", "https://169.254.169.254/", "https://localhost/v1", "ftp://x.example/"]) {
    assert.throws(() => resolveConfig(req({ "x-api-base-url": base, "x-api-key": "k" }), {}), ConfigError, base);
  }
});

test("ALLOW_HEADER_CONFIG=false ignores provider headers", () => {
  const cfg = resolveConfig(req({ "x-api-base-url": "https://other.example/v1", "x-api-key": "sk-user" }), { ...ENV, ALLOW_HEADER_CONFIG: "false" });
  assert.deepEqual([cfg.apiKey, cfg.baseUrl], ["sk-env", "https://provider.example.com/v1"]);
});

test("missing config errors", () => {
  assert.throws(() => resolveConfig(req(), {}), /No API key/);
  assert.throws(() => resolveConfig(req({ "x-api-key": "k" }), {}), /No API base URL/);
});

test("validateArgs", () => {
  assert.deepEqual(validateArgs({ prompt: "  cat " }), { prompt: "cat", size: "1024x1024" });
  assert.equal(validateArgs({ prompt: "cat", size: "1536x1024" }).size, "1536x1024");
  assert.equal(validateArgs({ prompt: "cat", size: "9x9" }).size, "1024x1024");
  assert.throws(() => validateArgs({}), /Missing required parameter: prompt/);
  assert.throws(() => validateArgs({ prompt: 5 }), /prompt must be a string/);
  assert.throws(() => validateArgs({ prompt: "x".repeat(32_001) }), /exceeds/);
});

test("detectMime", () => {
  assert.equal(detectMime("iVBORw0KGgoAAAA"), "image/png");
  assert.equal(detectMime("/9j/4AAQSkZJRg"), "image/jpeg");
  assert.equal(detectMime(btoa("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
});
