// 012 in-process L2 with backchannel approval against the stand-in Auth0 (test/helpers/ciba-stub.ts), shared by the
// test/backchannel-*.test.ts files. Real CibaClient, real verification (jose against the stub's JWKS), real ledger
// on a temp file; only the platform account's signer is fake and the timing is fast (test-only deps, never env).
// 015 (research R17): user accounts are always on, and two people, alice and bob, are onboarded before the helper
// returns. Their identifiers are made from the stand-in's own issuer, so L2's identity check passes for them as it
// would with one tenant. An intent is alice's unless a test says otherwise, and a person's payment is signed with
// that person's own account (a real keyring), never the fake platform signer.
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import type { AdminDeps } from "../../src/layer2-control/admin-routes.js";
import { issuerKeys } from "../../src/layer2-control/approval-evidence.js";
import type { BackchannelDeps } from "../../src/layer2-control/backchannel.js";
import { CibaClient, type CibaClientOptions, type CibaPort, type CibaSettings } from "../../src/layer2-control/ciba-client.js";
import { AuditLedger, type LedgerEntry } from "../../src/layer2-control/ledger.js";
import { buildMandate, type SpendingMandate } from "../../src/layer2-control/mandate.js";
import { createControlService, recordPlatformConfig, type ControlService } from "../../src/layer2-control/service.js";
import { WalletKeyring, type PaymentSignerLike } from "../../src/layer2-control/signer.js";
import type { AuthorizationDecision, PaymentIntent, PolicyValues, UserView } from "../../src/shared/contracts.js";
import { userIdFor } from "../../src/shared/user-id.js";
import { type CibaStub, startCibaStub, testRsaKeyPair, type TestRsaKeyPair } from "./ciba-stub.js";
import { TEST_MNEMONIC, testPlatform } from "./users.js";

/** 015: the two people's subjects at the stand-in approval service (the `sub` of their sign-in tokens). */
export const ALICE_SUB = "auth0|alice-1";
export const BOB_SUB = "auth0|bob-1";
export const CLIENT_ID = "client-l2";
export const AUDIENCE = "https://x402-payments.example/";
export const CLIENT_SECRET = "client-secret-for-tests-0123456789";
export const CAIP2 = "eip155:31337";
export const ASSET = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
export const PAY_TO = "0xcccccccccccccccccccccccccccccccccccccccc";
export const SELLER = "http://127.0.0.1:4021";
export const TOKENS = { control: "b-control", settlement: "b-settlement", operator: "b-operator", portal: "b-portal", portalAdmin: "b-portal-admin" };
/** One client key for the whole run; restart tests reuse it (a different key cannot open sealed handles). */
export const CLIENT_KEY: TestRsaKeyPair = testRsaKeyPair();

const MANDATE_JSON = {
  mandateId: "mandate-test-012",
  expiresAt: "2027-12-31T23:59:59Z",
  allowedSchemes: ["exact"],
  allowedPayees: [],
  allowedHosts: ["127.0.0.1:4021"],
  autoApproveMaxAtomic: "20000",
  hardCapPerPaymentAtomic: "100000",
  sessionBudgetAtomic: "100000",
  dailyBudgetAtomic: "500000",
  maxAuthorizationsPerMinute: 100,
  maxTimeoutSeconds: 300,
};

/**
 * 015: each person's one policy. Its values equal MANDATE_JSON's, so every amount T-CIBA-01..14 use gets the
 * decision the platform account gave it: up to 20000 is auto-approved (1000, 5000, 20000), 30000, 50000 and 60000
 * escalate, and three payments of 20000 beside a pending 50000 exceed the 100000 run budget.
 */
