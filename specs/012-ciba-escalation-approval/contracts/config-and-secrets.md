# Contract: configuration, credential confinement and Azure delivery

## CFG-2: `env/l2-control.env` (new optional variables)

| Variable | Required when `CIBA_APPROVAL=1` | Validation (the error names the variable, never the value) |
|---|---|---|
| `CIBA_APPROVAL` | — | `1` = on; unset, empty or `0` = off; anything else is a startup error |
| `CIBA_ISSUER` | yes | an absolute `https://` URL with no query or fragment; a trailing `/` is added if missing |
| `CIBA_CLIENT_ID` | yes | 1–64 characters, no whitespace |
| `CIBA_AUDIENCE` | yes | 1–255 characters, no whitespace |
| `CIBA_APPROVER` | yes | 1–255 characters, no whitespace (an Auth0 `sub`, such as `auth0|…`) |
| `CIBA_CLIENT_KEY` | exactly one of these two | a PKCS#8 PEM RSA private key of 2048–4096 bits (`\n` escapes accepted) |
| `CIBA_CLIENT_SECRET` | exactly one of these two | 16 or more characters |
| `CIBA_CLIENT_KEY_ID` | no | 1–255 characters; only with `CIBA_CLIENT_KEY` |

- **Order.** Validation runs in `main()` right after `loadEnv`, before the ledger lock (L2-6). L2
  exits 1 with `l2-control: <VARIABLE> <problem>`. Running first means a misconfigured revision in
  Azure never takes the lock from the running one. It also fails before the network profile or
  the mandate are resolved.
- **Off.** When off, any `CIBA_*` variable present logs one warning:
  `l2-control: backchannel approval is off; ignoring CIBA_ISSUER, …` (names only).
- **No startup network call** (research R16).

`env/l2-control.env.example` lists every variable with an empty value, and a comment saying it is
off by default. T-ARCH-ENV's `l2-control` optional list gains the eight names.

## §3.3: credential matrix (new row)

| Secret | L1 | L2 | L3 | Seller | Facilitator | Human operator |
|---|---|---|---|---|---|---|
| `CIBA_CLIENT_KEY` or `CIBA_CLIENT_SECRET` (L2→Auth0, v1.8) | — | ✅ (`ciba-client.ts` only, rule A9) | — | — | — | — |

The credential authenticates L2 to the approval service. It can't authorize an on-chain transfer,
so it is not payment key material (INV-2). The approver's Guardian enrollment lives on their phone
and in Auth0, never in this system.

## §4.1: rule A9

| Rule | Invariant | Scope | Violation |
|---|---|---|---|
| A9 | §3.3, FR-030 | `src/**`, `scripts/**`, `env/*.env.example` (`test/**` exempt) | the identifier or string `CIBA_CLIENT_KEY` or `CIBA_CLIENT_SECRET` outside `src/layer2-control/ciba-client.ts` and `env/l2-control.env.example`. Comments in TS don't count, as for A8. |

- `\bCIBA_CLIENT_KEY\b` does not match `CIBA_CLIENT_KEY_ID`: `_` is a word character.
- The fixture is `test/fixtures/arch/a9-violation.ts`. It trips A9 and only A9 (T-ARCH-A9).
- **The repository is clean**: the names appear in `ciba-client.ts` and the L2 template only.
- **Infra**: Bicep files are outside A9's scope. T-IAC-01 checks that the secret reaches only the
  `l2` container.

## Azure (FR-003)

The CIBA settings are **always present** on L2's container (decided 2026-11-08). Conditional elements would compile
L2's `secrets` and `env` arrays into one ARM expression, which T-IAC-01's static rules can't read. So the arrays stay
literal, and the l2 vault always holds the credential secret.

`infra/main.bicep` gains a parameter, and `infra/main.<env>.bicepparam` sets every value:

```bicep
param ciba = {
  enabled: false                      // dev starts off (research R14); quickstart §6 turns it on
  issuer: ''                          // 'https://<tenant>.<region>.auth0.com/'
  clientId: ''
  audience: ''
  approver: ''                        // 'auth0|…'
  credential: 'key'                   // 'key' (private_key_jwt) or 'secret'
  clientKeyId: ''
}
```

It is a plain `object`, not a user-defined type: a type would switch the compiled template to
`languageVersion` 2.0, with symbolic names that rule 13 doesn't read. `main.bicep` checks it in the `cibaChecked`
variable and refuses (`fail()`) a `credential` other than `key` or `secret`. It also refuses `enabled: true` with a
non-`https://` issuer, or with an empty `clientId`, `audience` or `approver`.

`infra/modules/l2-apps.bicep`, always:
- **Secret**: `{ name: 'ciba-client-credential', keyVaultUrl: '${vaultL2}secrets/ciba-client-credential', identity: idL2.id }`.
- **The `l2` container's env**:
  - `CIBA_APPROVAL` = `ciba.enabled ? '1' : '0'`;
  - `CIBA_ISSUER`, `CIBA_CLIENT_ID`, `CIBA_AUDIENCE`, `CIBA_APPROVER` and `CIBA_CLIENT_KEY_ID`, from the object
    (empty strings while it is off, which L2 reads as absent);
  - `CIBA_CLIENT_SECRET` if `ciba.credential` is `secret`, otherwise `CIBA_CLIENT_KEY`, with
    `secretRef: 'ciba-client-credential'`.
- **The proxy sidecar** still gets no env and no secrets.

**The placeholder.** While `ciba.enabled` is false, the vault secret holds `off`.
- With the feature off, L2 ignores a credential that equals `off` and logs no warning for it.
- With the feature on, L2 refuses `off` at startup, naming the variable (`… still holds the placeholder`), before
  it takes the ledger lock.

**Seeding** (by hand, like the payer key; never in a template, a parameter file or GitHub):

```bash
# every environment, before its first L2 deployment with 012
az keyvault secret set --vault-name kv-l2-eastus2-dev --name ciba-client-credential --value off
```

```bash
# to turn it on: the real credential, then ciba.enabled: true and deploy-l2
az keyvault secret set --vault-name kv-l2-eastus2-dev --name ciba-client-credential --file ciba-client-key.pem
```

**Existing environments.** A revision whose Key Vault reference points at a missing secret fails to provision. So
seed the placeholder before running `deploy-l2.yml` with this change. If you forget, the pipeline rolls L2 back to
`last-good`; seed the secret, then run it again.

T-IAC-01 rule 19 (specs/011 contracts/cloud-topology.md) checks:
- `ciba-client-credential` is referenced only by `ca-l2-eastus2-dev`, only from the l2 vault, and only through
  `secretRef` on the `l2` container, under the name chosen by `ciba.credential`;
- every other `CIBA_*` value comes from `parameters('ciba')`, and `main.bicep` passes `ciba` to `l2-apps` whole;
- `main.bicep`'s `cibaChecked` holds the `fail()` and every check above;
- no other app, job or container has a `CIBA_*` variable or the secret.

Rule 17 already requires every parameter file to set `ciba`. The must-fail mutants are the credential on the agent,
a literal credential secret, a single fixed credential name, a `CIBA_ISSUER` written in the template, and
`main.bicep` without its issuer check.
