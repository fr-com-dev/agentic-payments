# Quickstart: CDP Facilitator on Base Sepolia

Validation guide for feature 009. Details live in [contracts/](contracts/) and
[data-model.md](data-model.md).

## 1. Offline gate (no CDP account, no internet)

```bash
npm install
npm run check        # typecheck + test + demo:local
```

Expected:

- All suites are green, including `architecture` (A1–A8, T-ARCH-ENV) and the new `cdp-*` suites (T-CDP-01..09).
- The `demo:local` summary is unchanged: `spent on-chain: 0.006 USDC` and `hash chain ok=true entries=<n>`.

Targeted runs:

```bash
npx vitest run test/cdp-config.test.ts test/cdp-auth.test.ts test/cdp-isolation.test.ts test/cdp-failures.test.ts
npx vitest run test/architecture.test.ts -t "A8"             # credential confinement + fixture trips
npx vitest run test/verifier.test.ts -t "FR-020"             # failure claim carrying a hash is checked on-chain
npx vitest run test/cdp-failures.test.ts -t "T-CDP-06"       # must-fail proof: CONFIRMED with FR-020, NOT_SETTLED without
```

## 2. Create a CDP API key

1. In the CDP portal (cdp.coinbase.com), create a **Secret API key** for a project used only by this seller.
2. Grant it the narrowest permissions and access restrictions that CDP offers for x402. Do not use a key that controls a funded CDP wallet.
3. Keep the key ID and the secret. Ed25519 (a base64 string) is the recommended format. EC keys work in either PEM form: PKCS#8 (`-----BEGIN PRIVATE KEY-----`) or SEC1 (`-----BEGIN EC PRIVATE KEY-----`). The seller converts SEC1 to PKCS#8 at startup.

## 3. Configure the seller (Base Sepolia)

`env/seller.base-sepolia.env` is gitignored. This is the only file that gets the CDP key.

```dotenv
NETWORK=base-sepolia
SELLER_PAY_TO=0x<your payee>
# FACILITATOR defaults to cdp on base-sepolia
CDP_API_KEY_ID=<key id>
CDP_API_KEY_SECRET="<secret>"   # quote a PEM key; newlines allowed
```

The other env files for L1, L2, L3 and the operator do not change. Do **not** add the CDP
variables to them, because T-ARCH-ENV and A8 forbid it.

To use the public facilitator instead, which needs no key:

```dotenv
FACILITATOR=public
# FACILITATOR_URL=https://x402.org/facilitator   (default)
```

## 4. Startup checks

```bash
ENV_FILE=env/seller.base-sepolia.env npm run seller
```

Expected log line:

```text
seller listening on 0.0.0.0:4021 (eip155:84532, facilitator=cdp host=api.cdp.coinbase.com key=…abcd)
```

Fail-closed drills (each exits 1 before listening, and no secret is printed):

| Change | Expected stderr |
|---|---|
| empty `CDP_API_KEY_SECRET` | `seller: missing CDP_API_KEY_SECRET (required for FACILITATOR=cdp)` |
| set `FACILITATOR_URL=https://example.org` | `seller: invalid facilitator config: FACILITATOR=cdp cannot be combined with FACILITATOR_URL` |
| `NETWORK=local` with `FACILITATOR=cdp` | `seller: invalid facilitator config: FACILITATOR=cdp is not valid on NETWORK=local` |
| a garbage secret | `seller: CDP_API_KEY_SECRET is not a valid Ed25519 (base64) or EC (PEM) key` |

Wrong but well-formed key, a runtime drill:

```bash
curl -i http://127.0.0.1:4021/api/weather?city=Lima
# HTTP/1.1 503 … {"error":"facilitator authentication","category":"authentication"}
curl -s http://127.0.0.1:4021/api/catalog   # still 200
```

## 5. Live acceptance run (opt-in, T-E2E-06)

Prerequisites:

- The payer (`env/l2-control.base-sepolia.env`) holds at least 0.01 test USDC from faucet.circle.com. It needs no ETH.
- `env/{seller,l2-control,l3-verifier,l1-agent}.base-sepolia.env` are filled in, with all bearer tokens set.
- The env layout is pinned so the scripted plan's outcomes are reproducible. Step 6 of the plan re-requests the weather through the `localhost` alias and must be DENIED for a host that is not allowlisted:

  | File | Setting |
  |---|---|
  | `l1-agent.base-sepolia.env` | `SELLER_URL=http://127.0.0.1:4021` |
  | `l2-control.base-sepolia.env` | `ALLOWED_HOSTS=127.0.0.1:4021` exactly (no `localhost` entry) |
  | `l2-control.base-sepolia.env` | `ALLOWED_PAYEES` includes `SELLER_PAY_TO` |

  Use another port only if `SELLER_PORT` in the seller file matches it everywhere.

```bash
npm run demo:base-sepolia
```

Expected (exit 0). These are the local demo's summary lines, plus three live-only lines before
the closing rule:

```text
==== demo summary ====
network:            base-sepolia
session:            sess_<8 hex>
outcomes:           FREE, PAID, PAID, ESCALATED, DENIED, DENIED
spent on-chain: 0.006 USDC
budget:             spentOrReserved=6000 remaining=94000 (atomic)
hash chain ok=true entries=<n>
settlements:        2 CONFIRMED
payer gas spent:    0 wei
secret scan:        clean
======================
```

- `spent on-chain` is the payee's USDC delta.
- `payer gas spent` sums gas over the settlement receipts sent by the payer. It is 0, because CDP submits them.
- `secret scan` checks every captured process line and the Base Sepolia ledger for the CDP secret, without printing it.
- `remaining` assumes the default mandate (session budget 100000).

SC-001 asks for 3 consecutive passing runs. Each run uses 2 CDP settlements.

The script refuses to start (exit 2, with one fixed line naming the problem) in these cases:

- The seller's Base Sepolia env file does not resolve to `FACILITATOR=cdp` with both CDP values present.
- `SELLER_URL`, `ALLOWED_HOSTS` or `ALLOWED_PAYEES` break the layout above.

## 6. Clean-up check

```bash
lsof -i :4020 -i :4021 -i :4023   # no listeners remain after either demo
```
