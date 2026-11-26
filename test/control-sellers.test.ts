// 021 T-SEL-01 L2's seller hosts (SPEC L2-5 `GET /v1/sellers`; specs/021 contracts/control-api.md): the hosts any caller
// of the agent could be paid at, from L2's configuration. `CONTROL_TOKEN` only: the route reads no caller's token
// (INV-13, SEC-32), and L1's adapter sends none. No ledger read, no sweep, nothing appended.
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HttpAuthorizationGate } from "../src/layer1-intent/ports-http.js";
import { OTHER_HOST, SELLER_HOST, startUsersL2, testPlatform, TOKENS, type UsersL2 } from "./helpers/users.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function l2(o: Parameters<typeof startUsersL2>[0] = {}): Promise<UsersL2> {
  const s = await startUsersL2(o);
  closers.push(() => s.close());
  return s;
}

const sellers = (s: UsersL2, token: string | null = TOKENS.control, caller?: string) =>
  s.call<{ hosts?: string[]; error?: string }>("GET", "/v1/sellers", { token, ...(caller !== undefined && { caller }) });

describe("T-SEL-01 GET /v1/sellers: the hosts L2 would pay at, for the agent's role only", () => {
  it("T-SEL-01 user accounts off: the mandate's allowedHosts, sorted, lowercase and without duplicates", async () => {
    const s = await l2({ off: true, mandate: { allowedHosts: ["Seller.Example", "127.0.0.1:4021", "seller.example", "a.example"] } });
    const r = await sellers(s);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ hosts: ["127.0.0.1:4021", "a.example", "seller.example"] });
  });

  it("T-SEL-01 user accounts on: the union of the mandate's hosts and the platform seller list's", async () => {
    const s = await l2({ mandate: { allowedHosts: [SELLER_HOST, "Mandate-Only.example"] }, platform: testPlatform({ sellers: [{ host: OTHER_HOST, name: "Second", payees: [] }, { host: "platform.example", name: "Third", payees: [] }] }) });
    const r = await sellers(s);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ hosts: [SELLER_HOST, OTHER_HOST, "mandate-only.example", "platform.example"].sort() });
  });

  it("T-SEL-01 every other role's token, an unknown token and no token get 401", async () => {
    const s = await l2();
    for (const token of [TOKENS.settlement, TOKENS.operator, TOKENS.portal, TOKENS.portalAdmin, "u-verifier", null]) {
      const r = await sellers(s, token);
      expect(r.status, String(token)).toBe(401);
      expect(r.body).toEqual({ error: "unauthorized" });
    }
  });

  it("T-SEL-01 the route reads no caller's token (INV-13): none, a machine caller's and a malformed one get the same 200", async () => {
    const s = await l2();
    const machine = await s.callers.machine();
    const answers = await Promise.all([sellers(s), sellers(s, TOKENS.control, machine), sellers(s, TOKENS.control, "not-a-token")]);
    for (const r of answers) expect([r.status, r.body]).toEqual([200, { hosts: [SELLER_HOST, OTHER_HOST].sort() }]);
  });

  it("T-SEL-01 nothing is appended and nothing is swept: the ledger file is byte-identical after 100 calls", async () => {
    const s = await l2();
    const before = readFileSync(s.ledgerFile);
    for (let i = 0; i < 100; i++) expect((await sellers(s)).status).toBe(200);
    s.clock.advance(3_600_000);
    expect((await sellers(s)).status).toBe(200);
    expect(readFileSync(s.ledgerFile).equals(before)).toBe(true);
  });

  it("T-SEL-01 L1's adapter: sellers() on a gate made for a caller sends CONTROL_TOKEN and no X-Caller-Authorization", async () => {
    const seen: IncomingHttpHeaders[] = [];
    const paths: string[] = [];
    const server = createServer((req, res) => {
      seen.push(req.headers);
      paths.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ hosts: ["seller.example"] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    closers.push(() => new Promise<void>((r) => server.close(() => r())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const gate = new HttpAuthorizationGate(base, "c-token").forCaller("a-callers-token");
    expect(await gate.sellers!()).toEqual({ hosts: ["seller.example"] });
    expect(paths).toEqual(["/v1/sellers"]);
    expect(seen[0]!.authorization).toBe("Bearer c-token");
    expect(seen[0]!["x-caller-authorization"]).toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain("a-callers-token");
  });

  it("T-SEL-01 L1's adapter: a non-2xx answer throws", async () => {
    const s = await l2();
    await expect(new HttpAuthorizationGate(s.url, "wrong-token").sellers()).rejects.toThrow();
  });
});
