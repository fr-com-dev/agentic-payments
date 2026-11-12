// The VS Code runner (.vscode/launch.json, .vscode/tasks.json). Every process runs in local mode, exactly as in
// stack:local and demo:local: NETWORK=local always, its own env file (env/<role>.env, or the .example template),
// and the local dev keys derived from the CP-5 mnemonic, each handed only to the process that holds it (demo-lib
// childEnv: the payer key to L2, the facilitator key to the facilitator). Keys stay in memory; nothing from VS
// Code's own environment reaches a process except API_DOCS and the debugger's plumbing: NODE_OPTIONS (its
// bootloader) and VSCODE_INSPECTOR_OPTIONS (where to attach), so breakpoints bind in the child.
//
//   vscode-local.ts chain                  start the local chain, or reuse the one already running (task "local: chain")
//   vscode-local.ts stack [--users]        make the whole local stack answer (task "local: stack"): each process that
//                                          answers is reused, one starting elsewhere is waited for, a missing one is
//                                          started here, without the debugger, and kept running. --users (task
//                                          "local: stack: users", 013) starts L2 with user accounts on and the local
//                                          dev mnemonic, and refuses an L2 that runs without them
//   vscode-local.ts run <role> [args...]   run one process as a child; the debugger attaches to it
//
// Roles: facilitator, seller, l2, l3, agent (L1 CLI), hosted (L1 hosted agent), portal (the L2 web portal, 013),
// approve, reject, escalations, ledger-verify (the operator's commands).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LOCAL_STACK, ProcessGroup, ROOT, childEnv, envFileFor, localStack, portInUse, sleep, type DemoProcess, type EnvFile, type StackRole } from "./demo-lib.js";
import { DEV_ISSUER } from "../src/shared/identity-token.js";
import { DEV_AGENT_CLIENT, loadOrCreateDevIssuer } from "./dev-issuer-lib.js";
import { startLocalChain } from "./local-chain-lib.js";

const operator = (entry: string): DemoProcess => ({ role: "operator", tag: "op", entry, args: [], envFile: "env/operator.env" });

/** What `run <role>` starts. `role` is childEnv's: it decides which local key, if any, the process gets. */
export const RUN_ROLES = {
  facilitator: { role: "facilitator", tag: "fac", entry: "scripts/facilitator.ts", args: [], envFile: "env/facilitator.env" },
  seller: { role: "seller", tag: "seller", entry: "src/counterparty/seller.ts", args: [], envFile: "env/seller.env" },
  l2: { role: "l2", tag: "l2", entry: "src/layer2-control/service.ts", args: [], envFile: "env/l2-control.env" },
  l3: { role: "l3", tag: "l3", entry: "src/layer3-settlement/service.ts", args: [], envFile: "env/l3-verifier.env" },
  agent: { role: "agent", tag: "agent", entry: "src/main.ts", args: [], envFile: "env/l1-agent.env" },
  hosted: { role: "hosted", tag: "hosted", entry: "src/hosted-main.ts", args: [], envFile: "env/l1-hosted.env" },
  // 013: not a stack service. It gets no key at all, and it needs L2 with user accounts on ("local: stack: users").
  portal: { role: "portal", tag: "portal", entry: "src/portal-main.ts", args: [], envFile: "env/portal.env" },
  approve: operator("scripts/approve.ts"),
  reject: operator("scripts/reject.ts"),
  escalations: operator("scripts/escalations.ts"),
  "ledger-verify": operator("scripts/ledger-verify.ts"),
} as const satisfies Record<string, DemoProcess>;
export type RunRole = keyof typeof RUN_ROLES;

/** Variables a launch configuration may set for its process; everything else from VS Code's environment stays out. */
export const PASSTHROUGH = ["API_DOCS"] as const;
/** How VS Code's debugger (js-debug's bootloader) finds a child process; NODE_OPTIONS comes through childEnv's NODE_*. */
export const DEBUGGER_ENV = ["VSCODE_INSPECTOR_OPTIONS", "NODE_INSPECTOR_IPC"] as const;

/**
 * The child's environment: childEnv in local mode, NETWORK=local whatever the env file says, PASSTHROUGH and DEBUGGER_ENV.
 * `users` (013) turns user accounts on, which only changes L2's environment.
 */
export function localRunEnv(role: RunRole, file: EnvFile | null, parent: NodeJS.ProcessEnv = process.env, opts: { users?: boolean } = {}): NodeJS.ProcessEnv {
  const env = childEnv(RUN_ROLES[role], file, { network: "local", sessionId: `sess_${randomBytes(4).toString("hex")}`, ...(opts.users && { users: true }) });
  env.NETWORK = "local";
  for (const key of [...PASSTHROUGH, ...DEBUGGER_ENV]) if (parent[key] !== undefined) env[key] = parent[key];
  return env;
}

