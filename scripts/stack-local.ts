// `npm run stack:local [-- --docker] [-- --users [--admin]]` (specs/011 quickstart §3; --users: specs/013 quickstart
// §2; --admin: specs/014 quickstart §2). Starts the five local stack processes of
// demo:local (chain, facilitator, seller, L2, L3) without an agent and keeps them running until Ctrl-C, so the
// hosted agent service (`npm run agent:hosted`, or its container image) has something to buy from. Children
// get the same env as in demo:local: local dev keys only to L2 and the facilitator (demo-lib childEnv).
// --docker also allows host.docker.internal:4021 in L2's mandate (R6): a container on Docker Desktop reaches
// the seller at that host, and L2 denies a host its mandate doesn't list.
// --users starts L2 with user accounts on (USER_ACCOUNTS=1 and the development wallet mnemonic), for the portal
// (`npm run portal`). Without it L2 runs exactly as in demo:local.
// --admin (only with --users) also turns L2's administration routes on (PORTAL_ADMIN=1), for the portal's
// administration area (`PORTAL_ADMIN=1 npm run portal`).
//
// Exit codes: 0 stopped by Ctrl-C or SIGTERM, 1 port busy, readiness timeout or child crash, 2 a bad flag.
import { rmSync } from "node:fs";
import { LOCAL_STACK, ProcessGroup, childEnv, localStack, portInUse, sleep, type DemoProcess, type StackRole } from "./demo-lib.js";

const DOCKER_SELLER_HOST = "host.docker.internal:4021";
const DOCKER = process.argv.includes("--docker");
const USERS = process.argv.includes("--users");
const ADMIN = process.argv.includes("--admin");
if (ADMIN && !USERS) {
  console.error("stack: --admin needs --users (the administration area belongs to the portal)");
  process.exit(2);
}

const stack = localStack();
const { files, ports: PORTS, network: NETWORK, deploymentPath } = stack;
const fileValue = (role: StackRole, key: string) => files.get(role)?.values[key] || undefined;

const group = new ProcessGroup(Object.values(PORTS));

function envFor(p: DemoProcess): NodeJS.ProcessEnv {
  const env = childEnv(p, files.get(p.role as StackRole) ?? null, { network: NETWORK, sessionId: "sess_stack", users: USERS, admin: ADMIN });
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
  for (const p of LOCAL_STACK) {
    group.start(p, envFor(p));
    await group.waitReady(p.role, stack.ready[p.role]);
  }
  console.log(
    `stack: ready (network ${NETWORK}${DOCKER ? `, L2 also allows ${DOCKER_SELLER_HOST}` : ""}${USERS ? ", user accounts on" : ""}). Ctrl-C stops it.`,
  );
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
