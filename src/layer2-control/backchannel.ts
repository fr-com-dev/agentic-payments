// Backchannel approval coordinator (SPEC L2-7; specs/012 plan "Approval request lifecycle"). Owner: feature 012.
// Starts one CIBA request per eligible escalation, polls it, verifies the answer and records the outcome. Every
// network call (start, poll, JWKS) runs outside the serialized section; every check-then-append runs inside it
// (FR-028, INV-8). It holds no credential: the CibaPort does (rule A9). It writes only new entry types and the
// backchannel channel of HUMAN_APPROVAL / HUMAN_REJECTION, with data copied from the escalation (INV-12), and
// never a token, a handle or the service's text (NFR-003). The policy engine never sees any of this: an approval
// reaches it through findOpenApproval, a refusal through findRejection, exactly as from the operator (FR-032).
import { randomUUID } from "node:crypto";
import type { PaymentRequirements } from "@x402/core/types";
import { DEFAULT_APPROVAL_TTL_SECONDS } from "./approval-routes.js";
import { type ApprovalKeys, type VerificationCheck, type VerificationResult, verifyApprovalToken } from "./approval-evidence.js";
import type { CibaPort, PollResult, StartResult } from "./ciba-client.js";
import {
  activeApprovalRequest,
  answerIdUsed,
  type ApprovalRequestMark,
  approvalRequestCount,
  approvalRequestState,
  escalationState,
  findEscalation,
  openApprovalRequest,
  referenceCode,
  requestsToResume,
} from "./escalations.js";
import type { AuditLedger, LedgerEntry } from "./ledger.js";
import type { Serialize } from "./ledger-routes.js";
import { bindingMessage, paymentDetails, requestedExpirySeconds } from "./payment-details.js";

/** The authorize call that created the escalation waits at most this long (FR-016). Fixed. */
export const BACKCHANNEL_WAIT_MS = 120_000;
/** FR-008: at most this many approval requests per rolling hour. */
export const APPROVAL_REQUEST_CAP = 10;
export const APPROVAL_REQUEST_CAP_WINDOW_MS = 3_600_000;
/** FR-009: the waits after the 1st and 2nd transient start failures (3 attempts, the first at once). */
export const START_RETRY_DELAYS_MS: readonly number[] = [250, 1000];
/** A refusal this close to the request's own expiry may mean "expired" (Auth0 uses one code for both). */
export const REFUSAL_MARGIN_MS = 5_000;
export const DEFAULT_POLL_INTERVAL_S = 5;
export const SLOW_DOWN_STEP_S = 5;
export const MAX_TRANSIENT_POLL_DELAY_S = 30;

export interface BackchannelDeps {
  port: CibaPort;
  issuer: string;
  clientId: string;
  audience: string;
  approver: string;
  keys: ApprovalKeys;
  /** The asset's decimals, for the USDC amount shown to the approver. */
  decimals: number;
  /** Test-only: the wait in the authorize call. Default BACKCHANNEL_WAIT_MS. */
  waitMs?: number;
  /** Test-only: maps the service's interval (seconds) to a sleep. Default s × 1000. */
  pollDelayMs?: (intervalS: number) => number;
  /** Test-only: start retry waits. Default START_RETRY_DELAYS_MS. */
  retryDelaysMs?: readonly number[];
  /** Test-only (must-fail proof): the cap. Default APPROVAL_REQUEST_CAP. */
  approvalRequestCap?: number;
  /** Test-only (must-fail proofs): verification checks to skip. */
  skipChecks?: ReadonlySet<VerificationCheck>;
  /** Test-only (must-fail proof, T-CIBA-10): false checks the state, awaits verification, then appends unserialized. */
  serializeOutcomes?: boolean;
  /** Log sink for the whitelisted lifecycle lines. Default console.log. */
  log?: (line: string) => void;
}

export interface BackchannelContext {
  ledger: AuditLedger;
  serialize: Serialize;
  now: () => number;
}

/** What the authorize path hands over after it wrote a `requested` ESCALATED (values L2 evaluated, never agent text). */
export interface StartPlan {
  escalationId: string;
  sessionId: string;
  resourceKey: string;
  payTo: string;
  amount: string;
  requirement: PaymentRequirements;
  escalationExpiresAtMs: number;
}

