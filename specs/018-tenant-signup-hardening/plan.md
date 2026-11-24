# Implementation Plan: Sign-Up Hardening for the Sign-In Tenant (pentest finding P1)

**Branch**: `claude/pentest-report-fixes-0709b1` (spec-kit feature `018-tenant-signup-hardening`) | **Date**: 2026-11-24 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/018-tenant-signup-hardening/spec.md`

**Renumbered (2026-11-24)**: this feature was written as 017, for SPEC 1.27, with the test T-PRT-16, and committed
that way in `d97909f`. `main` then took 017, SPEC 1.27 and T-PRT-16..18 for the portal's DAST remediation
(`specs/017-dast-findings-remediation`). So this feature is 018, for SPEC 1.28, and its portal test is T-PRT-19.
Nothing else changed.

## Summary

The pentest's finding P1 has four parts:

- the login page offers a "Sign up" the tenant refuses;
- a first Google sign-in creates an account outside the sign-up switch;
- Google may run on Auth0's shared developer keys;
- the signed-in API couldn't be tested for lack of an account.

The owner decided on 2026-11-24 that Google sign-up is the public way in. Email-and-password sign-up stays closed.
Using the portal needs no role (R21); the agent needs `x402-agent`.

The approach is almost entirely in the tenant's declaration (`auth0/`):

- The default database connection comes under Terraform. Its own "Disable Sign Ups" (`disable_signup =
  !var.allow_sign_ups`) hides the link and refuses every public sign-up, and it still lets the operator create test
  accounts (research R1, R2).
- The connections' enabled applications are declared authoritatively: the portal and the agent only (R3).
- Google is read, never written. A precondition requires the project's own Google client ID, and the secret stays
  only in the tenant (R4).
- The deny-all pre-user-registration Action is removed in a second rollout step. It also refuses the operator's own
  user creation (R1, R7).

No service changes. Two new tests pin what a role-less Google person reaches (R11). The SPEC (1.28), SEC-26, the
constitution (3.0.1) and the guides follow (R12).

## Technical Context

**Language/Version**:

- HCL for Terraform. The operator command installs the pinned 1.15.5; the configuration requires 1.11 or later.
- The `auth0/auth0` provider: 1.60.0 is locked, constrained to `>= 1.60.0, < 2.0.0`. This uses its connection data
  source's `hide_client_secret` (1.56.0 and later) and `auth0_connection_clients`.
- TypeScript (strict, ESM) on Node 22 and 26 for the tests. Bash for the operator command.

**Primary Dependencies**: None new: no package and no provider. The new Terraform objects are
`auth0_connection`, `data "auth0_connection"` and `auth0_connection_clients`.

**Storage**: The tenant's Terraform state stays a local file on the operator's host (`~/x402-tfstate`, mode 0600,
SPEC 1.26), and no Google secret reaches it (R4). L2's ledger is unchanged.

**Testing**:

- vitest: T-IAC-02, offline, extended with must-fail mutants for every new rule; the new T-PRT-19 in
  `test/portal.test.ts`; the new T-AGT-15 in `test/hosted-access.test.ts`, the suite of the agent's access
  rules; a case for the same person in T-CTK-01 row 5 (`test/caller-token.test.ts`), where L2 checks the
  permission on the forwarded token; T-ARCH-TRACE through SEC-26's row.
- A live check by hand against the dev tenant (quickstart §1–§5, §7).

**Target Platform**:

- The Auth0 tenant `fabriciorojas.us.auth0.com` (dev, free plan), applied from the VPS.
- The portal at `https://dev.fabriciorojas.com`, the agent at `https://agent.fabriciorojas.com`.
- A Google Cloud OAuth client, made by hand.

**Project Type**: The existing repository: TypeScript services, the tenant's Terraform and operator scripts.

**Performance Goals**: Not applicable. The user-facing target is SC-003: from sign-in page to saved profile in
under 3 minutes.

**Constraints**:

- No Google secret in the repository, the tfvars file, the state, a plan or GitHub (FR-008).
- No lock-out at any step (NFR-002).
- One setting decides the sign-up page and the endpoints (FR-002).
- No window with sign-up open during the rollout (R7).
- The database connection is never destroyed or reset (R2).

**Scale/Scope**:

- One environment (dev), two people's connections, four application kinds.
- About 8 files in `auth0/`, `scripts/` and `test/`, plus the documents.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Verdict (before research) | After design |
|---|---|---|
| I. Separation of Payment Authority | Pass. No layer, import or tool changes. Nothing new reaches L1, L2 or L3 | Pass. Only `auth0/`, `scripts/auth0-tenant.sh`, tests and documents change |
| II. Deterministic, Pure Policy | Pass. No policy input changes | Pass |
| III. Ledger Is the Single Source of Truth | Pass. Nothing is appended or rewritten. A deleted test person's entries stay | Pass |
| IV. Trust the Chain | Not applicable | Not applicable |
| V. Least-Privilege Credentials | Check: is there a new credential? | Pass, see below |
| VI. Exact Money Arithmetic | Not applicable | Not applicable |
| VII. Protocol Fidelity | Not applicable | Not applicable |
| VIII. Proven Safety | Check: a safety mechanism (the deny Action) is removed | Pass, see below |

