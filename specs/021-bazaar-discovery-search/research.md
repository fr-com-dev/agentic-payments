# Research: The Hosted Agent Searches for x402 Resources

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Date**: 2026-11-26

Each entry: Decision, Rationale, Alternatives considered. Facts about the discovery index come from Coinbase's
documentation (Sources at the end) and one probe of the public search on 2026-11-26.

## R1. The discovery index and its search

**Decision**: Search Coinbase's x402 Bazaar with `GET <CDP facilitator>/discovery/search`, where the facilitator's
address is the existing `CDP_FACILITATOR_URL` (`https://api.cdp.coinbase.com/platform/v2/x402`, `src/shared/config.ts`).
Query parameters: `query`, `network` (the profile's CAIP-2, `eip155:84532`), `scheme=exact`, `limit=20`. No key, no
header but `Accept: application/json`.

**Rationale**: Coinbase documents the discovery APIs as public ("You do not need a CDP API key to use the discovery
APIs"), and testnet resources are indexed once they settle through CDP. The probe (`query=weather`,
`network=eip155:84532`, `limit=3`) answered 200 with `application/json`, 7.4 KB, and this shape:

```text
{ x402Version: 2, searchMethod: "hybrid", partialResults: true, meta: { searchToken },
  resources: [ { resource, type: "http", x402Version, lastUpdated, description, serviceName, tags[],
                 quality: { l30DaysTotalCalls, l30DaysUniquePayers, lastCalledAt },
                 accepts: [ { scheme: "exact", network: "eip155:84532", amount: "1000", asset: "0x036C…", payTo, maxTimeoutSeconds, … } ],
                 extensions: { bazaar: { info: { input: { type: "http", method: "GET", queryParams: { location: "San Francisco" } } },
                                         schema: { properties: { input: { properties: { queryParams: {
                                           type: "object", properties: { location: { type: "string", description, minLength } },
                                           required: ["location"] } } } } } } } } ] }
```

All three results were other parties' weather APIs on Base Sepolia at 1000 atomic units. This is the input the
agent's search tool works from: an address, the payment options, a description and a declared input schema.

**Alternatives considered**: the paginated catalog (`/discovery/resources`): no relevance ranking, so the agent would
page through everything. Coinbase's Bazaar MCP server (`/discovery/mcp`): it would hand the model tools defined by a
third party, which is what this design avoids (FR-005). A general web search: rejected in the spec's Assumptions.
The x402.org facilitator's own catalog: a different index from the one the seller is paid through.

## R2. Our own small client, not the SDK's `withBazaar`

**Decision**: L1 calls the search with `fetch` in one new file, `src/layer1-intent/hosted/discovery.ts`, and parses
the answer with zod (already an L1 dependency). The fetch is injectable for tests, has
`AbortSignal.timeout(5000)`, `redirect: "error"`, and a 256 KB cap on the body. No new package in L1.

**Rationale**: `@x402/extensions@2.31.0` (installed, as a dependency of `@x402/express`) has
`withBazaar(client).extensions.bazaar.search({ query })`, which calls the same path. But it uses the global `fetch`
(no injection), sets no timeout and no abort signal, follows redirects, and throws errors that carry the index's
response text (`Facilitator searchDiscoveryResources failed (<status>): <text>`). FR-009 needs a 5 s bound and
SEC-64 needs the index's text kept from the model. Discovery JSON is not an x402 header, so Constitution VII (SDK
helpers for headers) doesn't apply; payments still go through the SDK unchanged.

**Alternatives considered**: wrapping the SDK call in a `Promise.race` timeout: the request would keep running after
the run moved on, and redirects would still be followed. Adding `@x402/extensions` to the L1 image for its types only:
a package for nothing at run time.

## R3. What the model sees of a listing

**Decision**: the search tool turns each listing into a fixed view (data-model.md, *Search result*), in this order:

1. Keep a listing only if `resource` is an absolute `https:` URL (or `http:` with a loopback host on the local network)
   with no user info, and one of its `accepts` has `scheme` `exact`, `network` equal to the profile's CAIP-2, `asset`
   equal to the profile's asset (case-insensitive) and `amount` matching `^[1-9][0-9]{0,30}$`. That option gives the
   price.
2. Deduplicate by the resource URL; keep at most 10.
3. `about`: the description with control characters removed, whitespace collapsed, cut to 300 characters. Markup is
   left as plain text: the model reads it as data in a JSON string.
