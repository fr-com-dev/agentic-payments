// Feature 002 — mandate, policy rules R1–R14, signer, authorize/budget endpoints, serialization
// (SPEC.md §8.2 L2-1, L2-2, L2-3, L2-5; T-POL-01..14). T-E2E-04 lives in test/e2e.local.test.ts.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthorizationDecision, PaymentIntent } from "../src/shared/contracts.js";
import { AuditLedger } from "../src/layer2-control/ledger.js";
import { buildMandate, loadMandate, MandateError, type SpendingMandate } from "../src/layer2-control/mandate.js";
import { decide, evaluateRequirement, type PolicyContext } from "../src/layer2-control/policy.js";
import { createControlService, createSerializer } from "../src/layer2-control/service.js";
import { PaymentSigner, type PaymentSignerLike } from "../src/layer2-control/signer.js";

const CAIP2 = "eip155:31337";
const ASSET = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const PAY_TO = "0xcccccccccccccccccccccccccccccccccccccccc";
const NET = { caip2: CAIP2 as `${string}:${string}`, asset: ASSET as `0x${string}` };
const URL_WEATHER = "http://127.0.0.1:4021/api/weather";
const NOW = Date.parse("2026-10-16T12:00:00.000Z");
// Throwaway test key (ganache account #9 of the public test mnemonic would also do); never funded.
const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

const DEFAULT_JSON = {
  mandateId: "mandate-poc-001",
  expiresAt: "2027-12-31T23:59:59Z",
  allowedSchemes: ["exact"],
  allowedPayees: [],
  allowedHosts: ["127.0.0.1:4021"],
  autoApproveMaxAtomic: "20000",
  hardCapPerPaymentAtomic: "100000",
  sessionBudgetAtomic: "100000",
  dailyBudgetAtomic: "500000",
  maxAuthorizationsPerMinute: 10,
  maxTimeoutSeconds: 300,
};

const mandate = (over: Partial<typeof DEFAULT_JSON> = {}, env: Record<string, string> = {}): SpendingMandate =>
  buildMandate({ ...DEFAULT_JSON, ...over }, NET, env);

const baseRequirement = (over: Partial<PaymentRequirements> = {}): PaymentRequirements =>
  ({
    scheme: "exact",
    network: CAIP2,
    asset: ASSET,
    amount: "1000",
    payTo: PAY_TO,
    maxTimeoutSeconds: 120,
    extra: { name: "USD Coin", version: "2" },
    ...over,
  }) as PaymentRequirements;

const baseCtx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  nowMs: NOW,
  requestedUrl: URL_WEATHER,
  challengeResourceUrl: URL_WEATHER,
  sessionCommittedAtomic: 0n,
  dailyCommittedAtomic: 0n,
  authorizationsLastMinute: 0,
  ...over,
});

const rules = (r: { violations: { rule: string }[] }) => r.violations.map((v) => v.rule);

