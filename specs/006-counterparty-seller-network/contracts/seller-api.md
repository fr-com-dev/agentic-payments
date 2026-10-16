# Contract: Seller API (CP-1)

The seller listens on port `SELLER_PORT`, default 4021, on all interfaces. Its environment
comes from `env/seller.env`: `NETWORK`, `SELLER_PAY_TO` and an optional `FACILITATOR_URL`.

## GET /api/catalog (free; mounted before the payment middleware)

200:
```json
{
  "network": "eip155:31337",
  "asset": "0x…",
  "decimals": 6,
  "items": [
    { "path": "/api/weather?city=", "priceAtomic": "1000",   "description": "…" },
    { "path": "/api/market-brief",  "priceAtomic": "5000",   "description": "…" },
    { "path": "/api/premium-report","priceAtomic": "50000",  "description": "…" },
    { "path": "/api/dataset-export","priceAtomic": "500000", "description": "…" }
  ]
}
```

This route never returns 402.

## Priced routes (all GET)

| Route | Unpaid | Paid and settled |
|---|---|---|
| `/api/weather?city=<c>` | 402 + `PAYMENT-REQUIRED` (amount 1000) | 200 `{city, tempC, condition, source}` + `PAYMENT-RESPONSE` |
| `/api/market-brief` | 402 (5000) | 200 `{headline, bullets[3], source}` |
| `/api/premium-report` | 402 (50000) | 200 `{title, pages:42, source}` |
| `/api/dataset-export` | 402 (500000) | 200 `{rows:1000000, source}` |

- Each 402 carries exactly one `accepts` entry. Its format is in
  [x402-wire.md](x402-wire.md), and its field values are in
  [../data-model.md](../data-model.md).
- With an invalid or unverifiable `PAYMENT-SIGNATURE`, the middleware answers 402 again with
  an error. The handler does not run.
- Verify and settle go to `net.facilitatorUrl` through `HTTPFacilitatorClient`.
