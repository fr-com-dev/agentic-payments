# Contract: Settlement verifier (L3-1)

The verifier implements `SettlementVerifierPort` from `src/shared/contracts.ts`:

```ts
interface SettlementVerifierPort { verify(claim: SettlementClaim): Promise<SettlementReport> }

function finalityClassFor(amountAtomic: bigint): FinalityClass;
// ≤ 10_000n → "included"; ≤ 1_000_000n → "confirmed-depth"; else "l1-safe"

class ChainSettlementVerifier implements SettlementVerifierPort {
  constructor(deps: {
    publicClient: PublicClient;          // viem, read-only; no wallet client accepted
    net: NetworkProfile;                 // rpcUrl, confirmationDepth, supportsSafeTag (CFG-1, owned by 006)
    waitMs?: number;                     // default 45_000
    pollMs?: number;                     // default 1_000
  });
  verify(claim: SettlementClaim): Promise<SettlementReport>;
}
```

## Chain reads used (and nothing else)

| Call | Purpose |
|---|---|
| `waitForTransactionReceipt({ hash, timeout: deadline − Date.now(), pollingInterval: pollMs })` (one shared deadline per call) | inclusion and success |
| `parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs })` | match (asset, payer, payTo, amount) |
| `getBlockNumber()` | `confirmations = head − block + 1` |
| `getBlock({ blockTag: "safe" })` | `l1-safe` finality, only when `supportsSafeTag` |

Forbidden in `src/layer3-settlement/**` (checked by the 007 architecture test, INV-4):
`createWalletClient`, `signTypedData`, `writeContract`, `privateKeyToAccount`,
`mnemonicToAccount`.

## Decoding

Decode `PAYMENT-RESPONSE` only with `decodePaymentResponseHeader` from `@x402/core/http`.
The header format is owned by 006 (§10 wire formats); see
[`specs/006-counterparty-seller-network/contracts/`](../../006-counterparty-seller-network/contracts/).

## Service options (`service.ts`)

| Option | Default | Env / override |
|---|---|---|
| port | 4023 | `SETTLEMENT_PORT` |
| recheckAttempts | 5 | constructor option (tests) |
| recheckIntervalMs | 30000 | constructor option (tests) |
| reconciler | HTTP `ReconciliationPort` to `CONTROL_URL` | injectable for tests |
