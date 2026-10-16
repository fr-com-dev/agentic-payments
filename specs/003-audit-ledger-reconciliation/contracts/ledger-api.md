# Contract: `AuditLedger` module (L2-4)

This is an internal L2 module. Only `src/layer2-control/*`, `test/*` and `scripts/*` may
import it.

```ts
class AuditLedger {
  constructor(filePath: string);               // load + verifyChain; throws Error("integrity: …")
  append(e: { type: EntryType; sessionId?: string; intentId?: string;
              authorizationId?: string; data: object }): LedgerEntry;  // sync write, then memory
  entries(): readonly LedgerEntry[];           // read-only view
  verifyChain(): { entries: number; ok: boolean; brokenAt?: number }; // brokenAt: 0-based line index
  findAuthorized(authorizationId: string): LedgerEntry | undefined;
  effectiveReport(authorizationId: string): SettlementReport & { anomaly: false } | undefined;
  committedAtomic(filter: { sessionId?: string; sinceMs?: number }, nowMs: number): bigint;
  authorizedSince(sinceMs: number): number;    // velocity count
  findOpenApproval(sessionId: string, resourceKey: string, nowMs: number): LedgerEntry | undefined;
    // implemented here (T043); semantics and tests: 004. Most recent HUMAN_APPROVAL for
    // (session, resourceKey) with nowMs ≤ expiresAtMs and no AUTHORIZED entry whose
    // data.approvalRef === data.approvalId. Single-use per approvalId.
}
function canonicalJSON(v: unknown): string;    // sorted keys, recursively; no whitespace
function resourceKey(url: string): string;     // origin + pathname
```

There is no method to update or delete an entry (INV-9).

## Invariants the module guarantees

| ID | Guarantee | Test |
|---|---|---|
| INV-7 | Every budget figure comes from `committedAtomic` or `authorizedSince`. No counters are stored. | code review, T-LED-02 |
| INV-9 | `append` is the only write path, and the constructor fails on a broken chain. | T-LED-01 |
| INV-11 | `effectiveReport` skips entries with `anomaly: true`. | T-LED-03 |
| NFR-007 | Methods that take `nowMs` never read the clock. | T-LED-02 |

## Reconcile algorithm (called from the service, inside the L2 mutex)

```text
(the service has already passed requireRole("verifier-control") and rejected a malformed body with 400)
auth = findAuthorized(r.authorizationId)            → none: 404
diff = [f for f in asset,payer,payTo,amount if lower(r.verified[f]) ≠ lower(auth.data[f])]
if diff:             store {...r, status:"MISMATCH", detail:"verified field mismatch: "+diff.join(","), anomaly:true}
elif eff=effectiveReport(id) is CONFIRMED and not (r.status=="CONFIRMED" and r.transaction==eff.transaction):
                     store {...r, anomaly:true}
else:                store {...r, anomaly:false}
return {ok:true, anomaly}
```

Note: `amount` is compared as a string. Both sides are canonical `^\d+$` atomic strings.
