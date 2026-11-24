// Feature 017: a refused caller is told how to authenticate (SPEC.md L1-6, L2-8; RFC 6750 §3; specs/017
// contracts/portal-edge.md "401 and the challenge", contracts/hosted-agent-edge.md). T-EDGE-06.
import { afterEach, describe, expect, it } from "vitest";
import { DEV_AGENT_CLIENT } from "../scripts/dev-issuer-lib.js";
import { startHostedApp, type HostedTestApp, type StartHostedOptions } from "./helpers/hosted.js";
import { startPortal, type PortalTestApp, type StartPortalOptions } from "./helpers/portal.js";
import { rawRequest } from "./helpers/raw-request.js";

let open: Array<PortalTestApp | HostedTestApp> = [];
afterEach(async () => {
  await Promise.all(open.map((o) => o.close()));
  open = [];
});
const portal = async (o: StartPortalOptions = {}) => {
  const p = await startPortal(o);
  open.push(p);
  return p;
};
const agent = async (o: StartHostedOptions = {}) => {
  const a = await startHostedApp(o);
  open.push(a);
  return a;
};

/** Long expired: before any clock a test uses. */
const EXPIRED = 1_000_000_000;

describe("T-EDGE-06 every 401 carries the bearer challenge, and nothing else does (FR-024)", () => {
  it("T-EDGE-06 the portal: realm x402-portal, with invalid_token when a token was presented", async () => {
    const p = await portal();
    const me = (authorization?: string) => rawRequest(p.base, { path: "/api/me", ...(authorization !== undefined && { headers: { authorization } }) });
    const bare = await me();
    expect([bare.status, bare.headers["www-authenticate"]]).toEqual([401, 'Bearer realm="x402-portal"']);
    const presented: Array<[string, string]> = [
      ["a forged token", "Bearer a.b.c"],
      ["an expired token", `Bearer ${await p.token("alice", { exp: EXPIRED })}`],
      ["another audience", `Bearer ${await p.token("alice", { audience: "api://another-api" })}`],
      ["no sign-in time", `Bearer ${await p.token("alice", { authTime: undefined })}`],
    ];
    for (const [name, authorization] of presented) {
      const r = await me(authorization);
      expect([r.status, r.json, r.headers["www-authenticate"]], name).toEqual([401, { error: "unauthorized" }, 'Bearer realm="x402-portal", error="invalid_token"']);
    }
    // A valid token that isn't the portal's is 403, not a challenge.
    const forbidden = await me(`Bearer ${await p.token("alice", { azp: DEV_AGENT_CLIENT })}`);
    expect([forbidden.status, forbidden.headers["www-authenticate"]]).toEqual([403, undefined]);
    // The token check passes, so the answer is not a 401 either.
    expect((await me(`Bearer ${await p.token("alice")}`)).headers["www-authenticate"]).toBeUndefined();
  });

  it("T-EDGE-06 the agent: realm x402-agent, with invalid_token when a token was presented", async () => {
    const a = await agent();
    const run = (authorization?: string) =>
      rawRequest(a.base, {
        method: "POST",
        path: "/v1/runs",
        headers: { "content-type": "application/json", ...(authorization !== undefined && { authorization }) },
        body: JSON.stringify({ goal: "hi" }),
      });
    const bare = await run();
    expect([bare.status, bare.headers["www-authenticate"]]).toEqual([401, 'Bearer realm="x402-agent"']);
    // 019: the body gains error_code (T-AGT-16); the challenge is unchanged.
    for (const [name, authorization, code] of [
      ["a forged token", "Bearer a.b.c", "invalid_token"],
      ["an expired token", `Bearer ${await a.token("alice", { exp: EXPIRED })}`, "token_expired"],
      ["another audience", `Bearer ${await a.token("alice", { audience: "api://another-api" })}`, "invalid_token"],
    ] as const) {
      const r = await run(authorization);
      expect([r.status, r.json, r.headers["www-authenticate"]], name).toEqual([401, { error: "unauthorized", error_code: code }, 'Bearer realm="x402-agent", error="invalid_token"']);
    }
    const forbidden = await run(`Bearer ${await a.token("alice", { permissions: [] })}`);
    expect([forbidden.status, forbidden.headers["www-authenticate"]]).toEqual([403, undefined]);
  });

  it("T-EDGE-06 a 429 and a 421 carry no challenge, and no challenge has an error_description", async () => {
    const p = await portal({ maxRequestsPerAddress: 1 });
    const a = await agent({ maxRequestsPerAddress: 1 });
    const challenges: string[] = [];
    for (const [base, path, method] of [
      [p.base, "/api/me", "GET"],
      [a.base, "/v1/runs", "POST"],
    ] as const) {
      const first = await rawRequest(base, { method, path, headers: { authorization: "Bearer a.b.c" } });
      challenges.push(String(first.headers["www-authenticate"]));
      const limited = await rawRequest(base, { method, path });
      expect([limited.status, limited.headers["www-authenticate"]], base).toEqual([429, undefined]);
      // Both are in dev mode: a public host name is refused before any token check.
      const misdirected = await rawRequest(base, { method, path, host: "portal.example" });
      expect([misdirected.status, misdirected.headers["www-authenticate"]], base).toEqual([421, undefined]);
    }
    expect(challenges.every((c) => c.startsWith("Bearer realm=") && !c.includes("error_description"))).toBe(true);
  });
});
