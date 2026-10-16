// L1-5 Composition root of the agent process (SPEC.md §8.1). It wires L1 to L2 and L3 over HTTP and
// holds no key material. It refuses to start if the payer key is visible (INV-3, SEC-2).
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { loadEnv, serviceUrls, tokenFor } from "./shared/config.js";

export const REFUSAL =
  "refusing to start: PAYER_PRIVATE_KEY is visible to the agent process. The payer key belongs only to L2 (INV-3).";

export const DEFAULT_GOAL =
  "Get today's weather for Lima and a short market brief, then give me a receipt list of what you bought.";

export function resolveSessionId(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SESSION_ID;
  return configured && configured.length > 0 ? configured : `sess_${randomBytes(4).toString("hex")}`;
}

async function main(argv: string[]): Promise<void> {
  loadEnv("l1-agent");
  // INV-3: this must stay the first check, before any network or LLM activity.
  if (process.env.PAYER_PRIVATE_KEY !== undefined) {
    console.error(REFUSAL);
    process.exit(1);
  }

  const { HttpAuthorizationGate, HttpSettlementVerifier } = await import("./layer1-intent/ports-http.js");
  const { PaidResourceOrchestrator } = await import("./layer1-intent/orchestrator.js");

  const urls = serviceUrls();
  const sessionId = resolveSessionId();
  const gate = new HttpAuthorizationGate(urls.control, tokenFor("agent-control"));
  const settlement = new HttpSettlementVerifier(urls.settlement, tokenFor("agent-verifier"));
  const orchestrator = new PaidResourceOrchestrator({ gate, settlement, sessionId });
  console.log(`session ${sessionId}`);

  const scripted = argv.includes("--scripted");
  if (scripted) {
    const { runScriptedAgent } = await import("./layer1-intent/scripted.js");
    await runScriptedAgent({ orchestrator, sellerUrl: urls.seller });
  } else {
    const { runClaudeAgent } = await import("./layer1-intent/agent.js");
    const goal = argv.filter((a) => !a.startsWith("--")).join(" ").trim() || DEFAULT_GOAL;
    const result = await runClaudeAgent({ goal, orchestrator, gate, sessionId, sellerUrl: urls.seller });
    console.log(result.finalText);
  }

  const budget = await gate.budget(sessionId);
  console.log(`budget ${JSON.stringify(budget)}`);
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
