# Contract: e2e harness (`test/helpers/harness.ts`) and T-E2E-01

## Harness API

```ts
interface HarnessOptions {
  signerLatencyMs?: number;        // L2 test hook (T-E2E-04 uses 25)
  ports?: Partial<{ chain: number; control: number; seller: number;
                    facilitator: number; settlement: number }>;
  mandateOverrides?: Partial<SpendingMandate>;  // shape owned by 002
}
interface Harness {
  urls: { seller: string; control: string; settlement: string; facilitator: string };
  tokens: { control: string; verifier: string; settlement: string; operator: string };
  addresses: { payer: `0x${string}`; payTo: `0x${string}`; asset: `0x${string}` };
  balanceOf(addr: `0x${string}`): Promise<bigint>;
  ledgerPath: string;              // fresh temp file per harness
  close(): Promise<void>;          // stops every server and the chain, frees ports
}
function startHarness(opts?: HarnessOptions): Promise<Harness>;
```

Rules:
- The seller binds to `0.0.0.0`. The allowlisted host is `127.0.0.1:<seller>`, and the
  non-allowlisted alias is `localhost:<seller>`.
- Each `startHarness` uses a new ledger file, so tests never share ledger state.
- `close()` runs in `afterAll`, even when a test fails.
- The harness may import across layers (INV-1 permits `test/**`). The architecture test
  (owned by 007) excludes `test/**`.

## T-E2E-01 assertions (owned here)

Run the scripted agent (feature 001) with the default mandate against a fresh harness:

| # | Assertion |
|---|---|
| 1 | `outcomes` deep-equals `["FREE","PAID","PAID","ESCALATED","DENIED","DENIED"]` |
| 2 | step 4 violations include `human_approval_required` |
| 3 | step 5 violations include `hard_cap_exceeded` |
| 4 | step 6 violations include `host_not_allowed` |
| 5 | `balanceBefore(payer) - balanceAfter(payer) === 6000n`, and `payTo` gains exactly 6000n |
| 6 | exactly 2 non-anomalous CONFIRMED `SETTLEMENT` ledger entries |
| 7 | `GET /v1/ledger/verify` returns `ok: true` |
| 8 | `GET /v1/budget/:sessionId` returns `spentOrReservedAtomic === "6000"` |

Other e2e tests reuse the harness but are owned elsewhere:
- T-E2E-02 by 004
- T-E2E-03 by 003 and 005
- T-E2E-04 by 002 (with `signerLatencyMs: 25`)
- T-E2E-05 by 003 and 007
