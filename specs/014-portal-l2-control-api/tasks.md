---

description: "Task list for 014: the portal's administration area over the rest of the L2 Control API"
---

# Tasks: Portal Administration: the Rest of the Control API in the Portal

**Input**: Design documents from `specs/014-portal-l2-control-api/`

**Prerequisites**:
- [plan.md](plan.md)
- [spec.md](spec.md)
- [research.md](research.md) (R1–R19)
- [data-model.md](data-model.md)
- [contracts/](contracts/): control-api, portal-api, portal-ui and config-and-secrets
- [quickstart.md](quickstart.md)

**Tests**: included and required. Constitution Principle VIII requires a test for every route and contract field,
plus the five must-fail proofs in plan.md "Proofs".
- **Test IDs.** Each test title carries its ID (T-ADM-01..10, T-LED-07, T-PRT-10..14, T-WEB-09..12, T-E2E-14,
  T-ARCH-A13) or `014 USn …`.
- **Order.** Write each story's tests first and confirm they fail before implementing.
- **Switches.** Every must-fail switch (`skipAdminCheck`, `skipOwnPaymentCheck`, `skipDecisionStepUp`,
  `singlePortalRole`, `skipPendingCheck`) is a test-only dep, never an environment variable.
- **Clock.** Tests pass `now` as a dep; nothing in a test sleeps to cross 300 seconds or 15 minutes.

**Organization**: tasks are grouped by user story (US1–US5 from spec.md). US2 to US5 each need US1's access and
navigation; they are otherwise independent of one another, except that US4 upgrades the screen US2 creates.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel: a different file, and no dependency on an incomplete task.
- **[Story]**: the user story the task belongs to (US1–US5).

## Path Conventions

- Single repository: `src/`, `web/`, `scripts/`, `test/`, `docs/`, `infra/`, `env/` at the root (plan.md
  "Project Structure").
- L2's new routes are in `src/layer2-control/admin-routes.ts`. The portal's administration half is
  `src/portal/admin-client.ts` and `src/portal/admin-routes.ts`; it imports only `src/shared/` and its own folder,
  and never `./control-client.js` (rule A13). Browser code is `web/portal/src/screens/admin/`.
- **Docs in step.** Any task that adds or changes an L2 route also updates `docs/l2-control.openapi.yaml` and the
  SPEC L2-5 table in the same task, because T-API-01..04 fail otherwise. The same holds for a portal route,
  `docs/portal.openapi.yaml`, SPEC L2-8 and `web/portal/src/api.ts` (T-API-12..15).
- **Off by default.** Until a test or a flag turns the administration area on, every existing test and
  `npm run demo:local` must stay green after every task.
- **The operator's path is not touched.** `POST /v1/approvals`, `POST /v1/rejections`, `GET /v1/escalations*`,
  `GET /v1/ledger/verify` and the three operator scripts keep their requests, responses and tests (FR-019).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: the contract shapes, the sixth role, the env templates and the dev tooling that later phases compile
against. No behavior changes.

- [X] T001 [P] Move and extend the escalation shapes in src/shared/contracts.ts per contracts/control-api.md "§7" and data-model.md "Derived views":
  - move `EscalationView`, `EscalationEvent`, `EscalationEventKind`, `ApprovalRequestState`, `ApprovalRequestMark` and `DecisionChannel` from src/layer2-control/escalations.ts, and re-export them from that file so every existing import compiles;
  - `DecisionChannel = "operator" | "backchannel" | "portal"`;
  - `REJECTION_REASON_CODES = ["not_expected", "amount_too_high", "wrong_seller", "duplicate", "other"] as const` and `RejectionReasonCode`;
  - `EscalationEvent.reasonCode?: RejectionReasonCode`;
  - new `BudgetLine { capAtomic: string; spentAtomic: string; remainingAtomic: string }`, `EscalationBudget`, `EscalationDetail`, `EventPage`, `DecisionOutcome` and `LedgerCheck { entries: number; ok: boolean; brokenAt?: number }`, field for field as data-model.md lists them.

  Make no behavior change (`channelOf` is changed in T008); `npm run typecheck` stays green.
- [X] T002 [P] Extend src/shared/config.ts: `Role` gains `"portal-admin"`; `ROLE_TOKEN_VAR["portal-admin"] = "PORTAL_ADMIN_TOKEN"` with the comment "014: the portal's administration role (INV-13). It reaches only the /v1/admin routes."; `DEV_TOKENS.PORTAL_ADMIN_TOKEN = "dev-portal-admin-token"`. Add cases to test/auth.test.ts (`014 shared the sixth role`): `tokenFor("portal-admin")` returns the dev default only with `NETWORK=local`, and throws naming `PORTAL_ADMIN_TOKEN` otherwise.
- [X] T003 Update the env templates and their allow-list (contracts/config-and-secrets.md "CFG-2"):
  - env/l2-control.env.example: after the 013 block, a commented block `# optional, 014 portal administration (L2-8); off unless PORTAL_ADMIN=1, and it needs USER_ACCOUNTS=1` with `# PORTAL_ADMIN=` and `# PORTAL_ADMIN_TOKEN=`, both empty;
  - env/portal.env.example: `# optional: 1 turns the administration area on (the Portal.Admin role)` with `# PORTAL_ADMIN=`, and `# with PORTAL_ADMIN=1; local dev default dev-portal-admin-token; the same value L2 verifies` with `# PORTAL_ADMIN_TOKEN=`;
  - test/architecture.test.ts `TEMPLATES`: the `l2-control` and `portal` specs gain both names (T-ARCH-ENV).
- [X] T004 [P] Add the administrator role to the dev issuer: in scripts/dev-issuer-lib.ts export `DEV_ADMIN_ROLE = "Portal.Admin"`; in scripts/dev-token.ts accept `--admin` (only with `--portal`; exit 2 with a message otherwise), which appends `Portal.Admin` to `roles`, so that `--admin --no-role` yields `roles: ["Portal.Admin"]`. Update the usage comment on line 1. Add cases beside the existing `--portal` cases in test/portal.test.ts (`014 dev-token --admin`).
- [X] T005 [P] Add `--admin` to the local stack: in scripts/demo-lib.ts, when both `--users` and `--admin` are given, L2's child env gets `PORTAL_ADMIN=1`; in scripts/stack-local.ts parse `--admin`, exit 2 with "--admin needs --users" when it is given alone, and update the header comment. `demo:local` and scripts/vscode-local.ts never pass it (research R17).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the portal channel in the derivations, one decision core under the operator's routes, the switch and
the role in L2, access by role in the portal, and the rule that keeps the portal's two halves apart.

**⚠️ CRITICAL**: no story can start until this phase is complete.

### L2 core

- [X] T006 Write T-LED-07 in test/escalations.test.ts, beside T-LED-04 and its fixtures (pure, must fail first):
  - `channelOf` returns `portal`, `backchannel`, `operator`, and `operator` for an entry with no `channel`;
  - `escalationEvents` over a `HUMAN_APPROVAL` with `channel: "portal"`, `approver: "usr_…"`: `channel: "portal"`, `decidedBy` is the identifier;
  - over a `HUMAN_REJECTION` with `channel: "portal"`, `approver`, `reasonCode: "amount_too_high"`: `reasonCode` set, `decidedBy` the identifier, no `operator` and no `reason` key;
  - `approvalRequestState` is `abandoned` when a portal decision ends an escalation whose phone request is open;
  - no view contains the keys `identityConfirmedAtMs`, `purpose`, `accepts`, `details` or `bindingMessage`.
