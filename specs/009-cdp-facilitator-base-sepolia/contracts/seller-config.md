# Contract: Seller facilitator configuration (CP-3, CFG-1, CFG-2 — amended)

## `env/seller.env.example` (exact variable set after this feature)

| Variable | Required | Notes |
|---|---|---|
| `NETWORK` | yes | `local` \| `base-sepolia` |
| `SELLER_PAY_TO` | yes | 0x address |
| `FACILITATOR` | no | `local` \| `public` \| `cdp`. Default: `local` on `local`, `cdp` on `base-sepolia` |
| `FACILITATOR_URL` | no | Only for `local` and `public`. Rejected together with `cdp` |
| `CDP_API_KEY_ID` | when `cdp` | Template value is empty, with `# set me (FACILITATOR=cdp only)` |
| `CDP_API_KEY_SECRET` | when `cdp` | Template value is empty, with `# set me (FACILITATOR=cdp only)`. Accepted forms: base64 Ed25519 (recommended), PKCS#8 PEM (`BEGIN PRIVATE KEY`) or SEC1 PEM (`BEGIN EC PRIVATE KEY`). SEC1 is converted to PKCS#8 at startup, because `generateJwt` accepts only PKCS#8 EC keys. A PEM key must be quoted, with real newlines or literal `\n` |
| `SELLER_PORT` | no | unchanged |

Must NOT contain: any private key for an on-chain account, or any bearer token. Unchanged from 007.

Every other template MUST NOT contain `FACILITATOR`, `CDP_API_KEY_ID` or `CDP_API_KEY_SECRET`
(T-ARCH-ENV, extended).

## Startup validation (seller `main()`; exit 1 on any failure, before `listen`)

The checks run in order:

| # | Check | Error message (exact prefix) |
|---|---|---|
| 1 | `facilitatorChoice(net, env)` resolves (research R3 table) | `seller: invalid facilitator config: <reason>` |
| 2 | `kind=cdp` → `CDP_API_KEY_ID` is non-empty | `seller: missing CDP_API_KEY_ID (required for FACILITATOR=cdp)` |
| 3 | `kind=cdp` → `CDP_API_KEY_SECRET` is non-empty | `seller: missing CDP_API_KEY_SECRET (required for FACILITATOR=cdp)` |
| 4 | `kind=cdp` → the secret signs one JWT locally | `seller: CDP_API_KEY_SECRET is not a valid Ed25519 (base64) or EC (PEM) key` |
| 5 | `SELLER_PAY_TO` is a 0x address | unchanged |

`<reason>` values:

| Condition | `<reason>` |
|---|---|
| CDP or public selected on `local` | `FACILITATOR=<kind> is not valid on NETWORK=local` |
| CDP with a URL override | `FACILITATOR=cdp cannot be combined with FACILITATOR_URL` |
| local selected on `base-sepolia` | `FACILITATOR=local is only valid on NETWORK=local` |
| unknown value | `unknown FACILITATOR "<v>" (expected local, public or cdp)` |

No message contains the secret, or any substring of it longer than 4 characters (T-CDP-02, T-CDP-07).

## Startup log (one line, stdout)

```text
seller listening on 0.0.0.0:<port> (<caip2>, facilitator=<kind> host=<url host>[ key=…<last4 of key id>])
```

When a CDP variable is set and `kind ≠ cdp`, the seller also logs one warning line to stderr:

```text
seller: CDP credentials set but unused (FACILITATOR=<kind>)
```

## Local baseline

With `NETWORK=local` and no `FACILITATOR`, the choice is `local`, the URL and timeout are
unchanged, and the startup log is the only visible difference
(`facilitator=local host=127.0.0.1:4022` instead of `facilitator http://127.0.0.1:4022`).
`demo-local.ts` does not parse that line, so the demo summary is unchanged (NFR-003).
