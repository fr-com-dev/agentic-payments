// Shared demo helpers (feature 008 demo-local, feature 009 demo-base-sepolia; SPEC.md §12, §13).
// Env reading, child environments, detached process groups, readiness polling and the summary.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { formatAtomic } from "../src/shared/config.js";
import { GANACHE_NOISE, localAddress, localDevKeys } from "./local-chain-lib.js";
import { RegressionBaseline } from "../test/helpers/baseline.js";

export interface DemoProcess {
  role: string;
  /** Log prefix. */
  tag: string;
  entry: string;
  args: string[];
  /** Explicit env file (data-model DemoProcess); null for the chain. */
  envFile: string | null;
}

export interface EnvFile {
  path: string;
  values: Record<string, string>;
}

export const ROOT = resolve(import.meta.dirname, "..");
export const TSX = resolve(ROOT, "node_modules/.bin/tsx");
export const READY_TIMEOUT_MS = 30_000;
export const POLL_MS = 250;
const KILL_GRACE_MS = 3_000;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Env files. Parsed here only to learn ports, tokens and empty keys; children load their own file
// through loadEnv(). Only src/shared/config.ts may use dotenv (architecture test), so this is a
// minimal KEY=VALUE reader.
// ---------------------------------------------------------------------------

export function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

/** The file a child loads: its own env file, or the `.example` defaults when it is missing (T015). */
export function envFileFor(p: DemoProcess, opts: { allowExample?: boolean } = {}): EnvFile | null {
  if (p.envFile === null) return null;
  const real = resolve(ROOT, p.envFile);
  const path = existsSync(real) || opts.allowExample === false ? real : `${real}.example`;
  if (!existsSync(path)) {
    throw new Error(opts.allowExample === false ? `missing ${p.envFile}` : `missing ${p.envFile} and ${p.envFile}.example`);
  }
  return { path, values: parseEnvFile(path) };
}

/**
 * T015: children inherit only PATH, HOME and NODE_* plus their own ENV_FILE. On NETWORK=local, missing
 * keys come from the CP-5 mnemonic: #2 only to l2, #1 only to the facilitator. The seller's payTo and
 * L2's payee allowlist default to #3 when empty. Off local nothing is derived.
 */
export function childEnv(p: DemoProcess, file: EnvFile | null, opts: { network: string; sessionId: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith("NODE_") && v !== undefined) env[k] = v;
  if (file) env.ENV_FILE = file.path;
  const value = (key: string) => file?.values[key] || undefined;
  const local = opts.network === "local";
  const { network: NETWORK } = opts;
  if (p.role === "l2" && local) {
    if (!value("PAYER_PRIVATE_KEY")) env.PAYER_PRIVATE_KEY = localDevKeys({ NETWORK }).payer;
    if (!value("ALLOWED_PAYEES")) env.ALLOWED_PAYEES = localAddress("sellerPayTo");
  }
  if (p.role === "facilitator" && local && !value("FACILITATOR_PRIVATE_KEY")) {
    env.FACILITATOR_PRIVATE_KEY = localDevKeys({ NETWORK }).facilitator;
  }
  if (p.role === "seller" && local && !value("SELLER_PAY_TO")) env.SELLER_PAY_TO = localAddress("sellerPayTo");
  if (p.role === "agent") env.SESSION_ID = opts.sessionId;
  return env;
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

export interface Running {
  p: DemoProcess;
  child: ChildProcess;
  exited: Promise<number | null>;
  done: boolean;
}

function forward(tag: string, stream: NodeJS.ReadableStream, sink: (line: string) => void, onLine?: (l: string) => void) {
  createInterface({ input: stream }).on("line", (line) => {
    if (GANACHE_NOISE.test(line)) return; // FR-007: drop ganache's harmless uws fallback notice
    onLine?.(line);
    sink(`[${tag}] ${line}`);
  });
}

const killGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: the group is already gone.
  }
};

/** Detached process groups for one demo run; `crash` records the first unexpected exit. */
export class ProcessGroup {
  readonly running: Running[] = [];
  crash: string | null = null;
  #shuttingDown = false;
  readonly #ports: number[];

  constructor(ports: number[]) {
    this.#ports = ports;
  }

