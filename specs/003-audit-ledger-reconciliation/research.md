# Research: Audit Ledger & Reconciliation

Technical Context had no `NEEDS CLARIFICATION` items. This file records the design decisions.

## R1. Canonical JSON for hashing

- **Decision**: Serialize with recursively sorted object keys and no whitespace. Arrays keep
  their order. Hash with `sha256` and store the result as lowercase hex.
  `hash = sha256(canonicalJSON({seq, ts, type, sessionId?, intentId?, authorizationId?, data, prevHash}))`.
  Omit absent optional fields, rather than writing them as `null`.
- **Rationale**: Plain `JSON.stringify` key order depends on insertion order, so a reload or
  rewrite could change the hash without any semantic change. Canonical form makes the hash a
  function of content only.
- **Alternatives considered**:
  - RFC 8785 JCS: rejected because it needs extra number-formatting rules we don't need. All
    amounts are strings, and the only numbers are `seq`, `validBefore`, `confirmations` and
    `expiresAtMs`, which are all integers.
  - A third-party canonicalizer: rejected as an unnecessary dependency.

## R2. Synchronous append for durability and ordering

- **Decision**:
  1. Build the entry in memory.
  2. Write `JSON.stringify(entry) + "\n"` with `fs.appendFileSync`.
  3. Push it to the in-memory array only after the write succeeds.

  No fsync is done per entry.
- **Rationale**: Inside the serialized authorize section, a synchronous append guarantees
  that `seq` and `prevHash` are assigned and persisted in order, with no interleaving. If the
  write throws, memory never gets ahead of disk. Leaving out fsync is acceptable for a PoC:
  a torn last line after a crash is detected at startup (fail closed), not silently repaired.
- **Alternatives considered**:
  - An async write stream: rejected because writes can interleave or be buffered across
    awaits.
  - Per-entry `fsyncSync`: deferred to EXT-6 (SQLite WAL), where durability is handled
    properly.

## R3. Startup integrity: fail closed

- **Decision**: The constructor reads the file, parses each line and runs `verifyChain()`. On
  any parse error or broken link or hash, it throws `Error("integrity: ...")`, and the L2
  process exits. A missing file means an empty ledger (genesis).
- **Rationale**: INV-9 and SEC-7. Auto-repair (truncating to the last good entry) would let an
  attacker delete recent entries, for example authorizations, and so free budget.
- **Alternatives considered**: Truncate and continue (rejected, see above). Signed checkpoints
  (out of scope; this would be a future extension).

## R4. `brokenAt` semantics

- **Decision**: `brokenAt` is the 0-based line index of the first line that cannot be parsed,
  whose hash does not recompute, or whose `prevHash` does not equal the previous entry's hash.
  On an untampered prefix the line index equals `seq`, so one numbering covers every case.
  Recorded in SPEC.md via 008 T000.
- **Rationale**: It points the auditor at the first untrustworthy entry. Everything before it
  is still verified.

## R5. Committed spend as a pure scan

- **Decision**: `committedAtomic({sessionId?, sinceMs?}, nowMs)` works in three steps:
  1. Build `effective = Map<authorizationId, latest SETTLEMENT entry with anomaly !== true>`.
  2. Sum `BigInt(data.amount)` over the AUTHORIZED entries that pass the filter, where
     `sinceMs` compares against `Date.parse(ts)`.
  3. Skip an entry only when `effective.status === "NOT_SETTLED"` and
     `nowMs > data.validBefore * 1000`.
- **Rationale**: This follows INV-7, NFR-005 (conservative) and NFR-007 (deterministic in
  `nowMs`). PENDING, MISMATCH and missing reports keep counting, so a late settlement can
  never exceed the budget (SEC-9).
- **Alternatives considered**:
  - Releasing on NOT_SETTLED immediately: rejected because the signature could still settle
    before `validBefore`.
  - Caching running totals: rejected because it is a mutable counter (INV-7).

## R6. Reconcile decision order

- **Decision**:
  1. Look up the AUTHORIZED entry; if there is none, return 404.
  2. Do a field cross-check on asset, payer, payTo and amount (lowercased strings). On any
     difference, the entry gets `status: "MISMATCH"`, `anomaly: true`, and `detail` naming the
     fields (for example `"verified field mismatch: amount"`).
  3. Check stickiness: if a non-anomalous CONFIRMED already exists and the new report is not
     (CONFIRMED with the same `transaction`), set `anomaly: true`.
  4. Otherwise set `anomaly: false`.

  Append a `SETTLEMENT` entry with the authorization's `sessionId` and `authorizationId`.
  Respond `{ok: true, anomaly}`.
- **Rationale**: The field check comes first, so a forged amount is always labeled MISMATCH,
  even before any CONFIRMED exists (SEC-5). Stickiness then protects INV-11. A repeated,
  identical CONFIRMED report is non-anomalous, so L3 re-checks are idempotent.
- **Alternatives considered**: Rejecting anomalous reports with 4xx was rejected: storing
  them preserves evidence for the auditor, and the effective-report rule already neutralizes
  them.

## R7. Reconcile runs inside the same mutex

- **Decision**: `POST /v1/reconcile` appends through the same serialized section as authorize.
  Recorded in SPEC.md via 008 T000.
- **Rationale**: There is one writer, so `seq` and `prevHash` stay strictly ordered (NFR-004),
  and a reconcile can never interleave with a check→sign→append sequence.
