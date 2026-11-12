# Contract: configuration, credential confinement and Azure delivery

Normative for SPEC CFG-2, §3.3 and §4.1, and for the T-ARCH and T-IAC-01 tests. It extends
[specs/013 contracts/config-and-secrets.md](../../013-l2-portal-onboarding/contracts/config-and-secrets.md); what is
not named here is unchanged. No new process, image, unit, pipeline or vault.

## CFG-2: `env/l2-control.env` (new optional variables)

| Variable | Required | Notes |
|---|---|---|
| `PORTAL_ADMIN` | no | `1` turns the administration routes on (FR-001). It needs `USER_ACCOUNTS=1`. Anything else, or unset: off, and the token below is ignored (L2 logs its name once, never its value). |
| `PORTAL_ADMIN_TOKEN` | with `PORTAL_ADMIN=1` | The `portal-admin` role's token (INV-13). Dev default `dev-portal-admin-token` on `NETWORK=local` only. Must differ from the other five tokens, or L2 refuses to start. |

Startup with `PORTAL_ADMIN=1`: these two are validated with the user-account settings, **before the ledger lock**
(L2-6). `PORTAL_ADMIN=1` without `USER_ACCOUNTS=1` is an error that names both variables. Errors never contain a
value.

## CFG-2: `env/portal.env` (new optional variables)

| Variable | Required | Notes |
|---|---|---|
| `PORTAL_ADMIN` | no | `1` turns the administration area on: the `/api/admin` routes are mounted and the permission `portal:admin` is read from the person's token |
| `PORTAL_ADMIN_TOKEN` | with `PORTAL_ADMIN=1`, off `local` | the same value L2 verifies; empty in the template |

