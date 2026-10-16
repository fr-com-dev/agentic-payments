// `npm run demo:local [-- --llm]` (SPEC.md §12, §13; feature 008 contracts/demo-local.md).
// Starts the six processes (chain, facilitator, seller, L2, L3, agent) as detached process groups,
// runs the agent, prints the summary last and frees every port.
//
// Exit codes: 0 baseline matched (or --llm completed with chain ok), 2 baseline mismatch,
// 1 port busy, readiness timeout, child crash or interrupt.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { createPublicClient, erc20Abi, http } from "viem";
import { CHAIN_PORT, DEFAULT_DEPLOYMENT_FILE, DEFAULT_PORTS, DEV_TOKENS, formatAtomic, type LocalDeployment } from "../src/shared/config.js";
import { GANACHE_NOISE, localAddress, localDevKeys } from "./local-chain-lib.js";
import { RegressionBaseline } from "../test/helpers/baseline.js";

type Role = "chain" | "facilitator" | "seller" | "l2" | "l3" | "agent";

interface DemoProcess {
  role: Role;
  /** Log prefix. */
  tag: string;
  entry: string;
  args: string[];
  /** Explicit env file (data-model DemoProcess); null for the chain. */
  envFile: string | null;
}

const LLM = process.argv.includes("--llm");
const ROOT = resolve(import.meta.dirname, "..");
const TSX = resolve(ROOT, "node_modules/.bin/tsx");
const READY_TIMEOUT_MS = 30_000;
const POLL_MS = 250;
const KILL_GRACE_MS = 3_000;

const PROCESSES: DemoProcess[] = [
  { role: "chain", tag: "chain", entry: "scripts/local-chain.ts", args: [], envFile: null },
  { role: "facilitator", tag: "fac", entry: "scripts/facilitator.ts", args: [], envFile: "env/facilitator.env" },
  { role: "seller", tag: "seller", entry: "src/counterparty/seller.ts", args: [], envFile: "env/seller.env" },
  { role: "l2", tag: "l2", entry: "src/layer2-control/service.ts", args: [], envFile: "env/l2-control.env" },
  { role: "l3", tag: "l3", entry: "src/layer3-settlement/service.ts", args: [], envFile: "env/l3-verifier.env" },
  { role: "agent", tag: "agent", entry: "src/main.ts", args: LLM ? [] : ["--scripted"], envFile: "env/l1-agent.env" },
];

// ---------------------------------------------------------------------------
// Env files. Parsed here only to learn ports, tokens and empty keys; children load their own file
// through loadEnv(). Only src/shared/config.ts may use dotenv (architecture test), so this is a
// minimal KEY=VALUE reader.
// ---------------------------------------------------------------------------

function parseEnvFile(path: string): Record<string, string> {
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
function envFileFor(p: DemoProcess): { path: string; values: Record<string, string> } | null {
  if (p.envFile === null) return null;
  const real = resolve(ROOT, p.envFile);
  const path = existsSync(real) ? real : `${real}.example`;
  if (!existsSync(path)) throw new Error(`missing ${p.envFile} and ${p.envFile}.example`);
  return { path, values: parseEnvFile(path) };
}

const files = new Map(PROCESSES.map((p) => [p.role, envFileFor(p)]));
const fileValue = (role: Role, key: string) => files.get(role)?.values[key] || undefined;
const portOf = (role: Role, key: string, fallback: number) => Number(fileValue(role, key) ?? fallback);

const PORTS: Record<Exclude<Role, "agent">, number> = {
  chain: CHAIN_PORT,
  facilitator: portOf("facilitator", "FACILITATOR_PORT", DEFAULT_PORTS.facilitator),
  seller: portOf("seller", "SELLER_PORT", DEFAULT_PORTS.seller),
  l2: portOf("l2", "CONTROL_PORT", DEFAULT_PORTS.control),
  l3: portOf("l3", "SETTLEMENT_PORT", DEFAULT_PORTS.settlement),
};
const NETWORK = fileValue("l2", "NETWORK") ?? "local";
const CONTROL_URL = `http://127.0.0.1:${PORTS.l2}`;
const CONTROL_TOKEN = fileValue("l2", "CONTROL_TOKEN") ?? DEV_TOKENS.CONTROL_TOKEN!;
const OPERATOR_TOKEN = fileValue("l2", "OPERATOR_TOKEN") ?? DEV_TOKENS.OPERATOR_TOKEN!;
const SESSION_ID = `sess_demo${Date.now().toString(16).slice(-6)}`;

/**
 * T015: children inherit only PATH, HOME and NODE_* plus their own ENV_FILE. On NETWORK=local, missing
 * keys come from the CP-5 mnemonic: #2 only to l2, #1 only to the facilitator. The seller's payTo and
 * L2's payee allowlist default to #3 when empty.
 */
function childEnv(p: DemoProcess): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith("NODE_") && v !== undefined) env[k] = v;
  const file = files.get(p.role);
  if (file) env.ENV_FILE = file.path;
  const local = NETWORK === "local";
  if (p.role === "l2" && local) {
    if (!fileValue("l2", "PAYER_PRIVATE_KEY")) env.PAYER_PRIVATE_KEY = localDevKeys({ NETWORK }).payer;
    if (!fileValue("l2", "ALLOWED_PAYEES")) env.ALLOWED_PAYEES = localAddress("sellerPayTo");
  }
  if (p.role === "facilitator" && local && !fileValue("facilitator", "FACILITATOR_PRIVATE_KEY")) {
    env.FACILITATOR_PRIVATE_KEY = localDevKeys({ NETWORK }).facilitator;
  }
  if (p.role === "seller" && local && !fileValue("seller", "SELLER_PAY_TO")) env.SELLER_PAY_TO = localAddress("sellerPayTo");
  if (p.role === "agent") env.SESSION_ID = SESSION_ID;
  return env;
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

