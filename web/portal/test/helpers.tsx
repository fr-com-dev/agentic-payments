// A fake portal API and sign-in for the web app's tests (specs/013 contracts/portal-ui.md "Tests"). The fake keeps a
// small world in memory and answers like the portal does; every method is a spy, so a test can count calls or make
// one call fail.
import { cleanup, render, type RenderResult } from "@testing-library/react";
import { afterEach, vi, type Mock } from "vitest";
import type { Api, ApiError, ApiResult } from "../src/api.js";
import { App } from "../src/app.js";
import type { Auth } from "../src/auth/types.js";
import type { CardFieldsFactory } from "../src/components/AddCard.js";
import { parseUsdcInput } from "../src/money.js";
import type { Account, Card, Config, Me, Platform, Policy, PolicyInput, PolicyValues, Wallet } from "../src/types.js";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

export const SELLER = { host: "127.0.0.1:4021", name: "Local demo seller" };
export const SELLER_2 = { host: "api.example.test", name: "Example data" };
export const ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

export const CONFIG: Config = { auth: { mode: "entra", tenantId: "t", clientId: "c", scope: "api://x/Portal.Access" }, network: "eip155:31337", cards: { available: true, publishableKey: "pk_test_x" } };

export const platform = (over: Partial<Platform> = {}): Platform => ({
  limits: { hardCapPerPaymentAtomic: "100000", sessionBudgetAtomic: "100000", userDailyCeilingAtomic: "500000", maxAuthorizationsPerMinute: 10, maxPolicyDays: 730 },
  sellers: [SELLER, SELLER_2],
  network: "eip155:31337",
  asset: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  decimals: 6,
  ...over,
});

export const account = (over: Partial<Account> = {}): Account => ({
  address: ADDRESS,
  network: "eip155:31337",
  asset: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  decimals: 6,
  balanceAtomic: "0",
  balanceReadAt: "2026-11-10T12:00:00.000Z",
  balanceStale: false,
  committedAtomic: "0",
  spent24hAtomic: "0",
  dailyCeilingAtomic: "500000",
  dailyRemainingAtomic: "500000",
  lowBalance: false,
  ...over,
});

export const card = (n: number, over: Partial<Card> = {}): Card => ({
  cardId: `pm_${n}`,
  brand: "visa",
  last4: String(4242 + n).slice(-4),
  expMonth: 12,
  expYear: 2030,
  addedAt: "2026-11-10T12:00:00.000Z",
  expired: false,
  ...over,
});

/** The example of contracts/portal-ui.md "Policy editor". */
export const EXAMPLE_VALUES: PolicyValues = {
  sellers: [SELLER.host],
  autoApproveMaxAtomic: "20000",
  hardCapPerPaymentAtomic: "100000",
  sessionBudgetAtomic: "100000",
  dailyBudgetAtomic: "500000",
  maxAuthorizationsPerMinute: 10,
  expiresAt: "2027-12-31T23:59:59.999Z",
  paymentMethod: "crypto_account",
};

export const policy = (id: string, over: Partial<Policy> = {}): Policy => ({
  policyId: id,
  name: `Policy ${id}`,
  version: 1,
  values: EXAMPLE_VALUES,
  state: "active",
  displayState: "active",
  expired: false,
  limitedByPlatform: [],
  unlistedSellers: [],
  updatedAt: "2026-11-10T12:00:00.000Z",
  ...over,
});

export interface World {
  me: Me;
  wallet: Wallet;
  policies: Policy[];
  platform: Platform;
}

const ME_NEW: Me = { userId: "usr_deeee4478bc01dab1b0afa3fbe31f010", enabled: true, onboarding: { profile: false, wallet: false, policy: false } };

/** A person at a stage of onboarding: `new`, `profile` (profile saved), `wallet` (account created) or `done`. */
export function world(stage: "new" | "profile" | "wallet" | "done" = "done", over: Partial<World> = {}): World {
  const reached = { profile: stage !== "new", wallet: stage === "wallet" || stage === "done", policy: stage === "done" };
  return {
    me: { ...ME_NEW, onboarding: reached, ...(reached.profile && { profile: { displayName: "Alice", contactEmail: "alice@example.test" } }) },
    wallet: { ...(reached.wallet && { account: account() }), cards: [], cardsAvailable: true, disabled: false },
    policies: reached.policy ? [policy("pol_1", { name: "Daily data" })] : [],
    platform: platform(),
    ...over,
  };
}

const ok = <T,>(data: T): ApiResult<T> => ({ ok: true, data });
export const refuse = (status: number, error: string, more: Partial<ApiError> = {}): ApiError => ({ ok: false, status, error, ...more });

function valuesOf(input: PolicyInput): PolicyValues {
  const atomic = (text: string) => parseUsdcInput(text, 6) as string;
  return {
    sellers: input.sellers,
    autoApproveMaxAtomic: atomic(input.autoApproveUsdc),
    hardCapPerPaymentAtomic: atomic(input.perPaymentUsdc),
    sessionBudgetAtomic: atomic(input.perRunUsdc),
    dailyBudgetAtomic: atomic(input.perDayUsdc),
    maxAuthorizationsPerMinute: input.paymentsPerMinute,
    expiresAt: `${input.endsOn}T23:59:59.999Z`,
    paymentMethod: "crypto_account",
  };
}

