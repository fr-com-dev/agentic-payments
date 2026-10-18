// `npm run demo:local [-- --llm]` (SPEC.md §12, §13; feature 008 contracts/demo-local.md).
// Starts the six processes (chain, facilitator, seller, L2, L3, agent) as detached process groups,
// runs the agent, prints the summary last and frees every port. Shared helpers live in demo-lib.ts.
//
// Exit codes: 0 baseline matched (or --llm completed with chain ok), 2 baseline mismatch,
// 1 port busy, readiness timeout, child crash or interrupt.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, erc20Abi, http } from "viem";
import { CHAIN_PORT, DEFAULT_DEPLOYMENT_FILE, DEFAULT_PORTS, DEV_TOKENS, type LocalDeployment } from "../src/shared/config.js";
import {
  OUTCOME_LINE,
  ProcessGroup,
  ROOT,
  childEnv,
  envFileFor,
  getJson,
  httpOk,
  matchesBaseline,
  portInUse,
  printSummary,
  type DemoProcess,
  type DemoSummary,
} from "./demo-lib.js";

type Role = "chain" | "facilitator" | "seller" | "l2" | "l3" | "agent";

const LLM = process.argv.includes("--llm");

const PROCESSES: DemoProcess[] = [
  { role: "chain", tag: "chain", entry: "scripts/local-chain.ts", args: [], envFile: null },
  { role: "facilitator", tag: "fac", entry: "scripts/facilitator.ts", args: [], envFile: "env/facilitator.env" },
  { role: "seller", tag: "seller", entry: "src/counterparty/seller.ts", args: [], envFile: "env/seller.env" },
  { role: "l2", tag: "l2", entry: "src/layer2-control/service.ts", args: [], envFile: "env/l2-control.env" },
  { role: "l3", tag: "l3", entry: "src/layer3-settlement/service.ts", args: [], envFile: "env/l3-verifier.env" },
  { role: "agent", tag: "agent", entry: "src/main.ts", args: LLM ? [] : ["--scripted"], envFile: "env/l1-agent.env" },
];

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

const group = new ProcessGroup(Object.values(PORTS));
const start = (p: DemoProcess, onLine?: (l: string) => void) =>
  group.start(p, childEnv(p, files.get(p.role) ?? null, { network: NETWORK, sessionId: SESSION_ID }), onLine);

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

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

async function payerBalance(dep: LocalDeployment): Promise<bigint> {
  const client = createPublicClient({ transport: http(`http://127.0.0.1:${PORTS.chain}`) });
  return client.readContract({ address: dep.asset, abi: erc20Abi, functionName: "balanceOf", args: [dep.accounts.payer] });
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
    await group.waitReady(p.role, READY[p.role as Exclude<Role, "agent">]);
  }

  const dep = JSON.parse(readFileSync(deploymentPath, "utf8")) as LocalDeployment;
  const before = await payerBalance(dep);

  const outcomes: string[] = [];
  const agent = start(PROCESSES.find((x) => x.role === "agent")!, (line) => {
    const m = OUTCOME_LINE.exec(line);
    if (m) outcomes.push(m[1]!);
  });
  const agentCode = await agent.exited;
  if (group.crash) throw new Error(group.crash);
  if (agentCode !== 0) throw new Error(`agent exited with code ${agentCode}`);

  const summary: DemoSummary = {
    network: NETWORK,
    session: SESSION_ID,
    outcomes,
    spentAtomic: before - (await payerBalance(dep)),
    budget: await getJson(`${CONTROL_URL}/v1/budget/${SESSION_ID}`, CONTROL_TOKEN),
    chain: await getJson(`${CONTROL_URL}/v1/ledger/verify`, OPERATOR_TOKEN),
  };
  await group.shutdown();
  printSummary(summary, [], LLM); // printed last (contract)
  if (LLM) return summary.chain?.ok ? 0 : 2;
  return matchesBaseline(summary) ? 0 : 2;
}

let interrupted = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (interrupted) return;
    interrupted = true;
    console.error(`demo: ${sig} received, stopping all processes`);
    void group.shutdown().then(() => process.exit(1));
  });
}

run()
  .then(async (code) => {
    await group.shutdown();
    process.exit(code);
  })
  .catch(async (err: unknown) => {
    console.error(`demo: ${err instanceof Error ? err.message : String(err)}`);
    await group.shutdown();
    process.exit(1);
  });