4. `inputs`: from `extensions.bazaar.schema.properties.input.properties.queryParams` (and `pathParams`): at most 8,
   each name matching `^[A-Za-z][A-Za-z0-9_-]{0,39}$`, `type` one of `string`, `number`, `integer`, `boolean` (else
   `string`), `required` from that schema's `required`. The third party's per-input descriptions, `serviceName`,
   `tags`, `quality`, `iconUrl`, `payTo` and every other field are dropped.
5. `onSellerList`: the URL's `host` (lowercase, port included, as `new URL().host` gives it) is in the run's seller
   hosts (R4).
6. Results on the seller list first, then the others, each group in the index's order.

**Rationale**: FR-007 and SEC-60. The fields are what the agent needs to choose and to fill the address; everything
else is text written by a stranger. Dropping `payTo` keeps the model from reasoning about payees, which L2 decides.
The 300-character cut sits under Coinbase's own 500-character guidance for descriptions.

**Alternatives considered**: passing the listing through and relying on Coinbase's prompt-injection screening: the
spec doesn't rely on it (Assumptions), and the screening covers metadata only at indexing time. Dropping descriptions
altogether: the agent couldn't tell a weather API from a report, the problem this feature started from.

## R4. Which hosts the agent may fetch in search mode

**Decision**: a new L2 read, `GET /v1/sellers`, for the agent's role (`CONTROL_TOKEN`) only. It takes no caller's
token: INV-13, SEC-32 and Constitution V accept that token on the authorize and budget routes only ("no other route
reads it"), and this answer is the same for every caller. It answers `{ hosts: string[] }`: the platform mandate's
`allowedHosts` (`ALLOWED_HOSTS` or `config/mandate.json`) together with, when user accounts are on, the hosts of the
platform seller list (`PLATFORM_SELLERS` or `config/platform.json`). It reads configuration only: no ledger entry, no
sweep. The hosted agent asks it once at the start of each search-mode run and uses the answer, plus the configured
seller's host, as the orchestrator's `allowedHosts` and for `onSellerList`. `runGoal` bounds the read at 2 s (a timer
raced against it, as `checkAccount` bounds the account question). If the read fails or takes longer, the run continues
with the configured seller's host only, and every other result is marked not on the list.

**Rationale**: FR-010 requires the list L2 pays against, never a second copy. R6 decides per caller from the platform
mandate (a machine caller) or the person's policy, whose sellers are always on the platform list, so this union is
every host any caller could be paid at. Read per run so a change to L2's configuration needs no agent restart. Failing
closed keeps the 1.19 property (the agent reaches no site L2 didn't name). Leaving the caller's token off keeps INV-13
as it is, so the constitution amendment stays MINOR; the token would add nothing, since nothing in the answer depends
on the caller.

**Alternatives considered**: a second setting on the agent (`ALLOWED_SELLER_HOSTS`), filled from the same parameter
in Azure: on the VPS it would be a second copy kept by hand. A field in the budget answer: that answer goes to the
model through `check_budget`, and sellers aren't a session figure. Per-caller hosts (only the person's policy
sellers): stricter than the spec, which expects a listed seller outside the person's policy to reach L2 and be denied
there (US2 scenario 3).

## R5. The flag: `agent-test-mode`

**Decision**: the setting is `AGENT_TEST_MODE` in `l1-hosted.env`: `1` is test mode, `0` or absent is search mode, any
other value stops the agent at startup naming the setting (as `API_DOCS` does). In Azure it is `agent.testMode`
(boolean) in every `infra/main.<env>.bicepparam`, written to the agent's container only as `AGENT_TEST_MODE` `1` or
`0`; the dev file sets `true`, so the pipeline's smoke run keeps its fixed path. On the VPS, the operator sets it in
`env/l1-hosted.env`; the demo runs with `0`. The local example (`env/l1-hosted.env.example`), the local stack's child
env and the VS Code runner set `1`.

**Rationale**: the spec's "hidden" is hidden from callers and the model (FR-003), and repository practice is one
`=1` setting per optional behavior (`API_DOCS`, `USER_ACCOUNTS`, `CIBA_APPROVAL`). Every Azure value lives in the
parameter file (T-IAC-01 rule 17), so `agent.testMode` follows `agent.apiDocs`.

**Alternatives considered**: a request field or header: rejected by FR-002 (any caller could choose). A must-fail
switch: those are test-only deps, never env, and this is an operating mode, not a disabled safety check.

## R6. Tools and prompt per mode

**Decision**: `createRunTools` takes the mode. Test mode builds exactly today's two tools and `buildAgent` gets
`systemPrompt(sellerUrl)` (L1-3, unchanged). Search mode adds `search_resources` (input `{ query: string }`, cut to
200 characters, `additionalProperties: false`) and uses a new `searchSystemPrompt(sellerUrl)`, whose text is fixed in
[contracts/hosted-agent-api.md](contracts/hosted-agent-api.md#the-search-mode-prompt). The tool's description is
fixed there too and names no mode. The command-line agent (`src/layer1-intent/agent.ts`, L1-3) keeps `AGENT_TOOLS`
and its prompt.

**Rationale**: FR-004 (test mode is byte-for-byte today's model input, so T-AGT-02's current assertions hold in test
mode) and FR-005, FR-012. One model path (`agent.stream`) stays.

**Alternatives considered**: offering the search tool in test mode and telling the model not to use it: the model
could still use it, and the model input would differ from today's.

## R7. Bounds and failures of a search

**Decision**: per run, at most 3 calls reach the index; a 4th returns `{ outcome: "LIMIT_REACHED", results: [] }`
without a request. Each call gives up after 5 s. A network error, a redirect, a non-200 status, a body over 256 KB,
JSON that zod refuses, or no result that passes R3 gives `{ outcome: "UNAVAILABLE", results: [] }` (none passing is
`OK` with an empty list; the prompt then sends the model to the catalog). Nothing from the index's error reaches the
tool's output, a step or a log.

**Rationale**: FR-009, SEC-64, NFR-004 (3 × 5 s stays well inside the 200 s run deadline; one search in the smoke run
adds at most 5 s to its 120 s).

**Alternatives considered**: retrying a failed search: the catalog fallback is cheaper and keeps the run's time
bounded.

## R8. Logs, steps and the stream

**Decision**: the run line gains `mode: "search" | "test"`. A search step's log line has `tool: "search_resources"`,
`outcome` (`ok`, `unavailable`, `limit_reached`) and `results` (a count), never the query or a listing's text. In the
answer and the stream, a search step is `{ index, tool: "search_resources", query, result }`, where `query` is the
cut query and `result` the tool's output. `docs/l1-hosted.openapi.yaml` adds the tool name and `query` to the step
schema; it names no mode.

**Rationale**: FR-017, FR-018, FR-003. The caller may see their own run's query, as they see `purpose`; the log may
not, as it doesn't hold `purpose` (T-AGT-20).

## R9. The seller describes itself for the index

**Decision**: a priced route's declaration gains what the index needs, in the two decorators it already has:

- `@Get(path, { query: { city: { type: "string", required: true, about: "…", example: "Lima" } } })`: typed inputs
  with one example value each (today `query: ["city"]`).
- The tier decorator gains `about` (at most 500 characters): what the route returns, in plain words. `description`
  stays the short label.
- The example answer is the handler's own answer to the example inputs, computed when the seller is built, so it
  can't drift from the route (the handlers are deterministic).

From that one declaration the seller builds: the catalog item's new `about` and `inputs` fields; the route config's
`description` (`about`), `serviceName`, and `extensions: declareDiscoveryExtension({ input, inputSchema, output: { example } })`;
and it registers `bazaarResourceServerExtension` on its resource server. `@x402/extensions` becomes a direct
dependency at the SDK's pinned version (2.31.0), in the seller's image only (A19 part 2).

**Rationale**: FR-015, FR-016, CP-1 (route, price, catalog and now listing from one declaration). The x402 client SDK
already copies a challenge's `extensions` and `resource` into the payment payload (`@x402/core` client, v2 path), L2
forwards the whole challenge to the signer and doesn't strip `extensions` (`validIntent`, `signer.ts`), and the
seller sends that payload to the facilitator on settle. So the facilitator sees the declaration with no L1 or L2
change. L2's authorize body limit (256 KB) leaves room for the larger challenge.

**Alternatives considered**: a separate `@Discovery` decorator: a priced route could then lack it; putting it in the
tier makes it part of the one declaration. Letting CDP's minimal automatic declaration stand: it carries no input
schema, so the agent couldn't fill `city`.

## R10. Getting the demo seller listed

**Decision**: on the VPS, the agent's `SELLER_URL` becomes `https://seller.fabriciorojas.com` (today
`http://127.0.0.1:4021`, docs/self-hosted/base-sepolia.md), and L2's `ALLOWED_HOSTS` and `PLATFORM_SELLERS` gain the
host `seller.fabriciorojas.com` (the loopback host stays, so existing policies keep working). One paid call to each
route that should be listed, through the public address, then up to 15 minutes. CDP's public `POST …/x402/validate`
checks a route's eligibility first.

**Rationale**: the seller's challenge names the address the request came to (`@x402/express` builds it from the
request's `Host`), and that becomes the listing's address. A paid call over loopback would offer a loopback address,
which CDP's listing checklist rules out (it asks for public HTTPS) and which no buyer could reach. Fetching the public address also keeps R7 (challenge host
equals requested host). The premium report escalates and the dataset export is denied, so neither is paid and neither
gets listed (spec US4 scenario 2) unless an operator approves a premium purchase once.

