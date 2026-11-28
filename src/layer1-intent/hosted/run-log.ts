// L1-6 run log (SPEC.md §11 SEC-16; specs/011 contracts/hosted-agent-api.md "Logs", research R13).
// One JSON line per tool call and one per run, built field by field from a whitelist: never headers,
// tokens, the session reference's MAC, the goal, `purpose`, tool error text or response bodies. The IDs
// (runId, requester `<issuer host>:<sub>`, sessionId, authorizationId) correlate a run with the L2 ledger (FR-025).
// 019: `client` names the client the caller's token was issued to (the docs page's, the desktop client, a machine
// caller's own), a public identifier, so a run can be traced to the way its person signed in (specs/019 FR-023).
// 021: the run line says which mode the run used (`search` or `test`), for the operator only (FR-003, FR-017); a search
// step's line has its outcome and the number of results, never the query, a listing's text or an address.
import type { RunStatus, StopReason } from "./agent.js";
import type { AgentMode } from "./config.js";

export interface StepLine {
  runId: string;
  requester: string;
  /** 019: the client of the caller's token. */
  client: string;
  sessionId: string;
  index: number;
  tool: string;
  outcome: string;
  intentId?: string;
  authorizationId?: string;
  /** 021: a search step's number of results. */
  results?: number;
  ms: number;
}

export interface RunLine {
  runId: string;
  requester: string;
  /** 019: the client of the caller's token. */
  client: string;
  sessionId: string;
  /** 021: the run's mode. */
  mode: AgentMode;
  status: RunStatus;
  stopReason: StopReason | null;
  steps: number;
  ms: number;
}

/** 017: an event of the service's edge, not of a run: the failed-authentication limit's burst, or an undeclared proxy. */
export interface EventLine {
  event: "auth_failure_limit" | "proxy_undeclared";
  count?: number;
}

export interface RunLog {
  step(e: StepLine): void;
  run(e: RunLine): void;
  /** 017: `{ event, count? }` and nothing else: never an address, a token, a path or a header. */
  event(e: EventLine): void;
}

export function createRunLog(write: (line: string) => void = (line) => process.stdout.write(line + "\n")): RunLog {
  return {
    step: (e) =>
      write(
        JSON.stringify({
          event: "step",
          runId: e.runId,
          requester: e.requester,
          client: e.client,
          sessionId: e.sessionId,
          index: e.index,
          tool: e.tool,
          outcome: e.outcome,
          ...(e.intentId !== undefined && { intentId: e.intentId }),
          ...(e.authorizationId !== undefined && { authorizationId: e.authorizationId }),
          ...(e.results !== undefined && { results: e.results }),
          ms: e.ms,
        }),
      ),
    run: (e) =>
      write(
        JSON.stringify({
          event: "run",
          runId: e.runId,
          requester: e.requester,
          client: e.client,
          sessionId: e.sessionId,
          mode: e.mode,
          status: e.status,
          stopReason: e.stopReason,
          steps: e.steps,
          ms: e.ms,
        }),
      ),
    event: (e) => write(JSON.stringify({ event: e.event, ...(e.count !== undefined && { count: e.count }) })),
  };
}

const SEARCH_OUTCOMES: Record<string, string> = { OK: "ok", UNAVAILABLE: "unavailable", LIMIT_REACHED: "limit_reached" };

/**
 * A step's outcome for the log: the fetch outcome, `ok` for a budget read, `error` when the tool threw. 021: a search's
 * `ok`, `unavailable` or `limit_reached`, and its number of results.
 */
export function stepOutcome(result: unknown, tool?: string): { outcome: string; authorizationId?: string; results?: number } {
  const r = result as { outcome?: unknown; error?: unknown; authorizationId?: unknown; results?: unknown } | null;
  if (tool === "search_resources") {
    if (r !== null && typeof r === "object" && typeof r.outcome === "string" && Array.isArray(r.results)) {
      return { outcome: SEARCH_OUTCOMES[r.outcome] ?? "error", results: r.results.length };
    }
    return { outcome: "error" };
  }
  if (r !== null && typeof r === "object" && typeof r.outcome === "string") {
    return { outcome: r.outcome, ...(typeof r.authorizationId === "string" && { authorizationId: r.authorizationId }) };
  }
  if (r !== null && typeof r === "object" && "error" in r) return { outcome: "error" };
  return { outcome: "ok" };
}
