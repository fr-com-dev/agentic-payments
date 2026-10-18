// Feature 005 — L3 settlement verifier unit tests (SPEC.md §8.3 L3-1). Scripted chain via a fake client.
import { describe, expect, it } from "vitest";
import { encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import {
  ChainSettlementVerifier,
  finalityClassFor,
  SAFE_DEPTH_MULTIPLIER,
} from "../src/layer3-settlement/verifier.js";
import type { SettlementClaim } from "../src/shared/contracts.js";
import { fakePublicClient, transferLog, type FakeChainScript } from "./helpers/fake-public-client.js";

const ASSET = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const OTHER_ASSET = "0x0000000000000000000000000000000000000bad";
const PAYER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const PAY_TO = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const TX = `0x${"12".repeat(32)}`;
const LOCAL = { confirmationDepth: 1, supportsSafeTag: false };
const BASE_SEPOLIA = { confirmationDepth: 2, supportsSafeTag: true };

const requirement = (amount: string, network = "eip155:31337"): PaymentRequirements => ({
  scheme: "exact",
  network: network as PaymentRequirements["network"],
  asset: ASSET,
  amount,
  payTo: PAY_TO,
  maxTimeoutSeconds: 120,
  extra: { name: "USD Coin", version: "2" },
});

const header = (over: Partial<{ success: boolean; transaction: string; network: string; errorReason: string }> = {}) =>
  encodePaymentResponseHeader({
    success: true,
    transaction: TX,
    network: "eip155:31337",
    payer: PAYER,
    ...over,
  } as Parameters<typeof encodePaymentResponseHeader>[0]);

const claim = (amount: string, over: Partial<SettlementClaim> = {}, network?: string): SettlementClaim => ({
  authorizationId: "auth_test",
  requirement: requirement(amount, network),
  payer: PAYER,
  validBefore: 1_900_000_000,
  httpStatus: 200,
  paymentResponseHeader: header(network ? { network } : {}),
  ...over,
});

const settled = (amount: bigint, extra: Partial<FakeChainScript> = {}, logs = [transferLog(ASSET, PAYER, PAY_TO, amount)]): FakeChainScript => ({
  receipt: { status: "success", blockNumber: 10n, logs },
  heads: [10n],
  ...extra,
});

const verifier = (script: FakeChainScript, net = LOCAL, waitMs = 2_000, pollMs = 20) =>
  new ChainSettlementVerifier({ publicClient: fakePublicClient(script), net, waitMs, pollMs });

describe("finalityClassFor (005 T004)", () => {
  it("uses the SPEC thresholds with bigint inputs", () => {
    expect(finalityClassFor(10_000n)).toBe("included");
    expect(finalityClassFor(10_001n)).toBe("confirmed-depth");
    expect(finalityClassFor(1_000_000n)).toBe("confirmed-depth");
    expect(finalityClassFor(1_000_001n)).toBe("l1-safe");
  });
});

describe("US1: confirm against the chain (005 T008–T010)", () => {
  it("T008 a 1000-atomic Transfer from the asset is CONFIRMED, class included, with block info", async () => {
    const r = await verifier(settled(1000n)).verify(claim("1000"));
    expect(r.status).toBe("CONFIRMED");
    expect(r.finalityClass).toBe("included");
    expect(r.transaction).toBe(TX);
    expect(r.blockNumber).toBe("10");
    expect(r.confirmations).toBeGreaterThanOrEqual(1);
    expect(r.network).toBe("eip155:31337");
    expect(() => new Date(r.observedAt).toISOString()).not.toThrow();
  });

  it("T009 verified deep-equals the claim's {asset, payer, payTo, amount}", async () => {
    const c = claim("5000");
    const r = await verifier(settled(5000n)).verify(c);
    expect(r.verified).toEqual({ asset: ASSET, payer: PAYER, payTo: PAY_TO, amount: "5000" });
  });

  it("T010 no matching Transfer → MISMATCH", async () => {
    const r = await verifier(settled(999n, {}, [transferLog(ASSET, PAYER, PAY_TO, 999n)])).verify(claim("1000"));
    expect(r.status).toBe("MISMATCH");
  });

  it("T010 a Transfer emitted by a different contract → MISMATCH", async () => {
    const r = await verifier(settled(1000n, {}, [transferLog(OTHER_ASSET, PAYER, PAY_TO, 1000n)])).verify(claim("1000"));
    expect(r.status).toBe("MISMATCH");
  });

  it("T010 a Transfer to a different payee → MISMATCH", async () => {
    const other = "0x0000000000000000000000000000000000000abc";
    const r = await verifier(settled(1000n, {}, [transferLog(ASSET, PAYER, other, 1000n)])).verify(claim("1000"));
    expect(r.status).toBe("MISMATCH");
  });

  it("T010 mixed-case addresses still match", async () => {
    const logs = [transferLog(ASSET.toLowerCase(), PAYER.toLowerCase(), PAY_TO.toLowerCase(), 1000n)];
    const c = claim("1000", { payer: PAYER.toUpperCase().replace("0X", "0x") });
    const r = await verifier(settled(1000n, {}, logs)).verify(c);
    expect(r.status).toBe("CONFIRMED");
  });
});

describe("US2: forged or missing evidence (005 T016–T019)", () => {
  it("T016 a null PAYMENT-RESPONSE → NOT_SETTLED, without reading the chain", async () => {
    const client = fakePublicClient(settled(1000n));
    const v = new ChainSettlementVerifier({ publicClient: client, net: LOCAL, waitMs: 500, pollMs: 10 });
    const r = await v.verify(claim("1000", { paymentResponseHeader: null }));
    expect(r.status).toBe("NOT_SETTLED");
    expect(client.calls.receipt).toBe(0);
  });

  it("T017 undecodable header, success:false and missing transaction → NOT_SETTLED with a reason", async () => {
    const v = verifier(settled(1000n));
    const bad = await v.verify(claim("1000", { paymentResponseHeader: "%%%not-base64%%%" }));
    expect(bad.status).toBe("NOT_SETTLED");
    expect(bad.detail).toMatch(/decode/);
    // SPEC v1.2 L3-1 step 2: a failure claim WITH a hash is checked on-chain (FR-020 rows below), so the
    // NOT_SETTLED case here is a failure claim that carries no transaction.
    const failed = await v.verify(
      claim("1000", { paymentResponseHeader: header({ success: false, errorReason: "insufficient_funds", transaction: "" }) }),
    );
    expect(failed.status).toBe("NOT_SETTLED");
    expect(failed.detail).toMatch(/insufficient_funds/);
    const noTx = await v.verify(claim("1000", { paymentResponseHeader: header({ transaction: "" }) }));
    expect(noTx.status).toBe("NOT_SETTLED");
    expect(noTx.detail).toMatch(/transaction/);
  });

  it("T018 settle.network ≠ requirement.network → MISMATCH before any chain read", async () => {
    const client = fakePublicClient(settled(1000n));
    const v = new ChainSettlementVerifier({ publicClient: client, net: LOCAL, waitMs: 500, pollMs: 10 });
    const r = await v.verify(claim("1000", { paymentResponseHeader: header({ network: "eip155:84532" }) }));
    expect(r.status).toBe("MISMATCH");
    expect(client.calls.receipt).toBe(0);
  });

  it("T019 a reverted transaction → NOT_SETTLED", async () => {
    const r = await verifier({ receipt: { status: "reverted", blockNumber: 10n, logs: [] }, heads: [10n] }).verify(claim("1000"));
    expect(r.status).toBe("NOT_SETTLED");
    expect(r.detail).toMatch(/reverted/);
  });
});

describe("US3: finality scaled to the amount (005 T025–T028)", () => {
  it("T025 confirmed-depth on base-sepolia: 1 confirmation is not enough, 2 is CONFIRMED", async () => {
    const r = await verifier(settled(1_000_000n, { heads: [10n, 10n, 11n] }), BASE_SEPOLIA).verify(
      claim("1000000", {}, "eip155:84532"),
    );
    expect(r.finalityClass).toBe("confirmed-depth");
    expect(r.status).toBe("CONFIRMED");
    expect(r.confirmations).toBe(2);

    const stuck = await verifier(settled(1_000_000n, { heads: [10n] }), BASE_SEPOLIA, 200, 20).verify(
      claim("1000000", {}, "eip155:84532"),
    );
    expect(stuck.status).toBe("PENDING");
    expect(stuck.confirmations).toBe(1);
  });

  it("T026 l1-safe with a safe tag: keeps polling while safe < block, CONFIRMED once safe ≥ block", async () => {
    const client = fakePublicClient(settled(1_000_001n, { safe: [8n, 9n, 10n] }));
    const v = new ChainSettlementVerifier({ publicClient: client, net: BASE_SEPOLIA, waitMs: 2_000, pollMs: 10 });
    const r = await v.verify(claim("1000001", {}, "eip155:84532"));
    expect(r.finalityClass).toBe("l1-safe");
    expect(r.status).toBe("CONFIRMED");
    expect(client.calls.safe).toBe(3);
  });

  it(`T027 l1-safe on local (no safe tag, depth 1) needs ${SAFE_DEPTH_MULTIPLIER} confirmations`, async () => {
    const client = fakePublicClient(settled(1_000_001n, { heads: [10n, 12n, 13n, 14n] }));
    const v = new ChainSettlementVerifier({ publicClient: client, net: LOCAL, waitMs: 2_000, pollMs: 10 });
    const r = await v.verify(claim("1000001"));
    expect(r.status).toBe("CONFIRMED");
    expect(r.confirmations).toBe(5);
    expect(client.calls.safe).toBe(0); // never asks for the safe block without the tag
  });

  it("T028 finality not reached by the deadline → PENDING with block info", async () => {
    const r = await verifier(settled(1_000_001n, { heads: [10n] }), LOCAL, 150, 20).verify(claim("1000001"));
    expect(r.status).toBe("PENDING");
    expect(r.blockNumber).toBe("10");
    expect(r.confirmations).toBe(1);
  });

  it("T028 the receipt never arrives → PENDING, not NOT_SETTLED, with no block info", async () => {
    const r = await verifier({ heads: [10n] }, LOCAL, 120, 20).verify(claim("1000"));
    expect(r.status).toBe("PENDING");
    expect(r.blockNumber).toBeUndefined();
  });

  it("T028 one shared deadline: a late receipt plus slow finality stays within waitMs + one pollMs", async () => {
    const waitMs = 300;
    const pollMs = 20;
    const client = fakePublicClient(settled(1_000_001n, { receiptDelayMs: 200, heads: [10n] }));
    const v = new ChainSettlementVerifier({ publicClient: client, net: LOCAL, waitMs, pollMs });
    const t0 = Date.now();
    const r = await v.verify(claim("1000001"));
    const elapsed = Date.now() - t0;
    expect(r.status).toBe("PENDING");
    expect(client.calls.lastTimeout).toBeLessThanOrEqual(waitMs);
    expect(elapsed).toBeLessThanOrEqual(waitMs + pollMs + 50); // 50 ms scheduler slack
  });

  it("a non-timeout RPC error while waiting for the receipt → PENDING (conservative), with the reason", async () => {
    const r = await verifier({ receiptError: new Error("connection refused") }).verify(claim("1000"));
    expect(r.status).toBe("PENDING");
    expect(r.detail).toMatch(/connection refused/);
  });
});

describe("L3-1 step 2 v1.2 (FR-020, SEC-11): a failure claim carrying a hash is checked on-chain", () => {
  const failure = (over: Partial<{ transaction: string; network: string }> = {}) =>
    header({ success: false, errorReason: "settlement_pending", ...over });

  it("L3-1 step 2 v1.2 (FR-020) success:false with no transaction → NOT_SETTLED, no chain read", async () => {
    const client = fakePublicClient(settled(1000n));
    const v = new ChainSettlementVerifier({ publicClient: client, net: LOCAL, waitMs: 500, pollMs: 10 });
    const r = await v.verify(claim("1000", { paymentResponseHeader: failure({ transaction: "" }) }));
    expect(r.status).toBe("NOT_SETTLED");
    expect(r.detail).toMatch(/settlement_pending/);
    expect(client.calls.receipt).toBe(0);
  });

  it("L3-1 step 2 v1.2 (FR-020) success:false with a non-32-byte transaction → NOT_SETTLED, no chain read", async () => {
    const client = fakePublicClient(settled(1000n));
    const v = new ChainSettlementVerifier({ publicClient: client, net: LOCAL, waitMs: 500, pollMs: 10 });
    const r = await v.verify(claim("1000", { paymentResponseHeader: failure({ transaction: "0x1234" }) }));
    expect(r.status).toBe("NOT_SETTLED");
    expect(client.calls.receipt).toBe(0);
  });

  it("L3-1 step 2 v1.2 (FR-020) success:false, valid hash, reverted receipt → NOT_SETTLED", async () => {
    const r = await verifier({ receipt: { status: "reverted", blockNumber: 10n, logs: [] }, heads: [10n] }).verify(
      claim("1000", { paymentResponseHeader: failure() }),
    );
    expect(r.status).toBe("NOT_SETTLED");
    expect(r.detail.startsWith("facilitator reported failure (settlement_pending); ")).toBe(true);
  });

  it("L3-1 step 2 v1.2 (FR-020) success:false, valid hash, Transfer mismatch → MISMATCH", async () => {
    const r = await verifier(settled(1000n, {}, [transferLog(ASSET, PAYER, PAY_TO, 999n)])).verify(
      claim("1000", { paymentResponseHeader: failure() }),
    );
    expect(r.status).toBe("MISMATCH");
    expect(r.detail.startsWith("facilitator reported failure (settlement_pending); ")).toBe(true);
  });

  it("L3-1 step 2 v1.2 (FR-020) success:false, valid hash, wrong network → MISMATCH before any chain read", async () => {
    const client = fakePublicClient(settled(1000n));
    const v = new ChainSettlementVerifier({ publicClient: client, net: LOCAL, waitMs: 500, pollMs: 10 });
    const r = await v.verify(claim("1000", { paymentResponseHeader: failure({ network: "eip155:84532" }) }));
    expect(r.status).toBe("MISMATCH");
    expect(client.calls.receipt).toBe(0);
  });

  it("L3-1 step 2 v1.2 (FR-020) success:false, valid hash, matching Transfer → CONFIRMED with the failure noted", async () => {
    const r = await verifier(settled(1000n)).verify(claim("1000", { paymentResponseHeader: failure() }));
    expect(r.status).toBe("CONFIRMED");
    expect(r.transaction).toBe(TX);
    expect(r.detail.startsWith("facilitator reported failure (settlement_pending); ")).toBe(true);
  });

  it("L3-1 step 2 v1.2 (FR-020) verifyFailedClaims:false restores v1.1 (test-only switch for the must-fail proof)", async () => {
    const client = fakePublicClient(settled(1000n));
    const v = new ChainSettlementVerifier({ publicClient: client, net: LOCAL, waitMs: 500, pollMs: 10, verifyFailedClaims: false });
    const r = await v.verify(claim("1000", { paymentResponseHeader: failure() }));
    expect(r.status).toBe("NOT_SETTLED");
    expect(client.calls.receipt).toBe(0);
  });

  it("L3-1 step 2 v1.2 (FR-020) success:true rows are unchanged", async () => {
    expect((await verifier(settled(1000n)).verify(claim("1000"))).detail).not.toMatch(/facilitator reported failure/);
  });
});
