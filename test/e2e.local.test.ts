// End-to-end suite on the 008 harness (SPEC.md §12). Real ganache + MockUSDC, local facilitator,
// seller, L2 control and L3 verifier, driven through L1's HTTP ports.
// T-E2E-01 is owned by 008 (T024, sole writer). T-E2E-02 by 004, T-E2E-03 by 003/005,
// T-E2E-04 by 002, T-E2E-05 by 003/007.
import { DEV_PORTAL_CLIENT, devUserId } from "../scripts/dev-issuer-lib.js";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import { HARNESS_USER_MNEMONIC, startHarness, RegressionBaseline, type Harness } from "./helpers/harness.js";
import { mockModel, startHostedApp, text, toolCall } from "./helpers/hosted.js";
import { HttpAuthorizationGate, HttpSettlementVerifier } from "../src/layer1-intent/ports-http.js";
import { PaidResourceOrchestrator, type PaidFetchResult } from "../src/layer1-intent/orchestrator.js";
import { runScriptedAgent } from "../src/layer1-intent/scripted.js";
import { listenControl } from "../src/layer2-control/service.js";
import { issuerKeys } from "../src/layer2-control/approval-evidence.js";
import { CibaClient, type CibaSettings } from "../src/layer2-control/ciba-client.js";
import { type CibaStub, PLANTED_ERROR_TEXT, startCibaStub } from "./helpers/ciba-stub.js";
import { APPROVER, AUDIENCE, CLIENT_ID, CLIENT_KEY } from "./helpers/backchannel-l2.js";
import { listenSettlement } from "../src/layer3-settlement/service.js";
import type {
  AuthorizationDecision,
  PaymentIntent,
  SettlementClaim,
  SettlementReport,
} from "../src/shared/contracts.js";

const rulesOf = (r: PaidFetchResult) => (r.violations ?? []).map((v) => v.rule);

function l1(h: Harness, sessionId: string) {
  const gate = new HttpAuthorizationGate(h.urls.control, h.tokens.control);
  const orchestrator = new PaidResourceOrchestrator({
    gate,
    settlement: new HttpSettlementVerifier(h.urls.settlement, h.tokens.verifier),
    sessionId,
  });
  return { gate, orchestrator };
}

const confirmedSettlements = (h: Harness) =>
  h.ledgerEntries().filter(
    (e) => e.type === "SETTLEMENT" && (e.data as { status?: string; anomaly?: boolean }).status === "CONFIRMED" && (e.data as { anomaly?: boolean }).anomaly !== true,
  );

async function ledgerVerify(h: Harness): Promise<{ ok: boolean; entries: number }> {
  const res = await fetch(`${h.urls.control}/v1/ledger/verify`, { headers: { authorization: `Bearer ${h.tokens.operator}` } });
  expect(res.status).toBe(200);
  return (await res.json()) as { ok: boolean; entries: number };
}

interface BaselineRun {
  outcomes: string[];
  payerDelta: bigint;
  payeeDelta: bigint;
}

async function runBaseline(h: Harness, sessionId: string) {
  const { gate, orchestrator } = l1(h, sessionId);
  const payer0 = await h.balanceOf(h.addresses.payer);
  const payee0 = await h.balanceOf(h.addresses.payTo);
  const results = await runScriptedAgent({ orchestrator, sellerUrl: h.urls.seller, log: () => {} });
  const run: BaselineRun = {
    outcomes: results.map((r) => r.outcome),
    payerDelta: payer0 - (await h.balanceOf(h.addresses.payer)),
    payeeDelta: (await h.balanceOf(h.addresses.payTo)) - payee0,
  };
  return { results, run, gate };
}

// ---------------------------------------------------------------------------
// T-E2E-01 (008 T024): the scripted plan is the regression baseline.
// ---------------------------------------------------------------------------
let firstRun: BaselineRun | undefined;
let firstResults: PaidFetchResult[] = [];

describe("T-E2E-01 scripted baseline", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  it("T-E2E-01 scripted baseline: outcomes, rules, on-chain delta 6000, 2 CONFIRMED, chain ok, budget 6000", async () => {
    const sessionId = "sess_e2e01";
    const { results, run, gate } = await runBaseline(h, sessionId);
    firstRun = run;
    firstResults = results;

    // 1. outcomes
    expect(run.outcomes).toEqual([...RegressionBaseline.outcomes]);
    // 2–4. rules on the blocked steps
    expect(rulesOf(results[3]!)).toContain("human_approval_required");
    expect(rulesOf(results[4]!)).toContain("hard_cap_exceeded");
    expect(rulesOf(results[5]!)).toContain("host_not_allowed");
    // 5. on-chain delta: payer −6000, payTo +6000 (006 T017: payee gains exactly the paid amounts)
    expect(run.payerDelta).toBe(BigInt(RegressionBaseline.onChainDeltaAtomic));
    expect(run.payeeDelta).toBe(BigInt(RegressionBaseline.onChainDeltaAtomic));
    // 6. exactly two non-anomalous CONFIRMED settlements in L2's ledger
    expect(confirmedSettlements(h)).toHaveLength(RegressionBaseline.confirmedSettlements);
    // 7. the hash chain verifies
    expect((await ledgerVerify(h)).ok).toBe(RegressionBaseline.ledgerChainOk);
    // 8. budget comes from the ledger
    expect((await gate.budget(sessionId)).spentOrReservedAtomic).toBe(RegressionBaseline.spentOrReservedAtomic);

    // Paid steps settle CONFIRMED in class `included` (005, L3 side) with a decodable PAYMENT-RESPONSE (006).
    for (const paid of [results[1]!, results[2]!]) {
      expect(paid.payment?.settlement?.status).toBe("CONFIRMED");
      expect(paid.payment?.settlement?.finalityClass).toBe("included");
      expect(paid.payment?.settlement?.transaction).toMatch(/^0x[0-9a-f]{64}$/);
    }
    expect([results[1]!.payment?.amountAtomic, results[2]!.payment?.amountAtomic]).toEqual(["1000", "5000"]);
  });
  it("T-E2E-01 ledger shape: step-4 ESCALATED entry (004 T008); one decision per INTENT, one SETTLEMENT per reconcile (003 T038)", () => {
    const entries = h.ledgerEntries();
    // 004 T008: the premium-report escalation as recorded by L2.
    const step4 = firstResults[3]!;
    const esc = entries.find((e) => e.type === "ESCALATED" && e.authorizationId === step4.authorizationId)!;
    expect(esc).toBeDefined();
    expect((esc.data.violations as { rule: string }[]).map((v) => v.rule)).toContain("human_approval_required");
    const u = new URL(step4.url);
    expect(esc.data.resourceKey).toBe(u.origin + u.pathname);
    expect(esc.data.payTo).toBe(h.addresses.payTo);
    expect(esc.data.amount).toBe("50000");
    expect(entries.some((e) => e.type === "AUTHORIZED" && e.data.resourceUrl === step4.url)).toBe(false);

    // 003 T038 (NFR-008): every authorize leaves INTENT + exactly one decision; every reconcile one SETTLEMENT.
    const intents = entries.filter((e) => e.type === "INTENT");
    expect(intents).toHaveLength(5); // steps 2–6 hit L2; step 1 is free
    for (const i of intents) {
      const decisions = entries.filter((e) => ["AUTHORIZED", "DENIED", "ESCALATED"].includes(e.type) && e.intentId === i.intentId);
      expect(decisions, i.intentId).toHaveLength(1);
    }
    const settlements = entries.filter((e) => e.type === "SETTLEMENT");
    expect(settlements).toHaveLength(2);
    const authorizedIds = entries.filter((e) => e.type === "AUTHORIZED").map((e) => e.authorizationId);
    expect(settlements.map((e) => e.authorizationId).sort()).toEqual([...authorizedIds].sort());
  });
});

