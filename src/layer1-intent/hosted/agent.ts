// L1-6 hosted agent (SPEC.md §8.1 L1-6; specs/011 research R1, R3, R4). A Mastra Agent used as a library
// with exactly the two L1-3 tools and nothing a framework could add: no memory, workspace, sub-agents,
// workflows, processors or Mastra instance (SEC-1). 021 (EXT-10): in search mode a third tool, read-only,
// `search_resources`, searches the public x402 discovery index (./discovery.ts); in test mode the agent is the one of
// before 021, byte for byte. The mode is the operator's setting, fixed when the run starts, and nothing the model sees
// names it (FR-001..004). Tools never sign, approve or reject; `purpose` reaches
// L2 as audit text only (INV-5). Mastra's own logger is silenced: a provider error object can carry the
// request body, and only the whitelisted run log may write (FR-026).
// 016: the model is always called through `agent.stream`, whichever form the answer takes, so the JSON answer and
// the event stream come from one path and can't differ (specs/016 research R7). `generate` was that same path plus
// collecting the output. Tools still start only after their model step has finished (`eagerToolExecution: false`).
import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import { noopLogger } from "@mastra/core/logger";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { AuthorizationGatePort, SettlementVerifierPort } from "../../shared/contracts.js";
import { AGENT_TOOLS, systemPrompt, toToolResult } from "../agent.js";
import { PaidResourceOrchestrator } from "../orchestrator.js";
import type { AgentMode } from "./config.js";
import { cutQuery, defaultDiscoveryUrl, LIMIT_REACHED, SEARCH_TIMEOUT_MS, searchResources, UNAVAILABLE, type SearchNetwork, type SearchOutput } from "./discovery.js";

// Rule A19: only this file imports the discovery client; the server names its network type through here.
export type { SearchNetwork, SearchOutput } from "./discovery.js";

export const MAX_STEPS = 10;
export const MAX_OUTPUT_TOKENS = 2048;
/** Same as the Anthropic SDK default in the L1-3 loop. A retried model call never re-runs a tool. */
export const MODEL_MAX_RETRIES = 2;
const ERROR_DETAIL_MAX = 300;
/** 021 (FR-009): searches one run may send to the index; later ones answer LIMIT_REACHED and send nothing. */
export const MAX_SEARCHES_PER_RUN = 3;
/**
 * 021 (NFR-004): the least search time worth a request. With less left the run's search time counts as spent: no
 * request could finish in it, and a timer that fired a fraction of a millisecond early must not buy another call.
 */
export const MIN_SEARCH_MS = 250;
/** 021 (FR-010): how long a run waits for L2's seller hosts before it goes on with the configured seller's only. */
export const SELLERS_TIMEOUT_MS = 2_000;
/** 021: `host[:port]`, as `new URL(...).host` gives it. */
const HOST_RE = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:]+\])(?::\d{1,5})?$/;

/** 021: the search tool's description (fixed; contracts/hosted-agent-api.md). It names no mode. */
export const SEARCH_TOOL_DESCRIPTION =
  "Search a public index of HTTP resources that take x402 payments. For each match it returns the URL, the price, the inputs it takes and whether you may buy from its seller (onSellerList). Searching is free and buys nothing.";

export type RunStatus = "completed" | "stopped" | "failed";
export type StopReason = "deadline" | "step_limit" | "client_disconnected";
const STOP_REASONS: readonly StopReason[] = ["deadline", "step_limit", "client_disconnected"];

export interface RunStep {
  index: number;
  tool: string;
  url?: string;
  purpose?: string;
  /** 021: a search step's query, as sent (cut to 200 characters). */
  query?: string;
  result: unknown;
}

export interface RunOutcome {
  status: RunStatus;
  stopReason: StopReason | null;
  error: string | null;
  finalText: string;
  steps: RunStep[];
}

type RunTool = ReturnType<typeof createTool>;
type Record_ = <T>(tool: string, input: { url?: string; purpose?: string; query?: string }, fn: () => Promise<T>) => Promise<T>;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, ERROR_DETAIL_MAX);

export interface RunToolsDeps {
  orchestrator: Pick<PaidResourceOrchestrator, "fetchPaid">;
  gate: Pick<AuthorizationGatePort, "budget">;
  sessionId: string;
  record: Record_;
  /**
   * 021, search mode only: one search of the discovery index, bounded and counted by the run. Absent (test mode): the
   * model is offered the two L1-3 tools and nothing else.
   */
  search?: (query: string) => Promise<SearchOutput>;
}