**Alternatives considered**: a fixed public `resource` per route in the seller's route config: then any buyer using
another address fails R7 (`resource_binding_mismatch`).

## R11. Where the new code may live (architecture rule A19)

**Decision**: a new rule, A19, in `test/architecture.test.ts`: (1) under `src/`, the search path `/discovery/search`
appears only in `src/layer1-intent/hosted/discovery.ts`, which only `src/layer1-intent/hosted/agent.ts` imports;
(2) `@x402/extensions` is imported only under `src/counterparty/`; (3) `policy.ts`, `signer.ts` and `ledger-key.ts`
never name the discovery index.

**Rationale**: the repository confines each outside service to one file (A8, A9, A18). The discovery client is no
credential, but it is the one place third-party text enters L1.

## R12. Testing

**Decision**:
- A stand-in discovery index, `test/helpers/discovery-stub.ts`, on loopback over HTTP, as `coinbase-stub.ts` is: it
  records each query, and answers with fixtures (good listings, listings with instruction-like text, other networks,
  duplicates, oversized, malformed, slow, redirecting, 500). Its address is a test dep, never env. No test reaches the
  real index (NFR-005).
- Hosted-agent tests use the test model's scripted turns (`doStream`), as today, so a test fixes which tool the model
  calls; what the model would choose (SC-001..003) is checked by hand (quickstart §4).
