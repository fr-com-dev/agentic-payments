// Feature 008 US1: `npm run demo:local` (contracts/demo-local.md). Runs the real six-process demo.
// T011 smoke (SC-001, SC-002), T012 port preflight, T023 process-group shutdown proof (NFR-001).
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, connect, type Server } from "node:net";
import { describe, expect, it } from "vitest";
import { localDevKeys } from "../scripts/local-chain-lib.js";

const DEMO_PORTS = [8545, 4020, 4021, 4022, 4023];

function runDemo(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn("node_modules/.bin/tsx", ["scripts/demo-local.ts"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = connect({ port, host: "127.0.0.1" });
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(300, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });

const listeners = async (ports: number[]) => (await Promise.all(ports.map(async (p) => ((await listening(p)) ? p : null)))).filter((p) => p !== null);

/** The payer key the demo gives L2: env/l2-control.env's, or the derived local dev key when that is empty. */
function demoPayerKey(): string {
  const file = "env/l2-control.env";
  const fromFile = existsSync(file) ? /^PAYER_PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(readFileSync(file, "utf8"))?.[1] : undefined;
  return fromFile ?? localDevKeys({ NETWORK: "local" }).payer;
}

describe("008 US1 one-command local demo", () => {
  let smokeOutput: string | undefined;

  it("T011 demo smoke: exit 0, the two contract strings, summary last, no listeners left (SC-001, SC-002)", async () => {
    expect(await listeners(DEMO_PORTS), "ports must be free before the demo").toEqual([]);
    const { code, stdout, stderr } = await runDemo();
    smokeOutput = stdout + stderr;
    expect(code, stderr.slice(-2000)).toBe(0);
    expect(stdout).toContain("spent on-chain: 0.006 USDC");
    expect(stdout).toMatch(/hash chain ok=true entries=\d+/);
    expect(stdout.trimEnd().endsWith("======================")).toBe(true);
    expect(stdout + stderr).not.toMatch(/Falling back to a NodeJS implementation|uws_/);
    expect(await listeners(DEMO_PORTS)).toEqual([]);
  }, 180_000);

  it("011 SC-005 demo output never contains the payer key", () => {
    expect(smokeOutput, "runs after the T011 smoke, reusing its captured output").toBeDefined();
    const key = demoPayerKey();
    const ledger = existsSync(".local/ledger-local.jsonl") ? readFileSync(".local/ledger-local.jsonl", "utf8") : "";
    for (const form of [key, key.slice(2), key.slice(2).toUpperCase()]) {
      expect(smokeOutput!.includes(form), "payer key in the demo's output").toBe(false);
      expect(ledger.includes(form), "payer key in the ledger").toBe(false);
    }
  });

  it("T012 port preflight: a busy 4021 aborts with exit 1, 'port busy', no fallback, nothing started", async () => {
    const blocker: Server = createServer();
    await new Promise<void>((r) => blocker.listen(4021, "127.0.0.1", () => r()));
    try {
      const { code, stdout, stderr } = await runDemo();
      expect(code).toBe(1);
      expect(stderr).toMatch(/port busy: 4021/);
      expect(stdout).not.toContain("[chain]");
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
    expect(await listeners(DEMO_PORTS)).toEqual([]);
  }, 60_000);

  it("T023 shutdown must kill the process group: killing only the pid leaves a grandchild listener", async () => {
    // Same shape as the demo: a detached leader (like tsx) whose child process holds the port (like ganache).
    const leaderSrc = `
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", "require('node:net').createServer().listen(0, '127.0.0.1', function () { console.log(this.address().port); })"], { stdio: ["ignore", "inherit", "inherit"] });
      setInterval(() => {}, 1000);`;
    const start = () =>
      new Promise<{ pid: number; port: number }>((resolve) => {
        const leader = spawn(process.execPath, ["-e", leaderSrc], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
        leader.stdout!.once("data", (d) => resolve({ pid: leader.pid!, port: Number(String(d).trim()) }));
      });
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // Kill by pid (the bug): the leader dies, the port stays open.
    const a = await start();
    process.kill(a.pid, "SIGTERM");
    await wait(500);
    expect(await listening(a.port)).toBe(true);
    process.kill(-a.pid, "SIGKILL"); // clean up the orphaned group

    // Kill by process group (what demo-local does): the port is freed.
    const b = await start();
    process.kill(-b.pid, "SIGTERM");
    await wait(500);
    expect(await listening(b.port)).toBe(false);
    await wait(200);
    expect(await listening(a.port)).toBe(false);
  }, 30_000);
});
