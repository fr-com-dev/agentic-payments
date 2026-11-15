# Data Model: Auth0 Sign-In, Token Propagation and Streaming for the Hosted Agent

**Feature**: [spec.md](spec.md) | **Research**: [research.md](research.md)

Nothing new is stored. The ledger gains no entry type and no field. What changes is where three values come
from and which shapes cross the two HTTP APIs.

## Caller (shared, `src/shared/identity-token.ts`)

The result of the one caller check (research R2). Built from a verified token only.

| Field | Person | Machine caller |
|---|---|---|
| `kind` | `"person"` | `"machine"` |
| `issuer` | `AUTH_ISSUER` | `AUTH_ISSUER` |
| `subject` | the token's `sub` | the token's `sub`, `<client>@clients` |
| `client` | `azp` or `client_id`, on the allow-list | `azp` or `client_id` |

Validation: [contracts/hosted-agent-api.md](contracts/hosted-agent-api.md#who-is-accepted). A refusal carries
`status` (401 or 403) and `reason` (`expired`, `invalid` or `forbidden`); nothing else leaves the function.

## Requester (L1, in memory, per request)

Unchanged shape (`specs/011` contracts/access-and-sessions.md).

| Field | Before | Now |
|---|---|---|
| `kind` | `user` (Auth0) or `service` (Entra) | `user` (a person) or `service` (a machine caller) |
| `authority` | the issuer, or the directory's tenant ID | the issuer, for both |
| `subject` | `sub`, or `oid` | `sub`, for both |
| `key` | `<issuer host>:<sub>` or `<tid>:<oid>` | `<issuer host>:<sub>`, for both |

The caller's token is not a field of it. It is one local value of the request handler, handed to
`gate.forCaller(token)` and to nothing else, and it ends with the request.

## Forwarded identity (L2, in memory, per request)

What `callerAuth` leaves for the route (research R4).

| `kind` | Fields | From | Used for |
|---|---|---|---|
| `person` | `userId`, `subject` | `userIdFor(issuer, sub)`, `sub` | the user of the decision and of the recorded intent; the addressee of a phone approval (015) |
| `machine` | none | a verified machine token | the platform account |
| `none` | none | sign-in not configured, no header | the platform account, as before 013 |

`subject` is never written anywhere (015 FR-020, kept). `userId` is written where it was: on the ledger entries
of that payment.

## PaymentIntent (`src/shared/contracts.ts`, SPEC §7)

| Field | Change |
|---|---|
| `userId` | stays in the type, documented as "set by L2 from the caller's token; never accepted from a request" |
| `approvalSubject` | removed |

`AuthorizationGatePort.budget(sessionId)` loses its second parameter. `OrchestratorDeps` loses `userId` and
`approvalSubject`.

## Run stream (L1, on the wire only)

Four event types ([contracts/hosted-agent-api.md](contracts/hosted-agent-api.md#the-stream)). Order rule:
`run` first, `result` last, `step` events in completion order, `text` events in the order written. No state is
kept for a stream once it ends.

## Tenant objects (`auth0/`)

| Object | Key fields | Rule |
|---|---|---|
| The agent's client | public, authorization code with PKCE, callbacks limited to docs pages | never a secret, never a refresh token |
| A machine caller's client | confidential, client credentials only, one public key | one grant: people's API, `agent:run` |
| Permission `agent:run` | on people's API | read by the agent and L2 only |
| Role `x402-agent` | holds exactly `agent:run` | assigned by hand |

## Settings objects

| Object | Fields | Where |
|---|---|---|
| `agent` (Bicep parameter) | `clientId`, `apiDocs`, `machineClientId`, `machineKeyId` | `infra/main.<env>.bicepparam` |
| Caller settings (L2) | `issuer`, `audience`, `clientIds`, `jwksFile?` | from `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AGENT_CLIENT_IDS`, `AUTH_JWKS_FILE` |
| Machine client settings | `clientId`, `keyId`, `key`, `issuer`, `audience` | `src/machine-caller/token.ts` |

## State transitions

None are added. Two existing ones change their trigger:

- An escalation's approval-request mark (015): `no_identity` no longer arises from a missing field; `no_owner`
  is what a machine caller's escalation gets.
- A payment request refused for its caller (401, 403, 400 at L2) creates no intent, so no state at all: L1
  reports an error for that step and the run goes on or ends as the model decides.
