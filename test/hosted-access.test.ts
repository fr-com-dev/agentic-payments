// 011 hosted agent service: requester access (SPEC.md L1-6, §11 SEC-14; specs/011 contracts/access-and-sessions.md).
// T-AGT-03: Entra-shaped tokens with Agent.Run, checked before any model or L2 call.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Express } from "express";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { HttpAuthorizationGate, HttpSettlementVerifier } from "../src/layer1-intent/ports-http.js";
import { fakePorts, mockModel, startHostedApp, text, toolCall, type HostedTestApp } from "./helpers/hosted.js";

let apps: HostedTestApp[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

async function start(...args: Parameters<typeof startHostedApp>) {
  const a = await startHostedApp(...args);
  apps.push(a);
  return a;
}

async function get(base: string, path: string, token?: string) {
  const res = await fetch(base + path, { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("T-AGT-03 tokens (foundational)", () => {
  it("no Authorization header → 401 unauthorized", async () => {
    const a = await start();
    expect(await get(a.base, "/v1/runs")).toEqual({ status: 401, body: { error: "unauthorized" } });
  });

  it("a garbage token → 401", async () => {
    const a = await start();
    expect((await get(a.base, "/v1/runs", "not-a-jwt")).status).toBe(401);
  });

  it("a token signed by another key → 401", async () => {
    const a = await start();
    const { privateKey } = await generateKeyPair("ES256");
    const forged = await new SignJWT({ oid: "mallory", tid: "dev", roles: ["Agent.Run"] })
      .setProtectedHeader({ alg: "ES256", kid: "x402-dev-1" })
      .setIssuer("urn:x402:dev-issuer")
      .setAudience("api://x402-l1-agent")
      .setExpirationTime("1h")
      .sign(privateKey);
    expect((await get(a.base, "/v1/runs", forged)).status).toBe(401);
  });

  it("/healthz needs no token", async () => {
    const a = await start();
    expect(await get(a.base, "/healthz")).toEqual({ status: 200, body: { status: "ok" } });
  });

  it("an unknown path answers 404 after auth, and 401 without a token (routes are not revealed)", async () => {
    const a = await start();
    const token = await a.token("alice");
    expect(await get(a.base, "/api/agents", token)).toEqual({ status: 404, body: { error: "not found" } });
    expect((await get(a.base, "/api/agents")).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// T-AGT-03 no forwarding (US2, FR-009): L2 and L3 only ever see their own role tokens
// ---------------------------------------------------------------------------

describe("T-AGT-03 no forwarding", () => {
  it("after a paid run, L2 saw only CONTROL_TOKEN, L3 only VERIFIER_TOKEN, and nobody saw the requester's JWT", async () => {
    const servers: Server[] = [];
    const listen = async (app: Express) => {
      const srv = await new Promise<Server>((r) => {
        const x = app.listen(0, "127.0.0.1", () => r(x));
      });
      servers.push(srv);
      return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    };
    const seen = { l2: [] as string[], l3: [] as string[], seller: [] as string[] };
    const req = { scheme: "exact", network: "eip155:31337", asset: "0x5FbDB2315678afecb367f032d93F642f64180aa3", amount: "1000", payTo: "0x90F79bf6EB2c4f870365E785982E1f101E93b906", maxTimeoutSeconds: 120, extra: { name: "USD Coin", version: "2" } };

    const sellerApp = express();
    sellerApp.get("/api/weather", (r, res) => {
      seen.seller.push(String(r.headers.authorization ?? ""));
      if (!r.headers["payment-signature"]) {
        const url = `http://${r.headers.host}${r.originalUrl}`;
        res.status(402).set("PAYMENT-REQUIRED", encodePaymentRequiredHeader({ x402Version: 2, resource: { url }, accepts: [req] } as never)).json({});
        return;
      }
      res.json({ city: "Lima" });
    });
    const sellerUrl = await listen(sellerApp);

    const l2 = express();
    l2.use((r, _res, next) => {
      seen.l2.push(String(r.headers.authorization ?? ""));
      next();
    });
    l2.post("/v1/authorize", express.json(), (r, res) =>
      res.json({ status: "AUTHORIZED", authorizationId: "auth_ok", intentId: r.body.intentId, requirement: req, paymentHeaders: { "PAYMENT-SIGNATURE": "opaque" }, payer: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", validBefore: 1_900_000_000, remainingSessionBudgetAtomic: "99000" }),
    );
    l2.get("/v1/budget/:id", (r, res) =>
      res.json({ sessionId: r.params.id, asset: req.asset, decimals: 6, sessionCapAtomic: "100000", spentOrReservedAtomic: "1000", remainingAtomic: "99000", perPaymentCapAtomic: "20000" }),
    );
    const l2Url = await listen(l2);

    const l3 = express();
    l3.post("/v1/settlements", express.json(), (r, res) => {
      seen.l3.push(String(r.headers.authorization ?? ""));
      res.json({ authorizationId: r.body.authorizationId, status: "CONFIRMED", transaction: "0xabc", network: req.network, finalityClass: "included", detail: "ok", observedAt: new Date().toISOString(), verified: { asset: req.asset, payer: r.body.payer, payTo: req.payTo, amount: req.amount } });
    });
    const l3Url = await listen(l3);

    const model = mockModel([toolCall("fetch_resource", { url: `${sellerUrl}/api/weather?city=Lima`, purpose: "weather" }), toolCall("check_budget", {}), text("done")]);
    const a = await start({
      model,
      gate: new HttpAuthorizationGate(l2Url, "t-control"),
      settlement: new HttpSettlementVerifier(l3Url, "t-verifier"),
      env: { SELLER_URL: sellerUrl },
    });
    try {
      const jwt = await a.token("alice");
      const res = await fetch(`${a.base}/v1/runs`, { method: "POST", headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" }, body: JSON.stringify({ goal: "weather" }) });
      const body = (await res.json()) as { steps: { result: { outcome: string } }[] };
      expect(body.steps.map((s) => s.result.outcome)).toEqual(["PAID", undefined]);
      expect(seen.l2.length).toBeGreaterThanOrEqual(2);
      expect(new Set(seen.l2)).toEqual(new Set(["Bearer t-control"]));
      expect(seen.l3).toEqual(["Bearer t-verifier"]);
      expect(seen.seller.every((h) => h === "")).toBe(true);
      for (const h of [...seen.l2, ...seen.l3, ...seen.seller]) expect(h).not.toContain(jwt);
    } finally {
      await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    }
  });
});

// ---------------------------------------------------------------------------
// T-AGT-03 access matrix (US3): every refusal happens before any model or L2 call, within 1 s
// ---------------------------------------------------------------------------

describe("T-AGT-03 access matrix", () => {
  const nowSec = () => Math.floor(Date.now() / 1000);

  it("bad tokens get 401, a token without Agent.Run gets 403; none reaches the model or L2, each within 1,000 ms", async () => {
    const model = mockModel();
    const ports = fakePorts();
    const a = await start({ model, gate: ports.gate, settlement: ports.settlement });
    const cases: [string, Parameters<HostedTestApp["token"]>[1], number][] = [
      ["expired", { exp: nowSec() - 120 }, 401],
      ["not yet valid", { nbf: nowSec() + 300 }, 401],
      ["wrong audience", { audience: "api://someone-else" }, 401],
      ["wrong issuer", { issuer: "https://login.microsoftonline.com/other/v2.0" }, 401],
      ["wrong tenant", { tenant: "other-tenant" }, 401],
      ["no oid", { omitOid: true }, 401],
      ["no role", { roles: [] }, 403],
      ["another role", { roles: ["Agent.Read"] }, 403],
    ];
    for (const [name, o, status] of cases) {
      const t0 = Date.now();
      const r = await a.run("alice", { goal: "hi" }, o);
      expect(r.status, name).toBe(status);
      expect(r.body, name).toEqual(status === 401 ? { error: "unauthorized" } : { error: "forbidden" });
      expect(Date.now() - t0, name).toBeLessThan(1_000);
    }
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(ports.gateCalls).toHaveLength(0);
  });

  it("a person's token and a service identity's token with Agent.Run both run", async () => {
    const a = await start();
    expect((await a.run("alice", { goal: "hi" })).status).toBe(200);
    expect((await a.run("svc-app-id", { goal: "hi" }, { idtyp: "app" })).status).toBe(200);
  });

  it("must-fail: with the test-only bypassAuth hook, an unauthenticated request reaches the model", async () => {
    const model = mockModel();
    const a = await start({ model, bypassAuth: true });
    expect((await a.run(null, { goal: "hi" })).status).toBe(200);
    expect(model.doGenerateCalls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// T-AGT-03 limits (US3, FR-014): 2 concurrent runs and 20 starts per sliding hour per requester
// ---------------------------------------------------------------------------

describe("T-AGT-03 limits", () => {
  it("a third concurrent run gets 429 with Retry-After 5; another requester is unaffected", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const model = mockModel(async () => {
      await gate;
      return text("done");
    });
    const a = await start({ model });
    const first = [a.run("alice", { goal: "1" }), a.run("alice", { goal: "2" })];
    await new Promise((r) => setTimeout(r, 200));
    const third = await a.run("alice", { goal: "3" });
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("5");
    const bob = a.run("bob", { goal: "b" });
    await new Promise((r) => setTimeout(r, 100));
    release();
    expect((await Promise.all(first)).map((r) => r.status)).toEqual([200, 200]);
    expect((await bob).status).toBe(200);
    expect((await a.run("alice", { goal: "4" })).status).toBe(200);
  });

  it("the 21st start within an hour gets 429 until the oldest start ages out; refused bodies don't count", async () => {
    let t = Date.parse("2026-10-22T00:00:00Z");
    const a = await start({ now: () => t });
    for (let i = 0; i < 5; i++) expect((await a.run("alice", { goal: "" })).status).toBe(400);
    for (let i = 0; i < 20; i++) {
      expect((await a.run("alice", { goal: `run ${i}` })).status).toBe(200);
      t += 60_000;
    }
    const over = await a.run("alice", { goal: "21" });
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe(String(3_600 - 20 * 60));
    expect((await a.run("bob", { goal: "b" })).status).toBe(200);
    t += Number(over.headers.get("retry-after")) * 1000 - 1_000;
    expect((await a.run("alice", { goal: "one second early" })).status).toBe(429);
    t += 1_000;
    expect((await a.run("alice", { goal: "after" })).status).toBe(200);
  });

  it("a failed run still releases its concurrency slot", async () => {
    const model = mockModel(async () => {
      throw new Error("down");
    });
    const a = await start({ model });
    for (let i = 0; i < 4; i++) {
      const r = await a.run("alice", { goal: "x" });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe("failed");
    }
  });
});
