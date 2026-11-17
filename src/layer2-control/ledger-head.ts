// 1.23 (SPEC.md §8.2 L2-4, INV-9, SEC-39; Phase 3 finding #7): the ledger's head, kept outside the ledger's share.
// The keyed chain (ledger-key.ts) makes a rewritten entry fail, but a ledger cut back to a shorter prefix still
// verifies: every entry left is genuine. Removing the newest entries releases what they recorded (a payment's amount,
// a rejection, a tightened policy). So L2 also writes the head, `{ entries, hash, mac }` (how many entries the ledger
// has, the hash of its last one, and a MAC of both under the ledger key), to a store only L2 can write
// (ledger-head-store.ts: a blob that only L2's head identity may write, in Azure), and checks the ledger against it at
// startup. The head is written inside the serialized section after every write (service.ts), before any answer that
// depends on the new entries leaves L2, so no cut of an entry whose effect left L2 goes unnoticed.
import { GENESIS_PREV_HASH, type AuditLedger, type LedgerEntry } from "./ledger.js";
import { headMac, headMacMatches, LEDGER_MAC_ENV, type LedgerMacKey } from "./ledger-key.js";

/** The head as stored: version 1. `mac` is present when L2 runs with a ledger key. */
export interface LedgerHead {
  v: 1;
  /** The number of entries the ledger had: the next `seq`. */
  entries: number;
  /** The last entry's hash, or 64 zeros for an empty ledger. */
  hash: string;
  /** hex(HMAC-SHA256(key, "x402-ledger-head-v1\n" + entries + "\n" + hash)). */
  mac?: string;
}

/**
 * Where the head lives. `read` gives the stored head, or undefined when none was ever written, and throws on anything
 * else (a store that can't be reached is never taken for an empty one). `write` replaces it, and throws when it can't,
 * or when another writer changed it since this store last read or wrote it (a compare-and-swap).
 */
export interface HeadStore {
  read(): Promise<unknown>;
  write(head: LedgerHead): Promise<void>;
  /** Where the head is, for the startup line. Never a credential. */
  readonly where: string;
}

/** A head that could not be written: the write that needed it answers 500 `internal error`, and nothing more is said. */
export class LedgerHeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerHeadError";
  }
}

const HASH_RE = /^[0-9a-f]{64}$/;

/** The head of a ledger as it is now. */
export function headFor(entries: readonly Pick<LedgerEntry, "hash">[], mac?: LedgerMacKey): LedgerHead {
  const n = entries.length;
  const hash = n === 0 ? GENESIS_PREV_HASH : entries[n - 1]!.hash;
  return { v: 1, entries: n, hash, ...(mac !== undefined && { mac: headMac(mac.key, n, hash) }) };
}

/** A stored value, if it has the shape of a head. */
export function parseHead(raw: unknown): LedgerHead | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const h = raw as Record<string, unknown>;
  const keys = Object.keys(h).sort().join(",");
  if (keys !== "entries,hash,v" && keys !== "entries,hash,mac,v") return undefined;
  if (h.v !== 1 || typeof h.entries !== "number" || !Number.isSafeInteger(h.entries) || h.entries < 0) return undefined;
  if (typeof h.hash !== "string" || !HASH_RE.test(h.hash)) return undefined;
  if (h.mac !== undefined && (typeof h.mac !== "string" || !HASH_RE.test(h.mac))) return undefined;
  return { v: 1, entries: h.entries, hash: h.hash, ...(h.mac !== undefined && { mac: h.mac as string }) };
}

/**
 * Why the stored head refuses this ledger, or undefined when the ledger is the head's ledger or a longer one.
 * - The head itself: well-formed; with a key, its MAC matches, and a head without one was written before the key was
 *   adopted (at most `keyedFrom` entries); without a key, it carries none (a keyed ledger needs its key).
 * - The ledger: at least `entries` entries (fewer is a cut), and its entry `entries - 1` has the head's hash (another
 *   ledger in its place).
 */
