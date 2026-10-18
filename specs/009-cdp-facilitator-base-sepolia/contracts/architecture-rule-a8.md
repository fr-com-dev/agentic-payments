# Contract: Architecture rule A8 and the T-ARCH-ENV extension (Principle V; proposed SEC-10)

Owner of `test/architecture.test.ts` and the §4.1 rule table: feature 007. This feature adds
one rule and extends one check.

## A8: CDP credential confinement

| Rule | Invariant | Scope | Violation |
|---|---|---|---|
| A8 | Principle V, SEC-10 | `src/**`, `scripts/**`, `env/*.env.example` (`test/**` is out of scope) | the string or identifier `CDP_API_KEY_ID` or `CDP_API_KEY_SECRET`, or an import specifier starting with `@coinbase/cdp-sdk`, in any file other than `src/counterparty/cdp-facilitator.ts` and `env/seller.env.example` |

- Fixture `test/fixtures/arch/a8-violation.ts` contains `process.env.CDP_API_KEY_SECRET` and `import { generateJwt } from "@coinbase/cdp-sdk/auth"`. The rule must trip on it (Principle VIII).
- A3 stays as it is (`privateKeyToAccount`, `mnemonicToAccount`, `viem/accounts`). A CDP JWT signer is not an on-chain account, and A8 confines it to one file.
- A1 is unaffected. `cdp-facilitator.ts` is in `src/counterparty/` and imports only `node:crypto` (SEC1→PKCS#8 conversion), `../shared/*`, `@x402/core/server` and `@coinbase/cdp-sdk/auth`.

## T-ARCH-ENV: template variable sets (delta)

| Template | Adds | Must NOT contain (adds) |
|---|---|---|
| `seller.env.example` | `FACILITATOR?`, `CDP_API_KEY_ID?`, `CDP_API_KEY_SECRET?` (empty) | — |
| every other template | — | `FACILITATOR`, `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` |

The "private keys are empty" check is extended to `CDP_API_KEY_SECRET`.

## SPEC §3.3 credential matrix (new row)

| Secret | L1 | L2 | L3 | Seller | Facilitator | Human operator |
|---|---|---|---|---|---|---|
| `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | — | — | — | ✅ (`FACILITATOR=cdp`) | — | — |

## SPEC §11 (new rows)

| ID | Threat | Control | Test |
|---|---|---|---|
| SEC-10 | The CDP API credential leaks to another process, a log or a response, or is misconfigured into silently using an unauthenticated facilitator | Seller-only (A8, T-ARCH-ENV); fail-closed startup; no runtime fallback; redaction | T-ARCH-A8, T-CDP-02, T-CDP-07, T-CDP-08 |
| SEC-11 | A facilitator reports failure for a transfer that actually settled, so the budget under-counts | L3 checks any reported hash on-chain (FR-020) | T-CDP-06 |

T-ARCH-TRACE requires every test ID named in these rows to appear in a test title.
