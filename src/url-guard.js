// SSRF guard: only allow http(s) URLs that point at public hosts.
//
// The WHATWG URL parser already normalises exotic IPv4 notations
// (e.g. "http://2130706433", "http://0x7f.1") into dotted-quad form and
// IPv6 literals into their compressed form, so checks below run on the
// canonical hostname.
//
// Limitation: hostnames are not resolved here, so a public DNS name that
// resolves to a private address (DNS rebinding) is not caught. On Cloudflare
// Workers outbound fetch() cannot reach private networks anyway; this guard
// is defence in depth and also protects local `wrangler dev` / Node runs.
// Here it guards caller-supplied X-API-Base-URL values.

export class UrlNotAllowedError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "UrlNotAllowedError";
    this.code = code;
  }
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
]);

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa", ".intranet"];

// [network, prefixLength]
const BLOCKED_IPV4 = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata (169.254.169.254)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];

function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function isBlockedIpv4Int(n) {
  for (const [net, bits] of BLOCKED_IPV4) {
    const base = ipv4ToInt(net);
    const size = 2 ** (32 - bits);
    if (n >= base && n < base + size) return true;
  }
  return false;
}

// Parse an IPv6 literal (without brackets) into 8 16-bit groups.
function parseIpv6(ip) {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  // Embedded IPv4 tail, e.g. ::ffff:127.0.0.1
  const v4 = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    if (n === null) return null;
    s = `${s.slice(0, -v4[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const out = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

function isBlockedIpv6(ip) {
  const g = parseIpv6(ip);
  if (!g) return true; // unparsable literal: refuse
  const embeddedV4 = (hi, lo) => isBlockedIpv4Int(hi * 65536 + lo);
  const allZero = (from, to) => g.slice(from, to).every((x) => x === 0);

  if (allZero(0, 8)) return true; // ::
  if (allZero(0, 7) && g[7] === 1) return true; // ::1
  if (allZero(0, 5) && g[5] === 0xffff) return embeddedV4(g[6], g[7]); // IPv4-mapped
  if (allZero(0, 6)) return embeddedV4(g[6], g[7]); // IPv4-compatible (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b && allZero(2, 6)) return embeddedV4(g[6], g[7]); // NAT64
  if (g[0] === 0x2002) return embeddedV4(g[1], g[2]); // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x0100 && allZero(1, 4)) return true; // discard-only 100::/64
  return false;
}

/** Returns true when the hostname (as produced by URL#hostname) must not be fetched. */
export function isBlockedHostname(hostname) {
  let host = String(hostname || "").toLowerCase().replace(/\.+$/, "");
  if (!host) return true;
  if (host.startsWith("[") && host.endsWith("]")) return isBlockedIpv6(host.slice(1, -1));
  if (host.includes(":")) return isBlockedIpv6(host);
  const v4 = ipv4ToInt(host);
  if (v4 !== null) return isBlockedIpv4Int(v4);
  if (/^[\d.]+$/.test(host)) return true; // malformed numeric host
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (!host.includes(".")) return true; // single-label names resolve on internal search domains
  return false;
}

/**
 * Validate an absolute URL and return the parsed URL object.
 * Throws UrlNotAllowedError for non-http(s) schemes, embedded credentials or
 * private / loopback / link-local / metadata hosts.
 */
export function assertPublicHttpUrl(input) {
  let parsed;
  try {
    parsed = input instanceof URL ? new URL(input.toString()) : new URL(String(input));
  } catch {
    throw new UrlNotAllowedError("invalid_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UrlNotAllowedError("unsupported_protocol", parsed.protocol);
  }
  if (parsed.username || parsed.password) {
    throw new UrlNotAllowedError("credentials_not_allowed");
  }
  if (isBlockedHostname(parsed.hostname)) {
    throw new UrlNotAllowedError("blocked_host", parsed.hostname);
  }
  return parsed;
}
