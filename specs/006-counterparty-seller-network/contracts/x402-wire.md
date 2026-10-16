# Contract: x402 v2 wire headers (§10)

This is the canonical wire contract. Features 001 (L1), 002 (L2 signer) and 005 (L3) link
here.

All headers are base64-encoded JSON and MUST be produced and parsed **only** with the
`@x402/core/http` helpers. Never hand-roll base64.

| Header | Direction | Encoder / decoder |
|---|---|---|
| `PAYMENT-REQUIRED` | seller → L1, on HTTP 402 | `encodePaymentRequiredHeader` / `decodePaymentRequiredHeader` |
| `PAYMENT-SIGNATURE` | L1 → seller (produced by L2) | `encodePaymentSignatureHeader` (L2 signer) / decoded by the seller middleware |
| `PAYMENT-RESPONSE` | seller → L1, on a paid 2xx | produced by the seller middleware / `decodePaymentResponseHeader` (L3) |

## PAYMENT-REQUIRED

```json
{
  "x402Version": 2,
  "resource": { "url": "http://127.0.0.1:4021/api/weather?city=Lima", "...": "..." },
  "accepts": [
    { "scheme": "exact", "network": "eip155:31337", "asset": "0x…", "amount": "1000",
      "payTo": "0x…", "maxTimeoutSeconds": 120,
      "extra": { "name": "USD Coin", "version": "2" } }
  ],
  "extensions": {}
}
```

## PAYMENT-SIGNATURE

```json
{
  "x402Version": 2,
  "accepted": { "...": "the single PaymentRequirements L2 approved" },
  "payload": {
    "signature": "0x…",
    "authorization": { "from": "0x…", "to": "0x…", "value": "1000",
      "validAfter": "…", "validBefore": "…", "nonce": "0x…" }
  }
}
```

## PAYMENT-RESPONSE

```json
{ "success": true, "transaction": "0x…", "network": "eip155:31337", "payer": "0x…" }
```

On failure, `success` is false and `errorReason` is set. The buyer side treats this header as
a claim only: L3 verifies on-chain (feature 005).

## Compatibility

- `extra.name` MUST match the token's EIP-712 name on that network: "USD Coin" locally,
  "USDC" on Base Sepolia.
- v1 fallback (a challenge in the 402 body, without a header) is a buyer-side tolerance in
  feature 001. This seller always emits the v2 header.