interface Running {
  p: DemoProcess;
  child: ChildProcess;
  exited: Promise<number | null>;
  done: boolean;
}

const running: Running[] = [];
let shuttingDown = false;
let crash: string | null = null;

function forward(tag: string, stream: NodeJS.ReadableStream, sink: (line: string) => void, onLine?: (l: string) => void) {
  createInterface({ input: stream }).on("line", (line) => {
    if (GANACHE_NOISE.test(line)) return; // FR-007: drop ganache's harmless uws fallback notice
    onLine?.(line);
    sink(`[${tag}] ${line}`);
  });
}

function start(p: DemoProcess, onLine?: (l: string) => void): Running {
  // T016: detached, so the child leads its own process group (pgid = pid).
  const child = spawn(TSX, [p.entry, ...p.args], { cwd: ROOT, env: childEnv(p), detached: true, stdio: ["ignore", "pipe", "pipe"] });
  forward(p.tag, child.stdout!, (l) => console.log(l), onLine);
  forward(p.tag, child.stderr!, (l) => console.error(l), onLine);
  const r: Running = { p, child, done: false, exited: Promise.resolve(null) };
  r.exited = new Promise((res) =>
    child.once("exit", (code) => {
      r.done = true;
      if (!shuttingDown && p.role !== "agent") crash ??= `${p.role} exited unexpectedly (code ${code})`;
      res(code);
    }),
  );
  running.push(r);
  return r;
}

const killGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: the group is already gone.
  }
};

/** T018: reverse order, SIGTERM to each process group, SIGKILL after 3 s. */
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const r of [...running].reverse()) {
    const pid = r.child.pid;
    if (pid === undefined) continue;
    killGroup(pid, "SIGTERM");
    const timer = new Promise<"timeout">((res) => setTimeout(() => res("timeout"), KILL_GRACE_MS));
    await Promise.race([r.exited, timer]);
    killGroup(pid, "SIGKILL"); // grandchildren (tsx runs node in a child process) go too
  }
  await waitPortsFree(5_000);
}

// ---------------------------------------------------------------------------
// Ports and readiness
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function portInUse(port: number): Promise<boolean> {
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

async function waitPortsFree(maxMs: number): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const busy = await Promise.all(Object.values(PORTS).map(portInUse));
    if (!busy.some(Boolean)) return;
    await sleep(POLL_MS);
  }
}

async function httpOk(url: string, headers: Record<string, string> = {}, init: RequestInit = {}): Promise<boolean> {
  try {
    const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(1_000) });
    return res.status === 200;
  } catch {
    return false;
  }
}

const deploymentPath = resolve(ROOT, DEFAULT_DEPLOYMENT_FILE);

const READY: Record<Exclude<Role, "agent">, () => Promise<boolean>> = {
  chain: async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${PORTS.chain}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        signal: AbortSignal.timeout(1_000),
      });
      const body = (await res.json()) as { result?: string };
      return body.result === "0x7a69" && existsSync(deploymentPath);
    } catch {
      return false;
    }
  },
  facilitator: () => httpOk(`http://127.0.0.1:${PORTS.facilitator}/supported`),
  seller: () => httpOk(`http://127.0.0.1:${PORTS.seller}/api/catalog`),
  l2: () => httpOk(`${CONTROL_URL}/v1/budget/${SESSION_ID}`, { authorization: `Bearer ${CONTROL_TOKEN}` }),
  l3: () => portInUse(PORTS.l3),
};

