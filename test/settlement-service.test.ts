// Feature 005 — L3 settlement service (SPEC.md §8.3 L3-2): auth, validation, reconcile push, PENDING
// re-checks. The real-chain checks (T-E2E-01 L3 side, T-E2E-03) live in test/e2e.local.test.ts (008).
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PaymentRequirements } from "@x402/core/types";
import {
  createSettlementService,
  HttpReconciler,
  type SettlementServiceDeps,
} from "../src/layer3-settlement/service.js";
import type { ReconciliationPort, SettlementClaim, SettlementReport, SettlementStatus } from "../src/shared/contracts.js";

const TOKENS = { verifier: "t-verifier", control: "t-control", settlement: "t-settlement", operator: "t-operator" };
const ASSET = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const PAY_TO = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const PAYER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

const requirement: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:31337",
  asset: ASSET,
  amount: "1000",
  payTo: PAY_TO,
  maxTimeoutSeconds: 120,
  extra: { name: "USD Coin", version: "2" },
};
const claim = (id = "auth_1"): SettlementClaim => ({
  authorizationId: id,
  requirement,
  payer: PAYER,
  validBefore: 1_900_000_000,
  httpStatus: 200,
  paymentResponseHeader: "x",
});
const reportFor = (c: SettlementClaim, status: SettlementStatus): SettlementReport => ({
  authorizationId: c.authorizationId,
  status,
  network: c.requirement.network,
  finalityClass: "included",
  detail: status,
  observedAt: new Date().toISOString(),
  verified: { asset: c.requirement.asset, payer: c.payer, payTo: c.requirement.payTo, amount: c.requirement.amount },
});

/** Verifier double returning a scripted status sequence (the last one repeats). */
function scriptedVerifier(statuses: SettlementStatus[]) {
  const calls: SettlementClaim[] = [];
  return {
    calls,
    async verify(c: SettlementClaim) {
      const s = statuses[Math.min(calls.length, statuses.length - 1)]!;
      calls.push(c);
      return reportFor(c, s);
    },
  };
}
function recordingReconciler(impl?: () => Promise<void>): ReconciliationPort & { reports: SettlementReport[] } {
  const reports: SettlementReport[] = [];
  return {
    reports,
    async reconcile(r) {
      reports.push(r);
      if (impl) await impl();
    },
  };
}

let servers: Server[] = [];
const services: { stop(): void }[] = [];
async function listen(app: express.Express): Promise<string> {
  const server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  for (const s of services.splice(0)) s.stop();
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers = [];
});

async function start(over: Partial<SettlementServiceDeps> & Pick<SettlementServiceDeps, "verifier">) {
  const logs: string[] = [];
  const reconciler = (over.reconciler as ReturnType<typeof recordingReconciler>) ?? recordingReconciler();
  const svc = createSettlementService({
    reconciler,
    token: TOKENS.verifier,
    log: (m) => logs.push(m),
    ...over,
  });
  services.push(svc);
  const base = await listen(svc.app);
  return { base, svc, reconciler, logs };
}
const post = (base: string, body: unknown, token: string | null = TOKENS.verifier) =>
  fetch(`${base}/v1/settlements`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token !== null && { authorization: `Bearer ${token}` }) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const waitFor = async (cond: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
};

