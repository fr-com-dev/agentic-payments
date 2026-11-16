// SPEC L2-6 (011). One ledger writer: an exclusive lock file beside the ledger, taken in main() before the
// ledger is loaded. Not a ledger entry; never touches the hash chain. Container Apps runs the old and the
// new revision side by side during an update, so the replacement waits in standby until the old holder
// releases the lock (SIGTERM) or stops refreshing it (crash). specs/011 contracts/ledger-lock.md.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

export const HEARTBEAT_MS = 5_000;
export const STALE_MS = 30_000;
export const POLL_MS = 1_000;
/**
 * 1.19: how long a lock must stay unchanged, by this process's own clock, before a heartbeat that looks old counts.
 * Two missed heartbeats. A live holder rewrites its lock every HEARTBEAT_MS, so a lock that only *looks* old because
 * the other host's clock is behind ours is seen changing well within this time.
 */
export const SILENT_MS = 2 * HEARTBEAT_MS;

interface LockInfo {
  holder: string;
  pid: number;
  host: string;
  acquiredAt: string;
  heartbeatAt: string;
}

export interface LedgerLockOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Called when a heartbeat finds the lock gone or held by someone else. Default: exit 1. */
  onLost?: () => void;
  /** Test-only (1.19 must-fail, T-LED-10): judge staleness by the holder's heartbeat time alone, as before 1.19. */
  skipLocalStaleness?: boolean;
}

export interface LedgerLock {
  holder: string;
  /** Deletes the lock if it is still ours. Safe to call more than once. */
  release(): void;
  /** One heartbeat now (the timer calls it every HEARTBEAT_MS; tests call it directly). */
  beat(): void;
  /**
   * 1.19 (fencing): checks, synchronously, that the lock still names this holder, and reports the loss otherwise
   * (`onLost`, which exits) and throws. The ledger calls it before every append, so a holder that stalled past the
   * staleness window and was replaced can't write one more entry when it wakes up, before its next heartbeat.
   */
  assertHeld(): void;
}

const errCode = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code;

function readLock(path: string): LockInfo | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as Partial<LockInfo>;
    return typeof v.holder === "string" && typeof v.heartbeatAt === "string" ? (v as LockInfo) : null;
  } catch {
    return null;
  }
}

export async function acquireLedgerLock(ledgerPath: string, o: LedgerLockOptions = {}): Promise<LedgerLock> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = o.log ?? ((line: string) => console.log(line));
  const onLost =
    o.onLost ??
    (() => {
      console.error("l2-control: lost the ledger lock");
      process.exit(1);
    });
  const lockPath = `${ledgerPath}.lock`;
  const holder = `l2_${randomUUID()}`;
  const acquiredAt = new Date(now()).toISOString();
  const info = (): LockInfo => ({ holder, pid: process.pid, host: hostname(), acquiredAt, heartbeatAt: new Date(now()).toISOString() });
  mkdirSync(dirname(lockPath), { recursive: true });

  let loggedWait = false;
  let unreadableOnce = false;
  // 1.19: what the lock said when this process first saw it say that, by this process's clock. Staleness is judged
  // from how long the lock has stayed unchanged here, never from the other host's clock alone: a replica whose clock
  // runs ahead of the holder's would otherwise read a live heartbeat as stale and take over at once.
  let seen: { content: string; sinceMs: number } | undefined;
  for (;;) {
    try {
      writeFileSync(lockPath, JSON.stringify(info()), { flag: "wx" });
      break;
    } catch (e) {
      if (errCode(e) !== "EEXIST") throw e;
    }
    const current = readLock(lockPath);
    if (current !== null) {
      const content = `${current.holder}\n${current.heartbeatAt}`;
      if (seen === undefined || seen.content !== content) seen = { content, sinceMs: now() };
      const unchangedMs = now() - seen.sinceMs;
      const looksOld = now() - Date.parse(current.heartbeatAt) >= STALE_MS;
      const stale = o.skipLocalStaleness ? looksOld : unchangedMs >= STALE_MS || (looksOld && unchangedMs >= SILENT_MS);
      if (!stale) {
        if (!loggedWait) {
          log(`l2-control: ledger locked by ${current.holder} (pid ${current.pid} on ${current.host}); waiting`);
          loggedWait = true;
        }
        await sleep(POLL_MS);
        continue;
      }
    }
    if (current === null && !unreadableOnce) {
      // Possibly caught mid-write by another process: give it one more poll before calling it stale.
      unreadableOnce = true;
      await sleep(POLL_MS);
      continue;
    }
    const previous = current?.holder ?? "unknown";
    try {
      renameSync(lockPath, `${lockPath}.stale.${previous}.${now()}`);
      log(`l2-control: took over a stale ledger lock from ${previous}`);
    } catch (e) {
      if (errCode(e) !== "ENOENT") throw e;
    }
    unreadableOnce = false;
  }

  let released = false;
  const beat = () => {
    if (released) return;
    const current = readLock(lockPath);
    if (current === null || current.holder !== holder) {
      clearInterval(timer);
      onLost();
      return;
    }
    const tmp = `${lockPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(info()));
    renameSync(tmp, lockPath);
  };
  const timer = setInterval(beat, HEARTBEAT_MS);
  timer.unref();

  const assertHeld = () => {
    if (released || readLock(lockPath)?.holder !== holder) {
      clearInterval(timer);
      onLost();
      throw new Error("l2-control: lost the ledger lock");
    }
  };

  return {
    holder,
    beat,
    assertHeld,
    release: () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      if (readLock(lockPath)?.holder !== holder) return;
      try {
        unlinkSync(lockPath);
      } catch (e) {
        if (errCode(e) !== "ENOENT") throw e;
      }
    },
  };
}