- [X] T007 Write the operator-path guard tests before the refactor, in test/escalations.test.ts (`014 the operator's decisions are unchanged`): snapshot the exact `data` of one operator `HUMAN_APPROVAL` and one operator `HUMAN_REJECTION` (keys and values apart from IDs and times) and the 200 and 409 bodies of `POST /v1/approvals/:id` and `POST /v1/rejections/:id` for pending, approved, denied and expired. They pass now and must still pass after T009.
- [X] T008 Update src/layer2-control/escalations.ts: `channelOf` returns `"portal"` or `"backchannel"` when the entry says so, else `"operator"`; in `escalationEvents`, a `denied` event of the portal channel sets `reasonCode` (only when it is one of `REJECTION_REASON_CODES`) and takes `decidedBy` from `approver`. Makes T006 pass; T-LED-04 and test/backchannel-views.test.ts stay green.
- [X] T009 Extract the decision core in src/layer2-control/approval-routes.ts (research R4, data-model.md "A decision from the portal, step by step"):
  - `type By = { channel: "operator"; label: string; ttlSeconds: number; reason?: string } | { channel: "portal"; decidedBy: string; identityConfirmedAtMs?: number; reasonCode?: RejectionReasonCode }`;
  - `recordApproval(ctx, escalationId, by, opts?)` and `recordRejection(ctx, escalationId, by, opts?)`, where `ctx = { ledger, now }` and `opts = { guards?: (escalated, entries, t) => { status, body } | undefined; skipPendingCheck?: boolean }`; each is one synchronous block: sweep, state, the existing outcome for a non-pending escalation, `guards`, one append;
  - the operator branch writes exactly today's `data`; the portal branch writes `channel: "portal"`, `approver: decidedBy`, and `identityConfirmedAtMs` (approval, `expiresAtMs = t + 600_000`) or `reasonCode` (rejection), with no `operator` and no `reason`;
  - each returns a neutral result (`{ kind: "recorded" | "already" | "not_found" | "other_state" | "refused", … }`) that the operator's two handlers translate into today's exact statuses and bodies.

  No behavior change: T007, T-E2E-02, T-E2E-07, T-E2E-08, T-POL-13, T-POL-15 and the backchannel suites pass unchanged.
- [X] T010 Extend the L2 test helper test/helpers/users.ts: `TOKENS.portalAdmin = "u-portal-admin"`; `startUsersL2` accepts `admin?: true | AdminDeps` and passes `tokens.portalAdmin` and `admin` to `createControlService`; add `adminCall(method, path, body?)` that sends that token. Extend test/helpers/backchannel-l2.ts the same way (`users` and `admin` options), for T-ADM-07.
- [X] T011 Write T-ADM-10 in a new file test/admin.test.ts (must fail first), per contracts/control-api.md "Tests":
  - `adminFromEnv`: `PORTAL_ADMIN=1` without `USER_ACCOUNTS=1` throws a `ConfigError` that names both variables; without `PORTAL_ADMIN_TOKEN` off `local` throws naming it; a token equal to `CONTROL_TOKEN`, `SETTLEMENT_TOKEN`, `OPERATOR_TOKEN` or `PORTAL_TOKEN` throws `PORTAL_ADMIN_TOKEN must differ from <name> (INV-13)`; no message contains a value;
  - off (unset, or `0`): returns `{ enabled: false, ignored }` listing `PORTAL_ADMIN_TOKEN` when it is set;
  - with `admin` absent, `GET /v1/admin/escalations` is 404 even with the right token; with user accounts off too.
- [X] T012 Add the switch and the mount in src/layer2-control/service.ts and a new src/layer2-control/admin-routes.ts:
  - `export interface AdminDeps { skipOwnPaymentCheck?: boolean; skipDecisionStepUp?: boolean; skipPendingCheck?: boolean; singlePortalRole?: boolean }`;
  - `ControlServiceDeps.admin?: AdminDeps` ("014 (L2-8): the administration routes. Absent: off, each answers 404. Needs `users`.") and `tokens.portalAdmin?`;
  - `adminFromEnv(env, accounts)` beside `userAccountsFromEnv`, with the rules of T011, called in `main()` before the ledger lock; `main()` logs `l2-control: portal administration on` or the ignored name once;
  - `mountAdminRoutes(app, deps)` in admin-routes.ts, called only when `users` and `admin` are both set; for now it builds the guard (`requireRole("portal-admin")`, or `"portal-control"` when `singlePortalRole`) and mounts nothing.

  Makes T011 pass.

### Portal: access by role

- [X] T013 Extend the portal test helper test/helpers/portal.ts: `startPortal` accepts `admin?: boolean` (sets `PORTAL_ADMIN=1` and `PORTAL_ADMIN_TOKEN: TOKENS.portalAdmin` in the config env, starts L2 with `admin: true`, builds an `AdminClient`) and `skipAdminCheck?: boolean`; `token(subject, o)` accepts `admin?: boolean` and `user?: boolean` (default true) and sets `roles` to match; `PortalTestApp` gains `adminAs(subject)` (a fresh token with both roles unless told otherwise) and `l2Calls()` (the count of requests L2 received, for "no call to L2").
- [X] T014 Write T-PRT-10 and T-PRT-14 in a new file test/portal-admin.test.ts (must fail first), per contracts/portal-api.md "Access" and "Tests":
  - administration on: a token with `Agent.Run` only is 403 `{ "error": "forbidden" }` on `GET /api/admin/escalations` with `l2Calls()` unchanged; a token with `Portal.Admin` only is 200 on `/api/me` with exactly `{ userId, user: false, admin: true }` and 403 on `/api/profile`, `/api/platform`, `/api/wallet`, `/api/policies` and `/api/account/disable`; a token with both is 200 on both families; a token with neither is 403; an agent-service token with `Portal.Admin` is 403; no token is 401;
  - administration off: `/api/admin/escalations` is 404 for a valid token; a `Portal.Admin`-only token is 403 on `/api/me`; `/api/me` for a user has `admin: false, user: true`;
  - `/api/config` has `admin: { available: true | false }`;
  - `loadPortalConfig` with `PORTAL_ADMIN=1` and no `PORTAL_ADMIN_TOKEN` off `local` throws naming the variable only;
  - **must-fail**: with `skipAdminCheck`, the `Agent.Run`-only token gets 200 on `GET /api/admin/escalations` (this case is completed in T023, when the route exists; until then assert it is not 403).