type RunTools = Record<"fetch_resource" | "check_budget", RunTool> & Partial<Record<"search_resources", RunTool>>;

/**
 * The tools (L1-3): names are the object keys the model sees; descriptions are L1-3's. 021: in search mode a third,
 * `search_resources`, after them. It reads the index only: it never fetches a listed address, never calls the gate,
 * the orchestrator or the settlement port, and never sees the caller's token (FR-005).
 */
export function createRunTools(d: RunToolsDeps): RunTools {
  let decimals: number | undefined;
  // 016: the gate was made for the caller; for a person L2 answers with the user view (the daily ceiling).
  const budget = () => d.gate.budget(d.sessionId);
  const tools: RunTools = {
    fetch_resource: createTool({
      id: "fetch_resource",
      description: AGENT_TOOLS[0]!.description!,
      inputSchema: z.object({ url: z.string(), purpose: z.string() }),
      // The abort signal is deliberately not passed to fetchPaid: a paid fetch in progress completes.
      execute: async ({ url, purpose }) =>
        d.record("fetch_resource", { url, purpose }, async () => {
          const r = await d.orchestrator.fetchPaid(url, purpose);
          if (r.payment && decimals === undefined) decimals = (await budget()).decimals;
          return toToolResult(r, decimals ?? 6);
        }),
    }) as RunTool,
    check_budget: createTool({
      id: "check_budget",
      description: AGENT_TOOLS[1]!.description!,
      inputSchema: z.object({}),
      // 019: `account` answers the agent's question before a person's run, never the model's: the tool's output
      // (and so a step's `result`) keeps the fields it had.
      execute: async () =>
        d.record("check_budget", {}, async () => {
          const { account: _account, ...status } = await budget();
          return status;
        }),
    }) as RunTool,
  };
  const search = d.search;
  if (search === undefined) return tools;
  return {
    ...tools,
    search_resources: createTool({
      id: "search_resources",
      description: SEARCH_TOOL_DESCRIPTION,
      inputSchema: z.object({ query: z.string() }).strict(),
      execute: async ({ query }) => {
        // Cut before it is recorded or sent: the step shows exactly what the index received.
        const q = cutQuery(query);
        return d.record("search_resources", { query: q }, () => search(q));
      },
    }) as RunTool,
  };
}

/**
 * 021 (FR-012): the search-mode prompt (contracts/hosted-agent-api.md), lines joined with `\n`. It names no mode, and
 * it tells the model to search for the kind of resource, never for what the person typed (FR-008).
 */
export function searchSystemPrompt(sellerUrl: string): string {
  const seller = sellerUrl.replace(/\/+$/, "");
  return [
    "You are a purchasing agent that buys HTTP resources priced with x402 stablecoin micropayments.",
    "You cannot sign, approve or change payment policy. A separate Control layer decides every payment.",
    "First use search_resources to look for resources that fit the goal.",
    'Search for the kind of resource you need, such as "current weather for a city". Never put names, addresses or other personal details from the goal in a search.',
    "Buy only results with onSellerList true. Never fetch a result with onSellerList false; you may tell the user it exists.",
    `If the search is unavailable, or no result on the seller list fits, read ${seller}/api/catalog and choose from it.`,
    "Fill a resource's inputs from the goal, and use only the inputs it declares.",
    "If nothing fits the goal, buy nothing, and say what you looked for and that nothing fits.",
    "Prices are in atomic units of the asset (USDC has 6 decimals: 1000 atomic units = $0.001).",
    "Buy only what the goal needs, and prefer cheaper items.",
    "Never retry a DENIED payment; explain which rule blocked it.",
    "If a payment is ESCALATED, report its authorizationId so a human can approve it.",
    "End with a receipt list: resource, USD, settlement status, tx.",
  ].join("\n");
}

export function buildAgent(o: { model: MastraModelConfig; sellerUrl: string; tools: Record<string, RunTool>; mode?: AgentMode }): Agent {
  const agent = new Agent({
    id: "x402-buyer",
    name: "x402 buyer",
    // 021: test mode keeps L1-3's prompt, unchanged.
    instructions: o.mode === "search" ? searchSystemPrompt(o.sellerUrl) : systemPrompt(o.sellerUrl),
    model: o.model,
    tools: o.tools,
    errorProcessorDefaults: false,
  });
  agent.__setLogger(noopLogger);
  return agent;
}

