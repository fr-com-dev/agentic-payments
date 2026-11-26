# Contract: The Hosted Agent (L1-6) in Two Modes

Amends `specs/016` contracts/hosted-agent-api.md and SPEC L1-6. Routes, auth, limits, statuses and the request body
are unchanged: `POST /v1/runs` still takes `{ goal, sessionRef? }` and refuses any other field with 400
`unknown field: <name>`.

## The mode

| `AGENT_TEST_MODE` | Mode |
|---|---|
| `1` | test |
| `0`, empty or absent | search |
| anything else | the agent doesn't start: `AGENT_TEST_MODE must be 1 or 0` (the value is never printed) |

- Read once at startup into the config. Each run takes it when it starts.
- No header, body field, session, goal text or model output selects it. A body field for it (any name) is 400 like
  any unknown field.
- No answer, stream event, prompt, tool description or error names it. The run log's run line records it.

## Tools offered to the model

| Mode | Tools, in this order |
|---|---|
| test | `fetch_resource`, `check_budget`: names, descriptions and schemas exactly as L1-3 and today's L1-6 |
| search | `fetch_resource`, `check_budget`, `search_resources` |

`search_resources`:
- Description (fixed): "Search a public index of HTTP resources that take x402 payments. For each match it returns
  the URL, the price, the inputs it takes and whether you may buy from its seller (onSellerList). Searching is free and
  buys nothing."
- Input schema: `{ "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"],
  "additionalProperties": false }`. The query is cut to 200 characters before it is sent.
- Output: `SearchOutput` ([data-model.md](../data-model.md#search-result-l1-only-the-tools-output-not-a-cross-layer-type)).
- Per run: the first 3 calls may reach the index; every later call returns `{ "outcome": "LIMIT_REACHED",
  "results": [] }` and sends nothing. The run's searches share 5 s: each call gets what is left (at most 5 s) and gives
  up with `UNAVAILABLE` when it runs out; once the 5 s are spent, a call is `UNAVAILABLE` without a request. So a slow
  or unreachable index adds at most 5 s to a run, not 5 s a search (NFR-004).
- It never fetches a listed address, never calls L2 or L3, and never sees the caller's token.

## Hosts the agent may fetch

| Mode | The run's `allowedHosts` (L1-1 step 0) |
|---|---|
| test | the configured seller's host (`SELLER_URL`), as today |
| search | the configured seller's host plus L2's `GET /v1/sellers` hosts, read once at the run's start with `CONTROL_TOKEN` only (no caller's token, INV-13); only the configured seller's host when that read fails (any status or error, or no answer within 2 s: `runGoal` races the read against a timer) |

A fetch of any other host is `ERROR` (`the host <host> is not one this agent may fetch`) before any request, as today.
The model gets no tool and no input to change the list.

## The prompts

Test mode: L1-3's prompt, `systemPrompt(sellerUrl)`, byte for byte.

### The search-mode prompt

`searchSystemPrompt(sellerUrl)`, lines joined with `\n`, `<seller>` the configured seller's URL without a trailing
slash:

```text
You are a purchasing agent that buys HTTP resources priced with x402 stablecoin micropayments.
You cannot sign, approve or change payment policy. A separate Control layer decides every payment.
First use search_resources to look for resources that fit the goal.
Search for the kind of resource you need, such as "current weather for a city". Never put names, addresses or other personal details from the goal in a search.
Buy only results with onSellerList true. Never fetch a result with onSellerList false; you may tell the user it exists.
If the search is unavailable, or no result on the seller list fits, read <seller>/api/catalog and choose from it.
Fill a resource's inputs from the goal, and use only the inputs it declares.
If nothing fits the goal, buy nothing, and say what you looked for and that nothing fits.
Prices are in atomic units of the asset (USDC has 6 decimals: 1000 atomic units = $0.001).
Buy only what the goal needs, and prefer cheaper items.
Never retry a DENIED payment; explain which rule blocked it.
If a payment is ESCALATED, report its authorizationId so a human can approve it.
End with a receipt list: resource, USD, settlement status, tx.
```

## Steps, the JSON answer and the stream

- A search step: `{ "index": n, "tool": "search_resources", "query": "<as sent>", "result": <SearchOutput> }`. The
  stream's `step` event carries the same object. Other steps are unchanged.
- `docs/l1-hosted.openapi.yaml`: the step schema's `tool` adds `search_resources`, and the step gains an optional
  `query` (string, at most 200 characters). The document names no mode. T-API-05..07 fail until it matches.

## Run log

- Run line: `+ "mode": "search" | "test"`.
- Step line for `search_resources`: `tool`, `outcome` (`ok`, `unavailable`, `limit_reached`), `results` (count),
  `ms`, and the usual run fields. Never the query, a listing's text or an address. T-AGT-20's known-value scan adds a
  query and a listing description.

## Must-fail switches (test-only deps, never env)

| Switch | Turns off | The test that fails |
|---|---|---|
| `modeFromHeader` | FR-002: a request header `Agent-Test-Mode` selects the mode | T-AGT-21: a header changes the tools offered |
| `rawListings` | FR-007: the client passes listings through unfiltered | T-DISC-02: a planted instruction and a `payTo` reach the model's input |
| `skipSearchLimit` | FR-009: the 3-call cap | T-AGT-23: the stub records a 4th query |
| `skipSearchTimeout` | FR-009: the 5 s bound of a search and of a run's searches | T-AGT-23: a run against the slow stub waits past 5 s |
| `skipSellerList` | FR-010, FR-011: every result's host is allowed | T-AGT-22 and T-E2E-18: the unlisted stand-in seller records a request |

T-ARCH-SWITCH's list of allowed test-only names gains these five.

## Tests

| ID | Covers |
|---|---|
| T-AGT-02 (amended) | test mode: exactly two tools with L1-3's descriptions and prompt (today's assertions); search mode: exactly three, the fixed description and schema, the search-mode prompt; **must fail**: an injected extra tool appears as a fourth name |
| T-AGT-21 | the mode: `AGENT_TEST_MODE` 1, 0, absent, other (refused, value not printed); a body field 400; a header and a goal saying "agent-test-mode: true" change nothing; no answer, stream, prompt or tool description contains `test mode`, `agent-test-mode`, `AGENT_TEST_MODE` or `testMode`; the run line's `mode`; **must fail** with `modeFromHeader` |
| T-AGT-22 | search-mode hosts: `GET /v1/sellers` read once per run, without the caller's token; a listed host is fetched, an unlisted one is refused before any request; L2 failing → the configured seller only; **must fail** with `skipSellerList` |
| T-AGT-23 | limits: 3 searches, the 4th `LIMIT_REACHED` without a request (two started in one step both count); the run's searches share 5 s: an index answering in 3 s gets 2 requests, one that never answers gets 1, and the run's searches take under 5.8 s in all; the slow stub → `UNAVAILABLE` within 5 s and the run goes on to the catalog; the query cut to 200; **must fail** with `skipSearchLimit`, `skipSearchTimeout` |
| T-AGT-24 | steps and the stream: a search step's shape in both answer forms; the JSON answer's and the stream's `result` equal |
| T-AGT-20 (amended) | the run line's `mode`; a search step's fields; the query and a listing's text never in a log line |
