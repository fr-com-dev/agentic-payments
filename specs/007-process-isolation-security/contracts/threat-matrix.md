# Contract: Threat → control → test matrix (§11)

| ID | Threat | Controls | Owner | Tests |
|---|---|---|---|---|
| SEC-1 | Prompt injection makes the agent overspend | Exactly 2 tools (no signing tool); rules R1–R14; session and daily budgets | 001, 002 | T-AGT-01, T-POL-*, T-E2E-01 |
| SEC-2 | Agent compromise leaks the key | Key only in L2 (env templates); `main.ts` exit 1; rules A3, A5 | 007 | T-ARCH (A3, A5), T-ARCH-ENV, T-AGT-KEY |
| SEC-3 | Malicious seller swaps the payee or redirects | R5 payee allowlist, R6 host allowlist, R7 resource binding | 002 | T-POL-05, T-POL-11 |
| SEC-4 | Seller claims payment without settling, or replays a tx | L3 requires a receipt plus a matching Transfer(payer, payTo, amount, asset); read-only L3 (A4) | 005 | T-E2E-03, T-ARCH (A4) |
| SEC-5 | Forged or contradictory settlement reports | Cross-check of the `verified` fields; CONFIRMED is sticky; `verifier-control` role token | 003, 007 | T-E2E-03, T-E2E-05, T-AUTH-01, T-AUTH-02 |
| SEC-6 | A concurrent burst bypasses limits | Serialized check, sign and append (INV-8) | 002 | T-E2E-04 (fails without the mutex) |
| SEC-7 | Audit tampering | Hash chain; startup integrity check | 003 | T-LED-01 |
| SEC-8 | Agent self-approves an escalation | `operator` role token; single-use exact-tuple approval | 004, 007 | T-E2E-02, T-POL-13 |
| SEC-9 | A stale signature settles late | Committed spend counts until `validBefore` | 003 | T-LED-02 |

## Accepted residual risks (v1)

| Risk | Why accepted | Retired by |
|---|---|---|
| Bearer tokens over loopback instead of mTLS | Single host; L2 and L3 are loopback-only | EXT-7 |
| Payer key held in an environment variable | PoC; isolated to the L2 process | EXT-2 (remote signer or KMS) |
| Single-node JSONL ledger | Hash chain detects tampering; no HA needed | EXT-6 |
| Facilitator trusted for liveness | L3 still verifies settlement on-chain | none planned |
| No refund path | Micro-amounts; testnet only | EXT-9 |
