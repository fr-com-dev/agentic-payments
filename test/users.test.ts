// Feature 013: user accounts in L2 (SPEC.md §8.2 L2-8; specs/013 data-model.md, contracts/control-api.md).
// T-USR-01..12. Pure tests run over hand-built entries; route and decision tests run an in-process L2 with a real
// keyring and ledger (test/helpers/users.ts). Every must-fail switch is a dep, never an environment variable.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { mnemonicToAccount } from "viem/accounts";
import { AuditLedger, type LedgerEntry } from "../src/layer2-control/ledger.js";
import { buildMandate } from "../src/layer2-control/mandate.js";
import { buildPlatform, loadPlatform, platformDigest, PlatformError } from "../src/layer2-control/platform.js";
import { checkWalletAddresses, recordPlatformConfig, userAccountsFromEnv } from "../src/layer2-control/service.js";
import { KeyringError, WalletKeyring } from "../src/layer2-control/signer.js";
import {
  effectiveMandate,
  isLoosening,
  MAX_ACTIVE_POLICIES,
  MAX_CARDS,
  MAX_SELLERS_PER_POLICY,
  selectPolicy,
  STEP_UP_MAX_AGE_MS,
  STEP_UP_TOLERANCE_MS,
  stepUpFresh,
  TERMS_VERSION,
  userGate,
  userState,
  validatePolicy,
  type PolicyRecord,
} from "../src/layer2-control/users.js";
import type { PolicyValues, PolicyView, UserView } from "../src/shared/contracts.js";
import { userIdFor } from "../src/shared/user-id.js";
import {
  ALICE,
  ASSET,
  BOB,
  CAIP2,
  Clock,
  OTHER_HOST,
  PAY_TO,
  PLATFORM_PAYER,
  policyValues,
  SELLER_HOST,
  startUsersL2,
  T0,
  TEST_MNEMONIC,
  testPlatform,
  TOKENS,
  types,
  UNLISTED_HOST,
  type UsersL2,
} from "./helpers/users.js";