// ---------------------------------------------------------------------------
describe("mandate loader (L2-1, CFG-3)", () => {
  it("config/mandate.json loads with the CFG-3 defaults", () => {
    const m = loadMandate(NET, {});
    expect(m).toMatchObject({ mandateId: "mandate-poc-001", autoApproveMaxAtomic: "20000", hardCapPerPaymentAtomic: "100000" });
    expect(m.allowedHosts).toEqual(["127.0.0.1:4021"]);
  });
  it("ALLOWED_PAYEES / ALLOWED_HOSTS replace the JSON lists; payees are lower-cased", () => {
    const m = mandate({}, { ALLOWED_PAYEES: "0xABCDEF0000000000000000000000000000000001, 0xAbC", ALLOWED_HOSTS: "a:1,b:2" });
    expect(m.allowedPayees).toEqual(["0xabcdef0000000000000000000000000000000001", "0xabc"]);
    expect(m.allowedHosts).toEqual(["a:1", "b:2"]);
  });
  it("networks and assets always come from the profile, even if the JSON has them", () => {
    const m = buildMandate({ ...DEFAULT_JSON, allowedNetworks: ["eip155:1"], allowedAssets: { "eip155:1": ["0x1"] } }, NET, {});
    expect(m.allowedNetworks).toEqual([CAIP2]);
    expect(m.allowedAssets).toEqual({ [CAIP2]: [ASSET.toLowerCase()] });
  });
  it("fails closed unless autoApproveMax < hardCap ≤ sessionBudget", () => {
    expect(() => mandate({ autoApproveMaxAtomic: "100000" })).toThrow(MandateError);
    expect(() => mandate({ hardCapPerPaymentAtomic: "200000" })).toThrow(/constraint/);
    expect(() => mandate({ hardCapPerPaymentAtomic: "100000", sessionBudgetAtomic: "100000" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe("policy rules (L2-2)", () => {
  const m = mandate();

  it("T-POL-01 a compliant $0.001 payment is AUTHORIZED", () => {
    expect(evaluateRequirement(baseRequirement(), m, baseCtx())).toEqual({ status: "AUTHORIZED", violations: [] });
  });

  it("T-POL-02 decide is deterministic and picks the cheapest (ties to the first offered)", () => {
    const a = baseRequirement({ amount: "5000" });
    const b = baseRequirement({ amount: "1000", payTo: PAY_TO });
    const c = baseRequirement({ amount: "1000", maxTimeoutSeconds: 60 });
    const accepts = [a, b, c];
    const snapshot = JSON.stringify(accepts);
    const r1 = decide(accepts, m, baseCtx());
    const r2 = decide(accepts, m, baseCtx());
    expect(r1).toEqual(r2);
    expect(r1.status).toBe("AUTHORIZED");
    expect(r1.chosen).toBe(b);
    expect(JSON.stringify(accepts)).toBe(snapshot);
  });

  it("T-POL-03 network_not_allowed", () => {
    expect(rules(evaluateRequirement(baseRequirement({ network: "eip155:1" }), m, baseCtx()))).toContain("network_not_allowed");
  });
  it("T-POL-04 asset_not_allowed (and a mixed-case allowlisted asset still passes)", () => {
    expect(rules(evaluateRequirement(baseRequirement({ asset: "0x1111111111111111111111111111111111111111" }), m, baseCtx()))).toEqual([
      "asset_not_allowed",
    ]);
    expect(evaluateRequirement(baseRequirement({ asset: ASSET.toUpperCase().replace("0X", "0x") }), m, baseCtx()).status).toBe("AUTHORIZED");
  });
  it("T-POL-05 payee_not_allowed (empty allowlist means any payee)", () => {
    const strict = mandate({}, { ALLOWED_PAYEES: "0x0000000000000000000000000000000000000001" });
    expect(rules(evaluateRequirement(baseRequirement(), strict, baseCtx()))).toEqual(["payee_not_allowed"]);
    expect(evaluateRequirement(baseRequirement(), m, baseCtx()).status).toBe("AUTHORIZED");
    const upper = mandate({}, { ALLOWED_PAYEES: PAY_TO.toUpperCase().replace("0X", "0x") });
    expect(evaluateRequirement(baseRequirement(), upper, baseCtx()).status).toBe("AUTHORIZED");
  });
  it("T-POL-06 scheme_not_allowed", () => {
    expect(rules(evaluateRequirement(baseRequirement({ scheme: "upto" }), m, baseCtx()))).toEqual(["scheme_not_allowed"]);
  });
  it("T-POL-07 timeout_out_of_range for 0 and for max + 1", () => {
    expect(rules(evaluateRequirement(baseRequirement({ maxTimeoutSeconds: 0 }), m, baseCtx()))).toEqual(["timeout_out_of_range"]);
    expect(rules(evaluateRequirement(baseRequirement({ maxTimeoutSeconds: 301 }), m, baseCtx()))).toEqual(["timeout_out_of_range"]);
    expect(evaluateRequirement(baseRequirement({ maxTimeoutSeconds: 300 }), m, baseCtx()).status).toBe("AUTHORIZED");
  });
  it("T-POL-08 hard_cap_exceeded at 100001", () => {
    // 100001 also exceeds the 100000 session budget (R11); the hard cap is reported first.
    expect(rules(evaluateRequirement(baseRequirement({ amount: "100001" }), m, baseCtx()))).toEqual(["hard_cap_exceeded", "session_budget_exceeded"]);
  });
  it("T-POL-09 amount_invalid for a negative amount", () => {
    expect(rules(evaluateRequirement(baseRequirement({ amount: "-5" }), m, baseCtx()))).toEqual(["amount_invalid"]);
  });
  it("T-POL-10 amount_invalid for a decimal amount (no BigInt throw), and for zero", () => {
    expect(rules(evaluateRequirement(baseRequirement({ amount: "1.5" }), m, baseCtx()))).toEqual(["amount_invalid"]);
    expect(rules(evaluateRequirement(baseRequirement({ amount: "0" }), m, baseCtx()))).toEqual(["amount_invalid"]);
  });

  it("T-POL-11 resource_binding_mismatch; host_not_allowed for the localhost alias and an unparsable URL", () => {
    expect(rules(evaluateRequirement(baseRequirement(), m, baseCtx({ challengeResourceUrl: "http://evil.example/api/weather" })))).toEqual([
      "resource_binding_mismatch",
    ]);
    const alias = "http://localhost:4021/api/weather";
    expect(rules(evaluateRequirement(baseRequirement(), m, baseCtx({ requestedUrl: alias, challengeResourceUrl: alias })))).toEqual([
      "host_not_allowed",
    ]);
    expect(rules(evaluateRequirement(baseRequirement(), m, baseCtx({ requestedUrl: "not a url" })))).toContain("host_not_allowed");
  });

  it("T-POL-12 session and daily budgets include the new amount; the boundary passes", () => {
    expect(evaluateRequirement(baseRequirement({ amount: "1000" }), m, baseCtx({ sessionCommittedAtomic: 99000n })).status).toBe("AUTHORIZED");
    expect(rules(evaluateRequirement(baseRequirement({ amount: "1001" }), m, baseCtx({ sessionCommittedAtomic: 99000n })))).toEqual([
      "session_budget_exceeded",
    ]);
    expect(evaluateRequirement(baseRequirement({ amount: "1000" }), m, baseCtx({ dailyCommittedAtomic: 499000n })).status).toBe("AUTHORIZED");
    expect(rules(evaluateRequirement(baseRequirement({ amount: "1001" }), m, baseCtx({ dailyCommittedAtomic: 499000n })))).toEqual([
      "daily_budget_exceeded",
    ]);
    expect(
      rules(evaluateRequirement(baseRequirement({ amount: "1001" }), m, baseCtx({ sessionCommittedAtomic: 99000n, dailyCommittedAtomic: 499000n }))),
    ).toEqual(["session_budget_exceeded", "daily_budget_exceeded"]);
  });

  it("T-POL-13 escalation cases: 50000 escalates, 20000 does not, over the cap is DENIED without R14", () => {
    const e = evaluateRequirement(baseRequirement({ amount: "50000" }), m, baseCtx());
    expect(e.status).toBe("ESCALATE");
    expect(rules(e)).toEqual(["human_approval_required"]);
    expect(evaluateRequirement(baseRequirement({ amount: "20000" }), m, baseCtx()).status).toBe("AUTHORIZED");
    const d = evaluateRequirement(baseRequirement({ amount: "200000" }), m, baseCtx());
    expect(d.status).toBe("DENIED");
    expect(rules(d)).toContain("hard_cap_exceeded");
    expect(rules(d)).not.toContain("human_approval_required");
  });

  it("T-POL-13 approval-match cases: exact match authorizes; another amount escalates; never overrides a DENY", () => {
    const approved = { payTo: PAY_TO.toUpperCase().replace("0X", "0x"), amount: "50000", approvalId: "apr_test" };
    expect(evaluateRequirement(baseRequirement({ amount: "50000" }), m, baseCtx({ humanApprovedFor: approved })).status).toBe("AUTHORIZED");
    expect(evaluateRequirement(baseRequirement({ amount: "50001" }), m, baseCtx({ humanApprovedFor: approved })).status).toBe("ESCALATE");
    const over = evaluateRequirement(baseRequirement({ amount: "200000" }), m, baseCtx({ humanApprovedFor: { ...approved, amount: "200000" } }));
    expect(over.status).toBe("DENIED");
    expect(rules(over)).toEqual(["hard_cap_exceeded", "session_budget_exceeded"]);
  });

  it("T-POL-14 mandate_expired, velocity_limit, and decide([]) → no_payment_options", () => {
    expect(rules(evaluateRequirement(baseRequirement(), m, baseCtx({ nowMs: Date.parse("2028-01-01T00:00:00Z") })))).toEqual([
      "mandate_expired",
    ]);
    expect(rules(evaluateRequirement(baseRequirement(), m, baseCtx({ authorizationsLastMinute: 10 })))).toEqual(["velocity_limit"]);
    expect(evaluateRequirement(baseRequirement(), m, baseCtx({ authorizationsLastMinute: 9 })).status).toBe("AUTHORIZED");
    expect(decide([], m, baseCtx())).toEqual({
      status: "DENIED",
      violations: [{ rule: "no_payment_options", detail: expect.any(String) }],
    });
  });

  it("collects every DENY violation in R-order; amount_invalid stops after R9; decide flattens", () => {
    const r = evaluateRequirement(baseRequirement({ network: "eip155:1", amount: "500000" }), mandate({}, { ALLOWED_PAYEES: "0x01" }), baseCtx());
    expect(rules(r)).toEqual(["network_not_allowed", "asset_not_allowed", "payee_not_allowed", "hard_cap_exceeded", "session_budget_exceeded"]); // 500000 = daily cap: not exceeded
    const inv = evaluateRequirement(baseRequirement({ scheme: "upto", amount: "abc" }), m, baseCtx({ authorizationsLastMinute: 99 }));
    expect(rules(inv)).toEqual(["scheme_not_allowed", "amount_invalid"]);
    const flat = decide([baseRequirement({ scheme: "upto" }), baseRequirement({ amount: "100001" })], m, baseCtx());
    expect(flat.status).toBe("DENIED");
    expect(rules(flat)).toEqual(["scheme_not_allowed", "hard_cap_exceeded", "session_budget_exceeded"]);
  });

  it("decide returns ESCALATE with that requirement when nothing is AUTHORIZED", () => {
    const esc = baseRequirement({ amount: "50000" });
    const r = decide([baseRequirement({ scheme: "upto" }), esc], m, baseCtx());
    expect(r.status).toBe("ESCALATE");
    expect(r.chosen).toBe(esc);
    expect(rules(r)).toEqual(["human_approval_required"]);
  });

  it("every rule ID in contracts/policy-rules.md appears in this file (SC-001)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL(import.meta.url), "utf8");
    for (const id of [
      "mandate_expired", "scheme_not_allowed", "network_not_allowed", "asset_not_allowed", "payee_not_allowed",
      "host_not_allowed", "resource_binding_mismatch", "timeout_out_of_range", "amount_invalid", "hard_cap_exceeded",
      "session_budget_exceeded", "daily_budget_exceeded", "velocity_limit", "human_approval_required",
      "no_payment_options", "signer_rejected",
    ]) {
      expect(src.split(`"${id}"`).length - 1, id).toBeGreaterThan(1);
    }
  });
});

// ---------------------------------------------------------------------------
const challengeFor = (accepts: PaymentRequirements[], url = URL_WEATHER): PaymentRequired =>
  ({ x402Version: 2, resource: { url, description: "", mimeType: "application/json" }, accepts }) as PaymentRequired;

describe("PaymentSigner (L2-3)", () => {
  const signer = new PaymentSigner(TEST_KEY, NET, "100000");

  it("signs exactly the approved requirement (INV-6) and returns headers, payer and validBefore in seconds", async () => {
    const approved = baseRequirement();
    const other = baseRequirement({ amount: "5000" });
    const out = await signer.sign(challengeFor([other, approved]), approved);
    expect(Object.keys(out.headers)).toEqual(["PAYMENT-SIGNATURE"]);
    const payload = decodePaymentSignatureHeader(out.headers["PAYMENT-SIGNATURE"]!);
    expect(payload.accepted).toEqual(approved);
    expect(out.payer.toLowerCase()).toBe(signer.address.toLowerCase());
    expect(Number.isInteger(out.validBefore)).toBe(true);
    expect(out.validBefore).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(out.validBefore).toBeLessThan(Math.floor(Date.now() / 1000) + 10_000);
  });

  it("the SDK spend control is an independent second cap: above the hard cap it throws", async () => {
    const big = baseRequirement({ amount: "100001" });
    await expect(signer.sign(challengeFor([big]), big)).rejects.toThrow();
  });

  it("exposes no key", () => {
    expect(Object.values(signer).join(" ")).not.toContain(TEST_KEY.slice(2));
  });
});

// ---------------------------------------------------------------------------
// Feature 010 — R15 human_rejected (SPEC.md §8.2 L2-2; contracts/policy-r15.md).
describe("T-POL-15 human_rejected (R15)", () => {
  const m = mandate();
  const rejected = { rejectionId: "rej_0b6f3c2e-1d4a-4e8b-9f1a-2c3d4e5f6a7b" };

  it("T-POL-15 a rejected (session, resource) is DENIED with exactly human_rejected, at any amount", () => {
    const big = evaluateRequirement(baseRequirement({ amount: "50000" }), m, baseCtx({ humanRejected: rejected }));
    expect(big.status).toBe("DENIED");
    expect(rules(big)).toEqual(["human_rejected"]);
    const small = evaluateRequirement(baseRequirement({ amount: "5000" }), m, baseCtx({ humanRejected: rejected }));
    expect(small.status).toBe("DENIED");
    expect(rules(small)).toEqual(["human_rejected"]);
  });

  it("T-POL-15 an approval never lifts human_rejected (INV-12)", () => {
    const approved = { payTo: PAY_TO, amount: "50000", approvalId: "apr_test" };
    const r = evaluateRequirement(baseRequirement({ amount: "50000" }), m, baseCtx({ humanRejected: rejected, humanApprovedFor: approved }));
    expect(r.status).toBe("DENIED");
    expect(rules(r)).toEqual(["human_rejected"]);
  });

  it("T-POL-15 human_rejected is collected with the other DENY rules", () => {
    const r = evaluateRequirement(baseRequirement({ amount: "50000" }), m, baseCtx({ humanRejected: rejected, sessionCommittedAtomic: 90000n }));
    expect(r.status).toBe("DENIED");
    expect(rules(r)).toEqual(expect.arrayContaining(["session_budget_exceeded", "human_rejected"]));
  });

  it("T-POL-15 must fail without the rule: the same request without humanRejected escalates", () => {
    const r = evaluateRequirement(baseRequirement({ amount: "50000" }), m, baseCtx());
    expect(r.status).toBe("ESCALATE");
    expect(rules(r)).toEqual(["human_approval_required"]);
  });

  it("T-POL-15 the detail carries only the rejectionId, never operator free text (SEC-12)", () => {
    const r = evaluateRequirement(baseRequirement({ amount: "50000" }), m, baseCtx({ humanRejected: rejected }));
    expect(r.violations[0]!.detail).toMatch(/^rejected by the operator \(rej_[\w-]+\)$/);
    expect(decide([baseRequirement({ amount: "50000" })], m, baseCtx({ humanRejected: rejected })).status).toBe("DENIED");
  });
});

// ---------------------------------------------------------------------------
const TOKENS = { control: "t-control", settlement: "t-settlement", operator: "t-operator" };

let dir: string;
let servers: Server[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "l2-"));
});
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers = [];
  rmSync(dir, { recursive: true, force: true });
});

const fakeSigner = (impl?: PaymentSignerLike["sign"]): PaymentSignerLike => ({
  address: "0x00000000000000000000000000000000000000f1",
  sign:
    impl ??
    (async () => ({ headers: { "PAYMENT-SIGNATURE": "opaque" }, payer: "0x00000000000000000000000000000000000000f1", validBefore: Math.floor(NOW / 1000) + 120 })),
});

async function startService(opts: { signer?: PaymentSignerLike; signerLatencyMs?: number; m?: SpendingMandate; now?: () => number } = {}) {
  const ledger = new AuditLedger(join(dir, ".local", "ledger-local.jsonl"));
  const svc = createControlService({
    mandate: opts.m ?? mandate(),
    signer: opts.signer ?? fakeSigner(),
    ledger,
    asset: { address: ASSET, decimals: 6 },
    tokens: TOKENS,
    ...(opts.signerLatencyMs !== undefined && { signerLatencyMs: opts.signerLatencyMs }),
    now: opts.now ?? (() => NOW),
  });
  const server = await new Promise<Server>((r) => {
    const s = svc.app.listen(0, "127.0.0.1", () => r(s));
  });
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { ledger, base, svc };
}

let n = 0;
const intent = (over: Partial<PaymentIntent> & { accepts?: PaymentRequirements[]; url?: string } = {}): PaymentIntent => {
  const url = over.url ?? URL_WEATHER;
  return {
    intentId: `int_${++n}`,
    sessionId: "sess_test",
    resourceUrl: url,
    paymentRequired: challengeFor(over.accepts ?? [baseRequirement()], url),
    purpose: "weather for the report",
    createdAt: new Date(NOW).toISOString(),
    ...over,
  };
};

const post = (base: string, body: unknown, token = TOKENS.control) =>
  fetch(`${base}/v1/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

describe("POST /v1/authorize contract (L2-5)", () => {
  it("compliant intent → 200 AUTHORIZED with opaque headers and remaining budget; INTENT + AUTHORIZED written", async () => {
    const { base, ledger } = await startService();
    const res = await post(base, intent());
    expect(res.status).toBe(200);
    const d = (await res.json()) as AuthorizationDecision;
    expect(d).toMatchObject({ status: "AUTHORIZED", paymentHeaders: { "PAYMENT-SIGNATURE": "opaque" }, remainingSessionBudgetAtomic: "99000" });
    expect(ledger.entries().map((e) => e.type)).toEqual(["INTENT", "AUTHORIZED"]);
    const auth = ledger.entries()[1]!;
    expect(auth.data).toMatchObject({ amount: "1000", mandateId: "mandate-poc-001", approvalRef: null, resourceUrl: URL_WEATHER });
    expect(ledger.entries()[0]!.data.purpose).toBe("weather for the report");
  });

  it("400 on missing ids, non-array accepts or a non-http URL; 401 on a missing or wrong token; none writes the ledger", async () => {
    const { base, ledger } = await startService();
    const good = intent();
    const cases: Array<[unknown, string?]> = [
      [{ ...good, intentId: undefined }],
      [{ ...good, sessionId: "" }],
      [{ ...good, paymentRequired: { ...good.paymentRequired, accepts: "nope" } }],
      [{ ...good, resourceUrl: "file:///etc/passwd" }],
    ];
    for (const [body] of cases) expect((await post(base, body)).status).toBe(400);
    expect((await post(base, good, TOKENS.settlement)).status).toBe(401);
    expect((await post(base, good, TOKENS.operator)).status).toBe(401);
    const noAuth = await fetch(`${base}/v1/authorize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(good) });
    expect(noAuth.status).toBe(401);
    expect(ledger.entries()).toHaveLength(0);
  });

  it("a signer error becomes DENIED signer_rejected with detail ≤ 300 chars", async () => {
    const { base, ledger } = await startService({ signer: fakeSigner(async () => Promise.reject(new Error("x".repeat(400)))) });
    const d = (await (await post(base, intent())).json()) as AuthorizationDecision;
    expect(d.status).toBe("DENIED");
    if (d.status === "AUTHORIZED") throw new Error("unreachable");
    expect(d.violations[0]!.rule).toBe("signer_rejected");
    expect(d.violations[0]!.detail.length).toBeLessThanOrEqual(300);
    expect(ledger.entries().map((e) => e.type)).toEqual(["INTENT", "DENIED"]);
  });

  it("NFR-009: each valid call writes exactly one INTENT and one outcome entry, with resourceKey on DENIED/ESCALATED", async () => {
    const { base, ledger } = await startService();
    await post(base, intent()); // AUTHORIZED
    await post(base, intent({ accepts: [baseRequirement({ amount: "500000" })] })); // DENIED
    await post(base, intent({ accepts: [baseRequirement({ amount: "50000" })], url: `${URL_WEATHER}?city=Lima` })); // ESCALATE
    const types = ledger.entries().map((e) => e.type);
    expect(types).toEqual(["INTENT", "AUTHORIZED", "INTENT", "DENIED", "INTENT", "ESCALATED"]);
    const denied = ledger.entries()[3]!;
    expect(denied.data.resourceKey).toBe(URL_WEATHER);
    const esc = ledger.entries()[5]!;
    expect(esc.data).toMatchObject({ resourceKey: URL_WEATHER, payTo: PAY_TO, amount: "50000" });
    expect((esc.data.violations as { rule: string }[])[0]!.rule).toBe("human_approval_required");
  });
});

