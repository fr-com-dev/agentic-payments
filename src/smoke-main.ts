// The smoke client (SPEC.md §3.1 Azure profile, §8.1 L1-5, §11 SEC-33; specs/016 research R9). The deployment
// pipeline's hosted smoke run, as a machine caller of its own: it gets a client-credentials token from the sign-in
// tenant (src/machine-caller/token.ts), sends one goal to the hosted agent, checks the answer and exits 0 or 1.
// In Azure it is a Container Apps job the pipeline starts and whose outcome it reads, so the pipeline never holds a
// token and GitHub never holds the caller's key.
//
// It calls the agent's public API and nothing else: no L2, no L3, no seller. It prints the target, the outcome and
// the duration, never the token. Like every L1 entry point it refuses to start if the payer key is visible.
import { pathToFileURL } from "node:url";
import { REFUSAL } from "./refusal.js";
import { loadEnv } from "./shared/config.js";

/** The goal of the smoke run: two purchases under the auto-approve limit, so nothing escalates. */
export const SMOKE_GOAL = "Get today's weather for Lima and a short market brief, then give me a receipt list of what you bought.";
/** What the run must have bought, each paid and confirmed on-chain. */
export const SMOKE_PURCHASES = ["/api/weather", "/api/market-brief"] as const;
/** SC-009 of 011: the run is expected within this time. */
export const SMOKE_MAX_SECONDS = 120;
/** Longer than the agent's own deadline (200 s), so its answer is always read. */
const REQUEST_TIMEOUT_MS = 210_000;
const HEALTH_TIMEOUT_MS = 5_000;

export interface SmokeOptions {
  /** The agent's address. */
  agentUrl: string;
  /** The agent's candidate revision's address: used while it answers (an L1 deployment in progress). */
  candidateUrl?: string;
  /** The machine caller's token. */
  token: () => Promise<string>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  maxSeconds?: number;
}

export interface SmokeResult {
  ok: boolean;
  /** The address the goal was sent to. */
  target: string;
  seconds: number;
  /** Why it failed; absent when it passed. Never carries the token or the agent's answer. */
  reason?: string;
}

interface Step {
  url?: unknown;
  result?: { outcome?: unknown; payment?: { settlement?: { status?: unknown } } };
}

const trimSlash = (u: string) => u.replace(/\/+$/, "");

/** The candidate revision when it answers its health route, the agent otherwise. */
async function targetOf(o: SmokeOptions, fetchImpl: typeof fetch): Promise<string> {
  if (o.candidateUrl === undefined || o.candidateUrl === "") return trimSlash(o.agentUrl);
  const candidate = trimSlash(o.candidateUrl);
  try {
    const res = await fetchImpl(`${candidate}/healthz`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (res.status === 200) return candidate;
  } catch {
    // No candidate revision right now: the agent's own address is the one to check.
  }
  return trimSlash(o.agentUrl);
}

/** What is wrong with a run's answer, or undefined when it is what the smoke run expects. */
export function smokeFailure(status: number, body: unknown): string | undefined {
  if (status !== 200) return `the agent answered HTTP ${status}`;
  const run = body as { status?: unknown; steps?: unknown } | null;
  if (run === null || typeof run !== "object") return "the agent's answer was not a run";
  if (run.status !== "completed") return `the run ended as ${String(run.status)}`;
  const steps: Step[] = Array.isArray(run.steps) ? (run.steps as Step[]) : [];
  for (const path of SMOKE_PURCHASES) {
    const paid = steps.some((s) => typeof s.url === "string" && s.url.includes(path) && s.result?.outcome === "PAID" && s.result.payment?.settlement?.status === "CONFIRMED");
    if (!paid) return `${path} was not paid and confirmed`;
  }
  if (steps.some((s) => s.result?.outcome === "ESCALATED")) return "a purchase escalated";
  return undefined;
}

export async function runSmoke(o: SmokeOptions): Promise<SmokeResult> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const target = await targetOf(o, fetchImpl);
  const started = now();
  const seconds = () => Math.round((now() - started) / 1000);
  let token: string;
  try {
    token = await o.token();
  } catch (e) {
    return { ok: false, target, seconds: seconds(), reason: e instanceof Error ? e.message : "no token" };
  }
  let status: number;
  let body: unknown;
  try {
    const res = await fetchImpl(`${target}/v1/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ goal: SMOKE_GOAL }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch {
    return { ok: false, target, seconds: seconds(), reason: "the agent could not be reached" };
  }
  const took = seconds();
  const failure = smokeFailure(status, body);
  if (failure !== undefined) return { ok: false, target, seconds: took, reason: failure };
  const max = o.maxSeconds ?? SMOKE_MAX_SECONDS;
  if (took > max) return { ok: false, target, seconds: took, reason: `the run took ${took} s, over ${max} s` };
  return { ok: true, target, seconds: took };
}

async function main(): Promise<number> {
  loadEnv("l1-agent");
  // INV-3: this must stay the first check, before any network activity.
  if (process.env.PAYER_PRIVATE_KEY !== undefined) {
    console.error(REFUSAL);
    return 1;
  }
  const agentUrl = process.env.AGENT_URL;
  if (agentUrl === undefined || agentUrl === "") {
    console.error("smoke: AGENT_URL is required (the hosted agent's address)");
    return 1;
  }
  const { callerTokenSourceFromEnv } = await import("./machine-caller/token.js");
  const token = callerTokenSourceFromEnv(process.env);
  if (token === undefined) {
    console.error("smoke: MACHINE_CLIENT_ID is required (the machine caller's client), or locally CALLER_TOKEN");
    return 1;
  }
  const candidateUrl = process.env.AGENT_CANDIDATE_URL;
  const r = await runSmoke({ agentUrl, ...(candidateUrl !== undefined && candidateUrl !== "" && { candidateUrl }), token });
  console.log(`smoke: ${r.target} ${r.seconds}s (target: ${SMOKE_MAX_SECONDS} s) ${r.ok ? "ok" : `failed: ${r.reason ?? "unknown"}`}`);
  return r.ok ? 0 : 1;
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`smoke: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
