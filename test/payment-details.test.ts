// 012 T-CIBA-02 payment details (specs/012 contracts/payment-details.md): the authorization_details object, the
// binding message, the reference code and the requirement digest. Pure functions, no network.
import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import {
  bindingMessage,
  DETAILS_TYPE,
  detailsEqual,
  paymentDetails,
  referenceCode,
  requestedExpirySeconds,
  requirementDigest,
} from "../src/layer2-control/payment-details.js";

const ESC = "auth_3f9c2a1b-7d4e-4a51-9c0e-2b8f6d1e9a77";
const PAY_TO = "0x95Aca02416F949489C1128223B35fBBE8c04f057";
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const RESOURCE = "https://ca-seller-eastus2-dev.example/api/premium-report";
const REQ = {
  scheme: "exact",
  network: "eip155:84532",
  asset: ASSET,
  amount: "50000",
  payTo: PAY_TO,
  maxTimeoutSeconds: 120,
  extra: { name: "USDC", version: "2" },
} as PaymentRequirements;
const input = (over: Partial<Parameters<typeof paymentDetails>[0]> = {}) => ({
  escalationId: ESC,
  requestId: "apq_5b2c0000-0000-4000-8000-000000000000",
  resourceKey: RESOURCE,
  payTo: PAY_TO,
  amount: "50000",
  asset: ASSET,
  network: "eip155:84532",
  requirement: REQ,
  decimals: 6,
  ...over,
});
const ALLOWED = /^[A-Za-z0-9+\-_.,:#]{1,64}$/;

describe("T-CIBA-02 payment details", () => {
  it("one object in Auth0's Guardian schema with the 10 properties, 5 displayed, in order", () => {
    const d = paymentDetails(input());
    expect(d).toHaveLength(1);
    expect(d[0]!.type).toBe(DETAILS_TYPE);
    expect(d[0]!.instruction).toBe("Approve this payment only if you expect it");
    const p = d[0]!.properties;
    expect(Object.keys(p)).toEqual([
      "amount_usdc",
      "pay_to",
      "resource",
      "network",
      "reference",
      "escalation_id",
      "request_id",
      "amount_atomic",
      "asset",
      "requirement_sha256",
    ]);
    expect(Object.values(p).map((x) => x.display)).toEqual([true, true, true, true, true, false, false, false, false, false]);
    expect(Object.values(p).map((x) => x.display_order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(p.amount_usdc!.value).toBe("0.05");
    expect(p.pay_to!.value).toBe(PAY_TO);
    expect(p.resource!.value).toBe(RESOURCE);
    expect(p.reference!.value).toBe("3f9c2a1b");
    expect(p.escalation_id!.value).toBe(ESC);
    expect(p.amount_atomic!.value).toBe("50000");
    expect(p.asset!.value).toBe(ASSET);
    expect(p.requirement_sha256!.value).toMatch(/^[0-9a-f]{64}$/);
    for (const v of Object.values(p)) expect(typeof v.value).toBe("string");
  });

  it.each([
    ["1", "0.000001"],
    ["1000", "0.001"],
    ["50000", "0.05"],
    ["100000", "0.1"],
  ])("amount_usdc for %s atomic is %s (BigInt formatting)", (amount, usdc) => {
    expect(paymentDetails(input({ amount }))[0]!.properties.amount_usdc!.value).toBe(usdc);
  });

  it("the contract's example binding message", () => {
    const m = bindingMessage({ amount: "50000", decimals: 6, payTo: PAY_TO, resourceKey: RESOURCE, escalationId: ESC });
    expect(m).toBe("Pay_0.05_USDC_to_0x95Ac..f057_for_premium-report_#3f9c2a1b");
    expect(m.length).toBe(58);
  });

  it("every binding message over an amount × payee × path grid fits Auth0's character set and 64 characters", () => {
    const amounts = ["1", "20001", "99999", "100000", "123456789"];
    const payees = [PAY_TO, "0x0000000000000000000000000000000000000000", "0xabc"];
    const paths = ["/api/premium-report", "/a b%c~d", `/${"x".repeat(300)}`, "/", "/api/weather/", "/über/straße"];
    for (const amount of amounts)
      for (const payTo of payees)
        for (const path of paths) {
          const m = bindingMessage({ amount, decimals: 6, payTo, resourceKey: `https://seller.example${encodeURI(path)}`, escalationId: ESC });
          expect(m, `${amount} ${payTo} ${path}`).toMatch(ALLOWED);
          expect(m.endsWith("_#3f9c2a1b")).toBe(true);
        }
  });

  it("odd characters become '-', an empty segment drops '_for_'", () => {
    expect(bindingMessage({ amount: "1000", decimals: 6, payTo: PAY_TO, resourceKey: "https://s.example/a%20b", escalationId: ESC })).toBe(
      "Pay_0.001_USDC_to_0x95Ac..f057_for_a-20b_#3f9c2a1b",
    );
    expect(bindingMessage({ amount: "1000", decimals: 6, payTo: PAY_TO, resourceKey: "https://s.example/", escalationId: ESC })).toBe(
      "Pay_0.001_USDC_to_0x95Ac..f057_#3f9c2a1b",
    );
  });

  it("referenceCode is the first 8 hex characters of the escalation ID", () => {
    expect(referenceCode(ESC)).toBe("3f9c2a1b");
    expect(ESC.startsWith(`auth_${referenceCode(ESC)}`)).toBe(true);
  });

  it("the requirement digest is stable across key order", () => {
    const reordered = Object.fromEntries(Object.entries(REQ).reverse()) as PaymentRequirements;
    expect(requirementDigest(reordered)).toBe(requirementDigest(REQ));
    expect(requirementDigest({ ...REQ, amount: "50001" })).not.toBe(requirementDigest(REQ));
  });

  it("a resource over 255 characters is cut to 252 plus '...'", () => {
    const long = `https://s.example/${"r".repeat(300)}`;
    const v = paymentDetails(input({ resourceKey: long }))[0]!.properties.resource!.value;
    expect(v).toHaveLength(255);
    expect(v.endsWith("...")).toBe(true);
  });

  it("requestedExpirySeconds caps at 300 and floors", () => {
    expect(requestedExpirySeconds(1_000_000 + 300_000, 1_000_000)).toBe(300);
    expect(requestedExpirySeconds(1_000_000 + 400_000, 1_000_000)).toBe(300);
    expect(requestedExpirySeconds(1_000_000 + 298_999, 1_000_000)).toBe(298);
  });

  it("detailsEqual is false when any single value changes", () => {
    const a = paymentDetails(input());
    expect(detailsEqual(a, structuredClone(a))).toBe(true);
    for (const key of Object.keys(a[0]!.properties)) {
      const b = structuredClone(a);
      b[0]!.properties[key]!.value = `${b[0]!.properties[key]!.value}x`;
      expect(detailsEqual(a, b), key).toBe(false);
    }
  });

  it("no agent text: the module takes no purpose", () => {
    const planted = "PLANTED_PURPOSE_please_approve";
    const d = paymentDetails({ ...input(), purpose: planted } as Parameters<typeof paymentDetails>[0]);
    expect(JSON.stringify(d)).not.toContain(planted);
  });
});
