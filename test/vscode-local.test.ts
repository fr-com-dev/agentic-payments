// VS Code debugging and running (.vscode/launch.json, .vscode/tasks.json, scripts/vscode-local.ts; SPEC.md §13).
// T-DEV-01: every configuration runs locally, through the runner, and every role, task, input and compound it names
// exists. T-DEV-02: each process gets only its own env file and its own local key, NETWORK=local whatever its file
// says, and nothing else from VS Code's environment.
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { parseEnvFile, type EnvFile } from "../scripts/demo-lib.js";
import { localRunEnv, PASSTHROUGH, RUN_ROLES, runWarnings, type RunRole } from "../scripts/vscode-local.js";

/** VS Code's JSON with comments: these files use whole-line `//` comments only. */
const jsonc = (path: string) => JSON.parse(readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, "")) as Record<string, unknown>;

type LaunchConfig = {
  name: string;
  program: string;
  args?: string[];
  runtimeArgs?: string[];
  env?: Record<string, string>;
  preLaunchTask?: string;
  autoAttachChildProcesses?: boolean;
};
type Compound = { name: string; configurations: string[]; preLaunchTask?: string };
type Input = { id: string };

const RUNNER = "${workspaceFolder}/scripts/vscode-local.ts";
const VITEST = "${workspaceFolder}/node_modules/vitest/vitest.mjs";

const launch = () => jsonc(".vscode/launch.json") as { configurations: LaunchConfig[]; compounds: Compound[]; inputs: Input[] };
const tasks = () => jsonc(".vscode/tasks.json") as { tasks: { label: string; args?: string[]; command?: string }[]; inputs: Input[] };
const inputsIn = (text: string) => [...text.matchAll(/\$\{input:(\w+)\}/g)].map((m) => m[1]!);

/** What's wrong with the VS Code files, as messages. */
function launchProblems(l = launch(), t = tasks()): string[] {
  const out: string[] = [];
  const names = new Set(l.configurations.map((c) => c.name));
  const labels = new Set(t.tasks.map((x) => x.label));
  for (const c of l.configurations) {
    if (c.program === RUNNER) {
      if (c.args?.[0] !== "run" || !((c.args?.[1] ?? "") in RUN_ROLES)) out.push(`${c.name}: not "run <role>" with a known role`);
      if (JSON.stringify(c.runtimeArgs) !== JSON.stringify(["--import", "tsx"])) out.push(`${c.name}: runtimeArgs must load tsx`);
      if (c.autoAttachChildProcesses !== true) out.push(`${c.name}: the debugger must attach to the runner's child`);
      for (const key of Object.keys(c.env ?? {})) if (!(PASSTHROUGH as readonly string[]).includes(key)) out.push(`${c.name}: sets ${key}, which the runner drops`);
    } else if (c.program === VITEST) {
      if (c.env?.NETWORK !== "local") out.push(`${c.name}: tests must run with NETWORK=local`);
    } else {
      out.push(`${c.name}: runs ${c.program}, not the local runner`);
    }
    if (c.preLaunchTask !== undefined && !labels.has(c.preLaunchTask)) out.push(`${c.name}: no task "${c.preLaunchTask}"`);
  }
  for (const k of l.compounds) {
    for (const m of k.configurations) if (!names.has(m)) out.push(`compound ${k.name}: no configuration "${m}"`);
    if (k.preLaunchTask !== undefined && !labels.has(k.preLaunchTask)) out.push(`compound ${k.name}: no task "${k.preLaunchTask}"`);
    // VS Code runs one instance of a task at a time: two members can't start on the same pre-launch task.
    const pre = k.configurations.map((m) => l.configurations.find((c) => c.name === m)?.preLaunchTask).filter((x) => x !== undefined);
    if (new Set(pre).size !== pre.length) out.push(`compound ${k.name}: two members share a pre-launch task`);
  }
  const launchInputs = new Set(l.inputs.map((i) => i.id));
  for (const id of inputsIn(readFileSync(".vscode/launch.json", "utf8"))) if (!launchInputs.has(id)) out.push(`launch.json: no input "${id}"`);
  const taskInputs = new Set(t.inputs.map((i) => i.id));
  for (const id of inputsIn(readFileSync(".vscode/tasks.json", "utf8"))) if (!taskInputs.has(id)) out.push(`tasks.json: no input "${id}"`);
  return out;
}

