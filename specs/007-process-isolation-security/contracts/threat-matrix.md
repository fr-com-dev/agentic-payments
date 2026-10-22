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
| SEC-8 | Agent self-approves (or rejects) an escalation | `operator` role token; single-use exact-tuple approval; one final state per escalation (010) | 004, 007, 010 | T-E2E-02, T-POL-13, T-E2E-07 |
| SEC-9 | A stale signature settles late | Committed spend counts until `validBefore` | 003 | T-LED-02 |
| SEC-10 | The CDP API credential leaks to another process, a log or a response, or a misconfiguration silently uses an unauthenticated facilitator | Seller-only credential (rule A8, T-ARCH-ENV); fail-closed startup; no runtime fallback; redaction (amended by 009, SPEC v1.2) | 009, 007 | T-ARCH-A8, T-CDP-02, T-CDP-07, T-CDP-08 |
| SEC-11 | A facilitator reports failure for a transfer that actually settled, so the budget under-counts | L3 checks any reported hash on-chain (L3-1 step 2, amended by 009, SPEC v1.2) | 009, 005 | T-CDP-06 |
| SEC-12 | Operator free text (label, reason) reaches the LLM agent and acts as a prompt injection | The R15 `human_rejected` detail carries only the rejection ID; label and reason are stored as data and shown to the operator only (010, SPEC v1.3) | 010, 002 | T-POL-15 |
| SEC-13 | The token-free API docs routes on L2 expose more than the document, or run third-party code on the signer's origin where operators type tokens | Off unless `API_DOCS=1`; three fixed files and the document, no ledger, mandate or signer access; Swagger UI from the pinned package, never a CDN; CSP limits scripts and requests to the L2 origin (SPEC v1.4) | v1.4 | T-API-04 |

## Accepted residual risks (v1)

| Risk | Why accepted | Retired by |
|---|---|---|
| Bearer tokens over loopback instead of mTLS | Single host; L2 and L3 are loopback-only | EXT-7 |
| Payer key held in an environment variable | PoC; isolated to the L2 process | EXT-2 (remote signer or KMS) |
| Single-node JSONL ledger | Hash chain detects tampering; no HA needed | EXT-6 |
| Facilitator trusted for liveness | L3 still verifies settlement on-chain | none planned |
| CDP facilitator sees payment metadata (payer, payee, amount, resource) and applies its own compliance screening (009) | Testnet PoC; CDP is the payment counterparty's chosen provider | none planned |
| A settle that times out with no transaction hash is indeterminate (009) | Amount stays committed until `validBefore` (SEC-9); applies to every facilitator | follow-up: EIP-3009 nonce check |
| Operator label is self-declared; one shared operator token for every operator (010) | Single-operator PoC; the token is still role-scoped (INV-13) | EXT-7 |
| A rejection blocks a (session, resource) for good, with no undo (010) | By design: final states are never reversed; a new session can buy again | none planned |
| No refund path | Micro-amounts; testnet only | EXT-9 |