  start(p: DemoProcess, env: NodeJS.ProcessEnv, onLine?: (l: string) => void): Running {
    // T016: detached, so the child leads its own process group (pgid = pid).
    const child = spawn(TSX, [p.entry, ...p.args], { cwd: ROOT, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    forward(p.tag, child.stdout!, (l) => console.log(l), onLine);
    forward(p.tag, child.stderr!, (l) => console.error(l), onLine);
    const r: Running = { p, child, done: false, exited: Promise.resolve(null) };
    r.exited = new Promise((res) =>
      child.once("exit", (code) => {
        r.done = true;
        if (!this.#shuttingDown && p.role !== "agent") this.crash ??= `${p.role} exited unexpectedly (code ${code})`;
        res(code);
      }),
    );
    this.running.push(r);
    return r;
  }

  /** T018: reverse order, SIGTERM to each process group, SIGKILL after 3 s. */
  async shutdown(): Promise<void> {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    for (const r of [...this.running].reverse()) {
      const pid = r.child.pid;
      if (pid === undefined) continue;
      killGroup(pid, "SIGTERM");
      const timer = new Promise<"timeout">((res) => setTimeout(() => res("timeout"), KILL_GRACE_MS));
      await Promise.race([r.exited, timer]);
      killGroup(pid, "SIGKILL"); // grandchildren (tsx runs node in a child process) go too
    }
    await waitPortsFree(this.#ports, 5_000);
  }

  /** T017: poll every 250 ms for up to 30 s. */
  async waitReady(role: string, ready: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.crash) throw new Error(this.crash);
      if (await ready()) return;
      await sleep(POLL_MS);
    }
    throw new Error(`readiness timeout: ${role} not ready after ${READY_TIMEOUT_MS / 1000} s`);
  }
}

// ---------------------------------------------------------------------------
// Ports and HTTP
// ---------------------------------------------------------------------------

export function portInUse(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = connect({ port, host: "127.0.0.1" });
    const done = (busy: boolean) => {
      s.destroy();
      res(busy);
    };
    s.setTimeout(300, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

export async function waitPortsFree(ports: number[], maxMs: number): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const busy = await Promise.all(ports.map(portInUse));
    if (!busy.some(Boolean)) return;
    await sleep(POLL_MS);
  }
}

export async function httpOk(url: string, headers: Record<string, string> = {}, init: RequestInit = {}): Promise<boolean> {
  try {
    const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(1_000) });
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function getJson<T>(url: string, token: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) });
    return res.status === 200 ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Summary (T020, R8): only authoritative sources (chain balance, /v1/budget, /v1/ledger/verify).
// ---------------------------------------------------------------------------

export interface DemoSummary {
  network: string;
  session: string;
  outcomes: string[];
  spentAtomic: bigint;
  budget: { spentOrReservedAtomic: string; remainingAtomic: string } | null;
  chain: { ok: boolean; entries: number } | null;
}

/** Printed last (contract). `extra` lines go before the closing rule (009 live run). */
export function printSummary(s: DemoSummary, extra: string[] = [], llm = false): void {
  const lines = [
    "==== demo summary ====",
    `network:            ${s.network}`,
    `session:            ${s.session}`,
    `outcomes:           ${s.outcomes.join(", ")}${llm ? "   (llm run, not asserted)" : ""}`,
    `spent on-chain: ${formatAtomic(s.spentAtomic.toString(), 6)} USDC`,
    s.budget
      ? `budget:             spentOrReserved=${s.budget.spentOrReservedAtomic} remaining=${s.budget.remainingAtomic} (atomic)`
      : "budget:             unavailable",
    s.chain ? `hash chain ok=${s.chain.ok} entries=${s.chain.entries}` : "hash chain ok=unknown",
    ...extra,
    "======================",
  ];
  console.log(lines.join("\n"));
}

/** T028: compare with the shared RegressionBaseline. */
export function matchesBaseline(s: DemoSummary): boolean {
  return (
    JSON.stringify(s.outcomes) === JSON.stringify(RegressionBaseline.outcomes) &&
    s.spentAtomic === BigInt(RegressionBaseline.onChainDeltaAtomic) &&
    s.chain?.ok === RegressionBaseline.ledgerChainOk &&
    s.budget?.spentOrReservedAtomic === RegressionBaseline.spentOrReservedAtomic
  );
}

/** The scripted agent's result lines: `<i>. <OUTCOME> <url> …` (L1-4 describeResult). */
export const OUTCOME_LINE = /^\d+\. ([A-Z_]+) /;