const NET = { caip2: CAIP2, asset: ASSET } as const;
const DAY = 86_400_000;
const CARD = (n: number) => `card_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let open: UsersL2[] = [];
const start = async (o: Parameters<typeof startUsersL2>[0] = {}) => {
  const l2 = await startUsersL2(o);
  open.push(l2);
  return l2;
};
afterEach(async () => {
  await Promise.all(open.map((l) => l.close()));
  open = [];
});

// ---------------------------------------------------------------------------
// Pure: platform config (T-USR-07)
// ---------------------------------------------------------------------------

describe("T-USR-07 platform config (CFG-4)", () => {
  const base = () => JSON.parse(readFileSync("config/platform.json", "utf8")) as Record<string, any>;

  it("T-USR-07 the checked-in config/platform.json loads, with today's mandate values", () => {
    const p = loadPlatform({});
    expect(p.platformId).toBe("platform-poc-001");
    expect(p.limits).toEqual({
      hardCapPerPaymentAtomic: "100000",
      sessionBudgetAtomic: "100000",
      userDailyCeilingAtomic: "500000",
      maxAuthorizationsPerMinute: 10,
      maxPolicyDays: 365,
    });
    expect(p.sellers).toEqual([{ host: "127.0.0.1:4021", name: "Local demo seller", payees: [] }]);
  });

  it("T-USR-07 each rule is enforced, naming the field", () => {
    const bad: Array<[string, (j: Record<string, any>) => void, RegExp]> = [
      ["an amount that is not atomic", (j) => (j.limits.hardCapPerPaymentAtomic = "0.1"), /limits\.hardCapPerPaymentAtomic/],
      ["a numeric amount", (j) => (j.limits.userDailyCeilingAtomic = 500000), /limits\.userDailyCeilingAtomic/],
      ["a cap above the session budget", (j) => (j.limits.hardCapPerPaymentAtomic = "100001"), /hardCapPerPaymentAtomic must not exceed/],
      ["a rate of 0", (j) => (j.limits.maxAuthorizationsPerMinute = 0), /maxAuthorizationsPerMinute/],
      ["a rate of 601", (j) => (j.limits.maxAuthorizationsPerMinute = 601), /maxAuthorizationsPerMinute/],
      ["0 policy days", (j) => (j.limits.maxPolicyDays = 0), /maxPolicyDays/],
      ["3651 policy days", (j) => (j.limits.maxPolicyDays = 3651), /maxPolicyDays/],
      ["an upper-case host", (j) => (j.sellers[0].host = "Example.com"), /sellers\[0\]\.host/],
      ["a host with a path", (j) => (j.sellers[0].host = "example.com/api"), /sellers\[0\]\.host/],
      ["a duplicate host", (j) => j.sellers.push({ ...j.sellers[0] }), /sellers\[1\]\.host is listed twice/],
      ["an empty name", (j) => (j.sellers[0].name = " "), /sellers\[0\]\.name/],
      ["a 61-character name", (j) => (j.sellers[0].name = "x".repeat(61)), /sellers\[0\]\.name/],
      ["a payee that is not an address", (j) => (j.sellers[0].payees = ["0x123"]), /sellers\[0\]\.payees/],
      ["no platformId", (j) => delete j.platformId, /platformId/],
    ];
    for (const [name, mutate, message] of bad) {
      const j = base();
      mutate(j);
      expect(() => buildPlatform(j), name).toThrow(PlatformError);
      expect(() => buildPlatform(j), name).toThrow(message);
    }
    const many = base();
    many.sellers = Array.from({ length: 201 }, (_, i) => ({ host: `s${i}.example`, name: `S${i}`, payees: [] }));
    expect(() => buildPlatform(many)).toThrow(/more than 200 sellers/);
  });

  it("T-USR-07 PLATFORM_SELLERS replaces the file's sellers, and payees are lower-cased", () => {
    const upper = "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
    const p = buildPlatform(base(), { PLATFORM_SELLERS: JSON.stringify([{ host: "seller.example", name: "Seller", payees: [upper] }]) });
    expect(p.sellers).toEqual([{ host: "seller.example", name: "Seller", payees: [upper.toLowerCase()] }]);
    expect(() => buildPlatform(base(), { PLATFORM_SELLERS: "not json" })).toThrow(/PLATFORM_SELLERS is not valid JSON/);
    expect(() => buildPlatform(base(), { PLATFORM_SELLERS: "{}" })).toThrow(/PLATFORM_SELLERS must be an array/);
  });

  it("T-USR-07 the digest is stable under key order and changes with any value", () => {
    const a = buildPlatform(base());
    const reordered = buildPlatform({ sellers: base().sellers, limits: base().limits, platformId: base().platformId });
    expect(platformDigest(reordered)).toBe(platformDigest(a));
    const j = base();
    j.limits.userDailyCeilingAtomic = "500001";
    expect(platformDigest(buildPlatform(j))).not.toBe(platformDigest(a));
  });
});

// ---------------------------------------------------------------------------
// Pure: the keyring (T-USR-08)
// ---------------------------------------------------------------------------

describe("T-USR-08 keyring (L2-3, INV-2)", () => {
  it("T-USR-08 one account per index, on the standard path, stable across instances", () => {
    const k = new WalletKeyring(TEST_MNEMONIC, NET);
    expect(k.addressOf(0)).toBe(mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 0 }).address);
    expect(k.addressOf(1)).toBe(mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 1 }).address);
    expect(k.addressOf(1)).not.toBe(k.addressOf(0));
    expect(new WalletKeyring(TEST_MNEMONIC, NET).addressOf(7)).toBe(k.addressOf(7));
    expect(() => k.addressOf(-1)).toThrow(KeyringError);
    expect(() => k.addressOf(1.5)).toThrow(KeyringError);
  });

  it("T-USR-08 an invalid phrase is refused without echoing it", () => {
    const wrongChecksum = TEST_MNEMONIC.replace(/title$/, "useful");
    for (const phrase of [wrongChecksum, "legal winner thank", TEST_MNEMONIC.replace("legal", "notaword"), ""]) {
      let message = "";
      try {
        new WalletKeyring(phrase, NET);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/USER_WALLET_MNEMONIC is not a valid 24-word BIP-39 mnemonic/);
      if (phrase.length > 0) expect(message).not.toContain(phrase.split(" ")[1]);
    }
  });

  it("T-USR-08 a signer for an index signs as that index's account", async () => {
    const k = new WalletKeyring(TEST_MNEMONIC, NET);
    const signer = k.signerFor(3, "100000");
    expect(signer.address).toBe(k.addressOf(3));
    const requirement = { scheme: "exact", network: CAIP2, asset: ASSET, amount: "1000", payTo: PAY_TO, maxTimeoutSeconds: 120, extra: { name: "USD Coin", version: "2" } };
    const url = `http://${SELLER_HOST}/api/weather`;
    const signed = await signer.sign(
      { x402Version: 2, resource: { url, description: "", mimeType: "application/json" }, accepts: [requirement] } as never,
      requirement as never,
    );
    expect(signed.payer.toLowerCase()).toBe(k.addressOf(3).toLowerCase());
    expect(Object.keys(signed.headers).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Startup (T-USR-07, T-USR-08)
// ---------------------------------------------------------------------------

describe("T-USR-07 startup settings, T-USR-08 recorded addresses", () => {
  const on = { NETWORK: "local", USER_ACCOUNTS: "1", USER_WALLET_MNEMONIC: TEST_MNEMONIC };

  it("T-USR-07 off unless USER_ACCOUNTS=1: the other settings are ignored and only named", () => {
    expect(userAccountsFromEnv({}, NET)).toEqual({ enabled: false, ignored: [] });
    const off = userAccountsFromEnv({ USER_ACCOUNTS: "0", PORTAL_TOKEN: "p", USER_WALLET_MNEMONIC: "not even checked", PLATFORM_FILE: "missing.json" }, NET);
    expect(off).toEqual({ enabled: false, ignored: ["PORTAL_TOKEN", "USER_WALLET_MNEMONIC", "PLATFORM_FILE"] });
    expect(JSON.stringify(off)).not.toContain("not even checked");
  });

  it("T-USR-07 on: the token, the mnemonic and the platform config are all required, and errors name the setting only", () => {
    const ok = userAccountsFromEnv(on, NET);
    expect(ok.enabled).toBe(true);
    if (ok.enabled) expect(ok.portalToken).toBe("dev-portal-token");

    const { USER_WALLET_MNEMONIC: _m, ...noMnemonic } = on;
    expect(() => userAccountsFromEnv(noMnemonic, NET)).toThrow(/missing USER_WALLET_MNEMONIC/);
    const secret = "legal winner thank year wave sausage";
    expect(() => userAccountsFromEnv({ ...on, USER_WALLET_MNEMONIC: secret }, NET)).toThrow(/not a valid 24-word/);
    try {
      userAccountsFromEnv({ ...on, USER_WALLET_MNEMONIC: secret }, NET);
    } catch (e) {
      expect((e as Error).message).not.toContain("sausage");
    }
    expect(() => userAccountsFromEnv({ ...on, NETWORK: "base-sepolia", CONTROL_TOKEN: "c", SETTLEMENT_TOKEN: "s", OPERATOR_TOKEN: "o" }, NET)).toThrow(/missing PORTAL_TOKEN/);
    expect(() => userAccountsFromEnv({ ...on, PLATFORM_FILE: "/nonexistent/platform.json" }, NET)).toThrow(/cannot read the platform config/);
    expect(() => userAccountsFromEnv({ ...on, PLATFORM_SELLERS: "[" }, NET)).toThrow(/PLATFORM_SELLERS/);
  });

  it("T-USR-07 a portal token equal to another role's token is refused (INV-13)", () => {
    expect(() => userAccountsFromEnv({ ...on, PORTAL_TOKEN: "dev-control-token" }, NET)).toThrow(/PORTAL_TOKEN must differ from CONTROL_TOKEN/);
    expect(() => userAccountsFromEnv({ ...on, PORTAL_TOKEN: "same", OPERATOR_TOKEN: "same" }, NET)).toThrow(/PORTAL_TOKEN must differ from OPERATOR_TOKEN/);
    expect(() => userAccountsFromEnv({ ...on, PORTAL_TOKEN: "same", SETTLEMENT_TOKEN: "same" }, NET)).toThrow(/PORTAL_TOKEN must differ from SETTLEMENT_TOKEN/);
  });

  it("T-USR-08 a changed mnemonic refuses to start, once the ledger is loaded", async () => {
    const l2 = await start();
    await l2.withWallet(ALICE);
    await l2.withWallet(BOB);
    expect(() => checkWalletAddresses(l2.ledger, l2.keyring)).not.toThrow();
    const other = new WalletKeyring(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
      NET,
    );
    expect(() => checkWalletAddresses(l2.ledger, other)).toThrow(/does not match the ledger \(wallet 0\); refusing to start/);
  });

  it("T-USR-07 PLATFORM_CONFIG is written once per digest", async () => {
    const l2 = await start();
    expect(l2.entries("PLATFORM_CONFIG")).toHaveLength(1);
    const first = l2.entries("PLATFORM_CONFIG")[0]!;
    expect(first.data).toEqual({ platformId: l2.platform.platformId, digest: platformDigest(l2.platform), limits: l2.platform.limits, sellers: l2.platform.sellers });
    expect(recordPlatformConfig(l2.ledger, l2.platform, T0)).toBe(false);
    const tighter = testPlatform({ limits: { hardCapPerPaymentAtomic: "50000" } });
    expect(recordPlatformConfig(l2.ledger, tighter, T0 + 1)).toBe(true);
    expect(recordPlatformConfig(l2.ledger, tighter, T0 + 2)).toBe(false);
    expect(l2.entries("PLATFORM_CONFIG").map((e) => e.data.digest)).toEqual([platformDigest(l2.platform), platformDigest(tighter)]);
  });
});

// ---------------------------------------------------------------------------
// Pure: user and policy state (T-USR-09)
// ---------------------------------------------------------------------------

let seq = 0;
const entry = (type: LedgerEntry["type"], data: Record<string, unknown>, atMs: number = T0): LedgerEntry =>
  ({ seq: seq++, ts: new Date(atMs).toISOString(), type, data, prevHash: "", hash: "" }) as LedgerEntry;
const created = (userId: string, policyId: string, over: Partial<PolicyValues> = {}, atMs = T0) =>
  entry("POLICY_CREATED", { userId, policyId, version: 1, ...policyValues(over), identityConfirmedAtMs: atMs }, atMs);

describe("T-USR-09 user state (pure)", () => {
  it("T-USR-09 an unknown user is all-false with empty lists", () => {
    expect(userState([], ALICE)).toEqual({ userId: ALICE, registered: false, enabled: true, cards: [], policies: [], onboarded: false });
    expect(userGate(userState([], ALICE))).toBe("not_onboarded");
  });

  it("T-USR-09 registered, wallet, cards and onboarded follow the entries", () => {
    const e: LedgerEntry[] = [entry("USER_REGISTERED", { userId: ALICE, acknowledgedTestFunds: true, termsVersion: TERMS_VERSION })];
    expect(userState(e, ALICE).registered).toBe(true);
    expect(userState(e, ALICE).onboarded).toBe(false);
    e.push(entry("WALLET_CREATED", { userId: ALICE, walletIndex: 4, address: "0xabc", network: CAIP2 }));
    expect(userState(e, ALICE).wallet).toEqual({ walletIndex: 4, address: "0xabc", network: CAIP2 });
    expect(userState(e, ALICE).onboarded).toBe(false);
    e.push(entry("CARD_ADDED", { userId: ALICE, cardId: CARD(1) }), entry("CARD_ADDED", { userId: ALICE, cardId: CARD(2) }), entry("CARD_ADDED", { userId: ALICE, cardId: CARD(1) }));
    expect(userState(e, ALICE).cards).toEqual([CARD(1), CARD(2)]);
    e.push(entry("CARD_REMOVED", { userId: ALICE, cardId: CARD(1) }));
    expect(userState(e, ALICE).cards).toEqual([CARD(2)]);
    e.push(created(ALICE, "pol_a"));
    expect(userState(e, ALICE).onboarded).toBe(true);
    expect(userGate(userState(e, ALICE))).toBeUndefined();
  });

  it("T-USR-09 onboarding stays complete after every policy is removed (FR-011)", () => {
    const e = [
      entry("USER_REGISTERED", { userId: ALICE }),
      entry("WALLET_CREATED", { userId: ALICE, walletIndex: 0, address: "0xabc", network: CAIP2 }),
      created(ALICE, "pol_a"),
      entry("POLICY_REMOVED", { userId: ALICE, policyId: "pol_a", version: 1 }),
    ];
    const s = userState(e, ALICE);
    expect(s.policies.map((p) => p.state)).toEqual(["removed"]);
    expect(s.onboarded).toBe(true);
  });

  it("T-USR-09 enabled is the last of USER_DISABLED and USER_ENABLED", () => {
    const e = [entry("USER_REGISTERED", { userId: ALICE }), entry("WALLET_CREATED", { userId: ALICE, walletIndex: 0, address: "0xabc", network: CAIP2 }), created(ALICE, "pol_a")];
    e.push(entry("USER_DISABLED", { userId: ALICE }));
    expect(userState(e, ALICE).enabled).toBe(false);
    expect(userGate(userState(e, ALICE))).toBe("disabled");
    e.push(entry("USER_ENABLED", { userId: ALICE }));
    expect(userState(e, ALICE).enabled).toBe(true);
  });

  it("T-USR-09 one user's entries never appear in another's state", () => {
    const e = [
      entry("USER_REGISTERED", { userId: ALICE }),
      entry("WALLET_CREATED", { userId: ALICE, walletIndex: 0, address: "0xabc", network: CAIP2 }),
      created(ALICE, "pol_a"),
      entry("CARD_ADDED", { userId: ALICE, cardId: CARD(1) }),
      entry("USER_DISABLED", { userId: ALICE }),
    ];
    expect(userState(e, BOB)).toEqual({ userId: BOB, registered: false, enabled: true, cards: [], policies: [], onboarded: false });
  });

  it("T-USR-09 lifecycle: versions, states and history follow the state diagram", () => {
    const e = [
      created(ALICE, "pol_a", {}, T0),
      entry("POLICY_CHANGED", { userId: ALICE, policyId: "pol_a", version: 2, ...policyValues({ dailyBudgetAtomic: "300000" }), loosened: false }, T0 + 1),
      entry("POLICY_PAUSED", { userId: ALICE, policyId: "pol_a", version: 2, cause: "user" }, T0 + 2),
      entry("POLICY_RESUMED", { userId: ALICE, policyId: "pol_a", version: 2, identityConfirmedAtMs: T0 + 3 }, T0 + 3),
      entry("POLICY_PAUSED", { userId: ALICE, policyId: "pol_a", version: 2, cause: "account_enabled" }, T0 + 4),
      entry("POLICY_REMOVED", { userId: ALICE, policyId: "pol_a", version: 2 }, T0 + 5),
      // An event for a policy that was never created is ignored, never trusted.
      entry("POLICY_RESUMED", { userId: ALICE, policyId: "pol_ghost", version: 1 }, T0 + 6),
    ];
    const p = userState(e, ALICE).policies[0]!;
    expect(userState(e, ALICE).policies).toHaveLength(1);
    expect(p.version).toBe(2);
    expect(p.state).toBe("removed");
    expect(p.values.dailyBudgetAtomic).toBe("300000");
    expect(p.history.map((h) => [h.kind, h.version, h.cause])).toEqual([
      ["created", 1, undefined],
      ["changed", 2, undefined],
      ["paused", 2, "user"],
      ["resumed", 2, undefined],
      ["paused", 2, "account_enabled"],
      ["removed", 2, undefined],
    ]);
    expect(p.history[0]!.values?.dailyBudgetAtomic).toBe("500000");
    expect(p.history[1]!.values?.dailyBudgetAtomic).toBe("300000");
    expect(p.history[2]!.values).toBeUndefined();
  });
});

describe("T-USR-09 validation of a policy save (pure, FR-026)", () => {
  const platform = testPlatform();
  const ctx = (over: Partial<Parameters<typeof validatePolicy>[1]> = {}) => ({ platform, nowMs: T0, others: [] as PolicyRecord[], addsActive: true, ...over });
  const codes = (v: Partial<PolicyValues>, c = ctx()) => validatePolicy(policyValues(v), c).map((i) => `${i.field}:${i.code}`);
  const record = (policyId: string, over: Partial<PolicyValues> = {}, state: PolicyRecord["state"] = "active"): PolicyRecord => ({
    policyId,
    userId: ALICE,
    version: 1,
    values: policyValues(over),
    state,
    updatedAt: new Date(T0).toISOString(),
    history: [],
  });

  it("T-USR-09 the US3 policy is valid; an auto-approve limit of 0 is valid", () => {
    expect(codes({})).toEqual([]);
    expect(codes({ autoApproveMaxAtomic: "0" })).toEqual([]);
  });

  it("T-USR-09 every code fires on its condition", () => {
    expect(codes({ autoApproveMaxAtomic: "0.02" })).toEqual(["autoApproveMaxAtomic:not_atomic"]);
    expect(codes({ autoApproveMaxAtomic: "100000" })).toEqual(["autoApproveMaxAtomic:order_auto_below_cap"]);
    expect(codes({ autoApproveMaxAtomic: "100001" })).toEqual(["autoApproveMaxAtomic:order_auto_below_cap"]);
    expect(codes({ sessionBudgetAtomic: "99999" })).toEqual(["hardCapPerPaymentAtomic:order_cap_within_session"]);
    expect(codes({ hardCapPerPaymentAtomic: "100001", sessionBudgetAtomic: "100001" })).toEqual([
      "hardCapPerPaymentAtomic:above_platform_limit",
      "sessionBudgetAtomic:above_platform_limit",
    ]);
    expect(codes({ dailyBudgetAtomic: "500001" })).toEqual(["dailyBudgetAtomic:above_platform_limit"]);
    expect(codes({ maxAuthorizationsPerMinute: 0 })).toEqual(["maxAuthorizationsPerMinute:rate_invalid"]);
    expect(codes({ maxAuthorizationsPerMinute: 1.5 })).toEqual(["maxAuthorizationsPerMinute:rate_invalid"]);
    expect(codes({ maxAuthorizationsPerMinute: 101 })).toEqual(["maxAuthorizationsPerMinute:above_platform_limit"]);
    expect(codes({ sellers: [] })).toEqual(["sellers:no_sellers"]);
    expect(codes({ sellers: [UNLISTED_HOST] })).toEqual(["sellers[0]:seller_not_listed"]);
    expect(codes({ expiresAt: new Date(T0).toISOString() })).toEqual(["expiresAt:expires_in_past"]);
    expect(codes({ expiresAt: new Date(T0 + 366 * DAY).toISOString() })).toEqual(["expiresAt:expires_too_late"]);
    expect(codes({ expiresAt: new Date(T0 + 365 * DAY).toISOString() })).toEqual([]);
    expect(codes({ paymentMethod: "card" as never })).toEqual(["paymentMethod:payment_method_unsupported"]);
  });

  it("T-USR-09 limits and offending hosts are carried on the issue", () => {
    expect(validatePolicy(policyValues({ dailyBudgetAtomic: "500001" }), ctx())).toEqual([{ field: "dailyBudgetAtomic", code: "above_platform_limit", limitAtomic: "500000" }]);
    expect(validatePolicy(policyValues({ maxAuthorizationsPerMinute: 101 }), ctx())).toEqual([{ field: "maxAuthorizationsPerMinute", code: "above_platform_limit", limit: 100 }]);
    expect(validatePolicy(policyValues({ sellers: [SELLER_HOST, UNLISTED_HOST] }), ctx())).toEqual([{ field: "sellers[1]", code: "seller_not_listed", host: UNLISTED_HOST }]);
  });

  it("T-USR-09 more than 20 sellers is refused", () => {
    const sellers = Array.from({ length: MAX_SELLERS_PER_POLICY + 1 }, (_, i) => ({ host: `s${i}.example`, name: `S${i}`, payees: [] }));
    const wide = testPlatform({ sellers });
    const issues = validatePolicy(policyValues({ sellers: sellers.map((s) => s.host) }), ctx({ platform: wide }));
    expect(issues).toEqual([{ field: "sellers", code: "too_many_sellers", limit: 20 }]);
  });

  it("T-USR-09 a seller of another active policy is a conflict naming it; paused and removed policies don't conflict (FR-028)", () => {
    expect(validatePolicy(policyValues(), ctx({ others: [record("pol_first")] }))).toEqual([{ field: "sellers[0]", code: "seller_conflict", host: SELLER_HOST, policyId: "pol_first" }]);
    expect(codes({}, ctx({ others: [record("pol_p", {}, "paused"), record("pol_r", {}, "removed")] }))).toEqual([]);
    expect(codes({ sellers: [OTHER_HOST] }, ctx({ others: [record("pol_first")] }))).toEqual([]);
  });

  it("T-USR-09 the 11th active policy is refused; a change to an existing one is not", () => {
    const ten = Array.from({ length: MAX_ACTIVE_POLICIES }, (_, i) => record(`pol_${i}`, { sellers: [`s${i}.example`] }));
    expect(codes({ sellers: [OTHER_HOST] }, ctx({ others: ten }))).toEqual(["policy:policy_limit"]);
    expect(codes({ sellers: [OTHER_HOST] }, ctx({ others: ten, addsActive: false }))).toEqual([]);
  });

  it("T-USR-09 all issues come back together", () => {
    expect(codes({ autoApproveMaxAtomic: "x", sellers: [], expiresAt: new Date(T0 - 1).toISOString(), maxAuthorizationsPerMinute: 0 })).toEqual([
      "autoApproveMaxAtomic:not_atomic",
      "maxAuthorizationsPerMinute:rate_invalid",
      "sellers:no_sellers",
      "expiresAt:expires_in_past",
    ]);
  });
});

describe("T-USR-05 loosening and step-up (pure, FR-007)", () => {
  const base = policyValues();
  it("T-USR-05 creating is loosening; each raise, an added seller and a later end date are loosening", () => {
    expect(isLoosening(undefined, base)).toBe(true);
    for (const f of ["autoApproveMaxAtomic", "hardCapPerPaymentAtomic", "sessionBudgetAtomic", "dailyBudgetAtomic"] as const) {
      expect(isLoosening(base, { ...base, [f]: (BigInt(base[f]) + 1n).toString() }), f).toBe(true);
      expect(isLoosening(base, { ...base, [f]: (BigInt(base[f]) - 1n).toString() }), f).toBe(false);
    }
    expect(isLoosening(base, { ...base, maxAuthorizationsPerMinute: 11 })).toBe(true);
    expect(isLoosening(base, { ...base, maxAuthorizationsPerMinute: 9 })).toBe(false);
    expect(isLoosening(base, { ...base, sellers: [SELLER_HOST, OTHER_HOST] })).toBe(true);
    expect(isLoosening({ ...base, sellers: [SELLER_HOST, OTHER_HOST] }, base)).toBe(false);
    expect(isLoosening(base, { ...base, sellers: [OTHER_HOST] })).toBe(true);
    expect(isLoosening(base, { ...base, expiresAt: new Date(Date.parse(base.expiresAt) + 1).toISOString() })).toBe(true);
    expect(isLoosening(base, { ...base, expiresAt: new Date(Date.parse(base.expiresAt) - 1).toISOString() })).toBe(false);
    expect(isLoosening(base, base)).toBe(false);
  });

  it("T-USR-05 fresh means at most 15 minutes old, with 60 s tolerance either way of the clock", () => {
    expect(stepUpFresh(T0, T0)).toBe(true);
    expect(stepUpFresh(T0 - STEP_UP_MAX_AGE_MS, T0)).toBe(true);
    expect(stepUpFresh(T0 - STEP_UP_MAX_AGE_MS - 1, T0)).toBe(false);
    expect(stepUpFresh(T0 + STEP_UP_TOLERANCE_MS, T0)).toBe(true);
    expect(stepUpFresh(T0 + STEP_UP_TOLERANCE_MS + 1, T0)).toBe(false);
    for (const bad of [undefined, null, "1", Number.NaN, Number.POSITIVE_INFINITY]) expect(stepUpFresh(bad, T0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pure: selection and the effective mandate (T-USR-10)
// ---------------------------------------------------------------------------

describe("T-USR-10 selection and the effective mandate (pure, FR-029, FR-030)", () => {
  const platformMandate = buildMandate(
    {
      mandateId: "platform-mandate",
      expiresAt: "2027-12-31T23:59:59Z",
      allowedSchemes: ["exact"],
      allowedPayees: [],
      allowedHosts: [SELLER_HOST],
      autoApproveMaxAtomic: "20000",
      hardCapPerPaymentAtomic: "100000",
      sessionBudgetAtomic: "100000",
      dailyBudgetAtomic: "500000",
      maxAuthorizationsPerMinute: 10,
      maxTimeoutSeconds: 240,
    },
    NET,
  );
  const onboarded = (...extra: LedgerEntry[]) => [
    entry("USER_REGISTERED", { userId: ALICE }),
    entry("WALLET_CREATED", { userId: ALICE, walletIndex: 0, address: "0xabc", network: CAIP2 }),
    ...extra,
  ];

  it("T-USR-10 the one active policy listing the host is selected", () => {
    const s = userState(onboarded(created(ALICE, "pol_a"), created(ALICE, "pol_b", { sellers: [OTHER_HOST] })), ALICE);
    expect(selectPolicy(s, SELLER_HOST, testPlatform())?.policyId).toBe("pol_a");
    expect(selectPolicy(s, OTHER_HOST, testPlatform())?.policyId).toBe("pol_b");
    expect(selectPolicy(s, UNLISTED_HOST, testPlatform())).toBeUndefined();
    expect(selectPolicy(s, null, testPlatform())).toBeUndefined();
  });

  it("T-USR-10 a paused or removed policy is not selected; an expired one still is (R1 denies it)", () => {
    const paused = userState(onboarded(created(ALICE, "pol_a"), entry("POLICY_PAUSED", { userId: ALICE, policyId: "pol_a", version: 1, cause: "user" })), ALICE);
    expect(selectPolicy(paused, SELLER_HOST, testPlatform())).toBeUndefined();
    const removed = userState(onboarded(created(ALICE, "pol_a"), entry("POLICY_REMOVED", { userId: ALICE, policyId: "pol_a", version: 1 })), ALICE);
    expect(selectPolicy(removed, SELLER_HOST, testPlatform())).toBeUndefined();
    const expired = userState(onboarded(created(ALICE, "pol_a", { expiresAt: new Date(T0 - 1).toISOString() })), ALICE);
    expect(selectPolicy(expired, SELLER_HOST, testPlatform())?.policyId).toBe("pol_a");
  });

  it("T-USR-10 a seller taken off the seller list is no longer selected (FR-042)", () => {
    const s = userState(onboarded(created(ALICE, "pol_a")), ALICE);
    const without = testPlatform({ sellers: [{ host: OTHER_HOST, name: "Second seller", payees: [] }] });
    expect(selectPolicy(s, SELLER_HOST, without)).toBeUndefined();
  });

  it("T-USR-10 the mandate holds the policy's values for one host, bounded by the platform", () => {
    const s = userState(onboarded(created(ALICE, "pol_b", { sellers: [OTHER_HOST, SELLER_HOST], dailyBudgetAtomic: "300000" })), ALICE);
    const policy = selectPolicy(s, OTHER_HOST, testPlatform())!;
    const m = effectiveMandate({ policy, host: OTHER_HOST, platform: testPlatform(), platformMandate, net: NET });
    expect(m).toEqual({
      mandateId: "pol_b@1",
      expiresAt: policy.values.expiresAt,
      allowedSchemes: ["exact"],
      allowedNetworks: [CAIP2],
      allowedAssets: { [CAIP2]: [ASSET.toLowerCase()] },
      allowedPayees: [PAY_TO],
      allowedHosts: [OTHER_HOST],
      autoApproveMaxAtomic: "20000",
      hardCapPerPaymentAtomic: "100000",
      sessionBudgetAtomic: "100000",
      dailyBudgetAtomic: "300000",
      maxAuthorizationsPerMinute: 10,
      maxTimeoutSeconds: 240,
    });
  });

  it("T-USR-10 platform limits tightened after the save apply: the stricter of the two, field by field (FR-041)", () => {
    const s = userState(onboarded(created(ALICE, "pol_a")), ALICE);
    const tight = testPlatform({ limits: { hardCapPerPaymentAtomic: "50000", sessionBudgetAtomic: "80000", userDailyCeilingAtomic: "200000", maxAuthorizationsPerMinute: 3 } });
    const m = effectiveMandate({ policy: selectPolicy(s, SELLER_HOST, tight), host: SELLER_HOST, platform: tight, platformMandate, net: NET });
    expect([m.hardCapPerPaymentAtomic, m.sessionBudgetAtomic, m.dailyBudgetAtomic, m.maxAuthorizationsPerMinute]).toEqual(["50000", "80000", "200000", 3]);
    expect(m.autoApproveMaxAtomic).toBe("20000");
  });

  it("T-USR-10 without a policy the mandate allows no host, so R6 denies with host_not_allowed (FR-029)", () => {
    const m = effectiveMandate({ policy: undefined, host: SELLER_HOST, platform: testPlatform(), platformMandate, net: NET });
    expect(m.allowedHosts).toEqual([]);
    expect(m.autoApproveMaxAtomic).toBe("0");
    expect(Date.parse(m.expiresAt)).toBeGreaterThan(T0 + 1000 * DAY);
  });
});

// ---------------------------------------------------------------------------
// Routes: roles, off, reads (T-USR-01, T-USR-02, T-USR-06)
// ---------------------------------------------------------------------------

const PORTAL_ROUTES: Array<[string, string]> = [
  ["GET", "/v1/platform"],
  ["GET", `/v1/users/${ALICE}`],
  ["PUT", `/v1/users/${ALICE}/registration`],
  ["PUT", `/v1/users/${ALICE}/wallet`],
  ["POST", `/v1/users/${ALICE}/policies`],
  ["GET", `/v1/users/${ALICE}/policies/pol_x`],
  ["PUT", `/v1/users/${ALICE}/policies/pol_x`],
  ["POST", `/v1/users/${ALICE}/policies/pol_x/pause`],
  ["POST", `/v1/users/${ALICE}/policies/pol_x/resume`],
  ["POST", `/v1/users/${ALICE}/policies/pol_x/remove`],
  ["POST", `/v1/users/${ALICE}/disable`],
  ["POST", `/v1/users/${ALICE}/enable`],
  ["PUT", `/v1/users/${ALICE}/cards/${CARD(1)}`],
  ["DELETE", `/v1/users/${ALICE}/cards/${CARD(1)}`],
];
const OTHER_ROUTES: Array<[string, string]> = [
  ["POST", "/v1/authorize"],
  ["GET", "/v1/budget/sess_x"],
  ["POST", "/v1/reconcile"],
  ["POST", "/v1/approvals/auth_x"],
  ["POST", "/v1/rejections/auth_x"],
  ["GET", "/v1/escalations"],
  ["GET", "/v1/escalations/events"],
  ["GET", "/v1/ledger/verify"],
];

describe("T-USR-02 role isolation (INV-13, FR-049)", () => {
  it("T-USR-02 the portal token is refused on every deciding, approving and reconciling route", async () => {
    const l2 = await start();
    for (const [method, path] of OTHER_ROUTES) {
      expect((await l2.call(method, path, { token: TOKENS.portal, body: method === "GET" ? undefined : {} })).status, `${method} ${path}`).toBe(401);
    }
    expect(l2.entries().filter((e) => e.type !== "PLATFORM_CONFIG")).toEqual([]);
  });

  it("T-USR-02 no token, and each of the other three tokens, is refused on every user-account route", async () => {
    const l2 = await start();
    for (const [method, path] of PORTAL_ROUTES) {
      for (const token of [null, TOKENS.control, TOKENS.settlement, TOKENS.operator, "nonsense"]) {
        expect((await l2.call(method, path, { token, body: method === "GET" || method === "DELETE" ? undefined : {} })).status, `${method} ${path} ${token}`).toBe(401);
      }
    }
    expect(l2.entries().filter((e) => e.type !== "PLATFORM_CONFIG")).toEqual([]);
  });

  it("T-USR-02 401 precedes 400: a malformed user ID with a wrong token is 401, with the right token 400", async () => {
    const l2 = await start();
    expect((await l2.call("GET", "/v1/users/not-a-user", { token: TOKENS.control })).status).toBe(401);
    expect((await l2.call("GET", "/v1/users/not-a-user")).status).toBe(400);
    expect((await l2.call("PUT", "/v1/users/usr_SHOUTING/wallet")).status).toBe(400);
  });
});

describe("T-USR-06 off by default (FR-001)", () => {
  it("T-USR-06 with user accounts off every user-account route is 404", async () => {
    const l2 = await start({ off: true });
    for (const [method, path] of PORTAL_ROUTES) {
      expect((await l2.call(method, path, { body: method === "GET" || method === "DELETE" ? undefined : {} })).status, `${method} ${path}`).toBe(404);
    }
  });

  it("T-USR-06 off, a userId on an intent changes nothing: same decision, same entries, the platform payer signs", async () => {
    const off = await start({ off: true });
    const plain = await off.authorize(off.intentFor("/api/weather", "1000", { sessionId: "sess_1" }));
    const named = await off.authorize(off.intentFor("/api/weather", "1000", { sessionId: "sess_2", userId: ALICE }));
    expect(plain.body.status).toBe("AUTHORIZED");
    expect(named.body.status).toBe("AUTHORIZED");
    expect((named.body as { payer: string }).payer).toBe(PLATFORM_PAYER);
    const [a, b] = [off.entries("AUTHORIZED")[0]!, off.entries("AUTHORIZED")[1]!];
    expect(Object.keys(b.data).sort()).toEqual(Object.keys(a.data).sort());
    expect(JSON.stringify(off.entries())).not.toContain(ALICE);
    expect(off.entries("PLATFORM_CONFIG")).toEqual([]);
    // The budget query is ignored too.
    const budget = await off.call("GET", `/v1/budget/sess_2?userId=${ALICE}`, { token: TOKENS.control });
    expect(budget.body.scope).toBeUndefined();
  });

  it("T-USR-06 a malformed userId is a 400 whether user accounts are on or off", async () => {
    for (const o of [{ off: true }, {}]) {
      const l2 = await start(o);
      const res = await l2.authorize({ ...l2.intentFor("/api/weather", "1000"), userId: "alice" });
      expect(res.status).toBe(400);
      expect(l2.entries("INTENT")).toEqual([]);
    }
  });
});

describe("T-USR-01 reads", () => {
  it("T-USR-01 GET /v1/platform returns the config in force, with its digest and the network", async () => {
    const l2 = await start();
    const res = await l2.portal("GET", "/v1/platform");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ platformId: l2.platform.platformId, digest: platformDigest(l2.platform), limits: l2.platform.limits, sellers: l2.platform.sellers, network: CAIP2, asset: ASSET, decimals: 6 });
  });

  it("T-USR-01 an unknown user is registered:false with empty lists, never 404", async () => {
    const l2 = await start();
    const res = await l2.portal<UserView>("GET", `/v1/users/${ALICE}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: ALICE, registered: false, enabled: true, onboarding: { profile: false, wallet: false, policy: false }, cards: [], policies: [] });
  });
});

// ---------------------------------------------------------------------------
// US1: registration (T-USR-01, T-USR-04)
// ---------------------------------------------------------------------------

describe("T-USR-01 registration, T-USR-04 idempotency (US1, FR-009)", () => {
  it("T-USR-01 the first call appends USER_REGISTERED; later calls append nothing", async () => {
    const l2 = await start();
    const first = await l2.portal<UserView>("PUT", `/v1/users/${ALICE}/registration`, { acknowledgedTestFunds: true });
    expect(first.status).toBe(200);
    expect(first.body.registered).toBe(true);
    expect(first.body.onboarding).toEqual({ profile: true, wallet: false, policy: false });
    const second = await l2.portal<UserView>("PUT", `/v1/users/${ALICE}/registration`, { acknowledgedTestFunds: true });
    expect(second.status).toBe(200);
    expect(l2.entries("USER_REGISTERED").map((e) => e.data)).toEqual([{ userId: ALICE, acknowledgedTestFunds: true, termsVersion: "test-funds-v1" }]);
    const e = l2.entries("USER_REGISTERED")[0]!;
    expect([e.sessionId, e.intentId, e.authorizationId]).toEqual([undefined, undefined, undefined]);
  });

  it("T-USR-01 without the acknowledgement, or with anything else in the body, it is a 400 and nothing is appended", async () => {
    const l2 = await start();
    for (const body of [{}, { acknowledgedTestFunds: false }, { acknowledgedTestFunds: "true" }, { acknowledgedTestFunds: true, displayName: "Ana" }]) {
      expect((await l2.portal("PUT", `/v1/users/${ALICE}/registration`, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(l2.entries("USER_REGISTERED")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// US2: the wallet (T-USR-01, T-USR-04)
// ---------------------------------------------------------------------------

describe("T-USR-01 wallet, T-USR-04 idempotency (US2, FR-013..FR-015)", () => {
  it("T-USR-01 a registered user gets one account at the next index; an unregistered one is refused", async () => {
    const l2 = await start();
    expect((await l2.portal("PUT", `/v1/users/${ALICE}/wallet`)).body).toEqual({ error: "not_registered" });
    const a = await l2.withWallet(ALICE);
    const b = await l2.withWallet(BOB);
    expect(a).toBe(l2.keyring.addressOf(0));
    expect(b).toBe(l2.keyring.addressOf(1));
    expect(l2.entries("WALLET_CREATED").map((e) => e.data)).toEqual([
      { userId: ALICE, walletIndex: 0, address: l2.keyring.addressOf(0), network: CAIP2 },
      { userId: BOB, walletIndex: 1, address: l2.keyring.addressOf(1), network: CAIP2 },
    ]);
  });

  it("T-USR-04 ten concurrent calls for one user create exactly one account", async () => {
    const l2 = await start();
    await l2.portal("PUT", `/v1/users/${ALICE}/registration`, { acknowledgedTestFunds: true });
    const replies = await Promise.all(Array.from({ length: 10 }, () => l2.portal<UserView>("PUT", `/v1/users/${ALICE}/wallet`)));
    expect(new Set(replies.map((r) => r.body.wallet?.address))).toEqual(new Set([l2.keyring.addressOf(0)]));
    expect(l2.entries("WALLET_CREATED")).toHaveLength(1);
  });

  it("T-USR-01 a fresh wallet's figures are zero spend and the whole ceiling", async () => {
    const l2 = await start();
    await l2.withWallet(ALICE);
    const view = (await l2.portal<UserView>("GET", `/v1/users/${ALICE}`)).body;
    expect(view.wallet).toEqual({
      address: l2.keyring.addressOf(0),
      network: CAIP2,
      asset: ASSET,
      decimals: 6,
      committedAtomic: "0",
      spent24hAtomic: "0",
      dailyCeilingAtomic: "500000",
      dailyRemainingAtomic: "500000",
    });
    expect(view.onboarding).toEqual({ profile: true, wallet: true, policy: false });
  });

  it("T-USR-01 no response and no ledger line ever holds the mnemonic or a private key", async () => {
    const l2 = await start();
    await l2.onboard(ALICE);
    const view = await l2.portal("GET", `/v1/users/${ALICE}`);
    const all = JSON.stringify(view.body) + readFileSync(l2.ledgerFile, "utf8");
    for (const word of ["sausage", "winner", "thank year"]) expect(all).not.toContain(word);
    expect(all).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });
});

// ---------------------------------------------------------------------------
// US3: creating a policy and deciding with it (T-USR-05, T-USR-11)
// ---------------------------------------------------------------------------

describe("T-USR-05 creating a policy (US3)", () => {
  it("T-USR-05 create appends POLICY_CREATED with exactly the values, and returns version 1", async () => {
    const l2 = await start();
    await l2.withWallet(ALICE);
    const res = await l2.createPolicy(ALICE, { sellers: [OTHER_HOST, SELLER_HOST] });
    expect(res.status).toBe(201);
    const view = res.body as unknown as PolicyView;
    expect(view.version).toBe(1);
    expect(view.state).toBe("active");
    expect(view.displayState).toBe("active");
    expect(view.values.sellers).toEqual([SELLER_HOST, OTHER_HOST].sort());
    expect(view.history?.map((h) => h.kind)).toEqual(["created"]);
    const e = l2.entries("POLICY_CREATED")[0]!;
    expect(Object.keys(e.data).sort()).toEqual(
      ["userId", "policyId", "version", "identityConfirmedAtMs", "sellers", "autoApproveMaxAtomic", "hardCapPerPaymentAtomic", "sessionBudgetAtomic", "dailyBudgetAtomic", "maxAuthorizationsPerMinute", "expiresAt", "paymentMethod"].sort(),
    );
    expect(String(e.data.policyId)).toMatch(/^pol_[0-9a-f-]{36}$/);
    const user = (await l2.portal<UserView>("GET", `/v1/users/${ALICE}`)).body;
    expect(user.onboarding).toEqual({ profile: true, wallet: true, policy: true });
  });

  it("T-USR-05 a create is always loosening: without a fresh sign-in time it is 403 and nothing is appended", async () => {
    const l2 = await start();
    await l2.withWallet(ALICE);
    for (const identityConfirmedAtMs of [null, T0 - STEP_UP_MAX_AGE_MS - 1]) {
      const res = await l2.createPolicy(ALICE, {}, { identityConfirmedAtMs });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "step_up_required", maxAgeSec: 900 });
    }
    expect(l2.entries("POLICY_CREATED")).toEqual([]);
    expect((await l2.createPolicy(ALICE, {}, { identityConfirmedAtMs: T0 - STEP_UP_MAX_AGE_MS })).status).toBe(201);
  });

  it("T-USR-05 without a registration or a wallet it is a 409; a malformed body is a 400", async () => {
    const l2 = await start();
    expect((await l2.createPolicy(ALICE)).body).toEqual({ error: "not_registered" });
    await l2.portal("PUT", `/v1/users/${ALICE}/registration`, { acknowledgedTestFunds: true });
    expect((await l2.createPolicy(ALICE)).body).toEqual({ error: "no_wallet" });
    await l2.portal("PUT", `/v1/users/${ALICE}/wallet`);
    const ok = { ...policyValues(), identityConfirmedAtMs: T0 };
    for (const body of [{ ...ok, name: "My policy" }, { ...ok, sellers: "x" }, { ...ok, autoApproveMaxAtomic: 20000 }, { ...ok, expiresAt: "tomorrow" }, { ...ok, maxAuthorizationsPerMinute: "10" }]) {
      expect((await l2.portal("POST", `/v1/users/${ALICE}/policies`, body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect(l2.entries("POLICY_CREATED")).toEqual([]);
  });

  it("T-USR-05 an invalid policy is a 422 with every issue", async () => {
    const l2 = await start();
    await l2.withWallet(ALICE);
    const res = await l2.createPolicy(ALICE, { hardCapPerPaymentAtomic: "200000", sessionBudgetAtomic: "200000", sellers: [UNLISTED_HOST] });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: "invalid_policy",
      issues: [
        { field: "hardCapPerPaymentAtomic", code: "above_platform_limit", limitAtomic: "100000" },
        { field: "sessionBudgetAtomic", code: "above_platform_limit", limitAtomic: "100000" },
        { field: "sellers[0]", code: "seller_not_listed", host: UNLISTED_HOST },
      ],
    });
  });
});

describe("T-USR-11 decisions for a user (US3, FR-029..FR-033)", () => {
  it("T-USR-11 within the auto-approve limit: AUTHORIZED, signed by the user's own account, recorded with user and policy", async () => {
    const l2 = await start();
    const { address, policyId } = await l2.onboard(ALICE);
    const res = await l2.authorize(l2.intentFor("/api/weather", "1000", { userId: ALICE }));
    expect(res.body.status).toBe("AUTHORIZED");
    const d = res.body as Extract<typeof res.body, { status: "AUTHORIZED" }>;
    expect(d.payer.toLowerCase()).toBe(address.toLowerCase());
    expect(d.payer).not.toBe(PLATFORM_PAYER);
    expect(d.remainingSessionBudgetAtomic).toBe("99000");
    const a = l2.entries("AUTHORIZED")[0]!;
    expect(a.data).toMatchObject({ userId: ALICE, policyId, policyVersion: 1, mandateId: `${policyId}@1`, payer: d.payer, amount: "1000" });
    expect(l2.entries("INTENT")[0]!.data.userId).toBe(ALICE);
  });

  it("T-USR-11 above the auto-approve limit: ESCALATE, with the user and the policy on the entry", async () => {
    const l2 = await start();
    const { policyId } = await l2.onboard(ALICE);
    const res = await l2.authorize(l2.intentFor("/api/premium-report", "50000", { userId: ALICE }));
    expect(res.body.status).toBe("ESCALATE");
    expect(l2.entries("ESCALATED")[0]!.data).toMatchObject({ userId: ALICE, policyId, policyVersion: 1, amount: "50000" });
    // A repeat while pending reuses it, and records whose it is.
    const again = await l2.authorize(l2.intentFor("/api/premium-report", "50000", { userId: ALICE }));
    expect(again.body.authorizationId).toBe(res.body.authorizationId);
    expect(l2.entries("ESCALATION_REPEATED")[0]!.data).toMatchObject({ userId: ALICE, policyId, policyVersion: 1 });
  });

  it("T-USR-11 above the cap, at another seller, or without a policy: DENIED with today's rules", async () => {
    const l2 = await start();
    await l2.onboard(ALICE);
    const rules = async (path: string, amount: string, o: { host?: string } = {}) => {
      const res = await l2.authorize(l2.intentFor(path, amount, { userId: ALICE, ...o }));
      expect(res.body.status).toBe("DENIED");
      return (res.body as { violations: { rule: string }[] }).violations.map((v) => v.rule);
    };
    expect(await rules("/api/dataset-export", "200000")).toEqual(["hard_cap_exceeded", "session_budget_exceeded"]);
    expect(await rules("/api/weather", "1000", { host: OTHER_HOST })).toEqual(["host_not_allowed"]);
    expect(await rules("/api/weather", "1000", { host: "127.0.0.1:4099" })).toEqual(["host_not_allowed"]);
    const denied = l2.entries("DENIED");
    expect(denied[0]!.data).toMatchObject({ userId: ALICE, policyVersion: 1 });
    // No policy applied at another seller: the entry names the user and no policy.
    expect(denied[1]!.data.userId).toBe(ALICE);
    expect(denied[1]!.data.policyId).toBeUndefined();
    expect(l2.entries("AUTHORIZED")).toEqual([]);
  });

  it("T-USR-11 a user who has not finished onboarding, or is unknown, is DENIED user_not_onboarded with a fixed detail (FR-012)", async () => {
    const l2 = await start();
    await l2.withWallet(BOB); // profile and wallet, no policy
    for (const userId of [BOB, userIdFor("dev", "nobody")]) {
      const res = await l2.authorize(l2.intentFor("/api/weather", "1000", { userId }));
      expect(res.body).toMatchObject({ status: "DENIED", violations: [{ rule: "user_not_onboarded", detail: "the user's setup is incomplete" }] });
    }
    expect(l2.entries("AUTHORIZED")).toEqual([]);
    expect(l2.entries("DENIED").map((e) => [e.data.userId, e.data.policyId])).toEqual([
      [BOB, undefined],
      [userIdFor("dev", "nobody"), undefined],
    ]);
  });

  it("T-USR-11 a seller's payees come from the seller list (R5), never from the user", async () => {
    const l2 = await start();
    await l2.onboard(ALICE, { sellers: [OTHER_HOST] });
    const stranger = "0xdddddddddddddddddddddddddddddddddddddddd";
    const bad = await l2.authorize(l2.intentFor("/api/weather", "1000", { userId: ALICE, host: OTHER_HOST, payTo: stranger }));
    expect((bad.body as { violations: { rule: string }[] }).violations.map((v) => v.rule)).toEqual(["payee_not_allowed"]);
    const ok = await l2.authorize(l2.intentFor("/api/weather", "1000", { userId: ALICE, host: OTHER_HOST, payTo: PAY_TO }));
    expect(ok.body.status).toBe("AUTHORIZED");
  });

  it("T-USR-11 the budget view for a user counts the daily ceiling; zeros when not onboarded; 400 when malformed", async () => {
    const l2 = await start();
    await l2.onboard(ALICE);
    await l2.authorize(l2.intentFor("/api/weather", "1000", { userId: ALICE }));
    const mine = await l2.call("GET", `/v1/budget/sess_u?userId=${ALICE}`, { token: TOKENS.control });
    expect(mine.body).toEqual({ sessionId: "sess_u", asset: ASSET, decimals: 6, sessionCapAtomic: "500000", spentOrReservedAtomic: "1000", remainingAtomic: "499000", perPaymentCapAtomic: "20000", scope: "user_daily" });
    const nobody = await l2.call("GET", `/v1/budget/sess_u?userId=${BOB}`, { token: TOKENS.control });
    expect(nobody.body).toMatchObject({ sessionCapAtomic: "0", spentOrReservedAtomic: "0", remainingAtomic: "0", perPaymentCapAtomic: "0", scope: "user_daily" });
    expect((await l2.call("GET", "/v1/budget/sess_u?userId=alice", { token: TOKENS.control })).status).toBe(400);
    // Without the query: the platform account's session view, untouched by the user's payment.
    const platform = await l2.call("GET", "/v1/budget/sess_u", { token: TOKENS.control });
    expect(platform.body).toMatchObject({ sessionCapAtomic: "100000", spentOrReservedAtomic: "0" });
    expect(platform.body.scope).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// US4: isolation (T-USR-03, T-USR-11)
// ---------------------------------------------------------------------------

describe("T-USR-03 ownership (US4, FR-004)", () => {
  const routes = (userId: string, policyId: string): Array<[string, string, unknown?]> => [
    ["GET", `/v1/users/${userId}/policies/${policyId}`],
    ["PUT", `/v1/users/${userId}/policies/${policyId}`, { ...policyValues({ dailyBudgetAtomic: "100000" }), expectedVersion: 1 }],
    ["POST", `/v1/users/${userId}/policies/${policyId}/pause`, {}],
    ["POST", `/v1/users/${userId}/policies/${policyId}/resume`, { identityConfirmedAtMs: T0 }],
    ["POST", `/v1/users/${userId}/policies/${policyId}/remove`, {}],
  ];

  it("T-USR-03 another user's policy ID is a 404, indistinguishable from an unknown one, on every route", async () => {
    const l2 = await start();
    await l2.onboard(ALICE);
    const bob = await l2.onboard(BOB, { sellers: [OTHER_HOST] });
    const before = l2.entries().length;
    for (const [method, path, body] of routes(ALICE, bob.policyId)) {
      const theirs = await l2.portal(method, path, body);
      const unknown = await l2.portal(method, path.replace(bob.policyId, "pol_00000000-0000-4000-8000-000000000000"), body);
      expect(theirs.status, `${method} ${path}`).toBe(404);
      expect(theirs.body).toEqual(unknown.body);
    }
    expect(l2.entries().length).toBe(before);
    expect((await l2.portal<PolicyView>("GET", `/v1/users/${BOB}/policies/${bob.policyId}`)).body.state).toBe("active");
  });

  it("T-USR-03 must-fail: with skipOwnershipCheck, user A reads user B's policy", async () => {
    const l2 = await start({ users: { skipOwnershipCheck: true } });
    await l2.onboard(ALICE);
    const bob = await l2.onboard(BOB, { sellers: [OTHER_HOST] });
    const res = await l2.portal<PolicyView>("GET", `/v1/users/${ALICE}/policies/${bob.policyId}`);
    expect(res.status).toBe(200);
    expect(res.body.values.sellers).toEqual([OTHER_HOST]);
  });
});

describe("T-USR-11 isolation between users (US4, FR-002, FR-017, FR-031)", () => {
  it("T-USR-11 each user's payment is signed by their own account, never another's or the platform's", async () => {
    const l2 = await start();
    const a = await l2.onboard(ALICE);
    const b = await l2.onboard(BOB);
    const pa = await l2.authorize(l2.intentFor("/api/weather", "1000", { userId: ALICE, sessionId: "sess_a" }));
    const pb = await l2.authorize(l2.intentFor("/api/weather", "1000", { userId: BOB, sessionId: "sess_b" }));
    const payer = (r: typeof pa) => (r.body as { payer: string }).payer.toLowerCase();
    expect(payer(pa)).toBe(a.address.toLowerCase());
    expect(payer(pb)).toBe(b.address.toLowerCase());
    expect(a.address).not.toBe(b.address);
    expect(l2.entries("AUTHORIZED").map((e) => e.data.userId)).toEqual([ALICE, BOB]);
  });

  it("T-USR-11 one user's spending never uses up another's budget, or the platform account's", async () => {
    const l2 = await start();
    await l2.onboard(ALICE, { dailyBudgetAtomic: "100000" });
    await l2.onboard(BOB, { dailyBudgetAtomic: "100000" });
    // Alice commits her whole session and daily budget.
    for (let i = 0; i < 5; i++) {
      expect((await l2.authorize(l2.intentFor(`/api/item-${i}`, "20000", { userId: ALICE, sessionId: "sess_shared" }))).body.status).toBe("AUTHORIZED");
    }
    const over = await l2.authorize(l2.intentFor("/api/item-5", "1000", { userId: ALICE, sessionId: "sess_shared" }));
    expect((over.body as { violations: { rule: string }[] }).violations.map((v) => v.rule)).toEqual(["session_budget_exceeded", "daily_budget_exceeded"]);
    // Bob, even in the same session ID, has his own budgets.
    const bob = await l2.authorize(l2.intentFor("/api/weather", "20000", { userId: BOB, sessionId: "sess_shared" }));
    expect(bob.body.status).toBe("AUTHORIZED");
    expect((bob.body as { remainingSessionBudgetAtomic: string }).remainingSessionBudgetAtomic).toBe("80000");
    // The platform account, same session ID again, is untouched.
    const platform = await l2.authorize(l2.intentFor("/api/weather", "20000", { sessionId: "sess_shared" }));
    expect(platform.body.status).toBe("AUTHORIZED");
    expect((platform.body as { payer: string; remainingSessionBudgetAtomic: string }).payer).toBe(PLATFORM_PAYER);
    expect((platform.body as { remainingSessionBudgetAtomic: string }).remainingSessionBudgetAtomic).toBe("80000");
  });

  it("T-USR-11 an intent with no user is the platform account, exactly as before (FR-002)", async () => {
    const l2 = await start();
    await l2.onboard(ALICE);
    const res = await l2.authorize(l2.intentFor("/api/weather", "1000"));
    expect(res.body.status).toBe("AUTHORIZED");
    expect((res.body as { payer: string }).payer).toBe(PLATFORM_PAYER);
    const a = l2.entries("AUTHORIZED")[0]!;
    expect(a.data.mandateId).toBe("mandate-test-013");
    expect([a.data.userId, a.data.policyId, a.data.policyVersion]).toEqual([undefined, undefined, undefined]);
    expect(l2.entries("INTENT")[0]!.data.userId).toBeUndefined();
  });

  it("T-USR-11 an approval for one user's escalation never lifts the requirement for another user (INV-12)", async () => {
    const l2 = await start();
    await l2.onboard(ALICE);
    await l2.onboard(BOB);
    const esc = await l2.authorize(l2.intentFor("/api/premium-report", "50000", { userId: ALICE, sessionId: "sess_shared" }));
    expect(esc.body.status).toBe("ESCALATE");
    expect((await l2.call("POST", `/v1/approvals/${esc.body.authorizationId}`, { token: TOKENS.operator, body: {} })).status).toBe(200);
    // Bob, same session and resource: still needs his own approval. The platform account too.
    expect((await l2.authorize(l2.intentFor("/api/premium-report", "50000", { userId: BOB, sessionId: "sess_shared" }))).body.status).toBe("ESCALATE");
    expect((await l2.authorize(l2.intentFor("/api/premium-report", "50000", { sessionId: "sess_shared" }))).body.status).toBe("ESCALATE");
    // Alice's own request consumes it.
    const paid = await l2.authorize(l2.intentFor("/api/premium-report", "50000", { userId: ALICE, sessionId: "sess_shared" }));
    expect(paid.body.status).toBe("AUTHORIZED");
  });

  it("T-USR-11 must-fail: with sharedSigner, a user's payment is signed by the platform account", async () => {
    const l2 = await start({ users: { sharedSigner: true } });
    await l2.onboard(ALICE);
    const res = await l2.authorize(l2.intentFor("/api/weather", "1000", { userId: ALICE }));
    expect((res.body as { payer: string }).payer).toBe(PLATFORM_PAYER);
  });

  it("T-USR-11 must-fail: with sharedBudgets, one user's spending exhausts another's budget", async () => {
    const l2 = await start({ users: { sharedBudgets: true } });
    await l2.onboard(ALICE, { dailyBudgetAtomic: "100000" });
    await l2.onboard(BOB, { dailyBudgetAtomic: "100000" });
    for (let i = 0; i < 5; i++) await l2.authorize(l2.intentFor(`/api/item-${i}`, "20000", { userId: ALICE, sessionId: `sess_a${i}` }));
    const bob = await l2.authorize(l2.intentFor("/api/weather", "20000", { userId: BOB, sessionId: "sess_b" }));
    expect(bob.body.status).toBe("DENIED");
    expect((bob.body as { violations: { rule: string }[] }).violations.map((v) => v.rule)).toContain("daily_budget_exceeded");
  });

  it("T-USR-11 must-fail: with fallbackToPlatform, a person who has not onboarded pays from the platform account", async () => {
    const l2 = await start({ users: { fallbackToPlatform: true } });
    const res = await l2.authorize(l2.intentFor("/api/weather", "1000", { userId: BOB }));
    expect(res.body.status).toBe("AUTHORIZED");
    expect((res.body as { payer: string }).payer).toBe(PLATFORM_PAYER);
  });
});

// ---------------------------------------------------------------------------
// US5: the policy lifecycle (T-USR-04, T-USR-05, T-USR-09, T-USR-10, T-USR-11)
// ---------------------------------------------------------------------------

describe("T-USR-09 policy lifecycle through the routes (US5, FR-035)", () => {
  const change = (l2: UsersL2, userId: string, policyId: string, over: Partial<PolicyValues>, o: { expectedVersion?: number; identityConfirmedAtMs?: number } = {}) =>
    l2.portal("PUT", `/v1/users/${userId}/policies/${policyId}`, {
      ...policyValues(over, T0),
      expectedVersion: o.expectedVersion ?? 1,
      ...(o.identityConfirmedAtMs !== undefined && { identityConfirmedAtMs: o.identityConfirmedAtMs }),
    });

  it("T-USR-09 a change appends POLICY_CHANGED with the next version; the same values again append nothing (T-USR-04)", async () => {
    const l2 = await start();
    const { policyId } = await l2.onboard(ALICE);
    const res = await change(l2, ALICE, policyId, { dailyBudgetAtomic: "300000" });
    expect(res.status).toBe(200);
    expect((res.body as unknown as PolicyView).version).toBe(2);
    const e = l2.entries("POLICY_CHANGED")[0]!;
    expect(e.data).toMatchObject({ userId: ALICE, policyId, version: 2, dailyBudgetAtomic: "300000", loosened: false });
    expect(e.data.identityConfirmedAtMs).toBeUndefined();
    // A double click or a retry: the same values with the old expected version.
    const again = await change(l2, ALICE, policyId, { dailyBudgetAtomic: "300000" });
    expect(again.status).toBe(200);
    expect((again.body as unknown as PolicyView).version).toBe(2);
    expect(l2.entries("POLICY_CHANGED")).toHaveLength(1);
  });

  it("T-USR-09 a stale expectedVersion is a 409 with the current policy; nothing is overwritten", async () => {
    const l2 = await start();
    const { policyId } = await l2.onboard(ALICE);
    await change(l2, ALICE, policyId, { dailyBudgetAtomic: "300000" });
    const stale = await change(l2, ALICE, policyId, { dailyBudgetAtomic: "200000" }, { expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("version_conflict");
    expect((stale.body.current as PolicyView).version).toBe(2);
    expect((stale.body.current as PolicyView).values.dailyBudgetAtomic).toBe("300000");
    expect(l2.entries("POLICY_CHANGED")).toHaveLength(1);
    expect((await change(l2, ALICE, policyId, { dailyBudgetAtomic: "200000" }, { expectedVersion: 2 })).status).toBe(200);
  });

  it("T-USR-05 loosening needs a fresh sign-in; tightening never does", async () => {
    const l2 = await start();
    const { policyId } = await l2.onboard(ALICE, { dailyBudgetAtomic: "300000", sessionBudgetAtomic: "100000", hardCapPerPaymentAtomic: "50000", autoApproveMaxAtomic: "10000", maxAuthorizationsPerMinute: 5 });
    const base = { dailyBudgetAtomic: "300000", sessionBudgetAtomic: "100000", hardCapPerPaymentAtomic: "50000", autoApproveMaxAtomic: "10000", maxAuthorizationsPerMinute: 5 };
    const stale = T0 - STEP_UP_MAX_AGE_MS - 1;
    const loosenings: Array<Partial<PolicyValues>> = [
      { ...base, dailyBudgetAtomic: "300001" },
      { ...base, hardCapPerPaymentAtomic: "50001" },
      { ...base, autoApproveMaxAtomic: "10001" },
      { ...base, maxAuthorizationsPerMinute: 6 },
      { ...base, sellers: [SELLER_HOST, OTHER_HOST] },
      { ...base, expiresAt: new Date(T0 + 31 * DAY).toISOString() },
    ];
    for (const over of loosenings) {
      expect((await change(l2, ALICE, policyId, over)).body, JSON.stringify(over)).toEqual({ error: "step_up_required", maxAgeSec: 900 });
      expect((await change(l2, ALICE, policyId, over, { identityConfirmedAtMs: stale })).status).toBe(403);
    }
    expect(l2.entries("POLICY_CHANGED")).toEqual([]);
    // Tightening: no sign-in time at all.
    expect((await change(l2, ALICE, policyId, { ...base, dailyBudgetAtomic: "200000" })).status).toBe(200);
    // Loosening with a fresh one: recorded with the time.
    const fresh = await change(l2, ALICE, policyId, { ...base, dailyBudgetAtomic: "250000" }, { expectedVersion: 2, identityConfirmedAtMs: T0 - STEP_UP_MAX_AGE_MS });
    expect(fresh.status).toBe(200);
    expect(l2.entries("POLICY_CHANGED")[1]!.data).toMatchObject({ loosened: true, identityConfirmedAtMs: T0 - STEP_UP_MAX_AGE_MS });
  });

  it("T-USR-09 pause, resume and remove follow the diagram and are idempotent (T-USR-04)", async () => {
    const l2 = await start();
    const { policyId } = await l2.onboard(ALICE);
    const post = (action: string, body: unknown = {}) => l2.portal<PolicyView>("POST", `/v1/users/${ALICE}/policies/${policyId}/${action}`, body);
    expect((await post("pause")).body.state).toBe("paused");
    expect((await post("pause")).body.state).toBe("paused");
    expect(l2.entries("POLICY_PAUSED").map((e) => e.data)).toEqual([{ userId: ALICE, policyId, version: 1, cause: "user" }]);
    // Resuming restores spending: it needs a fresh sign-in.
    expect((await post("resume")).status).toBe(403);
    expect((await post("resume", { identityConfirmedAtMs: T0 })).body.state).toBe("active");
    expect((await post("resume", { identityConfirmedAtMs: T0 })).body.state).toBe("active");
    expect(l2.entries("POLICY_RESUMED")).toHaveLength(1);
    expect((await post("remove")).body.state).toBe("removed");
    expect((await post("remove")).body.state).toBe("removed");
    expect(l2.entries("POLICY_REMOVED")).toHaveLength(1);
    expect((await post("pause")).body).toEqual({ error: "policy_removed" });
    expect((await post("resume", { identityConfirmedAtMs: T0 })).body).toEqual({ error: "policy_removed" });
    // A body the route does not expect is a 400, before anything is looked up.
    expect((await post("pause", { identityConfirmedAtMs: T0 })).status).toBe(400);
    expect((await change(l2, ALICE, policyId, { dailyBudgetAtomic: "100000" })).body).toEqual({ error: "policy_removed" });
    const view = (await l2.portal<PolicyView>("GET", `/v1/users/${ALICE}/policies/${policyId}`)).body;
    expect(view.history?.map((h) => h.kind)).toEqual(["created", "paused", "resumed", "removed"]);
    // Removed policies stay visible in the user's list (FR-035).
    expect((await l2.portal<UserView>("GET", `/v1/users/${ALICE}`)).body.policies.map((p) => p.state)).toEqual(["removed"]);
  });

  it("T-USR-09 resume re-validates: a seller now in another active policy is a conflict", async () => {
    const l2 = await start();
    const first = await l2.onboard(ALICE);
    await l2.portal("POST", `/v1/users/${ALICE}/policies/${first.policyId}/pause`, {});
    const second = await l2.createPolicy(ALICE);
    expect(second.status).toBe(201);
    const res = await l2.portal("POST", `/v1/users/${ALICE}/policies/${first.policyId}/resume`, { identityConfirmedAtMs: T0 });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "invalid_policy", issues: [{ field: "sellers[0]", code: "seller_conflict", host: SELLER_HOST, policyId: second.body.policyId }] });
  });
});

describe("T-USR-10 one policy per seller (US5, FR-028)", () => {
  it("T-USR-10 a second active policy for the same seller is refused, naming the first", async () => {
    const l2 = await start();
    const { policyId } = await l2.onboard(ALICE);
    const res = await l2.createPolicy(ALICE, { sellers: [OTHER_HOST, SELLER_HOST] });
    expect(res.status).toBe(422);
    expect(res.body.issues).toEqual([{ field: "sellers[0]", code: "seller_conflict", host: SELLER_HOST, policyId }]);
    expect((await l2.createPolicy(ALICE, { sellers: [OTHER_HOST] })).status).toBe(201);
    // Adding the first policy's seller to the second by a change is refused the same way.
    const second = l2.entries("POLICY_CREATED")[1]!.data.policyId as string;
    const changed = await l2.portal("PUT", `/v1/users/${ALICE}/policies/${second}`, { ...policyValues({ sellers: [OTHER_HOST, SELLER_HOST] }, T0), expectedVersion: 1, identityConfirmedAtMs: T0 });
    expect(changed.body.issues).toEqual([{ field: "sellers[0]", code: "seller_conflict", host: SELLER_HOST, policyId }]);
  });

  it("T-USR-10 must-fail: with skipSellerOverlapCheck, two active policies list one seller", async () => {
    const l2 = await start({ users: { skipSellerOverlapCheck: true } });
    await l2.onboard(ALICE);
    expect((await l2.createPolicy(ALICE, { autoApproveMaxAtomic: "90000" })).status).toBe(201);
    const actives = userState(l2.ledger.entries(), ALICE).policies.filter((p) => p.state === "active" && p.values.sellers.includes(SELLER_HOST));
    expect(actives).toHaveLength(2);
  });
});

describe("T-USR-11 changes apply to the next decision (US5, FR-032, FR-036)", () => {
  it("T-USR-11 a lowered daily budget, a pause and an expiry each deny the next payment with today's rule", async () => {
    const clock = new Clock();
    const l2 = await start({ clock });
    const { policyId } = await l2.onboard(ALICE, { expiresAt: new Date(T0 + 2 * DAY).toISOString() });
    expect((await l2.authorize(l2.intentFor("/api/a", "20000", { userId: ALICE, sessionId: "s1" }))).body.status).toBe("AUTHORIZED");
    const rules = async (sessionId: string) => {
      const res = await l2.authorize(l2.intentFor("/api/b", "1000", { userId: ALICE, sessionId }));
      return res.body.status === "DENIED" ? (res.body as { violations: { rule: string }[] }).violations.map((v) => v.rule) : [res.body.status];
    };
    await l2.portal("PUT", `/v1/users/${ALICE}/policies/${policyId}`, { ...policyValues({ dailyBudgetAtomic: "20000", sessionBudgetAtomic: "20000", hardCapPerPaymentAtomic: "20000", autoApproveMaxAtomic: "10000", expiresAt: new Date(T0 + 2 * DAY).toISOString() }, T0), expectedVersion: 1 });
    expect(await rules("s2")).toEqual(["daily_budget_exceeded"]);
    expect(l2.entries("DENIED").at(-1)!.data.policyVersion).toBe(2);
    await l2.portal("POST", `/v1/users/${ALICE}/policies/${policyId}/pause`, {});
    expect(await rules("s3")).toEqual(["host_not_allowed"]);
    await l2.portal("POST", `/v1/users/${ALICE}/policies/${policyId}/resume`, { identityConfirmedAtMs: clock.now() });
    clock.advance(3 * DAY);
    expect(await rules("s4")).toEqual(["mandate_expired"]);
    const view = (await l2.portal<PolicyView>("GET", `/v1/users/${ALICE}/policies/${policyId}`)).body;
    expect([view.expired, view.displayState, view.state]).toEqual([true, "expired", "active"]);
  });

  it("T-USR-11 two policies stop at the user daily ceiling, although neither has used its own budget (US5 scenario 5)", async () => {
    const l2 = await start({ platform: testPlatform({ limits: { userDailyCeilingAtomic: "60000" } }) });
    await l2.onboard(ALICE, { dailyBudgetAtomic: "50000", sessionBudgetAtomic: "50000", hardCapPerPaymentAtomic: "20000", autoApproveMaxAtomic: "19999" });
    expect((await l2.createPolicy(ALICE, { sellers: [OTHER_HOST], dailyBudgetAtomic: "50000", sessionBudgetAtomic: "50000", hardCapPerPaymentAtomic: "20000", autoApproveMaxAtomic: "19999" })).status).toBe(201);
    const pay = (host: string, sessionId: string, amount = "15000") => l2.authorize(l2.intentFor("/api/x", amount, { userId: ALICE, host, sessionId }));
    expect((await pay(SELLER_HOST, "s1")).body.status).toBe("AUTHORIZED");
    expect((await pay(SELLER_HOST, "s2")).body.status).toBe("AUTHORIZED");
    expect((await pay(OTHER_HOST, "s3")).body.status).toBe("AUTHORIZED");
    const fourth = await pay(OTHER_HOST, "s4");
    expect(fourth.body.status).toBe("AUTHORIZED"); // 60000 exactly: at the ceiling
    expect((fourth.body as { remainingSessionBudgetAtomic: string }).remainingSessionBudgetAtomic).toBe("0");
    const over = await pay(SELLER_HOST, "s5", "1");
    expect(over.body).toMatchObject({ status: "DENIED", violations: [{ rule: "daily_budget_exceeded", detail: "60000 + 1 > 60000" }] });
  });

  it("T-USR-11 an escalation approved after the policy tightened is DENIED at payment time (INV-12)", async () => {
    const l2 = await start();
    const { policyId } = await l2.onboard(ALICE);
    const esc = await l2.authorize(l2.intentFor("/api/premium-report", "50000", { userId: ALICE }));
    expect(esc.body.status).toBe("ESCALATE");
    await l2.portal("PUT", `/v1/users/${ALICE}/policies/${policyId}`, { ...policyValues({ hardCapPerPaymentAtomic: "30000" }, T0), expectedVersion: 1 });
    expect((await l2.call("POST", `/v1/approvals/${esc.body.authorizationId}`, { token: TOKENS.operator, body: {} })).status).toBe(200);
    const res = await l2.authorize(l2.intentFor("/api/premium-report", "50000", { userId: ALICE }));
    expect(res.body).toMatchObject({ status: "DENIED", violations: [{ rule: "hard_cap_exceeded" }] });
    expect(l2.entries("AUTHORIZED")).toEqual([]);
  });

  /** Entries between a decision's INTENT and its outcome, for the serialization proof. */
  const insideDecision = (entries: readonly LedgerEntry[], intentId: string) => {
    const from = entries.findIndex((e) => e.type === "INTENT" && e.intentId === intentId);
    const to = entries.findIndex((e, i) => i > from && e.intentId === intentId);
    return types(entries.slice(from + 1, to));
  };

  it("T-USR-11 a policy change submitted during a decision is recorded after that decision's outcome (FR-036)", async () => {
    const l2 = await start({ signerLatencyMs: 60 });
    const { policyId } = await l2.onboard(ALICE);
    const intent = l2.intentFor("/api/weather", "1000", { userId: ALICE });
    const deciding = l2.authorize(intent);
    await new Promise((r) => setTimeout(r, 15));
    const changing = l2.portal("PUT", `/v1/users/${ALICE}/policies/${policyId}`, { ...policyValues({ dailyBudgetAtomic: "100000" }, T0), expectedVersion: 1 });
    const [decision] = await Promise.all([deciding, changing]);
    expect(decision.body.status).toBe("AUTHORIZED");
    expect(insideDecision(l2.ledger.entries(), intent.intentId)).toEqual([]);
    expect(l2.entries("AUTHORIZED")[0]!.data.policyVersion).toBe(1);
    expect(types(l2.ledger.entries()).slice(-3)).toEqual(["INTENT", "AUTHORIZED", "POLICY_CHANGED"]);
  });

  it("T-USR-11 must-fail: with unserializedUserWrites, the change lands inside the decision", async () => {
    const l2 = await start({ signerLatencyMs: 60, users: { unserializedUserWrites: true } });
    const { policyId } = await l2.onboard(ALICE);
    const intent = l2.intentFor("/api/weather", "1000", { userId: ALICE });
    const deciding = l2.authorize(intent);
    await new Promise((r) => setTimeout(r, 15));
    await l2.portal("PUT", `/v1/users/${ALICE}/policies/${policyId}`, { ...policyValues({ dailyBudgetAtomic: "100000" }, T0), expectedVersion: 1 });
    await deciding;
    expect(insideDecision(l2.ledger.entries(), intent.intentId)).toEqual(["POLICY_CHANGED"]);
  });
});

// ---------------------------------------------------------------------------
// US6: cards (T-USR-01, T-USR-04)
// ---------------------------------------------------------------------------

describe("T-USR-01 cards, T-USR-04 idempotency (US6, FR-019..FR-021)", () => {
  it("T-USR-01 a card is an identifier and nothing else; add and remove are idempotent", async () => {
    const l2 = await start();
    await l2.withWallet(ALICE);
    const put = (id: string) => l2.portal<{ cards: string[] }>("PUT", `/v1/users/${ALICE}/cards/${id}`);
    const del = (id: string) => l2.portal<{ cards: string[] }>("DELETE", `/v1/users/${ALICE}/cards/${id}`);
    expect((await put(CARD(1))).body).toEqual({ cards: [CARD(1)] });
    expect((await put(CARD(1))).body).toEqual({ cards: [CARD(1)] });
    expect((await put(CARD(2))).body).toEqual({ cards: [CARD(1), CARD(2)] });
    expect((await del(CARD(1))).body).toEqual({ cards: [CARD(2)] });
    expect((await del(CARD(1))).body).toEqual({ cards: [CARD(2)] });
    expect(l2.entries("CARD_ADDED").map((e) => e.data)).toEqual([{ userId: ALICE, cardId: CARD(1) }, { userId: ALICE, cardId: CARD(2) }]);
    expect(l2.entries("CARD_REMOVED").map((e) => e.data)).toEqual([{ userId: ALICE, cardId: CARD(1) }]);
  });

  it("T-USR-01 a malformed card ID is a 400; an unregistered user and a sixth card are refused", async () => {
    const l2 = await start();
    expect((await l2.portal("PUT", `/v1/users/${ALICE}/cards/pm_1Abc`)).status).toBe(400);
    expect((await l2.portal("DELETE", `/v1/users/${ALICE}/cards/4242424242424242`)).status).toBe(400);
    expect((await l2.portal("PUT", `/v1/users/${ALICE}/cards/${CARD(1)}`)).body).toEqual({ error: "not_registered" });
    await l2.withWallet(ALICE);
    for (let i = 1; i <= MAX_CARDS; i++) expect((await l2.portal("PUT", `/v1/users/${ALICE}/cards/${CARD(i)}`)).status).toBe(200);
    expect((await l2.portal("PUT", `/v1/users/${ALICE}/cards/${CARD(6)}`)).body).toEqual({ error: "card_limit" });
    // Another user's cards are their own: Bob can't remove Alice's, and his list stays empty.
    await l2.withWallet(BOB);
    expect((await l2.portal("DELETE", `/v1/users/${BOB}/cards/${CARD(1)}`)).body).toEqual({ cards: [] });
    expect((await l2.portal<UserView>("GET", `/v1/users/${ALICE}`)).body.cards).toHaveLength(5);
  });

  it("T-USR-01 a card never changes a payment decision (FR-021)", async () => {
    const l2 = await start();
    await l2.onboard(ALICE);
    await l2.portal("PUT", `/v1/users/${ALICE}/cards/${CARD(1)}`);
    const res = await l2.authorize(l2.intentFor("/api/weather", "1000", { userId: ALICE }));
    expect(res.body.status).toBe("AUTHORIZED");
    expect(JSON.stringify(l2.entries("AUTHORIZED")[0]!.data)).not.toContain("card_");
    expect((await l2.createPolicy(ALICE, { sellers: [OTHER_HOST], paymentMethod: "card" as never })).body.issues).toEqual([{ field: "paymentMethod", code: "payment_method_unsupported" }]);
  });
});

// ---------------------------------------------------------------------------
// US7: disable and enable (T-USR-01, T-USR-11)
// ---------------------------------------------------------------------------

describe("T-USR-01 the account, T-USR-11 a disabled user (US7, FR-037..FR-040)", () => {
  it("T-USR-11 disabling denies the next payment with user_disabled, and deletes nothing", async () => {
    const l2 = await start();
    const { address, policyId } = await l2.onboard(ALICE);
    await l2.portal("PUT", `/v1/users/${ALICE}/cards/${CARD(1)}`);
    expect((await l2.authorize(l2.intentFor("/api/a", "1000", { userId: ALICE }))).body.status).toBe("AUTHORIZED");
    const before = l2.ledger.entries().map((e) => e.hash);
    const off = await l2.portal<UserView>("POST", `/v1/users/${ALICE}/disable`);
    expect(off.status).toBe(200);
    expect(off.body.enabled).toBe(false);
    expect((await l2.portal("POST", `/v1/users/${ALICE}/disable`)).status).toBe(200);
    expect(l2.entries("USER_DISABLED").map((e) => e.data)).toEqual([{ userId: ALICE }]);
    const res = await l2.authorize(l2.intentFor("/api/b", "1000", { userId: ALICE }));
    expect(res.body).toMatchObject({ status: "DENIED", violations: [{ rule: "user_disabled", detail: "the user's account can't pay" }] });
    expect(l2.entries("AUTHORIZED")).toHaveLength(1);
    // Nothing was rewritten or removed, and everything is still readable, marked disabled.
    expect(l2.ledger.entries().slice(0, before.length).map((e) => e.hash)).toEqual(before);
    expect(l2.ledger.verifyChain().ok).toBe(true);
    const view = (await l2.portal<UserView>("GET", `/v1/users/${ALICE}`)).body;
    expect(view.wallet?.address).toBe(address);
    expect(view.cards).toEqual([CARD(1)]);
    expect(view.policies.map((p) => [p.policyId, p.state, p.displayState])).toEqual([[policyId, "active", "disabled"]]);
    expect((await l2.portal<PolicyView>("GET", `/v1/users/${ALICE}/policies/${policyId}`)).body.history?.map((h) => h.kind)).toEqual(["created"]);
    // The budget view reports zeros while disabled.
    expect((await l2.call("GET", `/v1/budget/sess_u?userId=${ALICE}`, { token: TOKENS.control })).body).toMatchObject({ remainingAtomic: "0", perPaymentCapAtomic: "0" });
  });

  it("T-USR-01 while disabled: no wallet, policy or card-add write; removing a card still works", async () => {
    const l2 = await start();
    const { policyId } = await l2.onboard(ALICE);
    await l2.portal("PUT", `/v1/users/${ALICE}/cards/${CARD(1)}`);
    await l2.portal("POST", `/v1/users/${ALICE}/disable`);
    const refused: Array<[string, string, unknown?]> = [
      ["POST", `/v1/users/${ALICE}/policies`, { ...policyValues({ sellers: [OTHER_HOST] }, T0), identityConfirmedAtMs: T0 }],
      ["PUT", `/v1/users/${ALICE}/policies/${policyId}`, { ...policyValues({ dailyBudgetAtomic: "100000" }, T0), expectedVersion: 1 }],
      ["POST", `/v1/users/${ALICE}/policies/${policyId}/pause`, {}],
      ["POST", `/v1/users/${ALICE}/policies/${policyId}/resume`, { identityConfirmedAtMs: T0 }],
      ["POST", `/v1/users/${ALICE}/policies/${policyId}/remove`, {}],
      ["PUT", `/v1/users/${ALICE}/cards/${CARD(2)}`],
    ];
    for (const [method, path, body] of refused) expect((await l2.portal(method, path, body)).body, `${method} ${path}`).toEqual({ error: "account_disabled" });
    expect((await l2.portal("DELETE", `/v1/users/${ALICE}/cards/${CARD(1)}`)).body).toEqual({ cards: [] });
    // A registered user with no wallet yet can't create one while disabled.
    await l2.portal("PUT", `/v1/users/${BOB}/registration`, { acknowledgedTestFunds: true });
    await l2.portal("POST", `/v1/users/${BOB}/disable`);
    expect((await l2.portal("PUT", `/v1/users/${BOB}/wallet`)).body).toEqual({ error: "account_disabled" });
    expect((await l2.portal("POST", `/v1/users/${userIdFor("dev", "nobody")}/disable`)).body).toEqual({ error: "not_registered" });
  });

  it("T-USR-01 enabling needs a fresh sign-in, pauses every active policy first, and is idempotent (FR-039)", async () => {
    const l2 = await start();
    const first = await l2.onboard(ALICE);
    const second = await l2.createPolicy(ALICE, { sellers: [OTHER_HOST] });
    await l2.portal("POST", `/v1/users/${ALICE}/policies/${second.body.policyId}/pause`, {});
    await l2.portal("POST", `/v1/users/${ALICE}/disable`);
    expect((await l2.portal("POST", `/v1/users/${ALICE}/enable`, {})).body).toEqual({ error: "step_up_required", maxAgeSec: 900 });
    expect(l2.entries("USER_ENABLED")).toEqual([]);
    const on = await l2.portal<UserView>("POST", `/v1/users/${ALICE}/enable`, { identityConfirmedAtMs: T0 });
    expect(on.status).toBe(200);
    expect(on.body.enabled).toBe(true);
    expect(on.body.policies.map((p) => p.state)).toEqual(["paused", "paused"]);
    // One POLICY_PAUSED for the policy that was active (not for the one already paused), then USER_ENABLED, contiguous.
    expect(types(l2.ledger.entries()).slice(-2)).toEqual(["POLICY_PAUSED", "USER_ENABLED"]);
    expect(l2.ledger.entries().at(-2)!.data).toEqual({ userId: ALICE, policyId: first.policyId, version: 1, cause: "account_enabled" });
    expect(l2.ledger.entries().at(-1)!.data).toEqual({ userId: ALICE, identityConfirmedAtMs: T0 });
    expect((await l2.portal("POST", `/v1/users/${ALICE}/enable`, { identityConfirmedAtMs: T0 })).status).toBe(200);
    expect(l2.entries("USER_ENABLED")).toHaveLength(1);
    // Enabling alone never restarts spending.
    const res = await l2.authorize(l2.intentFor("/api/weather", "1000", { userId: ALICE }));
    expect((res.body as { violations: { rule: string }[] }).violations.map((v) => v.rule)).toEqual(["host_not_allowed"]);
    await l2.portal("POST", `/v1/users/${ALICE}/policies/${first.policyId}/resume`, { identityConfirmedAtMs: T0 });
    expect((await l2.authorize(l2.intentFor("/api/weather", "1000", { userId: ALICE }))).body.status).toBe("AUTHORIZED");
  });

  it("T-USR-11 an escalation pending at the disable is DENIED at payment time, even once approved (US7 scenario 5)", async () => {
    const l2 = await start();
    await l2.onboard(ALICE);
    const esc = await l2.authorize(l2.intentFor("/api/premium-report", "50000", { userId: ALICE }));
    await l2.portal("POST", `/v1/users/${ALICE}/disable`);
    expect((await l2.call("POST", `/v1/approvals/${esc.body.authorizationId}`, { token: TOKENS.operator, body: {} })).status).toBe(200);
    const res = await l2.authorize(l2.intentFor("/api/premium-report", "50000", { userId: ALICE }));
    expect(res.body).toMatchObject({ status: "DENIED", violations: [{ rule: "user_disabled" }] });
    expect(l2.entries("AUTHORIZED")).toEqual([]);
  });

  it("T-USR-11 must-fail: with skipUserGate, a disabled user's payment is AUTHORIZED", async () => {
    const l2 = await start({ users: { skipUserGate: true } });
    await l2.onboard(ALICE);
    await l2.portal("POST", `/v1/users/${ALICE}/disable`);
    expect((await l2.authorize(l2.intentFor("/api/weather", "1000", { userId: ALICE }))).body.status).toBe("AUTHORIZED");
  });
});

// ---------------------------------------------------------------------------
// US8: platform bounds, audit, scale (T-USR-10, T-USR-12)
// ---------------------------------------------------------------------------

describe("T-USR-10 the platform bound (US8, FR-041..FR-043)", () => {
  /** A ledger written under the default platform, then served under a tighter one (the operator edited the file). */
  const restartUnder = async (first: UsersL2, platform: ReturnType<typeof testPlatform>, users: Parameters<typeof startUsersL2>[0] = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "x402-users-restart-"));
    const file = join(dir, "ledger-local.jsonl");
    writeFileSync(file, readFileSync(first.ledgerFile, "utf8"));
    const l2 = await start({ ledgerFile: file, platform, ...users });
    return { l2, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  };

  it("T-USR-10 a platform cap lowered after the save denies above it, and the policy is flagged", async () => {
    const first = await start();
    const { policyId } = await first.onboard(ALICE, { autoApproveMaxAtomic: "90000" });
    const { l2, cleanup } = await restartUnder(first, testPlatform({ limits: { hardCapPerPaymentAtomic: "50000" } }));
    try {
      const res = await l2.authorize(l2.intentFor("/api/x", "80000", { userId: ALICE }));
      expect(res.body).toMatchObject({ status: "DENIED", violations: [{ rule: "hard_cap_exceeded", detail: "80000 > 50000" }] });
      // The cap is now below the auto-approve limit: nothing above the cap is paid, and below it still is.
      expect((await l2.authorize(l2.intentFor("/api/y", "50000", { userId: ALICE }))).body.status).toBe("AUTHORIZED");
      const view = (await l2.portal<PolicyView>("GET", `/v1/users/${ALICE}/policies/${policyId}`)).body;
      expect(view.limitedByPlatform).toEqual(["hardCapPerPaymentAtomic"]);
      expect(view.values.hardCapPerPaymentAtomic).toBe("100000");
      expect(l2.entries("PLATFORM_CONFIG")).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  it("T-USR-10 must-fail: with skipPlatformBound, the payment above the platform cap is AUTHORIZED", async () => {
    const first = await start();
    await first.onboard(ALICE, { autoApproveMaxAtomic: "90000" });
    const { l2, cleanup } = await restartUnder(first, testPlatform({ limits: { hardCapPerPaymentAtomic: "50000" } }), { users: { skipPlatformBound: true } });
    try {
      expect((await l2.authorize(l2.intentFor("/api/x", "80000", { userId: ALICE }))).body.status).toBe("AUTHORIZED");
    } finally {
      cleanup();
    }
  });

  it("T-USR-10 a seller taken off the list denies with host_not_allowed and is flagged; a lower ceiling applies at once", async () => {
    const first = await start();
    const { policyId } = await first.onboard(ALICE);
    const { l2, cleanup } = await restartUnder(
      first,
      testPlatform({ sellers: [{ host: OTHER_HOST, name: "Second seller", payees: [] }], limits: { userDailyCeilingAtomic: "10000" } }),
    );
    try {
      const gone = await l2.authorize(l2.intentFor("/api/x", "1000", { userId: ALICE }));
      expect((gone.body as { violations: { rule: string }[] }).violations.map((v) => v.rule)).toEqual(["host_not_allowed"]);
      const view = (await l2.portal<PolicyView>("GET", `/v1/users/${ALICE}/policies/${policyId}`)).body;
      expect(view.unlistedSellers).toEqual([SELLER_HOST]);
      expect(view.limitedByPlatform).toEqual(["dailyBudgetAtomic"]);
      expect((await l2.portal<UserView>("GET", `/v1/users/${ALICE}`)).body.wallet?.dailyCeilingAtomic).toBe("10000");
    } finally {
      cleanup();
    }
  });
});

describe("013 US8 audit: the ledger alone tells who paid under which policy (SC-010, FR-044..FR-046)", () => {
  it("013 US8 every policy's history and every payment's user, policy, version, account and limits rebuild from the file", async () => {
    const l2 = await start();
    const a = await l2.onboard(ALICE);
    await l2.onboard(BOB, { sellers: [OTHER_HOST] });
    await l2.authorize(l2.intentFor("/api/a", "1000", { userId: ALICE, sessionId: "s1" }));
    await l2.portal("PUT", `/v1/users/${ALICE}/policies/${a.policyId}`, { ...policyValues({ dailyBudgetAtomic: "300000" }, T0), expectedVersion: 1 });
    await l2.authorize(l2.intentFor("/api/b", "2000", { userId: ALICE, sessionId: "s2" }));
    await l2.authorize(l2.intentFor("/api/c", "3000", { userId: BOB, sessionId: "s3", host: OTHER_HOST }));
    await l2.authorize(l2.intentFor("/api/d", "4000", { sessionId: "s4" }));

    // An auditor with nothing but the file.
    const lines = readFileSync(l2.ledgerFile, "utf8").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as LedgerEntry);
    expect(new AuditLedger(l2.ledgerFile).verifyChain().ok).toBe(true);
    let digest = "";
    const payments = lines.flatMap((e) => {
      if (e.type === "PLATFORM_CONFIG") digest = String(e.data.digest);
      return e.type === "AUTHORIZED" ? [{ user: e.data.userId, policy: e.data.policyId, version: e.data.policyVersion, payer: String(e.data.payer).toLowerCase(), amount: e.data.amount, digest }] : [];
    });
    const d = platformDigest(l2.platform);
    expect(payments).toEqual([
      { user: ALICE, policy: a.policyId, version: 1, payer: l2.keyring.addressOf(0).toLowerCase(), amount: "1000", digest: d },
      { user: ALICE, policy: a.policyId, version: 2, payer: l2.keyring.addressOf(0).toLowerCase(), amount: "2000", digest: d },
      { user: BOB, policy: expect.stringMatching(/^pol_/), version: 1, payer: l2.keyring.addressOf(1).toLowerCase(), amount: "3000", digest: d },
      { user: undefined, policy: undefined, version: undefined, payer: PLATFORM_PAYER, amount: "4000", digest: d },
    ]);
    const rebuilt = userState(lines, ALICE).policies[0]!;
    expect(rebuilt.history.map((h) => [h.kind, h.version, h.values?.dailyBudgetAtomic])).toEqual([
      ["created", 1, "500000"],
      ["changed", 2, "300000"],
    ]);
    // Users are named by identifier only: no name or email was ever sent to L2, so none can be here.
    const text = readFileSync(l2.ledgerFile, "utf8");
    expect(/alice|bob/i.test(text)).toBe(false);
    expect(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(text)).toBe(false);
  });

  it("013 US8 the operator's escalation views name the user, and only when there is one", async () => {
    const l2 = await start();
    await l2.onboard(ALICE);
    const mine = await l2.authorize(l2.intentFor("/api/premium-report", "50000", { userId: ALICE, sessionId: "s1" }));
    const platform = await l2.authorize(l2.intentFor("/api/premium-report", "50000", { sessionId: "s2" }));
    const pending = (await l2.call<{ pending: Array<Record<string, unknown>> }>("GET", "/v1/escalations", { token: TOKENS.operator })).body.pending;
    expect(pending.map((p) => [p.authorizationId, p.userId])).toEqual([
      [mine.body.authorizationId, ALICE],
      [platform.body.authorizationId, undefined],
    ]);
    expect("userId" in pending[1]!).toBe(false);
    const events = (await l2.call<{ events: Array<Record<string, unknown>> }>("GET", "/v1/escalations/events?after=-1", { token: TOKENS.operator })).body.events;
    expect(events.filter((e) => e.kind === "escalated").map((e) => e.userId)).toEqual([ALICE, undefined]);
  });
});

describe("T-USR-12 scale (NFR-010)", () => {
  it("T-USR-12 with 100 users and 10 policies each, a user decision adds under 50 ms to a platform one", async () => {
    const l2 = await start();
    const users = Array.from({ length: 100 }, (_, i) => userIdFor("dev", `user-${i}`));
    const sellers = Array.from({ length: 10 }, (_, i) => ({ host: `s${i}.example`, name: `S${i}`, payees: [] }));
    const wide = testPlatform({ sellers: [...l2.platform.sellers, ...sellers] });
    // Written straight to the ledger: 100 users, each with a wallet and 10 policies at five versions.
    users.forEach((userId, u) => {
      l2.ledger.append({ type: "USER_REGISTERED", data: { userId, acknowledgedTestFunds: true, termsVersion: TERMS_VERSION } }, T0);
      l2.ledger.append({ type: "WALLET_CREATED", data: { userId, walletIndex: u, address: l2.keyring.addressOf(u), network: CAIP2 } }, T0);
      for (let p = 0; p < 10; p++) {
        const policyId = `pol_${u}_${p}`;
        const host = p === 0 ? SELLER_HOST : sellers[p]!.host;
        l2.ledger.append({ type: "POLICY_CREATED", data: { userId, policyId, version: 1, ...policyValues({ sellers: [host] }), identityConfirmedAtMs: T0 } }, T0);
        for (let v = 2; v <= 5; v++) l2.ledger.append({ type: "POLICY_CHANGED", data: { userId, policyId, version: v, ...policyValues({ sellers: [host], dailyBudgetAtomic: String(500000 - v) }), loosened: false } }, T0);
      }
    });
    expect(l2.ledger.entries().length).toBeGreaterThan(5000);
    expect(wide.sellers.length).toBe(12);

    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const time = async (userId: string | undefined, i: number) => {
      const intent = l2.intentFor(`/api/item-${i}`, "1", { ...(userId && { userId }), sessionId: `sess_perf_${userId ?? "platform"}_${i}` });
      const t = performance.now();
      const res = await l2.authorize(intent);
      const ms = performance.now() - t;
      expect(res.body.status).toBe("AUTHORIZED");
      return ms;
    };
    const platformTimes: number[] = [];
    const userTimes: number[] = [];
    for (let i = 0; i < 50; i++) {
      platformTimes.push(await time(undefined, i));
      userTimes.push(await time(users[i * 2]!, i));
    }
    expect(median(userTimes) - median(platformTimes)).toBeLessThan(50);
  }, 120_000);
});

describe("013 US8 the operator's CLI names the user (FR-045)", () => {
  it("013 US8 escalations lines end with userId=… for a user's payment, and are unchanged for the platform account", async () => {
    const { formatEvent, formatPending } = await import("../scripts/escalations.js");
    const view = { authorizationId: "auth_1", sessionId: "s", resourceKey: "http://x/y", payTo: "0xp", amount: "50000", expiresAt: "2026-11-10T12:05:00.000Z", referenceCode: "abcd1234" };
    expect(formatPending(view)).toBe("PENDING auth_1 session=s resource=http://x/y payTo=0xp amount=50000 expiresAt=2026-11-10T12:05:00.000Z referenceCode=abcd1234");
    expect(formatPending({ ...view, userId: ALICE })).toBe(`${formatPending(view)} userId=${ALICE}`);
    const event = { kind: "escalated", authorizationId: "auth_1", sessionId: "s", resourceKey: "http://x/y", amount: "50000", expiresAt: "2026-11-10T12:05:00.000Z" };
    expect(formatEvent({ ...event, userId: ALICE })).toBe(`${formatEvent(event)} userId=${ALICE}`);
  });
});
