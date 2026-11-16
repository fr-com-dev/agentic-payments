// L2 Control HTTP service (SPEC.md §8.2 L2-5). Owner of the bootstrap, authorize and budget: feature 002.
// Reconcile and ledger-verify routes come from ./ledger-routes.ts (003); approvals and rejections from
// ./approval-routes.ts (004, 010); escalation reads from ./escalation-routes.ts (010); Swagger UI from
// ./api-docs.ts (v1.4, only with API_DOCS=1).
// INV-8: the whole authorize body (INTENT → decide → sign → outcome entry) runs in one serialized section.
// 012 (L2-7): with backchannel approval on, a new eligible escalation starts an approval request and the call waits
// up to 120 s outside the section; if the escalation reaches approved or denied meanwhile, a second serialized
// decision (a new INTENT for the same intentId) is returned instead of ESCALATE.
// 013 (L2-8): with user accounts on, an intent that names a user is decided against that user's one active policy for
// the requested seller, bounded by the platform limits, and signed with that user's own account. An intent without a
// user is the platform account, exactly as before. The user routes come from ./user-routes.ts.
// 014 (L2-8): with the administration area on as well, the portal's second role reaches the routes of
// ./admin-routes.ts: the escalation reads, the two decisions, the budget behind an escalation and the ledger check.
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import express, { type Express } from "express";
import type { PaymentRequirements } from "@x402/core/types";
import { addressLimit } from "../shared/address-limit.js";
import { requireRole } from "../shared/auth.js";
import { apiDocsEnabled, ConfigError, CONTROL_BIND_HOST, controlPort, loadEnv, networkProfile, ROLE_TOKEN_VAR, tokenFor, type NetworkProfile } from "../shared/config.js";
import { USER_ID_RE } from "../shared/user-id.js";
import type { AuthorizationDecision, BudgetStatus, EscalationBudget, PaymentIntent, PolicyViolation } from "../shared/contracts.js";
import { mountAdminRoutes, toEscalationBudget, type AdminDeps } from "./admin-routes.js";
import { mountApiDocs } from "./api-docs.js";
import { issuerKeys } from "./approval-evidence.js";
import { mountApprovalRoutes } from "./approval-routes.js";
import { Backchannel, type BackchannelDeps, type StartPlan } from "./backchannel.js";
import { CibaClient, cibaConfigFromEnv, publicSettings } from "./ciba-client.js";
import { mountEscalationRoutes } from "./escalation-routes.js";
import { ESCALATION_TTL_MS, findPendingEscalation, findRejection, sweep } from "./escalations.js";
import { AuditLedger, resourceKey, type LedgerEntry } from "./ledger.js";
import { callerAuth, callerChecksPerMinute, callerDepsFor, callerSettingsFromEnv, forwardedIdentityOf, type CallerDeps } from "./caller.js";
import { acquireLedgerLock } from "./ledger-lock.js";
import { mountLedgerRoutes, type Serialize } from "./ledger-routes.js";
import { AUTHORIZE_BODY_LIMIT, jsonBody, refuseUnreadBody } from "./json-body.js";
import { loadMandate, type SpendingMandate } from "./mandate.js";
import { loadPlatform, platformDigest, type PlatformConfig } from "./platform.js";
import { decide, type PolicyContext } from "./policy.js";
import { keyringFromEnv, PaymentSigner, refusePublishedDevKeys, USER_WALLET_ENV, type PaymentSignerLike } from "./signer.js";
import { mountUserRoutes } from "./user-routes.js";
import {
  effectiveMandate,
  highestAutoApprove,
  lastPlatformDigest,
  recordedWallets,
  selectPolicy,
  userGate,
  userState,
  type UserGate,
  type PolicyRecord,
  type UserAccountsDeps,
  type UserState,
  type WalletKeyringLike,
} from "./users.js";