/** With the dev issuer's keys only the dev issuer's name is accepted (specs/013 research R19): an env file from before says otherwise. */
function devIssuerWarnings(file: EnvFile | null, fallbackPath: string, who: string): string[] {
  if (file?.values.AUTH_ISSUER === DEV_ISSUER) return [];
  return [`${file?.path ?? fallbackPath} needs AUTH_ISSUER=${DEV_ISSUER} with AUTH_JWKS_FILE (people sign in with Auth0 now; see the template): ${who} will refuse to start`];
}

/** Warnings about a process that will refuse to start, or run differently than the file suggests. Names only, no values. */
export function runWarnings(role: RunRole, file: EnvFile | null, args: readonly string[]): string[] {
  const v = (key: string) => file?.values[key] || undefined;
  const out: string[] = [];
  if (file && v("NETWORK") !== undefined && v("NETWORK") !== "local") out.push(`${file.path} sets NETWORK=${v("NETWORK")}; VS Code runs it with NETWORK=local`);
  if (role === "agent" && !args.includes("--scripted") && !v("ANTHROPIC_API_KEY")) {
    out.push(`${file?.path ?? "env/l1-agent.env"} has no ANTHROPIC_API_KEY: the Claude agent needs one (the scripted plan doesn't)`);
  }
  if (role === "hosted") {
    if (v("MODEL_PROVIDER") !== "anthropic") out.push(`locally the hosted agent needs MODEL_PROVIDER=anthropic (Foundry signs in as the Container App's managed identity)`);
    else if (!v("ANTHROPIC_API_KEY")) out.push(`${file?.path ?? "env/l1-hosted.env"} has no ANTHROPIC_API_KEY: the hosted agent will refuse to start`);
    if (!v("AUTH_JWKS_FILE")) out.push(`${file?.path ?? "env/l1-hosted.env"} has no AUTH_JWKS_FILE: locally the hosted agent uses the dev issuer (.local/dev-issuer/jwks.json)`);
    else out.push(...devIssuerWarnings(file, "env/l1-hosted.env", "the hosted agent"));
    if (!v("AGENT_CLIENT_IDS")) out.push(`${file?.path ?? "env/l1-hosted.env"} has no AGENT_CLIENT_IDS: the hosted agent will refuse to start (the dev issuer's client is ${DEV_AGENT_CLIENT})`);
  }
  if (role === "portal") {
    if (!v("AUTH_JWKS_FILE")) out.push(`${file?.path ?? "env/portal.env"} has no AUTH_JWKS_FILE: locally the portal uses the dev issuer (.local/dev-issuer/jwks.json)`);
    else out.push(...devIssuerWarnings(file, "env/portal.env", "the portal"));
    if (!existsSync(resolve(ROOT, v("PORTAL_WEB_ROOT") ?? "dist/portal-web", "index.html"))) out.push("the web app is not built: run `npm run build:web`, or the portal serves only its API");
  }
  return out;
}

/** The stack's services by run role: `run` refuses to start one whose port is already taken. */
const SERVICE_PORTS: Partial<Record<RunRole, StackRole>> = { facilitator: "facilitator", seller: "seller", l2: "l2", l3: "l3" };

async function run(role: string | undefined, args: string[]): Promise<number> {
  if (role === undefined || !(role in RUN_ROLES)) {
    console.error(`vscode-local: run <role> [args...]; roles: ${Object.keys(RUN_ROLES).join(", ")}`);
    return 2;
  }
  const r = role as RunRole;
  const p = RUN_ROLES[r];
  const file = envFileFor(p);
  const service = SERVICE_PORTS[r];
  if (service !== undefined) {
    const port = localStack().ports[service];
    if (await portInUse(port)) {
      console.error(`vscode-local: port ${port} is taken: another ${r} runs, maybe in the task "local: stack". Run the task "local: stop stack" to debug this one.`);
      return 1;
    }
  }
  for (const w of runWarnings(r, file, args)) console.error(`vscode-local: ${w}`);
  // The hosted agent and the portal verify dev-issuer tokens locally; `npm run dev-token` signs them with the same issuer.
  const jwks = r === "hosted" || r === "portal" ? file?.values.AUTH_JWKS_FILE : undefined;
  if (jwks) await loadOrCreateDevIssuer(dirname(resolve(ROOT, jwks)), { NETWORK: "local" });

  const child = spawn(process.execPath, ["--import", "tsx", p.entry, ...args], { cwd: ROOT, env: localRunEnv(r, file), stdio: "inherit" });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
  return new Promise((done) => child.once("exit", (code, signal) => done(code ?? (signal ? 0 : 1))));
}

