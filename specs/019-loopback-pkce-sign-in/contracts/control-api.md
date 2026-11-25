# Contract: L2's control API (delta to SPEC L2-5, §7 and `specs/016` contracts/control-api.md)

**Feature**: [../spec.md](../spec.md) | **Data model**: [../data-model.md](../data-model.md)

Two changes, both on routes the agent already calls with `CONTROL_TOKEN` and the caller's token. No route is
added, no role token changes, and nothing is appended to the ledger by either. `docs/l2-control.openapi.yaml`,
SPEC L2-5 and §7 change with them; T-API-01..04 fail until they match.

## The caller check: accounts off gets its own code

`specs/016`'s order of checks, row 6, changes its refusal code; every other row stays.

| # | Check | Refusal |
|---|---|---|
| 5 | A machine token without `agent:run`; a person's token without `agent:run` or from a client not on `AGENT_CLIENT_IDS` | 403 `{ "error": "caller_forbidden" }` (unchanged) |
| 6 | A person's token while user accounts are off | 403 `{ "error": "user_accounts_off" }` (**was** `caller_forbidden`) |

Why: the agent asks before a person's run whether that person can pay, and "this L2 has no person accounts" is
an answer to that, while "L2 refuses this token" is a misconfiguration between the two services. One code can't
carry both ([research R8](../research.md#r8-the-account-question-reuses-the-budget-route)). The refusal still
decides nothing, signs nothing and appends nothing, on both routes. The code names a state of L2, never the
person.

## `GET /v1/budget/:sessionId`: the user view says whether the person can pay

The user view (`scope: "user_daily"`, a person's forwarded token with user accounts on) gains one field:

| Field | Type | Value |
|---|---|---|
| `account` | `"ready" \| "not_onboarded" \| "disabled"` | `userGate(state)` for the person in the verified token, from the ledger: `"ready"` when it gives none |

- The other fields are unchanged; for `not_onboarded` and `disabled` they are already `"0"` caps, as today.
- The platform view (a machine caller, or no caller where sign-in is not configured) has no `account` field.
- The value is computed from the ledger in the same read as the rest of the answer, outside the serialized
  section; the route still appends nothing.
- `BudgetStatus` in `src/shared/contracts.ts` gains `account?: "ready" | "not_onboarded" | "disabled"` (a
  contract change: SPEC §7, every producer and consumer). The scripted agent and the CLI agent ignore it; the
  hosted agent's account question reads it; its `check_budget` tool drops it before the model sees it.

## Unchanged

`POST /v1/authorize` (a not-onboarded or disabled person's payment is still denied by R16/R17 if it ever gets
there), the order of checks before row 5, the per-address bound on token checks, the portal's and the
operator's routes, the ledger's entry types.

## Tests

| ID | What | Must-fail |
|---|---|---|
| T-CTK-10 | The user view's `account` for a ready, a not-onboarded and a disabled person, each from their own token; no `account` on the platform view; nothing appended | `trustIntentUser` (existing, test-only): the `account` of the user named in the query instead of the token's |
| T-CTK-11 | A person's token while user accounts are off: 403 `user_accounts_off` on budget and on authorize; a token from a client not on the list: still 403 `caller_forbidden` | Swapping the two rows' codes (test-only `singleForbiddenCode`): the agent's mapping test in T-AGT-17 sends the misconfigured case to 409 |
