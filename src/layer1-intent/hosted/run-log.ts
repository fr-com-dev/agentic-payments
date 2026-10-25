// L1-6 run log (SPEC.md §11 SEC-16; specs/011 contracts/hosted-agent-api.md "Logs", research R13).
// One JSON line per tool call and one per run, built field by field from a whitelist: never headers,
// tokens, the session reference's MAC, the goal, `purpose`, tool error text or response bodies. The IDs
// (runId, requester tid:oid, sessionId, authorizationId) correlate a run with the L2 ledger (FR-025).
import type { RunStatus, StopReason } from "./agent.js";

export interface StepLine {
  runId: string;
  requester: string;
  sessionId: string;
  index: number;
  tool: string;
  outcome: string;
  intentId?: string;
  authorizationId?: string;
  ms: number;
}

export interface RunLine {
  runId: string;
  requester: string;
  sessionId: string;
  status: RunStatus;
  stopReason: StopReason | null;
  steps: number;
  ms: number;
}

export interface RunLog {
  step(e: StepLine): void;
  run(e: RunLine): void;
}

export function createRunLog(write: (line: string) => void = (line) => process.stdout.write(line + "\n")): RunLog {
  return {
    step: (e) =>
      write(
        JSON.stringify({
          event: "step",
          runId: e.runId,
          requester: e.requester,
          sessionId: e.sessionId,
          index: e.index,
          tool: e.tool,
          outcome: e.outcome,
          ...(e.intentId !== undefined && { intentId: e.intentId }),
          ...(e.authorizationId !== undefined && { authorizationId: e.authorizationId }),
          ms: e.ms,
        }),
      ),
    run: (e) =>
      write(
        JSON.stringify({
          event: "run",
          runId: e.runId,
          requester: e.requester,
          sessionId: e.sessionId,
          status: e.status,
          stopReason: e.stopReason,
          steps: e.steps,
          ms: e.ms,
        }),
      ),
  };
}

/** A step's outcome for the log: the fetch outcome, `ok` for a budget read, `error` when the tool threw. */
export function stepOutcome(result: unknown): { outcome: string; authorizationId?: string } {
  const r = result as { outcome?: unknown; error?: unknown; authorizationId?: unknown } | null;
  if (r !== null && typeof r === "object" && typeof r.outcome === "string") {
    return { outcome: r.outcome, ...(typeof r.authorizationId === "string" && { authorizationId: r.authorizationId }) };
  }
  if (r !== null && typeof r === "object" && "error" in r) return { outcome: "error" };
  return { outcome: "ok" };
}
