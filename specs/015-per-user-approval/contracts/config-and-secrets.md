# Contract: configuration, the tenant and Azure (delta to SPEC CFG-2, §3.1, §3.3)

**Feature**: [../spec.md](../spec.md) | **Builds on**: `specs/012` and `specs/013` contracts/config-and-secrets.md

No new credential, no new secret, no new application in the tenant, no new unit, image or pipeline (FR-005,
FR-028). One setting is removed everywhere, and one dependency between two switches is added.

## L2 (`env/l2-control.env`)

| Variable | Change |
|---|---|
| `CIBA_APPROVER` | removed |
| `CIBA_APPROVAL`, `CIBA_ISSUER`, `CIBA_CLIENT_ID`, `CIBA_AUDIENCE`, `CIBA_CLIENT_KEY` / `CIBA_CLIENT_SECRET`, `CIBA_CLIENT_KEY_ID` | unchanged |

Checked before the ledger lock, in this order after today's checks:

| Condition | Result |
|---|---|
| `CIBA_APPROVAL=1` and `CIBA_APPROVER` is set (any value) | L2 stops: `CIBA_APPROVER is no longer used: remove it (SPEC L2-7)`. The value is never printed |
| `CIBA_APPROVAL=1` and `USER_ACCOUNTS` is not `1` | L2 stops: `CIBA_APPROVAL=1 needs USER_ACCOUNTS=1 (SPEC L2-7)` |
| `CIBA_APPROVAL` off and `CIBA_APPROVER` set | named in the one "ignoring …" line, as today |

The startup line becomes `backchannel approval on (issuer <issuer>, per user)`.

## The hosted agent, the portal

No new variable. The agent's three people's variables stay all-or-none and local only. The portal learns
whether phone approval is on from L2's platform view.

## §3.3 credential matrix

No new row. The row of the Auth0 client credential changes one word: an approval counts only when **the
owner's** signed answer verifies. Rule A9 is unchanged.

## The tenant (`auth0/`, Terraform)

| Item | Change |
|---|---|
| `variable "approver_user_id"` | removed |
| `data "auth0_user" "approver"` | removed; the configuration reads and manages no user |
| output `bicepparam_ciba` | loses `approver`; its keys still equal the parameter file's `ciba` keys |
| the env-file output | loses the `CIBA_APPROVER=` line |
| `auth0_action "enroll_phone"` (`auth0/enroll-phone.js`) | new; bound in the post-login flow with `sign_in_time` |
| the tenant setting that lets an Action choose MFA factors | new, on |
| `auth0_guardian` | unchanged: the push factor on, `guardian_policy` `never` |
| applications | unchanged: exactly two (T-IAC-02 still fails on a third) |
| roles and permissions | unchanged |

**`auth0/enroll-phone.js`.** It enrolls the push factor only when all three hold, and otherwise does nothing:
the sign-in asked for it (`acr_values`), the person has no push factor, and their latest authentication is at
most 5 minutes old. It sets no claim, reads no secret and never fails a sign-in by itself.

**The pipeline (`provision-auth0.yml`).** `VAR_approver_user_id`, its `required` entry and its name in the
export loop are removed. No secret and no variable is added.

**`infra/github-setup.sh`.** `AUTH0_VARIABLES` loses `AUTH0_APPROVER_USER_ID`: it creates five variables. It
never deletes one, so the existing `AUTH0_APPROVER_USER_ID` of an environment is deleted by hand
([quickstart §6](../quickstart.md)).

## Azure (`infra/`)

| File | Change |
|---|---|
| `main.bicep` | `ciba` is `{ enabled, issuer, clientId, audience, credential, clientKeyId }`; `cibaChecked` no longer asks for an approver; new `fail()` when `ciba.enabled` and not `userAccounts.enabled` |
| `main.<env>.bicepparam` | `approver` removed from `ciba` |
| `modules/l2-apps.bicep` | the `CIBA_APPROVER` environment variable removed |

Nothing is added to a vault. `ciba-client-credential` is still always referenced and seeded by hand (rule 19).
The hosted agent's app gets no people's setting (rule 21 unchanged).

## T-IAC-01 rule 19, as amended

- an enabled `ciba` names an https issuer, a client and an audience;
- `ciba` has no `approver` key, and no app has a `CIBA_APPROVER` environment variable;
- `ciba.enabled` without `userAccounts.enabled` is refused by `main.bicep`;
- everything else of rule 19 (the credential is a reference to the l2 vault, only L2 has it) is unchanged.

## T-IAC-02, as amended

- `REQUIRED` and `VARIABLES` lose the approver; the list of variables without a default is `api_identifier`,
  `environment`, `tenant_domain`;
- **must fail**: an `auth0_user` data source or resource; an `approver` in an output; the pipeline reading
  `AUTH0_APPROVER_USER_ID`;
- the new Action is run with a fake `event` and `api`: it enrolls in the one case above, and in no other;
- **must fail**: the Action without its freshness check (a session a day old enrolls a phone), without its
  `acr_values` check (every sign-in is sent to enrollment), or without its enrolled-factor check.

## Tests

| ID | What it proves |
|---|---|
| T-CIBA-24 | `CIBA_APPROVER` with the feature on stops L2 before the lock, naming the variable and never its value; off, it is only named as ignored; `CIBA_APPROVAL=1` without user accounts stops L2 |
| T-IAC-01 rule 19 | as amended above |
| T-IAC-02 | as amended above, with the Action's cases |
| the setup script's test | five variables created, none deleted, none overwritten |

## Architecture rules

A9 (the client credential's one file) and A1 to A13 are unchanged. No new rule: the proof that the subject is
never kept is a scan of what L2 writes (T-CIBA-20), not an import rule.

## Documents that name the approver

`README.md` (the phone section), `auth0/README.md` (the variable table, the steps, "the approver enrolls"),
`CLAUDE.md` (the gotchas on CIBA and on the Auth0 variables), `docs/l2-control.openapi.yaml` and
`docs/portal.openapi.yaml` (the descriptions of `approver`, `decidedBy` and `check`).
