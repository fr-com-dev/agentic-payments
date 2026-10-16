# Data Model: Counterparty Seller, Facilitator and Network Profiles

## CatalogItem (seller `CATALOG`)

| path | priceAtomic | description | body |
|---|---|---|---|
| `/api/weather` (query `city`) | `"1000"` | current weather for a city | `{city, tempC, condition, source}` (deterministic per city) |
| `/api/market-brief` | `"5000"` | daily market brief | `{headline, bullets[3], source}` |
| `/api/premium-report` | `"50000"` | premium research report | `{title, pages: 42, source}` |
| `/api/dataset-export` | `"500000"` | full dataset export | `{rows: 1000000, source}` |

Validation:
- `priceAtomic` is a positive integer string.
- The query string never affects the price.
- A new route is added only to `CATALOG`. If that changes the scripted plan, update SPEC L1-4
  and T-E2E-01.

## PaymentRequirements (one `accepts[]` entry, emitted by the seller)

| Field | Value |
|---|---|
| scheme | `"exact"` |
| network | `net.caip2` |
| asset | `net.asset` |
| amount | `priceAtomic` |
| payTo | `SELLER_PAY_TO` (local default: account #3) |
| maxTimeoutSeconds | `120` |
| extra | `net.assetDomain`, i.e. `{name, version}` |

## NetworkProfile (CFG-1)

| Field | Type | local | base-sepolia |
|---|---|---|---|
| name | string | `local` | `base-sepolia` |
| caip2 | string | `eip155:31337` | `eip155:84532` |
| chainId | number | 31337 | 84532 |
| rpcUrl | string | deployment `rpcUrl`, else `http://127.0.0.1:8545` | `BASE_SEPOLIA_RPC_URL`, else `https://sepolia.base.org` |
| asset | address | deployment `asset` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| decimals | number | 6 | 6 |
| assetDomain | `{name, version}` | `{"USD Coin","2"}` | `{"USDC","2"}` |
| facilitatorUrl | string | `FACILITATOR_URL`, else `http://127.0.0.1:4022` | `FACILITATOR_URL`, else `https://x402.org/facilitator` |
| confirmationDepth | number | 1 | 2 |
| supportsSafeTag | boolean | false | true |

Selection: `NETWORK`, default `local`. An unknown name throws.

## LocalDeployment (`.local/deployment.json`)

| Field | Type | Notes |
|---|---|---|
| chainId | number | 31337 |
| rpcUrl | string | `http://127.0.0.1:8545` |
| asset | address | the MockUSDC address |
| accounts | `{deployer, facilitator, payer, sellerPayTo}` | addresses of #0–#3 |
| deployedAt | string | ISO timestamp |

It holds addresses only, never private keys. Keys go into the per-process env files.

## EIP3009Authorization (signed by L2, settled by the facilitator)

| Field | Type | Rule |
|---|---|---|
| from | address | the payer (#2 locally) |
| to | address | must equal `payTo` |
| value | uint256 | must equal `amount` |
| validAfter, validBefore | uint256 (seconds) | the token requires `validAfter < now < validBefore` |
| nonce | bytes32 | single use, tracked by `authorizationState` |

### Authorization nonce state (MockUSDC)

```text
unused ──transferWithAuthorization (valid window, valid sig)──► used  (emits AuthorizationUsed + Transfer)
used   ──any resubmission─────────────────────────────────────► revert
```

## Local accounts (CP-5)

| Index | Role | Holder |
|---|---|---|
| #0 | deployer and MockUSDC owner | scripts only |
| #1 | facilitator (pays gas) | `env/facilitator.env`, turned into an account only in `scripts/facilitator.ts` (demo: `localDevKeys()`, facilitator child only) |
| #2 | payer, minted 10 USDC | `env/l2-control.env` (L2 only; demo: `localDevKeys()`, L2 child only) |
| #3 | seller payTo | `env/seller.env` (address only) |
