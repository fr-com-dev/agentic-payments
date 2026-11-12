# x402 agent payments with three-layer separation

A Claude agent buys HTTP resources with x402 (protocol v2, scheme `exact`, EIP-3009 USDC) **without holding payment authority**. Payment authority is split across three processes:

| Layer | Folder | Role | Port |
|---|---|---|---|
| L1 Intent | `src/layer1-intent/`, `src/main.ts` | Agent and 402 transport loop. No keys. | — |
| L2 Control | `src/layer2-control/` | Pure policy engine, sole signer, hash-chained ledger, human approvals | 4020 (loopback) |
| L3 Settlement | `src/layer3-settlement/` | Read-only on-chain verification, reconciles into L2 | 4023 (loopback) |
| Counterparty | `src/counterparty/`, `scripts/facilitator.ts` | Seller API and local facilitator | 4021, 4022 |
| Portal (optional) | `src/portal/`, `src/portal-main.ts`, `web/portal/` | Web portal for user accounts: profile, wallet and expense policies. No keys, decides nothing. | 4025 |

`SPEC.md` (v1.10) is normative. Feature specs, plans and task lists live under `specs/` (spec-kit). Agent guidance is in `CLAUDE.md`.

## Diagrams

Interactive diagrams live in `docs/diagrams/`. Each is a self-contained HTML file with pan/zoom, search and guided views. GitHub shows HTML as source, so open them locally in a browser. The `.json` file next to each one is its [archify](https://github.com/tt-a1i/archify) source.

| Diagram | Shows |
|---|---|
| [Architecture](docs/diagrams/x402-architecture.html) | The three layers, the seller, the portal for user accounts, the CDP facilitator on Base Sepolia, the local-network path and the payment-authority boundary. Each box links to its source files. |
| [Paid fetch](docs/diagrams/x402-paid-fetch.html) | 402 challenge, L2 authorization, signed retry, CDP verify/settle, then L3 on-chain verification and reconcile. |
| [Escalation and approval](docs/diagrams/x402-approval.html) | A payment above 0.02 USDC escalates, an operator approves it, and the agent retries in the same session. |

The L2 HTTP API (authorize, budget, reconcile, approvals, rejections, escalations, ledger verify) is described in OpenAPI 3.1 at [`docs/l2-control.openapi.yaml`](docs/l2-control.openapi.yaml). Open it in any OpenAPI viewer, such as Swagger Editor or the VS Code OpenAPI extensions. `test/openapi.test.ts` keeps it in sync with the service.

To browse it in Swagger UI, start L2 with `API_DOCS=1` and open http://127.0.0.1:4020/docs. Click **Authorize** and enter the token for the routes you want to try: `CONTROL_TOKEN`, `SETTLEMENT_TOKEN` or `OPERATOR_TOKEN` from L2's env file. "Try it out" calls that same L2, so `POST` requests really sign, approve or reject and append to the ledger. The docs routes take no token and are off by default; Swagger UI is served from L2 itself, not a CDN.

```bash
API_DOCS=1 ENV_FILE=env/l2-control.base-sepolia.env npm run l2:control
```

The hosted agent's API (`POST /v1/runs` and the health routes) is described the same way, in [`docs/l1-hosted.openapi.yaml`](docs/l1-hosted.openapi.yaml), and `test/openapi-hosted.test.ts` keeps it in sync. To browse it in Swagger UI, start the agent with `API_DOCS=1` and open http://127.0.0.1:4024/docs. Click **Authorize** and paste a bearer token: locally `npm run dev-token -- --subject alice`, or for Entra `az account get-access-token --scope api://app-l1-eastus2-dev/user_impersonation --query accessToken -o tsv`. "Try it out" runs a real goal, so it calls the model and can pay. The Azure deployment never sets `API_DOCS`.

```bash
API_DOCS=1 npm run agent:hosted
```

The seller monetizes with freemium discovery plus pay-per-use tiers: each endpoint in `src/counterparty/seller-api.ts` declares its route and tier with decorators (`@Get` with `@Free`, `@PayPerUse`, `@Premium` or `@Enterprise`), and the catalog lists each priced route's `tier`. The seller's API (the free catalog and the four priced routes, with their x402 headers) is in [`docs/seller.openapi.yaml`](docs/seller.openapi.yaml), kept in sync with the seller and its catalog prices by `test/openapi-seller.test.ts`. With `API_DOCS=1` the seller serves it in Swagger UI at http://127.0.0.1:4021/docs. A browser can't sign an x402 payment, so "Try it out" on a priced route shows its 402 challenge: decode the `PAYMENT-REQUIRED` header (base64 JSON) to see the price and `payTo`. The Azure deployment never sets `API_DOCS`.

```bash
API_DOCS=1 npm run seller
```

The portal's API (`/api/me`, the profile, the wallet, cards, policies and the account) is in [`docs/portal.openapi.yaml`](docs/portal.openapi.yaml), kept in sync by `test/openapi-portal.test.ts`. With `API_DOCS=1` the portal serves it in Swagger UI at http://127.0.0.1:4025/docs; paste a token from `npm run -s dev-token -- --subject alice --portal`.

## Quick start

```bash
npm install                 # not `npm ci` (ganache lockfile quirk)
npm run typecheck
npm test
npm run demo:local          # six processes; prints the summary below and exits 0
```

The demo starts the local chain, facilitator, seller, L2, L3 and the scripted agent, then prints:

```text
==== demo summary ====
network:            local
session:            sess_xxxxxxxx
outcomes:           FREE, PAID, PAID, ESCALATED, DENIED, DENIED
spent on-chain: 0.006 USDC
budget:             spentOrReserved=6000 remaining=94000 (atomic)
hash chain ok=true entries=<n>
======================
```

`spent on-chain: 0.006 USDC` and `hash chain ok=true` are the contract strings. Exit codes: `0` baseline matched, `2` baseline mismatch, `1` busy port, readiness timeout, child crash or interrupt. `npm run demo:local -- --llm` runs the Claude agent instead (needs `ANTHROPIC_API_KEY` in `env/l1-agent.env`; the baseline is not asserted).

Each process reads exactly one env file, `env/<role>.env` (templates in `env/*.env.example`). The demo falls back to the templates when a file is missing and, on the local network only, derives the dev payer key (account #2) for L2 and the facilitator key (#1) for the facilitator from the fixed ganache mnemonic. Never create a shared `.env` with `PAYER_PRIVATE_KEY`: the agent refuses to start if it can see that key.

### Debugging in VS Code

`.vscode/launch.json` debugs, or runs with Ctrl+F5, every process, always in local mode: L1 (the CLI agent, scripted or with Claude, and the hosted agent), L2, L3, the seller, the facilitator and the operator's commands. Each configuration starts through `scripts/vscode-local.ts`. It gives the process its own env file and, on the local network, only its own dev key, exactly as `stack:local` does; `NETWORK=local` is forced whatever the file says. The debugger attaches to the process, so breakpoints in `src/` and `scripts/` work as usual.

Start any L1 or operator configuration. Its task `local: stack` makes the local stack answer first: it reuses whatever part already runs and starts the rest (the chain, facilitator, seller, L2 and L3) in that task, without the debugger. To debug the stack's services as well, start the compound **Local stack** first; its task `local: chain` starts or reuses the chain, and L1 then reuses those services. The seller and L2 serve Swagger UI at `/docs`.

| Configuration | What it runs |
|---|---|
| Local stack (compound) | the facilitator, seller, L2 and L3, debugged (also each alone: Facilitator, Seller, L2 control, L3 verifier) |
| L1 agent: scripted plan | the deterministic L1-4 plan: FREE, PAID, PAID, ESCALATED, DENIED, DENIED |
| L1 agent: Claude, your goal | the Claude agent with a goal you type (needs `ANTHROPIC_API_KEY` in `env/l1-agent.env`) |
| L1 hosted agent | the hosted service on `:4024` with Swagger UI (needs `ANTHROPIC_API_KEY` in `env/l1-hosted.env`; get a token with task `local: dev token`) |
| Portal | the web portal on `:4025` with Swagger UI. Its task `local: stack: users` starts the stack with user accounts on in L2 (stop `local: stack` first if it runs). Build the web app with task `build: web`, and sign in with a token from task `local: portal token` |
| Operator: watch escalations, approve, reject, ledger-verify | the operator's commands; approve and reject ask for the `authorizationId` |

Tasks `local: stop stack` and `local: stop chain` stop what `local: stack` and `local: chain` started; otherwise they keep running for the next session. To debug a service that `local: stack` started, stop that task first: the runner refuses to start a second process on a taken port. **Vitest: current file** debugs the open test file; stop the local stack and chain first, because the e2e suites use the same ports.

### Human approval

A payment above the auto-approve limit (default $0.02) is escalated. The agent reports its `authorizationId`. The escalation ends exactly once, and nothing is ever reversed:

- **Approved.** The operator approves it, and the agent retries the purchase in the same session. The approval is single-use and expires after 600 s, so an escalation pays at most once. Approving it again returns the same approval.
- **Denied.** The operator rejects it, optionally with a reason. Every later request for that resource in that session is refused with `human_rejected`, at any price.
- **Expired.** Nobody decides within 5 minutes. The next request for the same purchase starts a new escalation.

```bash
npm run approve -- <authorizationId> [approver]
npm run reject -- <authorizationId> [operator] [reason]
npm run escalations -- --watch    # lists pending escalations, then shows each new one and each outcome
```

While an escalation is pending, a repeat of the same purchase returns the same `authorizationId`. An approval never overrides a DENY rule. A rejection's reason is shown to the operator only, never to the agent. For a step-by-step run on Base Sepolia, see [Approving an escalated payment](#approving-an-escalated-payment).

#### From the approver's phone (backchannel approval, optional)

With backchannel approval on (`CIBA_APPROVAL=1` in L2's env file, SPEC L2-7), L2 also asks one configured approver directly: an OpenID CIBA request to an Auth0 tenant, delivered as a Guardian push. The phone shows the amount in USDC, the payee, the resource and a reference code, such as `Pay_0.05_USDC_to_0x95Ac..f057_for_premium-report_#3f9c2a1b`. The reference code is the start of the escalation's `authorizationId`.

- **Within 2 minutes**, the agent's same request goes on to pay after an approval, or is refused with `human_rejected` after a refusal.
- **Later**, the approval pays on the agent's next request for the purchase.
- **L2 checks the answer** before it counts: issuer, signature, approver, and the exact payment, field for field. Anything else approves nothing.
- **The operator path keeps working** whatever happens on the phone, and the first decision recorded wins. `npm run escalations -- --watch` shows each request's state and who decided, through which channel.
- **Automated checks never ask the approver**: the scripted regression is operator-only, there are at most 10 requests per hour, and repeats of a pending purchase reuse its escalation.

The Auth0 tenant is Terraform in [`auth0/`](auth0/README.md), applied by its own pipeline, `provision-auth0.yml`. Its outputs are the env values and the `ciba` object for Azure. The steps and a live check are in [specs/012 quickstart](specs/012-ciba-escalation-approval/quickstart.md). It is off by default, and the local demo never uses it.

## User accounts and the portal (optional)

With user accounts on (`USER_ACCOUNTS=1` in L2's env file, SPEC L2-8), each person who may start agent runs sets up their own spending in a web portal:

- **Profile.** A name and a contact email, kept by the portal only. L2 knows a person as an opaque `userId`.
- **Wallet.** One crypto account per person on the test network. L2 derives it from one mnemonic and is the only process that can sign with it; nobody ever sees a key, and nothing in the portal moves funds out. Cards can be registered at a card vault (Stripe, test mode) for later; an agent can't pay with a card.
- **Expense policies.** Where the agent may pay (sellers from the operator's list), how much (without asking, per payment, per run, per day) and how (payments per minute, an end date). The operator's platform limits (`config/platform.json`) bound every policy, and one daily ceiling bounds each person across all their policies.

A run started by a person through the hosted agent pays from that person's account under that person's policy. A person who has not finished setting up, or disabled their account, is denied; they never fall back to the platform account. A system identity, the scripted agent and `demo:local` use the platform account, as before. Raising a limit, adding a seller, resuming a policy or enabling an account asks the person to sign in again if their last sign-in is older than 15 minutes.

Locally, in three terminals:

```bash
npm run stack:local -- --users     # the stack, with user accounts on in L2
npm run -s dev-token -- --subject alice --portal   # a sign-in token to paste into the portal (the first call creates the local dev issuer)
npm run build:web && npm run portal   # the portal on http://127.0.0.1:4025
```

People sign in with Auth0 where it is deployed (SPEC v1.12); locally the dev issuer stands in for it, and the "sign-in" is the pasted token. Then follow the three steps on screen. `npm run fund-user -- <address> 1` mints 1 test USDC to the new account. To pay as that person, start `npm run agent:hosted` and send a run with an agent token (`npm run -s dev-token -- --subject alice`, without `--portal`): the two services refuse each other's tokens. The full walk-through, the isolation checks, cards and Azure are in [specs/013 quickstart](specs/013-l2-portal-onboarding/quickstart.md). It is off by default, and the local demo never uses it.

## Base Sepolia

Base Sepolia uses Circle's test USDC. No local chain or facilitator runs.

The seller verifies and settles through the **Coinbase Developer Platform (CDP) x402 facilitator** (`https://api.cdp.coinbase.com/platform/v2/x402`) by default. It pays gas, so the payer needs test USDC only. Every request is authenticated with a short-lived JWT signed by your CDP API key. The key goes in the seller's env file and nowhere else (SPEC §3.3, rule A8).

> **Upgrading from v1.1:** an existing Base Sepolia setup without a CDP key now stops at seller startup. Either add the key below, or set `FACILITATOR=public` to keep using `https://x402.org/facilitator`.

1. Create a **Secret API key** at <https://cdp.coinbase.com>, in a project used only by this seller, with the narrowest permissions CDP offers for x402. Don't use a key that controls a funded CDP wallet. Ed25519 keys are recommended. EC keys work as PKCS#8 or SEC1 PEM.
   Create it in the **production** (Live) environment. A **Sandbox** key is rejected with 401 (keys are environment-scoped), and the CDP Sandbox has no x402 facilitator and no blockchain activity. Production still settles on Base Sepolia with test USDC.
2. Fund the payer address with test USDC at <https://faucet.circle.com>.
3. Fill one env file per process. Off the local network every bearer token must be set; there are no dev defaults.
   - `env/seller.base-sepolia.env`: `NETWORK=base-sepolia`, `SELLER_PAY_TO`, `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`. Quote a PEM key; real newlines or `\n` both work.
   - `env/l2-control.base-sepolia.env`: the payer key, `ALLOWED_PAYEES` (including `SELLER_PAY_TO`), `ALLOWED_HOSTS=127.0.0.1:4021`, and all tokens.
   - `env/l3-verifier.base-sepolia.env` and `env/l1-agent.base-sepolia.env` (`SELLER_URL=http://127.0.0.1:4021`).
   - `env/operator.base-sepolia.env`: `CONTROL_URL=http://127.0.0.1:4020` and the `OPERATOR_TOKEN` that L2 verifies. It is needed only to approve escalated payments.
4. Run the opt-in live acceptance run (T-E2E-06). It is not part of `npm run check`:

```bash
npm run demo:base-sepolia
```

It refuses to start (exit 2) unless the seller resolves to `FACILITATOR=cdp` with both CDP values set, and the `SELLER_URL`/`ALLOWED_HOSTS`/`ALLOWED_PAYEES` layout above holds. A passing run ends with:

```text
outcomes:           FREE, PAID, PAID, ESCALATED, DENIED, DENIED
spent on-chain: 0.006 USDC
budget:             spentOrReserved=6000 remaining=94000 (atomic)
hash chain ok=true entries=<n>
settlements:        2 CONFIRMED
payer gas spent:    0 wei
secret scan:        clean
```

Or run the processes yourself, one terminal each, with `ENV_FILE=env/<role>.base-sepolia.env`:

```bash
npm run seller
npm run l2:control
npm run l3:verifier
npm run agent -- "<goal>"
```

The seller logs which facilitator it uses, for example `facilitator=cdp host=api.cdp.coinbase.com key=…abcd`. Misconfigurations exit 1 with a fixed message that never echoes the secret.

### Approving an escalated payment

`/api/premium-report` costs 0.05 USDC, above the 0.02 USDC auto-approve limit in `config/mandate.json`, so L2 escalates it instead of paying. An approval applies to one session and one resource. `demo:base-sepolia` stops L2 when it finishes and starts a new session each run, so run the processes yourself with a fixed `SESSION_ID`:

1. Start the seller, L2 and L3 as shown above. Optionally, watch escalations in another terminal: `ENV_FILE=env/operator.base-sepolia.env npm run escalations -- --watch`.
2. Run the agent with a session ID you choose. Step 4 is escalated and prints its `authorizationId`:

   ```bash
   SESSION_ID=sess_approve1 ENV_FILE=env/l1-agent.base-sepolia.env npm run agent:scripted
   # 4. ESCALATED http://127.0.0.1:4021/api/premium-report rules=human_approval_required authorizationId=auth_…
   ```

3. Within 5 minutes (escalations expire after 300 s), approve it as the operator:

   ```bash
   ENV_FILE=env/operator.base-sepolia.env npm run approve -- auth_… <approver>
   # {"ok":true,"approvalId":"apr_…","expiresAt":"…"}
   ```

   Or reject it instead. The next run's step 4 is then `DENIED … rules=human_rejected` for this session:

   ```bash
   ENV_FILE=env/operator.base-sepolia.env npm run reject -- auth_… <operator> <reason…>
   # {"ok":true,"rejectionId":"rej_…","rejectedAt":"…","alreadyRejected":false}
   ```

4. Within 600 s, run the agent again with the same `SESSION_ID`. Step 4 is now `PAID … settlement=CONFIRMED`. The scripted plan also buys the weather and the market brief again, so the session spends 0.062 of its 0.1 USDC budget.

The ledger shows `ESCALATED`, then `HUMAN_APPROVAL` with the `approvalId`, then an `AUTHORIZED` entry whose `approvalRef` points to that approval. Once used, the approval is spent, so a third run escalates again. An approval lifts only `human_approval_required`. It never overrides a refusal such as `hard_cap_exceeded` on `/api/dataset-export`.

To buy only the report instead of repeating the plan, use the Claude agent in the same session: `SESSION_ID=sess_approve1 ENV_FILE=env/l1-agent.base-sepolia.env npm run agent -- "buy the premium report"`. It needs `ANTHROPIC_API_KEY` in `env/l1-agent.base-sepolia.env`.

Facilitator failures reach the agent in two ways:
- Before a challenge, priced routes answer 503 `{"error":"facilitator <category>","category":…}`. The category is `unavailable`, `authentication`, `rate-limited` or `unsupported`.
- During a paid retry, the seller answers 502.

A CDP JWT is valid for 120 s, so a skewed clock on the seller host shows up as `authentication`.

## Hosted agent service (Azure)

The agent can also run as an HTTP service (SPEC L1-6, `specs/011`): `POST /v1/runs` takes a goal from a requester with a token: a person's from the sign-in tenant (Auth0) with the permission `agent:run`, or a system identity's from Entra ID with the `Agent.Run` role. It uses the same two tools, prompt and limits as the command-line agent, and gains no payment authority:
- it refuses to start if it can see the payer key;
- it never calls operator routes;
- it never forwards the requester's token to L2 or L3.

Sessions are bound to their requester by a signed `sessionRef`, so a requester can continue a session after an operator approves an escalation.

Locally, against the local stack:

```bash
npm run stack:local                                 # terminal 1: chain, facilitator, seller, L2, L3
cp env/l1-hosted.env.example env/l1-hosted.env     # set ANTHROPIC_API_KEY and SESSION_REF_SECRET (openssl rand -hex 32)
npm run agent:hosted                                # 127.0.0.1:4024
TOKEN=$(npm run -s dev-token -- --subject alice)    # local dev issuer, NETWORK=local only
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"goal":"Get the weather for Lima"}' http://127.0.0.1:4024/v1/runs | jq '.status, [.steps[].result.outcome]'
```

To run the agent's container image instead, see [quickstart §3](specs/011-l1-hosted-agent-azure/quickstart.md) (`stack:local -- --docker`).

**Images**: each unit has its own image, built from `docker/l1-agent.Dockerfile`, `docker/l2-control.Dockerfile`, `docker/l3-verifier.Dockerfile` or `docker/operator.Dockerfile` (the operator job: only the operator scripts). The seller's comes from the root `Dockerfile`. Each image holds only its own unit's code and the packages that code imports, so only the L2 image contains the signer. `scripts/image-closure.ts` works this out from the import graph and fails the build if an image would pick up another unit's file.

**Azure layout** (`infra/`, Bicep):
- One Container Apps environment holds the agent (public ingress), L2 and L3. L2 and L3 have internal-only ingress through a loopback proxy sidecar, so they still bind 127.0.0.1.
- Each runtime unit has its own managed identity and Key Vault. The payer key is readable only by L2's identity.
- The ledger lives on an NFS share. L2 holds a lock on it (L2-6), so only one L2 writes during a revision update.
- The sellers run in a separate environment.
- Every resource is named `{type}-{app}-{location}-{env}`, such as `ca-l1-eastus2-dev`; the parameter files' `names` hold them all. `infra/` has two scripts only: `infra/github-setup.sh` and `infra/cleanup.sh`, which deletes all of an environment (`--dry-run` first).
- Azure is provisioned by Bicep only. `infra/pre-deploy.bicep` makes the resource group, the Entra app registrations, the operators' group and the deploy app's roles; an administrator deploys it by hand. `infra/main.bicep` makes everything in the resource group, the Claude model deployment included.
- Every value is in a parameter file: `infra/pre-deploy.<env>.bicepparam` and `infra/main.<env>.bicepparam`, the tenant, subscription and resource group included. Each template refuses to run anywhere else.
- People sign in with Auth0 (the tenant in `auth0/`, Terraform): a person with the role `x402-user` gets a token with `npm run -s user-token`, the tenant's device flow. System identities, the deploy pipeline included, use Entra ID (the API app `app-l1-<location>-<env>`, role `Agent.Run`); an Entra token never names a user.

**Deployment**: one GitHub Actions pipeline per unit, each run by hand or on its own tag, one at a time:

| Pipeline | Tag | Deploys |
|---|---|---|
| `deploy-infra.yml` | `deploy-infra-*` | the platform: network, logs, identities, registry, vaults, storage, Foundry, the environments |
| `deploy-l1.yml` | `deploy-l1-*` | `x402-l1-agent`: the agent and the regression job |
| `deploy-l2.yml` | `deploy-l2-*` | `x402-l2-control`: the control service |
| `deploy-l3.yml` | `deploy-l3-*` | `x402-l3-verifier`: the verifier |
| `deploy-operator.yml` | `deploy-operator-*` | `x402-operator`: the operator job |
| `deploy-portal.yml` | `deploy-portal-*` | `x402-portal`: the web portal for user accounts (optional; [specs/013 quickstart §6](specs/013-l2-portal-onboarding/quickstart.md)) |
| `deploy-seller.yml` | `deploy-seller-*` | `x402-seller`: the seller and its alias |

All seven call the same steps, `.github/workflows/deploy.yml`, with their unit. A run signs in with OIDC as the deploy app, again in each step that calls Azure (GitHub's token is valid for 5 minutes), and reads its target from `infra/main.<env>.bicepparam`, not from GitHub secrets. It builds the unit's image, then previews and deploys `infra/main.bicep` with `UNIT` set, which deploys only that unit and leaves the others as they are. It records the image as `last-good` only after these all pass:
- the infrastructure rules (T-IAC-01);
- a secret check on the image;
- the L1-4 baseline in the cloud (`--check-baseline`), through every unit;
- the chain check (`ledger-verify`);
- a hosted smoke run;
- a log secret scan.

L1's run then moves the agent's traffic to the new revision, by deploying `main.bicep` again. A failure redeploys that unit's `last-good`. The platform has no image: its run checks the units through the new platform and is fixed forward. On a new environment, run the pipelines in order: infra, seller, L3, operator, L2, then L1. Every pipeline but L1's starts with `first-deployment`, which skips the checks through units that aren't there yet ([quickstart §4](specs/011-l1-hosted-agent-azure/quickstart.md)).

The first deployment, vault seeding and the operator job are in `specs/011-l1-hosted-agent-azure/quickstart.md`.

## Definition of done

| # | Gate | Command / check | Pass condition |
|---|---|---|---|
| G1 | Types | `npm run typecheck` | 0 errors |
| G2 | Tests | `npm test` | all suites green, including `architecture` |
| G3 | Baseline | `npm run demo:local` | exit 0, with `spent on-chain: 0.006 USDC` and `hash chain ok=true` |
| G4 | Spec sync | review | a behavior or contract change updates SPEC.md in the same change; a plan or price change updates §8.1 L1-4, §12 and this README |
| G5 | Coverage | review | every new rule, endpoint or contract field has a test whose name cites its ID |
| G6 | Safety proof | review | a new safety mechanism has a test shown to fail without it. Example: T-E2E-04 runs with `signerLatencyMs: 25`; without the authorize mutex 15/15 concurrent intents are AUTHORIZED, with it exactly 10/15 |
| G7 | Traceability | review | commit message cites requirement IDs |

`npm run check` runs G1–G3 in one command.

## Build order (M0–M7)

A milestone must pass its exit check before the next one starts.

| M | Deliverables | Owning features | Exit check | Pass |
|---|---|---|---|---|
| M0 | `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` | 008 | `npm run typecheck` | passes on the scaffold |
| M1 | `shared/contracts.ts`, `shared/config.ts`, architecture test | 001, 006, 007 | `npx vitest run test/architecture.test.ts` | T-ARCH-* green |
| M2 | `MockUSDC.sol`, `local-chain-lib.ts` | 006 | `npm run local:chain` | deployed, payer holds 10 USDC |
| M3 | seller and facilitator | 006 | unpaid `GET /api/weather?city=Lima` (006 T013 in `test/counterparty.test.ts`) | 402, `PAYMENT-REQUIRED` decodes via the SDK |
| M4 | L2: mandate, policy, ledger, signer, service, approvals | 002, 003, 004 | `npx vitest run test/policy.test.ts test/ledger.test.ts` | T-POL-*, T-LED-* green |
| M5 | L3: verifier, service | 005 | `npx vitest run test/e2e.local.test.ts -t "T-E2E-03"` | green |
| M6 | L1: orchestrator, adapters, scripted agent, `main.ts` | 001 | `npx vitest run test/e2e.local.test.ts -t "T-E2E-01\|T-E2E-02\|T-E2E-04\|T-E2E-05"` | green |
| M7 | Claude agent + T-AGT-01, `demo-local.ts`, `approve.ts`, README | 001, 004, 008 | `npx vitest run test/agent.test.ts && npm run demo:local` | green, and G3 passes |

## Tests

| File | Covers |
|---|---|
| `test/vscode-local.test.ts` | T-DEV-01..03: every VS Code configuration runs locally through the runner and resolves its role, tasks and inputs; each process gets its own env file and local key, NETWORK=local, and nothing else from VS Code but the debugger's attach hook; `local: stack` reuses, waits for or starts each stack process |
| `test/architecture.test.ts` | INV-1..4 and rules A1–A12 (static import and identifier scan), env templates |
| `test/users.test.ts`, `test/user-id.test.ts` | T-USR-01..12: user accounts in L2: the portal routes, role isolation, ownership, step-up, the keyring, policy validation, the effective mandate, decisions per user and isolation between users, with their must-fail proofs |
| `test/portal.test.ts`, `test/card-vault.test.ts` | T-PRT-01..09 and T-CARD-01..06: the portal's access rules, profile, wallet, policies, headers and log; cards against a stand-in vault |
| `test/openapi-portal.test.ts` | T-API-12..14: `docs/portal.openapi.yaml` matches the portal's routes, auth, statuses and response shapes; T-API-15: its Swagger UI routes |
| `web/portal/test/` | T-WEB-01..08: the web app in jsdom with a fake API: routing, forms, exact money, the policy summary, step-up, version conflicts, cards, text never rendered as HTML, an accessibility pass |
| `test/auth.test.ts` | per-role bearer guard `requireRole` (INV-13), token resolution, `loadEnv` |
| `test/policy.test.ts` | mandate, T-POL-01..15, signer, authorize/budget API, approvals, rejections and escalation reads in-process, operator CLIs |
| `test/ledger.test.ts` | T-LED-01..03, committed spend, reconcile, approvals lookup |
| `test/escalations.test.ts` | T-LED-04 escalation lifecycle: state, expiry sweep, lapse, rejection and pending lookups, operator views |
| `test/verifier.test.ts`, `test/settlement-service.test.ts` | L3 verification, finality, reconcile push, PENDING re-checks, T-AUTH-02 |
| `test/counterparty.test.ts` | seller, facilitator, MockUSDC, network profiles |
| `test/agent.test.ts` | L1 orchestrator, port adapters, T-AGT-01, scripted plan, key refusal |
| `test/e2e.local.test.ts` | T-E2E-01..05, T-E2E-07 (operator reject) and T-E2E-08 (expiry) on the in-process harness (`test/helpers/harness.ts`) |
| `test/demo.local.test.ts` | the real six-process demo, port preflight, process-group shutdown |
| `test/hosted-agent.test.ts`, `test/hosted-access.test.ts`, `test/hosted-sessions.test.ts`, `test/hosted-run.test.ts` | T-AGT-02..05: the hosted service's exact two tools, requester access and limits, session binding, run semantics and log redaction |
| `test/ledger-lock.test.ts` | T-LED-05: one ledger writer across processes (L2-6) |
| `test/infra.test.ts` | T-IAC-01: the compiled `main.bicep` and `pre-deploy.bicep` keep identities, secrets and ingress per the Azure matrix, take every name from the parameter files' `names` (each one the standard name), set up the Entra apps and the deploy app's roles, and take every value from their parameter files (needs `BICEP_PATH`) |
| `test/images.test.ts` | T-IMG-01: each image holds only its own unit's code and packages (only L2's has the signer) |
| `test/deploy-workflow.test.ts` | T-E2E-AZ: one pipeline per unit, each calling `deploy.yml` with its unit in one concurrency group; `deploy.yml`'s OIDC sign-in from the parameter file, no GitHub secret, Bicep-only provisioning (also in `infra/*.sh`), gates, skips and the unit's rollback |
| `test/github-setup.test.ts` | T-E2E-AZ: `infra/github-setup.sh` against a fake `gh`: creates only the two GitHub environments the parameter file names (the deploy job's and the Auth0 job's), and reports leftover secrets |
| `test/cleanup.test.ts` | T-E2E-AZ: `infra/cleanup.sh` against a fake tenant and `gh`: deletes the GitHub environment, role assignments, resource group, app registrations and the operators' group and nothing else, leaves no orphaned role assignment, and deletes nothing on `--dry-run`, unconfirmed or for the wrong tenant |
| `test/openapi.test.ts` | T-API-01..03: `docs/l2-control.openapi.yaml` matches L2's routes, tokens, statuses and response shapes; T-API-04: the Swagger UI routes are off by default, same-origin and serve fixed files only |
| `test/seller-monetization.test.ts` | T-MON-01..03: the seller's tiers and prices, what's derived from its decorators, the free catalog while payments are down, `usdc()`, and every declaration mistake refused while the seller is built |
| `test/openapi-seller.test.ts` | T-API-09..10: `docs/seller.openapi.yaml` matches the seller's routes, catalog prices, statuses, decoded x402 headers and bodies; T-API-11: its Swagger UI routes are off by default, never set in Azure, same-origin and serve fixed files only |
| `test/openapi-hosted.test.ts` | T-API-05..07: `docs/l1-hosted.openapi.yaml` matches the hosted agent's routes, auth, statuses, headers and response shapes; T-API-08: its Swagger UI routes are off by default, never set in Azure, same-origin and serve fixed files only |

Run one test with `npx vitest run test/policy.test.ts -t "<name>"`.

## Security model

The agent can ask for a payment but cannot make one happen. Each threat in SPEC.md §11 has a
control and a test that fails without it. The full table is in
[specs/007-process-isolation-security/contracts/threat-matrix.md](specs/007-process-isolation-security/contracts/threat-matrix.md),
and `test/architecture.test.ts` (T-ARCH-TRACE) checks that every test it names exists.

| Threat | Control | Test |
|---|---|---|
| Prompt injection overspends | Two tools only; rules R1–R14; budgets | T-AGT-01, T-POL-*, T-E2E-01 |
| Agent compromise leaks the key | Key only in L2; `main.ts` exits 1 if it sees the key | T-ARCH, T-ARCH-ENV, T-AGT-KEY |
| Seller swaps payee or redirects | Payee and host allowlists; resource binding | T-POL-05, T-POL-11 |
| Seller claims payment without settling | L3 checks the receipt and the Transfer log | T-E2E-03 |
| Forged settlement reports | Field cross-check; CONFIRMED is final; per-role tokens | T-E2E-03, T-E2E-05, T-AUTH-01/02 |
| Concurrent burst | Serialized check → sign → append | T-E2E-04 |
| Audit tampering | Hash chain checked at startup | T-LED-01 |
| Agent self-approves | Operator token; single-use approvals | T-E2E-02, T-POL-13 |
| Stale signature settles late | Spend counts until `validBefore` | T-LED-02 |
| One person reaches another's data or budget | The user comes only from the verified token; own account, budgets and approvals per user | T-PRT-02, T-USR-03, T-USR-11 |
| A stolen portal sign-in loosens a policy | A fresh sign-in for every loosening change; platform limits | T-USR-05, T-USR-10 |
| The wallet mnemonic or card data leaks | Mnemonic in L2's signer only; cards go browser to vault | T-ARCH-A11, T-USR-08, T-CARD-06 |

Accepted residual risks (v1), and the extension that retires each:

| Risk | Retired by |
|---|---|
| Bearer tokens over loopback instead of mTLS | EXT-7 |
| Payer key held in an environment variable | EXT-2 (remote signer or KMS) |
| Single-node JSONL ledger | EXT-6 |
| Facilitator trusted for liveness | none planned (L3 still verifies on-chain) |
| No refund path | EXT-9 |

## Known gotchas

- Use `npm install`, not `npm ci`: ganache's lockfile has a darwin-only `fsevents` entry.
- Never replace `USER_WALLET_MNEMONIC` once users have wallets: L2 refuses to start when recorded addresses no longer match. `npm run wallet-mnemonic` prints a new one for a new environment.
- ganache prints a `uws`/"Falling back to a NodeJS implementation" notice. It is harmless and filtered.
- On a Linux sandbox without IPv6, binding `::` fails. The seller binds `0.0.0.0`, and tests use `localhost` only as the non-allowlisted alias.
- Local signing finishes within microtasks, so races are invisible without `signerLatencyMs`. Keep it in T-E2E-04.
- Base Sepolia USDC's EIP-712 name is `"USDC"`; the local MockUSDC's is `"USD Coin"`. A wrong `extra.name` makes signatures fail.
- Kill child processes by process group (`process.kill(-pid)`), or a grandchild can keep port 8545 open.
- Development here runs on Node 26 (SPEC §5 pins 22.x; `engines` is `>=22`).
