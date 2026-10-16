# Specs index: x402 three-layer agent payments

These spec-kit feature specs decompose `SPEC.md` v1.0, which remains normative.
Project principles live in `.specify/memory/constitution.md` (v1.0.0). It covers INV-1..13,
the definition of done and the governance rules.

| # | Feature | Layer | Functional scope | Main non-functional scope |
|---|---|---|---|---|
| 001 | [agent-paid-fetch](001-agent-paid-fetch/spec.md) | L1 | L1-1..L1-5, §10 (L1 side), T-AGT-01 | INV-1/3, SEC-1/2, no key in agent |
| 002 | [spending-policy-authorization](002-spending-policy-authorization/spec.md) | L2 | L2-1, L2-2 R1–R14 + decide, L2-3, L2-5 authorize/budget, CFG-3, T-POL-*, T-E2E-04 | INV-5/6/8, SEC-3/6, serialized decisions |
| 003 | [audit-ledger-reconciliation](003-audit-ledger-reconciliation/spec.md) | L2 | L2-4, L2-4.1, L2-5 reconcile and ledger/verify, T-LED-*, T-E2E-03/05 | INV-7/9/11, SEC-5/7/9 |
| 004 | [human-approval-escalation](004-human-approval-escalation/spec.md) | L2 + operator | R14, L2-4.2, L2-5 approvals, approve CLI, T-POL-13, T-E2E-02 | INV-12/13, SEC-8 |
| 005 | [settlement-verification](005-settlement-verification/spec.md) | L3 | L3-1 (finality classes), L3-2 (reconcile push, PENDING re-checks) | INV-4/10, SEC-4, timeouts |
| 006 | [counterparty-seller-network](006-counterparty-seller-network/spec.md) | Counterparty | CP-1..CP-5, CFG-1, §10 wire formats | EIP-712 domain correctness |
| 007 | [process-isolation-security](007-process-isolation-security/spec.md) | Cross-cutting | §3.1, §3.3, CFG-2, T-ARCH-* | INV-1..4/13, SEC-1..9 consolidated, residual risks |
| 008 | [local-demo-regression](008-local-demo-regression/spec.md) | Cross-cutting | L1-4 baseline, T-E2E-01, demo, §13, §14 M0–M7 | Definition of done, clean shutdown, §16 gotchas |

## Traceability (SPEC.md ID → feature)

| SPEC ID | Feature(s) |
|---|---|
| INV-1, INV-2, INV-3 | 007 (owner), 001 |
| INV-4 | 007, 005 |
| INV-5, INV-6, INV-8 | 002 |
| INV-7, INV-9, INV-11 | 003 |
| INV-10 | 005 |
| INV-12 | 004, 002 |
| INV-13 | 007 (owner), 003, 004, 005 |
| L1-1..L1-3, L1-5 | 001 |
| L1-4 | 001, 008 |
| L2-1, L2-2, L2-3 | 002 (R14 also in 004) |
| L2-4, L2-4.1 | 003 |
| L2-4.2 | 004 |
| L2-5 | 002 (authorize, budget), 003 (reconcile, ledger/verify), 004 (approvals) |
| L3-1, L3-2 | 005 |
| CP-1..CP-5 | 006 (CP-3/CP-5 also in 008) |
| CFG-1 | 006 |
| CFG-2 | 007 |
| CFG-3 | 002 |
| SEC-1..SEC-9 | 007 (consolidated), with detail in 001 (1, 2), 002 (3, 6), 003 (5, 7, 9), 004 (8), 005 (4) |
| T-POL-01..14 | 002 (T-POL-13 also in 004) |
| T-LED-01..03 | 003 |
| T-ARCH-* | 007 |
| T-AGT-01 | 001 |
| T-E2E-01 | 008 (owner), 001, 002, 003, 005, 006 |
| T-E2E-02 | 004 |
| T-E2E-03 | 003 (L2 side), 005 (L3 side) |
| T-E2E-04 | 002, 008 |
| T-E2E-05 | 003, 007 |
| §0, §13, §14, §16 | 008 (§16 EIP-712 name also in 006) |
| §5 stack, §10 wire formats | constitution, 006, 007 |
| EXT-1..EXT-9 | Not specified. Future features, one spec per extension (`/speckit-specify`) |

Each spec tags every FR/NFR with its SPEC source, e.g. `*(SPEC: L2-2 R6, SEC-3)*`.
Each `checklists/requirements.md` records the quality validation.