- [X] T015 Extend src/portal/config.ts: `PortalConfig.admin?: { token: string }`, set when `env.PORTAL_ADMIN === "1"` from `tokenFor("portal-admin", env)`; a missing token off `local` is a `ConfigError("PORTAL_ADMIN_TOKEN is required with PORTAL_ADMIN=1 (env/portal.env)")`. This file and admin-client.ts are the only ones in src/portal/ that name the role (rule A13).
- [X] T016 Extend src/portal/access.ts per data-model.md "People and permissions": `export const ADMIN_ROLE = "Portal.Admin"`; `AccessOptions.adminEnabled?: boolean` and `skipAdminCheck?: boolean` (test hook, T-PRT-10); `Person` gains `user: boolean` and `admin: boolean`; the role check becomes "403 unless `user || admin`", with `admin = adminEnabled && roles includes Portal.Admin`; export `requireUser` and `requireAdmin` middlewares that answer 403 `{ error: "forbidden" }` (with `skipAdminCheck`, `requireAdmin` lets everyone through). The order of the other checks, and the 401 for `auth_time`, are unchanged.
- [X] T017 Create src/portal/admin-client.ts: `AdminPort` (methods are added by the stories) and `class AdminClient implements AdminPort` with the same private `call` as `ControlClient` (5 s timeout, `redirect: "error"`, 401 and 5xx as `ControlUnavailable`, other statuses as `ControlError`) but sending the administration token. Reuse `ControlError` and `ControlUnavailable` by moving them to a new src/portal/control-errors.ts that both clients import, so admin-client.ts does not import control-client.ts.
- [X] T018 Wire access by role in src/portal/routes.ts, src/portal/server.ts and a new src/portal/admin-routes.ts:
  - routes.ts: `requireUser` on every 013 route except `GET /api/me`; `/api/me` adds `user` and `admin`, and for a person with `user: false` answers `{ userId, user: false, admin: true }` without calling L2;
  - server.ts: `PortalDeps.admin?: AdminPort` and `skipAdminCheck?`; `/api/config` adds `admin: { available: deps.admin !== undefined }`; passes `adminEnabled` to `portalAccess`; when `deps.admin` is set, `app.use("/api/admin", requireAdmin)` and `mountPortalAdminRoutes(app, { admin: deps.admin, now })` before the `/api` 404;
  - admin-routes.ts: `mountPortalAdminRoutes` with the shared `handle` wrapper (502 `control_unavailable`; a `ControlError` relayed by its code and listed fields; a fixed log label through `res.locals.event`); no route yet;
  - src/portal-main.ts: build `new AdminClient(config.controlUrl, config.admin.token)` when `config.admin` is set, and add "administration on|off" to the listen line;
  - docs/portal.openapi.yaml and SPEC L2-8: the two new fields of `/api/me`, the administrator-only variant, and `/api/config`'s `admin`.

  Makes T014 pass; T-PRT-01..09 and T-API-12..15 stay green (T-PRT-01's "a person without the permission" row still expects 403).
- [X] T019 Add rule A13 and extend A12 in test/architecture.test.ts, with test/fixtures/arch/a13-violation.ts (contracts/config-and-secrets.md "§4.1"):
  - A12: in L1, L3 and counterparty files, `PORTAL_ADMIN_TOKEN` is a violation, as `PORTAL_TOKEN` is;
  - A13, over `src/portal/**`: `portal-admin` or `PORTAL_ADMIN_TOKEN` outside config.ts and admin-client.ts; an import of `./admin-client.js` outside admin-routes.ts and server.ts; an import of `./control-client.js` in admin-routes.ts or admin-client.ts;
  - `Rule` gains `"A13"`; T-ARCH-A13 has the fixture that trips only A13, the "repository is clean" walk and the "not vacuous" check (the allowed files exist and contain the name).

### Web: shapes and helpers

- [X] T020 [P] Extend web/portal/src/types.ts and web/portal/src/api.ts: `Me` gains `user: boolean` and `admin: boolean`; `enabled` and `onboarding` stay required in the type and `normalizeMe` in api.ts fills them with neutral values for an administrator only, so no existing screen changes; `Config` gains `admin: { available: boolean }`; add the types `AdminEscalation`, `AdminEscalationDetail`, `EscalationBudget`, `BudgetLine`, `EventPage`, `AdminEvent`, `DecisionOutcome`, `LedgerCheck` as contracts/portal-api.md lists them (import the shared ones from src/shared/contracts.ts, as `PolicyValues` is). `ApiError` gains `state?`, `channel?` and `decidedBy?`, copied when present. The six `Api` methods are declared here too (the type must be complete for the test fakes); each story mounts its portal route and uses its method.
- [X] T021 [P] Create web/portal/src/poll.ts: `startPolling(fn: () => void | Promise<void>, everyMs: number, doc = document): () => void` runs `fn` at once and then every `everyMs` while `doc.visibilityState === "visible"`, runs it again when the tab becomes visible, never overlaps two runs, and returns a stop function. Add web/portal/test/poll.test.ts (`014 poll`) with fake timers: the cadence, the pause while hidden, the catch-up on return, no overlap, stop.

**Checkpoint**: with the switch on, a person with `Portal.Admin` passes the portal's access check and L2 knows the
sixth role; nothing is mounted yet. With it off, every answer is what it was.

---

## Phase 3: User Story 1 - An administrator sees every payment that is waiting for a human (Priority: P1) 🎯 MVP

**Goal**: the waiting list, for every user and the platform account, current within 5 seconds, visible only to
administrators.

**Independent Test**: quickstart.md §2 steps 1–3 and §3: an escalation appears in `/admin` within 5 seconds with
its seller, amount, owner and reference code; it leaves when it expires; a user without the role gets 403 and no
link.

### Tests for User Story 1 (write first; they must fail)

- [X] T022 [US1] Add to test/admin.test.ts:
  - T-ADM-01 (list): `GET /v1/admin/escalations` returns `{ pending, cursor, readAt }`, oldest first, with `userId` on a user's item and none on the platform account's; 401 without or with a malformed token, before anything else;
  - T-ADM-02: for every `ENDPOINT_ROLES` entry of the role `portal-admin`, the tokens of `agent-control`, `verifier-control`, `operator` and `portal-control` get 401 and append nothing; `TOKENS.portalAdmin` gets 401 on `POST /v1/authorize`, `GET /v1/budget/s1`, `POST /v1/reconcile`, `POST /v1/approvals/x`, `POST /v1/rejections/x`, `GET /v1/escalations`, `GET /v1/escalations/events`, `GET /v1/ledger/verify`, `GET /v1/platform` and `GET /v1/users/<id>`. The test iterates `ENDPOINT_ROLES`, so later routes are covered as they are added. **Must-fail**: with `admin: { singlePortalRole: true }`, `TOKENS.portal` reads the list;
  - T-ADM-08 (list): an item leaves the list at exactly 300 s by the clock with no `ESCALATION_EXPIRED` entry yet; `ledger.entries().length` is the same before and after ten reads.
- [X] T023 [P] [US1] Add to test/portal-admin.test.ts:
  - T-PRT-11 (list): `GET /api/admin/escalations` maps each item to `AdminEscalation`: `owner: { userId, platformAccount: false }` or `{ platformAccount: true }`, `mine` true only for the signed-in person's own, `amountAtomic`, no `sessionId` key and no `amount` key; `readAt` present; with `controlDown`, 502 `control_unavailable`;
  - T-PRT-13 (list): the log line has the route template `/api/admin/escalations`, the status, the administrator's `userId` and no token; the response has `Cache-Control: no-store` and the CSP;
  - complete the T-PRT-10 must-fail from T014: with `skipAdminCheck`, the `Agent.Run`-only token gets 200.
- [X] T024 [P] [US1] Write T-WEB-09 and T-WEB-10 in a new file web/portal/test/admin.test.tsx (first line `// @vitest-environment jsdom`, its own `cleanup`), using the fakes of web/portal/test/helpers.tsx extended with the administration calls:
  - T-WEB-09: the "Administration" link only when `me.admin`; a person with `user: false` sees only "Administration" and "Sign out" and lands on `/admin` from `/`, `/wallet` and `/policies`; a non-administrator's visit to `/admin` shows "Not found" and the fake API records no `/api/admin` call; an administrator who has not onboarded reaches `/admin` without being sent to onboarding; with `config.admin.available` false there is no link;
  - T-WEB-10: the columns of contracts/portal-ui.md "Waiting for approval"; the "Your payment" tag; "No payment is waiting for approval."; "Read at …"; the countdown computed from `readAt` when the local clock is 90 s off; a failed refresh keeps the last list with "Couldn't refresh"; no request while the tab is hidden; the live region says "1 new payment is waiting" once when the count grows and nothing otherwise.

### Implementation for User Story 1

- [X] T025 [US1] Add `GET /v1/admin/escalations` in src/layer2-control/admin-routes.ts: no sweep and no `serialize`; `t = now()`; `{ pending: pendingEscalations(entries, t), cursor: entries.length - 1, readAt: new Date(t).toISOString() }`. Add the route to `ENDPOINT_ROLES` in src/shared/auth.ts, to docs/l2-control.openapi.yaml (a new security scheme `portalAdminToken`) and to the SPEC L2-5 table. Makes T022 pass.
- [X] T026 [US1] Add `pending()` to `AdminPort` and `AdminClient` in src/portal/admin-client.ts, and `GET /api/admin/escalations` in src/portal/admin-routes.ts with the mapping of T023 (a pure `toAdminEscalation(view, person)`). Update docs/portal.openapi.yaml, SPEC L2-8 and `adminEscalations()` in web/portal/src/api.ts. Makes T023 pass.
- [X] T027 [US1] Route and frame the area in web/portal/src/routes.ts and web/portal/src/app.tsx (contracts/portal-ui.md "Screens"): screens `admin-waiting` (`/admin`), `admin-payment` (`/admin/escalations/:authorizationId`), `admin-activity` (`/admin/activity`) and `admin-ledger` (`/admin/ledger`); `resolveRoute(path, me)` takes the whole `Me`: an `/admin…` path resolves to itself for an administrator and to a not-found screen otherwise, and never through the onboarding rules; any other path for a person with `user: false` resolves to `/admin`; the header shows "Administration" when `me.admin`, and only that and "Sign out" when `me.user` is false. Until its story lands, a screen that does not exist yet renders the existing "Not found" section.
- [X] T028 [US1] Create web/portal/src/screens/admin/AdminNav.tsx (the second navigation row: "Waiting", "Activity", "Ledger check") and web/portal/src/screens/admin/Waiting.tsx per contracts/portal-ui.md "Waiting for approval": `startPolling(…, 3000)`; a table with a caption and column headers that becomes a labeled list under the phone breakpoint in web/portal/src/styles.css; amounts through `money.ts`; the countdown as text ("4 min 12 s", "under 1 min", "Expired"), ticking each second from `expiresAt` and the `readAt` offset; the polite live region; "Review" links. Add the new strings to web/portal/src/messages.ts. Makes T024 pass.

**Checkpoint**: US1 works alone: an administrator watches escalations arrive and leave; nobody else can.

---

## Phase 4: User Story 2 - An administrator approves or rejects a pending payment (Priority: P1)

**Goal**: an administrator approves or rejects a pending escalation in the portal, with the same effect as the
operator's decision, and L2 enforces who may decide and when.

**Independent Test**: quickstart.md §2 steps 5–12: an approval is one `HUMAN_APPROVAL` with `channel: "portal"`
and the agent's retry pays once; a rejection denies; a decision on a decided or expired item, by a
non-administrator, or on one's own payment records nothing.

### Tests for User Story 2 (write first; they must fail)

- [X] T029 [US2] Add to test/admin.test.ts, per contracts/control-api.md "Tests":
  - T-ADM-01 (decisions): 400 for a malformed `:authorizationId` (not `^auth_[0-9a-f-]{36}$`), a `decidedBy` that fails `USER_ID_RE`, a non-integer `identityConfirmedAtMs`, a `reasonCode` outside the list, and any unknown body field (`ttlSeconds`, `approver`, `operator`, `reason`); 404 for an unknown ID; 401 before all of them;
  - T-ADM-03: the approval entry's `data` is exactly `approvalId, escalationId, resourceKey, payTo, amount, expiresAtMs (= t + 600_000), channel: "portal", approver, identityConfirmedAtMs`; the next authorize for the same session, resource, payee and amount is AUTHORIZED once and a second is ESCALATE again; a different amount is not covered; with the policy paused, the account disabled or the daily budget used up after the approval, the retry is DENIED by that rule;
  - T-ADM-04: the rejection entry's `data` is exactly `rejectionId, escalationId, resourceKey, payTo, amount, channel: "portal", approver, reasonCode`; the next authorize is DENIED `human_rejected` and its violation detail contains only the rejection ID (no reason code, no identifier, no channel); each of the five codes is accepted;
  - T-ADM-05: `identityConfirmedAtMs` at `t`, at `t − 900_000`, at `t − 900_001`, at `t + 60_000` and at `t + 60_001`: the second and fourth pass, the third and fifth are 403 `{ error: "step_up_required", maxAgeSec: 900 }` with nothing appended; a rejection passes with no such field. **Must-fail**: with `skipDecisionStepUp`, a value a day old approves;
  - T-ADM-06: `decidedBy` equal to the escalation's `userId` is 403 `{ error: "own_payment" }` for approve and for reject, nothing appended; another identifier succeeds; a platform-account escalation is decided by anyone. **Must-fail**: with `skipOwnPaymentCheck`, the owner approves;
  - T-ADM-07: for each ordered pair of paths among portal, operator and the backchannel stand-in, and for both decisions: the second request appends nothing; the same decision returns the first outcome with `already: true`; the opposite one is 409 `{ error: "not_pending", state, channel, decidedBy }`; at exactly 300 s both are 409 with `state: "expired"`; with a phone request open, a portal decision leaves `approvalRequestState` as `abandoned` and the waiting authorize call returns the re-evaluated decision. **Must-fail**: with `skipPendingCheck`, a portal approval is appended after an operator rejection.
- [X] T030 [P] [US2] Add to test/portal-admin.test.ts:
  - T-PRT-12: on approve, L2 receives `decidedBy` equal to the signed-in person's `userId` and `identityConfirmedAtMs` equal to the token's `auth_time × 1000`; a body with `decidedBy`, `identityConfirmedAtMs`, `ttlSeconds`, `approver`, `operator` or `reason` is 400 and `l2Calls()` is unchanged; reject needs `reasonCode` from the list (400 otherwise) and no body field else; 403 `own_payment`, 403 `step_up_required` with `maxAgeSec`, 404 and 409 `not_pending` with `state`, `channel` and `decidedBy` are relayed; a repeat returns `already: true`; with `controlDown`, 502 and nothing changed;
  - T-PRT-13 (decisions): the labels `admin_approved`, `admin_rejected`, `admin_already_decided`, `admin_own_payment`, `admin_step_up_required` and `admin_not_pending`; the route template in the log, never the escalation ID; a known-value scan of every response and log line of this file for `TOKENS.portal`, `TOKENS.portalAdmin` and the person's token.
- [X] T031 [P] [US2] Add T-WEB-11 (deciding) to web/portal/test/admin.test.tsx, per contracts/portal-ui.md "One payment": the confirm dialog repeats seller, payee, amount, owner, reference code and time left; approving on 403 `step_up_required` shows "Confirm it's you", and after the click the same request is sent exactly once more; rejecting needs one of the five radio buttons, has no text input and never asks for identity; no buttons when `mine`, with the "payment of your own agent run" text; the messages for 409 `not_pending` (naming the path), expired, 403 `own_payment` and 502; an item that is no longer in the pending list shows "This payment is no longer waiting" and a link to the list.
- [X] T032 [P] [US2] Write T-E2E-14 in test/e2e.local.test.ts beside T-E2E-13: a user's run through the real orchestrator escalates; an administrator approves through the in-process portal's HTTP API; the retry pays, L3 confirms the transfer from the user's account, and the time from the approve request to its answer is under 2 s; a second escalation is rejected in the portal and nothing is paid; with the backchannel stand-in on, a portal approval ends the 120 s wait and the same authorize call returns AUTHORIZED; a known-value scan of the ledger and every log for both portal tokens.
- [X] T033 [P] [US2] Add to test/users.test.ts, beside "013 US8 the operator's CLI names the user" (`014 US2 the operator's CLI shows a portal decision`): `formatEvent` prints `portal`, the decider's identifier and the reason code for a portal approval and rejection, and is unchanged for the other two channels.

### Implementation for User Story 2

- [X] T034 [US2] Add `POST /v1/admin/escalations/:authorizationId/approve` and `…/reject` in src/layer2-control/admin-routes.ts: the guard, then `express.json({ limit: "16kb" })`; validation per data-model.md "Validation rules" (400); then `serialize(() => recordApproval | recordRejection(ctx, id, { channel: "portal", … }, { guards, skipPendingCheck }))` with the guards in this order: own payment (`escalationOwner(entries, id) === decidedBy` → 403 `own_payment`, unless `skipOwnPaymentCheck`), then for an approval `stepUpFresh(identityConfirmedAtMs, t)` (→ 403 `step_up_required`, `maxAgeSec: 900`, unless `skipDecisionStepUp`); translate the core's result into `DecisionOutcome`, 404, or 409 `not_pending` with `state`, `channel`, `decidedBy` and the IDs. Add both routes to `ENDPOINT_ROLES`, docs/l2-control.openapi.yaml and the SPEC L2-5 table, and the portal channel's fields to the SPEC L2-4 entry table. Makes T029 pass.
- [X] T035 [P] [US2] Update scripts/escalations.ts: `formatEvent` and `formatPending` print the channel `portal`, `decidedBy` and `reasonCode` when present. The script still imports only src/shared. Makes T033 pass.
- [X] T036 [US2] Add `approve(id, decidedBy, identityConfirmedAtMs)` and `reject(id, decidedBy, reasonCode)` to src/portal/admin-client.ts, and the two `POST` routes in src/portal/admin-routes.ts: 400 for a bad ID or any body key other than `reasonCode` (and for a missing or unknown `reasonCode` on reject) before any call; `decidedBy` and `identityConfirmedAtMs` from `res.locals.person` only; the log labels of T030. Update docs/portal.openapi.yaml, SPEC L2-8 and `approveEscalation`, `rejectEscalation` in web/portal/src/api.ts. Makes T030 and T032 pass.
- [X] T037 [US2] Create web/portal/src/screens/admin/Payment.tsx per contracts/portal-ui.md "One payment" (first version): load the pending list and show the item with this ID, or "This payment is no longer waiting" with a link; the approve dialog and the reject dialog (five radio buttons with the labels of the contract, no text field) built on the existing `Dialog`; approving goes through the existing step-up function behind a "Confirm it's you" button; the outcome replaces the buttons. Add the error and reason strings to web/portal/src/messages.ts and the screen to web/portal/src/app.tsx. Makes T031 pass.

**Checkpoint**: US1 and US2 together are the first version worth turning on: see and decide.

---

## Phase 5: User Story 3 - An administrator follows what happened to each escalation (Priority: P2)

**Goal**: the activity trail, read in pages, every event once and in order.

**Independent Test**: quickstart.md §2 step 13: three outcomes on three paths appear in order with path and
decider; after two more, reopening shows exactly those two as new.

### Tests for User Story 3 (write first; they must fail)

- [X] T038 [US3] Add T-ADM-09 to test/admin.test.ts: over a ledger with 130 escalation events, `GET /v1/admin/escalations/events` with neither cursor returns the last 50 with `more: true`; `before=<first>` walks back to the start, and `after=-1&limit=200` then `after=<last>` walks forward, each walk yielding all 130 once and in order; `first`, `last` and `cursor` as data-model.md "EventPage" defines them, with `first: -1, last: -1` on an empty page; 400 for `limit` 0, 201 or non-integer, `after` and `before` together, a value below -1, and any unknown query key; the ledger length is unchanged by the reads; a portal decision's event has `reasonCode` and no `reason`.
- [X] T039 [P] [US3] Add to test/portal-admin.test.ts (T-PRT-11, events): `GET /api/admin/escalations/events` passes `after`, `before` and `limit` through, refuses other query keys with 400 and no call to L2, drops `sessionId` from each event and adds `mine`; an operator's `reason` containing `<script>` is returned as the same plain string.
- [X] T040 [P] [US3] Add T-WEB-12 (activity) to web/portal/test/admin.test.tsx: newest first; each kind's text per contracts/portal-ui.md "Activity", with the path and decider on decisions and the reason's label on a portal rejection; "Show earlier" requests `before=<first>` and is offered only while `more`; while open, later events are requested with `after=<cursor or last>` every 5 s and added at the top; events that arrive while the screen is open are marked "New", and nothing is stored in the browser (T-WEB-07); an operator's reason with markup appears as text and creates no element.

### Implementation for User Story 3

- [X] T041 [US3] Add the pure `eventPage(entries, q: { after?: number; before?: number; limit: number }): EventPage` to src/layer2-control/escalations.ts (built on `escalationEvents`), and `GET /v1/admin/escalations/events` to src/layer2-control/admin-routes.ts with the query rules of data-model.md "Validation rules" (`limit` integer 1 to 200, default 50; `after`, `before` integer ≥ -1, not both; unknown keys refused). No sweep. Add the route to `ENDPOINT_ROLES`, docs/l2-control.openapi.yaml and the SPEC L2-5 table. Register this path before `/:authorizationId` so the word `events` is never read as an ID. Makes T038 pass.
- [X] T042 [US3] Add `events(q)` to src/portal/admin-client.ts and `GET /api/admin/escalations/events` to src/portal/admin-routes.ts. Update docs/portal.openapi.yaml, SPEC L2-8 and `adminEvents(q)` in web/portal/src/api.ts. Makes T039 pass.
- [X] T043 [US3] Create web/portal/src/screens/admin/Activity.tsx per contracts/portal-ui.md "Activity", with `startPolling(…, 5000)`, the "New" mark on what arrives while the screen is open (kept in memory; T-WEB-07 forbids `localStorage`) and "Show earlier". Add the event texts to web/portal/src/messages.ts and the screen to web/portal/src/app.tsx. Makes T040 pass.

**Checkpoint**: an administrator can answer "what happened to that payment, and who decided it?".

---

## Phase 6: User Story 4 - An administrator sees the budget behind a payment (Priority: P2)

**Goal**: for any escalation, in any state, the budget it counts against, from the decision's own figures.

**Independent Test**: quickstart.md §2 step 4 and the "can't be paid" paragraph: the run's and the user's figures
match the ledger and the user's own wallet view; an amount over what remains shows the warning.

### Tests for User Story 4 (write first; they must fail)

- [X] T044 [US4] Add to test/admin.test.ts (T-ADM-08, detail and budget):
  - `GET /v1/admin/escalations/:authorizationId` returns `EscalationDetail` for a pending, an approved (each of the three paths), a denied and an expired escalation, with `decision` as data-model.md lists it; 404 for an unknown ID, 400 for a malformed one;
  - for a user's escalation after two payments in the run: `run`, `day` and `userDay` equal `sessionCommittedAtomic`, `dailyCommittedAtomic` and the user-wide figure that `decideOnce` passes to the engine for the same owner, session and resource (compared with the ledger's own `committedAtomic` for the same filters, the agent's budget read and the user's wallet view), with `remainingAtomic` never below `"0"`;
  - for a platform-account escalation: `run` and `day` from the mandate, no `userDay`;
  - `fits` true when the amount equals every remaining amount and false one atomic unit over; false when the amount is above `hardCapPerPaymentAtomic`;
  - `applies: false` with `notApplying` `no_active_policy` (policy paused, or the seller taken off the list), `user_disabled` and `user_not_onboarded`, and then zero lines and `fits: false`;
  - the read appends nothing.