const personPolicy = (nowMs: number): PolicyValues => ({
  sellers: [new URL(SELLER).host],
  autoApproveMaxAtomic: MANDATE_JSON.autoApproveMaxAtomic,
  hardCapPerPaymentAtomic: MANDATE_JSON.hardCapPerPaymentAtomic,
  sessionBudgetAtomic: MANDATE_JSON.sessionBudgetAtomic,
  dailyBudgetAtomic: MANDATE_JSON.dailyBudgetAtomic,
  maxAuthorizationsPerMinute: MANDATE_JSON.maxAuthorizationsPerMinute,
  expiresAt: new Date(nowMs + 30 * 86_400_000).toISOString(),
  paymentMethod: "crypto_account",
});

export interface Person {
  /** `userIdFor(<the stand-in's issuer>, subject)`: what the ledger and every view call them. */
  userId: string;
  /** Their subject at the approval service. It travels on the intent and is written nowhere. */
  subject: string;
  /** Their own crypto account, which signs their payments. */
  address: string;
}

/** A clock both L2 and the stub read: real time plus an offset tests can advance. */
export class TestClock {
  offsetMs = 0;
  now = (): number => Date.now() + this.offsetMs;
  advance(ms: number): void {
    this.offsetMs += ms;
  }
}

export interface BackchannelL2Options {
  clock?: TestClock;
  /** Overrides on the backchannel deps (waitMs, pollDelayMs, retryDelaysMs, cap, skipChecks, serializeOutcomes, log). */
  backchannel?: Partial<BackchannelDeps>;
  /** No backchannel at all (the feature off). */
  off?: boolean;
  credential?: "key" | "secret";
  /** A different client key (rotation tests). Default CLIENT_KEY. */
  clientKey?: TestRsaKeyPair;
  /** Reuse a stub and a ledger file (restart tests). */
  stub?: CibaStub;
  ledgerFile?: string;
  mandate?: Partial<typeof MANDATE_JSON>;
  signer?: PaymentSignerLike;
  /** Overrides on the CibaClient options (default: 400 ms timeouts). */
  clientOptions?: Partial<CibaClientOptions>;
  /**
   * 014: the portal's administration routes on (`true`, or with must-fail switches), so a test can decide from the
   * portal's path beside the phone and the operator. Absent: off. User accounts are on either way (015).
   */
  admin?: true | AdminDeps;
}

