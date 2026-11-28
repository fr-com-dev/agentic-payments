# Quickstart: Checking the Search Tool and Test Mode

**Feature**: [spec.md](spec.md) | **Contracts**: [contracts/](contracts/)

## 1. Automated checks (every slice)

```bash
npm run typecheck
```

```bash
npx vitest run test/discovery.test.ts test/hosted-search.test.ts test/control-sellers.test.ts test/seller-monetization.test.ts
```

```bash
npm run check
```

Expected:
- T-DISC-01..03, T-AGT-21..24, T-SEL-01, T-MON-04, T-E2E-18 and the amended T-MON-03 pass; T-AGT-02 passes in both modes.
- Each must-fail switch makes its own test fail ([contracts/hosted-agent-api.md](contracts/hosted-agent-api.md#must-fail-switches-test-only-deps-never-env)).
- `demo:local` still prints `spent on-chain: 0.006 USDC` and `hash chain ok=true` (NFR-006).
- No test reaches the real index: with the network off, `npm test` gives the same result.

## 2. Test mode by hand, locally

The local chain has no public index, so search mode runs locally only in the tests (FR-019). Test mode is what the
local example sets. An `env/l1-hosted.env` copied before 021 lacks `AGENT_TEST_MODE`: add `AGENT_TEST_MODE=1`, or the
agent refuses to start with `DISCOVERY_URL is required on the local network unless AGENT_TEST_MODE=1`
([config.md](contracts/config.md#upgrading-an-existing-env-file)).

```bash
npm run stack:local -- --sign-in
```

```bash
npm run agent:hosted
```

```bash
npm run dev-token -- --service
```

Send a run with that token (`POST http://127.0.0.1:4024/v1/runs`, `{ "goal": "Get weather premium report for Trujillo" }`).

Expected: the steps start at `/api/catalog`; the catalog items now carry `about` and `inputs`; no step is a search;
the run log's run line says `"mode":"test"`; the answer names no mode. Then send the same body with an extra field
`"agentTestMode": false`: 400 `unknown field: agentTestMode`.

## 3. The demo on the VPS (operator)

Order (research R13): L2 first, then the seller, then the agent.

1. Update the checkout on the VPS and restart L2 with the settings of [contracts/config.md](contracts/config.md#the-vps-dev-by-hand-docsself-hostedbase-sepoliamd)
   (`ALLOWED_HOSTS` and `PLATFORM_SELLERS` gain `seller.fabriciorojas.com`). Check:
   `GET /v1/sellers` with `CONTROL_TOKEN` lists both hosts (the route takes no caller's token).
2. Restart the seller. Check: `GET https://seller.fabriciorojas.com/api/catalog` shows `about` and `inputs`; an unpaid
   `GET https://seller.fabriciorojas.com/api/weather?city=Lima` answers 402 whose decoded `PAYMENT-REQUIRED` has
   `extensions.bazaar`.
3. Optional: ask CDP whether the route is eligible (public, no key): `POST https://api.cdp.coinbase.com/platform/v2/x402/validate`
   with `{ "resource": "https://seller.fabriciorojas.com/api/weather?city=Lima", "method": "GET" }`. Expect
   `valid: true`.
4. Restart the agent with `SELLER_URL=https://seller.fabriciorojas.com` and `AGENT_TEST_MODE=1`. Run, as a person
   whose policy names `seller.fabriciorojas.com`: "Get today's weather for Lima and a short market brief". Expect both
   PAID and CONFIRMED: the first settlements through CDP at the public address.
5. Wait up to 15 minutes, then search the index directly:

   ```bash
   curl -s 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/search?query=weather%20for%20a%20city&network=eip155:84532&limit=20' | jq -r '.resources[].resource' | grep seller.fabriciorojas.com
   ```

   Expect `https://seller.fabriciorojas.com/api/weather?...` (and the market brief for a market query). The premium
   report and the dataset export are not listed (US4 scenario 2).
6. Restart the agent with `AGENT_TEST_MODE=0`. Run "Get today's weather for Trujillo". Expect: a search step first,
   whose results put `seller.fabriciorojas.com` first with `onSellerList: true` and other parties' weather APIs after
   it with `false`; one purchase, `https://seller.fabriciorojas.com/api/weather?city=Trujillo`, PAID (13 °C, cloudy);
   no request to any other host; the run line says `"mode":"search"`.

## 4. Model behavior (by hand, SC-001..003)

Ten runs of each goal, in the mode shown, through the plugin or `POST /v1/runs`. Record each run's purchases from the
answer's `steps`.

| Goal | Mode | Pass |
|---|---|---|
| "Get today's weather for Trujillo" | search | the first purchase is the seller's weather with `city=Trujillo` in at least 9 of 10 (SC-001) |
| "Flight prices from Lima to Trujillo" | search and test | nothing bought, and the answer says nothing fits, in at least 9 of 10 each (SC-002) |
| "Get weather premium report for Trujillo" | search and test | the research report bought in none of 10 each; the weather or nothing, and the answer says no premium weather report is offered (SC-003) |

A miss is a prompt or description problem, never a reason to loosen a rule.

## 5. Azure

`infra/main.dev.bicepparam` sets `agent.testMode: true`, so the pipeline's smoke run keeps its fixed path. To try
search mode there: set it to `false`, deploy L1 (`deploy-l1.yml`), and confirm the smoke job still passes within its
120 s (NFR-004) and that a run's first step is a search that answers `OK` (the agent reaches the index from Azure).