- [X] T045 [P] [US4] Add to test/portal-admin.test.ts (T-PRT-11, detail): `GET /api/admin/escalations/:authorizationId` returns `AdminEscalationDetail` with `mine`, `amountAtomic`, the `budget` unchanged and no `sessionId`; 400 for a bad ID before any call; 404 relayed.
- [X] T046 [P] [US4] Add to web/portal/test/admin.test.tsx (T-WEB-11, detail and budget): the screen now shows an escalation in any state with its outcome text ("Approved in the portal by …", "Rejected from the command line", "Approved by phone", "Expired at …"); the budget table's three rows (two for the platform account); the `fits: false` warning above buttons that stay; the three `applies: false` texts; an activity row links to this screen.

### Implementation for User Story 4

- [X] T047 [US4] Extract the spend figures (`spendFigures(u, sessionId, t)`, with `budgetFor(escalated, t)` beside it) from `decideOnce` in src/layer2-control/service.ts (research R9): it returns the mandate in force, the owner filter, `sessionCommittedAtomic`, `dailyCommittedAtomic`, the user-wide 24 h figure and the user gate; `decideOnce` builds its `PolicyContext` from it. No behavior change: test/policy.test.ts, test/users.test.ts (T-USR-10, T-USR-11) and T-E2E-01, T-E2E-04, T-E2E-12 pass unchanged. The must-fail switches `sharedBudgets`, `skipUserCeiling`, `skipUserGate` and `skipPlatformBound` keep acting inside it.
- [X] T048 [US4] Add the pure `escalationDetail(entries, escalationId, nowMs)` (state and `decision`, from a whitelist) to src/layer2-control/escalations.ts and `toEscalationBudget(lines, amount, net)` to src/layer2-control/service.ts (`BigInt` only; `fits` and `applies` as data-model.md "EscalationBudget" defines them), and `GET /v1/admin/escalations/:authorizationId` to src/layer2-control/admin-routes.ts, taking the owner, session and resource from the `ESCALATED` entry. Add the route to `ENDPOINT_ROLES`, docs/l2-control.openapi.yaml and the SPEC L2-5 table. Makes T044 pass.
- [X] T049 [US4] Add `escalation(id)` to src/portal/admin-client.ts and `GET /api/admin/escalations/:authorizationId` to src/portal/admin-routes.ts. Update docs/portal.openapi.yaml, SPEC L2-8 and `adminEscalation(id)` in web/portal/src/api.ts. Makes T045 pass.
- [X] T050 [US4] Upgrade web/portal/src/screens/admin/Payment.tsx to load `adminEscalation(id)` instead of searching the list: any state, the outcome text, the budget table and the warnings of contracts/portal-ui.md "The budget"; after a decision or a 409 it reloads. Link each row of web/portal/src/screens/admin/Activity.tsx to this screen when that file exists. Makes T046 pass; T031 still passes with its fake returning the detail.