describe("GET /v1/budget/:sessionId (L2-5)", () => {
  it("returns BudgetStatus from ledger-derived committed spend; perPaymentCap is the auto-approve limit", async () => {
    const { base } = await startService();
    for (const amt of ["1000", "5000"]) await post(base, intent({ accepts: [baseRequirement({ amount: amt })] }));
    const res = await fetch(`${base}/v1/budget/sess_test`, { headers: { authorization: `Bearer ${TOKENS.control}` } });
    expect(await res.json()).toEqual({
      sessionId: "sess_test",
      asset: ASSET,
      decimals: 6,
      sessionCapAtomic: "100000",
      spentOrReservedAtomic: "6000",
      remainingAtomic: "94000",
      perPaymentCapAtomic: "20000",
    });
  });

  it("unknown session → 200 with zero spend; operator token → 401", async () => {
    const { base } = await startService();
    const r = await fetch(`${base}/v1/budget/sess_none`, { headers: { authorization: `Bearer ${TOKENS.control}` } });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ spentOrReservedAtomic: "0", remainingAtomic: "100000" });
    const bad = await fetch(`${base}/v1/budget/sess_none`, { headers: { authorization: `Bearer ${TOKENS.operator}` } });
    expect(bad.status).toBe(401);
  });

  it("remainingAtomic is floored at 0", async () => {
    // hardCap = sessionBudget, so a later mandate with a smaller budget can see committed > cap.
    const { base, ledger } = await startService();
    await post(base, intent({ accepts: [baseRequirement({ amount: "20000" })] }));
    const small = createControlService({
      mandate: mandate({ autoApproveMaxAtomic: "1000", hardCapPerPaymentAtomic: "5000", sessionBudgetAtomic: "10000" }),
      signer: fakeSigner(),
      ledger,
      asset: { address: ASSET, decimals: 6 },
      tokens: TOKENS,
      now: () => NOW,
    });
    const s = await new Promise<Server>((r) => {
      const srv = small.app.listen(0, "127.0.0.1", () => r(srv));
    });
    servers.push(s);
    const r = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/v1/budget/sess_test`, {
      headers: { authorization: `Bearer ${TOKENS.control}` },
    });
    expect(await r.json()).toMatchObject({ spentOrReservedAtomic: "20000", remainingAtomic: "0" });
  });
});

describe("approvals lift R14 once per approval (L2-4.2, D2)", () => {
  it("an open HUMAN_APPROVAL authorizes the matching request and is consumed by its approvalId", async () => {
    const { base, ledger } = await startService();
    const req50 = baseRequirement({ amount: "50000" });
    const first = (await (await post(base, intent({ accepts: [req50] }))).json()) as AuthorizationDecision;
    expect(first.status).toBe("ESCALATE");
    ledger.append(
      {
        type: "HUMAN_APPROVAL",
        sessionId: "sess_test",
        authorizationId: first.authorizationId,
        data: {
          approvalId: "apr_1",
          escalationId: first.authorizationId,
          resourceKey: URL_WEATHER,
          payTo: PAY_TO,
          amount: "50000",
          approver: "operator",
          expiresAtMs: NOW + 600_000,
        },
      },
      NOW,
    );
    const paid = (await (await post(base, intent({ accepts: [req50] }))).json()) as AuthorizationDecision;
    expect(paid.status).toBe("AUTHORIZED");
    const authEntry = ledger.entries().filter((e) => e.type === "AUTHORIZED").at(-1)!;
    expect(authEntry.data.approvalRef).toBe("apr_1");
    const again = (await (await post(base, intent({ accepts: [req50] }))).json()) as AuthorizationDecision;
    expect(again.status).toBe("ESCALATE");
  });

  it("an approval is not consumed by a payment under the auto-approve limit", async () => {
    const { base, ledger } = await startService();
    ledger.append(
      {
        type: "HUMAN_APPROVAL",
        sessionId: "sess_test",
        data: { approvalId: "apr_2", escalationId: "auth_x", resourceKey: URL_WEATHER, payTo: PAY_TO, amount: "1000", approver: "op", expiresAtMs: NOW + 600_000 },
      },
      NOW,
    );
    await post(base, intent());
    expect(ledger.entries().find((e) => e.type === "AUTHORIZED")!.data.approvalRef).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("serialization (INV-8)", () => {
  it("the promise-chain mutex runs callers strictly one at a time, even after a failure", async () => {
    const serialize = createSerializer();
    const log: string[] = [];
    const job = (id: string, ms: number, fail = false) =>
      serialize(async () => {
        log.push(`start ${id}`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`end ${id}`);
        if (fail) throw new Error(id);
        return id;
      });
    const results = await Promise.allSettled([job("a", 20, true), job("b", 5), job("c", 1)]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });
});

// Writes a scratch mandate file so loadMandate's file path is exercised.
describe("loadMandate file path", () => {
  it("reads the given file", () => {
    const f = join(dir, "m.json");
    writeFileSync(f, JSON.stringify({ ...DEFAULT_JSON, mandateId: "m-file" }));
    expect(loadMandate(NET, {}, f).mandateId).toBe("m-file");
  });
});

// ---------------------------------------------------------------------------
// Feature 004 — human approval of escalations (SPEC.md L2-4.2, L2-5 approvals; T-POL-13, T-E2E-02).
// These run in-process (createControlService + real ledger + real HTTP). The end-to-end T-E2E-02
// (L1, L3, seller, chain) lives in test/e2e.local.test.ts.

const approveCall = (base: string, authorizationId: string, body: unknown = {}, token: string | null = TOKENS.operator) =>
  fetch(`${base}/v1/approvals/${authorizationId}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token !== null && { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });

const req50 = () => baseRequirement({ amount: "50000" });
const authz = async (base: string, i: PaymentIntent) => (await (await post(base, i)).json()) as AuthorizationDecision;
const approvals = (ledger: AuditLedger) => ledger.entries().filter((e) => e.type === "HUMAN_APPROVAL");

describe("004 US1 escalation is never signed (T-POL-13, FR-004)", () => {
  it("ESCALATE skips the signer and records ESCALATED with violations, resourceKey, payTo and amount", async () => {
    let signed = 0;
    const { base, ledger } = await startService({
      signer: fakeSigner(async () => {
        signed++;
        throw new Error("must not sign");
      }),
    });
    const d = await authz(base, intent({ accepts: [req50()], url: `${URL_WEATHER}?city=Lima` }));
    expect(d.status).toBe("ESCALATE");
    expect(signed).toBe(0);
    const esc = ledger.entries().find((e) => e.type === "ESCALATED")!;
    expect(esc.authorizationId).toBe(d.authorizationId);
    expect((esc.data.violations as { rule: string }[]).map((v) => v.rule)).toEqual(["human_approval_required"]);
    expect(esc.data).toMatchObject({ resourceKey: URL_WEATHER, payTo: PAY_TO, amount: "50000" });
    expect(ledger.entries().some((e) => e.type === "AUTHORIZED")).toBe(false);
  });
});

describe("004 US2 operator approves one exact escalation (T-POL-13, in-process)", () => {
  it("T-POL-13 matching approval: a different payTo still escalates", () => {
    const approved = { payTo: PAY_TO, amount: "50000", approvalId: "apr_x" };
    const other = evaluateRequirement(
      baseRequirement({ amount: "50000", payTo: "0xdddddddddddddddddddddddddddddddddddddddd" }),
      mandate(),
      baseCtx({ humanApprovedFor: approved }),
    );
    expect(other.status).toBe("ESCALATE");
  });

  it("004 in-process HITL approve and consume: escalate → approve (200, apr_, TTL 600 s) → AUTHORIZED with approvalRef → escalates again", async () => {
    const { base, ledger } = await startService();
    const esc = await authz(base, intent({ accepts: [req50()] }));
    expect(esc.status).toBe("ESCALATE");
    const res = await approveCall(base, esc.authorizationId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; approvalId: string; expiresAt: string };
    expect(body.ok).toBe(true);
    expect(body.approvalId).toMatch(/^apr_[0-9a-f-]{36}$/);
    expect(Date.parse(body.expiresAt) - NOW).toBe(600_000);
    const appr = approvals(ledger)[0]!;
    expect(appr.data).toMatchObject({
      approvalId: body.approvalId,
      escalationId: esc.authorizationId,
      resourceKey: URL_WEATHER,
      payTo: PAY_TO,
      amount: "50000",
      approver: "operator",
      expiresAtMs: NOW + 600_000,
    });
    expect(appr.sessionId).toBe("sess_test");

    const paid = await authz(base, intent({ accepts: [req50()] }));
    expect(paid.status).toBe("AUTHORIZED");
    const authEntry = ledger.entries().find((e) => e.type === "AUTHORIZED")!;
    expect(authEntry.data.approvalRef).toBe(body.approvalId);

    const again = await authz(base, intent({ accepts: [req50()] }));
    expect(again.status).toBe("ESCALATE");
  });

  it("approvals errors: unknown, DENIED and AUTHORIZED ids → 404; bad ttlSeconds → 400; none appends", async () => {
    const { base, ledger } = await startService();
    const denied = await authz(base, intent({ accepts: [baseRequirement({ amount: "500000" })] }));
    expect(denied.status).toBe("DENIED");
    const ok = await authz(base, intent());
    expect(ok.status).toBe("AUTHORIZED");
    const esc = await authz(base, intent({ accepts: [req50()] }));
    const before = ledger.entries().length;
    for (const id of ["auth_unknown", denied.authorizationId, ok.authorizationId]) {
      const r = await approveCall(base, id);
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: "not found" });
    }
    for (const ttl of [0, -5, 1.5, "x"]) {
      const r = await approveCall(base, esc.authorizationId, { ttlSeconds: ttl });
      expect(r.status, String(ttl)).toBe(400);
    }
    expect(ledger.entries().length).toBe(before);
  });

  it("edge cases: another session escalates; an expired approval escalates; a different query string matches", async () => {
    let clock = NOW;
    const { base } = await startService({ now: () => clock });
    const esc = await authz(base, intent({ accepts: [req50()], url: `${URL_WEATHER}?city=Lima` }));
    expect((await approveCall(base, esc.authorizationId, { ttlSeconds: 1 })).status).toBe(200);

    const other = await authz(base, intent({ accepts: [req50()], url: `${URL_WEATHER}?city=Lima`, sessionId: "sess_other" }));
    expect(other.status).toBe("ESCALATE");

    clock = NOW + 1001;
    const expired = await authz(base, intent({ accepts: [req50()], url: `${URL_WEATHER}?city=Lima` }));
    expect(expired.status).toBe("ESCALATE");
    expect(expired.authorizationId).not.toBe(esc.authorizationId); // 010: esc is approved (final), so this is a new escalation

    // 010 FR-011: one approval per escalation, so approve the new escalation rather than re-approving esc.
    expect((await approveCall(base, expired.authorizationId)).status).toBe(200);
    const quito = await authz(base, intent({ accepts: [req50()], url: `${URL_WEATHER}?city=Quito` }));
    expect(quito.status).toBe("AUTHORIZED");
  });

  it("004 in-process single consumption under concurrency: two concurrent identical intents after one approval → exactly one AUTHORIZED", async () => {
    const { base, ledger } = await startService({ signerLatencyMs: 25 });
    const esc = await authz(base, intent({ accepts: [req50()] }));
    const { approvalId } = (await (await approveCall(base, esc.authorizationId)).json()) as { approvalId: string };
    const ds = await Promise.all([authz(base, intent({ accepts: [req50()] })), authz(base, intent({ accepts: [req50()] }))]);
    expect(ds.map((d) => d.status).sort()).toEqual(["AUTHORIZED", "ESCALATE"]);
    const refs = ledger.entries().filter((e) => e.type === "AUTHORIZED").map((e) => e.data.approvalRef);
    expect(refs).toEqual([approvalId]);
  });

  it("004/010 in-process re-approve returns the existing approval: one escalation pays once; the next request escalates under a new ID (FR-011)", async () => {
    // sessionBudget 200000: under the default 100000 a second 50000 request would be DENIED before R14 can fire.
    let clock = NOW;
    const { base, ledger } = await startService({ m: mandate({ sessionBudgetAtomic: "200000" }), now: () => clock++ });
    const esc = await authz(base, intent({ accepts: [req50()] }));
    const a1 = (await (await approveCall(base, esc.authorizationId)).json()) as { approvalId: string; expiresAt: string };
    const a2 = (await (await approveCall(base, esc.authorizationId)).json()) as { approvalId: string; expiresAt: string; alreadyApproved?: boolean };
    expect(a2).toEqual({ ok: true, approvalId: a1.approvalId, expiresAt: a1.expiresAt, alreadyApproved: true });
    expect(approvals(ledger)).toHaveLength(1);
    const d1 = await authz(base, intent({ accepts: [req50()] }));
    const d2 = await authz(base, intent({ accepts: [req50()] }));
    expect(d1.status).toBe("AUTHORIZED");
    expect(d2.status).toBe("ESCALATE");
    expect(d2.authorizationId).not.toBe(esc.authorizationId);
    if (d2.status !== "AUTHORIZED") expect(d2.violations.map((v) => v.rule)).toEqual(["human_approval_required"]);
    const refs = ledger.entries().filter((e) => e.type === "AUTHORIZED").map((e) => e.data.approvalRef);
    expect(refs).toEqual([a1.approvalId]);
  });
});