describe("US4 auth and validation (005 T031)", () => {
  it("missing or wrong token → 401 unauthorized, even with a malformed body (401 precedes 400)", async () => {
    const { base, reconciler } = await start({ verifier: scriptedVerifier(["CONFIRMED"]) });
    for (const token of [null, "nope"]) {
      const res = await post(base, "{not json", token);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect(reconciler.reports).toHaveLength(0);
  });

  it("T-AUTH-02: CONTROL_TOKEN and SETTLEMENT_TOKEN are rejected; only VERIFIER_TOKEN passes", async () => {
    const v = scriptedVerifier(["CONFIRMED"]);
    const { base } = await start({ verifier: v });
    expect((await post(base, claim(), TOKENS.control)).status).toBe(401);
    expect((await post(base, claim(), TOKENS.settlement)).status).toBe(401);
    expect((await post(base, claim(), TOKENS.operator)).status).toBe(401);
    expect(v.calls).toHaveLength(0);
    expect((await post(base, claim(), TOKENS.verifier)).status).toBe(200);
  });

  it("valid token: non-string authorizationId or non-object requirement → 400 {error}", async () => {
    const v = scriptedVerifier(["CONFIRMED"]);
    const { base } = await start({ verifier: v });
    for (const body of [
      { ...claim(), authorizationId: undefined },
      { ...claim(), authorizationId: 42 },
      { ...claim(), requirement: undefined },
      { ...claim(), requirement: "exact" },
    ]) {
      const res = await post(base, body);
      expect(res.status).toBe(400);
      expect(typeof ((await res.json()) as { error: unknown }).error).toBe("string");
    }
    expect((await post(base, "{not json")).status).toBe(400);
    expect(v.calls).toHaveLength(0);
  });

  it("every status is answered with 200 and the report", async () => {
    for (const s of ["CONFIRMED", "PENDING", "MISMATCH", "NOT_SETTLED"] as const) {
      const { base } = await start({ verifier: scriptedVerifier([s]), recheckIntervalMs: 60_000 });
      const res = await post(base, claim(`auth_${s}`));
      expect(res.status).toBe(200);
      expect(((await res.json()) as SettlementReport).status).toBe(s);
    }
  });
});

describe("US4 reconcile push (005 T032, T033)", () => {
  it("T032 every report reaches the reconciler", async () => {
    const { base, reconciler } = await start({ verifier: scriptedVerifier(["CONFIRMED", "MISMATCH"]) });
    await post(base, claim("auth_a"));
    await post(base, claim("auth_b"));
    expect(reconciler.reports.map((r) => [r.authorizationId, r.status])).toEqual([
      ["auth_a", "CONFIRMED"],
      ["auth_b", "MISMATCH"],
    ]);
  });

  it("T032 the HTTP adapter sends SETTLEMENT_TOKEN, never VERIFIER_TOKEN (INV-13)", async () => {
    const seen: { auth?: string; body?: SettlementReport }[] = [];
    const l2 = express();
    l2.post("/v1/reconcile", express.json(), (req, res) => {
      seen.push({ auth: req.headers.authorization, body: req.body as SettlementReport });
      res.json({ ok: true, anomaly: false });
    });
    const l2Url = await listen(l2);
    const { base } = await start({
      verifier: scriptedVerifier(["CONFIRMED"]),
      reconciler: new HttpReconciler(l2Url, TOKENS.settlement, 5_000, () => {}),
    });
    await post(base, claim("auth_http"));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.auth).toBe(`Bearer ${TOKENS.settlement}`);
    expect(seen[0]!.auth).not.toContain(TOKENS.verifier);
    expect(seen[0]!.body!.authorizationId).toBe("auth_http");
  });

  it("T033 a throwing reconciler still yields 200 with the report, and the failure is logged", async () => {
    const reconciler = recordingReconciler(async () => {
      throw new Error("L2 down");
    });
    const { base, logs } = await start({ verifier: scriptedVerifier(["CONFIRMED"]), reconciler });
    const res = await post(base, claim("auth_down"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as SettlementReport).status).toBe("CONFIRMED");
    expect(logs.some((l) => /reconcile failed for auth_down: L2 down/.test(l))).toBe(true);
  });

  it("T033 a hung L2 is cut off by the reconcile timeout; L1 still gets the report", async () => {
    const reconciler = recordingReconciler(() => new Promise<void>(() => {})); // never resolves
    const { base, logs } = await start({ verifier: scriptedVerifier(["CONFIRMED"]), reconciler, reconcileTimeoutMs: 200 });
    const t0 = Date.now();
    const res = await post(base, claim("auth_hang"));
    expect(res.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(200 + 1_000);
    expect(logs.some((l) => /auth_hang: timed out after 200 ms/.test(l))).toBe(true);
  });

  it("T033 the HTTP adapter aborts a hung L2 after its timeout", async () => {
    const l2 = express();
    l2.post("/v1/reconcile", () => {
      /* never answers */
    });
    const l2Url = await listen(l2);
    const adapter = new HttpReconciler(l2Url, TOKENS.settlement, 150, () => {});
    const t0 = Date.now();
    await expect(adapter.reconcile(reportFor(claim(), "CONFIRMED"))).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

describe("US4 PENDING re-checks (005 T034, T035)", () => {
  it("T034 at most recheckAttempts re-checks, each reconciled", async () => {
    const v = scriptedVerifier(["PENDING"]);
    const { base, reconciler, svc } = await start({ verifier: v, recheckAttempts: 3, recheckIntervalMs: 20 });
    await post(base, claim("auth_p"));
    await waitFor(() => v.calls.length >= 4);
    await new Promise((r) => setTimeout(r, 100));
    expect(v.calls).toHaveLength(1 + 3);
    expect(reconciler.reports).toHaveLength(1 + 3);
    expect(svc.scheduled()).toEqual([]);
  });

  it("T034 re-checking stops at the first non-PENDING result", async () => {
    const v = scriptedVerifier(["PENDING", "PENDING", "CONFIRMED", "PENDING"]);
    const { base, reconciler, svc } = await start({ verifier: v, recheckAttempts: 5, recheckIntervalMs: 20 });
    await post(base, claim("auth_stop"));
    await waitFor(() => v.calls.length >= 3);
    await new Promise((r) => setTimeout(r, 120));
    expect(v.calls).toHaveLength(3);
    expect(reconciler.reports.map((r) => r.status)).toEqual(["PENDING", "PENDING", "CONFIRMED"]);
    expect(svc.scheduled()).toEqual([]);
  });

  it("T034 a second PENDING claim for the same authorizationId replaces the schedule", async () => {
    const v = scriptedVerifier(["PENDING"]);
    const { base, svc } = await start({ verifier: v, recheckAttempts: 2, recheckIntervalMs: 150 });
    await post(base, claim("auth_same"));
    await new Promise((r) => setTimeout(r, 75));
    await post(base, claim("auth_same")); // restarts the 2-attempt schedule
    expect(svc.scheduled()).toEqual(["auth_same"]);
    await waitFor(() => v.calls.length >= 4, 2_000);
    await new Promise((r) => setTimeout(r, 250));
    // 2 requests + 2 re-checks from the replacing schedule only (the first schedule never fired).
    expect(v.calls).toHaveLength(4);
  });

  it("T035 the response returns before any re-check runs, and timers do not block teardown", async () => {
    const v = scriptedVerifier(["PENDING"]);
    const { base, svc } = await start({ verifier: v, recheckIntervalMs: 30_000 });
    const res = await post(base, claim("auth_fast"));
    expect(res.status).toBe(200);
    expect(v.calls).toHaveLength(1);
    expect(svc.scheduled()).toEqual(["auth_fast"]);
    // Timers are unref'd: stop() is not needed for the process to exit; afterEach still cancels them.
  });
});
