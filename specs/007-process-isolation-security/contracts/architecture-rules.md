# Contract: Architecture rules (`test/architecture.test.ts`, T-ARCH-*)

## Layers and scope

| Folder | Layer | May import (relative or alias) |
|---|---|---|
| `src/shared/**` | shared | `src/shared/**` only |
| `src/layer1-intent/**` | L1 | `src/shared/**`, `src/layer1-intent/**` |
| `src/layer2-control/**` | L2 | `src/shared/**`, `src/layer2-control/**` |
| `src/layer3-settlement/**` | L3 | `src/shared/**`, `src/layer3-settlement/**` |
| `src/counterparty/**` | CP | `src/shared/**`, `src/counterparty/**` |
| `src/main.ts`, `scripts/**`, `test/**` | composition | anything (exempt from A1) |

Package imports (`@x402/*`, `viem`, `express` and so on) are allowed unless a rule below
forbids them.

## Rules

| ID | Invariant | Scope | Fails when |
|---|---|---|---|
| A1 | INV-1 | all layer folders | an import resolves into another layer's folder |
| A2 | INV-1 | `src/shared/**` | shared re-exports or imports layer code (prevents laundering through shared) |
| A3 | INV-2 | `src/**` except `src/layer2-control/signer.ts` (no other exemption; `scripts/**` is out of scope) | identifier `privateKeyToAccount` or `mnemonicToAccount`, or import of `viem/accounts` |
| A4 | INV-4 | `src/layer3-settlement/**` | identifier `createWalletClient`, `signTypedData`, `writeContract`, `sendTransaction`, `privateKeyToAccount` |
| A5 | INV-3 | `src/layer1-intent/**` | string or identifier `PAYER_PRIVATE_KEY` |
| A6 | INV-5 | `src/layer2-control/policy.ts` | imports of `node:*`, `fs`, `http`, `express`, `viem`, `@anthropic-ai/*`; or `Date.now`, `new Date(` with no argument, `fetch(`, `Math.random`, `console.`, `node:fs`, and any identifier access to `purpose` (e.g. `ctx.purpose`, `intent.purpose`); comments are ignored. Merges 002 T020's list; 007 is the single owner of this check |
| A7 | §10 | all layer folders | `Buffer.from(…, "base64")` / `atob` / `btoa` in a file that mentions `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE` or `PAYMENT-RESPONSE` |

`src/main.ts` may reference `PAYER_PRIVATE_KEY`, but only for the refusal check. It is
outside A5's scope by layout.

## Failure output

Each violation prints as `A<n> <file>:<line> <detail>`. The test asserts that the list is
empty and prints all violations, not just the first.

## Negative fixtures (must-fail proof)

Each `test/fixtures/arch/a<n>-violation.ts` contains exactly one violation of rule A<n>,
with a virtual path given to `checkFile`. The test asserts
`checkFile(fixture).map(v => v.rule) == ["A<n>"]` for n = 1..7.
