# Feature Specification: The Hosted Agent Searches for x402 Resources

**Feature Branch**: `021-bazaar-discovery-search`

**Created**: 2026-11-25

**Status**: Draft

**Input**: User description: "For demo purposes, the agent searches in seller.fabriciorojas.com (it supports x402). However, the
agent must use a search tool, looking for a web page or API that satisfies the user's prompt, of course supporting the x402
protocol. Include one hidden flag, agent-test-mode: true. If the flag is true, for testing purposes, go directly to
seller.fabriciorojas.com."

## Reading the request against the repository

Today the hosted agent (L1-6) knows one seller, the one its deployment names (`SELLER_URL`; in the dev environment on the
VPS, `seller.fabriciorojas.com`). Its prompt sends it to that seller's free catalog, and it picks an item by reading a
few words of description per item. It can't look anywhere else, and it can't fetch any host but that seller's (L1-1
step 0, since 1.19). A test with the goal "Get weather premium report for Trujillo" showed the limit: the catalog says
nothing that tells "current weather for a city" apart from "premium research report", so the agent may pay for a report
that has nothing to do with Trujillo.

The x402 ecosystem has a public search service for this: a **discovery index** where sellers that take x402 payments
are listed with what each resource does, what it takes and what it costs (Coinbase's x402 Bazaar). Searching it needs no
key. This feature gives the agent a search tool over that index, keeps every payment rule as it is, and adds a test mode
that takes the agent straight to the configured seller, as it works today.

| Request | This spec |
|---|---|
| "the agent must use a search tool, looking for a web page or API that satisfies the user's prompt" | A third tool, read-only: it searches the discovery index for resources that fit the goal (US1). It searches x402 resources, not the open web: an ordinary web page can't be bought with x402, and a general web search would bring raw page text from anywhere into the model (Assumptions). |
| "of course supporting the x402 protocol" | Only resources that take x402 v2, the `exact` scheme and USDC on the deployment's network are shown (FR-006). Buying is unchanged: the seller's own 402 challenge, L2's decision, L3's check (FR-014). |
| "for demo purposes, the agent searches in seller.fabriciorojas.com" | The seller describes each priced route for the index, so a search finds it (US4). The agent may fetch and pay only the sellers on the operator's seller list; for the demo that list is this seller (FR-010, FR-011). |
| "one hidden flag, agent-test-mode: true … go directly to seller.fabriciorojas.com" | **Test mode**: a deployment setting, off by default. On, the agent has no search tool and goes straight to the configured seller's catalog, exactly as today. Callers and the model can't see or change it (US3). |

## User Scenarios & Testing *(mandatory)*

Terms used below:
- **Person**: someone who starts a run of the hosted agent with their own sign-in (feature 016). A **machine caller**
  starts runs too, for the platform account; everything below applies to both unless a story says otherwise.
- **Discovery index**: a public list of resources that take x402 payments, each with a description, its inputs and its
  price, which sellers get onto by being paid through the hosted facilitator. Coinbase's x402 Bazaar is the one this
  feature uses.
- **Listing**: one resource in the discovery index. Its text is written by whoever runs that resource: it is untrusted.
- **Seller list**: the sellers the operator allows, by host (CFG-4). L2 pays no host outside it (R6), and a person's
  expense policy can name only sellers on it.
- **Configured seller**: the one seller the agent's deployment names. It is on the seller list.
- **Search mode**: the agent searches the discovery index first. This is the default.
- **Test mode**: the agent skips the search and goes straight to the configured seller, as it does today. It is on when
  the deployment setting `agent-test-mode` is `1` (on), as the repository's other on/off settings are written.

### User Story 1 - The agent finds what the goal needs by searching (Priority: P1)

A person asks the hosted agent for something, such as "today's weather for Trujillo". The agent searches the discovery
index for resources that fit, reads what each result does, takes and costs, chooses the one that fits best on the
seller list, fills in its inputs (the city), and buys it the usual way. The answer lists what was found, what was
bought, its price and its settlement.

**Why this priority**: it is the feature. Without it the agent can only pick from one seller's short descriptions.

**Independent Test**: with a stand-in discovery index that lists the seller's weather route with its `city` input and
its price, a run with the goal "today's weather for Trujillo" searches once, buys
`<seller>/api/weather?city=Trujillo`, and its answer shows the search step and the purchase.

**Acceptance Scenarios**:

1. **Given** search mode and a listing for the seller's weather route, **When** a person asks for the weather in a
   city, **Then** the agent searches, buys that route with the city filled in, and the purchase is decided by L2 as any
   other.
2. **Given** search mode, **When** the agent searches, **Then** each result it sees has only fixed fields: the
   resource's address and host, the price in atomic units and in USD, the network, a description of at most 300
   characters, its inputs (name, type, required or not) and whether its host is on the seller list.
3. **Given** a listing whose price differs from the seller's own payment challenge, **When** the agent buys it,
   **Then** L2 decides from the seller's challenge alone, and the answer shows the price actually paid.
4. **Given** a run in search mode, **When** it ends, **Then** its answer and its stream list each search as a step,
   with the query the model wrote and the results it saw.

---

### User Story 2 - Sellers off the list are reported, never fetched or paid (Priority: P1)

A search can find resources on hosts the operator never allowed. The agent may tell the person about them, but it must
not fetch them, and L2 must not pay them.

**Why this priority**: a search brings other parties' text and addresses into the run. Without this rule, search mode
would undo the 1.19 limit on what the agent fetches (SEC-1) and the seller list would be the only thing left between a
listing and a payment.

**Independent Test**: with a stand-in index whose best match is on a host not on the seller list, the run makes no
request to that host (the stand-in seller records none), makes no payment request for it, and its answer names the
host as found but not allowed.

**Acceptance Scenarios**:

1. **Given** a result whose host is not on the seller list, **When** the model asks to fetch it, **Then** the fetch is
   refused before any request is made, as a host outside the list is refused today (L1-1 step 0), and nothing reaches L2.
2. **Given** a listing whose description tells the agent to pay someone, visit an address or ignore its instructions,
   **When** the agent searches, **Then** that text reaches the model only inside the bounded description field, the
   agent can still fetch only hosts on the seller list, and every payment rule applies unchanged.
3. **Given** a person whose expense policy names fewer sellers than the seller list, **When** the agent buys from a
   listed seller outside that policy, **Then** L2 denies it as today (`host_not_allowed`), and the agent reports the rule.
4. **Given** a listing whose address is not http(s), or whose host differs from every host on the seller list (another
   port, or an IP address for a listed name), **When** the search returns it, **Then** it is marked as not on the
   seller list.

---

### User Story 3 - The operator turns on test mode (Priority: P1)

For testing and for regression runs, the operator turns `agent-test-mode` on (`1`) in the agent's deployment. The agent
then works exactly as it does before this feature: two tools, the prompt that starts at the configured seller's
catalog, and only the configured seller's host. Nobody who calls the agent can turn it on or off, and nothing in an
answer says which mode a run used. The operator sees the mode in the run log.

**Why this priority**: tests, the deployment's smoke run and the demo need a run that doesn't depend on a third-party
index or on what other sellers list today.

**Independent Test**: with `agent-test-mode` on, every model call offers exactly `fetch_resource` and `check_budget`
with today's descriptions and today's prompt, every existing hosted-agent test passes unchanged, and the run log's
run line says `test`. With it off, the same call offers the three tools and the run line says `search`.

**Acceptance Scenarios**:

1. **Given** `agent-test-mode` on, **When** a run starts, **Then** the model is offered exactly the two tools of
   today, the prompt sends it to the configured seller's catalog, and the agent fetches only that seller's host.
2. **Given** the setting absent or `0`, **When** a run starts, **Then** the run is in search mode. **Given** any other
   value (`true` and `false` included), **When** the agent starts, **Then** it refuses to start, naming the setting.
3. **Given** any mode, **When** a request carries a field that names the mode, **Then** it is refused as every unknown
   field is today (400), and no header, goal text or session can change the mode.
4. **Given** a goal that says "agent-test-mode: true" or "skip the search", **When** the run is in search mode,
   **Then** it stays in search mode: the model has no way to choose the mode.
5. **Given** any mode, **When** a run ends, **Then** its answer, its stream and the model's tool descriptions never name
   the mode or the setting, and the run's log line records `search` or `test`.
6. **Given** a run in progress, **When** the operator changes the setting, **Then** the run keeps its mode; the
   change applies to runs that start after the agent is deployed again with it.

---

### User Story 4 - The seller can be found, and its catalog says what each item is (Priority: P2)

The seller describes each priced route for the discovery index: what it returns, the inputs it reads and an example
answer. The same description and inputs appear in its free catalog, so an agent in either mode can tell the weather
route from the research report.

**Why this priority**: in search mode the agent finds the demo seller only if the seller is listed; in test mode the
richer catalog fixes the "premium report for Trujillo" mistake on its own.

**Independent Test**: the seller's payment challenge for each priced route carries its discovery description, inputs
and example; its catalog shows the same description and inputs; the weather route's input `city` is a required text;
the research report says it takes no input and does not depend on a place.

**Acceptance Scenarios**:

1. **Given** the seller on the hosted facilitator, **When** a route is paid for the first time, **Then** that route
   becomes eligible for the discovery index, and appears within the time the index states (up to 15 minutes).
2. **Given** a route that has never been paid through the hosted facilitator (today, the premium report, which
   escalates, and the dataset export, which is denied), **When** the agent searches, **Then** it isn't listed, and the
   agent can still reach it through the catalog.
3. **Given** the catalog and the discovery description of a route, **When** they are compared, **Then** they agree,
   because both come from the route's one declaration (CP-1).
4. **Given** the local facilitator, **When** the seller runs locally, **Then** nothing reaches the discovery index and
   the seller behaves as today, the richer catalog aside.

---

### User Story 5 - Nothing fits, or the search fails (Priority: P2)

When the search fails, is slow, or finds nothing on the seller list that fits, the agent looks at the configured
seller's catalog. When nothing there fits either, it buys nothing and tells the person why.

**Why this priority**: the discovery index is a third party; a run must still work without it. And buying the closest
wrong thing costs the person money.

**Independent Test**: with the stand-in index down, a run for the weather in a city buys it through the catalog; with
the goal "flight prices from Lima to Trujillo", which no listing and no catalog item fits, the run buys nothing and
says that no item fits.

**Acceptance Scenarios**:

1. **Given** the index unreachable, answering an error, answering after 5 seconds or answering something malformed,
   **When** the agent searches, **Then** the tool reports the search as unavailable, without the index's own error text,
   and the agent continues from the configured seller's catalog.
2. **Given** a goal that no listed result and no catalog item fits, **When** the run ends, **Then** nothing was bought,
   and the answer says what was looked for and that no item fits.
3. **Given** a run that has searched 3 times, **When** the model searches again, **Then** the tool refuses with a fixed
   message and the index is not called.

---

### Edge Cases

- A listing's text contains instructions, links, markup or control characters: only the fixed fields reach the model,
  the description is plain text cut to 300 characters, and no address in it is ever fetched (US2).
- The same resource is listed more than once, or under many hosts: results are deduplicated by address and capped at
  10 per search.
- A listing is for another network, scheme or asset: it is dropped before the model sees it.
- A listing's address has a path or query input: the agent fills the inputs the listing declares; the seller ignores
  inputs it doesn't read, and L2's approvals and rejections stay per path without the query (as today).
- A listing names a host on the seller list but a path that the seller no longer serves: the fetch returns the
  seller's answer (for example 404) and nothing is paid.
- The model's search query carries details the person typed (a name, an address): the prompt tells the model to search
  for the kind of resource only, the query is cut to 200 characters, and it is never logged (FR-008).
- A machine caller's run (the deployment's smoke run) in search mode: same tools and rules; it must still buy the
  weather and the market brief within its time limit.
