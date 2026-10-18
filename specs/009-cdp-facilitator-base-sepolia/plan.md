# Implementation Plan: CDP Facilitator on Base Sepolia

**Branch**: `009-cdp-facilitator-base-sepolia` (work happens on `devsoftx/sepolia-api-key-config`) | **Date**: 2026-10-17 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/009-cdp-facilitator-base-sepolia/spec.md`

## Summary

On `base-sepolia`, the seller verifies and settles x402 v2 `exact` payments through Coinbase
Developer Platform's hosted facilitator (`https://api.cdp.coinbase.com/platform/v2/x402`). It
authenticates every call with a per-request CDP JWT signed by the operator's CDP API key.

The technical approach (research R1–R4):

- **Client**: keep the pinned `HTTPFacilitatorClient` (`@x402/core` 2.28.0). Give it `createAuthHeaders` built on `generateJwt` from `@coinbase/cdp-sdk/auth` (1.59.0, exact pin, auth subpath only) and a 30 s `timeoutMs`.
- **Selection**: a pure `facilitatorChoice(net, env)` selects `local | public | cdp`. CDP is the default on `base-sepolia`, and every invalid combination fails at startup.
- **Credential confinement**: one new file, `src/counterparty/cdp-facilitator.ts`, is the only place that reads the CDP credential. A new architecture rule A8 enforces this.
- **Failure categories**: a `CategorizedFacilitatorClient` decorator maps transport, auth, throttle and capability failures to four categories. They surface as 503 before a challenge and 502 during a paid retry. The SDK's x402 rejections pass through unchanged.
- **L3 amendment (FR-020)**: L3 checks on-chain any `PAYMENT-RESPONSE` that reports failure but carries a transaction hash. This covers CDP's `settlement_pending` results.
- **Tests and live run**: an offline CDP stub (it verifies JWTs, then delegates to the local facilitator on ganache) drives T-CDP-01..09. An opt-in `npm run demo:base-sepolia` is the live acceptance run.

L1 and L2 code, `contracts.ts` and the ledger schema are unchanged. The local demo summary is
unchanged.

## Technical Context

**Language/Version**: TypeScript ^7.0 (`strict`, NodeNext) on Node.js 22.x ESM. Development also runs on Node 26.

**Primary Dependencies**:
- Unchanged: `@x402/core`, `@x402/evm`, `@x402/express` 2.28.0; viem ^2.57; express ^5.3; dotenv ^18.
- **New**: `@coinbase/cdp-sdk` **1.59.0** (exact). The seller only, through `@coinbase/cdp-sdk/auth` → `generateJwt`. Its optional `@x402/*` peers are already satisfied by 2.28.0, and `@x402/svm` is not needed because `./auth` does not import it.

**Storage**: No new storage. Base Sepolia runs use the existing per-network ledger `.local/ledger-base-sepolia.jsonl`.

**Testing**: vitest ^5.0. New suites, split by story so phases can proceed in parallel, run against `test/helpers/cdp-stub.ts`: `test/cdp-config.test.ts` (T-CDP-01), `test/cdp-auth.test.ts` (T-CDP-03), `test/cdp-isolation.test.ts` (T-CDP-02/07/08) and `test/cdp-failures.test.ts` (T-CDP-04/05/06/09). That stub verifies Ed25519 JWTs with `node:crypto` and delegates to `createFacilitatorApp` on ganache. Existing suites are extended: `architecture.test.ts` (A8, T-ARCH-ENV), `verifier.test.ts` (FR-020 rows) and `counterparty.test.ts` (the new 503 body). The live run T-E2E-06 is manual and opt-in.

**Target Platform**: Node.js server processes on macOS/Linux, plus the public Base Sepolia RPC and the CDP API. CI and `npm run check` stay offline.

**Project Type**: Existing multi-process services (seller, L2, L3, agent). This is a counterparty change, plus one L3 rule amendment.

**Performance Goals**: Not throughput-bound. Every hosted facilitator call is bounded at 30 s. A `/supported` sync may take up to about 30 s more under 429 back-off, because the SDK retries 3 times.