export interface RunGoalOptions {
  goal: string;
  sessionId: string;
  signal: AbortSignal;
  model: MastraModelConfig;
  gate: AuthorizationGatePort;
  settlement: SettlementVerifierPort;
  sellerUrl: string;
  /** 021: the run's mode, taken from the operator's setting when the run starts (FR-002). */
  mode: AgentMode;
  /**
   * 021, search mode: the index's search address (absent: the network's default) and the network a search filters
   * by. Without an address and a default, every search is UNAVAILABLE.
   */
  discovery?: { url?: string; network: SearchNetwork; fetchImpl?: typeof fetch };
  /** 021 test hook (T-DISC-02 must-fail): listings reach the model unfiltered. Never set by the server's entry point. */
  rawListings?: boolean;
  /** 021 test hook (T-AGT-23 must-fail): no cap on the searches of a run. Never set by the entry point. */
  skipSearchLimit?: boolean;
  /** 021 test hook (T-AGT-23 must-fail): no 5 s bound on a search or on a run's searches. Never set by the entry point. */
  skipSearchTimeout?: boolean;
  /** 021 test hook (T-AGT-22, T-E2E-18 must-fail): the run fetches any host, and every result is on the list. Never set by the entry point. */
  skipSellerList?: boolean;
  /** Test hook (T-AGT-02 must-fail): extra tools beside the two. Never set by the server. */
  extraTools?: Record<string, RunTool>;
  /** Called once per finished tool call, in completion order, with its duration (run log). */
  onStep?: (step: RunStep, ms: number) => void;
  /** 016: called with each piece of text as the model writes it (the run stream). Absent: the text is only collected. */
  onText?: (delta: string) => void;
}

const reasonOf = (signal: AbortSignal): StopReason =>
  STOP_REASONS.includes(signal.reason as StopReason) ? (signal.reason as StopReason) : "deadline";

/**
 * 021 (FR-010): the hosts L2 would pay at (`GET /v1/sellers`), asked once at a search-mode run's start, with
 * `CONTROL_TOKEN` only (INV-13). Raced against a 2 s timer, as the account question is: a gate without the read, an
 * error, a malformed answer or no answer in time gives [], and the run goes on with the configured seller's host only.
 */
export async function listedSellerHosts(gate: Pick<AuthorizationGatePort, "sellers">, timeoutMs: number = SELLERS_TIMEOUT_MS): Promise<string[]> {
  if (gate.sellers === undefined) return [];
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    // A read that fails after the timer is still handled: it resolves to null and is ignored.
    const read = Promise.resolve()
      .then(() => gate.sellers!())
      .then(
        (s) => s,
        () => null,
      );
    const answer = await Promise.race([read, timedOut]);
    if (answer === null || !Array.isArray(answer.hosts)) return [];
    return answer.hosts.filter((h): h is string => typeof h === "string" && h.length <= 260 && HOST_RE.test(h.toLowerCase())).map((h) => h.toLowerCase());
  } finally {
    clearTimeout(timer);
  }
}

