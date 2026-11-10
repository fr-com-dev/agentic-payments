// Feature 013: registered cards (SPEC.md §8.2 L2-8, §11 SEC-22; specs/013 contracts/card-vault.md). T-CARD-01..06.
// The portal runs against the stand-in card vault (test/helpers/card-vault-stub.ts), which records every request.
// Cards are saved and removed, never charged: no test here could even ask for a charge, because no route exists.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { API_BASE, API_VERSION, CARD_NICKNAME_MAX, CardVault, CardVaultConfigError, CardVaultError, cardVaultFromEnv } from "../src/portal/card-vault.js";
import { cardExpired, MAX_CARDS, validNickname } from "../src/portal/cards.js";
import { loadPortalConfig } from "../src/portal/config.js";
import { startCardVaultStub, VAULT_MESSAGE, type CardVaultStub, type StubCard } from "./helpers/card-vault-stub.js";
import { startPortal, TEST_PUBLISHABLE_KEY, TEST_VAULT_KEY, type PortalTestApp, type StartPortalOptions } from "./helpers/portal.js";
import { SELLER_HOST, T0 } from "./helpers/users.js";

let portals: PortalTestApp[] = [];
let stubs: CardVaultStub[] = [];
afterEach(async () => {
  await Promise.all(portals.map((p) => p.close()));
  await Promise.all(stubs.map((s) => s.close()));
  portals = [];
  stubs = [];
});

async function start(o: StartPortalOptions = {}) {
  const vault = await startCardVaultStub();
  stubs.push(vault);
  const p = await startPortal({ vault, ...o });
  portals.push(p);
  return { p, vault };
}

const PROFILE = { displayName: "Ana Pérez", contactEmail: "ana.perez@example.com", acknowledgedTestFunds: true };
const CARD_ID = /^card_[0-9a-f-]{36}$/;

/** A person with a profile (cards need nothing more). */
async function withProfile(p: PortalTestApp, subject = "alice") {
  const me = p.as(subject);
  expect((await me("PUT", "/api/profile", PROFILE)).status).toBe(200);
  return me;
}

/** The whole add: setup at the portal, the "browser" confirms at the vault, then the portal confirms. */
async function addCard(p: PortalTestApp, vault: CardVaultStub, subject: string, card: StubCard = {}, nickname?: string) {
  const me = p.as(subject);
  const setup = await me<{ clientSecret: string }>("POST", "/api/cards/setup");
  if (setup.status !== 200) return { setup, confirm: undefined, setupIntentId: "" };
  const setupIntentId = setup.body.clientSecret.split("_secret_")[0]!;
  vault.confirm(setupIntentId, card);
  const confirm = await me("POST", "/api/cards", { setupIntentId, ...(nickname !== undefined && { nickname }) });
  return { setup, confirm, setupIntentId };
}

// ---------------------------------------------------------------------------
// T-CARD-01: configuration
// ---------------------------------------------------------------------------