**Checkpoint**: a decision is an informed one, and decided payments can be opened from the trail.

---

## Phase 7: User Story 5 - An administrator checks the ledger's integrity (Priority: P3)

**Goal**: the ledger check from the portal, read-only.

**Independent Test**: quickstart.md §2 step 14: the entry count and "verifies"; against an altered ledger, the
position of the break; refused for a non-administrator.

### Tests for User Story 5 (write first; they must fail)

- [X] T051 [US5] Add to test/admin.test.ts (T-ADM-01, ledger check): `GET /v1/admin/ledger/verify` returns `{ entries, ok: true }` for an intact ledger and `{ entries, ok: false, brokenAt }` after one entry's `data` is altered in the test's ledger file and reloaded; nothing is appended.
- [X] T052 [P] [US5] Add to test/portal-admin.test.ts (T-PRT-11, ledger check): `GET /api/admin/ledger/verify` adds `checkedAt`; two administrators asking five times within 10 s by the test clock cause one L2 call, and a call at 10 s plus 1 ms causes a second; a 502 is not cached.
- [X] T053 [P] [US5] Add to web/portal/test/admin.test.tsx: T-WEB-12 (ledger): nothing is requested until "Check the ledger" is pressed; the verified text with the entry count and time; the broken banner with the entry number and "The operator must act. Nothing can be repaired here."; and one `axe-core` run over each of the four administration screens in their loaded state, with no violation.