export type FakeApi = { [K in keyof Api]: Mock<Api[K]> };

export function fakeApi(w: World): FakeApi {
  const find = (id: string) => w.policies.find((p) => p.policyId === id);
  const setState = (id: string, state: Policy["state"]) => {
    const p = find(id);
    if (!p) return refuse(404, "not found");
    const next = { ...p, state, displayState: state, version: p.version };
    w.policies = w.policies.map((x) => (x.policyId === id ? next : x));
    return ok(next);
  };
  const api: Api = {
    config: async () => ok(CONFIG),
    me: async () => ok(w.me),
    saveProfile: async (input) => {
      w.me = { ...w.me, profile: { displayName: input.displayName, contactEmail: input.contactEmail }, onboarding: { ...w.me.onboarding, profile: true } };
      return ok(w.me);
    },
    platform: async () => ok(w.platform),
    wallet: async () => ok(w.wallet),
    createAccount: async () => {
      w.wallet = { ...w.wallet, account: w.wallet.account ?? account() };
      w.me = { ...w.me, onboarding: { ...w.me.onboarding, wallet: true } };
      return ok(w.wallet);
    },
    cardSetup: async () => ok({ clientSecret: "seti_1_secret_test" }),
    confirmCard: async (_setupIntentId, nickname) => {
      const added = card(w.wallet.cards.length + 1, { ...(nickname !== undefined && nickname !== "" && { nickname }) });
      w.wallet = { ...w.wallet, cards: [...w.wallet.cards, added] };
      return ok(added);
    },
    removeCard: async (cardId) => {
      w.wallet = { ...w.wallet, cards: w.wallet.cards.filter((c) => c.cardId !== cardId) };
      return ok({ cards: w.wallet.cards });
    },
    policies: async () => ok({ policies: w.policies }),
    policy: async (id) => {
      const p = find(id);
      return p ? ok({ ...p, history: p.history ?? [{ seq: 1, ts: p.updatedAt, kind: "created", version: 1, values: p.values }] }) : refuse(404, "not found");
    },
    createPolicy: async (input) => {
      const created = policy(`pol_${w.policies.length + 1}`, { name: input.name, values: valuesOf(input) });
      w.policies = [created, ...w.policies];
      w.me = { ...w.me, onboarding: { ...w.me.onboarding, policy: true } };
      return ok(created);
    },
    changePolicy: async (id, input) => {
      const p = find(id);
      if (!p) return refuse(404, "not found");
      const next = { ...p, name: input.name, values: valuesOf(input), version: p.version + 1 };
      w.policies = w.policies.map((x) => (x.policyId === id ? next : x));
      return ok(next);
    },
    pausePolicy: async (id) => setState(id, "paused"),
    resumePolicy: async (id) => setState(id, "active"),
    removePolicy: async (id) => setState(id, "removed"),
    disableAccount: async () => {
      w.me = { ...w.me, enabled: false };
      w.wallet = { ...w.wallet, disabled: true };
      w.policies = w.policies.map((p) => (p.state === "removed" ? p : { ...p, displayState: "disabled" }));
      return ok(w.me);
    },
    enableAccount: async () => {
      w.me = { ...w.me, enabled: true };
      w.wallet = { ...w.wallet, disabled: false };
      w.policies = w.policies.map((p) => (p.state === "removed" ? p : { ...p, state: "paused", displayState: "paused" }));
      return ok(w.me);
    },
  };
  return Object.fromEntries(Object.entries(api).map(([k, fn]) => [k, vi.fn(fn as (...a: never[]) => unknown)])) as unknown as FakeApi;
}

export type FakeAuth = Auth & { confirmIdentity: Mock<Auth["confirmIdentity"]>; signIn: Mock<Auth["signIn"]>; signOut: Mock<Auth["signOut"]> };

export function fakeAuth(over: { signedIn?: boolean; mode?: "entra" | "dev" } = {}): FakeAuth {
  let signedIn = over.signedIn ?? true;
  return {
    mode: over.mode ?? "entra",
    signedIn: () => signedIn,
    account: () => ({ name: "Alice Example", email: "alice@example.test" }),
    signIn: vi.fn(async () => {
      signedIn = true;
      return true;
    }),
    token: async () => (signedIn ? "token" : null),
    confirmIdentity: vi.fn(async () => true),
    signOut: vi.fn(async () => {
      signedIn = false;
    }),
  };
}

/** The card vault's fields, faked: nothing a person types into them is ever given to the app. */
export const fakeCardFields: CardFieldsFactory = async () => ({
  mount: (el) => {
    el.textContent = "[the card vault's own fields]";
  },
  confirm: async () => ({ setupIntentId: "seti_1" }),
  destroy: () => undefined,
});

export interface Rendered extends RenderResult {
  api: FakeApi;
  auth: FakeAuth;
  world: World;
}

/** Renders the whole app at a path, as a signed-in person in the given world. */
export function renderApp(path: string, w: World = world(), o: { auth?: FakeAuth; api?: FakeApi } = {}): Rendered {
  window.history.replaceState(null, "", path);
  const api = o.api ?? fakeApi(w);
  const auth = o.auth ?? fakeAuth();
  const view = render(<App api={api} auth={auth} config={CONFIG} cardFields={fakeCardFields} />);
  return Object.assign(view, { api, auth, world: w });
}