// 008 T025 (NFR-002): a second fresh harness gives the same outcome sequence and deltas.
describe("T-E2E-01 determinism (008 T025)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  it("T-E2E-01 determinism: two fresh runs give identical outcomes and deltas", async () => {
    const { run } = await runBaseline(h, "sess_e2e01b");
    expect(firstRun, "the first T-E2E-01 run must have completed").toBeDefined();
    expect(run).toEqual(firstRun);
  });
});

// ---------------------------------------------------------------------------
// T-E2E-02 (004): human-in-the-loop approval, end to end.
// ---------------------------------------------------------------------------
describe("T-E2E-02 HITL approval", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  const approve = (id: string, token: string) =>
    fetch(`${h.urls.control}/v1/approvals/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ approver: "e2e-operator" }),
    });

  it("T-E2E-02 HITL: escalate → agent-token approval 401 → operator approval → PAID+CONFIRMED → escalates again", async () => {
    const { orchestrator } = l1(h, "sess_e2e02");
    const url = `${h.urls.seller}/api/premium-report`;

    const escalated = await orchestrator.fetchPaid(url, "premium report");
    expect(escalated.outcome).toBe("ESCALATED");
    expect(rulesOf(escalated)).toEqual(["human_approval_required"]);
    const escalationId = escalated.authorizationId!;

    const agentTry = await approve(escalationId, h.tokens.control);
    expect(agentTry.status).toBe(401);
    expect(h.ledgerEntries().some((e) => e.type === "HUMAN_APPROVAL")).toBe(false);

    const ok = await approve(escalationId, h.tokens.operator);
    expect(ok.status).toBe(200);
    const { approvalId, expiresAt } = (await ok.json()) as { approvalId: string; expiresAt: string };
    expect(approvalId).toMatch(/^apr_/);
    expect(Math.abs(Date.parse(expiresAt) - Date.now() - 600_000)).toBeLessThan(5_000); // default TTL 600 s

    const payer0 = await h.balanceOf(h.addresses.payer);
    const paid = await orchestrator.fetchPaid(url, "premium report, approved");
    expect(paid.outcome).toBe("PAID");
    expect(paid.payment?.settlement?.status).toBe("CONFIRMED");
    expect(payer0 - (await h.balanceOf(h.addresses.payer))).toBe(50000n);
    const auth = h.ledgerEntries().filter((e) => e.type === "AUTHORIZED");
    expect(auth.at(-1)!.data.approvalRef).toBe(approvalId);

    const again = await orchestrator.fetchPaid(url, "premium report, once more");
    expect(again.outcome).toBe("ESCALATED");
    expect(rulesOf(again)).toEqual(["human_approval_required"]);
  });
});

// ---------------------------------------------------------------------------
// T-E2E-03 (003/005) and T-E2E-05 (003/007).
// ---------------------------------------------------------------------------
describe("T-E2E-03 forged settlement and T-E2E-05 role separation", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  /** L1's job by hand: 402 → authorize → paid retry. Returns the claim L1 would send to L3. */
  async function buy(path: string) {
    const url = `${h.urls.seller}${path}`;
    const first = await fetch(url);
    expect(first.status).toBe(402);
    const intent: PaymentIntent = {
      intentId: `int_${crypto.randomUUID()}`,
      sessionId: "sess_e2e03",
      resourceUrl: url,
      paymentRequired: decodePaymentRequiredHeader(first.headers.get("PAYMENT-REQUIRED")!),
      purpose: "T-E2E-03",
      createdAt: new Date().toISOString(),
    };
    const decision = await new HttpAuthorizationGate(h.urls.control, h.tokens.control).authorize(intent);
    if (decision.status !== "AUTHORIZED") throw new Error(`not authorized: ${decision.status}`);
    const paid = await fetch(url, { headers: decision.paymentHeaders });
    expect(paid.status).toBe(200);
    const claim: SettlementClaim = {
      authorizationId: decision.authorizationId,
      requirement: decision.requirement,
      payer: decision.payer,
      validBefore: decision.validBefore,
      httpStatus: paid.status,
      paymentResponseHeader: paid.headers.get("PAYMENT-RESPONSE"),
    };
    return { claim, decision: decision as Extract<AuthorizationDecision, { status: "AUTHORIZED" }> };
  }
  const verifier = () => new HttpSettlementVerifier(h.urls.settlement, h.tokens.verifier);
  const effectiveStatus = (authorizationId: string) => {
    const reports = h
      .ledgerEntries()
      .filter((e) => e.type === "SETTLEMENT" && e.authorizationId === authorizationId && (e.data as { anomaly?: boolean }).anomaly !== true);
    return (reports.at(-1)?.data as { status?: string } | undefined)?.status;
  };

  it("T-E2E-03 forged PAYMENT-RESPONSE → L3 MISMATCH; L2 keeps the first CONFIRMED and records an anomaly naming amount", async () => {
    const weather = await buy("/api/weather?city=Lima");
    const brief = await buy("/api/market-brief");
    const real: SettlementReport = await verifier().verify(weather.claim);
    expect(real.status).toBe("CONFIRMED");
    expect((await verifier().verify(brief.claim)).status).toBe("CONFIRMED");

    // Forgery 1: the real tx, presented with a different amount.
    const forged = await verifier().verify({ ...weather.claim, requirement: { ...weather.claim.requirement, amount: "999" } });
    expect(forged.status).toBe("MISMATCH");
    const last = h
      .ledgerEntries()
      .filter((e) => e.type === "SETTLEMENT" && e.authorizationId === weather.decision.authorizationId)
      .at(-1)!;
    expect((last.data as { anomaly: boolean }).anomaly).toBe(true);
    expect((last.data as { detail: string }).detail).toMatch(/amount/);
    expect(effectiveStatus(weather.decision.authorizationId)).toBe("CONFIRMED");

    // Forgery 2: a PAYMENT-RESPONSE pointing at another real payment's tx.
    const otherTx = decodePaymentResponseHeader(brief.claim.paymentResponseHeader!).transaction;
    const header = encodePaymentResponseHeader({ success: true, transaction: otherTx, network: "eip155:31337", payer: weather.claim.payer });
    expect((await verifier().verify({ ...weather.claim, paymentResponseHeader: header })).status).toBe("MISMATCH");
    expect(effectiveStatus(weather.decision.authorizationId)).toBe("CONFIRMED");
  });

  it("seller PAYMENT-RESPONSE decodes to {success, transaction, network, payer} (006 T017)", async () => {
    const { claim } = await buy("/api/market-brief");
    const pr = decodePaymentResponseHeader(claim.paymentResponseHeader!);
    expect(pr.success).toBe(true);
    expect(pr.transaction).toMatch(/^0x[0-9a-f]{64}$/);
    expect(pr.network).toBe("eip155:31337");
    expect(pr.payer?.toLowerCase()).toBe(h.addresses.payer.toLowerCase());
  });

  it("GET /v1/ledger/verify: operator → {entries, ok:true}; control, settlement and verifier tokens → 401 (003 T033)", async () => {
    const v = await ledgerVerify(h);
    expect(v.ok).toBe(true);
    expect(v.entries).toBe(h.ledgerEntries().length);
    for (const token of [h.tokens.control, h.tokens.settlement, h.tokens.verifier]) {
      const res = await fetch(`${h.urls.control}/v1/ledger/verify`, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(401);
    }
  });

  it("T-E2E-05 /v1/reconcile with the agent token → 401; the ledger is unchanged", async () => {
    const before = h.ledgerEntries().length;
    const report: SettlementReport = {
      authorizationId: "auth_forged",
      status: "CONFIRMED",
      network: "eip155:31337",
      finalityClass: "included",
      detail: "forged by the agent",
      observedAt: new Date().toISOString(),
      verified: { asset: h.addresses.asset, payer: h.addresses.payer, payTo: h.addresses.payTo, amount: "1000" },
    };
    const res = await fetch(`${h.urls.control}/v1/reconcile`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.tokens.control}` },
      body: JSON.stringify(report),
    });
    expect(res.status).toBe(401);
    expect(h.ledgerEntries().length).toBe(before);
  });

  it("T-AUTH-01 /v1/authorize with SETTLEMENT_TOKEN → 401; the ledger is unchanged (007 T031)", async () => {
    const url = `${h.urls.seller}/api/weather?city=Lima`;
    const first = await fetch(url);
    const intent: PaymentIntent = {
      intentId: `int_${crypto.randomUUID()}`,
      sessionId: "sess_auth01",
      resourceUrl: url,
      paymentRequired: decodePaymentRequiredHeader(first.headers.get("PAYMENT-REQUIRED")!),
      purpose: "T-AUTH-01",
      createdAt: new Date().toISOString(),
    };
    const before = h.ledgerEntries().length;
    for (const token of [h.tokens.settlement, h.tokens.verifier, h.tokens.operator]) {
      const res = await fetch(`${h.urls.control}/v1/authorize`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(intent),
      });
      expect(res.status).toBe(401);
    }
    expect(h.ledgerEntries().length).toBe(before);
  });

  it("T-AUTH-02 /v1/settlements with CONTROL_TOKEN → 401; no reconcile reaches L2 (007 T032, 005 T031)", async () => {
    const { claim } = await buy("/api/market-brief");
    const before = h.ledgerEntries().length;
    for (const token of [h.tokens.control, h.tokens.settlement]) {
      const res = await fetch(`${h.urls.settlement}/v1/settlements`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(claim),
      });
      expect(res.status).toBe(401);
    }
    expect(h.ledgerEntries().length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// NFR-001 / SC-006 (007 T034): L2 and L3 bind to loopback; a port override never changes the host.
// ---------------------------------------------------------------------------
describe("T-ARCH-BIND loopback bind for L2 and L3 (007 T034)", () => {
  it("listenControl and listenSettlement bind 127.0.0.1 with CONTROL_PORT and SETTLEMENT_PORT overridden", async () => {
    const saved = { c: process.env.CONTROL_PORT, s: process.env.SETTLEMENT_PORT };
    const free = async () => {
      const probe = express().listen(0, "127.0.0.1");
      await new Promise((r) => probe.once("listening", r));
      const port = (probe.address() as AddressInfo).port;
      await new Promise((r) => probe.close(r));
      return port;
    };
    const [cp, sp] = [await free(), await free()];
    process.env.CONTROL_PORT = String(cp);
    process.env.SETTLEMENT_PORT = String(sp);
    try {
      for (const [listen, port] of [
        [listenControl, cp],
        [listenSettlement, sp],
      ] as const) {
        const server = listen(express());
        await new Promise((r) => server.once("listening", r));
        const addr = server.address() as AddressInfo;
        expect(addr.address).toBe("127.0.0.1");
        expect(addr.port).toBe(port);
        await new Promise((r) => server.close(r));
      }
    } finally {
      if (saved.c === undefined) delete process.env.CONTROL_PORT;
      else process.env.CONTROL_PORT = saved.c;
      if (saved.s === undefined) delete process.env.SETTLEMENT_PORT;
      else process.env.SETTLEMENT_PORT = saved.s;
    }
  });
});

// ---------------------------------------------------------------------------
// T-E2E-04 (002): concurrent bursts cannot bypass the velocity limit (INV-8).
// Must fail without the mutex: 15/15 AUTHORIZED (002 T029, recorded); 10/15 with it.
// ---------------------------------------------------------------------------
describe("T-E2E-04 serialized authorization", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ signerLatencyMs: 25 });
  });
  afterAll(async () => {
    await h?.close();
  });

  it("T-E2E-04 signerLatencyMs 25: 15 concurrent intents → exactly 10 AUTHORIZED in the trailing 60 s", async () => {
    const url = `${h.urls.seller}/api/weather?city=Lima`;
    const first = await fetch(url);
    expect(first.status).toBe(402);
    const paymentRequired = decodePaymentRequiredHeader(first.headers.get("PAYMENT-REQUIRED")!);
    const gate = new HttpAuthorizationGate(h.urls.control, h.tokens.control);
    const decisions = await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        gate.authorize({
          intentId: `int_${crypto.randomUUID()}`,
          sessionId: "sess_e2e04",
          resourceUrl: url,
          paymentRequired,
          purpose: `burst ${i}`,
          createdAt: new Date().toISOString(),
        }),
      ),
    );
    const authorized = decisions.filter((d) => d.status === "AUTHORIZED");
    const denied = decisions.filter((d) => d.status === "DENIED");
    expect(authorized).toHaveLength(10);
    expect(denied).toHaveLength(5);
    for (const d of denied) if (d.status !== "AUTHORIZED") expect(d.violations.map((v) => v.rule)).toEqual(["velocity_limit"]);
    const since = Date.now() - 60_000;
    expect(h.ledgerEntries().filter((e) => e.type === "AUTHORIZED" && Date.parse(e.ts) >= since)).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// T-E2E-07 (010): operator rejection, end to end (SPEC.md L2-4.3, L2-5; SEC-8, SEC-12).