`src/portal-main.ts` still exits 1 if `PAYER_PRIVATE_KEY` or `USER_WALLET_MNEMONIC` is visible. With the area on in
the portal and off in L2, every administration route answers 502 (L2's routes are 404), and nothing else changes.

## §3.3: credential matrix (one new row)

| Secret | L1 | L2 | L3 | Seller | Portal | Human |
|---|---|---|---|---|---|---|
| `PORTAL_ADMIN_TOKEN` (portal→L2, administration) | — | ✅ verifies | — | — | ✅ (`admin-client.ts` only) | — |

- It opens the six administration routes and nothing else: not a user-account route, not authorize, budget,
  reconcile or the operator's routes (FR-028).
- `PORTAL_TOKEN` is unchanged: it still can't approve, reject, authorize or reconcile.
- The portal still holds no payment key, and never `CONTROL_TOKEN`, `OPERATOR_TOKEN`, `SETTLEMENT_TOKEN` or
  `VERIFIER_TOKEN` (FR-029).
- The administrator's own sign-in is verified by the portal and never forwarded (FR-030).

## §4.1: architecture rules

| Rule | Invariant | Scope | Violation |
|---|---|---|---|
| A12 (extended) | INV-13, FR-005 | `src/layer1-intent/**`, `src/layer3-settlement/**`, `src/counterparty/**` | `PORTAL_TOKEN` or `PORTAL_ADMIN_TOKEN`. The portal's half is unchanged |
| A13 (new) | INV-13, FR-028 | `src/portal/**` | the role name `portal-admin` or `PORTAL_ADMIN_TOKEN` outside `config.ts` and `admin-client.ts`; an import of `./admin-client.js` outside `admin-routes.ts` and `server.ts`; an import of `./control-client.js` in `admin-routes.ts` or `admin-client.ts` |

A13 keeps the two halves of the portal apart in code: the user-account routes can't reach the administration
credential, and the administration routes can't reach the user-account one. It gets a fixture under
`test/fixtures/arch/` that trips only it, a "repository is clean" walk and a "not vacuous" check, as A8 to A12
have. T-ARCH-ENV: the `l2-control` and `portal` templates gain the two names; `PORTAL_ADMIN_TOKEN` must be the
dev default in `l2-control.env.example` and empty or the dev default in `portal.env.example`, as `PORTAL_TOKEN` is.

## Local processes

| Item | Change |
|---|---|
| `src/shared/config.ts` | `Role` gains `portal-admin`; `ROLE_TOKEN_VAR` and `DEV_TOKENS` gain `PORTAL_ADMIN_TOKEN` |
| `src/shared/auth.ts` | `ENDPOINT_ROLES` gains the six routes |
| `scripts/demo-lib.ts`, `scripts/stack-local.ts` | `--admin` (with `--users`): L2's child env gets `PORTAL_ADMIN=1`. `demo:local` never passes it |
| `scripts/dev-issuer-lib.ts`, `scripts/dev-token.ts` | `--admin` (with `--portal`) adds `portal:admin` to the token's `permissions` |
| `scripts/escalations.ts` (operator CLI) | prints `channel: portal`, the decider's identifier and the reason code |
| `scripts/vscode-local.ts`, `.vscode/` | unchanged; the area stays off there ([research R17](../research.md#r17-local-development)) |
| `package.json` | no new script and no new dependency |

## Azure

### Parameters

`main.<env>.bicepparam`: the existing plain object gains one boolean.

```bicep
param userAccounts = {
  enabled: false
  administration: false         // 014: the portal's administration area
  portalClientId: ''
  sellerName: 'x402 demo seller'
  cardVault: 'off'
  cardVaultPublishableKey: ''
}
```

`main.bicep` fails validation (`fail()`) when `administration` is true and `enabled` is false.

Nothing changes in `pre-deploy.bicep` or its parameter file: who is an administrator is not an Azure or Entra
object.

### The sign-in tenant (`auth0/`)

People sign in with Auth0 (013, SPEC v1.12), and using the portal needs no permission (v1.14). 014 adds the only
permission and the only role there are, in `auth0/main.tf`:

- `auth0_resource_server_scopes.identity`: one permission on people's API, `portal:admin`.
- `auth0_role.admin`, named `x402-admin`, and `auth0_role_permissions.admin`: the role holds exactly that
  permission.
- Nobody is assigned in code. An administrator of the tenant gives the role to a person by hand (**User Management
  → Users → the user → Roles**), and takes it away the same way. Signing up gives it to nobody.
- RBAC was already enforced with the permissions in the access token, so the portal reads `permissions` offline.
  The hosted agent service never reads this permission.

T-IAC-02 fails on a second permission, a second role, a role that holds anything else, a permission for using the
portal, and a role assigned to a person in code.

### `infra/modules/l2-apps.bicep` and `portal-apps.bicep`

| App | Secret (always referenced) | Env |
|---|---|---|
| L2 | `portal-admin-token` from `kv-l2` → `PORTAL_ADMIN_TOKEN` | `PORTAL_ADMIN: userAccounts.administration ? '1' : '0'` |
| portal | `portal-admin-token` from `kv-portal` → `PORTAL_ADMIN_TOKEN` | `PORTAL_ADMIN: userAccounts.administration ? '1' : '0'` |

### Secrets, seeded by hand

```text
# every environment, before its first L2 and portal deployments with 014:
kv-l2:      portal-admin-token = off
kv-portal:  portal-admin-token = off

# to turn the administration area on:
kv-l2 and kv-portal: portal-admin-token = <one new random value, the same in both, different from portal-token>
Auth0: the role x402-admin assigned to each administrator, by hand
main.<env>.bicepparam: userAccounts.administration: true      then deploy-l2, deploy-portal
```

Without the seed, the new revision of either app fails ("unable to fetch secret") and the pipeline rolls it
back, as for `portal-token` and `ciba-client-credential`. Values are piped into the vault, never printed.

### T-IAC-01 changes

| Rule | Change |
|---|---|
| 8 | unchanged pattern (`…_TOKEN` is already covered): `PORTAL_ADMIN_TOKEN` is never a literal |
| 16 | unchanged: 014 adds nothing to Entra |
| 21 | unchanged |
| 22 (new) | administration: L2 and the portal each always reference `portal-admin-token`, from their own vault only; `PORTAL_ADMIN` in both comes from `userAccounts.administration`; the portal app gets no token other than `PORTAL_TOKEN` and `PORTAL_ADMIN_TOKEN`; no other app gets `PORTAL_ADMIN_TOKEN`; `main.bicep` refuses `administration` without `enabled` |

Each changed or new rule keeps a must-fail mutant.

### Image and pipeline

No change to `scripts/image-closure.ts`, the Dockerfiles, `deploy.yml` or any `deploy-<unit>.yml`: the new files
are inside `src/portal/`, `src/layer2-control/`, `src/shared/` and `web/portal/`, which the L2 and portal images
already take. `portal-smoke` is unchanged: `/api/me` without a token is still 401. T-IMG-01 and T-E2E-AZ pass
unchanged.

## Tests

| ID | Covers |
|---|---|
| T-ADM-10 | L2 config and the off switch ([control-api.md](control-api.md#tests)) |
| T-PRT-14 | portal config and the flags ([portal-api.md](portal-api.md#tests)) |
| T-ARCH-A12, A13 | A12 with the new name in the three layers; A13 with its fixture, clean walk and not-vacuous check |
| T-ARCH-ENV | the two templates' new names |
| T-IAC-01 | rule 22 new, with its mutants |
| T-IAC-02 | the one permission and the one role, with their mutants |
