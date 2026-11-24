// Feature 017: the reference front proxy for a self-hosted portal (SPEC.md L2-8; specs/017
// contracts/self-hosted-proxy.md P1-P10). T-PROXY-01. Caddy is not a dependency of the system: the file is checked
// by its directives here, and with CADDY_PATH pointing at a Caddy binary, `caddy validate` checks it too.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CADDYFILE = "docs/self-hosted/Caddyfile";
const README = "docs/self-hosted/README.md";
const text = readFileSync(CADDYFILE, "utf8");
/** The configuration without its comments: what Caddy reads. */
const config = text
  .split("\n")
  .map((l) => l.replace(/^\s*#.*$/, "").trimEnd())
  .filter((l) => l.trim() !== "")
  .join("\n");

/** Caddy's placeholders (`{$VAR:default}`, `{host}`, `{uri}`) hidden behind same-length text, so braces are blocks only. */
const masked = (source: string) => source.replace(/\{\$[A-Z_]+(?::[^}]*)?\}|\{(?:host|uri)\}/g, (m) => "_".repeat(m.length));

/** The body of the first block opening with `head {` at or after `from`, its braces balanced, and where it ends. */
function block(source: string, head: string, from = 0): { body: string; end: number } {
  const m = masked(source);
  const start = head === "" ? m.indexOf("{", from) : source.indexOf(`${head} {`, from);
  expect(start, head).toBeGreaterThanOrEqual(0);
  const open = m.indexOf("{", start + head.length);
  let depth = 0;
  for (let i = open; i < m.length; i++) {
    if (m[i] === "{") depth++;
    if (m[i] === "}" && --depth === 0) return { body: source.slice(open + 1, i), end: i };
  }
  throw new Error(`unclosed block ${head}`);
}
const ALLOW = "not remote_ip {$PORTAL_ALLOW_FROM:192.0.2.1/32}";

describe("T-PROXY-01 the reference Caddyfile does what the contract says (P1-P10)", () => {
  it("T-PROXY-01 P9 and the redirect: the admin endpoint stays local, and Caddy's own redirect server is off", () => {
    const global = block(config, "").body;
    expect(global).toMatch(/^\s*admin localhost:2019$/m);
    expect(global).toMatch(/^\s*auto_https disable_redirects$/m);
  });

  it("T-PROXY-01 P2, P3, P7: plain HTTP refuses anyone off the list, then redirects permanently, without Server", () => {
    const http = block(config, "http://{$PORTAL_HOST}").body;
    expect(http).toMatch(/^\s*header -Server$/m);
    const route = block(http, "route").body;
    const lines = route.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(lines).toEqual([`@outside ${ALLOW}`, "respond @outside 403", "redir https://{host}{uri} 308"]);
  });

  it("T-PROXY-01 P1, P3-P8: HTTPS with TLS 1.2 and 1.3, HSTS, no Server or Via, and the literal order allow-list, hidden routes, portal", () => {
    const httpEnd = block(config, "http://{$PORTAL_HOST}").end;
    const https = block(config, "{$PORTAL_HOST}", httpEnd).body;
    expect(block(https, "tls").body.trim()).toBe("protocols tls1.2 tls1.3");
    const headers = block(https, "header").body.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(headers).toEqual(['Strict-Transport-Security "max-age=31536000; includeSubDomains"', "-Server", "-Via"]);
    const route = block(https, "route").body.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(route).toEqual([
      `@outside ${ALLOW}`,
      "respond @outside 403",
      "@internal path /healthz /readyz /docs /docs/*",
      "respond @internal 404",
      "reverse_proxy 127.0.0.1:4025",
    ]);
    // Nothing answers outside that route: no handler at the site's own level.
    expect(https).not.toMatch(/^\t(reverse_proxy|respond|file_server|redir|handle)\b/m);
  });

  it("T-PROXY-01 P4, P10: the default allow-list refuses everyone, and the file holds no address or host name of anyone's", () => {
    // TEST-NET-1 (RFC 5737) is never a real client.
    expect(config.match(/\{\$PORTAL_ALLOW_FROM:([^}]*)\}/g)).toEqual([`{$PORTAL_ALLOW_FROM:192.0.2.1/32}`, `{$PORTAL_ALLOW_FROM:192.0.2.1/32}`]);
    const addresses = new Set(config.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []);
    expect([...addresses].sort()).toEqual(["127.0.0.1", "192.0.2.1"]);
    expect(config.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi) ?? []).toEqual([]);
    expect(config).not.toMatch(/token|secret|password|key/i);
  });

  it("T-PROXY-01 the procedure names the portal's settings behind the proxy and the on-host health check", () => {
    const readme = readFileSync(README, "utf8");
    for (const needed of ["TRUSTED_PROXY_HOPS=1", "PORTAL_BIND_HOST=127.0.0.1", "--mode deployment", "PORTAL_ALLOW_FROM", "127.0.0.1:4025/healthz"]) {
      expect(readme, needed).toContain(needed);
    }
    expect(readme).not.toContain("AUTH_JWKS_FILE=");
  });

  it.skipIf(!process.env.CADDY_PATH)("T-PROXY-01 caddy validate accepts the file", () => {
    const r = spawnSync(process.env.CADDY_PATH!, ["validate", "--adapter", "caddyfile", "--config", CADDYFILE], {
      env: { ...process.env, PORTAL_HOST: "portal.example" },
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
  });
});