How V passes:

- No process of the system holds the Google secret: the tenant holds it, entered by hand (R4). The tfvars file is
  refused if it tries to carry it (R9).
- The Management API credential gains four connection scopes and still "can change the tenant's configuration;
  it never signs a payment and never approves one". It gets no create or delete scope, so the connections it can
  reach can't be replaced (R10).
- L2's approval client and the machine callers lose any connection (R3).
- Every role and role credential stays as it is (INV-13).

How VIII passes:

- The deny Action is replaced, not dropped. The connection's own setting closes the same self-service paths
  (page, `/u/signup`, `/dbconnections/signup`). T-IAC-02 must-fail mutants check its binding to the switch, and
  quickstart §3.5 and §4.2 check it live.
- What the Action did beyond that (refusing the operator's own creations) is exactly what FR-004 needs removed.
- Its passwordless coverage is kept by the declaration and the live check (R5).
- Every other new rule has a must-fail mutant. T-PRT-19 and T-AGT-15 each check a refusal that a mutant
  (`skipPermission`, `bypassAuth`) turns into an acceptance.

**Development Workflow & Quality Gates**: `npm run check` stays green. The demo summary is unchanged: no service
behavior changes. SPEC is updated in the same change (1.28). Requirement IDs go in commit messages and test names.
**Governance**: the constitution goes to 3.0.1 (PATCH) with a Sync Impact Report. Technology & Scope Constraints
gains the two people's connections, and the residual risk is added. No principle is redefined.

Gate result: **pass**. There are no violations, so Complexity Tracking stays empty.

## Project Structure

### Documentation (this feature)

```text
specs/018-tenant-signup-hardening/
├── spec.md                       # /speckit-specify (amended by this plan: FR-003, FR-007, FR-018, US3, SC-005)
├── plan.md                       # This file
├── research.md                   # R1–R12
├── data-model.md                 # tenant variables, connections, person, portal user
├── quickstart.md                 # live check and offline checks, steps A and B
├── contracts/
│   ├── tenant-connections.md     # the declaration, what a visitor gets, T-IAC-02 rules 1–8
│   └── new-person-access.md      # what a role-less Google person reaches (T-PRT-19, T-AGT-15)
├── checklists/requirements.md
└── tasks.md                      # /speckit-tasks (not created here)
```

### Source Code (repository root)

```text
auth0/
├── main.tf            # new section "People's connections" (step A); deny_sign_up removed (step B)
├── variables.tf       # google_client_id, google_sign_in; allow_sign_ups narrowed to email and password
├── deny-sign-up.js    # deleted (step B)
└── README.md          # Management API scopes, imports, the Google application by hand, People, emergency stop
scripts/
└── auth0-tenant.sh    # check_tfvars: refuse *secret* variables and GOCSPX- values
test/
├── auth0-iac.test.ts  # T-IAC-02 rules 1–8 and their mutants; the deny Action's checks replaced
├── portal.test.ts     # T-PRT-19: a role-less google-oauth2| person in the portal
├── hosted-access.test.ts  # T-AGT-15: the same person refused by the agent, no model or gate call
└── caller-token.test.ts   # T-CTK-01 row 5: the same person's forwarded token refused at L2, nothing appended
SPEC.md                # 1.28: Changes in 1.28, SEC-26, residual risks, T-IAC-02 row, T-PRT-19, T-AGT-15, §13
.specify/memory/constitution.md   # 3.0.1
specs/007-process-isolation-security/contracts/threat-matrix.md   # SEC-26
specs/README.md, CLAUDE.md        # the sign-up notes, the auth0/ gotchas
```

**Structure Decision**: No new directory or module. The tenant's declaration grows by one section, as each earlier
feature added one (012, 013, 016, Phase 3). The new tests go in the suites that own each service's access rules
(T-PRT in `portal.test.ts`, T-AGT in `hosted-access.test.ts`, T-CTK in `caller-token.test.ts`). Rollout comes in two merges:

- **Step A**: the connections, the variables, the script check, the tests and the documents.
- **Step B**: removing the Action and its T-IAC-02 checks.

Step B is merged only after step A's live check (quickstart §3) passes. That sequencing is a task dependency in
`tasks.md`.

## Changes to the spec from planning

Three requirements were made precise by research, without changing their intent:

- **FR-003 and US1 scenario 2**: the refusal is Auth0's own "sign-up disabled" answer (HTTP 400), no longer the
  Action's "Sign-ups are closed" text. That text was the Action's, and the Action is gone (R1).
- **FR-007, US3 scenario 1 and SC-005**: the evidence of whose Google application is used is the redirect to
  Google, which carries the project's client ID and the tenant's callback. The consent screen shows only a domain
  until Google's brand verification (R4).
- **FR-018**: a Google connection changed by hand fails the next plan's precondition, rather than being restored
  by the apply. Terraform never writes Google's options (R4).

## Complexity Tracking

No Constitution Check violations.
