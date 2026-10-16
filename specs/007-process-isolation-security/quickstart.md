# Quickstart: validate Process Isolation & Security

## Prerequisites

- Node.js 22. Run `npm install`.
- For step 3 only: features 002–005 are implemented, so the services exist.
- Steps 1, 2 and 4 need no network or chain.

## 1. Static isolation checks (T-ARCH-*, T-ARCH-ENV)

```bash
npx vitest run test/architecture.test.ts
```

Expected:
- 0 violations across rules A1–A7 ([contracts/architecture-rules.md](contracts/architecture-rules.md)).
- 6 of 6 env templates match [contracts/env-templates.md](contracts/env-templates.md).

## 2. Prove the checks can fail

The same suite runs every negative fixture in `test/fixtures/arch/`. Each must produce
exactly its own rule ID (A1–A7).

Manual spot check:
1. Add `import "../layer2-control/ledger.js";` to `src/layer1-intent/orchestrator.ts`.
2. Run step 1. Expect `A1 src/layer1-intent/orchestrator.ts:<line> ../layer2-control/ledger.js`.
3. Revert the change.


**Recorded result (T028, 2026-10-16):** a scratch file `src/layer1-intent/__scratch.ts` importing
`../layer2-control/policy.js` made `npx vitest run test/architecture.test.ts` fail with
`A1 src/layer1-intent/__scratch.ts:1 ../layer2-control/policy.js` (1 failed, 18 passed). After
removing it, 19/19 passed.

## 3. Wrong-role tokens are rejected (T-E2E-05, T-AUTH-01/02)

```bash
npx vitest run test/e2e.local.test.ts -t "T-E2E-05"
npx vitest run test/e2e.local.test.ts -t "T-AUTH"
```

Expected: every call in the negative-test table of [contracts/auth-roles.md](contracts/auth-roles.md)
returns 401, and the ledger entry count is unchanged.

## 4. Agent refuses the payer key (INV-3, §12 manual)

```bash
PAYER_PRIVATE_KEY=0x1 ENV_FILE=/dev/null npx tsx src/main.ts --scripted; echo "exit=$?"
PAYER_PRIVATE_KEY= ENV_FILE=/dev/null npx tsx src/main.ts; echo "exit=$?"
```

Expected: both print the refusal message and `exit=1`. No request reaches ports 4020, 4021
or 4023.

Result (2026-10-16, T016): `--scripted` → refusal, `exit=1`; LLM mode (`"buy weather"`) → refusal,
`exit=1`; empty `PAYER_PRIVATE_KEY=` → refusal, `exit=1` (presence, not validity). T-AGT-KEY automates
the check and counts 0 connections to the service ports.

## 5. Loopback binding (NFR-001, SC-006)

With `npm run demo:local` running:

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(4020|4021|4023)'
```

Expected: 4020 and 4023 listen on `127.0.0.1` only, and 4021 listens on `*` / `0.0.0.0`.
The same holds after the demo is restarted with `CONTROL_PORT=5020`.

Result (2026-10-16): during a demo run, `127.0.0.1:4020`, `127.0.0.1:4023` and `*:4021`; no listener
on 8545 or 4020–4023 after exit. T-ARCH-BIND (`test/e2e.local.test.ts`) checks the override case:
`listenControl`/`listenSettlement` stay on 127.0.0.1 with `CONTROL_PORT`/`SETTLEMENT_PORT` overridden.

## 6. Threat traceability (SC-004)

Walk [contracts/threat-matrix.md](contracts/threat-matrix.md). Every SEC row must name a
test that passes in `npm test`: 9 of 9.

Result (2026-10-16): T-ARCH-TRACE (`test/architecture.test.ts`) checks this automatically: 9 of 9
rows resolve to test titles, and its must-fail case reports a row that names a missing test.
`npm run check`: typecheck clean, 231/231 tests, demo `spent on-chain: 0.006 USDC` and
`hash chain ok=true`, exit 0.