export async function runGoal(o: RunGoalOptions): Promise<RunOutcome> {
  const steps: RunStep[] = [];
  const inflight = new Set<Promise<unknown>>();
  let next = 0;
  const record: Record_ = (tool, input, fn) => {
    const index = ++next;
    const startedMs = Date.now();
    const done = (result: unknown) => {
      const step: RunStep = { index, tool, ...input, result };
      steps.push(step);
      o.onStep?.(step, Date.now() - startedMs);
    };
    const p = fn().then(
      (result) => {
        done(result);
        return result;
      },
      (e: unknown) => {
        done({ error: errorText(e) });
        throw e;
      },
    );
    inflight.add(p);
    void p.finally(() => inflight.delete(p)).catch(() => undefined);
    return p;
  };

  // 1.19 (SEC-1): the model fetches the seller's host only. Neither the goal nor a fetched page can point the agent
  // at an internal address or another site. 021 (FR-010): in search mode, also the hosts L2 would pay at, read once
  // here; nothing a listing, the goal or the model says adds a host. Test mode never asks.
  const search = o.mode === "search";
  const sellerHost = new URL(o.sellerUrl).host;
  const hosts = search ? [...new Set([sellerHost, ...(await listedSellerHosts(o.gate))])] : [sellerHost];
  const orchestrator = new PaidResourceOrchestrator({
    gate: o.gate,
    settlement: o.settlement,
    sessionId: o.sessionId,
    ...(!(search && o.skipSellerList) && { allowedHosts: hosts }),
  });

  // 021 (FR-009, NFR-004): at most 3 searches reach the index in a run, and together they take at most 5 s: each call
  // gets what is left of the run's search time, and once it is spent (less than MIN_SEARCH_MS left) a search is
  // UNAVAILABLE without a request. So a
  // slow or unreachable index adds at most 5 s to a run, not 5 s a search. Any failure, the network's asset included,
  // is the fixed UNAVAILABLE.
  let searches = 0;
  let searchMs = 0;
  const searchOnce = async (query: string): Promise<SearchOutput> => {
    if (!o.skipSearchLimit && searches >= MAX_SEARCHES_PER_RUN) return { ...LIMIT_REACHED, results: [] };
    searches++;
    const d = o.discovery;
    const url = d === undefined ? undefined : (d.url ?? defaultDiscoveryUrl(d.network.name));
    if (d === undefined || url === undefined) return { ...UNAVAILABLE, results: [] };
    const left = SEARCH_TIMEOUT_MS - searchMs;
    if (!o.skipSearchTimeout && left < MIN_SEARCH_MS) return { ...UNAVAILABLE, results: [] };
    const started = performance.now();
    try {
      return await searchResources({
        url,
        query,
        network: d.network,
        sellerHosts: hosts,
        timeoutMs: left,
        ...(d.fetchImpl && { fetchImpl: d.fetchImpl }),
        ...(o.rawListings && { rawListings: true }),
        ...(o.skipSearchTimeout && { skipSearchTimeout: true }),
        ...(o.skipSellerList && { skipSellerList: true }),
      });
    } catch {
      return { ...UNAVAILABLE, results: [] };
    } finally {
      // Searches the model starts together each count in full, so the bound only gets stricter.
      searchMs += performance.now() - started;
    }
  };

  const tools = {
    ...createRunTools({ orchestrator, gate: o.gate, sessionId: o.sessionId, record, ...(search && { search: searchOnce }) }),
    ...o.extraTools,
  };
  const agent = buildAgent({ model: o.model, sellerUrl: o.sellerUrl, tools, mode: o.mode });

  const finish = async (out: Omit<RunOutcome, "steps">): Promise<RunOutcome> => {
    // A tool still running when the run ended (abort) completes and is listed (spec edge case).
    await Promise.allSettled([...inflight]);
    return { ...out, steps: [...steps].sort((a, b) => a.index - b.index) };
  };

  try {
    const stream = await agent.stream(o.goal, {
      maxSteps: MAX_STEPS,
      modelSettings: { maxOutputTokens: MAX_OUTPUT_TOKENS, maxRetries: MODEL_MAX_RETRIES },
      abortSignal: o.signal,
      // A tool runs when its model step has finished, as with `generate`: nothing starts on a half-written step.
      eagerToolExecution: false,
    });
    if (o.onText) {
      // Text only: tool calls, results and reasoning never leave through this callback. A model error ends the
      // stream here and is thrown by getFullOutput below.
      for await (const chunk of stream.fullStream) {
        if (chunk.type === "text-delta" && chunk.payload.text.length > 0) o.onText(chunk.payload.text);
      }
    }
    const r = await stream.getFullOutput();
    if (o.signal.aborted) return finish({ status: "stopped", stopReason: reasonOf(o.signal), error: null, finalText: r.text ?? "" });
    if (r.finishReason === "tool-calls") return finish({ status: "stopped", stopReason: "step_limit", error: null, finalText: r.text ?? "" });
    return finish({ status: "completed", stopReason: null, error: null, finalText: r.text ?? "" });
  } catch (e) {
    if (o.signal.aborted) return finish({ status: "stopped", stopReason: reasonOf(o.signal), error: null, finalText: "" });
    return finish({ status: "failed", stopReason: null, error: errorText(e), finalText: "" });
  }
}