describe("004 US3 the agent cannot approve its own escalations (SEC-8, INV-13)", () => {
  it("004 in-process agent token cannot approve: control, settlement, verifier and no token → 401, no HUMAN_APPROVAL", async () => {
    const { base, ledger } = await startService();
    const esc = await authz(base, intent({ accepts: [req50()] }));
    for (const token of [TOKENS.control, TOKENS.settlement, "t-verifier", null]) {
      const r = await approveCall(base, esc.authorizationId, { ttlSeconds: 0 }, token);
      expect(r.status, String(token)).toBe(401); // 401 precedes body validation
      expect(await r.json()).toEqual({ error: "unauthorized" });
    }
    expect(approvals(ledger)).toHaveLength(0);
  });
});

describe("004 US4 an approval never overrides a hard limit (INV-12)", () => {
  const approved = { payTo: PAY_TO, amount: "50000", approvalId: "apr_x" };
  it.each([
    ["session_budget_exceeded", {}, baseCtx({ humanApprovedFor: approved, sessionCommittedAtomic: 60000n })],
    ["velocity_limit", {}, baseCtx({ humanApprovedFor: approved, authorizationsLastMinute: 10 })],
    ["mandate_expired", {}, baseCtx({ humanApprovedFor: approved, nowMs: Date.parse("2028-01-01T00:00:00Z") })],
    ["payee_not_allowed", { ALLOWED_PAYEES: "0x01" }, baseCtx({ humanApprovedFor: approved })],
    ["host_not_allowed", {}, baseCtx({ humanApprovedFor: approved, requestedUrl: "http://localhost:4021/api/weather", challengeResourceUrl: "http://localhost:4021/api/weather" })],
  ] as const)("T-POL-13 approval never overrides DENY: %s", (rule, env, ctx) => {
    const r = evaluateRequirement(req50(), mandate({}, env), ctx);
    expect(r.status).toBe("DENIED");
    expect(rules(r)).toContain(rule);
    expect(rules(r)).not.toContain("human_approval_required");
  });

  it("T-POL-13 approval never overrides DENY: hard_cap_exceeded", () => {
    const r = evaluateRequirement(baseRequirement({ amount: "150000" }), mandate(), baseCtx({ humanApprovedFor: { ...approved, amount: "150000" } }));
    expect(r.status).toBe("DENIED");
    expect(rules(r)).toContain("hard_cap_exceeded");
    expect(rules(r)).not.toContain("human_approval_required");
  });

  it("an approved request denied by the session budget leaves the approval open (FR-011)", async () => {
    const { base, ledger } = await startService();
    const esc = await authz(base, intent({ accepts: [req50()] }));
    const { approvalId } = (await (await approveCall(base, esc.authorizationId)).json()) as { approvalId: string };
    for (let i = 0; i < 3; i++) expect((await authz(base, intent({ accepts: [baseRequirement({ amount: "20000" })] }))).status).toBe("AUTHORIZED");
    const d = await authz(base, intent({ accepts: [req50()] }));
    expect(d.status).toBe("DENIED");
    if (d.status !== "AUTHORIZED") expect(d.violations.map((v) => v.rule)).toEqual(["session_budget_exceeded"]);
    expect(ledger.entries().some((e) => e.type === "AUTHORIZED" && e.data.approvalRef === approvalId)).toBe(false);
    expect(ledger.findOpenApproval("sess_test", URL_WEATHER, NOW)?.data.approvalId).toBe(approvalId);
  });
});