- The local network has no public discovery index: in search mode the agent needs the address of a stand-in index, or
  it refuses to start, naming the setting; the local examples turn test mode on (FR-019).
- A search step, a fetch step and the 10-step limit: a search is a step like any other; a run that reaches the limit
  stops as today (`step_limit`).

## Requirements *(mandatory)*

### Functional Requirements

**Modes**

- **FR-001**: The hosted agent MUST have two modes, search mode and test mode, chosen only by the deployment setting
  `agent-test-mode`: `1` selects test mode; `0` or absent selects search mode; any other value (`true` and `false`
  included) MUST stop the agent at startup, naming the setting and never the value. *(SPEC: proposed L1-6, CFG-2, §3.1)*
- **FR-002**: The mode MUST NOT be a request field, a header, a session property or anything the goal or the model can
  set. A request that carries a field for it MUST be refused as an unknown field is today. The mode of a run MUST be
  fixed when the run starts. *(SPEC: proposed L1-6, SEC-63)*
- **FR-003**: The mode is hidden from callers and from the model: no answer, stream event, tool description, prompt or
  error that a caller sees MAY name it or the setting. It is not hidden from the operator: the SPEC, the deployment's
  parameter file, the run log and the agent's startup refusals state it. *(SPEC: proposed L1-6 Logs)*
