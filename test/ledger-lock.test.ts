// T-LED-05 one ledger writer (SPEC.md L2-6; specs/011 contracts/ledger-lock.md). Container Apps overlaps
// revisions on update, so L2 takes an exclusive lock beside the ledger before loading it.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLedger } from "../src/layer2-control/ledger.js";
import { acquireLedgerLock, STALE_MS } from "../src/layer2-control/ledger-lock.js";

let dir: string;
let children: ChildProcess[] = [];
const fresh = () => {
  dir = mkdtempSync(join(tmpdir(), "ledger-lock-"));
  return join(dir, "ledger-local.jsonl");
};
afterEach(() => {
  for (const c of children) c.kill("SIGKILL");
  children = [];
  rmSync(dir, { recursive: true, force: true });
});

function holdInChild(ledgerPath: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--import", "tsx", "test/fixtures/lock-holder.ts", ledgerPath], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.stdout!.on("data", (d) => {
      if (String(d).includes("held")) resolve(child);
    });
    child.on("exit", (code) => reject(new Error(`lock holder exited early (${code})`)));
  });
}

describe("T-LED-05 one ledger writer", () => {
  it("a second acquire waits while another process holds a fresh lock, and gets it within 2 s after that process gets SIGTERM", async () => {
    const path = fresh();
    const child = await holdInChild(path);
    const logs: string[] = [];
    let acquiredAt = 0;
    const second = acquireLedgerLock(path, { log: (l) => logs.push(l) }).then((lock) => {
      acquiredAt = Date.now();
      return lock;
    });
    await new Promise((r) => setTimeout(r, 1_500));
    expect(acquiredAt).toBe(0);
    expect(logs.filter((l) => l.includes("waiting"))).toHaveLength(1);
    const killedAt = Date.now();
    child.kill("SIGTERM");
    const lock = await second;
    expect(acquiredAt - killedAt).toBeLessThan(2_000);
    lock.release();
    expect(existsSync(`${path}.lock`)).toBe(false);
  }, 15_000);

  it("a lock whose heartbeat is 31 s old is taken over, logged, and the stale file is kept aside", async () => {
    const path = fresh();
    const now = Date.parse("2026-10-22T00:00:00Z");
    writeFileSync(`${path}.lock`, JSON.stringify({ holder: "l2_old", pid: 1, host: "h", acquiredAt: "x", heartbeatAt: new Date(now - STALE_MS - 1_000).toISOString() }));
    const logs: string[] = [];
    const lock = await acquireLedgerLock(path, { now: () => now, sleep: async () => undefined, log: (l) => logs.push(l) });
    expect(logs).toContain("l2-control: took over a stale ledger lock from l2_old");
    expect(readdirSync(dir).some((f) => /^ledger-local\.jsonl\.lock\.stale\.l2_old\.\d+$/.test(f))).toBe(true);
    expect(JSON.parse(readFileSync(`${path}.lock`, "utf8")).holder).toBe(lock.holder);
    lock.release();
  });

  it("an unreadable lock counts as fresh for one poll, then as stale", async () => {
    const path = fresh();
    writeFileSync(`${path}.lock`, "{not json");
    let sleeps = 0;
    const lock = await acquireLedgerLock(path, { sleep: async () => void sleeps++, log: () => undefined });
    expect(sleeps).toBe(1);
    lock.release();
  });

  it("a holder whose lock file now names another holder reports the loss on its next heartbeat", async () => {
    const path = fresh();
    let lost = 0;
    const lock = await acquireLedgerLock(path, { onLost: () => void lost++ });
    writeFileSync(`${path}.lock`, JSON.stringify({ holder: "l2_intruder", pid: 2, host: "h", acquiredAt: "x", heartbeatAt: new Date().toISOString() }));
    lock.beat();
    expect(lost).toBe(1);
    lock.release();
    expect(JSON.parse(readFileSync(`${path}.lock`, "utf8")).holder).toBe("l2_intruder");
  });

  it("the heartbeat refreshes heartbeatAt while the lock is ours", async () => {
    const path = fresh();
    let t = Date.parse("2026-10-22T00:00:00Z");
    const lock = await acquireLedgerLock(path, { now: () => t });
    t += 5_000;
    lock.beat();
    expect(JSON.parse(readFileSync(`${path}.lock`, "utf8")).heartbeatAt).toBe(new Date(t).toISOString());
    lock.release();
  });

  it("must-fail: two writers opened on one ledger without the lock fork the chain, and the reload throws integrity", () => {
    const path = fresh();
    const a = new AuditLedger(path);
    const b = new AuditLedger(path);
    a.append({ type: "INTENT", sessionId: "s", intentId: "i1", data: {} });
    b.append({ type: "INTENT", sessionId: "s", intentId: "i2", data: {} });
    expect(() => new AuditLedger(path)).toThrow(/integrity/);
  });

  it("L2-6: service.ts main() takes the lock before loading the ledger", () => {
    const src = readFileSync("src/layer2-control/service.ts", "utf8");
    const body = src.slice(src.indexOf("export async function main"));
    const lock = body.indexOf("acquireLedgerLock(");
    const ledger = body.indexOf("new AuditLedger(");
    expect(lock).toBeGreaterThan(0);
    expect(ledger).toBeGreaterThan(lock);
  });
});
