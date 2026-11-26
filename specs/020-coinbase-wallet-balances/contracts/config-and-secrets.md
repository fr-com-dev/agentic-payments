# Contract: configuration, credential confinement and delivery

Normative for SPEC CFG-2 (`portal.env`), §3.3, §4.1 and the T-ARCH, T-IAC-01 and T-DEV tests that enumerate names.
L2's settings don't change: its two new routes come with user accounts (`USER_ACCOUNTS=1`).

## CFG-2: `env/portal.env` (new optional variables)

| Variable | Required | Notes |
|---|---|---|
| `CONNECTED_PLATFORMS` | no | `coinbase` turns the feature on (FR-001); unset or empty: off, and the six Coinbase-specific names below (`COINBASE_CLIENT_ID`, `COINBASE_CLIENT_SECRET`, `COINBASE_GRANT_KEY`, `COINBASE_REDIRECT_URI`, `PRIVACY_POLICY_URL`, `SUPPORT_URL`) are ignored (their names logged once, never their values). Any other value stops the portal. User accounts (US5 scenario 3): in Azure `main.bicep` refuses it without `userAccounts.enabled`; locally a portal in front of an L2 without user accounts gets L2's 404 on every user route and offers nothing. |
| `COINBASE_CLIENT_ID` | with `coinbase` | the project's Coinbase OAuth client's ID; public |
| `COINBASE_CLIENT_SECRET` | with `coinbase` | its secret; read only in `src/portal/coinbase/client.ts` (rule A18). Never logged, never in a file the project keeps |
| `COINBASE_GRANT_KEY` | with `coinbase` | 32 random bytes, base64 (44 characters): the key that seals every user's grant. Read only in `src/portal/coinbase/grants.ts` (rule A18). Never rotated in place: a new key can't open the old grants, so every user would have to reconnect (research R5) |
| `COINBASE_REDIRECT_URI` | with `coinbase` | the portal's own `https://<portal host>/wallet/return`, exactly as registered at Coinbase. `http://localhost:<port>/wallet/return` is accepted only with `NETWORK=local` (research R6) |
| `PRIVACY_POLICY_URL` | with `coinbase` | an absolute `https` address of the deployment's privacy policy, linked before connecting (FR-030; Coinbase's terms, research R8) |
| `SUPPORT_URL` | with `coinbase` | an absolute `https` or `mailto:` address for support, linked beside it |
| `CONNECTION_DIR` | no | where the grant files are; default `.local/portal/connections`. Must not be inside `PROFILE_DIR` or the web root |

Startup checks with `coinbase` (before listening; each error names the variable, never its value):
- `COINBASE_GRANT_KEY` decodes to exactly 32 bytes, and is not `off`;
- `COINBASE_CLIENT_SECRET` is not empty and not `off`;
- `COINBASE_REDIRECT_URI` is an absolute `https` URL whose path is `/wallet/return` and that has no query or fragment
  (or the `localhost` exception);
- `PRIVACY_POLICY_URL` and `SUPPORT_URL` are set and well formed;
- every grant file in `CONNECTION_DIR` opens with the key, or the portal refuses to start with
  `connection grants don't open with COINBASE_GRANT_KEY` (so a rotated key is noticed at once, not one user at a time).

