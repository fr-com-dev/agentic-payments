# Research: Process Isolation & Security Model

Technical Context had no `NEEDS CLARIFICATION` items. This file records the design decisions.

## R1. Architecture test: TS-aware import extraction plus identifier scan

- **Decision**: Walk `src/**/*.ts` and handle each file as follows:
  - Parse it with the TypeScript compiler API (`ts.createSourceFile`, no type checking).
  - Collect module specifiers from `import`, `export … from`, dynamic `import()` with a
    string literal, and `import type`.
  - Resolve relative specifiers to repository paths and classify each by its top-level
    folder.
  - Scan identifiers and string literals for the forbidden names in
    [contracts/architecture-rules.md](contracts/architecture-rules.md).
- **Rationale**:
  - Regex misses multi-line imports and can be fooled by comments or strings.
  - The compiler API is already installed and needs no type checking, so it is fast and
    needs no network (NFR-004).
  - `import type` is included because a type-only import still couples layers at the source
    level.
- **Alternatives considered**:
  - dependency-cruiser or eslint-plugin-boundaries was rejected: it is a new dependency and
    an extra config surface.
  - A regex-only scan was rejected: it is fragile, though acceptable as a fallback.
  - A runtime module-graph check was rejected because it needs every module loaded.

## R2. Scan scope and exemptions

- **Decision**: The rules apply to these folders:
  - `src/layer1-intent`, `src/layer2-control`, `src/layer3-settlement` and `src/shared`
    are checked.
  - `src/counterparty` is checked as its own "layer" for INV-1: it may import only `shared`.
  - `src/main.ts`, `scripts/**` and `test/**` are exempt from INV-1, as SPEC allows.
  - INV-2 (key → account) applies to every `src/**` file except
    `src/layer2-control/signer.ts`, with no other exemption. `scripts/**` is out of scope.
- **Rationale**:
  - INV-2 stays exactly as SPEC states it. The facilitator still holds its own key
    (`FACILITATOR_PRIVATE_KEY`, §3.3), but the key-to-account step moves out of `src/`:
    `src/counterparty/facilitator.ts` exports a factory that takes a ready viem account, and
    the new entry point `scripts/facilitator.ts` loads `env/facilitator.env`, derives the
    account and starts the server (owned by 006).
  - `scripts/local-chain-lib.ts` derives ganache accounts from a mnemonic; scripts are
    outside `src/`.
- **Alternatives considered**: Exempting `src/counterparty/facilitator.ts` from INV-2 was
  rejected: it would need a constitution and SPEC amendment for a local-only simulator.

## R3. Prove each rule can fail ("must fail without it")

- **Decision**: For every rule A1–A7, keep a tiny violating file in `test/fixtures/arch/`.
  The test runs the same checker on each fixture and asserts the expected violation. The
  checker is a pure function `checkFile(path, source) → Violation[]`.
- **Rationale**: Constitution Principle VIII requires this. A green architecture test proves
  nothing unless it is also shown to go red. `test/fixtures/**` sits outside the `src/**`
  scan, so the real tree stays clean.
- **Alternatives considered**: Mutating `src/` temporarily during the test was rejected: it
  is racy and risks leaving the tree dirty.

## R4. Per-role bearer guard with constant-time comparison

- **Decision**: `requireRole(role)` is an express middleware factory in
  `src/shared/auth.ts`. It works as follows:
  1. Read `Authorization: Bearer <t>`.
  2. Compare `sha256(t)` with `sha256(expected[role])` using `crypto.timingSafeEqual`.
     Hashing first equalizes the lengths.
  3. On failure, return `401 {error:"unauthorized"}` without calling `next()`.

  Each route lists exactly one role.
- **Rationale**:
  - INV-13 says one token, one role. It is enforced structurally by mounting one role per
    route.
  - Constant-time comparison removes a timing oracle at negligible cost.
  - Auth runs before the body handler, so a rejected request writes no ledger entry.
- **Alternatives considered**:
  - Plain `===` was rejected: it leaks timing. SPEC does not require constant time, so this
    is a hardening choice. *Flagged for human review.*
  - A role-list per route (for example, both agent and operator) was rejected because it
    breaks INV-13.
  - mTLS is deferred to EXT-7.

## R5. Token configuration and fail-closed defaults

- **Decision**: `config.ts` reads `CONTROL_TOKEN`, `VERIFIER_TOKEN`, `SETTLEMENT_TOKEN` and
  `OPERATOR_TOKEN`. If one is unset, it falls back to the documented `dev-*-token` only when
  `NETWORK=local`. On any other network, a missing token makes the service exit at startup.
  An empty-string token is rejected at startup on every network.
- **Rationale**: NFR-006 means a misconfiguration never turns into accepting unauthenticated
  requests. This matches CFG-2's statement that the dev defaults are for local use only.
- **Alternatives considered**: Always falling back to the dev defaults was rejected because
  it is unsafe on base-sepolia. *SPEC only says the defaults are "for local use"; the
  startup refusal goes beyond that and is flagged for review.*

## R6. Key refusal in the agent

- **Decision**: In `src/main.ts`, immediately after loading `ENV_FILE`, the agent tests
  `"PAYER_PRIVATE_KEY" in process.env`. This is a presence check: empty and dummy values
  count. If present, it writes the refusal to stderr and calls `process.exit(1)`. dotenv does
  not override existing variables, so a key in the parent shell is caught too.
- **Rationale**: This covers the §12 manual check and the spec edge cases (`0x1`,
  `ENV_FILE=/dev/null`). Nothing is fetched before the check.

## R7. Loopback binding

- **Decision**: L2 and L3 call `app.listen(port, "127.0.0.1")`. The host is a constant,
  not configurable. The seller binds `0.0.0.0` (§16: no IPv6 `::` binding). The facilitator
  and ganache are local-only.
- **Rationale**: NFR-001: a port override changes only the port, never the interface.

## R8. Threat traceability as a contract

- **Decision**: [contracts/threat-matrix.md](contracts/threat-matrix.md) is the single
  mapping from SEC-* to control, owner feature and test IDs. Each owning feature's tests
  carry the SEC ID in their names.
- **Rationale**: NFR-005 and SC-004 (9 of 9 traceable).
