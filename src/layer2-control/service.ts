// L2 Control HTTP service (SPEC.md §8.2 L2-5). Owner of the bootstrap, authorize and budget: feature 002.
// Reconcile and ledger-verify routes come from ./ledger-routes.ts (003); approvals and rejections from
// ./approval-routes.ts (004, 010); escalation reads from ./escalation-routes.ts (010); Swagger UI from
// ./api-docs.ts (v1.4, only with API_DOCS=1).
// INV-8: the whole authorize body (INTENT → decide → sign → outcome entry) runs in one serialized section.
// 012 (L2-7): with backchannel approval on, a new eligible escalation starts an approval request and the call waits
// up to 120 s outside the section; if the escalation reaches approved or denied meanwhile, a second serialized
// decision (a new INTENT for the same intentId) is returned instead of ESCALATE.
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import express, { type Express } from "express";
import type { PaymentRequirements } from "@x402/core/types";
import { requireRole } from "../shared/auth.js";
import { apiDocsEnabled, CONTROL_BIND_HOST, controlPort, loadEnv, networkProfile } from "../shared/config.js";
import type { AuthorizationDecision, BudgetStatus, PaymentIntent, PolicyViolation } from "../shared/contracts.js";
import { mountApiDocs } from "./api-docs.js";
import { issuerKeys } from "./approval-evidence.js";
import { mountApprovalRoutes } from "./approval-routes.js";
import { Backchannel, type BackchannelDeps, type StartPlan } from "./backchannel.js";
import { CibaClient, cibaConfigFromEnv, publicSettings } from "./ciba-client.js";
import { mountEscalationRoutes } from "./escalation-routes.js";
import { ESCALATION_TTL_MS, findPendingEscalation, findRejection, sweep } from "./escalations.js";
import { AuditLedger, resourceKey } from "./ledger.js";
import { acquireLedgerLock } from "./ledger-lock.js";
import { mountLedgerRoutes, type Serialize } from "./ledger-routes.js";
import { loadMandate, type SpendingMandate } from "./mandate.js";
import { decide, type PolicyContext } from "./policy.js";
import { PaymentSigner, type PaymentSignerLike } from "./signer.js";

export interface ControlServiceDeps {
  mandate: SpendingMandate;
  signer: PaymentSignerLike;
  ledger: AuditLedger;
  /** Asset and decimals reported by /v1/budget. */
  asset: { address: string; decimals: number };
  /** Test hook (T-E2E-04): simulated remote-signer latency, applied inside the serialized section. */
  signerLatencyMs?: number;
  /** Test hook: explicit tokens instead of resolving them from the environment. */
  tokens?: { control?: string; settlement?: string; operator?: string };
  /** Test hook: clock. Read once per authorize call. */
  now?: () => number;
  /**
   * Test hook (010 must-fail proof): `false` restores v1.2, where every ESCALATE writes a new ESCALATED
   * even while one is pending for the same purchase. Default true (FR-005).
   */
  dedupePendingEscalations?: boolean;
  /** v1.4: mounts the token-free Swagger UI routes (`API_DOCS=1` in main()). Default false (SEC-13). */
  apiDocs?: boolean;
  /** 012 (L2-7): backchannel approval through the approval service. Absent: off, behavior as in v1.7. */
  backchannel?: BackchannelDeps;
}

export interface ControlService {
  app: Express;
  serialize: Serialize;
  /** 010: runs the escalation sweep (L2-4.3) inside the serialized section at `now()`. */
  sweep: () => Promise<unknown>;
  /** 012: present when backchannel approval is on (resume after a restart, stop on shutdown). */
  backchannel?: Backchannel;
}

const DAY_MS = 86_400_000;
/** 010: escalation sweep period in main(); with a 1 s watch poll, events surface in about 2 s (FR-017, FR-021). */
const SWEEP_INTERVAL_MS = 1_000;
const SIGNER_DETAIL_MAX = 300;