### Implementation for User Story 5

- [X] T054 [US5] Add `GET /v1/admin/ledger/verify` to src/layer2-control/admin-routes.ts (`res.json(ledger.verifyChain())`), `ENDPOINT_ROLES`, docs/l2-control.openapi.yaml and the SPEC L2-5 table. Makes T051 pass.
- [X] T055 [US5] Add `verifyLedger()` to src/portal/admin-client.ts and `GET /api/admin/ledger/verify` to src/portal/admin-routes.ts with one in-memory entry `{ at, result }` reused while `now() − at ≤ 10_000` (research R15). Update docs/portal.openapi.yaml, SPEC L2-8 and `adminLedgerCheck()` in web/portal/src/api.ts. Makes T052 pass.
- [X] T056 [US5] Create web/portal/src/screens/admin/LedgerCheck.tsx per contracts/portal-ui.md "Ledger check", add its strings to web/portal/src/messages.ts and the screen to web/portal/src/app.tsx; fix any accessibility finding of T053 in the four screens. Makes T053 pass.

**Checkpoint**: all five stories work; every capability of the control API meant for a person is in the portal.

---

## Phase 8: Azure

**Purpose**: the administrator role in Entra, the second secret, and the switch in the two apps. No new unit,
image or pipeline (contracts/config-and-secrets.md "Azure").

- [X] T057 Update T-IAC-01 in test/infra.test.ts first (it must fail): rule 16 expects exactly two roles on the API app, `Agent.Run` (`['User', 'Application']`) and `Portal.Admin` (`['User']`), each with its fixed ID, and one `Portal.Admin` assignment per `portalAdmins` entry; new rule 22 as the contract's table states it; one must-fail mutant for each (a third role; `PORTAL_ADMIN_TOKEN` as a literal; the portal app referencing `kv-l2`; `administration: true` with `enabled: false` not refused).
- [X] T058 Update infra/pre-deploy.bicep and infra/pre-deploy.dev.bicepparam: the second app role `Portal.Admin` (a new fixed GUID, `allowedMemberTypes: ['User']`, description "Lets a person use the portal's administration area"); `param portalAdmins array` with its description; `Microsoft.Graph/users` `existing` and `appRoleAssignedTo` loops for it, as `agentUsers` has; `param portalAdmins = []` in the dev file. `Agent.Run`, the scopes and the pre-authorized clients keep their IDs.
- [X] T059 Update infra/main.bicep and infra/main.dev.bicepparam: `userAccounts.administration: false`; `fail()` when `administration` is true and `enabled` is false; `userAccounts` is still passed whole to the modules.
- [X] T060 [P] Update infra/modules/l2-apps.bicep: the secret `portal-admin-token` from the l2 vault, always referenced, as `PORTAL_ADMIN_TOKEN`; env `PORTAL_ADMIN: userAccounts.administration ? '1' : '0'`.
- [X] T061 [P] Update infra/modules/portal-apps.bicep: the secret `portal-admin-token` from the portal's vault, always referenced, as `PORTAL_ADMIN_TOKEN`; env `PORTAL_ADMIN` from the same expression. No other token.
- [X] T062 Run `BICEP_PATH=~/.azure/bin/bicep npx vitest run test/infra.test.ts test/deploy-workflow.test.ts test/images.test.ts test/cleanup.test.ts test/github-setup.test.ts`: T057 passes, and T-E2E-AZ and T-IMG-01 pass unchanged. Confirm `az bicep build-params -f infra/main.dev.bicepparam --stdout` shows `administration: false`.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: the normative documents, the stated changes to existing tests, and the validation runs.