export interface ControlServiceDeps {
  mandate: SpendingMandate;
  signer: PaymentSignerLike;
  ledger: AuditLedger;
  /** Asset and decimals reported by /v1/budget. */
  asset: { address: string; decimals: number };
  /** Test hook (T-E2E-04): simulated remote-signer latency, applied inside the serialized section. */
  signerLatencyMs?: number;
  /** Test hook: explicit tokens instead of resolving them from the environment. */
  tokens?: { control?: string; settlement?: string; operator?: string; portal?: string; portalAdmin?: string };
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
  /** 013 (L2-8): user accounts. Absent: off, behavior as in v1.8, and a person's token is refused (016). */
  users?: UserAccountsDeps;
  /**
   * 016 (L2-5, SEC-32): sign-in. Present: every authorize and budget call must carry the caller's access token
   * beside the role token, L2 verifies it and takes the user from it. Absent: no token is accepted, no payment
   * names a user, and the platform account pays (the local scripted demo). main() requires it with user accounts.
   */
  caller?: CallerDeps;
  /** 013: the network, for the effective mandate and the views. Required with `users`. */
  net?: Pick<NetworkProfile, "caip2" | "asset" | "decimals">;
  /** 014 (L2-8): the administration routes. Absent: off, each answers 404. Needs `users`. */
  admin?: AdminDeps;
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

/**
 * 400 checks (L2-5): ids present, accepts is an array, resourceUrl is http(s). 016 (SEC-32): a request can't name
 * who the payment is for or whose phone to ask. `userId` and the retired `approvalSubject` are refused, because the
 * user comes from the caller's token alone. `trustUser` is the test-only must-fail switch that restores `userId`.
 */
function validIntent(body: unknown, trustUser = false): body is PaymentIntent {
  if (body === null || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  const pr = b.paymentRequired as Record<string, unknown> | undefined;
  if ("approvalSubject" in b) return false;
  if ("userId" in b && !(trustUser && typeof b.userId === "string" && USER_ID_RE.test(b.userId))) return false;
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

/**
 * 015 (FR-020, T-CIBA-20): answers an authorize body that could not be read (not JSON, too large, compressed, cut
 * off). Without it the error reaches Express's default handler, which logs it outside the test environment, and a
 * body-parser error carries the raw body: `approvalSubject` (or `purpose`) would be in L2's log. Nothing of the
 * request is logged or repeated here. Any other error is passed on unchanged. Every other route that takes a body
 * gets the same treatment with generic messages (T-BODY-02).
 */
const refuseUnreadIntent = refuseUnreadBody({ malformed: "malformed PaymentIntent", refused: "PaymentIntent body refused" });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const maxZero = (n: bigint) => (n < 0n ? 0n : n);
const minOf = (...ns: bigint[]) => ns.reduce((a, b) => (b < a ? b : a));

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.host.length > 0 ? u.host : null;
  } catch {
    return null;
  }
}

/** 013: everything one decision needs about the user, derived inside the serialized section. */
interface UserDecision {
  userId: string;
  state: UserState;
  /** R16, R17: why this user can't pay at all, if so. */
  gate: UserGate | undefined;
  policy: PolicyRecord | undefined;
  mandate: SpendingMandate;
}

export function createControlService(deps: ControlServiceDeps): ControlService {
  const { mandate, signer, ledger } = deps;
  const now = deps.now ?? Date.now;
  const dedupePending = deps.dedupePendingEscalations ?? true;
  const serialize = createSerializer();
  const app = express();
  const tok = (t?: string) => (t === undefined ? {} : { token: t });

  const users = deps.users;
  const userNet: Pick<NetworkProfile, "caip2" | "asset" | "decimals"> = deps.net ?? {
    caip2: (mandate.allowedNetworks[0] ?? "eip155:0") as NetworkProfile["caip2"],
    asset: deps.asset.address as NetworkProfile["asset"],
    decimals: deps.asset.decimals,
  };
  // 013: with user accounts on, the platform account counts only its own entries (no `userId`), so users never use
  // up its budgets. Off, the filter is absent and every figure is exactly what it was.
  const platformOwner = users ? ({ userId: null } as const) : {};
  const remainingFor = (sessionId: string, t: number) =>
    maxZero(BigInt(mandate.sessionBudgetAtomic) - ledger.committedAtomic({ sessionId, ...platformOwner }, t));

  /** 013: the user, their one applicable policy and the mandate the engine will evaluate (data-model.md). */
  function userDecision(userId: string, resourceUrl: string): UserDecision {
    const state = userState(ledger.entries(), userId);
    const host = hostOf(resourceUrl);
    // `skipUserGate` is the must-fail proof of R16 and R17: without the gate, a disabled user's policy applies.
    const gate = users!.skipUserGate ? undefined : userGate(state);
    const policy = gate === undefined ? selectPolicy(state, host, users!.platform) : undefined;
    return {
      userId,
      state,
      gate,
      policy,
      mandate: effectiveMandate({
        policy,
        host,
        platform: users!.platform,
        platformMandate: mandate,
        net: userNet,
        ...(users!.skipPlatformBound && { skipPlatformBound: true }),
      }),
    };
  }
  /**
   * 014: the ledger-derived figures a payment counts against (INV-7), for one owner, session and moment. For a user:
   * this user's and this policy's entries only, plus the user-wide figure for the daily ceiling (FR-031, FR-032).
   * The decision builds its policy context from this, and so does the administration area's budget view, so what an
   * administrator sees is what the retry will be judged against (specs/014 research R9).
   */
  function spendFigures(u: UserDecision | undefined, sessionId: string, t: number) {
    const mine = u ? (users!.sharedBudgets ? {} : { userId: u.userId, ...(u.policy && { policyId: u.policy.policyId }) }) : platformOwner;
    return {
      mine,
      sessionCommittedAtomic: ledger.committedAtomic({ sessionId, ...mine }, t),
      dailyCommittedAtomic: ledger.committedAtomic({ sinceMs: t - DAY_MS, ...mine }, t),
      userDailyCommittedAtomic: u ? ledger.committedAtomic({ userId: u.userId, sinceMs: t - DAY_MS }, t) : 0n,
    };
  }

  /** 014: the budget behind an escalation, as of `t`, under the rules that apply to its owner now (INV-12). Reads only. */
  function budgetFor(escalated: LedgerEntry, t: number): EscalationBudget {
    const owner = typeof escalated.data.userId === "string" ? escalated.data.userId : undefined;
    const u = users && owner !== undefined ? userDecision(owner, String(escalated.data.resourceKey)) : undefined;
    const spend = spendFigures(u, String(escalated.sessionId ?? ""), t);
    return toEscalationBudget({
      asset: deps.asset,
      amountAtomic: String(escalated.data.amount),
      mandate: u ? u.mandate : mandate,
      ...(u && {
        user: {
          ...(u.gate !== undefined && { gate: u.gate }),
          hasPolicy: u.policy !== undefined,
          dailyCeilingAtomic: users!.platform.limits.userDailyCeilingAtomic,
          dailyCommittedAtomic: spend.userDailyCommittedAtomic,
        },
      }),
      sessionCommittedAtomic: spend.sessionCommittedAtomic,
      dailyCommittedAtomic: spend.dailyCommittedAtomic,
    });
  }
  // 015 (FR-001): a request goes to the user a payment is for. Without user accounts no payment names a user, so
  // the feature would be on and could ask nobody.
  if (deps.backchannel && !users) throw new Error("backchannel approval needs user accounts (SPEC L2-7)");
  const backchannel = deps.backchannel ? new Backchannel({ ...deps.backchannel, ledger, serialize, now }) : undefined;

  type Decided = { decision: AuthorizationDecision; start?: StartPlan };

  /**
   * One serialized decision (L2-5 steps 1–6). `reevaluationOf` marks the second decision after a wait (012): its
   * INTENT carries the escalation ID, and it never starts an approval request. 016: `intent.userId` was set by the
   * route from the caller's verified token, never by the request; `subject` is that token's subject, for a person.
   */
  async function decideOnce(intent: PaymentIntent, opts: { reevaluationOf?: string; subject?: string } = {}): Promise<Decided> {
    // Step 1: one clock read; INTENT before deciding.
    const t = now();
    // 010: record due expiries and lapses first, so the decision sees current escalation states.
    sweep(ledger, t);
    const authorizationId = `auth_${randomUUID()}`;
    const { intentId, sessionId } = intent;
    const key = resourceKey(intent.resourceUrl);
    const accepts = intent.paymentRequired.accepts as PaymentRequirements[];
    // 013, 016: the user the caller's token proved. With user accounts off there is none (a person's token is
    // refused before this point) and nothing is recorded about one (FR-001).
    let u = users && intent.userId !== undefined ? userDecision(intent.userId, intent.resourceUrl) : undefined;
    // Test-only must-fail proof of FR-002 (never set by main()): a person who has not onboarded falls back.
    if (u?.gate === "not_onboarded" && users!.fallbackToPlatform) u = undefined;
    const gate = u?.gate;
    // What every entry of this decision says about its owner: the user, and the policy and version when one applied.
    const who = u && {
      userId: u.userId,
      ...(u.policy && { policyId: u.policy.policyId, policyVersion: u.policy.version }),
    };
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
          ...(u && { userId: u.userId }),
        },
      },
      t,
    );
    // The mandate the engine evaluates: the user's effective one, or the platform account's.
    const m = u ? u.mandate : mandate;
    // Whose approvals, rejections and pending escalations count: this user's, or the platform account's.
    const owner = users ? (u ? u.userId : null) : undefined;

    // Step 2: open approval for (session, resourceKey), most recent wins (L2-4.2).
    const approval = ledger.findOpenApproval(sessionId, key, t, owner);
    const approvalData = approval?.data as { payTo: string; amount: string; approvalId: string } | undefined;
    // 010: an operator rejection for (session, resourceKey) feeds R15.
    const rejection = findRejection(ledger.entries(), sessionId, key, owner);

    // Step 3: ledger-derived context (INV-7). For a user: this user's and this policy's entries only, plus the
    // user-wide figure for the daily ceiling (FR-031, FR-032).
    const spend = spendFigures(u, sessionId, t);
    const { mine } = spend;
    const ctx: PolicyContext = {
      nowMs: t,
      requestedUrl: intent.resourceUrl,
      challengeResourceUrl: String(intent.paymentRequired.resource?.url ?? ""),
      sessionCommittedAtomic: spend.sessionCommittedAtomic,
      dailyCommittedAtomic: spend.dailyCommittedAtomic,
      authorizationsLastMinute: ledger.authorizedSince(t - 60_000, mine),
      ...(approvalData && {
        humanApprovedFor: { payTo: approvalData.payTo, amount: approvalData.amount, approvalId: approvalData.approvalId },
      }),
      ...(rejection && { humanRejected: { rejectionId: rejection.data.rejectionId as string } }),
      ...(u && {
        user: {
          ...(gate !== undefined && { gate }),
          dailyCommittedAtomic: spend.userDailyCommittedAtomic,
          ...(!users!.skipUserCeiling && { dailyCeilingAtomic: users!.platform.limits.userDailyCeilingAtomic }),
        },
      }),
    };

    // Step 4: pure decision.
    const d = decide(accepts, m, ctx);
    const base = { authorizationId, intentId };
    const deny = (violations: PolicyViolation[]): Decided => {
      ledger.append({ type: "DENIED", sessionId, intentId, authorizationId, data: { violations, resourceKey: key, ...who } }, t);
      return { decision: { status: "DENIED", ...base, violations } };
    };

    if (d.status === "ESCALATE") {
      const chosen = d.chosen!;
      // 010 FR-005: one pending escalation per purchase. A repeat returns it and records the repeat.
      const pending =
        dedupePending && findPendingEscalation(ledger.entries(), sessionId, key, String(chosen.payTo), chosen.amount, t, owner);
      if (pending && pending.authorizationId !== undefined) {
        ledger.append(
          {
            type: "ESCALATION_REPEATED",
            sessionId,
            intentId,
            authorizationId: pending.authorizationId,
            data: { escalationId: pending.authorizationId, resourceKey: key, payTo: chosen.payTo, amount: chosen.amount, violations: d.violations, ...who },
          },
          t,
        );
        return { decision: { status: "ESCALATE", authorizationId: pending.authorizationId, intentId, violations: d.violations } };
      }
      // 012 (L2-7): eligibility is decided here, inside the section, from the ledger; recorded on the entry.
      // 015: also from who the escalation is for. `u` is the user this decision resolved (absent: the platform
      // account, which asks nobody). 016: the subject is the one of the caller's verified token; it goes to
      // eligibility and, for `requested`, into the start plan, and nowhere else: never an entry, a log line or
      // the decision.
      const approvalRequest = backchannel?.eligibility({
        operatorOnly: intent.operatorApprovalOnly === true,
        reevaluation: opts.reevaluationOf !== undefined,
        nowMs: t,
        ...(u && { owner: u.userId }),
        ...(opts.subject !== undefined && { subject: opts.subject }),
      });
      ledger.append(
        {
          type: "ESCALATED",
          sessionId,
          intentId,
          authorizationId,
          data: { violations: d.violations, resourceKey: key, payTo: chosen.payTo, amount: chosen.amount, ...(approvalRequest && { approvalRequest }), ...who },
        },
        t,
      );
      const decision: AuthorizationDecision = { status: "ESCALATE", ...base, violations: d.violations };
      if (approvalRequest !== "requested" || !backchannel) return { decision };
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
          ...backchannel.addressee({ ...(u && { owner: u.userId }), ...(opts.subject !== undefined && { subject: opts.subject }) }),
        },
      };
    }
    if (d.status === "DENIED") return deny(d.violations);

    // Step 5: AUTHORIZED → optional simulated latency, then sign the single chosen requirement.
    const chosen = d.chosen!;
    if (deps.signerLatencyMs && deps.signerLatencyMs > 0) await sleep(deps.signerLatencyMs);
    let signed;
    try {
      // 013 FR-017: a user's payment is signed with that user's own account, and only if the keyring still derives
      // the address the ledger recorded for it.
      let with_: PaymentSignerLike = signer;
      if (u && !users!.sharedSigner) {
        const wallet = u.state.wallet;
        if (!wallet) throw new Error("the user has no crypto account");
        with_ = users!.keyring.signerFor(wallet.walletIndex, m.hardCapPerPaymentAtomic);
        if (with_.address.toLowerCase() !== wallet.address.toLowerCase()) throw new Error("the user's account does not match the ledger");
      }
      signed = await with_.sign(intent.paymentRequired, chosen);
    } catch (err) {
      const detail = (err instanceof Error ? err.message : String(err)).slice(0, SIGNER_DETAIL_MAX);
      return deny([{ rule: "signer_rejected", detail }]);
    }

    // The approval is consumed only when it was what lifted R14 for this exact payee and amount.
    const usedApproval =
      approvalData !== undefined &&
      approvalData.payTo.toLowerCase() === String(chosen.payTo).toLowerCase() &&
      approvalData.amount === chosen.amount &&
      BigInt(chosen.amount) > BigInt(m.autoApproveMaxAtomic);

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
          mandateId: m.mandateId,
          approvalRef: usedApproval ? approvalData!.approvalId : null,
          ...who,
        },
      },
      t,
    );
    // What is left after this payment. For a user: the smallest of the policy's session and daily budgets and the
    // user daily ceiling.
    const remaining = u
      ? maxZero(
          minOf(
            BigInt(m.sessionBudgetAtomic) - ledger.committedAtomic({ sessionId, ...mine }, t),
            BigInt(m.dailyBudgetAtomic) - ledger.committedAtomic({ sinceMs: t - DAY_MS, ...mine }, t),
            BigInt(users!.platform.limits.userDailyCeilingAtomic) - ledger.committedAtomic({ userId: u.userId, sinceMs: t - DAY_MS }, t),
          ),
        )
      : remainingFor(sessionId, t);
    return {
      decision: {
        status: "AUTHORIZED",
        ...base,
        requirement: chosen,
        paymentHeaders: signed.headers,
        payer: signed.payer,
        validBefore: signed.validBefore,
        remainingSessionBudgetAtomic: remaining.toString(),
      },
    };
  }

  // 016 (SEC-32): the role token first, then the caller's token, then the body. A refused caller's body is never
  // parsed, and the token is verified here, before any serialized section.
  const caller = callerAuth(deps.caller, { usersOn: users !== undefined });
  const trustIntentUser = deps.caller?.trustIntentUser === true;
  // Verifying a caller's token costs a signature check, so both routes count requests per calling address first,
  // after the role token: a caller without it is refused before it counts. Beyond the bound: 429, and nothing is
  // verified, parsed, decided or appended. No bound where sign-in is not configured (nothing is verified there).
  const callerLimit = addressLimit({ max: callerChecksPerMinute(deps.caller) });

  app.post("/v1/authorize", requireRole("agent-control", tok(deps.tokens?.control)), callerLimit, caller, jsonBody(AUTHORIZE_BODY_LIMIT), async (req, res) => {
    if (!validIntent(req.body, trustIntentUser)) {
      res.status(400).json({ error: "malformed PaymentIntent" });
      return;
    }
    // Who the payment is for: the person the token proved, or nobody (a machine caller, or no sign-in configured).
    const who = forwardedIdentityOf(res);
    const subject = who.kind === "person" ? who.subject : undefined;
    const intent: PaymentIntent = trustIntentUser ? req.body : { ...req.body, ...(who.kind === "person" && { userId: who.userId }) };
    // 012 FR-019: the caller leaving during the wait ends it, and nothing is signed for this call.
    const left = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) left.abort();
    });
    try {
      const first = await serialize(() => decideOnce(intent, { ...(subject !== undefined && { subject }) }));
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
        const second = await serialize(() => (left.signal.aborted ? null : decideOnce(intent, { reevaluationOf: escalationId, ...(subject !== undefined && { subject }) })));
        if (second !== null) res.json(second.decision);
        return;
      }
      res.json(first.decision);
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.use("/v1/authorize", refuseUnreadIntent);

  app.get("/v1/budget/:sessionId", requireRole("agent-control", tok(deps.tokens?.control)), callerLimit, caller, (req, res) => {
    const sessionId = String(req.params.sessionId);
    const t = now();
    // 016: the user view is for the person the caller's token proved. `?userId=` named one before; it is refused
    // now, whatever its value (the test-only switch restores it for the must-fail proof).
    const asked = req.query.userId;
    if (asked !== undefined && !(trustIntentUser && typeof asked === "string" && USER_ID_RE.test(asked))) {
      res.status(400).json({ error: "userId is not accepted: the user comes from the caller's token" });
      return;
    }
    const who = forwardedIdentityOf(res);
    const queried = trustIntentUser && typeof asked === "string" ? asked : who.kind === "person" ? who.userId : undefined;
    if (users && queried !== undefined) {
      const state = userState(ledger.entries(), queried);
      const usable = userGate(state) === undefined;
      const ceiling = usable ? BigInt(users.platform.limits.userDailyCeilingAtomic) : 0n;
      const spent = usable ? ledger.committedAtomic({ userId: queried, sinceMs: t - DAY_MS }, t) : 0n;
      const userStatus: BudgetStatus = {
        sessionId,
        asset: deps.asset.address,
        decimals: deps.asset.decimals,
        sessionCapAtomic: ceiling.toString(),
        spentOrReservedAtomic: spent.toString(),
        remainingAtomic: maxZero(ceiling - spent).toString(),
        perPaymentCapAtomic: usable ? highestAutoApprove(state, users.platform, t) : "0",
        scope: "user_daily",
      };
      res.json(userStatus);
      return;
    }
    const committed = ledger.committedAtomic({ sessionId, ...platformOwner }, t);
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

  // 013: mounted only when user accounts are on; off, each of these routes answers 404.
  if (users) {
    mountUserRoutes(app, {
      ledger,
      serialize,
      now,
      users,
      net: userNet,
      ...(deps.tokens?.portal !== undefined && { tokens: { portal: deps.tokens.portal } }),
    });
  }

  // 014: mounted only when user accounts and the administration area are both on; otherwise each is 404.
  if (users && deps.admin) {
    mountAdminRoutes(app, {
      ledger,
      serialize,
      now,
      admin: deps.admin,
      budgetFor,
      tokens: {
        ...(deps.tokens?.portalAdmin !== undefined && { portalAdmin: deps.tokens.portalAdmin }),
        ...(deps.tokens?.portal !== undefined && { portal: deps.tokens.portal }),
      },
    });
  }

  if (deps.apiDocs) mountApiDocs(app);
  // Every other route's unreadable body: a fixed JSON answer, never Express's default handler (T-BODY-02).
  app.use(refuseUnreadBody());

  return { app, serialize, sweep: () => serialize(() => sweep(ledger, now())), ...(backchannel && { backchannel }) };
}

// ---------------------------------------------------------------------------
// 013 user accounts: configuration and startup checks (CFG-2, L2-8)
// ---------------------------------------------------------------------------

type Env = Record<string, string | undefined>;
const USER_ACCOUNT_VARS = ["PORTAL_TOKEN", USER_WALLET_ENV, "PLATFORM_FILE", "PLATFORM_SELLERS"] as const;

export type UserAccountsConfig =
  | { enabled: false; ignored: string[] }
  | { enabled: true; platform: PlatformConfig; keyring: WalletKeyringLike; portalToken: string };

/**
 * Reads the user-account settings. Off unless `USER_ACCOUNTS=1`: the other variables are then ignored and only their
 * names are reported. On, everything is checked here, before the ledger lock: the portal token (its own, never
 * another role's), the wallet mnemonic and the platform config. An error names the setting, never a value.
 */
export function userAccountsFromEnv(env: Env, net: Pick<NetworkProfile, "caip2" | "asset">): UserAccountsConfig {
  if (env.USER_ACCOUNTS !== "1") {
    return { enabled: false, ignored: USER_ACCOUNT_VARS.filter((k) => env[k] !== undefined && env[k] !== "") };
  }
  const portalToken = tokenFor("portal-control", env);
  for (const role of ["agent-control", "verifier-control", "operator"] as const) {
    if (tokenFor(role, env) === portalToken) {
      throw new ConfigError(`PORTAL_TOKEN must differ from ${ROLE_TOKEN_VAR[role]} (INV-13)`);
    }
  }
  return { enabled: true, platform: loadPlatform(env), keyring: keyringFromEnv(env, net), portalToken };
}

// ---------------------------------------------------------------------------
// 014 portal administration: configuration (CFG-2, L2-8)
// ---------------------------------------------------------------------------

export type AdminConfig = { enabled: false; ignored: string[] } | { enabled: true; adminToken: string };

/**
 * Reads the administration settings. Off unless `PORTAL_ADMIN=1`: the token is then ignored and only its name is
 * reported. On, it needs user accounts on (the administration area belongs to the portal) and a token of its own,
 * never another role's. Checked before the ledger lock; an error names the setting, never a value.
 */
export function adminFromEnv(env: Env, accounts: Pick<UserAccountsConfig, "enabled">): AdminConfig {
  if (env.PORTAL_ADMIN !== "1") {
    return { enabled: false, ignored: ["PORTAL_ADMIN_TOKEN"].filter((k) => env[k] !== undefined && env[k] !== "") };
  }
  if (!accounts.enabled) throw new ConfigError("PORTAL_ADMIN=1 needs USER_ACCOUNTS=1 (the administration area belongs to the portal)");
  const adminToken = tokenFor("portal-admin", env);
  for (const role of ["agent-control", "verifier-control", "operator", "portal-control"] as const) {
    if (tokenFor(role, env) === adminToken) {
      throw new ConfigError(`PORTAL_ADMIN_TOKEN must differ from ${ROLE_TOKEN_VAR[role]} (INV-13)`);
    }
  }
  return { enabled: true, adminToken };
}

/** Fails closed when the keyring no longer derives a recorded wallet address (a changed or mistyped mnemonic). */
export function checkWalletAddresses(ledger: AuditLedger, keyring: WalletKeyringLike): void {
  for (const w of recordedWallets(ledger.entries())) {
    if (keyring.addressOf(w.walletIndex).toLowerCase() !== w.address.toLowerCase()) {
      throw new Error(`the user wallet mnemonic does not match the ledger (wallet ${w.walletIndex}); refusing to start`);
    }
  }
}

/** Appends PLATFORM_CONFIG when the config in force differs from the last one recorded. Returns true if it did. */
export function recordPlatformConfig(ledger: AuditLedger, platform: PlatformConfig, atMs: number = Date.now()): boolean {
  const digest = platformDigest(platform);
  if (lastPlatformDigest(ledger.entries()) === digest) return false;
  ledger.append({ type: "PLATFORM_CONFIG", data: { platformId: platform.platformId, digest, limits: platform.limits, sellers: platform.sellers } }, atMs);
  return true;
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
  // 013: the same for the user-account settings (token, mnemonic, platform config). No network call.
  const accounts = userAccountsFromEnv(process.env, networkProfile());
  // 014: and for the administration area (its own token, and user accounts on).
  const administration = adminFromEnv(process.env, accounts);
  // 015 (L2-7, FR-001): backchannel approval asks the user a payment is for, so it needs user accounts. Checked with
  // the rest, before the lock.
  if (ciba.enabled && !accounts.enabled) throw new ConfigError("CIBA_APPROVAL=1 needs USER_ACCOUNTS=1 (SPEC L2-7)");
  // 016 (L2-5, FR-015): the caller's token. A user is whoever a verified token names, so user accounts need sign-in.
  const signIn = callerSettingsFromEnv(process.env, networkProfile().name);
  if (accounts.enabled && signIn === undefined) {
    throw new ConfigError("USER_ACCOUNTS=1 needs AUTH_ISSUER, AUTH_AUDIENCE and AGENT_CLIENT_IDS (SPEC L2-8): the user of a payment comes from the caller's token");
  }
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
  // A published development key or mnemonic is refused outside local, before anything is served (T-DEVKEY-01).
  refusePublishedDevKeys(net.name, signer.address, accounts.enabled ? accounts.keyring : undefined);
  const apiDocs = apiDocsEnabled();
  // 012 (L2-7): the client holds the credential; the rest of L2 sees only the non-secret settings. No network call.
  let backchannelDeps: BackchannelDeps | undefined;
  if (ciba.enabled) {
    const settings = publicSettings(ciba);
    backchannelDeps = { port: new CibaClient(ciba), ...settings, keys: issuerKeys(settings.issuer), decimals: net.decimals };
    console.log(`l2-control: backchannel approval on (issuer ${settings.issuer}, per user)`);
  } else if (ciba.ignored.length > 0) {
    console.log(`l2-control: backchannel approval is off; ignoring ${ciba.ignored.join(", ")}`);
  }
  // 013 (L2-8): before serving, every recorded wallet must still derive from the mnemonic, and the platform config
  // in force is recorded when it changed. Both happen under the lock, on the loaded ledger.
  if (accounts.enabled) {
    checkWalletAddresses(ledger, accounts.keyring);
    recordPlatformConfig(ledger, accounts.platform);
    console.log(`l2-control: user accounts on (platform ${accounts.platform.platformId}, ${accounts.platform.sellers.length} sellers)`);
  } else if (accounts.ignored.length > 0) {
    console.log(`l2-control: user accounts are off; ignoring ${accounts.ignored.join(", ")}`);
  }
  if (signIn !== undefined) console.log(`l2-control: callers' tokens verified (issuer ${signIn.issuer}); every payment request needs one`);
  if (administration.enabled) console.log("l2-control: portal administration on");
  else if (administration.ignored.length > 0) console.log(`l2-control: portal administration is off; ignoring ${administration.ignored.join(", ")}`);
  const { app, sweep: sweepNow, backchannel } = createControlService({
    mandate,
    signer,
    ledger,
    asset: { address: net.asset, decimals: net.decimals },
    apiDocs,
    ...(backchannelDeps && { backchannel: backchannelDeps }),
    ...(signIn !== undefined && { caller: callerDepsFor(signIn) }),
    ...(accounts.enabled && {
      users: { platform: accounts.platform, keyring: accounts.keyring },
      net,
      tokens: { portal: accounts.portalToken, ...(administration.enabled && { portalAdmin: administration.adminToken }) },
    }),
    ...(administration.enabled && { admin: {} }),
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
