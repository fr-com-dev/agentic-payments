# Data Model: The Hosted Agent Searches for x402 Resources

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

Nothing here is stored. The ledger gets no entry type and no store gains a file. Amounts are atomic-unit decimal
strings (Constitution VI).

## Agent mode (L1, configuration)

| Field | Type | Rule |
|---|---|---|
| `mode` | `"search"` \| `"test"` | From `AGENT_TEST_MODE` at startup: `1` → `test`; `0` or absent → `search`; anything else stops the agent (FR-001). One value per process; each run takes it when it starts (FR-002). |

Where it shows: the run log's run line (`mode`). Nowhere else: no request field, answer, stream event, prompt or tool
description (FR-003).

## Seller hosts (crosses L1 ← L2: `src/shared/contracts.ts`)

```ts
/** 021: the hosts any caller of the agent could be paid at (L2-5 GET /v1/sellers). */
export interface SellerHosts {
  /** `host[:port]`, lowercase, as `new URL(...).host` gives it; no duplicates; sorted. */
  hosts: string[];
}
```

- L2 builds it from the platform mandate's `allowedHosts` and, with user accounts on, the platform seller list's
  hosts. It changes only when L2 restarts with other configuration.
- L1 uses it, plus the configured seller's host, for the run's `allowedHosts` and each result's `onSellerList`. When
  the read fails, the run's set is the configured seller's host alone.

## Search result (L1 only: the tool's output, not a cross-layer type)

```ts
interface SearchResult {
  url: string;            // the listing's resource address (https, or http on loopback with the local network)
  host: string;           // new URL(url).host
  priceAtomic: string;    // the matching option's amount, ^[1-9][0-9]{0,30}$
  priceUsd: string;       // formatAtomic(priceAtomic, decimals), display only
  network: string;        // the profile's CAIP-2 (every kept result has it)
  about: string;          // plain text, control characters removed, whitespace collapsed, at most 300 characters
  inputs: { name: string; type: "string" | "number" | "integer" | "boolean"; required: boolean }[]; // at most 8
  onSellerList: boolean;  // host ∈ the run's seller hosts
}

interface SearchOutput {
  outcome: "OK" | "UNAVAILABLE" | "LIMIT_REACHED";
  results: SearchResult[]; // at most 10; on the seller list first, then the rest, each in the index's order
}
```

Validation from a listing (contracts/discovery-index.md): kept only when its address and one payment option pass;
deduplicated by `url`. A listing's `payTo`, `serviceName`, `tags`, `quality`, `iconUrl`, its inputs' descriptions and
every other field never reach a `SearchResult`.

## Run step (L1, answer and stream)

`RunStep` gains one optional field:

| Field | When | Value |
|---|---|---|
| `query` | `tool` is `search_resources` | the query as sent (cut to 200 characters) |

A search step is `{ index, tool: "search_resources", query, result: SearchOutput }`. Fetch and budget steps are
unchanged.

## Run log lines (L1)

| Line | New field | Value |
|---|---|---|
| run | `mode` | `"search"` or `"test"` |
| step (`search_resources`) | `outcome` | `ok`, `unavailable` or `limit_reached` |
| step (`search_resources`) | `results` | the number of results |

Never logged: the query, a listing's text, a result's address (as today no URL is logged).

## Discovery declaration (seller, `src/counterparty/`)

Each priced route declares, once:

| Part | Where | Rule |
|---|---|---|
| inputs | `@Get(path, { query: { <name>: { type, required, about, example } } })` | name `^[a-z][a-zA-Z0-9]{0,39}$`; type `string` \| `number` \| `integer` \| `boolean`; `about` ≤ 200 characters; `example` of that type. Replaces `query: string[]`. |
| `description` | the tier decorator | the short label, as today |
| `about` | the tier decorator (`@PayPerUse`, `@Premium`, `@Enterprise`) | what the route returns, 1–500 characters, plain text; required for a paid tier |
| example answer | computed | the handler's answer to the inputs' example values, when the seller is built |

The four routes' values are in [contracts/seller-api.md](contracts/seller-api.md#the-four-routes).

## Catalog item (seller → buyer)

`CatalogItem` and `CatalogBody.items[]` gain two fields; the others are unchanged:

| Field | Type | Value |
|---|---|---|
| `about` | string | the route's `about` |
| `inputs` | `{ name, type, required }[]` | from the route's declared inputs; `[]` for a route with none |

`path` keeps the query names (`/api/weather?city=`), so existing buyers read it as before.
