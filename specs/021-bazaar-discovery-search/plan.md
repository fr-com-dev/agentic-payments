# Implementation Plan: The Hosted Agent Searches for x402 Resources

**Branch**: `021-bazaar-discovery-search` (work on `claude/l1-agent-endpoint-selection-c16c8b`) | **Date**: 2026-11-26 |
**Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/021-bazaar-discovery-search/spec.md` (no clarification session; the
three defaults in its Assumptions stand: the flag is a deployment setting, R6 stays, the search covers x402
resources only).

## Summary

The hosted agent gets two modes. **Test mode** (`AGENT_TEST_MODE=1`, the spec's `agent-test-mode`) is the agent as
it is today. **Search mode** (the default) adds one read-only tool that searches Coinbase's public x402 discovery
index, so the agent can find a resource that fits the goal before it buys.

- **The index.** `GET <CDP facilitator>/discovery/search?query&network&scheme=exact&limit=20`, public, no key. A probe
  on 2026-11-26 returned Base Sepolia weather APIs with their price, description and input schema
  ([R1](research.md#r1-the-discovery-index-and-its-search)).
- **Our own client, one file.** `src/layer1-intent/hosted/discovery.ts` calls it with `fetch` (5 s, no redirects,
  256 KB cap) and validates the answer with zod. The SDK's client has no timeout and leaks error text, so it isn't
  used ([R2](research.md#r2-our-own-small-client-not-the-sdks-withbazaar)). New architecture rule A19 confines it.
- **Fixed fields only.** Each listing becomes `{ url, host, priceAtomic, priceUsd, network, about (≤ 300), inputs
  (≤ 8), onSellerList }`, filtered to the profile's network, `exact` and USDC, deduplicated, at most 10
  ([R3](research.md#r3-what-the-model-sees-of-a-listing)).
- **The agent fetches only what L2 would pay.** A new L2 read, `GET /v1/sellers` (agent role only; no caller's token,
  INV-13), answers the hosts of the platform mandate and the seller list; the run's orchestrator gets them as
  `allowedHosts`.
  If L2 doesn't answer, the run uses the configured seller only. L2's policy is untouched
  ([R4](research.md#r4-which-hosts-the-agent-may-fetch-in-search-mode)).
- **The flag.** `AGENT_TEST_MODE` `1`/`0`, absent is `0`, anything else stops the agent at startup. `agent.testMode`
  in every Azure parameter file (dev: `true`). It is never a request field, and no answer, prompt or tool description
  names it; the run log line records `mode` ([R5](research.md#r5-the-flag-agent-test-mode),
  [R8](research.md#r8-logs-steps-and-the-stream)).
- **Bounds.** 3 searches per run, sharing 5 s (each gets what is left; once it is spent a search sends nothing), query
  cut to 200 characters and never logged; any failure is a fixed
  `UNAVAILABLE` and the prompt sends the model to the catalog ([R7](research.md#r7-bounds-and-failures-of-a-search)).
- **The seller describes itself.** Typed inputs with an example (`@Get`), an `about` text (the tier decorators), and
  the handler's own answer as the example. From that one declaration: the catalog's new `about` and `inputs`, and the
  challenge's Bazaar extension. The x402 client SDK already echoes it in the payment, so CDP can list the route after
  its first settlement, with no L1 or L2 change ([R9](research.md#r9-the-seller-describes-itself-for-the-index)).
- **The demo.** On the VPS the agent's seller becomes `https://seller.fabriciorojas.com` and L2 allows that host too,
  so the listed address is public and reachable ([R10](research.md#r10-getting-the-demo-seller-listed)).

The command-line agent, the scripted plan, the local demo, L3 and the portal don't change.

## Technical Context

**Language/Version**: TypeScript (strict), ESM, Node.js ≥ 22.13 (development on Node 26).

**Primary Dependencies**: no new package in L1 (`fetch`, zod, Mastra as today). The seller imports
`@x402/extensions/bazaar` (`declareDiscoveryExtension`, `bazaarResourceServerExtension`), made a direct dependency at
2.31.0, the version `@x402/core`, `@x402/evm` and `@x402/express` are pinned at.

**Storage**: none new. L2's ledger gets no entry type; the sellers route reads configuration only.

**Testing**: vitest. A stand-in discovery index over HTTP on loopback (`test/helpers/discovery-stub.ts`); the hosted
agent's test model with scripted turns (`test/helpers/hosted.ts`); an in-process L2 for the sellers route; the
on-chain local suite for T-E2E-18; architecture fixtures for A19; OpenAPI and IaC checks
([R12](research.md#r12-testing)).

**Target Platform**: the hosted agent and the seller, locally, on the self-hosted VPS (dev, Base Sepolia) and in the
Azure profile (Base Sepolia). The public index exists for Base Sepolia; the local chain has none.

**Project Type**: the existing multi-process service. This feature changes L1's hosted agent, adds one read route to
L2 and changes the seller's declarations.

**Performance Goals**: a search answers or gives up within 5 s; the smoke run stays within 120 s in either mode.

**Constraints**: Constitution I (no signing tool; the agent reaches only hosts L2 names), II (nothing from a listing
reaches a decision), V (no credential added; the caller's token goes to L2 only, never to the index), VII (payments
through the SDK, unchanged), VIII (five must-fail switches). Text from the index is untrusted (SEC-60).

**Scale/Scope**: one demo seller, a handful of searches per run, up to 10 results each.

## Constitution Check

*GATE: checked before Phase 0 and again after Phase 1 design (constitution v3.2.0).*

| Principle | Check | Before | After design |
|---|---|---|---|
| I. Separation of payment authority | The new tool reads a public index and returns data; it can't fetch, pay, approve or reach L2 or L3 (FR-005). The agent still holds no key. In search mode it reaches only the hosts L2 names (`GET /v1/sellers`), and the configured seller only when L2 doesn't answer (R4). The new L2 route opens nothing for the agent but a read of configuration. | Pass | Pass |
| II. Deterministic, pure policy | `policy.ts` gets no input; a listing's price, text and the query never reach L2 (FR-013). R6 unchanged. | Pass | Pass |
| III. Ledger is the single source of truth | No entry type, no counter; the sellers route reads configuration, not the ledger. | Pass | Pass |
| IV. Trust the chain | Untouched: a found resource is paid and verified as any other (FR-014). | Pass | Pass |
| V. Least-privilege credentials | No new credential: the index is public. The caller's token still goes to L2 on authorize and budget only: the new route takes `CONTROL_TOKEN` alone and reads no caller's token (INV-13, SEC-32), and L1's `sellers()` sends none, even on a gate made for a caller. The token never goes to the index, which receives the cut query and the network filters only (NFR-002). | Pass | Pass |
| VI. Exact money arithmetic | Prices stay atomic decimal strings, checked with a regex and shown with `formatAtomic`; no float. | Pass | Pass |
| VII. Protocol fidelity | Payments unchanged, through the SDK. The seller's discovery declaration uses the SDK's own `declareDiscoveryExtension` and `bazaarResourceServerExtension`. The discovery answer is JSON, not a protocol header (R2). | Pass | Pass |
| VIII. Proven safety | Five must-fail switches (`modeFromHeader`, `rawListings`, `skipSearchLimit`, `skipSearchTimeout`, `skipSellerList`), each with a test that fails with it on; A19; T-E2E-18 shows an unlisted host is never requested. | Pass | Pass |
| Technology & scope | An outbound call from L1 to a third-party index is new scope (no credential, untrusted data). **Needs the MINOR amendment below.** | Pass with amendment | Pass with amendment |

**Constitution amendment (3.2.0 → 3.3.0, MINOR)**, made with SPEC.md in the same change (Governance):
- Technology & Scope: "Since 3.3.0 the hosted agent may search a public x402 discovery index (Coinbase's Bazaar)
  over HTTPS, with no credential. What it returns is untrusted data: the model sees fixed fields only, the agent
  fetches only hosts the control layer names, and nothing from it decides a payment. The seller uses the x402 SDK's
  extensions package, at the SDK's pinned version, to describe its routes for that index."

No violation needs the Complexity Tracking table.

## Project Structure

### Documentation (this feature)

```text
specs/021-bazaar-discovery-search/
├── spec.md
├── plan.md                       # this file
├── research.md                   # R1–R14
├── data-model.md                 # mode, search result, seller hosts, discovery declaration, log fields
├── quickstart.md                 # local checks, the VPS demo, the hand-run model checks
├── contracts/
│   ├── hosted-agent-api.md       # the mode, the tools, the prompt, steps, stream, run log, must-fail switches
│   ├── discovery-index.md        # what L1 sends to the index and how it reads the answer
│   ├── control-api.md            # GET /v1/sellers
│   ├── seller-api.md             # typed inputs, about, the catalog's new fields, the challenge's extension
│   └── config.md                 # AGENT_TEST_MODE, DISCOVERY_URL, agent.testMode, the VPS settings
├── checklists/requirements.md
└── tasks.md                      # /speckit-tasks
```

### Source Code (repository root)

```text
src/
├── shared/
│   ├── contracts.ts              # + SellerHosts { hosts: string[] }
│   └── config.ts                 # unchanged: discovery.ts builds the default from CDP_FACILITATOR_URL (A19 keeps the path there)
├── layer1-intent/
│   ├── orchestrator.ts           # unchanged (allowedHosts already exists)
│   ├── ports-http.ts             # + HttpAuthorizationGate.sellers() → GET /v1/sellers (CONTROL_TOKEN only, never the caller's token)
│   └── hosted/
│       ├── discovery.ts          # NEW: the index client, its default address and the listing → search result view (A19)
│       ├── agent.ts              # mode-aware tools and prompt; search_resources; per-run limits; seller hosts
│       ├── config.ts             # + AGENT_TEST_MODE, DISCOVERY_URL
│       ├── run-log.ts            # + mode on the run line; search step fields
│       └── server.ts             # mode into the run; steps with `query`
├── layer2-control/
│   └── service.ts                # + GET /v1/sellers (agent-control role only, no caller's token, no ledger)
├── counterparty/
│   ├── endpoints.ts              # typed query inputs with an example; advertisedPath unchanged
│   ├── monetization.ts           # + `about` on the paid tiers
│   ├── seller-api.ts             # about/inputs for the four routes; catalog item + about, inputs
│   └── seller.ts                 # route config: description, serviceName, extensions; register the bazaar extension
├── hosted-main.ts                # unchanged order (config refuses a bad AGENT_TEST_MODE)
scripts/
├── demo-lib.ts                   # child env: AGENT_TEST_MODE=1 for the hosted agent
├── vscode-local.ts               # (through demo-lib) T-DEV-01
└── image-closure.ts              # the seller image's packages include @x402/extensions
env/l1-hosted.env.example         # + AGENT_TEST_MODE=1, DISCOVERY_URL (commented)
infra/
├── main.bicep, modules/l1-apps.bicep   # agent.testMode → AGENT_TEST_MODE
└── main.dev.bicepparam           # agent.testMode: true
docs/
├── l1-hosted.openapi.yaml        # step schema: search_resources, query
├── l2-control.openapi.yaml       # GET /v1/sellers
├── seller.openapi.yaml           # catalog item about/inputs; the challenge's extensions
└── self-hosted/base-sepolia.md   # the VPS demo settings (R10)
test/
├── helpers/discovery-stub.ts     # NEW
├── hosted-search.test.ts         # NEW: T-AGT-21..24
├── discovery.test.ts             # NEW: T-DISC-01..03
├── control-sellers.test.ts       # NEW: T-SEL-01
├── seller-monetization.test.ts   # + T-MON-04; T-MON-03 amended
├── e2e.local.test.ts             # + T-E2E-18
├── hosted-agent.test.ts          # T-AGT-02 per mode
├── hosted-run-log.test.ts        # T-AGT-20 with mode
├── architecture.test.ts          # A19
└── openapi.test.ts, openapi-hosted.test.ts, openapi-seller.test.ts, infra.test.ts, images.test.ts,
    vscode-local.test.ts   # amended
SPEC.md, .specify/memory/constitution.md, CLAUDE.md, specs/README.md
```

**Structure Decision**: the existing layout. The one new source file is the discovery client inside the hosted
agent's folder; L2's new route sits beside budget in `service.ts`, and the seller's change stays in its decorators.

## Delivery

Five slices, each green on `npm run check` before the next. 1 and 2 can go in either order; 3 needs 2.

1. **Seller (US4).** Typed inputs, `about`, catalog fields, the Bazaar extension; T-MON-04, T-MON-03 (amended), T-API-09..10. Useful
   alone: in today's agent the catalog now tells the weather route from the report.
2. **L2 (FR-010).** `GET /v1/sellers`, `SellerHosts`, the OpenAPI entry; T-SEL-01, T-API-01..04.
3. **L1 (US1, US2, US3, US5).** The flag and modes (test mode first, proving T-AGT-02 unchanged), then the client,
   the tool, the seller hosts and the limits, the logs and steps; the stub; T-AGT-21..24, T-DISC-01..03, T-E2E-18,
   A19, the five must-fail switches.
4. **Config and documents.** Env example, local child env, Bicep parameter and rule 27, SPEC 1.31, constitution
   3.3.0, `CLAUDE.md` hard rule 2 and gotchas, specs index.
5. **The demo on the VPS (operator, by hand).** quickstart §3: deploy L2, the seller, then L1; the settings of R10;
   one paid call per route; wait up to 15 minutes; run the demo goals; the hand checks of quickstart §4.

## Complexity Tracking

No constitution violation needs justifying.
