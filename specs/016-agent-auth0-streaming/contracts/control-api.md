# Contract: L2's control API (delta to SPEC L2-5, L2-7, L2-8 and §7)

**Feature**: [../spec.md](../spec.md) | **Data model**: [../data-model.md](../data-model.md)

What changes on L2's HTTP API. Everything not named here is unchanged. `docs/l2-control.openapi.yaml` changes
with it, and T-API-01..04 fail until both match the service.

Two routes change, the two that L1 calls for a run: `POST /v1/authorize` and `GET /v1/budget/:sessionId`. Both
keep their one role token (`CONTROL_TOKEN`, INV-13). Beside it they now take the caller's token, and they no
longer take a user from the request.

## The caller's token

```http
POST /v1/authorize
Authorization: Bearer <CONTROL_TOKEN>
X-Caller-Authorization: Bearer <the access token the caller presented to the hosted agent>
```

- The header carries the caller's access token unchanged. L1 never alters it and never builds one.
- L2 verifies it with the shared caller check ([research R2](../research.md#r2-one-caller-check-shared-by-l1-and-l2)),
  against its own settings (`AUTH_ISSUER`, `AUTH_AUDIENCE`, `AGENT_CLIENT_IDS`; locally `AUTH_JWKS_FILE`). It
  reads no statement about the caller from L1.
- The header opens nothing by itself: without a valid `CONTROL_TOKEN` the answer is 401 before the header is
  looked at, and no other route reads the header.
- It is verified before the body is parsed and before the serialized section. Verification may fetch the
  tenant's keys; nothing inside the serialized section does.
- The token is never stored, logged, echoed or written to the ledger. What L2 keeps from it is the forwarded
  identity ([data-model.md](../data-model.md#forwarded-identity-l2-in-memory-per-request)), for the length of
  the request.

### Order of checks, both routes

| # | Check | Refusal |
|---|---|---|
| 1 | `Authorization` is the `CONTROL_TOKEN` | 401 `{ "error": "unauthorized" }` (unchanged) |
| 2 | Sign-in configured, no `X-Caller-Authorization`, or not `Bearer <token>` | 401 `{ "error": "caller_token_required" }` |
| 3 | Sign-in not configured, `X-Caller-Authorization` present | 400 `{ "error": "caller_token_not_accepted" }` |
| 4 | Signature, issuer, audience, validity, subject | 401 `{ "error": "caller_token_expired" }` when only the validity period failed; otherwise 401 `{ "error": "caller_token_invalid" }` |
| 5 | A machine token without `agent:run`; a person's token without `agent:run` or from a client not on `AGENT_CLIENT_IDS` | 403 `{ "error": "caller_forbidden" }` |
| 6 | A person's token while user accounts are off | 403 `{ "error": "caller_forbidden" }` |
| 7 | The body (authorize) or the query (budget) | 400, as below |

"Sign-in configured" means L2 was started with `AUTH_ISSUER`, `AUTH_AUDIENCE` and `AGENT_CLIENT_IDS` (all three
or none). With user accounts on they are required: L2 refuses to start without them. A refusal at steps 1 to 7
decides nothing, signs nothing and appends nothing.

The portal's client is never on `AGENT_CLIENT_IDS`: L2 refuses to start when `PORTAL_CLIENT_ID` is set and on
the list, as the agent does.

## `POST /v1/authorize` (`CONTROL_TOKEN` and the caller's token)

**Request.** `PaymentIntent` loses the two fields that named a person:

| Field | Before | Now |
|---|---|---|
| `userId` | optional, set by the hosted agent from the token it verified | not accepted: 400 `malformed PaymentIntent` when present |
| `approvalSubject` (015) | optional, set by the hosted agent | removed from the contract: 400 `malformed PaymentIntent` when present |

**Who the payment is for.**

| Caller's token | User | Pays |
|---|---|---|
| a person's | `userIdFor(AUTH_ISSUER, sub)` | that user's account, under the effective mandate (L2-8), never the platform account |
| a machine caller's | none | the platform account, under the platform mandate |
| none (sign-in not configured) | none | the platform account, as before 013 |

A person with no account, an unverified wallet or a paused account is decided as today (`DENY` with the user
gate's rule, recorded for that user).

**The ledger.** Entries are as before: an entry for a person's payment carries `userId`, written by L2 from the
verified token; an entry for a machine caller's or an unsigned-in payment carries none. Nothing identifies the
machine caller in the ledger; the hosted agent's run log does.

**Phone approval (015).** Eligibility is decided as in 015 with one change of source: `owner` is the user from
the token and `subject` is the token's `sub`. So `no_identity` can no longer arise from a missing field,
`identity_mismatch` arises only when the sign-in issuer is not the approval service's (015's same-tenant rule),
and a machine caller's escalation is `no_owner`.

**Response and timing.** Unchanged.

## `GET /v1/budget/:sessionId` (`CONTROL_TOKEN` and the caller's token)

- `?userId=` is not accepted any more: 400 `{ "error": "userId is not accepted: the user comes from the caller's token" }`
  when present, whatever its value.
- A person's token: the user view (`scope: "user_daily"`), as `?userId=` gave.
- A machine caller's token, or none where sign-in is not configured: the session view, as today.

## Unchanged

Every other route, its token and its answers; the operator's, the portal's and the administration routes; the
events; reconcile. The portal keeps naming the user in the path of its own routes (`PORTAL_TOKEN`), from the
token the portal verified: forwarding a person's token from the portal is not part of this feature.

## Tests

T-CTK-01..08 ([plan.md](../plan.md#tests-defined-here)); T-API-01..04 extended for the header, the two refused
fields and the new statuses.
