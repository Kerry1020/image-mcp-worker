import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPublicHttpUrl, isBlockedHostname } from "../src/url-guard.js";

const blocked = [
  "http://localhost/",
  "http://LOCALHOST./",
  "http://127.0.0.1/",
  "http://127.1/",
  "http://2130706433/",
  "http://0x7f000001/",
  "http://0177.0.0.1/",
  "http://0.0.0.0/",
  "http://10.1.2.3/",
  "http://172.16.0.1/",
  "http://172.31.255.255/",
  "http://192.168.1.1/",
  "http://100.64.0.1/",
  "http://169.254.169.254/latest/meta-data/",
  "http://metadata.google.internal/",
  "http://foo.internal/",
  "http://printer.local/",
  "http://intranet/",
  "http://[::1]/",
  "http://[::]/",
  "http://[::ffff:127.0.0.1]/",
  "http://[::ffff:a9fe:a9fe]/",
  "http://[fd00::1]/",
  "http://[fe80::1]/",
  "http://[64:ff9b::7f00:1]/",
  "http://[2002:7f00:1::]/",
  "http://224.0.0.1/",
  "http://255.255.255.255/",
];

for (const url of blocked) {
  test(`blocks ${url}`, () => {
    assert.throws(() => assertPublicHttpUrl(url), (e) => e.code === "blocked_host");
  });
}

const allowed = ["https://example.com/", "http://8.8.8.8/", "https://[2606:4700:4700::1111]/", "https://172.32.0.1/", "https://sub.example.co.uk:8443/x"];
for (const url of allowed) {
  test(`allows ${url}`, () => {
    assert.equal(assertPublicHttpUrl(url).toString(), new URL(url).toString());
  });
}

test("rejects non-http(s) schemes and credentials", () => {
  assert.throws(() => assertPublicHttpUrl("ftp://example.com/"), (e) => e.code === "unsupported_protocol");
  assert.throws(() => assertPublicHttpUrl("file:///etc/passwd"), (e) => e.code === "unsupported_protocol");
  assert.throws(() => assertPublicHttpUrl("https://user:pw@example.com/"), (e) => e.code === "credentials_not_allowed");
  assert.throws(() => assertPublicHttpUrl("not a url"), (e) => e.code === "invalid_url");
});


test("isBlockedHostname handles empty and odd input", () => {
  assert.equal(isBlockedHostname(""), true);
  assert.equal(isBlockedHostname("1.2.3"), true);
  assert.equal(isBlockedHostname("example.com"), false);
});
