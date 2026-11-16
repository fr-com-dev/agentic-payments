// 1.19 (Phase 3, finding #7) — the ledger's keyed chain (SPEC.md §8.2 L2-4, INV-9; T-LED-05). The hash chain alone
// lets anyone who can write the file rewrite an entry and recompute every hash after it. With LEDGER_MAC_KEY, every
// new entry carries an HMAC of its hash that nobody without the key can recompute.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditLedger, GENESIS_PREV_HASH, hashEntry, verifyLines, type LedgerEntry } from "../src/layer2-control/ledger.js";
import { ledgerMacKeyFromEnv, type LedgerMacKey } from "../src/layer2-control/ledger-key.js";

const T0 = Date.parse("2026-11-16T12:00:00.000Z");
const HEX_KEY = "11".repeat(32);
const KEY: LedgerMacKey = { key: Buffer.from(HEX_KEY, "hex"), keyedFrom: 0 };

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ledger-key-"));
  file = join(dir, "ledger.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const lines = () => readFileSync(file, "utf8").split("\n").filter((l) => l !== "");
const write = (ls: string[]) => writeFileSync(file, ls.map((l) => `${l}\n`).join(""));
const fill = (l: AuditLedger, n: number, from = 0) => {
  for (let i = 0; i < n; i++) l.append({ type: "INTENT", sessionId: "s", intentId: `int_${from + i}`, data: { resourceUrl: "http://x/y", purpose: "p", accepts: [] } }, T0 + i);
};

/** What someone with write access but no key can do: change entry `at` and recompute every hash from there on. */
function rewrite(ls: string[], at: number, change: (e: LedgerEntry) => void, stripMacs = false): string[] {
  const out: string[] = [];
  let prev = GENESIS_PREV_HASH;
  ls.forEach((line, i) => {
    const e = JSON.parse(line) as LedgerEntry;
    if (i === at) change(e);
    if (stripMacs) delete e.mac;
    if (i >= at) {
      e.prevHash = prev;
      e.hash = hashEntry(e);
    }
    prev = e.hash;
    out.push(JSON.stringify(e));
  });
  return out;
}

describe("T-LED-05 LEDGER_MAC_KEY", () => {
  it("T-LED-05 off or unset means no key; a value needs at least 32 bytes; an error never repeats the value", () => {
    expect(ledgerMacKeyFromEnv({})).toBeUndefined();
    expect(ledgerMacKeyFromEnv({ LEDGER_MAC_KEY: "off" })).toBeUndefined();
    expect(ledgerMacKeyFromEnv({ LEDGER_MAC_KEY: HEX_KEY })).toEqual({ key: Buffer.from(HEX_KEY, "hex"), keyedFrom: 0 });
    expect(ledgerMacKeyFromEnv({ LEDGER_MAC_KEY: `1234:${HEX_KEY}` })?.keyedFrom).toBe(1234);
    expect(ledgerMacKeyFromEnv({ LEDGER_MAC_KEY: Buffer.alloc(32, 7).toString("base64") })?.key).toEqual(Buffer.alloc(32, 7));
    for (const bad of ["short", "11".repeat(31), `x:${HEX_KEY}`, "not base64!"]) {
      let message = "";
      try {
        ledgerMacKeyFromEnv({ LEDGER_MAC_KEY: bad });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, bad).toMatch(/^LEDGER_MAC_KEY must be off/);
      expect(message).not.toContain(bad);
    }
  });
});

describe("T-LED-05 the keyed chain", () => {
  it("T-LED-05 every entry written with the key carries a MAC; the ledger reopens with the key, and refuses to open without it", () => {
    fill(new AuditLedger(file, { mac: KEY }), 3);
    expect(lines().map((l) => typeof (JSON.parse(l) as LedgerEntry).mac)).toEqual(["string", "string", "string"]);
    expect(new AuditLedger(file, { mac: KEY }).verifyChain()).toEqual({ entries: 3, ok: true });
    expect(() => new AuditLedger(file)).toThrow(/is keyed; start L2 with its LEDGER_MAC_KEY/);
  });

  it("T-LED-05 an entry rewritten with every hash recomputed, or with the MACs stripped, is refused with the key", () => {
    fill(new AuditLedger(file, { mac: KEY }), 4);
    const original = lines();
    const raised = rewrite(original, 1, (e) => (e.data.purpose = "rewritten"));
    expect(verifyLines(raised, KEY)).toEqual({ entries: 4, ok: false, brokenAt: 1 });
    const stripped = rewrite(original, 1, (e) => (e.data.purpose = "rewritten"), true);
    expect(verifyLines(stripped, KEY)).toEqual({ entries: 4, ok: false, brokenAt: 0 });
    write(stripped);
    expect(() => new AuditLedger(file, { mac: KEY })).toThrow(/integrity/);
  });

  it("T-LED-05 must fail: with hashes only, the same rewrite verifies, which is what the key prevents", () => {
    fill(new AuditLedger(file, { mac: KEY }), 4);
    const stripped = rewrite(lines(), 1, (e) => (e.data.purpose = "rewritten"), true);
    expect(verifyLines(stripped)).toEqual({ entries: 4, ok: true });
  });

  it("T-LED-05 another key is refused at the first keyed entry", () => {
    fill(new AuditLedger(file, { mac: KEY }), 2);
    expect(() => new AuditLedger(file, { mac: { key: Buffer.alloc(32, 9), keyedFrom: 0 } })).toThrow(/broken at line 0/);
  });

  it("T-LED-05 an existing ledger is adopted as it is: its first n entries may stay unkeyed, every later one is keyed", () => {
    fill(new AuditLedger(file), 3);
    const adopted = { ...KEY, keyedFrom: 3 };
    const l = new AuditLedger(file, { mac: adopted });
    fill(l, 2, 3);
    expect(lines().map((x) => (JSON.parse(x) as LedgerEntry).mac === undefined)).toEqual([true, true, true, false, false]);
    expect(l.verifyChain()).toEqual({ entries: 5, ok: true });
    // Rewriting the unkeyed beginning breaks the first keyed entry, whose MAC covers the chain before it.
    expect(verifyLines(rewrite(lines(), 0, (e) => (e.data.purpose = "rewritten")), adopted)).toMatchObject({ ok: false, brokenAt: 3 });
    // Cut back past the point the key was adopted: broken at its end.
    write(lines().slice(0, 2));
    expect(verifyLines(lines(), adopted)).toEqual({ entries: 2, ok: false, brokenAt: 2 });
  });

  it("T-LED-05 an unkeyed entry after a keyed one is refused", () => {
    fill(new AuditLedger(file), 2);
    fill(new AuditLedger(file, { mac: { ...KEY, keyedFrom: 2 } }), 1, 2);
    const ls = lines();
    const last = JSON.parse(ls[2]!) as LedgerEntry;
    const unkeyed: LedgerEntry = { ...last, seq: 3, intentId: "int_x", prevHash: last.hash, hash: "", mac: undefined };
    delete unkeyed.mac;
    unkeyed.hash = hashEntry(unkeyed);
    expect(verifyLines([...ls, JSON.stringify(unkeyed)], { ...KEY, keyedFrom: 2 })).toMatchObject({ ok: false, brokenAt: 3 });
    // A ledger shorter than the point of adoption is refused outright.
    expect(() => new AuditLedger(file, { mac: { ...KEY, keyedFrom: 5 } })).toThrow(/broken at line 3/);
  });
});
