# Contract: Network profile and local deployment (CFG-1, CP-5)

## `networkProfile(name?: string): NetworkProfile` (`src/shared/config.ts`)

- `name` defaults to `process.env.NETWORK ?? "local"`. An unknown name throws.
- The fields and per-network values are in [../data-model.md](../data-model.md#networkprofile-cfg-1).
- Consumers:

  | Consumer | Fields used |
  |---|---|
  | L2 (002) | `caip2` and `asset`, for the allowed networks and assets |
  | L2 signer | `caip2` and `assetDomain` |
  | L3 (005) | `rpcUrl`, `confirmationDepth`, `supportsSafeTag` |
  | Seller | `caip2`, `asset`, `assetDomain`, `facilitatorUrl` |
  | Facilitator | `caip2`, `rpcUrl` |

## Overrides

| Env var | Affects |
|---|---|
| `NETWORK` | profile selection |
| `BASE_SEPOLIA_RPC_URL` | `base-sepolia.rpcUrl` |
| `FACILITATOR_URL` | `facilitatorUrl` (both networks) |

## `.local/deployment.json` (written by `scripts/local-chain-lib.ts`)

```json
{
  "chainId": 31337,
  "rpcUrl": "http://127.0.0.1:8545",
  "asset": "0x…",
  "accounts": { "deployer": "0x…", "facilitator": "0x…", "payer": "0x…", "sellerPayTo": "0x…" },
  "deployedAt": "2026-10-16T00:00:00.000Z"
}
```

- It contains addresses only, never keys.
- It is regenerated on every local chain start.
- If it is missing, `local.rpcUrl` falls back to `http://127.0.0.1:8545`, and `local.asset`
  is unresolved. Consumers that need the asset fail fast.

## Local chain (`npm run local:chain`)

| Step | Result |
|---|---|
| Start ganache | :8545, chainId 31337, hardfork `shanghai`, fixed mnemonic (`myth like bonus … collect`) |
| Deploy MockUSDC from #0 | asset address |
| `mint(#2, 10_000_000)` | payer balance = 10 USDC |
| Write the deployment file | `.local/deployment.json` |

`localDevKeys()` (exported by `scripts/local-chain-lib.ts`, local only) returns the #1 and #2
private keys derived from the mnemonic for the demo. It is used only by `scripts/**` and its
output is never written to disk. The chain port 8545 is fixed.
