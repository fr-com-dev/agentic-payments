# Contract: Settings (CFG-2, §3.1) and the VPS

## `env/l1-hosted.env`

| Variable | Values | Default | Rule |
|---|---|---|---|
| `AGENT_TEST_MODE` | `1`, `0` | `0` (search mode) | Any other value (`true` and `false` included) stops the agent at startup, naming the variable, never the value. |
| `DISCOVERY_URL` | an absolute URL | base-sepolia: `https://api.cdp.coinbase.com/platform/v2/x402/discovery/search`; local: none | `https:` outside local; on local, `http:` only to a loopback host. Read only in search mode. On the local network, search mode without it stops the agent at startup with `DISCOVERY_URL is required on the local network unless AGENT_TEST_MODE=1`. |

`env/l1-hosted.env.example` sets `AGENT_TEST_MODE=1` and shows `DISCOVERY_URL` commented out. The local stack's child
env (`scripts/demo-lib.ts`) and the VS Code runner set `AGENT_TEST_MODE=1` for the hosted agent (T-DEV-01).

No other process reads either variable. Neither is a secret.

### Upgrading an existing env file

An `env/l1-hosted.env` made before 021 has no `AGENT_TEST_MODE`, so the agent starts in search mode:

- **Locally:** `npm run agent:hosted` reads that file directly (not through the VS Code runner), so the agent refuses to
  start with the `DISCOVERY_URL` message above until the file gets `AGENT_TEST_MODE=1`.
- **On the VPS:** the agent's next restart is in search mode, against the public index. Set `AGENT_TEST_MODE` in that
  file before pulling 021, to `1` to keep today's behavior or `0` for the search demo.
- **In Azure:** nothing to do. `agent.testMode` is set in the parameter file and rule 27 fails without it.

`CLAUDE.md` (Gotchas), `docs/self-hosted/base-sepolia.md` and quickstart §2 say this too.

## Azure (`infra/`)

- `agent.testMode` (bool) in `agent` of every `infra/main.<env>.bicepparam`; `infra/main.dev.bicepparam` sets `true`.
- `modules/l1-apps.bicep` writes `AGENT_TEST_MODE` `'1'` or `'0'` on the agent's container only.
- `DISCOVERY_URL` is not set: the profile's default applies. `infra/` declares no egress rule (no network security
  group, firewall or user-defined route), so no network change is planned; the first search-mode run in Azure
  confirms the agent reaches the index (quickstart §3).
- T-IAC-01 rule 27: every parameter file sets `agent.testMode`; only the agent's container has `AGENT_TEST_MODE`,
  and its value is `'1'` or `'0'` from that parameter.

## The VPS (dev, by hand; `docs/self-hosted/base-sepolia.md`)

For the search demo with `seller.fabriciorojas.com` ([research R10](../research.md#r10-getting-the-demo-seller-listed)):

| File | Setting | Value |
|---|---|---|
| `env/l1-hosted.env` | `SELLER_URL` | `https://seller.fabriciorojas.com` |
| `env/l1-hosted.env` | `AGENT_TEST_MODE` | `0` for the search demo, `1` to go straight to the seller |
| `env/l2-control.env` | `ALLOWED_HOSTS` | the current host(s) plus `seller.fabriciorojas.com` |
| `env/l2-control.env` | `PLATFORM_SELLERS` | the current entry plus one for `seller.fabriciorojas.com` with the same payee |

Each person in the demo adds `seller.fabriciorojas.com` to their expense policy in the portal, or their purchases
there are denied by R6 (`host_not_allowed`), as designed.
