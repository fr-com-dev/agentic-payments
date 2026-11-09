// 012 in-process L2 with backchannel approval against the stand-in Auth0 (test/helpers/ciba-stub.ts), shared by the
// test/backchannel-*.test.ts files. Real CibaClient, real verification (jose against the stub's JWKS), real ledger
// on a temp file; only the signer is fake and the timing is fast (test-only deps, never env).
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { issuerKeys } from "../../src/layer2-control/approval-evidence.js";
import type { BackchannelDeps } from "../../src/layer2-control/backchannel.js";
import { CibaClient, type CibaClientOptions, type CibaPort, type CibaSettings } from "../../src/layer2-control/ciba-client.js";
import { AuditLedger, type LedgerEntry } from "../../src/layer2-control/ledger.js";
import { buildMandate, type SpendingMandate } from "../../src/layer2-control/mandate.js";
import { createControlService, type ControlService } from "../../src/layer2-control/service.js";
import type { PaymentSignerLike } from "../../src/layer2-control/signer.js";
import type { AuthorizationDecision, PaymentIntent } from "../../src/shared/contracts.js";
import { type CibaStub, startCibaStub, testRsaKeyPair, type TestRsaKeyPair } from "./ciba-stub.js";

export const APPROVER = "auth0|approver-1";
export const CLIENT_ID = "client-l2";
export const AUDIENCE = "https://x402-payments.example/";
export const CLIENT_SECRET = "client-secret-for-tests-0123456789";
export const CAIP2 = "eip155:31337";
export const ASSET = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
export const PAY_TO = "0xcccccccccccccccccccccccccccccccccccccccc";
export const SELLER = "http://127.0.0.1:4021";
export const TOKENS = { control: "b-control", settlement: "b-settlement", operator: "b-operator" };
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
  intentFor(path: string, amount: string, o?: { sessionId?: string; operatorApprovalOnly?: unknown; purpose?: string }): PaymentIntent;
  authorize(intent: PaymentIntent, o?: { signal?: AbortSignal }): Promise<{ status: number; body: AuthorizationDecision & { error?: string } }>;
  approve(id: string, body?: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }>;
  reject(id: string, body?: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }>;
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
    (await startCibaStub({ approver: APPROVER, clientId: CLIENT_ID, audience: AUDIENCE, clientPublicKeyPem: CLIENT_KEY.publicPem, clientSecret: CLIENT_SECRET, now: clock.now }));
  const dir = o.ledgerFile ? undefined : mkdtempSync(join(tmpdir(), "x402-bc-"));
  const ledgerFile = o.ledgerFile ?? join(dir!, "ledger-local.jsonl");
  const ledger = new AuditLedger(ledgerFile);
  const logs: string[] = [];
  const settings: CibaSettings = {
    issuer: stub.issuer,
    clientId: CLIENT_ID,
    audience: AUDIENCE,
    approver: APPROVER,
    credential: (o.credential ?? "key") === "key" ? { kind: "key", keyPem: key.privatePem } : { kind: "secret", secret: CLIENT_SECRET },
  };
  const deps: BackchannelDeps = {
    port: new CibaClient(settings, { allowInsecureLoopback: true, startTimeoutMs: 400, pollTimeoutMs: 400, ...o.clientOptions }),
    issuer: stub.issuer,
    clientId: CLIENT_ID,
    audience: AUDIENCE,
    approver: APPROVER,
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
  const service = createControlService({
    mandate,
    signer,
    ledger,
    asset: { address: ASSET, decimals: 6 },
    tokens: TOKENS,
    now: clock.now,
    ...(o.off !== true && { backchannel: deps }),
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
    intentFor: (path, amount, io = {}) => {
      const resourceUrl = `${SELLER}${path}`;
      return {
        intentId: `int_bc_${++n}`,
        sessionId: io.sessionId ?? "sess_bc",
        resourceUrl,
        paymentRequired: { x402Version: 2, resource: { url: resourceUrl, description: "", mimeType: "application/json" }, accepts: [requirement(amount)] } as PaymentRequired,
        purpose: io.purpose ?? "for the report",
        createdAt: new Date(clock.now()).toISOString(),
        ...(io.operatorApprovalOnly !== undefined && { operatorApprovalOnly: io.operatorApprovalOnly as boolean }),
      };
    },
    authorize: (intent, ao = {}) => call("POST", "/v1/authorize", TOKENS.control, intent, ao.signal),
    approve: (id, body = {}) => call("POST", `/v1/approvals/${id}`, TOKENS.operator, body),
    reject: (id, body = {}) => call("POST", `/v1/rejections/${id}`, TOKENS.operator, body),
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