export type WaitResult = "approved" | "denied" | "expired" | "ended" | "timeout" | "aborted";

type Copied = { escalationId: string; resourceKey: unknown; payTo: unknown; amount: unknown };

export class Backchannel {
  private stopped = false;
  private readonly sleepers = new Set<{ timer: NodeJS.Timeout; wake: (ok: boolean) => void }>();
  private readonly polling = new Set<string>();
  private readonly log: (line: string) => void;

  constructor(private readonly d: BackchannelDeps & BackchannelContext) {
    this.log = d.log ?? ((line) => console.log(`l2-control: ${line}`));
  }

  get waitMs(): number {
    return this.d.waitMs ?? BACKCHANNEL_WAIT_MS;
  }

  /** Decided inside the serialized section that writes the new ESCALATED, from the ledger only (research R9). */
  eligibility(o: { operatorOnly: boolean; reevaluation: boolean; nowMs: number }): ApprovalRequestMark {
    if (o.reevaluation) return "reevaluation";
    if (o.operatorOnly) return "operator_only";
    const cap = this.d.approvalRequestCap ?? APPROVAL_REQUEST_CAP;
    if (approvalRequestCount(this.d.ledger.entries(), o.nowMs, APPROVAL_REQUEST_CAP_WINDOW_MS) >= cap) return "capped";
    return "requested";
  }

  /** Fire and forget: starts the request outside the lock, records the result inside it, then polls. */
  start(plan: StartPlan): void {
    void this.runStart(plan).catch(() => this.log(`approval request for ${plan.escalationId} stopped on an internal error`));
  }

