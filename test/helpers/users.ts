// 013 in-process L2 with user accounts on (specs/013 research R15), shared by test/users.test.ts and the portal
// tests. Real ledger on a temp file, real keyring (so each user signs with their own derived account), real routes;
// only the platform account's signer is fake. Every must-fail switch arrives as a dep, never through the environment.
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
import { createControlService, recordPlatformConfig, type ControlService } from "../../src/layer2-control/service.js";
import { WalletKeyring, type PaymentSignerLike } from "../../src/layer2-control/signer.js";
import type { UserAccountsDeps } from "../../src/layer2-control/users.js";
import type { AuthorizationDecision, PaymentIntent, PolicyValues } from "../../src/shared/contracts.js";
import { userIdFor } from "../../src/shared/user-id.js";

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

export const ALICE = userIdFor("dev", "alice");
export const BOB = userIdFor("dev", "bob");

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
  /** User accounts off entirely (FR-001). */
  off?: boolean;
  /** 014: the administration routes on (`true`), or on with must-fail switches. Absent: off, each is 404. */
  admin?: true | AdminDeps;
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
  /** Any route with any token (default: the portal's). */
  call<T = Record<string, unknown>>(method: string, path: string, o?: { token?: string | null; body?: unknown }): Promise<Reply<T>>;
  portal<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<Reply<T>>;
  /** 014: an administration route, with the administration role's token. */
  admin<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<Reply<T>>;
  /** 014: an operator route, with the operator's token. */
  operator<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<Reply<T>>;
  /** 014: how many HTTP requests this L2 has received (to prove a refusal made no call). */
  requestCount(): number;
  intentFor(path: string, amount: string, o?: { sessionId?: string; userId?: string; host?: string; payTo?: string }): PaymentIntent;
  authorize(intent: PaymentIntent | Record<string, unknown>): Promise<Reply<AuthorizationDecision & { error?: string }>>;
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
  const service = createControlService({
    mandate,
    signer,
    ledger,
    asset: { address: ASSET, decimals: 6 },
    tokens: TOKENS,
    now: clock.now,
    ...(o.signerLatencyMs !== undefined && { signerLatencyMs: o.signerLatencyMs }),
    ...(!o.off && { users: { platform, keyring, ...o.users }, net }),
    ...(o.admin !== undefined && { admin: o.admin === true ? {} : o.admin }),
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
      headers: { ...(token !== null && { authorization: `Bearer ${token}` }), ...(co.body !== undefined && { "content-type": "application/json" }) },
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
  const portal: UsersL2["portal"] = (method, path, body) => call(method, path, body === undefined ? {} : { body });

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
    admin: (method, path, body) => call(method, path, { token: TOKENS.portalAdmin, ...(body !== undefined && { body }) }),
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
    authorize: (intent) => call("POST", "/v1/authorize", { token: TOKENS.control, body: intent }),
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