/** Promise-chain mutex. Every caller runs after the previous one settles, success or failure. */
export function createSerializer(): Serialize {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => T | Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

function isHttpUrl(s: unknown): s is string {
  if (typeof s !== "string") return false;
  try {
    const p = new URL(s).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}

/** 400 checks (L2-5): ids present, accepts is an array, resourceUrl is http(s). */
function validIntent(body: unknown): body is PaymentIntent {
  if (body === null || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  const pr = b.paymentRequired as Record<string, unknown> | undefined;
  return (
    typeof b.intentId === "string" &&
    b.intentId.length > 0 &&
    typeof b.sessionId === "string" &&
    b.sessionId.length > 0 &&
    isHttpUrl(b.resourceUrl) &&
    pr !== null &&
    typeof pr === "object" &&
    Array.isArray(pr.accepts) &&
    // 012 FR-007: optional, boolean only.
    (b.operatorApprovalOnly === undefined || typeof b.operatorApprovalOnly === "boolean")
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const maxZero = (n: bigint) => (n < 0n ? 0n : n);

export function createControlService(deps: ControlServiceDeps): ControlService {
  const { mandate, signer, ledger } = deps;
  const now = deps.now ?? Date.now;
  const dedupePending = deps.dedupePendingEscalations ?? true;
  const serialize = createSerializer();
  const app = express();
  const tok = (t?: string) => (t === undefined ? {} : { token: t });

  const remainingFor = (sessionId: string, t: number) =>
    maxZero(BigInt(mandate.sessionBudgetAtomic) - ledger.committedAtomic({ sessionId }, t));
  const backchannel = deps.backchannel ? new Backchannel({ ...deps.backchannel, ledger, serialize, now }) : undefined;

  type Decided = { decision: AuthorizationDecision; start?: StartPlan };

  /**
   * One serialized decision (L2-5 steps 1–6). `reevaluationOf` marks the second decision after a wait (012): its
   * INTENT carries the escalation ID, and it never starts an approval request.
   */
  async function decideOnce(intent: PaymentIntent, opts: { reevaluationOf?: string } = {}): Promise<Decided> {
    // Step 1: one clock read; INTENT before deciding.
    const t = now();
    // 010: record due expiries and lapses first, so the decision sees current escalation states.
    sweep(ledger, t);
    const authorizationId = `auth_${randomUUID()}`;
    const { intentId, sessionId } = intent;
    const key = resourceKey(intent.resourceUrl);
    const accepts = intent.paymentRequired.accepts as PaymentRequirements[];
    ledger.append(
      {
        type: "INTENT",
        sessionId,
        intentId,
        data: {
          resourceUrl: intent.resourceUrl,
          purpose: String(intent.purpose ?? ""),
          accepts,
          ...(opts.reevaluationOf !== undefined && { reevaluationOf: opts.reevaluationOf }),
        },
      },
      t,
    );

    // Step 2: open approval for (session, resourceKey), most recent wins (L2-4.2).
    const approval = ledger.findOpenApproval(sessionId, key, t);
    const approvalData = approval?.data as { payTo: string; amount: string; approvalId: string } | undefined;
    // 010: an operator rejection for (session, resourceKey) feeds R15.
    const rejection = findRejection(ledger.entries(), sessionId, key);

    // Step 3: ledger-derived context (INV-7).
    const ctx: PolicyContext = {
      nowMs: t,
      requestedUrl: intent.resourceUrl,
      challengeResourceUrl: String(intent.paymentRequired.resource?.url ?? ""),
      sessionCommittedAtomic: ledger.committedAtomic({ sessionId }, t),
      dailyCommittedAtomic: ledger.committedAtomic({ sinceMs: t - DAY_MS }, t),
      authorizationsLastMinute: ledger.authorizedSince(t - 60_000),
      ...(approvalData && {
        humanApprovedFor: { payTo: approvalData.payTo, amount: approvalData.amount, approvalId: approvalData.approvalId },
      }),
      ...(rejection && { humanRejected: { rejectionId: rejection.data.rejectionId as string } }),
    };

    // Step 4: pure decision.
    const d = decide(accepts, mandate, ctx);
    const base = { authorizationId, intentId };
    const deny = (violations: PolicyViolation[]): Decided => {
      ledger.append({ type: "DENIED", sessionId, intentId, authorizationId, data: { violations, resourceKey: key } }, t);
      return { decision: { status: "DENIED", ...base, violations } };
    };

    if (d.status === "ESCALATE") {
      const chosen = d.chosen!;
      // 010 FR-005: one pending escalation per purchase. A repeat returns it and records the repeat.
      const pending =
        dedupePending && findPendingEscalation(ledger.entries(), sessionId, key, String(chosen.payTo), chosen.amount, t);
      if (pending && pending.authorizationId !== undefined) {
        ledger.append(
          {
            type: "ESCALATION_REPEATED",
            sessionId,
            intentId,
            authorizationId: pending.authorizationId,
            data: { escalationId: pending.authorizationId, resourceKey: key, payTo: chosen.payTo, amount: chosen.amount, violations: d.violations },
          },
          t,
        );
        return { decision: { status: "ESCALATE", authorizationId: pending.authorizationId, intentId, violations: d.violations } };
      }
      // 012 (L2-7): eligibility is decided here, inside the section, from the ledger; recorded on the entry.
      const approvalRequest = backchannel?.eligibility({
        operatorOnly: intent.operatorApprovalOnly === true,
        reevaluation: opts.reevaluationOf !== undefined,
        nowMs: t,
      });
      ledger.append(
        {
          type: "ESCALATED",
          sessionId,
          intentId,
          authorizationId,
          data: { violations: d.violations, resourceKey: key, payTo: chosen.payTo, amount: chosen.amount, ...(approvalRequest && { approvalRequest }) },
        },
        t,
      );
      const decision: AuthorizationDecision = { status: "ESCALATE", ...base, violations: d.violations };
      if (approvalRequest !== "requested") return { decision };
      return {
        decision,
        start: {
          escalationId: authorizationId,
          sessionId,
          resourceKey: key,
          payTo: String(chosen.payTo),
          amount: chosen.amount,
          requirement: chosen,
          escalationExpiresAtMs: t + ESCALATION_TTL_MS,
        },
      };
    }
    if (d.status === "DENIED") return deny(d.violations);

    // Step 5: AUTHORIZED → optional simulated latency, then sign the single chosen requirement.
    const chosen = d.chosen!;
    if (deps.signerLatencyMs && deps.signerLatencyMs > 0) await sleep(deps.signerLatencyMs);
    let signed;
    try {
      signed = await signer.sign(intent.paymentRequired, chosen);
    } catch (err) {
      const detail = (err instanceof Error ? err.message : String(err)).slice(0, SIGNER_DETAIL_MAX);
      return deny([{ rule: "signer_rejected", detail }]);
    }

    // The approval is consumed only when it was what lifted R14 for this exact payee and amount.
    const usedApproval =
      approvalData !== undefined &&
      approvalData.payTo.toLowerCase() === String(chosen.payTo).toLowerCase() &&
      approvalData.amount === chosen.amount &&
      BigInt(chosen.amount) > BigInt(mandate.autoApproveMaxAtomic);

    // Step 6: outcome entry with the full SPEC L2-4 field set.
    ledger.append(
      {
        type: "AUTHORIZED",
        sessionId,
        intentId,
        authorizationId,
        data: {
          amount: chosen.amount,
          asset: chosen.asset,
          network: chosen.network,
          payTo: chosen.payTo,
          payer: signed.payer,
          validBefore: signed.validBefore,
          resourceUrl: intent.resourceUrl,
          mandateId: mandate.mandateId,
          approvalRef: usedApproval ? approvalData!.approvalId : null,
        },
      },
      t,
    );
    return {
      decision: {
        status: "AUTHORIZED",
        ...base,
        requirement: chosen,
        paymentHeaders: signed.headers,
        payer: signed.payer,
        validBefore: signed.validBefore,
        remainingSessionBudgetAtomic: remainingFor(sessionId, t).toString(),
      },
    };
  }

  app.post("/v1/authorize", requireRole("agent-control", tok(deps.tokens?.control)), express.json({ limit: "256kb" }), async (req, res) => {
    if (!validIntent(req.body)) {
      res.status(400).json({ error: "malformed PaymentIntent" });
      return;
    }
    const intent = req.body;
    // 012 FR-019: the caller leaving during the wait ends it, and nothing is signed for this call.
    const left = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) left.abort();
    });
    try {
      const first = await serialize(() => decideOnce(intent));
      if (!first.start || !backchannel) {
        res.json(first.decision);
        return;
      }
      // 012 FR-016: start the approval request and wait, holding no lock.
      const escalationId = first.start.escalationId;
      backchannel.start(first.start);
      const outcome = await backchannel.waitForFinal(escalationId, backchannel.waitMs, left.signal);
      if (outcome === "aborted" || left.signal.aborted) return;
      if (outcome === "approved" || outcome === "denied") {
        // FR-017: a second serialized decision, re-checking every rule at this moment.
        const second = await serialize(() => (left.signal.aborted ? null : decideOnce(intent, { reevaluationOf: escalationId })));
        if (second !== null) res.json(second.decision);
        return;
      }
      res.json(first.decision);
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/v1/budget/:sessionId", requireRole("agent-control", tok(deps.tokens?.control)), (req, res) => {
    const sessionId = String(req.params.sessionId);
    const t = now();
    const committed = ledger.committedAtomic({ sessionId }, t);
    const status: BudgetStatus = {
      sessionId,
      asset: deps.asset.address,
      decimals: deps.asset.decimals,
      sessionCapAtomic: mandate.sessionBudgetAtomic,
      spentOrReservedAtomic: committed.toString(),
      remainingAtomic: maxZero(BigInt(mandate.sessionBudgetAtomic) - committed).toString(),
      perPaymentCapAtomic: mandate.autoApproveMaxAtomic,
    };
    res.json(status);
  });

  mountLedgerRoutes(app, {
    ledger,
    serialize,
    tokens: {
      ...(deps.tokens?.settlement !== undefined && { settlement: deps.tokens.settlement }),
      ...(deps.tokens?.operator !== undefined && { operator: deps.tokens.operator }),
    },
  });

  mountApprovalRoutes(app, {
    ledger,
    serialize,
    now,
    ...(deps.tokens?.operator !== undefined && { tokens: { operator: deps.tokens.operator } }),
  });

  mountEscalationRoutes(app, {
    ledger,
    serialize,
    now,
    ...(deps.tokens?.operator !== undefined && { tokens: { operator: deps.tokens.operator } }),
  });

  if (deps.apiDocs) mountApiDocs(app);

  return { app, serialize, sweep: () => serialize(() => sweep(ledger, now())), ...(backchannel && { backchannel }) };
}

/** `.local/ledger-<network>.jsonl`, from the network name only (no profile resolution). */
export function ledgerPathFor(network: string = process.env.NETWORK ?? "local"): string {
  return `.local/ledger-${network}.jsonl`;
}

/** Binds L2 to loopback only (SPEC §3.1, NFR-001). Overriding the port never changes the host. */
export function listenControl(app: Express, port: number = controlPort(), onListen?: () => void): Server {
  return app.listen(port, CONTROL_BIND_HOST, onListen);
}

/**
 * Entry point (`npm run l2:control`). Order: env → ledger lock (L2-6) → ledger integrity → profile →
 * mandate → signer → listen.
 */
export async function main(): Promise<void> {
  loadEnv("l2-control");
  // 012: the CIBA_* settings are checked before the lock, so a misconfigured revision never takes it (L2-6).
  const ciba = cibaConfigFromEnv(process.env);
  // L2-6: one writer. Wait in standby while another L2 holds the ledger, then read it only once ours.
  const lock = await acquireLedgerLock(ledgerPathFor());
  // The ledger loads and verifies first, so an integrity failure is reported before anything else.
  const ledger = new AuditLedger(ledgerPathFor());
  const net = networkProfile();
  const mandate = loadMandate(net, process.env);
  const key = process.env.PAYER_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("PAYER_PRIVATE_KEY is missing or malformed (env/l2-control.env)");
  }
  const signer = new PaymentSigner(key as `0x${string}`, net, mandate.hardCapPerPaymentAtomic);
  const apiDocs = apiDocsEnabled();
  // 012 (L2-7): the client holds the credential; the rest of L2 sees only the non-secret settings. No network call.
  let backchannelDeps: BackchannelDeps | undefined;
  if (ciba.enabled) {
    const settings = publicSettings(ciba);
    backchannelDeps = { port: new CibaClient(ciba), ...settings, keys: issuerKeys(settings.issuer), decimals: net.decimals };
    console.log(`l2-control: backchannel approval on (issuer ${settings.issuer}, approver ${settings.approver})`);
  } else if (ciba.ignored.length > 0) {
    console.log(`l2-control: backchannel approval is off; ignoring ${ciba.ignored.join(", ")}`);
  }
  const { app, sweep: sweepNow, backchannel } = createControlService({
    mandate,
    signer,
    ledger,
    asset: { address: net.asset, decimals: net.decimals },
    apiDocs,
    ...(backchannelDeps && { backchannel: backchannelDeps }),
  });
  // FR-012: resume every open approval request from the ledger, without sending a new one.
  backchannel?.resume();
  // 010 (L2-4.3): expire escalations and lapse approvals on time even when nobody calls L2. The timer
  // never keeps the process alive; tests never call main(), so they stay deterministic.
  void sweepNow();
  setInterval(() => void sweepNow(), SWEEP_INTERVAL_MS).unref();
  const port = controlPort();
  const server = listenControl(app, port, () => {
    console.log(`l2-control listening on http://${CONTROL_BIND_HOST}:${port} (network ${net.name}, payer ${signer.address})`);
    if (apiDocs) console.log(`l2-control API docs on http://${CONTROL_BIND_HOST}:${port}/docs (API_DOCS=1, no token)`);
  });
  server.on("error", (err) => {
    console.error(`l2-control: ${err.message}`);
    lock.release();
    process.exit(1);
  });
  // L2-6: release the lock on shutdown so a replacement revision takes over at once.
  const stop = () => {
    backchannel?.stop();
    server.close();
    lock.release();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`l2-control: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