export function headProblem(raw: unknown, entries: readonly Pick<LedgerEntry, "hash">[], mac?: LedgerMacKey): string | undefined {
  const head = parseHead(raw);
  if (head === undefined) return "the ledger head is malformed";
  if (mac !== undefined) {
    if (head.mac !== undefined && !headMacMatches(mac.key, head.entries, head.hash, head.mac)) return "the ledger head's MAC does not match";
    if (head.mac === undefined && head.entries > mac.keyedFrom) return "the ledger head carries no MAC, but was written after the key was adopted";
  } else if (head.mac !== undefined) {
    return `the ledger head is keyed; start L2 with its ${LEDGER_MAC_ENV}`;
  }
  if (entries.length < head.entries) return `the ledger has ${entries.length} entries, fewer than the ${head.entries} its head records: entries were removed`;
  const at = head.entries === 0 ? GENESIS_PREV_HASH : entries[head.entries - 1]!.hash;
  if (at !== head.hash) return `the ledger's entry ${head.entries - 1} is not the one its head records`;
  return undefined;
}

export interface HeadOptions {
  mac?: LedgerMacKey;
  /** Checked before every head write (the ledger lock's `assertHeld`), like every append. */
  fence?: () => void;
  /**
   * Test-only (1.23 must-fail, T-LED-11; never set by main()): open the ledger without comparing it with the stored
   * head, as before 1.23. A ledger cut back to an earlier prefix then opens, and what the cut entries recorded no
   * longer counts.
   */
  skipHeadCheck?: boolean;
}

/**
 * Keeps the stored head at the ledger's tip. `flush` writes the head of the ledger as it is now, if it moved since the
 * last write; flushes run one after another, so the stored head only moves forward.
 */
export class LedgerHeadAnchor {
  private chain: Promise<unknown> = Promise.resolve();
  private last: LedgerHead | undefined;

  constructor(
    private readonly ledger: AuditLedger,
    private readonly store: HeadStore,
    private readonly opts: Pick<HeadOptions, "mac" | "fence"> = {},
  ) {}

  /** The head this process last wrote. */
  get written(): LedgerHead | undefined {
    return this.last;
  }

  get where(): string {
    return this.store.where;
  }

  /** Writes the ledger's current head unless it is already the stored one. Rejects with a LedgerHeadError. */
  flush(force = false): Promise<void> {
    const run = this.chain.then(() => this.writeTip(force));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async writeTip(force: boolean): Promise<void> {
    const entries = this.ledger.entries();
    if (!force && this.last !== undefined && this.last.entries === entries.length) return;
    this.opts.fence?.();
    const head = headFor(entries, this.opts.mac);
    try {
      await this.store.write(head);
    } catch (err) {
      throw err instanceof LedgerHeadError ? err : new LedgerHeadError(`ledger head: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.last = head;
    this.ledger.raiseHead(head);
  }
}

export interface OpenedHead {
  anchor: LedgerHeadAnchor;
  /** True when the store held no head: this ledger, as it is, is where the record starts. */
  adopted: boolean;
}

/**
 * Startup (L2-6, after the ledger loads under the lock): reads the stored head, refuses a ledger it doesn't describe
 * (`integrity: …`), then writes the head of the ledger as loaded, which also proves L2 can write it before anything is
 * served. No stored head: the ledger is adopted as it is (a new store, or the first start with 1.23).
 */
export async function openLedgerHead(ledger: AuditLedger, store: HeadStore, opts: HeadOptions = {}): Promise<OpenedHead> {
  let stored: unknown;
  try {
    stored = await store.read();
  } catch (err) {
    throw new LedgerHeadError(`ledger head: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (stored !== undefined && opts.skipHeadCheck !== true) {
    const problem = headProblem(stored, ledger.entries(), opts.mac);
    if (problem !== undefined) throw new Error(`integrity: ${problem}`);
  }
  const anchor = new LedgerHeadAnchor(ledger, store, { ...(opts.mac !== undefined && { mac: opts.mac }), ...(opts.fence !== undefined && { fence: opts.fence }) });
  await anchor.flush(true);
  return { anchor, adopted: stored === undefined };
}