`env/portal.env.example` gains eight names, commented, with empty values: those six, `CONNECTED_PLATFORMS` and
`CONNECTION_DIR` (T-ARCH-ENV knows them, and requires the secret and the key to be empty). `src/portal-main.ts`'s
refusal of `PAYER_PRIVATE_KEY` and `USER_WALLET_MNEMONIC` is unchanged. The three L1 entry points (`src/main.ts`,
`src/hosted-main.ts`, `src/smoke-main.ts`) also refuse to start if they can see `COINBASE_CLIENT_SECRET` or
`COINBASE_GRANT_KEY`, as they refuse the payer key (rule A18 part 2 keeps the names out of every layer's code; this
keeps the values out of the agent's environment).

## §3.3: credential matrix (four new rows)

| Credential | Held by | Reaches | Can |
|---|---|---|---|
| Coinbase OAuth client secret | the portal (`coinbase/client.ts`) | Coinbase's token and revoke endpoints only | exchange a person's code, renew and revoke that person's grant. It can't read any account by itself |
| A person's Coinbase grant (refresh token) | the portal (`coinbase/grants.ts`, sealed at rest; `client.ts` in memory) | Coinbase's token endpoint (renewal) | read that one person's accounts and balances, nothing more (the scope allow-list, research R4) |
| The access token a renewal returns | the portal's memory only | Coinbase's accounts endpoint | the same, until it expires |
| `COINBASE_GRANT_KEY` | the portal (`coinbase/grants.ts`) | nothing | open the sealed grants |

None of them reaches L2, L3, the agent, the model, the seller, a log or the browser. None of them can sign, approve
or move funds: Constitution V's "never payment authority".

## §4.1: rule A18 (new; T-ARCH-A18)

1. Under `src/`, `COINBASE_CLIENT_SECRET`, the two Coinbase hosts the portal calls (`login.coinbase.com`,
   `api.coinbase.com`) in a string, and the token, revoke and accounts paths are named only in
   `src/portal/coinbase/client.ts` (outside `src/`: `env/portal.env.example`, the docs, the tests, and the web app's
   one link to Coinbase's public connections page in `messages.ts`). The CDP facilitator's address in `src/shared/config.ts`
   (`api.cdp.coinbase.com`) is neither host, so this part doesn't reach it.
   `COINBASE_GRANT_KEY` is named only in `src/portal/coinbase/grants.ts`. Each of the two files imports neither the
   other's credential name nor `control-client.ts`, `admin-client.ts` or anything under `src/layer*`.
2. No file under `src/layer1-intent/`, `src/layer2-control/`, `src/layer3-settlement/`, `src/counterparty/`,
   `src/machine-caller/` names `COINBASE_` or imports from `src/portal/coinbase/`. The three L1 entry points may name
   the two variables only to refuse them (as they name the payer key outside rule A5's folder), and never import from
   `src/portal/`.
3. `src/layer2-control/policy.ts`, `signer.ts` and `ledger-key.ts` don't name `CONNECTION_OPENED`,
   `CONNECTION_CLOSED` or `connections` (FR-020: no payment decision reads a connection).

Each part has a fixture that violates it in `test/fixtures/` (as A10 and A13 do), and the test shows the rule fires.

## Azure (T-IAC-01 rule 26, new)

- The portal app always references two more secrets of the **portal** vault: `coinbase-client-secret`
  (`COINBASE_CLIENT_SECRET`) and `coinbase-grant-key` (`COINBASE_GRANT_KEY`), in arrays no flag can empty, like rule
  21's `card-vault-key`. Seed both as `off` before the portal's first deployment with 020, or the revision fails and
  the pipeline rolls back.
- No other app references either secret, and no other vault holds them.
- `userAccounts` in `main.bicep` gains `coinbase` (a plain object, as `ciba` is):
  `{ enabled: false, clientId: '', redirectUri: '', privacyPolicyUrl: '', supportUrl: '' }`. `CONNECTED_PLATFORMS`
  is `coinbase` when `enabled` is true, else empty. `main.bicep` refuses (`fail()`) `coinbase.enabled` without
  `userAccounts.enabled`, a `clientId`, a `redirectUri` starting with `https://` and ending with `/wallet/return`,
  and both addresses.
- `CONNECTION_DIR` points into the portal's existing share (where `PROFILE_DIR` is), in its own folder.
- The portal's `maxReplicas` stays 1 (rule 26 fails on more): per-user serialization of rotating refresh tokens
  lives in the one process (research R5).

## The VPS (self-hosted dev, `docs/self-hosted/`)

The portal's env file on the operator's host gains the connected-platform variables above. The two secrets go into that file only
(mode 0600, the operator's user), never into the repository, a tfvars file or GitHub. `docs/self-hosted/README.md`
gains the steps. The Coinbase OAuth client is registered by hand in Coinbase's developer portal once Coinbase allows
it (research R0, R8), with the redirect `https://dev.fabriciorojas.com/wallet/return` (and
`http://localhost:4025/wallet/return` for local runs).

## Tests that enumerate names

T-DEV-01 (VS Code roles) doesn't change: no new process. T-IMG-01 doesn't change: no new package (research R10).
`test/openapi-portal.test.ts` (T-API-12..15) gains the four routes; `test/openapi.test.ts` (T-API-01..04) the two L2
routes. T-ARCH-ENV is amended: `env/portal.env.example`'s eight new names.