async function chain(): Promise<number> {
  const stack = localStack();
  console.log("local chain: checking 127.0.0.1:8545");
  if (await stack.ready.chain()) {
    console.log(`local chain: already running on 127.0.0.1:${stack.ports.chain} (reused)`);
    return 0;
  }
  if (await portInUse(stack.ports.chain)) {
    console.error(`local chain: error: port ${stack.ports.chain} is busy, but not with the local chain; stop whatever listens there`);
    return 1;
  }
  console.log("local chain: starting");
  const local = await startLocalChain();
  console.log(`local chain: ready on ${local.deployment.rpcUrl}, MockUSDC ${local.deployment.asset} (task "local: stop chain" stops it)`);
  let stopping = false;
  await new Promise<void>((done) => {
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.on(sig, () => {
        if (stopping) return;
        stopping = true;
        console.log(`local chain: stopping (${sig})`);
        void local.stop().then(done);
      });
    }
  });
  return 0;
}

/** What `stack` does with one process: reuse it (it answers), wait for it (its port is taken), or start it (free). */
export type StackAction = "reuse" | "wait" | "start";
export const stackAction = (answers: boolean, portTaken: boolean): StackAction => (answers ? "reuse" : portTaken ? "wait" : "start");

const READY_MS = 60_000;

/**
 * Whether the L2 that answers has user accounts on (013): its portal routes exist only then. Without a token a
 * mounted route answers 401 and a missing one 404, so no credential is needed to tell.
 */
export const userAccountsOn = (status: number): boolean => status !== 404;

async function stack(users: boolean): Promise<number> {
  const local = localStack();
  const group = new ProcessGroup(Object.values(local.ports));
  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      if (stopping) return;
      stopping = true;
      if (group.running.length > 0) console.log(`local stack: stopping (${sig})`);
      void group.shutdown().then(() => process.exit(0));
    });
  }

  console.log("local stack: checking");
  try {
    for (const p of LOCAL_STACK) {
      const role = p.role;
      const action = stackAction(await local.ready[role](), await portInUse(local.ports[role]));
      if (action === "start") {
        if (role === "chain") rmSync(local.deploymentPath, { force: true }); // readiness must see this chain's deployment
        const env = role === "chain" ? childEnv(p, null, { network: "local", sessionId: "sess_stack" }) : localRunEnv(role as RunRole, local.files.get(role) ?? null, {}, { users });
        console.log(`local stack: starting ${role} (not debugged)`);
        group.start(p, env);
        await group.waitReady(role, local.ready[role]);
      } else if (action === "wait") {
        console.log(`local stack: waiting for ${role} (port ${local.ports[role]} is starting elsewhere)`);
        const deadline = Date.now() + READY_MS;
        while (!(await local.ready[role]())) {
          if (Date.now() > deadline) throw new Error(`${role} holds port ${local.ports[role]} but doesn't answer; stop what listens there`);
          await sleep(500);
        }
      }
    }
  } catch (err) {
    // A process that crashed or never answered: stop the ones this task started, so none is left behind.
    console.log(`local stack: error: ${err instanceof Error ? err.message : String(err)}`);
    await group.shutdown();
    return 1;
  }
  if (users) {
    // An L2 that was already running may have been started without user accounts; the portal can do nothing with it.
    const status = await fetch(`http://127.0.0.1:${local.ports.l2}/v1/platform`).then(
      (r) => r.status,
      () => 0,
    );
    if (!userAccountsOn(status)) {
      console.log(`local stack: error: the L2 on port ${local.ports.l2} runs without user accounts; stop it (task "local: stop stack", or the compound "Local stack") and run this task again`);
      await group.shutdown();
      return 1;
    }
  }
  if (group.running.length === 0) {
    console.log("local stack: already running (reused)");
    return 0;
  }
  console.log(`local stack: ready; ${group.running.map((r) => r.p.role).join(", ")} run in this task (task "local: stop stack" stops them)`);
  while (!group.crash) await sleep(1_000);
  console.log(`local stack: error: ${group.crash}`);
  await group.shutdown();
  return 1;
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  const [command, role, ...rest] = process.argv.slice(2);
  const job = command === "chain" ? chain() : command === "stack" ? stack(role === "--users") : command === "run" ? run(role, rest) : null;
  if (job === null) {
    console.error("vscode-local: chain | stack [--users] | run <role> [args...]");
    process.exit(2);
  }
  job.then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`vscode-local: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