**Constraints**:
- No network access beyond loopback in `npm test` or `npm run check`.
- Exact pins for x402 2.28.0 and cdp-sdk 1.59.0.
- No change to the 402 challenge or the wire formats (FR-013).
- The CDP secret never leaves `cdp-facilitator.ts`'s closure (FR-011).
- No runtime facilitator switching (FR-005).

**Scale/Scope**:

| Kind | Files |
|---|---|
| New source | `src/counterparty/cdp-facilitator.ts`, `src/counterparty/facilitator-client.ts`, `scripts/demo-base-sepolia.ts`, `scripts/demo-lib.ts` (extracted from `demo-local.ts`) |
| Modified source | `src/shared/config.ts`, `src/counterparty/seller.ts`, `src/layer3-settlement/verifier.ts`, `scripts/demo-local.ts` (it imports `demo-lib`; output byte-identical), `package.json` |
| Tests | 4 new suites, 1 new helper, 1 new arch fixture, 4 suites extended (`architecture`, `verifier`, `counterparty`, harness) |
| Docs | SPEC.md v1.2, constitution 1.1.0, CLAUDE.md, README.md, `env/seller.env.example`, `specs/README.md` |

All `NEEDS CLARIFICATION` items are resolved in [research.md](research.md) (R1–R11).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate for this feature | Pre-design | Post-design |
|---|---|---|---|
| I. Separation of authority | L1 and L2 code are unchanged. L3 stays read-only: FR-020 only lets an existing read path (receipt + Transfer) run for failure claims, and A4 still applies. No new process gets the payer key. INV-2 / A3 are unchanged: the CDP JWT signer is not an on-chain account. CLAUDE.md's informal hard rule 2 ("only `signer.ts` touches key material") is narrowed to *payment* key material, and A8 confines the CDP credential to one file (Complexity Tracking #2). | ✅ (with #2) | ✅ [contracts/architecture-rule-a8.md](contracts/architecture-rule-a8.md) |
| II. Pure policy | `policy.ts`, mandates and R1–R14 are untouched. The facilitator choice is seller-side config, not a buyer decision. | ✅ | ✅ |
| III. Ledger as source of truth | No new entry type and no counter. FR-020 makes the ledger *more* accurate, because a settled transfer reported as failed now reaches CONFIRMED. Indeterminate settle timeouts stay a documented residual risk (spec edge case). | ✅ | ✅ [contracts/l3-verify-amendment.md](contracts/l3-verify-amendment.md) |
| IV. Trust the chain | Strengthened: a facilitator's failure claim is no longer taken as proof either way (INV-10 applied symmetrically). Which account submitted a transaction is not part of the check. | ✅ | ✅ |
| V. Least privilege | The CDP credential is held by the seller process only (§3.3 row; A8; T-ARCH-ENV). Startup fails closed (FR-008). There is no fallback (FR-005). Secrets are redacted (R8). The demo and harness pass only `PATH/HOME/NODE_*/ENV_FILE` (T-CDP-08). | ✅ | ✅ [contracts/seller-config.md](contracts/seller-config.md) |
| VI. Exact money | No new money math. The live script computes balance deltas as `bigint` and prints them with `formatAtomic`. | ✅ | ✅ |
| VII. Protocol fidelity | x402 v2 `exact` with SDK 2.28.0 header helpers. The challenge and `PAYMENT-RESPONSE` formats are unchanged. The CDP SDK is used for auth only, and never to encode or decode x402 headers. | ✅ | ✅ [contracts/cdp-facilitator-api.md](contracts/cdp-facilitator-api.md) |
| VIII. Proven safety | Every FR maps to a test (table below). Must-fail proofs: T-CDP-06 (NOT_SETTLED without FR-020), T-ARCH-A8 (the fixture trips), T-CDP-08 (the public stub counts 0 requests; any fallback would make it non-zero). | ✅ | ✅ |
| Tech & scope constraints | Adding `@coinbase/cdp-sdk` changes the pinned stack, so the constitution is amended to 1.1.0 (MINOR) and SPEC §5 is updated in the same change (Complexity Tracking #1). Networks stay `local` and `base-sepolia`, and mainnet stays out of scope. | ✅ (with #1) | ✅ |
| Quality gates | `npm run check` stays offline and the demo summary is unchanged. SPEC v1.2 is updated in the same change. Test IDs are in test titles (T-ARCH-TRACE). | ✅ | ✅ |

**Result: PASS**, with three justified items (Complexity Tracking). The governance amendments
are listed in research R11. They land in the same change, gated by the first task, following
the 008 T000 precedent.

### Requirement → test map

| Requirement | Test(s) |
|---|---|
| FR-001..FR-004, SC-007 | T-CDP-01 (`facilitatorChoice` matrix) |
| FR-005, FR-010, SC-005 | T-CDP-08 (no fallback; demo/harness child envs) |
| FR-006 | T-CDP-02 (startup log line format, key suffix only) |
| FR-007, FR-013, FR-014, US1 offline | T-CDP-03 (stub-verified JWTs; scripted plan through the CDP stub; T-E2E-01 outcomes) |
| FR-008, SC-003 (startup) | T-CDP-02 (missing ID or secret, malformed secret, conflicts → exit 1) |
| FR-009, FR-022 | T-ARCH-A8, T-ARCH-ENV |
| FR-011, SC-004 | T-CDP-07 (secret scan of output, responses, ledger, `.local/`) |
| FR-012 | T-ARCH-A8 + A3 (no account from the CDP key); review |
| FR-015..FR-017, SC-003 (runtime), SC-008 | T-CDP-04 (pre-challenge 503 per category; 0 AUTHORIZED entries) |
| FR-016 (paid retry), FR-018 | T-CDP-05 (502 category; compliance decline → 402 reason; L1 PAYMENT_FAILED; L3 NOT_SETTLED) |
| FR-019, FR-020 | T-CDP-06 (must-fail), verifier.test.ts FR-020 rows |
| SC-009 | T-CDP-09 (outage → recovery without restart) |
| FR-021 | the T-CDP suite runs with no network and no real key |
| FR-023, SC-001, SC-002 | T-E2E-06 (manual, `npm run demo:base-sepolia`, 3 runs) |
| NFR-003, SC-006 | `npm run check` (G1–G3) |

## Project Structure

### Documentation (this feature)

```text
specs/009-cdp-facilitator-base-sepolia/
├── spec.md
├── plan.md                         # this file
├── research.md                     # R1–R11
├── data-model.md                   # FacilitatorChoice, CdpCredential, failure categories, PAYMENT-RESPONSE reinterpretation
├── quickstart.md                   # offline gate, CDP key setup, drills, live run
├── contracts/
│   ├── seller-config.md            # env vars, startup validation, log lines (CP-3, CFG-1/2)
│   ├── cdp-facilitator-api.md      # outbound CDP endpoints, JWT, status mapping, offline stub
│   ├── seller-errors.md            # 503/502/402 bodies per category; buyer-side outcomes
│   ├── l3-verify-amendment.md      # L3-1 step 2 v1.2 + decision table
│   └── architecture-rule-a8.md     # A8, T-ARCH-ENV delta, §3.3 row, SEC-10/11
├── checklists/requirements.md
└── tasks.md                        # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
src/
├── shared/config.ts                  # + FacilitatorKind, facilitatorChoice(net, env), CDP_FACILITATOR_URL,
│                                     #   HOSTED_FACILITATOR_TIMEOUT_MS (pure; never reads CDP vars)
├── counterparty/
│   ├── cdp-facilitator.ts            # NEW. Only reader of CDP_API_KEY_ID/SECRET (A8). cdpFacilitatorClient({apiKeyId,
│   │                                 #   apiKeySecret, baseUrl?, timeoutMs}), cdpCredentialsFromEnv(env), normalizeCdpSecret()
│   │                                 #   (SEC1→PKCS#8), cdpCredentialStatus(values), containsCdpSecret(values, text),
│   │                                 #   validateCdpSecret(), makeRedactor(), CDP auth hint text
│   ├── facilitator-client.ts         # NEW. CategorizedFacilitatorClient, FacilitatorUnavailableError{category},
│   │                                 #   categorize(err), facilitatorClientFor(choice, cdpCreds?)
│   └── seller.ts                     # createSellerApp({net, payTo, facilitator?}); 503 {error, category}; main(): choice +
│                                     #   validation order + log line (contracts/seller-config.md)
└── layer3-settlement/verifier.ts     # L3-1 step 2 amendment (FR-020); test-only option verifyFailedClaims
scripts/
├── demo-lib.ts                       # NEW. Spawn/shutdown/readiness/env helpers extracted from demo-local.ts (no behavior change)
├── demo-local.ts                     # imports demo-lib; summary byte-identical
└── demo-base-sepolia.ts              # NEW. T-E2E-06 live acceptance run (opt-in)
test/
├── cdp-config.test.ts                # NEW. T-CDP-01 (+ US4 public-path checks)
├── cdp-auth.test.ts                  # NEW. JWT units, T-CDP-03
├── cdp-isolation.test.ts             # NEW. T-CDP-02, T-CDP-07, T-CDP-08
├── cdp-failures.test.ts              # NEW. categorize(), T-CDP-04, 05, 06, 09
├── helpers/cdp-stub.ts               # NEW. JWT-verifying CDP stub delegating to createFacilitatorApp; failure modes; counters
├── fixtures/arch/a8-violation.ts# NEW. Must trip A8
├── architecture.test.ts              # + A8, T-ARCH-ENV delta
├── verifier.test.ts                  # + FR-020 rows
└── counterparty.test.ts              # 503 body update
env/seller.env.example                # + FACILITATOR?, CDP_API_KEY_ID=, CDP_API_KEY_SECRET= (empty, # set me)
package.json                          # + "@coinbase/cdp-sdk": "1.59.0"; + "demo:base-sepolia" script
```

**Structure Decision**: Keep the single-project layout from SPEC §6. The CDP code goes in
`src/counterparty/`, because the seller is the only process that talks to a facilitator. It
is split so that the secret-bearing file (`cdp-facilitator.ts`) stays minimal, and the error
categorization (`facilitator-client.ts`) is credential-free and reusable for the `public`
choice.

Ownership, so `/speckit-tasks` can coordinate:

| Feature | Files or rules |
|---|---|
| 006 | `seller.ts`, `config.ts` network section, CP-3, CFG-1 |
| 005 | `verifier.ts`, L3-1 |
| 007 | `architecture.test.ts`, `env/*.env.example`, §3.3, §11 |
| 008 | `demo-local.ts`, npm scripts, §13 |

This feature amends each of these, and the matching spec READMEs and traceability rows are
updated together.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| **#1** A new runtime dependency outside the constitution's pinned stack (`@coinbase/cdp-sdk` 1.59.0). It is large (about 8 MB unpacked, with Solana and axios transitive deps). | CDP's JWT format (key parsing for Ed25519/EC, `uris` binding, header nonce, 120 s expiry) is owned by Coinbase. Using its canonical `generateJwt` avoids silent auth drift. | A hand-rolled JWT (`node:crypto`) would make us own a third-party auth format, and drift would show up only as live 401s. `createCdpFacilitatorClient` loads a barrel that needs the uninstalled optional peer `@x402/svm`, and offers no timeout (research R1). The dependency is confined to one file by A8 and to the `./auth` subpath. |
| **#2** Secret-bearing signing (the CDP JWT) in `src/` outside `layer2-control/signer.ts`, against CLAUDE.md hard rule 2's literal wording. | The seller is the only legitimate holder of its facilitator credential (SPEC §3.3). The JWT authenticates the seller to CDP and cannot authorize any on-chain transfer, so INV-2 (accounts) and A3 hold unchanged. | Moving it to `scripts/`, as 006 did for the facilitator key, was rejected. CLAUDE.md also limits `scripts/` to local dev keys, it would need a new seller entry point, and A8 already gives a narrower, test-enforced boundary of one file. CLAUDE.md rule 2 is reworded to "payment key material" in the same change (R11). |
| **#3** An L3 behavior change (FR-020) inside a counterparty feature. | A hosted facilitator introduces `settlement_pending` failure claims that carry real transactions. Without the change, the budget under-counts settled spend (Principles III and IV). | Leaving L3 alone and treating pending as the seller's problem was rejected, because it violates INV-10 ("the seller's response is a claim, not proof"). The change is one step, read-only, with no contract change, and comes with a must-fail test (T-CDP-06). |