// ---------------------------------------------------------------------------
describe("T-E2E-07 operator reject", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  const operatorPost = (path: string, body: unknown, token = h.tokens.operator) =>
    fetch(`${h.urls.control}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  it("T-E2E-07 reject: escalate → operator reject → retry DENIED human_rejected; other session escalates; ledger trail", async () => {
    const { orchestrator } = l1(h, "sess_e2e07");
    const url = `${h.urls.seller}/api/premium-report`;
    const escalated = await orchestrator.fetchPaid(url, "premium report");
    expect(escalated.outcome).toBe("ESCALATED");
    const id = escalated.authorizationId!;

    const res = await operatorPost(`/v1/rejections/${id}`, { operator: "e2e-operator", reason: "too expensive" });
    expect(res.status).toBe(200);

    const payer0 = await h.balanceOf(h.addresses.payer);
    const again = await orchestrator.fetchPaid(url, "premium report, again");
    expect(again.outcome).toBe("DENIED");
    expect(rulesOf(again)).toEqual(["human_rejected"]);
    expect(JSON.stringify(again.violations)).not.toMatch(/e2e-operator|too expensive/); // SEC-12
    expect(await h.balanceOf(h.addresses.payer)).toBe(payer0);

    const other = await l1(h, "sess_e2e07b").orchestrator.fetchPaid(url, "premium report, other session");
    expect(other.outcome).toBe("ESCALATED");

    const trail = h.ledgerEntries().filter((e) => e.sessionId === "sess_e2e07" && e.type !== "INTENT").map((e) => e.type);
    expect(trail).toEqual(["ESCALATED", "HUMAN_REJECTION", "DENIED"]);
  });
  it("T-E2E-07 concurrent approve and reject on one pending escalation: exactly one final entry, the other is 409", async () => {
    const { orchestrator } = l1(h, "sess_e2e07c");
    const escalated = await orchestrator.fetchPaid(`${h.urls.seller}/api/premium-report`, "premium report, race");
    expect(escalated.outcome).toBe("ESCALATED");
    const id = escalated.authorizationId!;
    const [a, r] = await Promise.all([operatorPost(`/v1/approvals/${id}`, {}), operatorPost(`/v1/rejections/${id}`, {})]);
    expect([a.status, r.status].sort()).toEqual([200, 409]);
    const finals = h
      .ledgerEntries()
      .filter((e) => (e.type === "HUMAN_APPROVAL" || e.type === "HUMAN_REJECTION" || e.type === "ESCALATION_EXPIRED") && e.data.escalationId === id);
    expect(finals).toHaveLength(1);
  });
  it("T-E2E-07 watch: events feed reports escalated, denied and approved within one poll", async () => {
    const get = (path: string) => fetch(`${h.urls.control}${path}`, { headers: { authorization: `Bearer ${h.tokens.operator}` } });
    const { cursor } = (await (await get("/v1/escalations")).json()) as { cursor: number };
    const url = `${h.urls.seller}/api/premium-report`;
    const x = await l1(h, "sess_e2e07w1").orchestrator.fetchPaid(url, "premium report, watch 1");
    const y = await l1(h, "sess_e2e07w2").orchestrator.fetchPaid(url, "premium report, watch 2");
    expect((await operatorPost(`/v1/rejections/${x.authorizationId}`, { operator: "e2e-operator", reason: "no" })).status).toBe(200);
    expect((await operatorPost(`/v1/approvals/${y.authorizationId}`, {})).status).toBe(200);
    const { events } = (await (await get(`/v1/escalations/events?after=${cursor}`)).json()) as {
      events: { kind: string; authorizationId: string; operator?: string; reason?: string }[];
    };
    expect(events.map((e) => [e.kind, e.authorizationId])).toEqual([
      ["escalated", x.authorizationId],
      ["escalated", y.authorizationId],
      ["denied", x.authorizationId],
      ["approved", y.authorizationId],
    ]);
    expect(events[2]).toMatchObject({ operator: "e2e-operator", reason: "no" });
  });
});

// ---------------------------------------------------------------------------
// T-E2E-08 (010): escalation expiry, repeat while pending, and re-escalation (SPEC.md L2-4.3).
// L2 runs on a controlled clock; everything else uses real time.
// ---------------------------------------------------------------------------
describe("T-E2E-08 expiry and re-escalation", () => {
  let h: Harness;
  let clock = Date.now();
  beforeAll(async () => {
    h = await startHarness({ controlNow: () => clock });
  });
  afterAll(async () => {
    await h?.close();
  });

  const operatorPost = (path: string, body: unknown) =>
    fetch(`${h.urls.control}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.tokens.operator}` },
      body: JSON.stringify(body),
    });

  it("T-E2E-08 expiry: a pending repeat reuses the ID; 300 s expire it; decisions are 409; the next request escalates anew; one approval pays once", async () => {
    const { orchestrator } = l1(h, "sess_e2e08");
    const url = `${h.urls.seller}/api/premium-report`;

    const first = await orchestrator.fetchPaid(url, "premium report");
    expect(first.outcome).toBe("ESCALATED");
    const A = first.authorizationId!;
    const repeat = await orchestrator.fetchPaid(url, "premium report, repeat");
    expect(repeat.outcome).toBe("ESCALATED");
    expect(repeat.authorizationId).toBe(A);
    expect(h.ledgerEntries().filter((e) => e.type === "ESCALATION_REPEATED")).toHaveLength(1);

    clock += 300_000;
    await h.sweepEscalations();
    expect(h.ledgerEntries().filter((e) => e.type === "ESCALATION_EXPIRED" && e.data.escalationId === A)).toHaveLength(1);
    for (const path of [`/v1/approvals/${A}`, `/v1/rejections/${A}`]) {
      const r = await operatorPost(path, {});
      expect(r.status, path).toBe(409);
      expect(((await r.json()) as { state: string }).state).toBe("expired");
    }

    const fresh = await orchestrator.fetchPaid(url, "premium report, after expiry");
    expect(fresh.outcome).toBe("ESCALATED");
    expect(rulesOf(fresh)).toEqual(["human_approval_required"]);
    const B = fresh.authorizationId!;
    expect(B).not.toBe(A);

    const a1 = (await (await operatorPost(`/v1/approvals/${B}`, {})).json()) as { approvalId: string };
    const a2 = (await (await operatorPost(`/v1/approvals/${B}`, {})).json()) as { approvalId: string; alreadyApproved: boolean };
    expect(a2).toMatchObject({ approvalId: a1.approvalId, alreadyApproved: true });

    const payer0 = await h.balanceOf(h.addresses.payer);
    const paid = await orchestrator.fetchPaid(url, "premium report, approved");
    expect(paid.outcome).toBe("PAID");
    expect(payer0 - (await h.balanceOf(h.addresses.payer))).toBe(50000n);
  });
});

// ---------------------------------------------------------------------------
// T-E2E-09 hosted agent service (011 US1, US5): the real L2/L3/seller/chain behind the hosted HTTP API,
// with a scripted mock model in place of Claude.
// ---------------------------------------------------------------------------

describe("T-E2E-09 hosted agent", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });

  type Step = { tool: string; result: { outcome: string; authorizationId: string | null; payment: { settlement: { status: string | null } } | null } };

  async function runScript(script: string, env: NodeJS.ProcessEnv, args: string[] = []) {
    const child = spawn(process.execPath, ["--import", "tsx", script, ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ENV_FILE: "/dev/null", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));
    const code = await new Promise<number | null>((r) => child.on("close", r));
    return { code, out };
  }

  it("011 US6 agent:scripted --check-baseline exits 0 and prints baseline: ok against the harness", async () => {
    const r = await runScript("src/main.ts", {
      NETWORK: "local",
      SELLER_URL: h.urls.seller,
      CONTROL_URL: h.urls.control,
      SETTLEMENT_URL: h.urls.settlement,
      CONTROL_TOKEN: h.tokens.control,
      VERIFIER_TOKEN: h.tokens.verifier,
    }, ["--scripted", "--check-baseline"]);
    expect(r.out).toContain("baseline: ok");
    expect(r.code).toBe(0);
  }, 120_000);

  it("011 US4 ledger-verify exits 0 on a clean chain and 1 on a wrong token", async () => {
    const ok = await runScript("scripts/ledger-verify.ts", { NETWORK: "local", CONTROL_URL: h.urls.control, OPERATOR_TOKEN: h.tokens.operator });
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/^entries=\d+ ok=true$/m);
    const bad = await runScript("scripts/ledger-verify.ts", { NETWORK: "local", CONTROL_URL: h.urls.control, OPERATOR_TOKEN: "wrong" });
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("HTTP 401");
  }, 60_000);
  const sessionOf = (ref: unknown) => String(ref).split(".")[1]!;

  it("default goal pays weather and market brief; the premium report escalates", async () => {
    const s = h.urls.seller;
    const model = mockModel([
      toolCall("fetch_resource", { url: `${s}/api/catalog`, purpose: "read the catalog" }),
      toolCall("fetch_resource", { url: `${s}/api/weather?city=Lima`, purpose: "weather for Lima" }),
      toolCall("fetch_resource", { url: `${s}/api/market-brief`, purpose: "market brief" }),
      toolCall("fetch_resource", { url: `${s}/api/premium-report`, purpose: "premium report" }),
      text("Receipts: weather, market brief. The premium report needs approval."),
    ]);
    const a = await startHostedApp({ harness: h, model });
    try {
      const r = await a.run("alice", { goal: "Get today's weather for Lima and a short market brief" });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe("completed");
      const steps = r.body.steps as Step[];
      expect(steps.map((x) => x.result.outcome)).toEqual(["FREE", "PAID", "PAID", "ESCALATED"]);
      expect(steps.filter((x) => x.result.outcome === "PAID").map((x) => x.result.payment?.settlement.status)).toEqual(["CONFIRMED", "CONFIRMED"]);
      const escalated = steps[3]!.result.authorizationId;
      expect(escalated).toMatch(/^auth_/);
      expect(h.ledgerEntries().some((e) => e.type === "AUTHORIZED" && e.authorizationId === escalated)).toBe(false);

      const sessionId = sessionOf(r.body.sessionRef);
      const budget = (await (await fetch(`${h.urls.control}/v1/budget/${sessionId}`, { headers: { authorization: `Bearer ${h.tokens.control}` } })).json()) as {
        spentOrReservedAtomic: string;
      };
      expect(budget.spentOrReservedAtomic).toBe("6000");
    } finally {
      await a.close();
    }
  }, 120_000);

  it("T-E2E-09 continuation: escalate, approve, continue the same session, pay once", async () => {
    const s = h.urls.seller;
    const report = () => toolCall("fetch_resource", { url: `${s}/api/premium-report`, purpose: "premium report" });
    const model = mockModel([report(), text("needs approval"), report(), text("bought it")]);
    const a = await startHostedApp({ harness: h, model });
    try {
      const run1 = await a.run("carol", { goal: "Buy the premium report" });
      const step1 = (run1.body.steps as Step[])[0]!;
      expect(step1.result.outcome).toBe("ESCALATED");
      const authorizationId = step1.result.authorizationId!;

      const approved = await fetch(`${h.urls.control}/v1/approvals/${authorizationId}`, {
        method: "POST",
        headers: { authorization: `Bearer ${h.tokens.operator}`, "content-type": "application/json" },
        body: JSON.stringify({ approver: "e2e-operator" }),
      });
      expect(approved.status).toBe(200);

      const run2 = await a.run("carol", { goal: "Buy the premium report", sessionRef: run1.body.sessionRef });
      expect(run2.status).toBe(200);
      const step2 = (run2.body.steps as Step[])[0]!;
      expect(step2.result.outcome).toBe("PAID");
      expect(step2.result.payment?.settlement.status).toBe("CONFIRMED");
      const sessionId = sessionOf(run1.body.sessionRef);
      const paid = h.ledgerEntries().filter((e) => e.type === "AUTHORIZED" && e.sessionId === sessionId);
      expect(paid).toHaveLength(1);
      expect((paid[0]!.data as { approvalRef: string | null }).approvalRef).toMatch(/^apr_/);

      const before = h.ledgerEntries().length;
      const stolen = await a.run("mallory", { goal: "Buy the premium report", sessionRef: run1.body.sessionRef });
      expect(stolen.status).toBe(404);
      expect(h.ledgerEntries().length).toBe(before);
    } finally {
      await a.close();
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 012: backchannel approval end to end, through the real L1 orchestrator, chain and L3 (specs/012 T018, T025, T043).
// One harness and one stand-in Auth0; each scenario uses its own session and its own request script.
// ---------------------------------------------------------------------------
describe("012 backchannel approval end to end", () => {
  let h: Harness;
  let stub: CibaStub;
  beforeAll(async () => {
    stub = await startCibaStub({ approver: APPROVER, clientId: CLIENT_ID, audience: AUDIENCE, clientPublicKeyPem: CLIENT_KEY.publicPem });
    const settings: CibaSettings = { issuer: stub.issuer, clientId: CLIENT_ID, audience: AUDIENCE, approver: APPROVER, credential: { kind: "key", keyPem: CLIENT_KEY.privatePem } };
    h = await startHarness({
      controlBackchannel: {
        port: new CibaClient(settings, { allowInsecureLoopback: true }),
        issuer: stub.issuer,
        clientId: CLIENT_ID,
        audience: AUDIENCE,
        approver: APPROVER,
        keys: issuerKeys(stub.issuer, { allowInsecureLoopback: true }),
        decimals: 6,
        waitMs: 10_000,
        pollDelayMs: (s) => s * 50,
        log: () => {},
      },
    });
  }, 60_000);
  afterAll(async () => {
    await h?.close();
    await stub?.close();
  });

  const leaks = (r: PaidFetchResult) => {
    const text = JSON.stringify(r);
    return [...stub.tokensIssued, ...stub.authReqIds, PLANTED_ERROR_TEXT].filter((s) => text.includes(s));
  };

  it("T-E2E-10 backchannel approval within the wait pays in the same fetch", async () => {
    const before = stub.authReqIds.length;
    stub.setAnswersFor(before, "pending", "pending", { approve: {} });
    const { orchestrator } = l1(h, "sess_e2e10a");
    const payer0 = await h.balanceOf(h.addresses.payer);
    const r = await orchestrator.fetchPaid(`${h.urls.seller}/api/premium-report`, "premium report");
    expect(r.outcome).toBe("PAID");
    expect(r.payment?.settlement?.status).toBe("CONFIRMED");
    expect(payer0 - (await h.balanceOf(h.addresses.payer))).toBe(50000n);
    expect(stub.authReqIds.length - before).toBe(1);
    const approval = h.ledgerEntries().find((e) => e.type === "HUMAN_APPROVAL" && e.sessionId === "sess_e2e10a")!;
    expect(approval.data.channel).toBe("backchannel");
    const paid = h.ledgerEntries().filter((e) => e.type === "AUTHORIZED" && e.sessionId === "sess_e2e10a");
    expect(paid).toHaveLength(1);
    expect(paid[0]!.data.approvalRef).toBe(approval.data.approvalId);
    expect(leaks(r)).toEqual([]);
  }, 60_000);

  it("T-E2E-10 the scripted plan never asks the approver (operator-only), and matches the baseline", async () => {
    const before = stub.authReqIds.length;
    const orchestrator = new PaidResourceOrchestrator({
      gate: new HttpAuthorizationGate(h.urls.control, h.tokens.control),
      settlement: new HttpSettlementVerifier(h.urls.settlement, h.tokens.verifier),
      sessionId: "sess_e2e10s",
      operatorApprovalOnly: true, // as src/main.ts builds it for --scripted
    });
    const results = await runScriptedAgent({ orchestrator, sellerUrl: h.urls.seller, log: () => {} });
    expect(results.map((r) => r.outcome)).toEqual(RegressionBaseline.outcomes);
    expect(stub.authReqIds.length).toBe(before);
    const esc = h.ledgerEntries().filter((e) => e.type === "ESCALATED" && e.sessionId === "sess_e2e10s");
    expect(esc.map((e) => e.data.approvalRequest)).toEqual(["operator_only"]);
  }, 60_000);

  it("T-E2E-11 backchannel refusal through the orchestrator", async () => {
    const before = stub.authReqIds.length;
    stub.setAnswersFor(before, "deny");
    const { orchestrator } = l1(h, "sess_e2e11");
    const payer0 = await h.balanceOf(h.addresses.payer);
    const r = await orchestrator.fetchPaid(`${h.urls.seller}/api/premium-report`, "premium report");
    expect(r.outcome).toBe("DENIED");
    expect(rulesOf(r)).toEqual(["human_rejected"]);
    expect(await h.balanceOf(h.addresses.payer)).toBe(payer0);
    const esc = h.ledgerEntries().find((e) => e.type === "ESCALATED" && e.sessionId === "sess_e2e11")!;
    const trail = h.ledgerEntries().filter((e) => e.sessionId === "sess_e2e11" && e.seq > esc.seq).map((e) => e.type);
    expect(trail).toEqual(["APPROVAL_REQUESTED", "HUMAN_REJECTION", "INTENT", "DENIED"]);
    expect(leaks(r)).toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 013 user accounts end to end (specs/013 quickstart §2, §3): two people, two accounts, one chain.
// ---------------------------------------------------------------------------

describe("013 user accounts end to end", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ users: {} });
  });
  afterAll(async () => {
    await h?.close();
  });

  const ALICE = devUserId("alice");
  const BOB = devUserId("bob");
  const sellerHost = () => new URL(h.urls.seller).host;
  const values = (over: Record<string, unknown> = {}) => ({
    sellers: [sellerHost()],
    autoApproveMaxAtomic: "20000",
    hardCapPerPaymentAtomic: "100000",
    sessionBudgetAtomic: "100000",
    dailyBudgetAtomic: "500000",
    maxAuthorizationsPerMinute: 10,
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    paymentMethod: "crypto_account",
    ...over,
  });
  const fresh = () => ({ identityConfirmedAtMs: Date.now() });

  /** Profile registered, crypto account created and funded, one policy. Through the real portal routes. */
  async function onboard(userId: string, fundAtomic: bigint, over: Record<string, unknown> = {}) {
    expect((await h.portal("PUT", `/v1/users/${userId}/registration`, { acknowledgedTestFunds: true })).status).toBe(200);
    const wallet = await h.portal<{ wallet: { address: `0x${string}` } }>("PUT", `/v1/users/${userId}/wallet`);
    expect(wallet.status).toBe(200);
    const address = wallet.body.wallet.address;
    expect(await h.fund(address, fundAtomic)).toBe(fundAtomic);
    const policy = await h.portal<{ policyId: string }>("POST", `/v1/users/${userId}/policies`, { ...values(over), ...fresh() });
    expect(policy.status).toBe(201);
    return { address, policyId: policy.body.policyId };
  }

  /** L1 for one person's run: the orchestrator names the user, as the hosted agent service does. */
  function l1For(sessionId: string, userId: string) {
    return new PaidResourceOrchestrator({
      gate: new HttpAuthorizationGate(h.urls.control, h.tokens.control),
      settlement: new HttpSettlementVerifier(h.urls.settlement, h.tokens.verifier),
      sessionId,
      userId,
    });
  }

  it("T-E2E-12 two users: each payment is signed by, and settles from, its own user's account; the platform payer is untouched", async () => {
    const alice = await onboard(ALICE, 1_000_000n);
    const bob = await onboard(BOB, 2_000_000n);
    expect(alice.address).not.toBe(bob.address);
    const platform0 = await h.balanceOf(h.addresses.payer);
    const payee0 = await h.balanceOf(h.addresses.payTo);

    const a = await l1For("sess_alice", ALICE).fetchPaid(`${h.urls.seller}/api/weather?city=Lima`, "weather for alice");
    const b = await l1For("sess_bob", BOB).fetchPaid(`${h.urls.seller}/api/market-brief`, "brief for bob");
    for (const r of [a, b]) {
      expect(r.outcome, JSON.stringify(r.violations ?? r.error)).toBe("PAID");
      expect(r.payment?.settlement?.status).toBe("CONFIRMED");
    }
    // The chain: each transfer left its own user's account. L3 verified the payer from the Transfer log (INV-10).
    expect(a.payment!.settlement!.verified.payer.toLowerCase()).toBe(alice.address.toLowerCase());
    expect(b.payment!.settlement!.verified.payer.toLowerCase()).toBe(bob.address.toLowerCase());
    expect(await h.balanceOf(alice.address)).toBe(1_000_000n - 1_000n);
    expect(await h.balanceOf(bob.address)).toBe(2_000_000n - 5_000n);
    expect(await h.balanceOf(h.addresses.payer)).toBe(platform0);
    expect((await h.balanceOf(h.addresses.payTo)) - payee0).toBe(6_000n);

    // The ledger: each decision names its user, policy, version and account (FR-045).
    const authorized = h.ledgerEntries().filter((e) => e.type === "AUTHORIZED");
    expect(authorized.map((e) => [e.data.userId, e.data.policyId, e.data.policyVersion, String(e.data.payer).toLowerCase()])).toEqual([
      [ALICE, alice.policyId, 1, alice.address.toLowerCase()],
      [BOB, bob.policyId, 1, bob.address.toLowerCase()],
    ]);
    expect(confirmedSettlements(h)).toHaveLength(2);
    expect((await ledgerVerify(h)).ok).toBe(true);

    // A run with no user is the platform account, exactly as before (FR-002).
    const plain = await l1(h, "sess_platform").orchestrator.fetchPaid(`${h.urls.seller}/api/weather?city=Lima`, "platform run");
    expect(plain.outcome).toBe("PAID");
    expect(plain.payment!.settlement!.verified.payer.toLowerCase()).toBe(h.addresses.payer.toLowerCase());
    expect(platform0 - (await h.balanceOf(h.addresses.payer))).toBe(1_000n);
    expect(await h.balanceOf(alice.address)).toBe(999_000n);

    // A person who never onboarded is denied, and nothing moves (FR-012).
    const nobody = await l1For("sess_nobody", devUserId("nobody")).fetchPaid(`${h.urls.seller}/api/weather?city=Lima`, "no setup");
    expect(nobody.outcome).toBe("DENIED");
    expect(rulesOf(nobody)).toEqual(["user_not_onboarded"]);

    // Known-value scan: the mnemonic and every role token are absent from the ledger file.
    const ledgerText = readFileSync(h.ledgerPath, "utf8");
    for (const secret of [...HARNESS_USER_MNEMONIC.split(" ").filter((w) => w.length > 5), ...Object.values(h.tokens)]) {
      expect(ledgerText.includes(secret), secret).toBe(false);
    }
    expect(/0x[0-9a-fA-F]{64}"/.test(ledgerText.replace(/"(transaction|hash|prevHash|digest)":"[^"]+"/g, ""))).toBe(false);
  });

  it("T-E2E-12 a user's account that can't cover the payment: signed, refused by the facilitator, nothing spent", async () => {
    const carol = devUserId("carol");
    const { address } = await onboard(carol, 500n);
    const r = await l1For("sess_carol", carol).fetchPaid(`${h.urls.seller}/api/weather?city=Lima`, "underfunded");
    expect(r.outcome).toBe("PAYMENT_FAILED");
    expect(await h.balanceOf(address)).toBe(500n);
  });

  it("T-E2E-13 disable and enable: an escalation approved after the disable is denied; after enable the policy is paused; after resume it pays once", async () => {
    const dave = devUserId("dave");
    const { address, policyId } = await onboard(dave, 1_000_000n);
    const orchestrator = l1For("sess_dave", dave);
    const premium = `${h.urls.seller}/api/premium-report`;

    // A payment authorized before the disable settles as usual.
    const before = await orchestrator.fetchPaid(`${h.urls.seller}/api/weather?city=Lima`, "before");
    expect(before.payment?.settlement?.status).toBe("CONFIRMED");

    const escalated = await orchestrator.fetchPaid(premium, "premium report");
    expect(escalated.outcome).toBe("ESCALATED");
    expect((await h.portal("POST", `/v1/users/${dave}/disable`)).status).toBe(200);
    const approve = await fetch(`${h.urls.control}/v1/approvals/${escalated.authorizationId}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${h.tokens.operator}` },
      body: "{}",
    });
    expect(approve.status).toBe(200);
    const denied = await orchestrator.fetchPaid(premium, "premium report, approved while disabled");
    expect(denied.outcome).toBe("DENIED");
    expect(rulesOf(denied)).toEqual(["user_disabled"]);
    expect(await h.balanceOf(address)).toBe(999_000n);

    // Enable: every policy comes back paused, so enabling alone never restarts spending.
    const enabled = await h.portal<{ enabled: boolean; policies: Array<{ state: string }> }>("POST", `/v1/users/${dave}/enable`, fresh());
    expect([enabled.body.enabled, enabled.body.policies.map((p) => p.state)]).toEqual([true, ["paused"]]);
    const paused = await orchestrator.fetchPaid(premium, "premium report, policy paused");
    expect(rulesOf(paused)).toEqual(["host_not_allowed"]);

    // Resume: the approval recorded earlier is still open, and pays exactly once.
    expect((await h.portal("POST", `/v1/users/${dave}/policies/${policyId}/resume`, fresh())).status).toBe(200);
    const paid = await orchestrator.fetchPaid(premium, "premium report, resumed");
    expect(paid.outcome).toBe("PAID");
    expect(paid.payment?.settlement?.status).toBe("CONFIRMED");
    expect(await h.balanceOf(address)).toBe(999_000n - 50_000n);
    // The approval is spent, and this run's budget is nearly used (1000 + 50000 of 100000): another 50000 is over it.
    const again = await orchestrator.fetchPaid(premium, "again");
    expect([again.outcome, rulesOf(again)]).toEqual(["DENIED", ["session_budget_exceeded"]]);
    // A new run of the same person has its own budget, and needs its own approval.
    expect((await l1For("sess_dave_2", dave).fetchPaid(premium, "new run")).outcome).toBe("ESCALATED");
    expect((await ledgerVerify(h)).ok).toBe(true);
  });

  it("T-E2E-12 through the hosted agent service: a person's token pays from that person's account, a system identity's from the platform's (013 research R19)", async () => {
    // The whole chain with the sign-in's token shape: the service derives the user from the issuer and `sub`.
    const erin = devUserId("erin");
    const { address, policyId } = await onboard(erin, 1_000_000n);
    const weather = () => toolCall("fetch_resource", { url: `${h.urls.seller}/api/weather?city=Lima`, purpose: "weather" });
    const a = await startHostedApp({ harness: h, model: mockModel([weather(), text("done"), weather(), text("done")]) });
    try {
      type Paid = { result: { outcome: string; authorizationId: string | null } };
      const platform0 = await h.balanceOf(h.addresses.payer);

      const mine = await a.run("erin", { goal: "Get the weather for Lima" });
      expect(mine.status).toBe(200);
      const paid = (mine.body.steps as Paid[])[0]!.result;
      expect(paid.outcome).toBe("PAID");
      expect(await h.balanceOf(address)).toBe(1_000_000n - 1_000n);
      expect(await h.balanceOf(h.addresses.payer)).toBe(platform0);
      const entry = h.ledgerEntries().find((e) => e.type === "AUTHORIZED" && e.authorizationId === paid.authorizationId)!;
      expect([entry.data.userId, entry.data.policyId, String(entry.data.payer).toLowerCase()]).toEqual([erin, policyId, address.toLowerCase()]);

      // A system identity names no user: the platform account pays, and the person's account is untouched (FR-002).
      const system = await a.run("svc-app-id", { goal: "Get the weather for Lima" }, { service: true });
      expect((system.body.steps as Paid[])[0]!.result.outcome).toBe("PAID");
      expect(platform0 - (await h.balanceOf(h.addresses.payer))).toBe(1_000n);
      expect(await h.balanceOf(address)).toBe(999_000n);

      // The portal's token for the same person never starts a run (SEC-20), and neither moves anything.
      const portalToken = await a.run("erin", { goal: "Get the weather for Lima" }, { azp: DEV_PORTAL_CLIENT, authTime: Math.floor(Date.now() / 1000) });
      expect(portalToken.status).toBe(403);
      expect(await h.balanceOf(address)).toBe(999_000n);
      expect((await ledgerVerify(h)).ok).toBe(true);
    } finally {
      await a.close();
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 014 portal administration end to end (specs/014 quickstart §2, §5): a real escalation, decided by an administrator
// through the portal's HTTP API, with the real orchestrator, chain and L3. One harness: user accounts, the
// administration routes and the stand-in approval service, so the phone path runs beside the portal's.
// ---------------------------------------------------------------------------
describe("014 portal administration end to end", () => {
  let h: Harness;
  let stub: CibaStub;
  let portal: import("./helpers/portal.js").PortalTestApp;
  beforeAll(async () => {
    stub = await startCibaStub({ approver: APPROVER, clientId: CLIENT_ID, audience: AUDIENCE, clientPublicKeyPem: CLIENT_KEY.publicPem });
    const settings: CibaSettings = { issuer: stub.issuer, clientId: CLIENT_ID, audience: AUDIENCE, approver: APPROVER, credential: { kind: "key", keyPem: CLIENT_KEY.privatePem } };
    h = await startHarness({
      users: {},
      admin: true,
      controlBackchannel: {
        port: new CibaClient(settings, { allowInsecureLoopback: true }),
        issuer: stub.issuer,
        clientId: CLIENT_ID,
        audience: AUDIENCE,
        approver: APPROVER,
        keys: issuerKeys(stub.issuer, { allowInsecureLoopback: true }),
        decimals: 6,
        waitMs: 20_000,
        pollDelayMs: (s) => s * 50,
        log: () => {},
      },
    });
    // The real portal app, with its two clients pointed at the harness's L2 and that L2's own two tokens.
    const { startPortal } = await import("./helpers/portal.js");
    const l2 = { url: h.urls.control, clock: { now: Date.now }, ledger: {}, requestCount: () => 0, close: async () => {} };
    portal = await startPortal({ l2: l2 as never, admin: true, env: { PORTAL_TOKEN: h.tokens.portal, PORTAL_ADMIN_TOKEN: h.tokens.portalAdmin } });
  }, 60_000);
  afterAll(async () => {
    await portal?.close();
    await h?.close();
    await stub?.close();
  });

  const ERIN = devUserId("erin");
  const CAROL = devUserId("carol");
  const premium = () => `${h.urls.seller}/api/premium-report`;
  /** A run of erin's. `operatorApprovalOnly` keeps the phone out of it, so the call returns ESCALATED at once. */
  const run = (sessionId: string, o: { phone?: boolean } = {}) =>
    new PaidResourceOrchestrator({
      gate: new HttpAuthorizationGate(h.urls.control, h.tokens.control),
      settlement: new HttpSettlementVerifier(h.urls.settlement, h.tokens.verifier),
      sessionId,
      userId: ERIN,
      ...(!o.phone && { operatorApprovalOnly: true }),
    });
  const carol = () => portal.adminAs("carol", { user: false });
  let erinAddress: `0x${string}`;

  it("T-E2E-14 an administrator approves in the portal: the agent's retry pays from the user's own account, and L3 confirms it", async () => {
    expect((await h.portal("PUT", `/v1/users/${ERIN}/registration`, { acknowledgedTestFunds: true })).status).toBe(200);
    erinAddress = (await h.portal<{ wallet: { address: `0x${string}` } }>("PUT", `/v1/users/${ERIN}/wallet`)).body.wallet.address;
    await h.fund(erinAddress, 1_000_000n);
    const policy = await h.portal("POST", `/v1/users/${ERIN}/policies`, {
      sellers: [new URL(h.urls.seller).host],
      autoApproveMaxAtomic: "20000",
      hardCapPerPaymentAtomic: "100000",
      sessionBudgetAtomic: "100000",
      dailyBudgetAtomic: "500000",
      maxAuthorizationsPerMinute: 10,
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      paymentMethod: "crypto_account",
      identityConfirmedAtMs: Date.now(),
    });
    expect(policy.status).toBe(201);

    const orchestrator = run("sess_e2e14a");
    const escalated = await orchestrator.fetchPaid(premium(), "premium report");
    expect(escalated.outcome).toBe("ESCALATED");
    const id = String(escalated.authorizationId);

    // The administrator sees it, by the user's identifier, and it is not theirs.
    const listed = await carol()<{ pending: Array<Record<string, unknown>> }>("GET", "/api/admin/escalations");
    expect(listed.body.pending.map((e) => [e.authorizationId, e.owner, e.mine, e.amountAtomic])).toEqual([[id, { userId: ERIN, platformAccount: false }, false, "50000"]]);

    const t0 = Date.now();
    const approved = await carol()("POST", `/api/admin/escalations/${id}/approve`, {});
    // NFR-007: the outcome of a decision within 2 s.
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(approved.body).toMatchObject({ ok: true, state: "approved", already: false, channel: "portal", decidedBy: CAROL });

    const paid = await orchestrator.fetchPaid(premium(), "premium report, approved");
    expect(paid.outcome, JSON.stringify(paid.violations ?? paid.error)).toBe("PAID");
    expect(paid.payment?.settlement?.status).toBe("CONFIRMED");
    expect(paid.payment!.settlement!.verified.payer.toLowerCase()).toBe(erinAddress.toLowerCase());
    expect(await h.balanceOf(erinAddress)).toBe(1_000_000n - 50_000n);

    // The ledger alone says which path decided and who (SC-007), and the approval paid exactly once.
    const approval = h.ledgerEntries().find((e) => e.type === "HUMAN_APPROVAL" && e.data.escalationId === id)!;
    expect(approval.data).toMatchObject({ channel: "portal", approver: CAROL, payTo: h.addresses.payTo, amount: "50000" });
    const authorized = h.ledgerEntries().filter((e) => e.type === "AUTHORIZED" && e.sessionId === "sess_e2e14a");
    expect(authorized.map((e) => e.data.approvalRef)).toEqual([approval.data.approvalId]);
    expect((await carol()<{ pending: unknown[] }>("GET", "/api/admin/escalations")).body.pending).toEqual([]);
  }, 60_000);

  it("T-E2E-14 an administrator rejects in the portal: the retry is denied, nothing is paid, and the agent learns nothing of why", async () => {
    const orchestrator = run("sess_e2e14b");
    const escalated = await orchestrator.fetchPaid(premium(), "premium report");
    expect(escalated.outcome).toBe("ESCALATED");
    const balance = await h.balanceOf(erinAddress);
    const rejected = await carol()("POST", `/api/admin/escalations/${String(escalated.authorizationId)}/reject`, { reasonCode: "amount_too_high" });
    expect(rejected.body).toMatchObject({ ok: true, state: "denied", channel: "portal", decidedBy: CAROL });
    const denied = await orchestrator.fetchPaid(premium(), "premium report, rejected");
    expect([denied.outcome, rulesOf(denied)]).toEqual(["DENIED", ["human_rejected"]]);
    expect(await h.balanceOf(erinAddress)).toBe(balance);
    const seen = JSON.stringify(denied);
    for (const hidden of ["amount_too_high", CAROL, "portal"]) expect(seen, hidden).not.toContain(hidden);
    // An approval can't revive it, from the portal or from the command line.
    expect((await carol()("POST", `/api/admin/escalations/${String(escalated.authorizationId)}/approve`, {})).status).toBe(409);
  }, 60_000);

  it("T-E2E-14 with the phone asked too, a portal approval ends the wait: the same fetch pays", async () => {
    const before = stub.authReqIds.length;
    stub.setAnswersFor(before, "pending");
    const fetching = run("sess_e2e14c", { phone: true }).fetchPaid(premium(), "premium report");
    // The administrator's list shows it, with the phone request open.
    let item: Record<string, unknown> | undefined;
    for (let i = 0; i < 200 && item?.approvalRequest !== "requested"; i++) {
      await new Promise((r) => setTimeout(r, 25));
      item = (await carol()<{ pending: Array<Record<string, unknown>> }>("GET", "/api/admin/escalations")).body.pending[0];
    }
    expect(item?.approvalRequest).toBe("requested");
    const approved = await carol()("POST", `/api/admin/escalations/${String(item!.authorizationId)}/approve`, {});
    expect(approved.body).toMatchObject({ state: "approved", already: false });
    const paid = await fetching;
    expect(paid.outcome, JSON.stringify(paid.violations ?? paid.error)).toBe("PAID");
    expect(paid.payment?.settlement?.status).toBe("CONFIRMED");
    expect(stub.authReqIds.length - before).toBe(1);
    const approvals = h.ledgerEntries().filter((e) => e.type === "HUMAN_APPROVAL" && e.sessionId === "sess_e2e14c");
    expect(approvals.map((e) => e.data.channel)).toEqual(["portal"]);
  }, 60_000);

  it("T-E2E-14 no token, key or sign-in reaches the ledger, the portal's log or its answers (NFR-003)", async () => {
    const token = await portal.adminToken("carol", { user: false });
    const answer = await portal.call("GET", "/api/admin/escalations", { token });
    const everything = [readFileSync(h.ledgerPath, "utf8"), portal.rawLogs.join("\n"), answer.text].join("\n");
    for (const secret of [...Object.values(h.tokens), token, ...HARNESS_USER_MNEMONIC.split(" ").filter((w) => w.length > 5)]) {
      expect(everything.includes(secret), secret.slice(0, 6)).toBe(false);
    }
    expect((await ledgerVerify(h)).ok).toBe(true);
  });
});