describe("T-CARD-01 configuration: test keys only (FR-018, SEC-22)", () => {
  it("T-CARD-01 unset: cards are off; stripe with test keys: on", () => {
    expect(cardVaultFromEnv({})).toBeUndefined();
    expect(cardVaultFromEnv({ CARD_VAULT: "" })).toBeUndefined();
    for (const key of ["rk_test_abc", "sk_test_abc"]) {
      expect(cardVaultFromEnv({ CARD_VAULT: "stripe", CARD_VAULT_KEY: key, CARD_VAULT_PUBLISHABLE_KEY: "pk_test_abc" })).toEqual({ key, publishableKey: "pk_test_abc" });
    }
  });

  it("T-CARD-01 a live key, a missing key or another vault refuses startup, naming the variable and never the value", () => {
    const base = { CARD_VAULT: "stripe", CARD_VAULT_KEY: "rk_test_abc", CARD_VAULT_PUBLISHABLE_KEY: "pk_test_abc" };
    const bad: Array<[Record<string, string>, RegExp]> = [
      [{ ...base, CARD_VAULT_KEY: "sk_live_SECRETLIVEKEY" }, /CARD_VAULT_KEY must be a test key/],
      [{ ...base, CARD_VAULT_KEY: "rk_live_SECRETLIVEKEY" }, /CARD_VAULT_KEY must be a test key/],
      [{ ...base, CARD_VAULT_KEY: "SECRETLIVEKEY" }, /CARD_VAULT_KEY must be a test key/],
      [{ ...base, CARD_VAULT_KEY: "" }, /missing CARD_VAULT_KEY/],
      [{ ...base, CARD_VAULT_PUBLISHABLE_KEY: "pk_live_SECRETLIVEKEY" }, /CARD_VAULT_PUBLISHABLE_KEY must be a test key/],
      [{ ...base, CARD_VAULT_PUBLISHABLE_KEY: "" }, /missing CARD_VAULT_PUBLISHABLE_KEY/],
      [{ ...base, CARD_VAULT: "adyen" }, /CARD_VAULT must be "stripe" or unset/],
    ];
    for (const [env, message] of bad) {
      let text = "";
      try {
        cardVaultFromEnv(env);
      } catch (e) {
        expect(e).toBeInstanceOf(CardVaultConfigError);
        text = (e as Error).message;
      }
      expect(text, JSON.stringify(env)).toMatch(message);
      expect(text).not.toContain("SECRETLIVEKEY");
    }
    // The portal's config loader refuses the same way.
    const dev = { NETWORK: "local", AUTH_TENANT_ID: "dev", AUTH_AUDIENCE: "api://x402-l1-agent", PORTAL_CLIENT_ID: "x402-portal-dev", AUTH_JWKS_FILE: "jwks.json" };
    expect(() => loadPortalConfig({ ...dev, ...base, CARD_VAULT_KEY: "sk_live_SECRETLIVEKEY" })).toThrow(/CARD_VAULT_KEY must be a test key/);
  });

  it("T-CARD-01 the vault address and version are constants, not configuration", () => {
    expect(API_BASE).toBe("https://api.stripe.com");
    expect(API_VERSION).toBe("2026-10-28.endive");
  });

  it("T-CARD-01 with cards off, the wallet says so and every card route answers 503 cards_unavailable", async () => {
    const p = await startPortal();
    portals.push(p);
    const me = await withProfile(p);
    expect((await p.call("GET", "/api/config")).body.cards).toEqual({ available: false });
    expect((await me("GET", "/api/wallet")).body).toMatchObject({ cards: [], cardsAvailable: false });
    for (const [method, path, body] of [
      ["POST", "/api/cards/setup", undefined],
      ["POST", "/api/cards", { setupIntentId: "seti_x" }],
      ["DELETE", "/api/cards/card_00000000-0000-4000-8000-000000000001", undefined],
    ] as const) {
      expect((await me(method, path, body)).body, path).toEqual({ error: "cards_unavailable" });
    }
  });
});

// ---------------------------------------------------------------------------
// T-CARD-02: adding a card
// ---------------------------------------------------------------------------

