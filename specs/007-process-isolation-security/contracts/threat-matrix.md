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
| SEC-14 | Anyone who can reach the public hosted agent endpoint spends from the budget | Entra ID token with `Agent.Run` checked before any model or L2 call; per-requester limits; L2's rules and budgets unchanged (SPEC v1.5 L1-6) | 011 | T-AGT-03 |
| SEC-15 | A requester continues another requester's session and uses its approvals or budget | HMAC-bound session references; raw session IDs refused; a foreign reference → 404 (SPEC v1.5 L1-6) | 011 | T-AGT-04 |
| SEC-16 | Secrets, requester tokens or payment headers reach logs or telemetry | Whitelisted JSON run log; Mastra logger silenced and no telemetry export; known-value tests offline and a shape scan of cloud logs (SPEC v1.5) | 011 | T-AGT-05, T-E2E-AZ |
| SEC-17 | A forged, replayed or swapped backchannel approval pays something nobody approved | L2 verifies the approver's token before recording it (JWKS signature, issuer, audience, client, validity, approver, the open request, payment details field for field, single use); outcomes recorded inside the serialized section; the Auth0 credential confined to `ciba-client.ts` (A9) (SPEC v1.8 L2-7) | 012 | T-CIBA-08, T-CIBA-10, T-ARCH-A9 |
| SEC-18 | Push fatigue: a prompt-injected agent escalates again and again until the approver taps "approve" | Repeats reuse the pending escalation; at most 10 approval requests per rolling hour from the ledger; the scripted regression is operator-only and the hosted smoke run fails on any escalation (SPEC v1.8 L2-7) | 012 | T-CIBA-03, T-CIBA-04, T-E2E-10 |

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
| The approval service (Auth0) is trusted to authenticate the approver; the approver's phone is a new place where approvals happen (012) | The approval must still verify against the exact payment, and fails closed; the operator path remains | none planned |
| Payment details checked against the unsigned token response when Auth0's CIBA token lacks them (012) | Same authenticated connection, answer to L2's own poll; recorded as `detailsSource: "response"` | Auth0 putting `authorization_details` in the token |
| No refund path | Micro-amounts; testnet only | EXT-9 |
