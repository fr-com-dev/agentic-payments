// L1-3 Claude agent (SPEC.md §8.1): a bounded tool-use loop. The model gets exactly two tools and
// none of them can sign, approve or edit policy (SEC-1). Its `purpose` text travels to L2 for audit
// only (INV-5). Amounts stay atomic strings; `amountUsd` is a display value.
import Anthropic from "@anthropic-ai/sdk";
import type { Message, MessageCreateParamsNonStreaming, MessageParam, Tool, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { formatAtomic } from "../shared/config.js";
import type { AuthorizationGatePort } from "../shared/contracts.js";
import type { PaidFetchResult, PaidResourceOrchestrator } from "./orchestrator.js";

export const DEFAULT_MODEL = "claude-sonnet-5-5";
export const MAX_TOKENS = 2048;
export const MAX_TURNS = 10;

/** The only two tools the model ever sees (SPEC v1.1 L1-3; descriptions are fixed). */
export const AGENT_TOOLS: Tool[] = [
  {
    name: "fetch_resource",
    description:
      "Fetch an HTTP resource. If it costs money, payment is requested from the Control layer, which may authorize, deny or escalate it. You cannot sign or approve payments.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string" }, purpose: { type: "string" } },
      required: ["url", "purpose"],
    },
  },
  {
    name: "check_budget",
    description: "Return the session budget as reported by the Control layer.",
    input_schema: { type: "object", properties: {} },
  },
];

export function systemPrompt(sellerUrl: string): string {
  const seller = sellerUrl.replace(/\/+$/, "");
  return [
    "You are a purchasing agent that buys HTTP resources priced with x402 stablecoin micropayments.",
    "You cannot sign, approve or change payment policy. A separate Control layer decides every payment.",
    `Start at ${seller}/api/catalog to see what is available and what it costs.`,
    "Prices are in atomic units of the asset (USDC has 6 decimals: 1000 atomic units = $0.001).",
    "Buy only what the goal needs, and prefer cheaper items.",
    "Never retry a DENIED payment; explain which rule blocked it.",
    "If a payment is ESCALATED, report its authorizationId so a human can approve it.",
    "End with a receipt list: resource, USD, settlement status, tx.",
  ].join("\n");
}

/** Minimal client surface so tests can inject a fake (L1-3 `opts.client`). */
export interface MessagesClient {
  messages: { create(params: MessageCreateParamsNonStreaming): Promise<Message> };
}

export interface ToolResultJson {
  outcome: PaidFetchResult["outcome"];
  httpStatus: number | null;
  body: unknown;
  payment: { authorizationId: string; amountUsd: string; settlement: { status: string | null; tx: string | null; finality: string | null } } | null;
  violations: PaidFetchResult["violations"] | null;
  authorizationId: string | null;
  error: string | null;
}

export function toToolResult(r: PaidFetchResult, decimals: number): ToolResultJson {
  return {
    outcome: r.outcome,
    httpStatus: r.httpStatus ?? null,
    body: r.body ?? null,
    payment: r.payment
      ? {
          authorizationId: r.payment.authorizationId,
          amountUsd: formatAtomic(r.payment.amountAtomic, decimals),
          settlement: {
            status: r.payment.settlement?.status ?? null,
            tx: r.payment.settlement?.transaction ?? null,
            finality: r.payment.settlement?.finalityClass ?? null,
          },
        }
      : null,
    violations: r.violations ?? null,
    authorizationId: r.authorizationId ?? null,
    error: r.error ?? null,
  };
}

export interface ClaudeAgentOptions {
  goal: string;
  orchestrator: Pick<PaidResourceOrchestrator, "fetchPaid">;
  gate: Pick<AuthorizationGatePort, "budget">;
  sessionId: string;
  sellerUrl: string;
  client?: MessagesClient;
  model?: string;
  /** Asset decimals for display. When absent, read once from the L2 budget. */
  decimals?: number;
}

export interface ClaudeAgentResult {
  finalText: string;
  turns: number;
  stopReason: string | null;
}

export async function runClaudeAgent(opts: ClaudeAgentOptions): Promise<ClaudeAgentResult> {
  const client: MessagesClient = opts.client ?? new Anthropic();
  const model = opts.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
  const system = systemPrompt(opts.sellerUrl);
  const messages: MessageParam[] = [{ role: "user", content: opts.goal }];
  let decimals = opts.decimals;
  let last: Message | undefined;
  let turns = 0;

  while (turns < MAX_TURNS) {
    turns++;
    last = await client.messages.create({ model, max_tokens: MAX_TOKENS, system, tools: AGENT_TOOLS, messages });
    messages.push({ role: "assistant", content: last.content });
    const calls = last.content.filter((b) => b.type === "tool_use");
    if (last.stop_reason !== "tool_use" || calls.length === 0) break;

    const results: ToolResultBlockParam[] = [];
    for (const call of calls) {
      let content: unknown;
      let isError = false;
      try {
        if (call.name === "fetch_resource") {
          const input = call.input as { url?: unknown; purpose?: unknown };
          if (typeof input.url !== "string" || typeof input.purpose !== "string") {
            throw new Error("fetch_resource needs string url and purpose");
          }
          const r = await opts.orchestrator.fetchPaid(input.url, input.purpose);
          if (r.payment && decimals === undefined) decimals = (await opts.gate.budget(opts.sessionId)).decimals;
          content = toToolResult(r, decimals ?? 6);
        } else if (call.name === "check_budget") {
          content = await opts.gate.budget(opts.sessionId);
        } else {
          isError = true;
          content = { error: `unknown tool: ${call.name}` };
        }
      } catch (e) {
        isError = true;
        content = { error: e instanceof Error ? e.message : String(e) };
      }
      results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(content), ...(isError && { is_error: true }) });
    }
    messages.push({ role: "user", content: results });
  }

  const finalText = (last?.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n");
  return { finalText, turns, stopReason: last?.stop_reason ?? null };
}
