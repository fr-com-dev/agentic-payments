// `npm run stack:local [-- --docker]` (specs/011 quickstart §3). Starts the five local stack processes of
// demo:local (chain, facilitator, seller, L2, L3) without an agent and keeps them running until Ctrl-C, so the
// hosted agent service (`npm run agent:hosted`, or its container image) has something to buy from. Children
// get the same env as in demo:local: local dev keys only to L2 and the facilitator (demo-lib childEnv).
// --docker also allows host.docker.internal:4021 in L2's mandate (R6): a container on Docker Desktop reaches
// the seller at that host, and L2 denies a host its mandate doesn't list.
//
// Exit codes: 0 stopped by Ctrl-C or SIGTERM, 1 port busy, readiness timeout or child crash.
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { CHAIN_PORT, DEFAULT_DEPLOYMENT_FILE, DEFAULT_PORTS, DEV_TOKENS } from "../src/shared/config.js";
import { ProcessGroup, ROOT, childEnv, envFileFor, httpOk, portInUse, sleep, type DemoProcess } from "./demo-lib.js";

type Role = "chain" | "facilitator" | "seller" | "l2" | "l3";

const DOCKER_SELLER_HOST = "host.docker.internal:4021";
const DOCKER = process.argv.includes("--docker");

const PROCESSES: DemoProcess[] = [
  { role: "chain", tag: "chain", entry: "scripts/local-chain.ts", args: [], envFile: null },
  { role: "facilitator", tag: "fac", entry: "scripts/facilitator.ts", args: [], envFile: "env/facilitator.env" },
  { role: "seller", tag: "seller", entry: "src/counterparty/seller.ts", args: [], envFile: "env/seller.env" },
  { role: "l2", tag: "l2", entry: "src/layer2-control/service.ts", args: [], envFile: "env/l2-control.env" },
  { role: "l3", tag: "l3", entry: "src/layer3-settlement/service.ts", args: [], envFile: "env/l3-verifier.env" },
];

const files = new Map(PROCESSES.map((p) => [p.role, envFileFor(p)]));
const fileValue = (role: Role, key: string) => files.get(role)?.values[key] || undefined;
const portOf = (role: Role, key: string, fallback: number) => Number(fileValue(role, key) ?? fallback);

const PORTS: Record<Role, number> = {
  chain: CHAIN_PORT,
  facilitator: portOf("facilitator", "FACILITATOR_PORT", DEFAULT_PORTS.facilitator),
  seller: portOf("seller", "SELLER_PORT", DEFAULT_PORTS.seller),
  l2: portOf("l2", "CONTROL_PORT", DEFAULT_PORTS.control),
  l3: portOf("l3", "SETTLEMENT_PORT", DEFAULT_PORTS.settlement),
};
const NETWORK = fileValue("l2", "NETWORK") ?? "local";
const CONTROL_TOKEN = fileValue("l2", "CONTROL_TOKEN") ?? DEV_TOKENS.CONTROL_TOKEN!;
const deploymentPath = resolve(ROOT, DEFAULT_DEPLOYMENT_FILE);

const READY: Record<Role, () => Promise<boolean>> = {
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
  l2: () => httpOk(`http://127.0.0.1:${PORTS.l2}/v1/budget/sess_stackready`, { authorization: `Bearer ${CONTROL_TOKEN}` }),
  l3: () => portInUse(PORTS.l3),
};

const group = new ProcessGroup(Object.values(PORTS));

function envFor(p: DemoProcess): NodeJS.ProcessEnv {
  const env = childEnv(p, files.get(p.role) ?? null, { network: NETWORK, sessionId: "sess_stack" });
  if (DOCKER && p.role === "l2") {
    const hosts = fileValue("l2", "ALLOWED_HOSTS") ?? `127.0.0.1:${PORTS.seller}`;
    env.ALLOWED_HOSTS = `${hosts},${DOCKER_SELLER_HOST}`;
  }
  return env;
}

async function run(): Promise<number> {
  for (const [role, port] of Object.entries(PORTS)) {
    if (await portInUse(port)) {
      console.error(`stack: port busy: ${port} (${role}). Stop whatever is listening there and retry.`);
      return 1;
    }
  }
  rmSync(deploymentPath, { force: true }); // readiness must see this run's deployment, not a stale one
  for (const p of PROCESSES) {
    group.start(p, envFor(p));
    await group.waitReady(p.role, READY[p.role as Role]);
  }
  console.log(`stack: ready (network ${NETWORK}${DOCKER ? `, L2 also allows ${DOCKER_SELLER_HOST}` : ""}). Ctrl-C stops it.`);
  while (!group.crash) await sleep(1_000);
  throw new Error(group.crash);
}

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    console.error(`stack: ${sig} received, stopping all processes`);
    void group.shutdown().then(() => process.exit(0));
  });
}

run().then(
  async (code) => {
    await group.shutdown();
    process.exit(code);
  },
  async (err: unknown) => {
    console.error(`stack: ${err instanceof Error ? err.message : String(err)}`);
    await group.shutdown();
    process.exit(1);
  },
);
