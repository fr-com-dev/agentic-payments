// 013 in-process L2 with user accounts on (specs/013 research R15), shared by test/users.test.ts and the portal
// tests. Real ledger on a temp file, real keyring (so each user signs with their own derived account), real routes;
// only the platform account's signer is fake. Every must-fail switch arrives as a dep, never through the environment.
import { DEV_PORTAL_CLIENT, devUserId } from "../../scripts/dev-issuer-lib.js";
import type { PersonDeps } from "../../src/layer2-control/person.js";
import { PORTAL_ADMIN_PERMISSION } from "../../src/shared/identity-token.js";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { AuditLedger, type LedgerEntry } from "../../src/layer2-control/ledger.js";
import { buildMandate, type SpendingMandate } from "../../src/layer2-control/mandate.js";
import { buildPlatform, type PlatformConfig } from "../../src/layer2-control/platform.js";
import type { AdminDeps } from "../../src/layer2-control/admin-routes.js";
import type { CallerDeps } from "../../src/layer2-control/caller.js";
import { createControlService, recordPlatformConfig, type ControlService } from "../../src/layer2-control/service.js";
import { WalletKeyring, type PaymentSignerLike } from "../../src/layer2-control/signer.js";
import type { UserAccountsDeps } from "../../src/layer2-control/users.js";
import type { AuthorizationDecision, BudgetStatus, PaymentIntent, PolicyValues } from "../../src/shared/contracts.js";
import { callerHeader, createTestIssuer, type TestIssuer } from "./caller-tokens.js";

export const CAIP2 = "eip155:31337";
export const ASSET = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
export const PAY_TO = "0xcccccccccccccccccccccccccccccccccccccccc";
export const PLATFORM_PAYER = "0x00000000000000000000000000000000000000f1";
export const SELLER_HOST = "127.0.0.1:4021";
export const OTHER_HOST = "127.0.0.1:4031";
export const UNLISTED_HOST = "127.0.0.1:4099";
export const TOKENS = { control: "u-control", settlement: "u-settlement", operator: "u-operator", portal: "u-portal", portalAdmin: "u-portal-admin" };
/** A fixed, valid 24-word phrase for tests only. Its accounts never hold anything. */
export const TEST_MNEMONIC =
  "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title";
export const T0 = Date.parse("2026-11-10T12:00:00.000Z");
/** FR-007: the step-up window, in seconds. */
export const STEP_UP_AGE = 900;

export const ALICE = devUserId("alice");
export const BOB = devUserId("bob");
/** 1.19: the administrator `admin()` calls as when a body names no decider. */
export const CAROL = devUserId("carol");

const MANDATE_JSON = {
  mandateId: "mandate-test-013",
  expiresAt: "2027-12-31T23:59:59Z",
  allowedSchemes: ["exact"],
  allowedPayees: [],
  allowedHosts: [SELLER_HOST],
  autoApproveMaxAtomic: "20000",
  hardCapPerPaymentAtomic: "100000",
  sessionBudgetAtomic: "100000",
  dailyBudgetAtomic: "500000",
  maxAuthorizationsPerMinute: 100,
  maxTimeoutSeconds: 300,
};

const PLATFORM_JSON = {
  platformId: "platform-test-013",
  limits: {
    hardCapPerPaymentAtomic: "100000",
    sessionBudgetAtomic: "100000",
    userDailyCeilingAtomic: "500000",
    maxAuthorizationsPerMinute: 100,
    maxPolicyDays: 365,
  },
  sellers: [
    { host: SELLER_HOST, name: "Local demo seller", payees: [] },
    { host: OTHER_HOST, name: "Second seller", payees: [PAY_TO] },
  ],
};

export function testPlatform(over: { limits?: Partial<PlatformConfig["limits"]>; sellers?: PlatformConfig["sellers"] } = {}): PlatformConfig {
  return buildPlatform({
    ...PLATFORM_JSON,
    limits: { ...PLATFORM_JSON.limits, ...over.limits },
    ...(over.sellers && { sellers: over.sellers }),
  });
}

