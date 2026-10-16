// End-to-end suite on the 008 harness (SPEC.md §12). Real ganache + MockUSDC, local facilitator,
// seller, L2 control and L3 verifier, driven through L1's HTTP ports.
// T-E2E-01 is owned by 008 (T024, sole writer). T-E2E-02 by 004, T-E2E-03 by 003/005,
// T-E2E-04 by 002, T-E2E-05 by 003/007.
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import { startHarness, RegressionBaseline, type Harness } from "./helpers/harness.js";
import { HttpAuthorizationGate, HttpSettlementVerifier } from "../src/layer1-intent/ports-http.js";
import { PaidResourceOrchestrator, type PaidFetchResult } from "../src/layer1-intent/orchestrator.js";
import { runScriptedAgent } from "../src/layer1-intent/scripted.js";
import { listenControl } from "../src/layer2-control/service.js";
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