- [X] T063 Update SPEC.md to v1.14 with a "Changes in 1.14" table, completing what the route tasks already changed (plan.md "SPEC and governance changes"): §1.2, §1.3, §2 glossary, §3.1, §3.2, §3.3 (the `PORTAL_ADMIN_TOKEN` row), §4 INV-13 (the sixth role), §4.1 (A12 extended, A13), §6, §7, L2-4 and L2-4.3 (three decision paths), L2-5 (the note on the operator's reads), L2-8 (the administration area), CFG-2, §11 (SEC-8 amended; SEC-25, SEC-26, SEC-27, each naming its tests; the two residual risks), §12 (every new test ID with its file and what it covers) and §13 (`stack:local -- --users --admin`, `dev-token -- --portal --admin`).
- [X] T064 Update specs/007-process-isolation-security/contracts/threat-matrix.md with SEC-25..27 and set `SEC_ROWS` to 27 in test/architecture.test.ts; the test that every SEC row names an existing test title must pass.
- [X] T065 [P] Amend .specify/memory/constitution.md to 1.5.0 with a Sync Impact Report (MINOR): Principle V's first bullet lists the sixth role; one new bullet for the administration credential, worded as plan.md "Constitution Check" states it; the existing portal-credential bullet unchanged; the two residual risks under "Added in 1.5.0"; the version line and date.
- [X] T066 [P] Update specs/README.md: the 014 row, and the traceability rows for INV-13, L2-4, L2-4.3, L2-5, L2-8, SEC-8, SEC-25..27, CFG-2 and the new test IDs; the header's version references (SPEC v1.14, constitution 1.5.0).
- [X] T067 [P] Add one pointer line each to specs/013-l2-portal-onboarding/contracts/control-api.md and specs/013-l2-portal-onboarding/contracts/portal-api.md: the administration routes, the sixth role and the `roles` row are defined by specs/014.
- [X] T068 [P] Update CLAUDE.md: "What this repo is" (the portal relays an administrator's decision to L2 and still holds no key); hard rule 10 (six roles, `PORTAL_ADMIN_TOKEN` opens only L2's administration routes); the commands (`stack:local -- --users --admin`, `dev-token -- --portal --admin`, `PORTAL_ADMIN=1 npm run portal`); under "New or changed portal route", the administration half and rule A13; the gotchas (seed `portal-admin-token` as `off` in both vaults before the first deployment with 014; the area needs 013's `auth_time` check; the must-fail switches of this feature are test-only deps).
- [X] T069 [P] Update README.md and docs/diagrams/x402-architecture.json: the administration path from the browser through the portal to L2, and the sixth credential.
- [X] T070 Update the two existing tests the plan names, and nothing else in them: T-USR-02 in test/users.test.ts gains the sixth token on the user-account routes (401), and T-PRT-01's access table in test/portal.test.ts states that with administration off a `Portal.Admin`-only token is 403. Confirm no other existing test file changed except for the additive cases listed in this task list (`git diff --stat test/ web/portal/test/`).
- [X] T071 Run the offline definition of done (quickstart.md §1): `npm run typecheck`, `npm test`, `npm run demo:local` (expect `spent on-chain: 0.006 USDC` and `hash chain ok=true`), then `BICEP_PATH=~/.azure/bin/bicep npm test`. Fix what fails without weakening a test.
- [ ] T072 Walk quickstart.md §2, §3 and §4 by hand on the local stack, including a keyboard-only pass of the four screens at phone and desktop widths, and record the date, the commit and each section's result in quickstart.md "Validation log".
- [ ] T073 Manual, needs outside accounts (do not block the merge on it): quickstart.md §5 against an Auth0 tenant when one is set up, and §6 in Azure. §6 is gated on 013's task T114: if the `auth_time` check has not passed, deploy with `userAccounts.administration: false` and stop there. Record the results in quickstart.md "Validation log".

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 (Setup)**: no dependencies. T001, T002, T004 and T005 are parallel; T003 touches
  test/architecture.test.ts and runs alone.
- **Phase 2 (Foundational)**: needs Phase 1. Blocks every story.
  - L2 core in order: T006 → T008; T007 → T009 (T009 after T008, same concepts); T010 → T011 → T012.
  - Portal in order: T013 → T014 → T015 → T016 → T017 → T018. T013 needs T012 (the `admin` dep).
  - T019 after T017 and T018 (the allowed files must exist for the not-vacuous check).
  - T020 and T021 are independent of the server tasks and of each other.
- **Phases 3–7 (stories)**: US1 first. US2, US3, US4 and US5 each need US1 (T027's routing and T025's token
  matrix) and are otherwise independent, with one link: US4's T050 rewrites the screen US2's T037 creates, so US4
  comes after US2.
- **Phase 8 (Azure)**: needs T012 and T018 (the variable names). T057 → T058 → T059; T060 and T061 parallel after
  T059; T062 last. It can proceed beside the stories.
- **Phase 9 (Polish)**: after the stories that are in scope. T063 before T064 and T066 (they cite SPEC IDs).
  T071 → T072 → T073 last.

### Within each story

- Tests first, and they fail; then L2, then the portal, then the web app.
- Tasks on the same file run in order: src/layer2-control/admin-routes.ts, src/portal/admin-client.ts,
  src/portal/admin-routes.ts, web/portal/src/api.ts, test/admin.test.ts, test/portal-admin.test.ts and
  web/portal/test/admin.test.tsx are each touched by every story.
- A story is done when its tests pass, the whole suite is green, and `npm run demo:local` is unchanged.

### Parallel opportunities

- Phase 1: T001, T002, T004, T005.
- Phase 2: T020 and T021 beside everything; the L2 core (T006–T012) beside nothing in the portal until T012.
- In each story, the three test tasks are in three different files (test/admin.test.ts, test/portal-admin.test.ts,
  web/portal/test/admin.test.tsx) and can be written together; the web screen can start from the contract while
  the portal route is built.
- After US2: US3 and US5 can be built by different people, merging carefully in the shared files above. US4
  waits for US2.
- Phase 8 beside any story. In Phase 9: T065, T066, T067, T068 and T069.

## Parallel example: User Story 2

```text
# Tests first, together (different files):
T029  test/admin.test.ts               T-ADM-01, 03, 04, 05, 06, 07
T030  test/portal-admin.test.ts        T-PRT-12, T-PRT-13
T031  web/portal/test/admin.test.tsx   T-WEB-11
T032  test/e2e.local.test.ts           T-E2E-14
T033  test/users.test.ts               the operator's CLI

# Then implementation, by layer:
T034        L2 (admin-routes.ts; needs T009's core)
T035        the operator's CLI (independent of T034)
T036        portal client and routes (needs T034)
T037        web screen (needs T036's API shape; can start from the contract)
```

## Implementation Strategy

### MVP first (User Story 1, then 2)

1. Phase 1 and Phase 2.
2. US1: an administrator sees what is waiting. **Stop and check** quickstart.md §2 steps 1–3 and §3.
3. US2: they decide. Check steps 5–12.

US1 alone is demonstrable and read-only. US1 and US2 together are the first version worth turning on, and
everything in it is off unless `PORTAL_ADMIN=1`.

### Incremental delivery

Each step leaves `npm run check` green and can merge with the feature off.

1. Setup + Foundational → merge. T009 (the decision core under the operator's routes) is the one change to
   existing authority code: review it on its own, against T007.
2. US1 → merge.
3. US2 → merge before any shared environment turns the area on (it carries four of the five proofs).
4. US3, US4, US5 → merge each; US4 after US2.
5. Phase 8 (Azure) → merge; deploy with `userAccounts.administration: false` first (quickstart.md §6).
6. Phase 9 → merge; T073's manual checks gate turning the area on, not the merge.

### Along the plan's slices

Plan.md "Delivery" names four slices. They map to these tasks: L2 (T001, T002, T006–T012, T022, T025, T029,
T033, T034, T035, T038, T041, T044, T047, T048, T051, T054); the portal backend (T013–T019, T023, T026, T030, T032,
T036, T039, T042, T045, T049, T052, T055); the web app (T020, T021, T024, T027, T028, T031, T037, T040, T043,
T046, T050, T053, T056); Azure and documents (T003–T005, T057–T073).

## Notes

- **Never weaken an invariant to make a test pass.** `policy.ts` is not touched by this feature; the ledger stays
  append-only; authorize stays inside the serialized section; an approval never overrides a DENY (CLAUDE.md hard
  rules 3–7).
- **Nothing typed reaches L2.** The administration area has no text input. If a task seems to need one, it is
  out of scope (FR-016, hard rule 11).
- **No route takes a user identifier from the browser.** The decider is the verified token's person; a user is
  reached only through an escalation's ID (FR-023).
- **Two tokens, two halves.** `PORTAL_TOKEN` never reaches an administration route and `PORTAL_ADMIN_TOKEN` never
  reaches a user-account route, at L2 (T-ADM-02) and in the portal's code (A13).
- **Reads write nothing.** No administration `GET` calls `sweep` or `serialize` (research R14).
- **Docs in step.** A route task is not done until its OpenAPI document and its SPEC table row match the service.
- Commit after each task or logical group, with the requirement IDs in the message.

## Phase 10: Convergence

- [X] T074 Add a case to T-PRT-10 in test/portal-admin.test.ts showing that the same person's next token, issued without `Portal.Admin`, is refused on every `/api/admin` route while a token issued before still carries the role until it expires; and record in SPEC.md §11 (residual risks added in v1.14) and specs/014-portal-l2-control-api/research.md R3 that a removed administrator permission takes effect when the person's current token expires, because the portal reads the role from the token and makes no directory call per spec Edge Cases "The permission is taken away" (partial)
- [X] T075 Extend "the token travels in the Authorization header only, and no call carries a user identifier" in web/portal/test/safety.test.tsx to call the six administration methods of web/portal/src/api.ts (`adminEscalations`, `adminEscalation`, `approveEscalation`, `rejectEscalation`, `adminEvents`, `adminLedgerCheck`) and assert that no URL, query or body carries a `usr_` identifier, and that the only body field sent is `reasonCode` per FR-023 (partial)
- [X] T076 Reconcile the additive fields with "exactly as in 013": either omit `user` and `admin` from `/api/me` and `admin` from `/api/config` in src/portal/routes.ts and src/portal/server.ts when the administration area is off (and default them in `normalizeMe` and the web app's config), or keep them and have FR-001 and SC-011 of spec.md amended through `/speckit-specify` to say "apart from additive fields", as SPEC.md "Changes in 1.14" already does per FR-001, SC-011 (contradicts)
- [X] T077 Raise "T-ADM-07 simultaneous decisions from two paths" in test/admin.test.ts from 25 to 100 pairs, alternating which path approves and which rejects, and keep the assertions (one 200 and one 409 per pair; 100 decisions for 100 escalations) per SC-003 (partial)
- [X] T078 Add to "with the approver's phone (012)" in test/admin.test.ts the case where the phone refuses first (`stub.setAnswers("pending", "deny")`): a portal approval is then 409 `not_pending` with `state: "denied"` and `channel: "backchannel"`, a portal rejection returns the phone's rejection with `already: true`, and one decision is recorded per T029, T-ADM-07 (partial)
- [X] T079 Add the two mutants T057 names to test/infra.test.ts and make the rule 16 test's title match what it mutates: a third app role on the API app is reported by rule 16, and a portal app that reads `portal-admin-token` from the l2 vault is reported by rule 22 per T057 (partial)
- [X] T080 Widen the known-value scan of T-PRT-13 in test/portal-admin.test.ts to every response body and every log line produced in that file (collect them in the file's `start` helper and scan in an `afterEach`), for `TOKENS.portal`, `TOKENS.portalAdmin` and each signed token the tests issued per T030, NFR-003 (partial)
- [X] T081 Add a case to T-WEB-10 in web/portal/test/admin.test.tsx: with focus on a "Review" link, a refresh that adds and removes rows leaves `document.activeElement` on the same payment's link, or on the document when that payment left the list, and never on the heading per contracts/portal-ui.md "Waiting for approval" (partial)
- [X] T082 Put the payment screen's countdown on the portal's clock: add `readAt` to the answer of `GET /api/admin/escalations/:authorizationId` in src/portal/admin-routes.ts (the portal's own clock at the read), document it in docs/portal.openapi.yaml, SPEC.md L2-8 and specs/014 contracts/portal-api.md, use it for the skew in web/portal/src/screens/admin/Payment.tsx as Waiting.tsx does, and test it with a browser clock 90 s off per contracts/portal-ui.md "One payment" (partial)
- [X] T083 Make the approval's identity prompt say what the contract says: let `useStepUp` in web/portal/src/components/StepUp.tsx take an optional prompt text and pass "Confirm it's you to approve." from web/portal/src/screens/admin/Payment.tsx (the 013 screens keep "Confirm it's you to make this change."), and assert the text in T-WEB-11 per contracts/portal-ui.md "Deciding" (contradicts)
- [X] T084 Add to SPEC.md §3.2 (data flow) the administrator's decision path: browser → portal (the person's token, `Portal.Admin`) → L2's administration routes (`PORTAL_ADMIN_TOKEN`) → one ledger entry, beside and never inside the payment flow per plan "SPEC and governance changes", §3.2 (partial)
- [X] T085 Update the `CFG-2` traceability row of specs/README.md to name 013 (`USER_ACCOUNTS`, `portal.env`) and 014 (`PORTAL_ADMIN`, `PORTAL_ADMIN_TOKEN`) beside 007 per T066 (partial)
- [X] T086 Regenerate docs/diagrams/x402-architecture.html from docs/diagrams/x402-architecture.json (the `archify` skill), so the rendered diagram shows the administration path the JSON already describes per plan "SPEC and governance changes", README and diagram (partial)