/** The policy of spec.md US3: 0.02 without asking, 0.10 per payment, 0.10 per run, 0.50 per day. */
export function policyValues(over: Partial<PolicyValues> = {}, nowMs: number = T0): PolicyValues {
  return {
    sellers: [SELLER_HOST],
    autoApproveMaxAtomic: "20000",
    hardCapPerPaymentAtomic: "100000",
    sessionBudgetAtomic: "100000",
    dailyBudgetAtomic: "500000",
    maxAuthorizationsPerMinute: 10,
    expiresAt: new Date(nowMs + 30 * 86_400_000).toISOString(),
    paymentMethod: "crypto_account",
    ...over,
  };
}

/** A clock tests advance by hand; L2 reads it once per operation. */
export class Clock {
  t: number;
  constructor(start: number = T0) {
    this.t = start;
  }
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface UsersL2Options {
  clock?: Clock;
  platform?: PlatformConfig;
  mandate?: Partial<typeof MANDATE_JSON>;
  /** Must-fail switches and other overrides on the user-account deps. */
  users?: Partial<UserAccountsDeps>;
  /** User accounts off entirely (FR-001). Sign-in is then not configured either, unless `caller` is given. */
  off?: boolean;
  /**
   * 016: must-fail switches and other overrides on L2's caller deps; `false` leaves sign-in unconfigured (L2 then
   * takes no caller's token). Default: configured, with this helper's own issuer.
   */
  caller?: Partial<CallerDeps> | false;
  /** 014: the administration routes on (`true`), or on with must-fail switches. Absent: off, each is 404. */
  admin?: true | AdminDeps;
  /** 1.19: overrides (must-fail switches) on L2's check of the person's portal token. */
  person?: Partial<PersonDeps>;
  /**
   * 1.19: who signs the person's portal tokens this helper sends (`portal()`, `admin()`, `portalToken()`), when L2
   * trusts another issuer's keys than this helper's own (the portal helper's). Takes the whole `sub`.
   */
  signPortalToken?: (sub: string, o: import("./caller-tokens.js").PersonTokenOptions) => Promise<string>;
  signerLatencyMs?: number;
  /** Reuse a ledger file (restart tests). */
  ledgerFile?: string;
  mnemonic?: string;
}

export interface Reply<T = Record<string, unknown>> {
  status: number;
  body: T;
}

export interface UsersL2 {
  url: string;
  ledgerFile: string;
  ledger: AuditLedger;
  service: ControlService;
  clock: Clock;
  platform: PlatformConfig;
  keyring: WalletKeyring;
  mandate: SpendingMandate;
  /** 016: the issuer of the callers' tokens this L2 verifies. People are known to it by `sub`. */
  callers: TestIssuer;
  /**
   * Any route with any token (default: the portal's). `caller` is a caller's token to forward, as L1 does; `person`
   * (1.19) a person's portal token to forward, as the portal does.
   */
  call<T = Record<string, unknown>>(method: string, path: string, o?: { token?: string | null; body?: unknown; caller?: string; person?: string }): Promise<Reply<T>>;
  /**
   * A user-account route as the portal sends it (1.19): the portal's role token and the person's own portal token, for
   * the user the path names. A body's `identityConfirmedAtMs` (a number) becomes that token's sign-in time and is taken
   * off the body, which may no longer carry it; without one the sign-in is fresh on L2's clock.
   */
  portal<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<Reply<T>>;
  /**
   * 014: an administration route as the portal sends it: the administration role's token and (1.19) the
   * administrator's own token, with `portal:admin` and a second factor. A body's `decidedBy` (a known user) names
   * the administrator, and its `identityConfirmedAtMs` (a number) the token's sign-in and second-factor times; both
   * are taken off the body. Without them the administrator is CAROL, signed in now.
   */
  admin<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<Reply<T>>;
  /** 1.19: a person's portal token for `userId` (a known user), as the portal holds it. */
  portalToken(userId: string, o?: { authMs?: number; admin?: boolean; mfaMs?: number | null }): Promise<string>;
  /** 014: an operator route, with the operator's token. */
  operator<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<Reply<T>>;
  /** 014: how many HTTP requests this L2 has received (to prove a refusal made no call). */
  requestCount(): number;
  intentFor(path: string, amount: string, o?: { sessionId?: string; userId?: string; host?: string; payTo?: string }): PaymentIntent;
  /**
   * `POST /v1/authorize` as L1 sends it (016): the control token and a caller's token. By default the caller is the
   * person the test named with `userId` on the intent (the field is taken off the body, which may not carry it), or
   * a machine caller when it names none. `caller` overrides: a token to forward, or `null` to forward none; the
   * body then goes out exactly as given.
   */
  authorize(intent: PaymentIntent | Record<string, unknown>, o?: { caller?: string | null }): Promise<Reply<AuthorizationDecision & { error?: string }>>;
  /** `GET /v1/budget/:sessionId` as L1 sends it: for a person (`userId`), or a machine caller. */
  budget(sessionId: string, o?: { userId?: string; caller?: string | null }): Promise<Reply<BudgetStatus & { error?: string }>>;
  /** Profile registered and a crypto account created. Returns the account's address. */
  withWallet(userId: string): Promise<string>;
  /** `withWallet`, then one policy. Returns the address and the policy ID. */
  onboard(userId: string, values?: Partial<PolicyValues>): Promise<{ address: string; policyId: string }>;
  createPolicy(userId: string, values?: Partial<PolicyValues>, o?: { identityConfirmedAtMs?: number | null }): Promise<Reply>;
  entries(type?: LedgerEntry["type"]): LedgerEntry[];
  close(o?: { keepLedger?: boolean }): Promise<void>;
}

let n = 0;

export async function startUsersL2(o: UsersL2Options = {}): Promise<UsersL2> {
  const clock = o.clock ?? new Clock();
  const dir = o.ledgerFile ? undefined : mkdtempSync(join(tmpdir(), "x402-users-"));
  const ledgerFile = o.ledgerFile ?? join(dir!, "ledger-local.jsonl");
  const ledger = new AuditLedger(ledgerFile);
  const net = { caip2: CAIP2, asset: ASSET, decimals: 6 } as const;
  const platform = o.platform ?? testPlatform();
  const keyring = new WalletKeyring(o.mnemonic ?? TEST_MNEMONIC, net);
  const mandate = buildMandate({ ...MANDATE_JSON, ...o.mandate }, net, {});
  const signer: PaymentSignerLike = {
    address: PLATFORM_PAYER,
    sign: async () => ({ headers: { "PAYMENT-SIGNATURE": "opaque" }, payer: PLATFORM_PAYER, validBefore: Math.floor(clock.now() / 1000) + 120 }),
  };
  if (!o.off) recordPlatformConfig(ledger, platform, clock.now());
  const callers = await createTestIssuer();
  const signIn = o.caller === false || (o.off && o.caller === undefined) ? undefined : { ...callers.deps, ...o.caller };
  const service = createControlService({
    mandate,
    signer,
    ledger,
    asset: { address: ASSET, decimals: 6 },
    tokens: TOKENS,
    now: clock.now,
    ...(o.signerLatencyMs !== undefined && { signerLatencyMs: o.signerLatencyMs }),
    ...(!o.off && { users: { platform, keyring, ...o.users }, net }),
    ...(signIn && { caller: signIn }),
    ...(o.admin !== undefined && { admin: o.admin === true ? {} : o.admin }),
    ...(!o.off && {
      person: { issuer: callers.issuer, audience: callers.audience, portalClientId: DEV_PORTAL_CLIENT, keys: callers.deps.keys, algorithms: callers.deps.algorithms, ...o.person },
    }),
  });
  const server = await new Promise<Server>((r) => {
    const s = service.app.listen(0, "127.0.0.1", () => r(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let requests = 0;
  server.on("request", () => {
    requests++;
  });

  const call: UsersL2["call"] = async (method, path, co = {}) => {
    const token = co.token === undefined ? TOKENS.portal : co.token;
    const res = await fetch(`${url}${path}`, {
      method,
      headers: {
        ...(token !== null && { authorization: `Bearer ${token}` }),
        ...(co.caller !== undefined && callerHeader(co.caller)),
        ...(co.person !== undefined && { "x-person-authorization": `Bearer ${co.person}` }),
        ...(co.body !== undefined && { "content-type": "application/json" }),
      },
      ...(co.body !== undefined && { body: JSON.stringify(co.body) }),
    });
    const text = await res.text();
    let body: unknown = {};
    try {
      body = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    return { status: res.status, body: body as never };
  };
  const portalToken: UsersL2["portalToken"] = (userId, po = {}) => {
    const at = Math.floor((po.authMs ?? clock.now()) / 1000);
    const mfa = po.mfaMs === null ? undefined : Math.floor((po.mfaMs ?? po.authMs ?? clock.now()) / 1000);
    const claims = { azp: DEV_PORTAL_CLIENT, authTime: at, ...(po.admin && { permissions: [PORTAL_ADMIN_PERMISSION], ...(mfa !== undefined && { mfaTime: mfa }) }) };
    if (!o.signPortalToken) return callers.forUser(userId, claims);
    const sub = callers.subjectOf(userId);
    if (sub === undefined) throw new Error(`users helper: ${userId} is not a registered person`);
    return o.signPortalToken(sub, claims);
  };
  /** Takes the fields the portal no longer sends off a body, and returns them (1.19). */
  const lift = (body: unknown): { body: unknown; authMs?: number; decidedBy?: string } => {
    if (body === null || typeof body !== "object" || Array.isArray(body)) return { body };
    const { identityConfirmedAtMs, decidedBy, ...rest } = body as Record<string, unknown>;
    const out: { body: unknown; authMs?: number; decidedBy?: string } = { body: { ...rest } };
    if (typeof identityConfirmedAtMs === "number") out.authMs = identityConfirmedAtMs;
    else if (identityConfirmedAtMs !== undefined) (out.body as Record<string, unknown>).identityConfirmedAtMs = identityConfirmedAtMs;
    if (typeof decidedBy === "string" && callers.subjectOf(decidedBy) !== undefined) out.decidedBy = decidedBy;
    else if (decidedBy !== undefined) (out.body as Record<string, unknown>).decidedBy = decidedBy;
    return out;
  };
  const portal: UsersL2["portal"] = async (method, path, body) => {
    const named = /^\/v1\/users\/(usr_[0-9a-f]{32})(?:[/?]|$)/.exec(path)?.[1];
    const lifted = lift(body);
    const person = named !== undefined && callers.subjectOf(named) !== undefined ? await portalToken(named, lifted.authMs === undefined ? {} : { authMs: lifted.authMs }) : undefined;
    return call(method, path, { ...(body !== undefined && { body: lifted.body }), ...(person !== undefined && { person }) });
  };

  const requirement = (amount: string, payTo: string): PaymentRequirements =>
    ({ scheme: "exact", network: CAIP2, asset: ASSET, amount, payTo, maxTimeoutSeconds: 120, extra: { name: "USD Coin", version: "2" } }) as PaymentRequirements;

  const createPolicy: UsersL2["createPolicy"] = (userId, values = {}, po = {}) => {
    const confirmed = po.identityConfirmedAtMs === undefined ? clock.now() : po.identityConfirmedAtMs;
    return portal("POST", `/v1/users/${userId}/policies`, {
      ...policyValues(values, clock.now()),
      ...(confirmed !== null && { identityConfirmedAtMs: confirmed }),
    });
  };
  const withWallet: UsersL2["withWallet"] = async (userId) => {
    const reg = await portal("PUT", `/v1/users/${userId}/registration`, { acknowledgedTestFunds: true });
    if (reg.status !== 200) throw new Error(`registration failed: ${reg.status} ${JSON.stringify(reg.body)}`);
    const w = await portal<{ wallet?: { address: string } }>("PUT", `/v1/users/${userId}/wallet`);
    if (w.status !== 200 || !w.body.wallet) throw new Error(`wallet failed: ${w.status} ${JSON.stringify(w.body)}`);
    return w.body.wallet.address;
  };

  return {
    url,
    ledgerFile,
    ledger,
    service,
    clock,
    platform,
    keyring,
    mandate,
    call,
    portal,
    admin: async (method, path, body) => {
      const lifted = lift(body);
      const person = await portalToken(lifted.decidedBy ?? CAROL, { admin: true, ...(lifted.authMs !== undefined && { authMs: lifted.authMs }) });
      return call(method, path, { token: TOKENS.portalAdmin, person, ...(body !== undefined && { body: lifted.body }) });
    },
    portalToken,
    operator: (method, path, body) => call(method, path, { token: TOKENS.operator, ...(body !== undefined && { body }) }),
    requestCount: () => requests,
    intentFor: (path, amount, io = {}) => {
      const resourceUrl = `http://${io.host ?? SELLER_HOST}${path}`;
      return {
        intentId: `int_u_${++n}`,
        sessionId: io.sessionId ?? "sess_u",
        resourceUrl,
        paymentRequired: {
          x402Version: 2,
          resource: { url: resourceUrl, description: "", mimeType: "application/json" },
          accepts: [requirement(amount, io.payTo ?? PAY_TO)],
        } as PaymentRequired,
        purpose: "for the report",
        createdAt: new Date(clock.now()).toISOString(),
        ...(io.userId !== undefined && { userId: io.userId }),
      };
    },
    callers,
    authorize: async (intent, ao = {}) => {
      if (ao.caller !== undefined) return call("POST", "/v1/authorize", { token: TOKENS.control, body: intent, ...(ao.caller !== null && { caller: ao.caller }) });
      if (!signIn) return call("POST", "/v1/authorize", { token: TOKENS.control, body: intent });
      const { userId, ...body } = intent as Record<string, unknown>;
      // A person the test named and this issuer knows: their token, and a body that names nobody.
      if (typeof userId === "string" && callers.subjectOf(userId) !== undefined) {
        return call("POST", "/v1/authorize", { token: TOKENS.control, body, caller: await callers.forUser(userId) });
      }
      return call("POST", "/v1/authorize", { token: TOKENS.control, body: intent, caller: await callers.machine() });
    },
    budget: async (sessionId, bo = {}) => {
      const path = `/v1/budget/${encodeURIComponent(sessionId)}`;
      if (bo.caller !== undefined) return call("GET", path, { token: TOKENS.control, ...(bo.caller !== null && { caller: bo.caller }) });
      if (!signIn) return call("GET", path, { token: TOKENS.control });
      return call("GET", path, { token: TOKENS.control, caller: bo.userId !== undefined ? await callers.forUser(bo.userId) : await callers.machine() });
    },
    withWallet,
    onboard: async (userId, values = {}) => {
      const address = await withWallet(userId);
      const p = await createPolicy(userId, values);
      if (p.status !== 201) throw new Error(`policy failed: ${p.status} ${JSON.stringify(p.body)}`);
      return { address, policyId: String(p.body.policyId) };
    },
    createPolicy,
    entries: (type) => ledger.entries().filter((e) => type === undefined || e.type === type),
    close: async (co = {}) => {
      await new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      });
      if (dir && !co.keepLedger) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Entry types in order, for trail assertions. */
export const types = (entries: readonly LedgerEntry[]) => entries.map((e) => e.type);