/** T017: poll every 250 ms for up to 30 s. */
async function waitReady(role: Exclude<Role, "agent">): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (crash) throw new Error(crash);
    if (await READY[role]()) return;
    await sleep(POLL_MS);
  }
  throw new Error(`readiness timeout: ${role} not ready after ${READY_TIMEOUT_MS / 1000} s`);
}

// ---------------------------------------------------------------------------
// Summary (T020, R8): only authoritative sources (chain balance, /v1/budget, /v1/ledger/verify).
// ---------------------------------------------------------------------------

interface DemoSummary {
  network: string;
  session: string;
  outcomes: string[];
  spentAtomic: bigint;
  budget: { spentOrReservedAtomic: string; remainingAtomic: string } | null;
  chain: { ok: boolean; entries: number } | null;
}

async function payerBalance(dep: LocalDeployment): Promise<bigint> {
  const client = createPublicClient({ transport: http(`http://127.0.0.1:${PORTS.chain}`) });
  return client.readContract({ address: dep.asset, abi: erc20Abi, functionName: "balanceOf", args: [dep.accounts.payer] });
}

async function getJson<T>(url: string, token: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) });
    return res.status === 200 ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

function printSummary(s: DemoSummary): void {
  const lines = [
    "==== demo summary ====",
    `network:            ${s.network}`,
    `session:            ${s.session}`,
    `outcomes:           ${s.outcomes.join(", ")}${LLM ? "   (llm run, not asserted)" : ""}`,
    `spent on-chain: ${formatAtomic(s.spentAtomic.toString(), 6)} USDC`,
    s.budget
      ? `budget:             spentOrReserved=${s.budget.spentOrReservedAtomic} remaining=${s.budget.remainingAtomic} (atomic)`
      : "budget:             unavailable",
    s.chain ? `hash chain ok=${s.chain.ok} entries=${s.chain.entries}` : "hash chain ok=unknown",
    "======================",
  ];
  console.log(lines.join("\n"));
}

/** T028: compare with the shared RegressionBaseline. */
function matchesBaseline(s: DemoSummary): boolean {
  return (
    JSON.stringify(s.outcomes) === JSON.stringify(RegressionBaseline.outcomes) &&
    s.spentAtomic === BigInt(RegressionBaseline.onChainDeltaAtomic) &&
    s.chain?.ok === RegressionBaseline.ledgerChainOk &&
    s.budget?.spentOrReservedAtomic === RegressionBaseline.spentOrReservedAtomic
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<number> {
  // T013: preflight; a busy port aborts with no fallback.
  for (const [role, port] of Object.entries(PORTS)) {
    if (await portInUse(port)) {
      console.error(`demo: port busy: ${port} (${role}). Stop whatever is listening there and retry.`);
      return 1;
    }
  }
  rmSync(deploymentPath, { force: true }); // readiness must see this run's deployment, not a stale one

  for (const p of PROCESSES.filter((x) => x.role !== "agent")) {
    start(p);
    await waitReady(p.role as Exclude<Role, "agent">);
  }

  const dep = JSON.parse(readFileSync(deploymentPath, "utf8")) as LocalDeployment;
  const before = await payerBalance(dep);

  const outcomes: string[] = [];
  const agent = start(PROCESSES.find((x) => x.role === "agent")!, (line) => {
    const m = /^\d+\. ([A-Z_]+) /.exec(line);
    if (m) outcomes.push(m[1]!);
  });
  const agentCode = await agent.exited;
  if (crash) throw new Error(crash);
  if (agentCode !== 0) throw new Error(`agent exited with code ${agentCode}`);

  const summary: DemoSummary = {
    network: NETWORK,
    session: SESSION_ID,
    outcomes,
    spentAtomic: before - (await payerBalance(dep)),
    budget: await getJson(`${CONTROL_URL}/v1/budget/${SESSION_ID}`, CONTROL_TOKEN),
    chain: await getJson(`${CONTROL_URL}/v1/ledger/verify`, OPERATOR_TOKEN),
  };
  await shutdown();
  printSummary(summary); // printed last (contract)
  if (LLM) return summary.chain?.ok ? 0 : 2;
  return matchesBaseline(summary) ? 0 : 2;
}

let interrupted = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (interrupted) return;
    interrupted = true;
    console.error(`demo: ${sig} received, stopping all processes`);
    void shutdown().then(() => process.exit(1));
  });
}

run()
  .then(async (code) => {
    await shutdown();
    process.exit(code);
  })
  .catch(async (err: unknown) => {
    console.error(`demo: ${err instanceof Error ? err.message : String(err)}`);
    await shutdown();
    process.exit(1);
  });