- Must-fail switches, test-only deps on the hosted agent: `modeFromHeader`, `rawListings`, `skipSearchLimit`,
  `skipSearchTimeout`, `skipSellerList`. Each makes its test fail (contracts/hosted-agent-api.md).
- New test IDs: T-AGT-21..24, T-DISC-01..03, T-SEL-01, T-MON-04, T-E2E-18; T-MON-03 (amended); T-AGT-02, T-AGT-20, T-API-01..07,
  T-API-09..10, T-IMG-01, T-DEV-01 and T-IAC-01 (rule 27) amended; T-ARCH-A19.

## R13. Order of deployment

**Decision**: L2 first (the sellers route), then the seller (its declarations), then L1. An L1 with 021 in search mode
in front of an L2 without the route gets 404 and runs with the configured seller only (R4), so nothing breaks; an
old L1 never calls the route.

## R14. Constitution and SPEC

**Decision**: Constitution 3.2.0 → 3.3.0 (MINOR), with SPEC 1.31 in the same change: Technology & Scope gains "the
hosted agent may search a public x402 discovery index (Coinbase's Bazaar) over HTTPS, with no credential; what it
returns is untrusted data, shown to the model as fixed fields only, and never decides a payment". SPEC: §15 EXT-10;
L1-1 step 0, L1-6 (modes, the third tool, the prompt, limits, logs, steps), L2-5 (`GET /v1/sellers`), §7
(`SellerHosts`), CP-1 (typed inputs, `about`, the discovery declaration, the catalog's new fields), CFG-2
(`AGENT_TEST_MODE`, `DISCOVERY_URL`), §3.1 (`agent.testMode`; the agent's outbound call to CDP), §11 SEC-60..64, §12
tests. `CLAUDE.md` hard rule 2 ("offers only `fetch_resource` and `check_budget`") becomes "two tools in test mode,
those two and `search_resources` in search mode".

## Sources

- [x402 Bazaar (CDP docs)](https://docs.cdp.coinbase.com/x402/bazaar)
- [Discover services (buyer)](https://docs.cdp.coinbase.com/x402/buyer/discover-services)
- [Get discovered (seller)](https://docs.cdp.coinbase.com/x402/seller/get-discovered)
- [Search resources (API reference)](https://docs.cdp.coinbase.com/api-reference/v2/rest-api/x402-facilitator/search-resources)
- `node_modules/@x402/extensions/dist/esm/chunk-2YLWFVIL.mjs` (the SDK's search client), `node_modules/@x402/core/dist/esm/client/index.mjs` (the payload's `extensions` and `resource`)