- **FR-004**: In test mode the agent MUST behave exactly as before this feature: exactly `fetch_resource` and
  `check_budget` with their L1-3 descriptions, the L1-3 prompt (start at the configured seller's catalog), and fetches
  only to the configured seller's host. *(SPEC: L1-3, L1-6, L1-1 step 0)*

**Searching**

- **FR-005**: In search mode the agent MUST be offered exactly three tools: `fetch_resource`, `check_budget` and a
  read-only `search_resources`, whose only input is a query. No tool MAY sign, approve, reject or edit a policy, and
  the search tool MUST NOT fetch any resource, start a payment or reach L2 or L3. *(SPEC: proposed L1-3/L1-6,
  Constitution I)*
- **FR-006**: The search MUST return only resources that take x402 v2 with the `exact` scheme and the deployment's
  asset on the deployment's network, at most 10 per search, deduplicated by address. A listing that says it is another
  x402 version, or another kind of resource than an HTTP one (an MCP tool), MUST be dropped. *(SPEC: proposed L1-6, Constitution VII)*
- **FR-007**: Each result the model sees MUST have only these fields: address, host, price in atomic units (a decimal
  string), the same price in USD for display, network, a plain-text description of at most 300 characters, the
  declared inputs (name, type, required), and whether its host is on the seller list. No other text from a listing MAY
  reach the model, a step or the answer. *(SPEC: proposed §7, SEC-60)*
- **FR-008**: The query MUST be cut to 200 characters, sent to the discovery index only, and never logged. The prompt
  MUST tell the model to search for the kind of resource it needs, without names, addresses or other personal details
  from the goal. *(SPEC: proposed SEC-61, L1-6 Logs)*
- **FR-009**: A run MUST make at most 3 searches, and its searches together MUST take at most 5 seconds: each gets what
  is left of that time, and once it is spent a search MUST answer "search unavailable" without a request. A failed, slow
  or malformed answer
  MUST give the model a fixed "search unavailable" result without the index's own text. *(SPEC: proposed L1-6, SEC-64)*

**Fetching and paying**

- **FR-010**: In search mode the agent MUST fetch only the configured seller's host and the hosts on the seller list;
  every other address, whatever a listing says, MUST be refused before any request, as L1-1 step 0 does today. The
  list MUST be the one L2 pays against (CFG-4), not a second copy kept by hand, so the two can't differ.
  *(SPEC: L1-1 step 0, CFG-4, proposed SEC-62)*
- **FR-011**: A result whose host is not on the seller list MUST be marked so, MAY be named in the answer, and MUST NOT
  be fetched or paid. *(SPEC: proposed L1-6)*
- **FR-012**: The search mode prompt MUST say: search first; prefer results on the seller list; if the search is
  unavailable or nothing on the list fits, read the configured seller's catalog; if nothing fits the goal, buy nothing
  and say so; report results that aren't on the seller list without fetching them; prices are in atomic units; never
  retry a denied payment; report an escalation's authorizationId; end with the receipt list. *(SPEC: proposed L1-3/L1-6)*
- **FR-013**: L2's rules MUST stay as they are: R6 (`host_not_allowed`) still denies any host outside the mandate's or
  the person's policy's sellers, and nothing from a listing (its price, its text, the query) MAY reach L2 or the ledger.
  `purpose` stays audit text only. *(SPEC: L2-2, INV-5)*
- **FR-014**: A resource found by search MUST be bought exactly as any other: the seller's own 402 challenge, L2's
  decision, the paid retry, L3's check. The listing's price MUST NOT be used for any decision. *(SPEC: L1-1, INV-10)*

**The seller**

- **FR-015**: Each priced route of the seller MUST declare, once, beside its route and tier: a description of what it
  returns (at most 500 characters), the inputs it reads with their types, and an example answer. Its payment
  challenge MUST carry them as the discovery index expects, and its catalog MUST show the same description and inputs.
  *(SPEC: CP-1)*
- **FR-016**: Prices, tiers, bodies and statuses of the seller's routes MUST stay as they are. *(SPEC: CP-1, T-MON-01)*

**Operation**

- **FR-017**: The run log's run line MUST record the mode (`search` or `test`); a search step's line MUST record the
  number of results and whether the search was unavailable, never the query or a listing's text. *(SPEC: L1-6 Logs)*
- **FR-018**: A run's answer and stream MUST list each search as a step with its query and the results the model saw
  (FR-007). *(SPEC: L1-6 the stream, `docs/l1-hosted.openapi.yaml`)*
- **FR-019**: The discovery index's address MUST be a setting, defaulting to the public index on Base Sepolia. On a
  network with no public index (the local chain), search mode without that setting MUST stop the agent at startup,
  naming the setting and never a value. The local example settings MUST turn test mode on. *(SPEC: proposed CFG-2)*
- **FR-020**: The command-line agent (L1-3), the scripted plan (L1-4) and the local demo MUST be unchanged.
  *(SPEC: L1-3, L1-4, §13)*

### Non-Functional Requirements

- **NFR-001 (Security)**: Each check in FR-002, FR-007, FR-009, FR-010 and FR-011 MUST have a test that fails when the
  check is switched off, through a test-only switch, never a setting. *(SPEC: Constitution VIII)*
- **NFR-002 (Privacy)**: The only data that leaves for the discovery index is the cut query and the network filters.
  No token, user, session or goal goes there. *(SPEC: proposed SEC-61, Constitution V)*
- **NFR-003 (Availability)**: Payments, the portal and every run in test mode MUST work the same with the discovery
  index down. A run in search mode with it down MUST still complete through the catalog.
- **NFR-004 (Performance)**: A run's searches MUST add at most 5 seconds to it in all, however many it makes (FR-009);
  the deployment's smoke run MUST still finish
  within its 120 seconds in either mode.
- **NFR-005 (Testability)**: Every test MUST use a stand-in discovery index; no test reaches the real one.
- **NFR-006 (Regression)**: The local demo summary MUST stay unchanged (`spent on-chain: 0.006 USDC`,
  `hash chain ok=true`), and every existing hosted-agent test MUST pass in test mode. *(SPEC: §13, definition of done)*

### Key Entities

- **Agent mode**: `search` or `test`, one per deployment, fixed for each run. Recorded in the run log only.
- **Listing**: one resource in the discovery index: address, the payment options it accepts, its description, its
  declared inputs and outputs, when it was last updated. Untrusted.
- **Search result**: what the model sees of one listing (FR-007), with `onSellerList`.
- **Seller list**: unchanged (CFG-4); in search mode it is also the list of hosts the agent may fetch.
- **Discovery declaration**: a seller route's description, inputs and example answer, declared with its route and
  tier, shown in the catalog and carried in its payment challenge.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In search mode, for goals that a listed resource fits (weather for a city, a market brief), the agent's
  first purchase is the fitting resource in at least 9 of 10 runs.
- **SC-002**: For a goal that nothing fits ("flight prices from Lima to Trujillo" against the demo seller), the agent
  buys nothing and says so in at least 9 of 10 runs, in either mode.
- **SC-003**: For the goal "Get weather premium report for Trujillo", the agent buys the research report in none of 10
  runs, in either mode: it buys the city's weather or nothing, and says that no premium weather report is offered.
- **SC-004**: No run in any mode fetches or pays a host outside the seller list: zero such requests in the tests and
  in the dev environment's logs.
- **SC-005**: In test mode every existing hosted-agent test and the deployment's smoke run pass unchanged.
- **SC-006**: With the discovery index down, 100% of runs that a catalog item fits still complete through the catalog,
  and the searches add at most 5 seconds to a run in all.
- **SC-007**: The demo seller's paid routes appear in the public index within 15 minutes of their first payment through
  the hosted facilitator.
- **SC-008**: No answer, stream or model input in any run names the mode, and every run log line names it.

## Assumptions

- **The search covers x402 resources, not the web.** A general web search would mostly find pages that can't be paid
  with x402, would need a new API key, and would bring raw page text from anywhere into the model. The discovery index
  lists only x402 resources, with structured fields, and needs no key.
- **The discovery index is Coinbase's x402 Bazaar**, the index of the facilitator the seller already uses on Base
  Sepolia. Its search is public and covers testnet resources once they have settled through it. Its rules (a listing
  appears up to 15 minutes after its first settled payment and leaves after 30 days without one; listings are screened
  for instruction-like text) are Coinbase's, and this feature doesn't rely on the screening.
- **R6 stays.** The agent pays only sellers on the seller list. Paying a seller found by search that the operator never
  allowed (for example, by escalating it to a person) is out of scope: it would be a change to L2's policy and needs
  its own decision.
- **"Hidden" means hidden from callers and from the model**, not undocumented: the setting is in the SPEC, the
  deployment's parameter file and the run log, as every other setting is.
- **The flag is a deployment setting.** Switching it means deploying the agent again; a per-run switch would let any
  caller choose how the agent behaves.
- **The demo's seller list is the configured seller** (`seller.fabriciorojas.com` on the VPS). Other listed sellers
  are shown as found but not allowed.
- **Scope.** Only the hosted agent gets search mode. The CLI agent, the scripted plan, L2, L3 and the portal don't
  change, except that L2's seller list now also bounds what the hosted agent fetches.
- **SPEC and constitution.** This becomes SPEC §15 EXT-10 and a SPEC version. It amends the rule that the hosted agent
  offers only two tools (L1-3, L1-6, T-AGT-02 and `CLAUDE.md` hard rule 2), adds SEC-60..64, and needs a constitution
  amendment for L1's new outbound call to the public discovery index (no credential).
