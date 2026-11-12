# Contract: the portal API delta (browser → portal)

Normative for SPEC L2-8, `docs/portal.openapi.yaml` and `web/portal/src/api.ts`; T-API-12..15 fail until they match
the service. It extends [specs/013 contracts/portal-api.md](../../013-l2-portal-onboarding/contracts/portal-api.md);
everything there that is not named here is unchanged: the token checks, the limits, the headers, the CSP, the log
format and the 013 routes.

## Access (FR-002 to FR-004, FR-006)

The token checks of 013 run as they do today, in the same order, and none is added for using the portal: since
SPEC v1.14 the portal asks for no permission, so every person who signs in through its client is a user. With the
administration area on, the access check reads one thing more from the verified token:

- `admin = administration is on and permissions contains portal:admin`

`portal:admin` is the only permission of people's API and is held by the tenant's only role, `x402-admin`, which an
administrator of the tenant gives to a person by hand ([config-and-secrets.md](config-and-secrets.md#the-sign-in-tenant-auth0)).
A `roles` claim, a token of the organization's directory, a machine token and a token of another client never make an
administrator. With the area off, `permissions` is not read at all.

| Routes | Requires | Otherwise |
|---|---|---|
| every route of 013 | a valid portal token (as in 013) | as in 013 |
| `/api/admin/*` | `admin` | 403 `{ "error": "forbidden" }` |
| `/api/admin/*` with administration off | — | 404 `{ "error": "not found" }` (not mounted) |

- An administrator is a user like any other: their own routes work as for anyone, and being an administrator opens
  nothing of another person's (FR-006).
- A refusal reveals nothing, makes **no call to L2** and writes nothing (FR-004, T-PRT-10). The body is the same
  for a person without the permission as for any other forbidden request.
- A request without a valid token is 401 before any route is matched, with administration on or off.
- A token issued to an agent client is refused as in 013, whatever its permissions.
- **The decider** is `userIdFor(issuer, sub)` of the verified token. No administration route reads a person from
  the path, the query or the body, and none takes a user identifier at all (FR-023): a user is reached only
  through an escalation.
- **Identity confirmed at** is the token's sign-in time claim (`AUTH_TIME_CLAIM`) × 1000, passed to L2 on an
  approval. L2 decides whether it is fresh.
- **A permission taken away** takes effect at the person's next token; a token issued before works until it
  expires, an hour at most ([research R20](../research.md#r20-after-the-merge-of-main-the-administrator-is-a-permission-of-the-sign-in-tenant)).

## Changed routes

| Method & path | Change |
|---|---|
| `GET /api/config` (no token) | adds `admin: { available: boolean }`: whether the administration area is on. Public, like the rest |
| `GET /api/me` | adds `admin: boolean`: the token carries `portal:admin` and the area is on |

Both are additive. With administration off, `admin` is `false` everywhere and every existing answer is otherwise
byte-for-byte what it was.

## Administration routes

All need `admin`. All can also answer 401, 403, 429, and 502 `control_unavailable` when L2 can't be reached or
answers 401 or 5xx. Amounts are atomic strings. `:authorizationId` must match `^auth_[0-9a-f-]{36}$` (400).

| Method & path | Request | 200 response | Errors |
|---|---|---|---|
| `GET /api/admin/escalations` | — | `{ pending: AdminEscalation[], readAt }`, oldest first | — |
| `GET /api/admin/escalations/events` | query `after` or `before` (not both), `limit` (1–200) | `EventPage` | 400 |
| `GET /api/admin/escalations/:authorizationId` | — | `AdminEscalationDetail`, with `readAt` (the portal's clock at the read) | 400, 404 |
| `POST /api/admin/escalations/:authorizationId/approve` | `{}` or no body | `DecisionOutcome` (`state: "approved"`) | 400, 403 `own_payment`, 403 `step_up_required` (`maxAgeSec`), 404, 409 `not_pending` (`state`, `channel?`, `decidedBy?`) |
| `POST /api/admin/escalations/:authorizationId/reject` | `{ reasonCode }` | `DecisionOutcome` (`state: "denied"`) | 400, 403 `own_payment`, 404, 409 `not_pending` |
| `GET /api/admin/ledger/verify` | — | `{ entries, ok, brokenAt?, checkedAt }` | — |

```text
AdminEscalation       { authorizationId, referenceCode, owner: { userId?: string, platformAccount: boolean },
                        mine: boolean, resourceKey, payTo, amountAtomic, createdAt, expiresAt,
                        approvalRequest?: string }
AdminEscalationDetail AdminEscalation & { state, decision?, budget: EscalationBudget }
```

The other shapes are in [data-model.md](../data-model.md#derived-views).

- **`mine`** is true when the escalation's owner is the signed-in person. The portal computes it; L2 enforces it
  (403 `own_payment`).
- **`sessionId` is not returned** to the browser: nothing in the administration area needs it, and it is the
  agent's session reference.
- **A body field other than `reasonCode`** is a 400, on both decision routes. In particular `decidedBy`,
  `identityConfirmedAtMs`, `ttlSeconds`, `approver`, `operator` and `reason` are refused: the first two come
  from the token, the rest don't exist on this path (FR-016, T-PRT-12).
- **`step_up_required`** is relayed as in 013; the web app signs the person in again and retries once.
- **A retry after a timeout is safe**: both decisions are idempotent at L2 (`already: true`).
- **The ledger check** is cached for 10 s across administrators; `checkedAt` says when it actually ran.
- **`decidedBy` on an operator decision and `reason`** are text an operator typed on the command line. They are
  returned as plain strings and the web app renders them as text (FR-010).

## Limits, headers and the log

Unchanged mechanisms, applied to the new routes:

- 300 requests a minute per client address before the token is verified, then 120 a minute per person
  (NFR-009). A polling administrator uses about 32.
- `Cache-Control: no-store`, the CSP and the other headers of 013 on every answer.
- One log line per request: time, route template (never the escalation ID), status, duration and the person's
  `userId`. Decisions add a fixed `event` label: `admin_approved`, `admin_rejected`, `admin_already_decided`,
  `admin_own_payment`, `admin_step_up_required`, `admin_not_pending`. Never a token, a name, a body or L2's text
  (FR-034).

## Order of writes

A decision is one call to L2 and no write in the portal, so there is nothing to order and nothing half-made. If
L2 can't be reached the portal answers 502 and the escalation is as it was; if the answer is lost after L2
recorded the decision, the retry returns it with `already: true`.

## Tests

| ID | Covers |
|---|---|
| T-API-12..15 | `docs/portal.openapi.yaml` matches the new routes, statuses and schemas and the changed `/api/config` and `/api/me` |
| T-PRT-10 | access by permission: a user without `portal:admin` is 403 on every `/api/admin` route with 0 calls to L2; an administrator is a user like any other and `/api/me` says `admin: true`; no other permission, `roles` claim, machine token, agent client's token or directory token counts; a permission taken away is refused at the next token; administration off: 404, and the permission is not read. **Must fail** with `skipAdminCheck`: an ordinary user approves |
| T-PRT-11 | reads: each L2 answer mapped as listed; `mine`; `sessionId` absent; query whitelist and bounds; L2 down gives 502 on every route; the ledger check runs at most once in 10 s |
| T-PRT-12 | decisions: `decidedBy` and `identityConfirmedAtMs` come from the token only; any extra body field is 400 and makes no call; the reason-code list; `own_payment`, `step_up_required` and `not_pending` relayed with their fields |
| T-PRT-13 | the log lines and labels for the new routes; headers on every answer; a known-value scan of responses and logs for both portal tokens and the person's token |
| T-PRT-14 | config: `PORTAL_ADMIN=1` without the token off `local` refuses to start, naming the variable only; `/api/config` and `/api/me` flags on and off; with it off every 013 answer is unchanged |
| T-E2E-14 | on the local chain: a user's run escalates; an administrator approves through the portal's HTTP API; the orchestrator's retry pays and L3 confirms the transfer; a second escalation is rejected in the portal and nothing is paid; with the backchannel stand-in on, a portal decision ends the 120 s wait and the same authorize call returns the re-evaluated decision |