  /** Resolves when the escalation reaches a final state, its request ends, the time is up, or the caller left. */
  waitForFinal(escalationId: string, ms: number, signal?: AbortSignal): Promise<WaitResult> {
    return new Promise((resolve) => {
      let done = false;
      let timer: NodeJS.Timeout | undefined;
      let unsubscribe = () => {};
      const onAbort = () => finish("aborted");
      const finish = (r: WaitResult) => {
        if (done) return;
        done = true;
        unsubscribe();
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(r);
      };
      unsubscribe = this.d.ledger.subscribe((e) => {
        if (e.data.escalationId !== escalationId) return;
        if (e.type === "HUMAN_APPROVAL") finish("approved");
        else if (e.type === "HUMAN_REJECTION") finish("denied");
        else if (e.type === "ESCALATION_EXPIRED") finish("expired");
        else if (e.type === "APPROVAL_REQUEST_FAILED" || e.type === "APPROVAL_REQUEST_LAPSED" || e.type === "APPROVAL_VERIFICATION_FAILED") finish("ended");
      });
      if (signal?.aborted) return finish("aborted");
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => finish("timeout"), ms);
      timer.unref?.();
      // The state may already be final (an answer recorded before the wait began).
      const entries = this.d.ledger.entries();
      const state = escalationState(entries, escalationId, this.d.now());
      if (state === "approved" || state === "denied" || state === "expired") return finish(state);
      const req = approvalRequestState(entries, escalationId);
      if (req === "failed" || req === "lapsed" || req === "verification_failed") finish("ended");
    });
  }

  /** After a restart (FR-012): poll open requests again from their sealed handles; never send a new one. */
  resume(): void {
    const set = requestsToResume(this.d.ledger.entries(), this.d.now());
    for (const req of set.open) {
      const id = req.data.escalationId as string;
      const handle = this.d.port.open(String(req.data.handleSealed), `${id}|${String(req.data.requestId)}`);
      if (handle === null) {
        void this.recordFailure(req, { phase: "resume", failure: "unrecoverable" });
      } else {
        this.log(`resuming approval request for ${id} (ref ${String(req.data.referenceCode)})`);
        this.poll(req, handle);
      }
    }
    for (const req of set.stale) void this.recordLapse(req, "expired");
    for (const esc of set.interrupted) void this.recordFailure(esc, { phase: "resume", failure: "interrupted" });
  }

  stop(): void {
    this.stopped = true;
    for (const s of this.sleepers) {
      clearTimeout(s.timer);
      s.wake(false);
    }
    this.sleepers.clear();
  }

  // -------------------------------------------------------------------------

  private sleep(ms: number): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    return new Promise((resolve) => {
      const s = {
        timer: setTimeout(() => {
          this.sleepers.delete(s);
          resolve(!this.stopped);
        }, ms),
        wake: resolve,
      };
      s.timer.unref?.();
      this.sleepers.add(s);
    });
  }

  private pendingAt(escalationId: string): boolean {
    return escalationState(this.d.ledger.entries(), escalationId, this.d.now()) === "pending";
  }

  /** escalationId, resourceKey, payTo and amount: copied from the ESCALATED entry (or a request entry that copied them). */
  private copied(e: LedgerEntry): Copied {
    const escalationId = e.type === "ESCALATED" ? e.authorizationId! : String(e.data.escalationId);
    return { escalationId, resourceKey: e.data.resourceKey, payTo: e.data.payTo, amount: e.data.amount };
  }

  private envelope(e: LedgerEntry, escalationId: string) {
    return { ...(e.sessionId !== undefined && { sessionId: e.sessionId }), authorizationId: escalationId };
  }

  private async runStart(plan: StartPlan): Promise<void> {
    const id = plan.escalationId;
    const requestId = `apq_${randomUUID()}`;
    const details = paymentDetails({
      escalationId: id,
      requestId,
      resourceKey: plan.resourceKey,
      payTo: plan.payTo,
      amount: plan.amount,
      asset: String(plan.requirement.asset),
      network: String(plan.requirement.network),
      requirement: plan.requirement,
      decimals: this.d.decimals,
    });
    const message = bindingMessage({ amount: plan.amount, decimals: this.d.decimals, payTo: plan.payTo, resourceKey: plan.resourceKey, escalationId: id });
    const delays = this.d.retryDelaysMs ?? START_RETRY_DELAYS_MS;
    let attempts = 0;
    let result: StartResult | undefined;
    let sentAt = 0;
    let expiry = 0;
    for (let i = 0; i <= delays.length; i++) {
      if (i > 0 && !(await this.sleep(delays[i - 1]!))) return;
      if (this.stopped || !this.pendingAt(id)) return;
      sentAt = this.d.now();
      expiry = requestedExpirySeconds(plan.escalationExpiresAtMs, sentAt);
      if (expiry < 1) return;
      attempts++;
      result = await this.d.port.start({ bindingMessage: message, requestedExpiry: expiry, authorizationDetails: details });
      if (result.kind !== "transient") break;
    }
    if (!result || this.stopped) return;
    if (result.kind === "ok") {
      const ok = result;
      const req = await this.d.serialize(() => {
        const t = this.d.now();
        const entries = this.d.ledger.entries();
        const esc = findEscalation(entries, id);
        if (!esc || escalationState(entries, id, t) !== "pending") return undefined;
        return this.d.ledger.append(
          {
            type: "APPROVAL_REQUESTED",
            ...this.envelope(esc, id),
            data: {
              ...this.copied(esc),
              channel: "backchannel",
              requestId,
              issuer: this.d.issuer,
              approver: this.d.approver,
              referenceCode: referenceCode(id),
              bindingMessage: message,
              details,
              requestedExpirySec: expiry,
              requestExpiresAtMs: Math.min(sentAt + ok.expiresIn * 1000, plan.escalationExpiresAtMs),
              intervalSec: ok.interval,
              handleSealed: this.d.port.seal(ok.authReqId, `${id}|${requestId}`),
              attempts,
            },
          },
          t,
        );
      });
      if (req) {
        this.log(`approval request sent for ${id} (ref ${referenceCode(id)}, attempts ${attempts})`);
        this.poll(req, ok.authReqId);
      }
      return;
    }
    const failure = result.kind === "permanent" ? "permanent" : result.failure;
    await this.d.serialize(() => {
      const t = this.d.now();
      const entries = this.d.ledger.entries();
      const esc = findEscalation(entries, id);
      if (!esc || escalationState(entries, id, t) !== "pending" || approvalRequestState(entries, id) !== "requested") return;
      this.d.ledger.append(
        {
          type: "APPROVAL_REQUEST_FAILED",
          ...this.envelope(esc, id),
          data: {
            ...this.copied(esc),
            channel: "backchannel",
            phase: "start",
            failure,
            ...(result.httpStatus !== undefined && { httpStatus: result.httpStatus }),
            ...(result.kind === "permanent" && { error: result.error }),
            attempts,
          },
        },
        t,
      );
      this.log(`approval request for ${id} failed (${failure}${result.kind === "permanent" ? `, ${result.error}` : ""}); the operator path remains`);
    });
  }

  private poll(req: LedgerEntry, handle: string): void {
    const id = String(req.data.escalationId);
    if (this.polling.has(id)) return;
    this.polling.add(id);
    void this.pollLoop(req, handle)
      .catch(() => this.log(`polling for ${id} stopped on an internal error`))
      .finally(() => this.polling.delete(id));
  }

  private delayMs(intervalS: number): number {
    return this.d.pollDelayMs ? this.d.pollDelayMs(intervalS) : intervalS * 1000;
  }

  private async pollLoop(req: LedgerEntry, handle: string): Promise<void> {
    const id = String(req.data.escalationId);
    const requestId = String(req.data.requestId);
    const expiresAt = req.data.requestExpiresAtMs as number;
    let interval = typeof req.data.intervalSec === "number" && req.data.intervalSec > 0 ? req.data.intervalSec : DEFAULT_POLL_INTERVAL_S;
    let delayS = interval;
    for (;;) {
      if (!(await this.sleep(this.delayMs(delayS)))) return;
      if (!this.pendingAt(id)) return; // decided another way, or expired: abandoned, nothing to record
      if (activeApprovalRequest(this.d.ledger.entries(), id)?.data.requestId !== requestId) return;
      if (this.d.now() >= expiresAt) return void (await this.recordLapse(req, "expired"));
      const r: PollResult = await this.d.port.poll(handle);
      if (this.stopped) return;
      switch (r.kind) {
        case "pending":
          delayS = interval;
          continue;
        case "slow_down":
          interval = Math.max(r.interval ?? 0, interval + SLOW_DOWN_STEP_S);
          delayS = interval;
          continue;
        case "transient":
          delayS = Math.min(interval * 2, MAX_TRANSIENT_POLL_DELAY_S);
          continue;
        case "denied":
          if (this.d.now() <= expiresAt - REFUSAL_MARGIN_MS) await this.recordRefusal(req);
          else await this.recordLapse(req, "late_refusal");
          return;
        case "expired":
          await this.recordLapse(req, "expired");
          return;
        case "permanent":
          await this.recordFailure(req, { phase: "poll", failure: "permanent", httpStatus: r.httpStatus, error: r.error });
          return;
        case "token":
          await this.recordToken(req, r.accessToken, r.responseDetails);
          return;
      }
    }
  }

  private verify(req: LedgerEntry, token: string, responseDetails: unknown): Promise<VerificationResult> {
    return verifyApprovalToken(
      token,
      {
        issuer: this.d.issuer,
        audience: this.d.audience,
        clientId: this.d.clientId,
        approver: this.d.approver,
        requestId: String(req.data.requestId),
        sentDetails: req.data.details,
      },
      {
        keys: this.d.keys,
        nowMs: this.d.now(),
        ...(responseDetails !== undefined && { responseDetails }),
        answerIdUsed: (answerId) => answerIdUsed(this.d.ledger.entries(), answerId),
        ...(this.d.skipChecks && { skipChecks: this.d.skipChecks }),
      },
    );
  }

  private async recordToken(req: LedgerEntry, token: string, responseDetails: unknown): Promise<void> {
    const id = String(req.data.escalationId);
    const requestId = String(req.data.requestId);
    if (this.d.serializeOutcomes === false) {
      // Must-fail proof only (T-CIBA-10): check, await, append, with nothing holding the state in between.
      if (openApprovalRequest(this.d.ledger.entries(), id, this.d.now())?.data.requestId !== requestId) return;
      const result = await this.verify(req, token, responseDetails);
      this.appendTokenOutcome(req, result, this.d.now());
      return;
    }
    const result = await this.verify(req, token, responseDetails); // outside the lock: may fetch the JWKS
    await this.d.serialize(() => {
      const t = this.d.now();
      const entries = this.d.ledger.entries();
      if (openApprovalRequest(entries, id, t)?.data.requestId !== requestId) return; // abandoned or ended meanwhile
      const replayed = result.ok && !this.d.skipChecks?.has("replay") && answerIdUsed(entries, result.evidence.answerId);
      this.appendTokenOutcome(req, replayed ? { ok: false, check: "replay" } : result, t);
    });
  }

  private appendTokenOutcome(req: LedgerEntry, result: VerificationResult, t: number): void {
    const id = String(req.data.escalationId);
    const requestId = String(req.data.requestId);
    if (!result.ok) {
      this.d.ledger.append(
        { type: "APPROVAL_VERIFICATION_FAILED", ...this.envelope(req, id), data: { ...this.copied(req), channel: "backchannel", requestId, check: result.check } },
        t,
      );
      this.log(`approval answer for ${id} failed verification (${result.check}); the escalation stays pending`);
      return;
    }
    const approvalId = `apr_${randomUUID()}`;
    this.d.ledger.append(
      {
        type: "HUMAN_APPROVAL",
        ...this.envelope(req, id),
        data: {
          approvalId,
          ...this.copied(req),
          approver: result.evidence.subject,
          expiresAtMs: t + DEFAULT_APPROVAL_TTL_SECONDS * 1000,
          channel: "backchannel",
          requestId,
          evidence: result.evidence,
        },
      },
      t,
    );
    this.log(`approved through the backchannel: ${id} (${approvalId})`);
  }

  private async recordRefusal(req: LedgerEntry): Promise<void> {
    const id = String(req.data.escalationId);
    const requestId = String(req.data.requestId);
    await this.d.serialize(() => {
      const t = this.d.now();
      const entries = this.d.ledger.entries();
      if (escalationState(entries, id, t) !== "pending" || activeApprovalRequest(entries, id)?.data.requestId !== requestId) return;
      const rejectionId = `rej_${randomUUID()}`;
      this.d.ledger.append(
        {
          type: "HUMAN_REJECTION",
          ...this.envelope(req, id),
          data: { rejectionId, ...this.copied(req), channel: "backchannel", approver: this.d.approver, issuer: this.d.issuer, requestId },
        },
        t,
      );
      this.log(`refused through the backchannel: ${id} (${rejectionId})`);
    });
  }

  private async recordLapse(req: LedgerEntry, cause: "expired" | "late_refusal"): Promise<void> {
    const id = String(req.data.escalationId);
    const requestId = String(req.data.requestId);
    await this.d.serialize(() => {
      const t = this.d.now();
      const entries = this.d.ledger.entries();
      if (escalationState(entries, id, t) !== "pending" || activeApprovalRequest(entries, id)?.data.requestId !== requestId) return;
      this.d.ledger.append(
        {
          type: "APPROVAL_REQUEST_LAPSED",
          ...this.envelope(req, id),
          data: { ...this.copied(req), channel: "backchannel", requestId, cause, requestExpiresAtMs: req.data.requestExpiresAtMs },
        },
        t,
      );
      this.log(`approval request for ${id} lapsed (${cause}); the escalation stays pending for the operator`);
    });
  }

  /** From a request entry (poll, resume) or an ESCALATED entry (interrupted). */
  private async recordFailure(
    from: LedgerEntry,
    f: { phase: "poll" | "resume"; failure: "permanent" | "interrupted" | "unrecoverable"; httpStatus?: number; error?: string },
  ): Promise<void> {
    const c = this.copied(from);
    const requestId = from.type === "APPROVAL_REQUESTED" ? String(from.data.requestId) : undefined;
    await this.d.serialize(() => {
      const t = this.d.now();
      const entries = this.d.ledger.entries();
      if (escalationState(entries, c.escalationId, t) !== "pending") return;
      if (requestId !== undefined ? activeApprovalRequest(entries, c.escalationId)?.data.requestId !== requestId : approvalRequestState(entries, c.escalationId) !== "requested") return;
      this.d.ledger.append(
        {
          type: "APPROVAL_REQUEST_FAILED",
          ...this.envelope(from, c.escalationId),
          data: {
            ...c,
            channel: "backchannel",
            ...(requestId !== undefined && { requestId }),
            phase: f.phase,
            failure: f.failure,
            ...(f.httpStatus !== undefined && { httpStatus: f.httpStatus }),
            ...(f.error !== undefined && { error: f.error }),
          },
        },
        t,
      );
      this.log(`approval request for ${c.escalationId} failed (${f.phase}, ${f.failure}${f.error ? `, ${f.error}` : ""}); the operator path remains`);
    });
  }
}