export interface BackchannelL2 {
  url: string;
  ledgerFile: string;
  ledger: AuditLedger;
  stub: CibaStub;
  service: ControlService;
  /** The CibaClient L2 uses (to open sealed handles in tests). */
  port: CibaPort;
  logs: string[];
  clock: TestClock;
  /** 015: the two onboarded people. */
  people: { alice: Person; bob: Person };
  /**
   * 015: onboards one more user (profile, crypto account, the same policy) under the identifier a test gives, for
   * people who are not `userIdFor(<the stand-in's issuer>, subject)`. Returns their account's address.
   */
  onboardUser(userId: string): Promise<string>;
  /**
   * `as` (015, default `"alice"`): a person's intent carries their `userId` and `approvalSubject`; `"platform"`
   * carries neither, as the scripted agent, the command-line agent and a system identity's run send it.
   */
  intentFor(
    path: string,
    amount: string,
    o?: { sessionId?: string; operatorApprovalOnly?: unknown; purpose?: string; as?: "alice" | "bob" | "platform" },
  ): PaymentIntent;
  authorize(intent: PaymentIntent, o?: { signal?: AbortSignal }): Promise<{ status: number; body: AuthorizationDecision & { error?: string } }>;
  approve(id: string, body?: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }>;
  reject(id: string, body?: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }>;
  /** 014: an administration route, with the administration role's token (needs the `admin` option). */
  admin(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
  /** 015: a user-account route, with the portal role's token. */
  portal(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
  pending(): Promise<{ pending: Record<string, unknown>[]; cursor: number }>;
  events(after?: number): Promise<{ events: Record<string, unknown>[]; cursor: number }>;
  budget(sessionId: string): Promise<{ status: number; body: Record<string, unknown> }>;
  reconcile(report: unknown): Promise<{ status: number }>;
  /** Entries whose escalationId (data or envelope) or intentId matches. */
  trail(o: { escalationId?: string; intentId?: string }): LedgerEntry[];
  /** Resolves once `pred` holds over the ledger, or throws after `ms`. */
  until(pred: (entries: readonly LedgerEntry[]) => boolean, ms?: number): Promise<void>;
  /** Stops the backchannel and the server. Keeps the stub unless `closeStub`, and the ledger file if `keepLedger`. */
  close(o?: { closeStub?: boolean; keepLedger?: boolean }): Promise<void>;
}

let n = 0;

export async function startBackchannelL2(o: BackchannelL2Options = {}): Promise<BackchannelL2> {
  const clock = o.clock ?? new TestClock();
  const key = o.clientKey ?? CLIENT_KEY;
  const stub =
    o.stub ??
    (await startCibaStub({ clientId: CLIENT_ID, audience: AUDIENCE, clientPublicKeyPem: CLIENT_KEY.publicPem, clientSecret: CLIENT_SECRET, now: clock.now }));
  const dir = o.ledgerFile ? undefined : mkdtempSync(join(tmpdir(), "x402-bc-"));
  const ledgerFile = o.ledgerFile ?? join(dir!, "ledger-local.jsonl");
  const ledger = new AuditLedger(ledgerFile);
  const logs: string[] = [];
  const settings: CibaSettings = {
    issuer: stub.issuer,
    clientId: CLIENT_ID,
    audience: AUDIENCE,
    credential: (o.credential ?? "key") === "key" ? { kind: "key", keyPem: key.privatePem } : { kind: "secret", secret: CLIENT_SECRET },
  };
  const deps: BackchannelDeps = {
    port: new CibaClient(settings, { allowInsecureLoopback: true, startTimeoutMs: 400, pollTimeoutMs: 400, ...o.clientOptions }),
    issuer: stub.issuer,
    clientId: CLIENT_ID,
    audience: AUDIENCE,
    keys: issuerKeys(stub.issuer, { allowInsecureLoopback: true }),
    decimals: 6,
    waitMs: 1500,
    pollDelayMs: (s) => s * 20,
    retryDelaysMs: [10, 20],
    log: (line) => logs.push(line),
    ...o.backchannel,
  };
  const signer: PaymentSignerLike = o.signer ?? {
    address: "0x00000000000000000000000000000000000000f1",
    sign: async () => ({ headers: { "PAYMENT-SIGNATURE": "opaque" }, payer: "0x00000000000000000000000000000000000000f1", validBefore: Math.floor(clock.now() / 1000) + 120 }),
  };
  const mandate: SpendingMandate = buildMandate({ ...MANDATE_JSON, ...o.mandate }, { caip2: CAIP2, asset: ASSET }, {});
  const platform = testPlatform();
  recordPlatformConfig(ledger, platform, clock.now());
  const service = createControlService({
    mandate,
    signer,
    ledger,
    asset: { address: ASSET, decimals: 6 },
    tokens: TOKENS,
    now: clock.now,
    ...(o.off !== true && { backchannel: deps }),
    users: { platform, keyring: new WalletKeyring(TEST_MNEMONIC, { caip2: CAIP2, asset: ASSET }) },
    net: { caip2: CAIP2, asset: ASSET, decimals: 6 },
    ...(o.admin !== undefined && { admin: o.admin === true ? {} : o.admin }),
  });
  const server = await new Promise<Server>((r) => {
    const s = service.app.listen(0, "127.0.0.1", () => r(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, token: string, body?: unknown, signal?: AbortSignal) => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { "content-type": "application/json" }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      ...(signal && { signal }),
    });
    return { status: res.status, body: (await res.json()) as never };
  };

  /** Profile, crypto account and one policy, through L2's own user-account routes. A restart on the same ledger adds nothing. */
  const onboardUser = async (userId: string): Promise<string> => {
    const portal = async (method: string, path: string, body?: unknown) => {
      const r = (await call(method, path, TOKENS.portal, body)) as { status: number; body: unknown };
      if (r.status !== 200 && r.status !== 201) throw new Error(`onboarding ${method} ${path} failed: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body as UserView;
    };
    let view = await portal("GET", `/v1/users/${userId}`);
    if (!view.onboarding.profile) await portal("PUT", `/v1/users/${userId}/registration`, { acknowledgedTestFunds: true });
    if (!view.onboarding.wallet) view = await portal("PUT", `/v1/users/${userId}/wallet`);
    if (!view.onboarding.policy) await portal("POST", `/v1/users/${userId}/policies`, { ...personPolicy(clock.now()), identityConfirmedAtMs: clock.now() });
    return view.wallet!.address;
  };
  const onboard = async (subject: string): Promise<Person> => {
    const userId = userIdFor(stub.issuer, subject);
    return { userId, subject, address: await onboardUser(userId) };
  };
  const people = { alice: await onboard(ALICE_SUB), bob: await onboard(BOB_SUB) };

  const requirement = (amount: string): PaymentRequirements =>
    ({ scheme: "exact", network: CAIP2, asset: ASSET, amount, payTo: PAY_TO, maxTimeoutSeconds: 120, extra: { name: "USD Coin", version: "2" } }) as PaymentRequirements;

  return {
    url,
    ledgerFile,
    ledger,
    stub,
    service,
    port: deps.port,
    logs,
    clock,
    people,
    onboardUser,
    intentFor: (path, amount, io = {}) => {
      const resourceUrl = `${SELLER}${path}`;
      const person = io.as === "platform" ? undefined : people[io.as ?? "alice"];
      return {
        intentId: `int_bc_${++n}`,
        sessionId: io.sessionId ?? "sess_bc",
        resourceUrl,
        paymentRequired: { x402Version: 2, resource: { url: resourceUrl, description: "", mimeType: "application/json" }, accepts: [requirement(amount)] } as PaymentRequired,
        purpose: io.purpose ?? "for the report",
        createdAt: new Date(clock.now()).toISOString(),
        ...(io.operatorApprovalOnly !== undefined && { operatorApprovalOnly: io.operatorApprovalOnly as boolean }),
        ...(person && { userId: person.userId, approvalSubject: person.subject }),
      };
    },
    authorize: (intent, ao = {}) => call("POST", "/v1/authorize", TOKENS.control, intent, ao.signal),
    approve: (id, body = {}) => call("POST", `/v1/approvals/${id}`, TOKENS.operator, body),
    reject: (id, body = {}) => call("POST", `/v1/rejections/${id}`, TOKENS.operator, body),
    admin: (method, path, body) => call(method, path, TOKENS.portalAdmin, body),
    portal: (method, path, body) => call(method, path, TOKENS.portal, body),
    pending: async () => (await call("GET", "/v1/escalations", TOKENS.operator)).body,
    events: async (after = -1) => (await call("GET", `/v1/escalations/events?after=${after}`, TOKENS.operator)).body,
    budget: (sessionId) => call("GET", `/v1/budget/${sessionId}`, TOKENS.control),
    reconcile: async (report) => ({ status: (await call("POST", "/v1/reconcile", TOKENS.settlement, report)).status }),
    trail: ({ escalationId, intentId }) =>
      ledger
        .entries()
        .filter(
          (e) =>
            (escalationId !== undefined && (e.authorizationId === escalationId || e.data.escalationId === escalationId)) ||
            (intentId !== undefined && e.intentId === intentId),
        ),
    until: async (pred, ms = 3000) => {
      const end = Date.now() + ms;
      while (!pred(ledger.entries())) {
        if (Date.now() > end) throw new Error("until: condition not met in time");
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    close: async (co = {}) => {
      service.backchannel?.stop();
      await new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      });
      if (co.closeStub) await stub.close();
      if (dir && !co.keepLedger) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Entry types in order, for trail assertions. */
export const types = (entries: readonly LedgerEntry[]) => entries.map((e) => e.type);