describe("004 US5 operator approve CLI (scripts/approve.ts)", () => {
  const runCli = async (args: string[], env: Record<string, string>) => {
    const { spawn } = await import("node:child_process");
    const childEnv: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env };
    for (const [k, v] of Object.entries(process.env)) if (k.startsWith("NODE_") && v !== undefined) childEnv[k] = v;
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const p = spawn("node_modules/.bin/tsx", ["scripts/approve.ts", ...args], { env: childEnv });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      p.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  };

  it("escalated id → exit 0 with JSON and approver recorded; unknown id → exit 1 with 404; no args → exit 2 with usage", async () => {
    const { base, ledger } = await startService();
    const esc = await authz(base, intent({ accepts: [req50()] }));
    const env = { CONTROL_URL: base, OPERATOR_TOKEN: TOKENS.operator };

    const ok = await runCli([esc.authorizationId, "alice"], env);
    expect(ok.code, ok.stderr).toBe(0);
    const out = JSON.parse(ok.stdout) as { ok: boolean; approvalId: string; expiresAt: string };
    expect(out.ok).toBe(true);
    expect(out.approvalId).toMatch(/^apr_/);
    expect(approvals(ledger)[0]!.data.approver).toBe("alice");

    const missing = await runCli(["auth_unknown"], env);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("404");

    const usage = await runCli([], env);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain("usage");
  });
});