describe("T-CARD-02 adding a card (US6, FR-018..FR-021)", () => {
  it("T-CARD-02 the happy path: the wallet lists brand, last four, expiry and nickname; the ledger holds an identifier only", async () => {
    const { p, vault } = await start();
    await withProfile(p);
    expect((await p.call("GET", "/api/config")).body.cards).toEqual({ available: true, publishableKey: TEST_PUBLISHABLE_KEY });
    const { setup, confirm } = await addCard(p, vault, "alice", { brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 }, "  Travel card  ");
    expect(setup.status).toBe(200);
    expect(Object.keys(setup.body)).toEqual(["clientSecret"]);
    expect(confirm!.status).toBe(201);
    const card = confirm!.body as Record<string, unknown>;
    expect(card).toEqual({ cardId: expect.stringMatching(CARD_ID), brand: "visa", last4: "4242", expMonth: 12, expYear: 2030, nickname: "Travel card", addedAt: expect.any(String), expired: false });
    // The ledger: one entry, with the user and the opaque identifier and nothing else (FR-044).
    expect(p.l2.entries("CARD_ADDED").map((e) => e.data)).toEqual([{ userId: p.userId("alice"), cardId: card.cardId }]);
    const wallet = await p.as("alice")("GET", "/api/wallet");
    expect(wallet.body).toMatchObject({ cardsAvailable: true, cards: [card] });
    // Nothing the browser gets names the vault's own identifiers or the fingerprint.
    expect(wallet.text + confirm!.text).not.toMatch(/pm_stub|cus_stub|fp_|fingerprint|seti_/);
  });

  it("T-CARD-02 each check adds no card, with its status, and detaches what the vault had saved", async () => {
    const { p, vault } = await start();
    const me = await withProfile(p);
    const fresh = async () => (await me<{ clientSecret: string }>("POST", "/api/cards/setup")).body.clientSecret.split("_secret_")[0]!;

    // Not confirmed in the browser yet.
    const pending = await fresh();
    expect((await me("POST", "/api/cards", { setupIntentId: pending })).body).toEqual({ error: "card_not_confirmed" });
    // The vault refused the card: the whitelisted code is passed on, never the vault's text.
    const declined = await fresh();
    vault.fail(declined, "card_declined");
    const refused = await me("POST", "/api/cards", { setupIntentId: declined });
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: "card_not_confirmed", vaultCode: "card_declined" });
    const odd = await fresh();
    vault.fail(odd, "some_new_vault_code");
    expect((await me("POST", "/api/cards", { setupIntentId: odd })).body).toEqual({ error: "card_not_confirmed", vaultCode: "other" });
    // Not a card.
    const bank = await fresh();
    vault.confirmNonCard(bank);
    expect((await me("POST", "/api/cards", { setupIntentId: bank })).body).toEqual({ error: "not_a_card" });
    // Already expired (October 2026, on a clock in November 2026).
    const old = await fresh();
    vault.confirm(old, { expMonth: 10, expYear: 2026 });
    const expired = await me("POST", "/api/cards", { setupIntentId: old });
    expect([expired.status, expired.body]).toEqual([422, { error: "card_expired" }]);
    // Unknown, and malformed.
    expect((await me("POST", "/api/cards", { setupIntentId: "seti_unknown" })).status).toBe(404);
    for (const body of [{}, { setupIntentId: 7 }, { setupIntentId: "pm_123" }, { setupIntentId: pending, extra: 1 }, { setupIntentId: pending, nickname: "x".repeat(CARD_NICKNAME_MAX + 1) }]) {
      expect((await me("POST", "/api/cards", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(vault.attached()).toEqual([]);
    expect(p.l2.entries("CARD_ADDED")).toEqual([]);
    expect((await me("GET", "/api/wallet")).body.cards).toEqual([]);
  });

  it("T-CARD-02 another person's setup intent answers like an unknown one (FR-004)", async () => {
    const { p, vault } = await start();
    await withProfile(p, "alice");
    const bob = await withProfile(p, "bob");
    const alices = (await p.as("alice")<{ clientSecret: string }>("POST", "/api/cards/setup")).body.clientSecret.split("_secret_")[0]!;
    vault.confirm(alices);
    // Bob has no customer yet, then has one: either way Alice's setup is not his.
    expect((await bob("POST", "/api/cards", { setupIntentId: alices })).status).toBe(404);
    await bob("POST", "/api/cards/setup");
    const res = await bob("POST", "/api/cards", { setupIntentId: alices });
    expect([res.status, res.body]).toEqual([404, { error: "not found" }]);
    expect(p.l2.entries("CARD_ADDED")).toEqual([]);
    // Alice can still finish it.
    expect((await p.as("alice")("POST", "/api/cards", { setupIntentId: alices })).status).toBe(201);
  });

  it("T-CARD-02 an answer from live mode is refused: nothing is added", async () => {
    const { p, vault } = await start();
    const me = await withProfile(p);
    vault.setMode({ kind: "live" });
    const res = await me("POST", "/api/cards/setup");
    expect([res.status, res.body]).toEqual([503, { error: "card_vault_unavailable" }]);
    expect(p.logs.at(-1)).toMatchObject({ route: "/api/cards/setup", status: 503, event: "card_vault_live_mode" });
  });

  it("T-CARD-02 confirming the same setup twice returns the same card and records it once", async () => {
    const { p, vault } = await start();
    await withProfile(p);
    const { confirm, setupIntentId } = await addCard(p, vault, "alice");
    const again = await p.as("alice")("POST", "/api/cards", { setupIntentId });
    expect(again.body.cardId).toBe(confirm!.body.cardId);
    expect(p.l2.entries("CARD_ADDED")).toHaveLength(1);
    expect(vault.attached()).toHaveLength(1);
  });

  it("T-CARD-02 the field rules: nicknames and expiry", () => {
    expect(validNickname(undefined)).toBeUndefined();
    expect(validNickname("  ")).toBeUndefined();
    expect(validNickname(" Travel ")).toBe("Travel");
    expect([validNickname(7), validNickname("x".repeat(41)), validNickname("a\u0000b")]).toEqual([null, null, null]);
    // A card is valid through the end of its expiry month.
    expect(cardExpired({ expMonth: 11, expYear: 2026 }, T0)).toBe(false);
    expect(cardExpired({ expMonth: 10, expYear: 2026 }, T0)).toBe(true);
    expect(cardExpired({ expMonth: 12, expYear: 2025 }, T0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-CARD-03: duplicates and the limit
// ---------------------------------------------------------------------------

describe("T-CARD-03 duplicates and the five-card limit (FR-019)", () => {
  it("T-CARD-03 the same card again is refused and the newcomer is detached", async () => {
    const { p, vault } = await start();
    await withProfile(p);
    expect((await addCard(p, vault, "alice", { last4: "4242", fingerprint: "fp_same" })).confirm!.status).toBe(201);
    const dup = await addCard(p, vault, "alice", { last4: "4242", fingerprint: "fp_same" });
    expect([dup.confirm!.status, dup.confirm!.body]).toEqual([409, { error: "card_already_registered" }]);
    expect(vault.attached()).toHaveLength(1);
    expect(p.l2.entries("CARD_ADDED")).toHaveLength(1);
    // The same card in another person's wallet is theirs to add.
    await withProfile(p, "bob");
    expect((await addCard(p, vault, "bob", { last4: "4242", fingerprint: "fp_same" })).confirm!.status).toBe(201);
  });

  it("T-CARD-03 a sixth card is refused before a setup starts, and L2 refuses it too", async () => {
    const { p, vault } = await start();
    const me = await withProfile(p);
    for (let i = 1; i <= MAX_CARDS; i++) expect((await addCard(p, vault, "alice", { last4: `000${i}`, fingerprint: `fp_${i}` })).confirm!.status).toBe(201);
    const setups = vault.requests.filter((r) => r.path === "/v1/setup_intents").length;
    expect((await me("POST", "/api/cards/setup")).body).toEqual({ error: "card_limit" });
    expect(vault.requests.filter((r) => r.path === "/v1/setup_intents").length).toBe(setups);
    expect((await me<{ cards: unknown[] }>("GET", "/api/wallet")).body.cards).toHaveLength(5);
    expect(p.l2.entries("CARD_ADDED")).toHaveLength(5);
  });

  it("T-CARD-03 a setup started before the limit was reached can't push the wallet over it", async () => {
    const { p, vault } = await start();
    const me = await withProfile(p);
    const early = (await me<{ clientSecret: string }>("POST", "/api/cards/setup")).body.clientSecret.split("_secret_")[0]!;
    for (let i = 1; i <= MAX_CARDS; i++) await addCard(p, vault, "alice", { last4: `000${i}`, fingerprint: `fp_${i}` });
    vault.confirm(early, { last4: "9999", fingerprint: "fp_late" });
    expect((await me("POST", "/api/cards", { setupIntentId: early })).body).toEqual({ error: "card_limit" });
    expect(vault.attached()).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// T-CARD-04: list, reconcile, remove
// ---------------------------------------------------------------------------

describe("T-CARD-04 list, reconcile and remove (FR-020, FR-022, research R8)", () => {
  it("T-CARD-04 remove detaches at the vault, then records CARD_REMOVED; an unknown or another person's card is 404", async () => {
    const { p, vault } = await start();
    const me = await withProfile(p);
    const added = await addCard(p, vault, "alice");
    const cardId = String(added.confirm!.body.cardId);
    await withProfile(p, "bob");
    expect((await p.as("bob")("DELETE", `/api/cards/${cardId}`)).status).toBe(404);
    expect((await me("DELETE", "/api/cards/card_00000000-0000-4000-8000-000000000009")).status).toBe(404);
    expect(vault.attached()).toHaveLength(1);
    const res = await me("DELETE", `/api/cards/${cardId}`);
    expect([res.status, res.body]).toEqual([200, { cards: [] }]);
    expect(vault.attached()).toEqual([]);
    expect(p.l2.entries("CARD_REMOVED").map((e) => e.data)).toEqual([{ userId: p.userId("alice"), cardId }]);
    expect((await me("DELETE", `/api/cards/${cardId}`)).status).toBe(404);
  });

  it("T-CARD-04 an expired card is flagged in the wallet", async () => {
    const { p, vault } = await start();
    const me = await withProfile(p);
    await addCard(p, vault, "alice", { expMonth: 12, expYear: 2026 });
    expect((await me<{ cards: Array<{ expired: boolean }> }>("GET", "/api/wallet")).body.cards[0]!.expired).toBe(false);
    p.l2.clock.advance(60 * 86_400_000); // January 2027
    expect((await me<{ cards: Array<{ expired: boolean }> }>("GET", "/api/wallet")).body.cards[0]!.expired).toBe(true);
  });

  it("T-CARD-04 a card saved at the vault without its identifier (an interrupted add) is detached on the next list", async () => {
    const { p, vault } = await start();
    const me = await withProfile(p);
    await addCard(p, vault, "alice");
    const stray = vault.addUnlabeled(vault.customers()[0]!, { last4: "1111", fingerprint: "fp_stray" });
    expect(vault.attached()).toContain(stray);
    const wallet = await me<{ cards: Array<{ last4: string }> }>("GET", "/api/wallet");
    expect(wallet.body.cards.map((c) => c.last4)).toEqual(["4242"]);
    expect(vault.attached()).not.toContain(stray);
  });

  it("T-CARD-04 a card removed at the vault outside the portal is recorded as removed on the next list", async () => {
    const { p, vault } = await start();
    const me = await withProfile(p);
    const added = await addCard(p, vault, "alice");
    vault.detachOutside(vault.attached()[0]!);
    expect((await me<{ cards: unknown[] }>("GET", "/api/wallet")).body.cards).toEqual([]);
    expect(p.l2.entries("CARD_REMOVED").map((e) => e.data.cardId)).toEqual([added.confirm!.body.cardId]);
  });

  it("T-CARD-04 if L2 refuses to record an add, the card is detached: never a card without its entry", async () => {
    const { p, vault } = await start();
    const me = await withProfile(p);
    const setupIntentId = (await me<{ clientSecret: string }>("POST", "/api/cards/setup")).body.clientSecret.split("_secret_")[0]!;
    vault.confirm(setupIntentId);
    // The account is disabled between the setup and the confirm: L2 answers 409 account_disabled.
    await me("POST", "/api/account/disable", { confirm: true });
    const res = await me("POST", "/api/cards", { setupIntentId });
    expect([res.status, res.body]).toEqual([409, { error: "account_disabled" }]);
    expect(vault.attached()).toEqual([]);
    expect(p.l2.entries("CARD_ADDED")).toEqual([]);
    // And a disabled account can't start a setup at all.
    expect((await me("POST", "/api/cards/setup")).body).toEqual({ error: "account_disabled" });
  });

  it("T-CARD-04 a registered card stays removable while the account is disabled (FR-038)", async () => {
    const { p, vault } = await start();
    const me = await withProfile(p);
    const cardId = String((await addCard(p, vault, "alice")).confirm!.body.cardId);
    await me("POST", "/api/account/disable", { confirm: true });
    expect((await me("GET", "/api/wallet")).body).toMatchObject({ disabled: true, cards: [{ cardId }] });
    expect((await me("DELETE", `/api/cards/${cardId}`)).status).toBe(200);
    expect(vault.attached()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T-CARD-05: the vault fails
// ---------------------------------------------------------------------------

describe("T-CARD-05 a failing vault affects cards only (NFR-005, US6 scenario 5)", () => {
  const modes: Array<[string, Parameters<CardVaultStub["setMode"]>[0], string]> = [
    ["down", { kind: "down" }, "card_vault_unavailable"],
    ["slow", { kind: "slow", ms: 900 }, "card_vault_unavailable"],
    ["401", { kind: "status", status: 401, times: 9 }, "card_vault_auth"],
    ["429", { kind: "status", status: 429, times: 9 }, "card_vault_unavailable"],
    ["500", { kind: "status", status: 500, times: 9 }, "card_vault_unavailable"],
  ];
  for (const [name, mode, event] of modes) {
    it(`T-CARD-05 vault ${name}: card routes answer 503, and profile, wallet and policy routes still work`, async () => {
      const { p, vault } = await start();
      const me = await withProfile(p);
      await me("PUT", "/api/wallet/account");
      vault.setMode(mode);
      const res = await me("POST", "/api/cards/setup");
      expect([res.status, res.body], name).toEqual([503, { error: "card_vault_unavailable" }]);
      expect(p.logs.at(-1)).toMatchObject({ status: 503, event });
      expect(res.text).not.toContain(VAULT_MESSAGE);
      // Everything else answers as usual. The wallet shows, without a card list.
      expect((await me("GET", "/api/me")).status).toBe(200);
      expect((await me("PUT", "/api/profile", { displayName: "Ana", contactEmail: "ana@example.com" })).status).toBe(200);
      expect((await me("GET", "/api/policies")).status).toBe(200);
      expect((await me("GET", "/api/platform")).status).toBe(200);
      const wallet = await me("GET", "/api/wallet");
      expect(wallet.status).toBe(200);
      expect(wallet.body).toMatchObject({ account: { address: p.l2.keyring.addressOf(0) } });
      // And a payment decision never waits on the vault.
      const policy = await p.l2.createPolicy(p.userId("alice"));
      expect(policy.status).toBe(201);
      expect((await p.l2.authorize(p.l2.intentFor("/api/weather", "1000", { userId: p.userId("alice") }))).body.status).toBe("AUTHORIZED");
    }, 30_000);
  }

  it("T-CARD-05 a wallet whose card list can't be read still shows the account, with cards marked unavailable", async () => {
    const { p, vault } = await start();
    const me = await withProfile(p);
    await me("PUT", "/api/wallet/account");
    await addCard(p, vault, "alice");
    vault.setMode({ kind: "down" });
    const wallet = await me("GET", "/api/wallet");
    expect(wallet.status).toBe(200);
    expect(wallet.body).toMatchObject({ cards: [], cardsAvailable: false, account: { address: p.l2.keyring.addressOf(0) } });
  });

  it("T-CARD-05 one transient failure is retried once with the same idempotency key, then succeeds", async () => {
    const { p, vault } = await start();
    const me = await withProfile(p);
    vault.setMode({ kind: "status", status: 500, times: 1 });
    expect((await me("POST", "/api/cards/setup")).status).toBe(200);
    const posts = vault.requests.filter((r) => r.path === "/v1/customers");
    expect(posts).toHaveLength(2);
    expect(posts[0]!.headers["idempotency-key"]).toBeDefined();
    expect(posts[1]!.headers["idempotency-key"]).toBe(posts[0]!.headers["idempotency-key"]);
  });

  it("T-CARD-05 the client classifies failures and keeps only whitelisted codes", async () => {
    const vault = await startCardVaultStub();
    stubs.push(vault);
    const client = new CardVault({ key: TEST_VAULT_KEY, publishableKey: TEST_PUBLISHABLE_KEY }, { baseUrl: vault.baseUrl, timeoutMs: 300 });
    const kind = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        return "ok";
      } catch (e) {
        expect(e).toBeInstanceOf(CardVaultError);
        expect((e as Error).message).not.toContain(VAULT_MESSAGE);
        return (e as CardVaultError).kind;
      }
    };
    expect(await kind(() => client.getSetupIntent("seti_missing"))).toBe("not_found");
    expect(await kind(() => client.detach("pm_missing"))).toBe("not_found");
    vault.setMode({ kind: "status", status: 403, times: 1 });
    expect(await kind(() => client.createCustomer("usr_x"))).toBe("auth");
    vault.setMode({ kind: "down" });
    expect(await kind(() => client.createCustomer("usr_x"))).toBe("unavailable");
    // A wrong key: the stand-in answers 401, as the real vault would.
    const wrong = new CardVault({ key: "rk_live_never", publishableKey: TEST_PUBLISHABLE_KEY }, { baseUrl: vault.baseUrl });
    vault.setMode({ kind: "ok" });
    expect(await kind(() => wrong.createCustomer("usr_x"))).toBe("auth");
  });
});

// ---------------------------------------------------------------------------
// T-CARD-06: what is sent, and what never appears
// ---------------------------------------------------------------------------

describe("T-CARD-06 what the vault is sent, and what never appears anywhere (SEC-22, NFR-003)", () => {
  it("T-CARD-06 only the six calls, with the pinned version, a bearer key, form bodies and idempotency keys on POSTs", async () => {
    const { p, vault } = await start();
    const me = await withProfile(p);
    const added = await addCard(p, vault, "alice", {}, "Travel");
    await me("GET", "/api/wallet");
    await me("DELETE", `/api/cards/${String(added.confirm!.body.cardId)}`);
    const calls = vault.requests.map((r) => `${r.method} ${r.path.replace(/(cus|seti|pm)_stub_\d+/g, "{id}")}`);
    expect(new Set(calls)).toEqual(
      new Set([
        "POST /v1/customers",
        "POST /v1/setup_intents",
        "GET /v1/setup_intents/{id}",
        "GET /v1/customers/{id}/payment_methods",
        "POST /v1/payment_methods/{id}",
        "POST /v1/payment_methods/{id}/detach",
      ]),
    );
    for (const r of vault.requests) {
      expect(r.headers.authorization, r.path).toBe(`Bearer ${TEST_VAULT_KEY}`);
      expect(r.headers["stripe-version"], r.path).toBe("2026-10-28.endive");
      if (r.method === "POST") {
        expect(r.headers["content-type"], r.path).toBe("application/x-www-form-urlencoded");
        expect(r.headers["idempotency-key"], r.path).toMatch(/^[0-9a-f-]{36}$/);
      }
      // Never a charge, a payment intent, a refund or a payout.
      expect(r.path).not.toMatch(/charge|payment_intent|refund|payout|transfer/);
    }
  });

  it("T-CARD-06 nothing but the listed fields is sent: no name, email, amount, seller, policy or account address", async () => {
    const { p, vault } = await start();
    const me = await withProfile(p);
    await me("PUT", "/api/wallet/account");
    await p.l2.createPolicy(p.userId("alice"));
    await addCard(p, vault, "alice", {}, "Travel");
    const customer = vault.requests.find((r) => r.path === "/v1/customers")!;
    expect(customer.form).toEqual({ "metadata[x402_user_id]": p.userId("alice") });
    const setup = vault.requests.find((r) => r.path === "/v1/setup_intents")!;
    expect(setup.form).toEqual({ customer: expect.stringMatching(/^cus_stub_/), "allowed_payment_method_types[]": "card", usage: "off_session", "metadata[x402_user_id]": p.userId("alice") });
    expect("payment_method_types" in setup.form).toBe(false);
    const label = vault.requests.find((r) => /^\/v1\/payment_methods\/[^/]+$/.test(r.path))!;
    expect(label.form).toEqual({ "metadata[x402_card_id]": expect.stringMatching(CARD_ID), "metadata[nickname]": "Travel" });
    const retrieve = vault.requests.find((r) => r.method === "GET" && r.path.startsWith("/v1/setup_intents/"))!;
    expect(retrieve.query).toEqual({ "expand[]": ["payment_method"] });
    const list = vault.requests.find((r) => r.path.endsWith("/payment_methods"))!;
    expect(list.query).toEqual({ type: ["card"], limit: ["100"] });
    const everything = JSON.stringify(vault.requests.map((r) => [r.path, r.query, r.form]));
    for (const text of ["Ana", "ana.perez", "example.com", SELLER_HOST, p.l2.keyring.addressOf(0), "20000", "500000", "pol_"]) {
      expect(everything.includes(text), text).toBe(false);
    }
  });

  it("T-CARD-06 a known-value scan: no key, client secret, fingerprint, vault identifier or vault text in logs, responses or the ledger", async () => {
    const { p, vault } = await start();
    const me = await withProfile(p);
    const setups: string[] = [];
    const others: string[] = [];
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await me(method, path, body);
      (path === "/api/cards/setup" ? setups : others).push(res.text);
      return res;
    };
    const setup = await call("POST", "/api/cards/setup");
    const clientSecret = String(setup.body.clientSecret);
    const setupIntentId = clientSecret.split("_secret_")[0]!;
    vault.confirm(setupIntentId, { fingerprint: "fp_SCANMEFINGERPRINT", last4: "4242" });
    const added = await call("POST", "/api/cards", { setupIntentId });
    await call("GET", "/api/wallet");
    await call("POST", "/api/cards", { setupIntentId: "seti_unknown" });
    const failing = (await call("POST", "/api/cards/setup")).body.clientSecret as string;
    vault.fail(failing.split("_secret_")[0]!, "card_declined");
    await call("POST", "/api/cards", { setupIntentId: failing.split("_secret_")[0]! });
    await call("DELETE", `/api/cards/${String(added.body.cardId)}`);

    const logs = p.rawLogs.join("\n");
    const ledger = readFileSync(p.l2.ledgerFile, "utf8");
    // A client secret is returned once, by the setup route that created it, and appears nowhere else.
    for (const [name, text] of [["logs", logs], ["ledger", ledger], ["every other response", others.join("\n")]] as const) {
      for (const secret of [TEST_VAULT_KEY, clientSecret, "CLIENTSECRET", "fp_SCANMEFINGERPRINT", "pm_stub_", "cus_stub_", VAULT_MESSAGE]) {
        expect(text.includes(secret), `${name}: ${secret}`).toBe(false);
      }
    }
    expect(setups).toHaveLength(2);
    for (const text of setups) for (const secret of [TEST_VAULT_KEY, "fp_", "pm_stub_", "cus_stub_", VAULT_MESSAGE]) expect(text.includes(secret), secret).toBe(false);
    // The ledger knows cards by identifier only: no brand, digits or expiry (FR-044). The card entries are checked
    // field by field: scanning the whole file for the digits would also match a hash or an identifier by chance.
    expect(/visa|exp_/i.test(ledger)).toBe(false);
    const cardEntries = ledger
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> })
      .filter((e) => e.type === "CARD_ADDED" || e.type === "CARD_REMOVED");
    expect(cardEntries.map((e) => e.type)).toEqual(["CARD_ADDED", "CARD_REMOVED"]);
    for (const e of cardEntries) {
      expect(Object.keys(e.data).sort()).toEqual(["cardId", "userId"]);
      expect(e.data.cardId).toBe(String(added.body.cardId));
    }
  });
});
