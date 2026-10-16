# Quickstart: validate Counterparty Seller, Facilitator and Network Profiles

## Prerequisites

- Node.js 22. Run `npm install` (not `npm ci`).
- Copy `env/seller.env.example` and `env/facilitator.env.example` to `.env` files (one per
  process).

## 1. Local chain (M2)

```bash
npm run local:chain
cat .local/deployment.json
```

Expected:
- ganache listens on :8545 (ignore the `uws_linux` warning).
- The deployment JSON matches [contracts/network-profile.md](contracts/network-profile.md).
- The payer (#2) balance is `10000000` atomic (SC-003).

## 2. Seller and facilitator (M3)

```bash
ENV_FILE=env/facilitator.env npm run facilitator
ENV_FILE=env/seller.env npm run seller
curl -s http://127.0.0.1:4021/api/catalog
curl -si "http://127.0.0.1:4021/api/weather?city=Lima" | head -20
```

Expected:
- The catalog returns 200 with 4 items, and never 402.
- The weather request returns `402` with a `PAYMENT-REQUIRED` header.
- Decoded with `decodePaymentRequiredHeader`, the header has exactly 1 `accepts` entry:
  `exact`, `eip155:31337`, amount `1000`, `maxTimeoutSeconds` 120,
  `extra.name` `"USD Coin"`. See [contracts/x402-wire.md](contracts/x402-wire.md).

## 3. Facilitator guard

```bash
NETWORK=base-sepolia ENV_FILE=/dev/null npm run facilitator; echo "exit=$?"
```

Expected: a non-zero exit with a "local only" message.

## 4. Paid settlement end to end (T-E2E-01)

```bash
npx vitest run test/e2e.local.test.ts -t "T-E2E-01"
```

Expected:
- The seller payTo (#3) balance rises by exactly 6000 (SC-002).
- Each paid response carries a `PAYMENT-RESPONSE` with `success:true` and a tx hash.

## 5. Token behavior (CP-4)

The checks in [contracts/mockusdc-abi.md](contracts/mockusdc-abi.md) must hold:
- Resubmitting a used authorization reverts, and `authorizationState` returns `true` (SC-004).
- An authorization outside the validity window reverts.
- `mint` from a non-owner reverts.

## 6. Base Sepolia (optional)

1. Set `NETWORK=base-sepolia` in the seller, L2 and L3 env files.
2. Fund the payer with test USDC (faucet.circle.com).
3. Do not start the local facilitator.

Expected:
- The challenge `extra.name` is `"USDC"` and the network is `eip155:84532`.
- Settlement goes through `https://x402.org/facilitator`.