describe("004 approve CLI isolation (T031)", () => {
  it("scripts/approve.ts never references the payer key or any other role's token, and imports only src/shared", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("scripts/approve.ts", "utf8");
    for (const name of ["PAYER_PRIVATE_KEY", "CONTROL_TOKEN", "VERIFIER_TOKEN", "SETTLEMENT_TOKEN", "ANTHROPIC_API_KEY"]) {
      expect(src, name).not.toContain(name);
    }
    const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
    expect(imports.filter((s) => s.startsWith(".")).every((s) => s.startsWith("../src/shared/"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Feature 010 — escalation lifecycle: operator rejection, final states, expiry, notification
// (SPEC.md §8.2 L2-4.3, L2-5; contracts/control-api.md). In-process, like the 004 section above.

const rejectCall = (base: string, authorizationId: string, body: unknown = {}, token: string | null = TOKENS.operator) =>
  fetch(`${base}/v1/rejections/${authorizationId}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token !== null && { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });
const rejections = (ledger: AuditLedger) => ledger.entries().filter((e) => e.type === "HUMAN_REJECTION");
type RejectBody = { ok: boolean; rejectionId: string; rejectedAt: string; alreadyRejected: boolean };

describe("010 US1 operator rejects a pending escalation", () => {
  it("010 US1 reject: 200 with rej_ ID; one HUMAN_REJECTION with session, resource, payee and amount copied from ESCALATED", async () => {
    const { base, ledger } = await startService();
    const esc = await authz(base, intent({ accepts: [req50()] }));
    const res = await rejectCall(base, esc.authorizationId, {
      operator: "alice",
      reason: "too expensive",
      payTo: "0x0000000000000000000000000000000000000bad",
      amount: "1",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RejectBody;
    expect(body).toEqual({ ok: true, rejectionId: expect.stringMatching(/^rej_/), rejectedAt: new Date(NOW).toISOString(), alreadyRejected: false });
    const [rej] = rejections(ledger);
    expect(rejections(ledger)).toHaveLength(1);
    expect(rej!.sessionId).toBe("sess_test");
    expect(rej!.authorizationId).toBe(esc.authorizationId);
    expect(rej!.data).toEqual({
      rejectionId: body.rejectionId,
      escalationId: esc.authorizationId,
      resourceKey: URL_WEATHER,
      payTo: PAY_TO,
      amount: "50000",
      operator: "alice",
      reason: "too expensive",
      channel: "operator", // 012: additive (FR-024)
    });
  });

  it("010 US1 reject again: returns the first rejection with alreadyRejected, appends nothing", async () => {
    const { base, ledger } = await startService();
    const esc = await authz(base, intent({ accepts: [req50()] }));
    const first = (await (await rejectCall(base, esc.authorizationId)).json()) as RejectBody;
    const before = ledger.entries().length;
    const again = await rejectCall(base, esc.authorizationId, { operator: "bob", reason: "second thoughts" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ...first, alreadyRejected: true });
    expect(ledger.entries()).toHaveLength(before);
    expect(rejections(ledger)[0]!.data.operator).toBe("operator");
  });

  it("010 US1 reject: 404 for an unknown, AUTHORIZED or DENIED authorization ID; nothing appended", async () => {
    const { base, ledger } = await startService();
    const ok = await authz(base, intent());
    const denied = await authz(base, intent({ accepts: [baseRequirement({ amount: "200000" })] }));
    expect(ok.status).toBe("AUTHORIZED");
    expect(denied.status).toBe("DENIED");
    const before = ledger.entries().length;
    for (const id of ["auth_missing", ok.authorizationId, denied.authorizationId]) {
      const r = await rejectCall(base, id);
      expect(r.status, id).toBe(404);
      expect(await r.json()).toEqual({ error: "not found" });
    }
    expect(ledger.entries()).toHaveLength(before);
  });

  it("010 US1 reject: 400 for an invalid operator label or reason; exactly 64 and 280 characters are accepted", async () => {
    const { base, ledger } = await startService();
    const esc = await authz(base, intent({ accepts: [req50()] }));
    const before = ledger.entries().length;
    for (const body of [{ operator: "x".repeat(65) }, { operator: "" }, { operator: 5 }, { reason: "r".repeat(281) }, { reason: 5 }]) {
      const r = await rejectCall(base, esc.authorizationId, body);
      expect(r.status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
    expect(ledger.entries()).toHaveLength(before);
    const edge = await rejectCall(base, esc.authorizationId, { operator: "o".repeat(64), reason: "r".repeat(280) });
    expect(edge.status).toBe(200);
  });

  it("010 US1 after a rejection the same session and resource is DENIED human_rejected at any amount; nothing is signed", async () => {
    let signed = 0;
    const { base, ledger } = await startService({
      signer: fakeSigner(async () => {
        signed++;
        return { headers: { "PAYMENT-SIGNATURE": "opaque" }, payer: "0x00000000000000000000000000000000000000f1", validBefore: Math.floor(NOW / 1000) + 120 };
      }),
    });
    const esc = await authz(base, intent({ accepts: [req50()] }));
    await rejectCall(base, esc.authorizationId);
    for (const amount of ["50000", "60000", "5000"]) {
      const d = await authz(base, intent({ accepts: [baseRequirement({ amount })], url: `${URL_WEATHER}?city=Lima` }));
      expect(d.status, amount).toBe("DENIED");
      if (d.status !== "AUTHORIZED") expect(d.violations.map((v) => v.rule)).toEqual(["human_rejected"]);
    }
    expect(signed).toBe(0);
    expect(ledger.entries().filter((e) => e.type === "DENIED")).toHaveLength(3);
  });

  it("010 US1 a different session for the same resource still escalates", async () => {
    const { base } = await startService();
    const esc = await authz(base, intent({ accepts: [req50()] }));
    await rejectCall(base, esc.authorizationId);
    const other = await authz(base, intent({ accepts: [req50()], sessionId: "sess_other" }));
    expect(other.status).toBe("ESCALATE");
    if (other.status !== "AUTHORIZED") expect(other.violations.map((v) => v.rule)).toEqual(["human_approval_required"]);
  });
});

describe("010 US2 final states are never left", () => {
  it("010 US2 approve on a denied escalation → 409 state denied with the rejectionId; nothing appended", async () => {
    const { base, ledger } = await startService();
    const esc = await authz(base, intent({ accepts: [req50()] }));
    const rej = (await (await rejectCall(base, esc.authorizationId)).json()) as RejectBody;
    const before = ledger.entries().length;
    const r = await approveCall(base, esc.authorizationId);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "escalation is denied", state: "denied", rejectionId: rej.rejectionId });
    expect(ledger.entries()).toHaveLength(before);
    expect(approvals(ledger)).toHaveLength(0);
  });

  it("010 US2 reject on an approved escalation → 409 state approved, before and after the approval pays; nothing appended", async () => {
    const { base, ledger } = await startService();
    const esc = await authz(base, intent({ accepts: [req50()] }));
    const { approvalId } = (await (await approveCall(base, esc.authorizationId)).json()) as { approvalId: string };
    const expectRefused = async () => {
      const before = ledger.entries().length;
      const r = await rejectCall(base, esc.authorizationId);
      expect(r.status).toBe(409);
      expect(await r.json()).toEqual({ error: "escalation is approved", state: "approved", approvalId });
      expect(ledger.entries()).toHaveLength(before);
    };
    await expectRefused();
    expect((await authz(base, intent({ accepts: [req50()] }))).status).toBe("AUTHORIZED");
    await expectRefused();
    expect(rejections(ledger)).toHaveLength(0);
  });

  it("010 US2 re-approve ignores a new ttlSeconds and approver; a first approve keeps the v1.2 response shape", async () => {
    const { base, ledger } = await startService();
    const esc = await authz(base, intent({ accepts: [req50()] }));
    const first = (await (await approveCall(base, esc.authorizationId)).json()) as Record<string, unknown>;
    expect(Object.keys(first).sort()).toEqual(["approvalId", "expiresAt", "ok"]);
    const again = (await (await approveCall(base, esc.authorizationId, { ttlSeconds: 5, approver: "mallory" })).json()) as Record<string, unknown>;
    expect(again).toEqual({ ...first, alreadyApproved: true });
    expect(approvals(ledger)).toHaveLength(1);
    expect(approvals(ledger)[0]!.data.approver).toBe("operator");
  });
});

describe("010 US2 one pending escalation per purchase", () => {
  it("010 US2 a repeat of the same purchase while pending returns the same ID and records ESCALATION_REPEATED", async () => {
    const { base, ledger } = await startService();
    const first = await authz(base, intent({ accepts: [req50()] }));
    const i2 = intent({ accepts: [req50()] });
    const second = await authz(base, i2);
    expect(second.status).toBe("ESCALATE");
    expect(second.authorizationId).toBe(first.authorizationId);
    expect(ledger.entries().filter((e) => e.type === "ESCALATED")).toHaveLength(1);
    const repeats = ledger.entries().filter((e) => e.type === "ESCALATION_REPEATED");
    expect(repeats).toHaveLength(1);
    expect(repeats[0]!.intentId).toBe(i2.intentId);
    expect(repeats[0]!.authorizationId).toBe(first.authorizationId);
    expect(repeats[0]!.data).toMatchObject({ escalationId: first.authorizationId, resourceKey: URL_WEATHER, payTo: PAY_TO, amount: "50000" });
    expect((repeats[0]!.data.violations as { rule: string }[]).map((v) => v.rule)).toEqual(["human_approval_required"]);
  });

  it("010 US2 a different amount for the same resource is a different purchase and escalates separately", async () => {
    const { base, ledger } = await startService();
    const first = await authz(base, intent({ accepts: [req50()] }));
    const other = await authz(base, intent({ accepts: [baseRequirement({ amount: "60000" })] }));
    expect(other.status).toBe("ESCALATE");
    expect(other.authorizationId).not.toBe(first.authorizationId);
    expect(ledger.entries().filter((e) => e.type === "ESCALATED")).toHaveLength(2);
  });

  it("010 US2 must fail without de-duplication: dedupePendingEscalations false gives two ESCALATED entries", async () => {
    const ledger = new AuditLedger(join(dir, ".local", "ledger-nodedupe.jsonl"));
    const svc = createControlService({
      mandate: mandate(),
      signer: fakeSigner(),
      ledger,
      asset: { address: ASSET, decimals: 6 },
      tokens: TOKENS,
      now: () => NOW,
      dedupePendingEscalations: false,
    });
    const server = await new Promise<Server>((r) => {
      const s = svc.app.listen(0, "127.0.0.1", () => r(s));
    });
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const a = await authz(base, intent({ accepts: [req50()] }));
    const b = await authz(base, intent({ accepts: [req50()] }));
    expect(a.authorizationId).not.toBe(b.authorizationId);
    expect(ledger.entries().filter((e) => e.type === "ESCALATED")).toHaveLength(2);
  });
});

const operatorGet = (base: string, path: string, token: string | null = TOKENS.operator) =>
  fetch(`${base}${path}`, { headers: { ...(token !== null && { authorization: `Bearer ${token}` }) } });

describe("010 US4 escalation reads", () => {
  it("010 US4 GET /v1/escalations: empty ledger → no pending and cursor -1; one escalation → one view and cursor = last seq", async () => {
    const { base, ledger } = await startService();
    expect(await (await operatorGet(base, "/v1/escalations")).json()).toEqual({ pending: [], cursor: -1 });
    const esc = await authz(base, intent({ accepts: [req50()] }));
    const body = (await (await operatorGet(base, "/v1/escalations")).json()) as { pending: { authorizationId: string }[]; cursor: number };
    expect(body.pending.map((p) => p.authorizationId)).toEqual([esc.authorizationId]);
    expect(body.cursor).toBe(ledger.entries().length - 1);
  });

  it("010 US4 GET /v1/escalations/events: escalated, then only denied after the cursor; after must be an integer >= -1", async () => {
    const { base } = await startService();
    const esc = await authz(base, intent({ accepts: [req50()] }));
    const all = (await (await operatorGet(base, "/v1/escalations/events?after=-1")).json()) as { events: { kind: string }[]; cursor: number };
    expect(all.events.map((e) => e.kind)).toEqual(["escalated"]);
    await rejectCall(base, esc.authorizationId, { operator: "alice" });
    const next = (await (await operatorGet(base, `/v1/escalations/events?after=${all.cursor}`)).json()) as { events: { kind: string; operator?: string }[] };
    expect(next.events).toEqual([expect.objectContaining({ kind: "denied", authorizationId: esc.authorizationId, operator: "alice" })]);
    for (const bad of ["abc", "-2", "1.5"]) {
      const r = await operatorGet(base, `/v1/escalations/events?after=${bad}`);
      expect(r.status, bad).toBe(400);
      expect(await r.json()).toEqual({ error: "after must be an integer >= -1" });
    }
  });

  it("010 US4 both reads are operator-only: control, settlement, verifier and no token → 401", async () => {
    const { base } = await startService();
    for (const path of ["/v1/escalations", "/v1/escalations/events?after=-1"]) {
      for (const token of [TOKENS.control, TOKENS.settlement, "t-verifier", null]) {
        const r = await operatorGet(base, path, token);
        expect(r.status, `${path} ${String(token)}`).toBe(401);
      }
    }
  });
});

const runScript = async (
  script: string,
  args: string[],
  env: Record<string, string>,
  opts: { until?: RegExp; timeoutMs?: number; onStart?: () => Promise<void> } = {},
) => {
  const { spawn } = await import("node:child_process");
  const childEnv: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env };
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith("NODE_") && v !== undefined) childEnv[k] = v;
  return new Promise<{ code: number | null; stdout: string; stderr: string; matchedAfterMs?: number }>((resolve) => {
    const p = spawn("node_modules/.bin/tsx", [script, ...args], { env: childEnv });
    let stdout = "";
    let stderr = "";
    let startedAt = 0;
    let matchedAfterMs: number | undefined;
    const timer = opts.until ? setTimeout(() => p.kill("SIGINT"), opts.timeoutMs ?? 15_000) : undefined;
    p.stdout.on("data", async (d) => {
      stdout += d;
      if (opts.until && startedAt === 0 && stdout.length > 0) {
        startedAt = Date.now();
        await opts.onStart?.();
      }
      if (opts.until && matchedAfterMs === undefined && opts.until.test(stdout)) {
        matchedAfterMs = Date.now() - startedAt;
        p.kill("SIGINT");
      }
    });
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, ...(matchedAfterMs !== undefined && { matchedAfterMs }) });
    });
  });
};

describe("010 US4 escalations CLI (scripts/escalations.ts)", () => {
  it("010 US4 list mode: none pending → message; one pending → a PENDING line; unreachable → exit 1", async () => {
    const { base } = await startService();
    const env = { CONTROL_URL: base, OPERATOR_TOKEN: TOKENS.operator };
    const none = await runScript("scripts/escalations.ts", [], env);
    expect(none.code, none.stderr).toBe(0);
    expect(none.stdout.trim()).toBe("no pending escalations");
    await authz(base, intent({ accepts: [req50()] }));
    const one = await runScript("scripts/escalations.ts", [], env);
    expect(one.code, one.stderr).toBe(0);
    expect(one.stdout.trim()).toMatch(/^PENDING auth_\S+ session=\S+ resource=\S+ payTo=0x\S+ amount=50000 expiresAt=\S+ referenceCode=[0-9a-f]{8}$/) // 012: additive;
    const down = await runScript("scripts/escalations.ts", [], { CONTROL_URL: "http://127.0.0.1:9", OPERATOR_TOKEN: TOKENS.operator });
    expect(down.code).toBe(1);
  });

  it("010 US4 watch mode prints a new escalation within 5 s, then exits 0 on SIGINT", async () => {
    const { base } = await startService();
    const env = { CONTROL_URL: base, OPERATOR_TOKEN: TOKENS.operator };
    const r = await runScript("scripts/escalations.ts", ["--watch"], env, {
      until: /ESCALATED auth_\S+ session=sess_test resource=\S+ amount=50000/,
      onStart: async () => {
        await authz(base, intent({ accepts: [req50()] }));
      },
    });
    expect(r.stdout).toMatch(/ESCALATED auth_/);
    expect(r.matchedAfterMs).toBeLessThan(5_000);
    expect(r.code).toBe(0);
  });

  it("010 US4 scripts/escalations.ts imports only src/shared and references no other role's secret", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("scripts/escalations.ts", "utf8");
    for (const name of ["PAYER_PRIVATE_KEY", "CONTROL_TOKEN", "VERIFIER_TOKEN", "SETTLEMENT_TOKEN", "ANTHROPIC_API_KEY"]) expect(src, name).not.toContain(name);
    const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
    expect(imports.filter((s) => s.startsWith(".")).every((s) => s.startsWith("../src/shared/"))).toBe(true);
  });
});

describe("010 US5 only the operator can reject (SEC-8, INV-13)", () => {
  it("010 US5 control, settlement, verifier and no token → 401 before body validation; ledger unchanged, no HUMAN_REJECTION", async () => {
    const { base, ledger } = await startService();
    const esc = await authz(base, intent({ accepts: [req50()] }));
    const before = ledger.entries().length;
    for (const token of [TOKENS.control, TOKENS.settlement, "t-verifier", null]) {
      const r = await rejectCall(base, esc.authorizationId, { reason: 5 }, token);
      expect(r.status, String(token)).toBe(401); // 401 precedes the 400 body validation
      expect(await r.json()).toEqual({ error: "unauthorized" });
    }
    expect(ledger.entries()).toHaveLength(before);
    expect(rejections(ledger)).toHaveLength(0);
  });
});

describe("010 US6 operator reject CLI (scripts/reject.ts)", () => {
  it("010 US6 reject <id> alice too expensive → exit 0, recorded; again → alreadyRejected; unknown → exit 1 404; no args → exit 2; unreachable → exit 1", async () => {
    const { base, ledger } = await startService();
    const esc = await authz(base, intent({ accepts: [req50()] }));
    const env = { CONTROL_URL: base, OPERATOR_TOKEN: TOKENS.operator };

    const ok = await runScript("scripts/reject.ts", [esc.authorizationId, "alice", "too", "expensive"], env);
    expect(ok.code, ok.stderr).toBe(0);
    const out = JSON.parse(ok.stdout) as RejectBody;
    expect(out.rejectionId).toMatch(/^rej_/);
    expect(out.alreadyRejected).toBe(false);
    expect(rejections(ledger)[0]!.data).toMatchObject({ operator: "alice", reason: "too expensive" });

    const again = await runScript("scripts/reject.ts", [esc.authorizationId, "alice", "too", "expensive"], env);
    expect(again.code, again.stderr).toBe(0);
    expect((JSON.parse(again.stdout) as RejectBody).alreadyRejected).toBe(true);
    expect(rejections(ledger)).toHaveLength(1);

    const missing = await runScript("scripts/reject.ts", ["auth_unknown"], env);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/^reject: HTTP 404/);

    const usage = await runScript("scripts/reject.ts", [], env);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain("usage: npm run reject -- <authorizationId> [operator] [reason]");

    const down = await runScript("scripts/reject.ts", [esc.authorizationId], { CONTROL_URL: "http://127.0.0.1:9", OPERATOR_TOKEN: TOKENS.operator });
    expect(down.code).toBe(1);
    expect(down.stderr).toContain("reject: control service unreachable at");
  });

  it("010 US6 scripts/reject.ts imports only src/shared and references no other role's secret", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("scripts/reject.ts", "utf8");
    for (const name of ["PAYER_PRIVATE_KEY", "CONTROL_TOKEN", "VERIFIER_TOKEN", "SETTLEMENT_TOKEN", "ANTHROPIC_API_KEY"]) expect(src, name).not.toContain(name);
    const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
    expect(imports.filter((s) => s.startsWith(".")).every((s) => s.startsWith("../src/shared/"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 013 user accounts: the two early rules and the user daily ceiling (SPEC L2-2 R16, R17, R12; specs/013 data-model.md)
// ---------------------------------------------------------------------------

describe("013 user rules (T-POL-16..19)", () => {
  const m = mandate();
  const user = (over: Partial<NonNullable<PolicyContext["user"]>> = {}): NonNullable<PolicyContext["user"]> => ({
    dailyCommittedAtomic: 0n,
    dailyCeilingAtomic: "500000",
    ...over,
  });

  it("T-POL-16 user_not_onboarded: evaluated first, returns immediately, with a fixed detail and no other violation", () => {
    // A request that would break R2, R3, R6, R9, R10 and R15 at once still shows only the one rule.
    const worst = baseRequirement({ scheme: "upto", network: "eip155:1" as never, amount: "-5" });
    const ctx = baseCtx({ requestedUrl: "http://evil.example/x", humanRejected: { rejectionId: "rej_1" }, user: user({ gate: "not_onboarded" }) });
    const r = evaluateRequirement(worst, mandate({ expiresAt: "2020-01-01T00:00:00Z" }), ctx);
    expect(r).toEqual({ status: "DENIED", violations: [{ rule: "user_not_onboarded", detail: "the user's setup is incomplete" }] });
    // Compliant request: still denied, and never escalated or authorized.
    expect(rules(evaluateRequirement(baseRequirement(), m, baseCtx({ user: user({ gate: "not_onboarded" }) })))).toEqual(["user_not_onboarded"]);
    expect(decide([baseRequirement(), baseRequirement({ amount: "50000" })], m, baseCtx({ user: user({ gate: "not_onboarded" }) })).status).toBe("DENIED");
  });

  it("T-POL-16 the detail says nothing about which step is missing (FR-012, SEC-12)", () => {
    const detail = evaluateRequirement(baseRequirement(), m, baseCtx({ user: user({ gate: "not_onboarded" }) })).violations[0]!.detail;
    expect(detail).not.toMatch(/profile|wallet|policy|account|card/i);
  });

  it("T-POL-17 user_disabled: the same shape, and an approval never lifts it", () => {
    const ctx = baseCtx({ user: user({ gate: "disabled" }), humanApprovedFor: { payTo: PAY_TO, amount: "50000", approvalId: "apr_1" } });
    const r = evaluateRequirement(baseRequirement({ amount: "50000" }), m, ctx);
    expect(r).toEqual({ status: "DENIED", violations: [{ rule: "user_disabled", detail: "the user's account can't pay" }] });
    expect(rules(evaluateRequirement(baseRequirement({ amount: "999999999" }), m, baseCtx({ user: user({ gate: "disabled" }) })))).toEqual(["user_disabled"]);
  });

  it("T-POL-17 must fail without the rule: the same request with no gate is AUTHORIZED", () => {
    expect(evaluateRequirement(baseRequirement(), m, baseCtx({ user: user() })).status).toBe("AUTHORIZED");
  });

  it("T-POL-18 the user daily ceiling denies with daily_budget_exceeded although the policy's own budget passes", () => {
    const at = (committed: bigint, amount: string) =>
      evaluateRequirement(baseRequirement({ amount }), m, baseCtx({ dailyCommittedAtomic: 0n, user: user({ dailyCommittedAtomic: committed, dailyCeilingAtomic: "60000" }) }));
    // Exactly at the ceiling passes; one atomic unit over fails.
    expect(at(59_000n, "1000").status).toBe("AUTHORIZED");
    expect(at(59_000n, "1001")).toEqual({ status: "DENIED", violations: [{ rule: "daily_budget_exceeded", detail: "59000 + 1001 > 60000" }] });
    expect(at(60_000n, "1").status).toBe("DENIED");
  });

  it("T-POL-18 when the policy's own daily budget also fails there is one daily_budget_exceeded, not two", () => {
    const r = evaluateRequirement(
      baseRequirement({ amount: "1000" }),
      mandate({ dailyBudgetAtomic: "100000" }),
      baseCtx({ dailyCommittedAtomic: 100_000n, user: user({ dailyCommittedAtomic: 100_000n, dailyCeilingAtomic: "60000" }) }),
    );
    expect(r.violations).toEqual([{ rule: "daily_budget_exceeded", detail: "100000 + 1000 > 100000" }]);
  });

  it("T-POL-18 the ceiling is collected with the other DENY rules, and an approval never lifts it (INV-12)", () => {
    const ctx = baseCtx({
      authorizationsLastMinute: 10,
      humanApprovedFor: { payTo: PAY_TO, amount: "50000", approvalId: "apr_1" },
      user: user({ dailyCommittedAtomic: 30_000n, dailyCeilingAtomic: "60000" }),
    });
    expect(rules(evaluateRequirement(baseRequirement({ amount: "50000" }), m, ctx))).toEqual(["daily_budget_exceeded", "velocity_limit"]);
  });

  it("T-POL-18 must fail without the ceiling: the same request with no ceiling is AUTHORIZED", () => {
    const { dailyCeilingAtomic: _, ...noCeiling } = user({ dailyCommittedAtomic: 60_000n, dailyCeilingAtomic: "60000" });
    expect(evaluateRequirement(baseRequirement(), m, baseCtx({ user: noCeiling })).status).toBe("AUTHORIZED");
    expect(evaluateRequirement(baseRequirement(), m, baseCtx({ user: user({ dailyCommittedAtomic: 60_000n, dailyCeilingAtomic: "60000" }) })).status).toBe("DENIED");
  });

  it("T-POL-19 without ctx.user, and with a user who has no gate and room under the ceiling, every rule gives the v1.8 result", () => {
    // One case per rule, in table order, plus the three outcomes.
    const cases: Array<[string, PaymentRequirements, SpendingMandate, PolicyContext]> = [
      ["authorized", baseRequirement(), m, baseCtx()],
      ["escalate", baseRequirement({ amount: "50000" }), m, baseCtx()],
      ["approved", baseRequirement({ amount: "50000" }), m, baseCtx({ humanApprovedFor: { payTo: PAY_TO, amount: "50000", approvalId: "apr_1" } })],
      ["R1", baseRequirement(), mandate({ expiresAt: "2020-01-01T00:00:00Z" }), baseCtx()],
      ["R2", baseRequirement({ scheme: "upto" }), m, baseCtx()],
      ["R3", baseRequirement({ network: "eip155:1" as never }), m, baseCtx()],
      ["R4", baseRequirement({ asset: "0x1111111111111111111111111111111111111111" }), m, baseCtx()],
      ["R5", baseRequirement(), mandate({}, { ALLOWED_PAYEES: "0x2222222222222222222222222222222222222222" }), baseCtx()],
      ["R6", baseRequirement(), m, baseCtx({ requestedUrl: "http://localhost:4021/api/weather", challengeResourceUrl: "http://localhost:4021/api/weather" })],
      ["R7", baseRequirement(), m, baseCtx({ challengeResourceUrl: "http://127.0.0.1:9999/api/weather" })],
      ["R8", baseRequirement({ maxTimeoutSeconds: 301 }), m, baseCtx()],
      ["R9", baseRequirement({ amount: "1.5" }), m, baseCtx()],
      ["R10", baseRequirement({ amount: "100001" }), m, baseCtx()],
      ["R11", baseRequirement(), m, baseCtx({ sessionCommittedAtomic: 99_500n })],
      ["R12", baseRequirement(), m, baseCtx({ dailyCommittedAtomic: 499_500n })],
      ["R13", baseRequirement(), m, baseCtx({ authorizationsLastMinute: 10 })],
      ["R15", baseRequirement(), m, baseCtx({ humanRejected: { rejectionId: "rej_1" } })],
    ];
    for (const [name, req, mand, ctx] of cases) {
      const plain = evaluateRequirement(req, mand, ctx);
      const withUser = evaluateRequirement(req, mand, { ...ctx, user: user({ dailyCommittedAtomic: 0n, dailyCeilingAtomic: "999999999" }) });
      expect(withUser, name).toEqual(plain);
    }
    // And a context whose `user` is explicitly undefined is the platform account.
    expect(evaluateRequirement(baseRequirement(), m, { ...baseCtx(), user: undefined } as PolicyContext).status).toBe("AUTHORIZED");
  });

  it("T-POL-19 the engine is still deterministic: the same inputs give the same decision, and nothing is read from a clock", () => {
    const ctx = baseCtx({ user: user({ dailyCommittedAtomic: 10n }) });
    const a = decide([baseRequirement(), baseRequirement({ amount: "500" })], m, ctx);
    const b = decide([baseRequirement(), baseRequirement({ amount: "500" })], m, ctx);
    expect(a).toEqual(b);
    expect(a.chosen?.amount).toBe("500");
  });
});