describe("T-DEV-01 every VS Code configuration runs locally, through the runner", () => {
  it("T-DEV-01 the launch configurations, compounds, tasks and inputs resolve, and every role is reachable", () => {
    expect(launchProblems()).toEqual([]);
    const used = new Set(launch().configurations.filter((c) => c.program === RUNNER).map((c) => c.args![1]));
    expect([...used].sort()).toEqual(Object.keys(RUN_ROLES).sort());
    for (const p of Object.values(RUN_ROLES)) expect(existsSync(p.entry), p.entry).toBe(true);
    for (const t of tasks().tasks) for (const a of t.args ?? []) if (/^scripts\/.*\.ts$/.test(a)) expect(existsSync(a), a).toBe(true);
  });

  it("T-DEV-01 must-fail: another program, an unknown role, an env the runner drops, a missing task and a shared pre-launch task are reported", () => {
    const l = launch();
    const t = tasks();
    l.configurations.push({ name: "Raw L2", program: "${workspaceFolder}/src/layer2-control/service.ts", env: { NETWORK: "base-sepolia" } });
    l.configurations.find((c) => c.name === "L3 verifier")!.args = ["run", "l4"];
    l.configurations.find((c) => c.name === "Seller")!.env = { API_DOCS: "1", NETWORK: "base-sepolia" };
    l.configurations.find((c) => c.name === "L1 hosted agent")!.preLaunchTask = "nope";
    l.compounds[0]!.configurations.push("L1 agent: scripted plan", "Operator: ledger-verify");
    expect(launchProblems(l, t)).toEqual([
      'Seller: sets NETWORK, which the runner drops',
      'L3 verifier: not "run <role>" with a known role',
      'L1 hosted agent: no task "nope"',
      "Raw L2: runs ${workspaceFolder}/src/layer2-control/service.ts, not the local runner",
      "compound Local stack: two members share a pre-launch task",
    ]);
  });
});

describe("T-DEV-02 each process gets its own env file, its own local key and NETWORK=local", () => {
  const template = (path: string): EnvFile => ({ path, values: parseEnvFile(path) });
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("T-DEV-02 the payer key only to L2, the facilitator key only to the facilitator, payTo only to the seller", () => {
    const keysOf = (role: RunRole) => {
      const env = localRunEnv(role, template(`${RUN_ROLES[role].envFile}.example`), {});
      return [env.NETWORK, ["PAYER_PRIVATE_KEY", "FACILITATOR_PRIVATE_KEY", "SELLER_PAY_TO"].filter((k) => env[k] !== undefined)];
    };
    expect(Object.fromEntries((Object.keys(RUN_ROLES) as RunRole[]).map((r) => [r, keysOf(r)]))).toEqual({
      facilitator: ["local", ["FACILITATOR_PRIVATE_KEY"]],
      seller: ["local", ["SELLER_PAY_TO"]],
      l2: ["local", ["PAYER_PRIVATE_KEY"]],
      l3: ["local", []],
      agent: ["local", []],
      hosted: ["local", []],
      approve: ["local", []],
      reject: ["local", []],
      escalations: ["local", []],
      "ledger-verify": ["local", []],
    });
    const env = localRunEnv("l2", template("env/l2-control.env.example"), {});
    expect(env.ENV_FILE).toBe("env/l2-control.env.example");
  });

  it("T-DEV-02 must-fail: a non-local env file still runs locally, and VS Code's own keys and settings never reach a process", () => {
    process.env.PAYER_PRIVATE_KEY = "0xdecoy";
    process.env.ANTHROPIC_API_KEY = "decoy";
    const remote: EnvFile = { path: "env/l2-control.env", values: { NETWORK: "base-sepolia", PAYER_PRIVATE_KEY: "" } };
    const env = localRunEnv("l2", remote, { API_DOCS: "1", PAYER_PRIVATE_KEY: "0xdecoy", CONTROL_PORT: "9999" });
    expect([env.NETWORK, env.API_DOCS, env.CONTROL_PORT]).toEqual(["local", "1", undefined]);
    expect(env.PAYER_PRIVATE_KEY).toMatch(/^0x[0-9a-f]{64}$/);
    expect(env.PAYER_PRIVATE_KEY).not.toBe("0xdecoy");
    const agent = localRunEnv("agent", template("env/l1-agent.env.example"), process.env);
    expect([agent.PAYER_PRIVATE_KEY, agent.ANTHROPIC_API_KEY]).toEqual([undefined, undefined]);
    expect(runWarnings("l2", remote, [])).toEqual(["env/l2-control.env sets NETWORK=base-sepolia; VS Code runs it with NETWORK=local"]);
  });

  it("T-DEV-02 the debugger's attach hook reaches the child, so breakpoints bind there", () => {
    process.env.NODE_OPTIONS = "--require /vscode/js-debug/bootloader.js";
    const env = localRunEnv("seller", template("env/seller.env.example"), { VSCODE_INSPECTOR_OPTIONS: '{"inspectorIpc":"/tmp/x"}' });
    expect([env.NODE_OPTIONS, env.VSCODE_INSPECTOR_OPTIONS]).toEqual(["--require /vscode/js-debug/bootloader.js", '{"inspectorIpc":"/tmp/x"}']);
  });

  it("T-DEV-02 warnings name a missing model key or a remote model provider, never a value", () => {
    const hosted: EnvFile = { path: "env/l1-hosted.env", values: { MODEL_PROVIDER: "foundry", AUTH_JWKS_FILE: ".local/dev-issuer/jwks.json" } };
    expect(runWarnings("hosted", hosted, [])).toEqual([
      "locally the hosted agent needs MODEL_PROVIDER=anthropic (Foundry signs in as the Container App's managed identity)",
    ]);
    const agent: EnvFile = { path: "env/l1-agent.env", values: { ANTHROPIC_API_KEY: "" } };
    expect(runWarnings("agent", agent, ["--scripted"])).toEqual([]);
    expect(runWarnings("agent", agent, ["Get the weather"])).toEqual([
      "env/l1-agent.env has no ANTHROPIC_API_KEY: the Claude agent needs one (the scripted plan doesn't)",
    ]);
  });
});
