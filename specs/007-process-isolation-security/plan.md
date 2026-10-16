# Implementation Plan: Process Isolation & Security Model

**Branch**: `007-process-isolation-security` | **Date**: 2026-10-16 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/007-process-isolation-security/spec.md`

## Summary

This feature makes the separation of payment authority enforceable and auditable. It
delivers six things:

1. **A static architecture test** (`test/architecture.test.ts`). It scans `src/**` and fails
   on:
   - a cross-layer import (INV-1);
   - key-to-account conversion outside `signer.ts` (INV-2);
   - a `PAYER_PRIVATE_KEY` reference in L1 (INV-3);
   - any signing or write capability in L3 (INV-4).
2. **A shared bearer-auth guard**, configured per role. One token maps to one role, and the
   token is compared in constant time (INV-13). L2 and L3 mount it per route.
3. **The agent-startup key refusal** in `src/main.ts` (exit 1).
4. **The process and port topology**, with L2 and L3 bound to loopback.
5. **One env template per process**, checked against the credential matrix.
6. **A consolidated SEC-1..SEC-9 traceability matrix**, plus the accepted residual risks.

Behavior of the endpoints themselves is owned by features 002–005. This feature fixes only
who may call them.

## Technical Context

**Language/Version**: TypeScript ^7.0 (`strict`, NodeNext) on Node.js 22.x, ESM

**Primary Dependencies**:
- `node:fs`/`node:path` for the source scan, and `node:crypto` (`timingSafeEqual`, `createHash`) for token comparison.
- express ^5.3 for the auth middleware and the bind address.
- dotenv ^18 to load `ENV_FILE`.
- The `typescript` compiler API (already a dev dependency) for TS-aware import extraction.
- No new runtime dependencies.

**Storage**: None

**Testing**: vitest ^5.0 (`fileParallelism: false`, 120 s timeouts).
- `test/architecture.test.ts` runs static checks with no network or chain (NFR-004).
- `test/e2e.local.test.ts` covers wrong-role 401s (T-E2E-05; T-E2E-02 is owned by 004).
- A manual exit-1 check covers the key refusal (§12).

**Target Platform**: Node.js 22 processes on macOS/Linux on a single host. L2 and L3 bind to `127.0.0.1`.

**Project Type**: Cross-cutting security controls inside a multi-process system (tests, middleware, configuration)

**Performance Goals**:
- The architecture test finishes in under 5 s on the PoC tree, which is about 20 source files.
- The auth check adds only negligible overhead to each request.

**Constraints**:
- Zero cross-layer imports in layer code.
- Exactly one module (`src/layer2-control/signer.ts`) calls `privateKeyToAccount` or `mnemonicToAccount`.
- `main.ts` refuses on the *presence* of the key, not on its validity.
- 401 responses have no side effects: auth runs before any handler logic or ledger append.

**Scale/Scope**:
- 6 processes.
- 7 secrets (3 private keys or API keys and 4 bearer tokens).
- 4 caller roles.
- 9 threats.
- 6 env templates.

No `NEEDS CLARIFICATION` items: SPEC.md §3, §4, §9 and §11 pin every choice.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate for this feature | Pre-design | Post-design |
|---|---|---|---|
| I. Separation of authority | INV-1..INV-4 are enforced by an automated test on every run, with no INV-2 exemption: the facilitator derives its account in `scripts/facilitator.ts`, outside `src/`. `main.ts` refuses to start with the key. | ✅ | ✅ The rules are enumerated in [contracts/architecture-rules.md](contracts/architecture-rules.md) |
| II. Pure policy | `policy.ts` must make no I/O imports. The architecture test adds a purity rule: no `node:fs`, `node:http`, `Date.now`, `fetch`, `console.` or access to `purpose` in `policy.ts` (A6, single owner 007, merging 002 T020). | ✅ | ✅ Rule A6 |
| III. Ledger as source of truth | A rejected (401) request writes nothing to the ledger, because auth runs before handlers. | ✅ | ✅ [contracts/auth-roles.md](contracts/auth-roles.md) |
| IV. Trust the chain | L3 is read-only (INV-4), so it cannot fabricate a settlement. | ✅ | ✅ Rule A4 |
| V. Least privilege | Per-process env files match the §3.3 matrix. One token per role. L2 and L3 bind to loopback. | ✅ | ✅ [contracts/env-templates.md](contracts/env-templates.md), [contracts/process-topology.md](contracts/process-topology.md) |
| VI. Exact money | Not affected. | ✅ n/a | ✅ n/a |
| VII. Protocol fidelity | The architecture test flags hand-rolled x402 header codecs (`Buffer.from(..., "base64")` next to `PAYMENT-` names) in layer code. | ✅ | ✅ Rule A7 |
| VIII. Proven safety | Each architecture rule has a negative fixture showing it fails on a violation. T-E2E-05 shows wrong-role 401. The manual exit-1 check covers the key refusal. | ✅ | ✅ [quickstart.md](quickstart.md) §2 |

Result: **PASS**. No violations, so Complexity Tracking stays empty.

## Project Structure

### Documentation (this feature)

```text
specs/007-process-isolation-security/
├── plan.md
├── research.md
├── data-model.md                 # Process, Credential, Role, Invariant, Threat, Risk
├── quickstart.md
├── contracts/
│   ├── architecture-rules.md     # Static rules A1–A7, scan scope, failure output
│   ├── auth-roles.md             # Role → token → endpoints; guard behavior
│   ├── env-templates.md          # One template per process (CFG-2) + ENV_FILE loading
│   ├── process-topology.md       # Ports, bind addresses, overrides
│   └── threat-matrix.md          # SEC-1..9 → control → owner → test; residual risks
└── tasks.md                      # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
src/
├── shared/
│   ├── config.ts            # loadEnv(ENV_FILE), ports, bind hosts, role tokens, dev defaults
│   └── auth.ts              # requireRole(role) bearer guard (express middleware factory)
├── layer2-control/service.ts       # mounts requireRole per route (owned by 002/003/004)
├── layer3-settlement/service.ts    # mounts requireRole("agent-verifier") (owned by 005)
└── main.ts                  # PAYER_PRIVATE_KEY refusal, exit 1 (shared with 001)

env/
├── l1-agent.env.example
├── l2-control.env.example
├── l3-verifier.env.example
├── seller.env.example
├── facilitator.env.example
└── operator.env.example

test/
├── architecture.test.ts     # T-ARCH-* (rules A1–A7)
├── fixtures/arch/           # negative fixtures: one violating file per rule
└── e2e.local.test.ts        # T-AUTH-01 (007); T-E2E-05 owned by 003 T032, T-AUTH-02 by 005 T031 (harness: 008)
```

**Structure Decision**: Use the single-project layout from SPEC.md §6. This feature owns
these files:
- `test/architecture.test.ts` and its fixtures
- `src/shared/auth.ts`
- the env and port parts of `src/shared/config.ts`
- `env/*.env.example`
- the refusal block in `src/main.ts`

The services in 002–005 consume the guard but do not reimplement it. `auth.ts` sits in
`shared/` because both L2 and L3 need it, and INV-1 forbids sharing it any other way.

## Complexity Tracking

No constitution violations to justify.
