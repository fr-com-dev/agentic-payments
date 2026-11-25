// L1-6 hosted agent (SPEC.md §8.1 L1-6; specs/011 research R1, R3, R4). A Mastra Agent used as a library
// with exactly the two L1-3 tools and nothing a framework could add: no memory, workspace, sub-agents,
// workflows, processors or Mastra instance (SEC-1). Tools never sign, approve or reject; `purpose` reaches
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

export const MAX_STEPS = 10;
export const MAX_OUTPUT_TOKENS = 2048;
/** Same as the Anthropic SDK default in the L1-3 loop. A retried model call never re-runs a tool. */
export const MODEL_MAX_RETRIES = 2;
const ERROR_DETAIL_MAX = 300;

export type RunStatus = "completed" | "stopped" | "failed";
export type StopReason = "deadline" | "step_limit" | "client_disconnected";
const STOP_REASONS: readonly StopReason[] = ["deadline", "step_limit", "client_disconnected"];

export interface RunStep {
  index: number;
  tool: string;
  url?: string;
  purpose?: string;
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
type Record_ = <T>(tool: string, input: { url?: string; purpose?: string }, fn: () => Promise<T>) => Promise<T>;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, ERROR_DETAIL_MAX);

export interface RunToolsDeps {
  orchestrator: Pick<PaidResourceOrchestrator, "fetchPaid">;
  gate: Pick<AuthorizationGatePort, "budget">;
  sessionId: string;
  record: Record_;
}

/** The only two tools (L1-3): names are the object keys the model sees; descriptions are L1-3's. */
export function createRunTools(d: RunToolsDeps): Record<"fetch_resource" | "check_budget", RunTool> {
  let decimals: number | undefined;
  // 016: the gate was made for the caller; for a person L2 answers with the user view (the daily ceiling).
  const budget = () => d.gate.budget(d.sessionId);
  return {
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
}

export function buildAgent(o: { model: MastraModelConfig; sellerUrl: string; tools: Record<string, RunTool> }): Agent {
  const agent = new Agent({
    id: "x402-buyer",
    name: "x402 buyer",
    instructions: systemPrompt(o.sellerUrl),
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
  /** Test hook (T-AGT-02 must-fail): extra tools beside the two. Never set by the server. */
  extraTools?: Record<string, RunTool>;
  /** Called once per finished tool call, in completion order, with its duration (run log). */
  onStep?: (step: RunStep, ms: number) => void;
  /** 016: called with each piece of text as the model writes it (the run stream). Absent: the text is only collected. */
  onText?: (delta: string) => void;
}

const reasonOf = (signal: AbortSignal): StopReason =>
  STOP_REASONS.includes(signal.reason as StopReason) ? (signal.reason as StopReason) : "deadline";

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
  // at an internal address or another site.
  const orchestrator = new PaidResourceOrchestrator({
    gate: o.gate,
    settlement: o.settlement,
    sessionId: o.sessionId,
    allowedHosts: [new URL(o.sellerUrl).host],
  });
  const tools = {
    ...createRunTools({ orchestrator, gate: o.gate, sessionId: o.sessionId, record }),
    ...o.extraTools,
  };
  const agent = buildAgent({ model: o.model, sellerUrl: o.sellerUrl, tools });

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
