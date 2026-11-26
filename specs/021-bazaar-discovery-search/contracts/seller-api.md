# Contract: The Seller Describes Its Routes (CP-1)

Update SPEC CP-1 and `docs/seller.openapi.yaml` together (T-API-09..10). Prices, tiers, paths, bodies and statuses
don't change (T-MON-01).

## Declarations

```ts
@Get("/api/weather", { query: { city: { type: "string", required: true, about: "A city name, such as Lima or Trujillo.", example: "Lima" } } })
@PayPerUse({ price: usdc("0.001"), description: "current weather for a city", about: "…" })
weather(req: Request) { … }
```

- `@Get`'s `query` becomes an object of typed inputs (data-model.md). `advertisedPath` still gives
  `/api/weather?city=`.
- The paid tiers take `about` (1–500 characters, required). `@Free` doesn't.
- A declaration mistake (a paid route without `about`, an input with a bad name or type, an example of the wrong type)
  is refused while the seller is built, as today's mistakes are (`EndpointDeclarationError`).

## The four routes

| Route | Inputs | `about` |
|---|---|---|
| `/api/weather` | `city` (string, required, example `Lima`) | Current weather for one city: the temperature in °C and the sky (sunny, cloudy, rain or fog). Mock data for a demo: the same city always gets the same answer. |
| `/api/market-brief` | none | A daily brief on stablecoin markets: a headline and three short points. Mock data for a demo. Takes no input. |
| `/api/premium-report` | none | A fixed research report, "Agentic payments: three-layer control": its title and page count. It is not about any place or date, and takes no input. |
| `/api/dataset-export` | none | A bulk export of a mock dataset: its row count (one million rows). Takes no input. |

## The catalog

`GET /api/catalog` items gain `about` and `inputs` (data-model.md). Example item:

```json
{ "path": "/api/weather?city=", "priceAtomic": "1000", "description": "current weather for a city", "tier": "pay-per-use",
  "about": "Current weather for one city: …", "inputs": [{ "name": "city", "type": "string", "required": true }] }
```

## The payment challenge

Each priced route's route config (`sellerRoutes`) gains, from the declaration:

- `description`: the route's `about` (today the short label), which the challenge's `resource.description` carries;
- `serviceName`: `"x402 PoC demo seller"`;
- `extensions`: `declareDiscoveryExtension({ input: <the example values>, inputSchema: { properties: { <name>: { type, description: about } }, required: [...] }, output: { example: <the handler's answer to the example> } })`.

`sellerPaymentMiddleware` registers `bazaarResourceServerExtension` on the seller's `x402ResourceServer`. The `PAYMENT-REQUIRED` header of
each priced route then carries `extensions.bazaar`; the x402 client SDK copies it into the payment payload, and the
seller's facilitator receives it on settle. The local facilitator ignores it.

## Tests

| ID | Covers |
|---|---|
| T-MON-04 | each priced route's challenge carries `extensions.bazaar` that the SDK's `validateDiscoveryExtension` accepts; its example equals the handler's answer to the example inputs; the catalog's `about` and `inputs` equal the declaration; prices and tiers unchanged |
| T-MON-03 (amended) | a paid route without `about`, an `about` over 500 characters, a bad input name or type, and an example of the wrong type are refused while the seller is built (T-MON-02 stays the `usdc()` price test) |
| T-E2E-18 (part) | in the local on-chain run, the payment payload the local facilitator receives for the weather route carries `extensions.bazaar` |
| T-API-09..10 (amended) | the catalog schema's new fields and the challenge's `extensions` in `docs/seller.openapi.yaml` |
