# Contract: L2's Seller Hosts (L2-5 `GET /v1/sellers`)

A new read for the agent's role. Update SPEC L2-5 and `docs/l2-control.openapi.yaml` together (T-API-01..04).

## Route

```text
GET /v1/sellers
Authorization: Bearer <CONTROL_TOKEN>
```

Middleware: `requireRole("agent-control", CONTROL_TOKEN)` only. No body.

The route takes no caller's token. INV-13 and SEC-32 accept the caller's token beside `CONTROL_TOKEN` on the
authorize and budget routes only, and "no other route reads it" (Constitution V). This answer is the same for every
caller, so the token would add nothing. The route has no `callerAuth` and no caller limit, and it never reads
`X-Caller-Authorization`: a request that carries one is answered as one without it.

| Status | Body | When |
|---|---|---|
| 200 | `SellerHosts` `{ "hosts": [ "seller.fabriciorojas.com", "127.0.0.1:4021" ] }` (sorted, lowercase, no duplicates) | `CONTROL_TOKEN` passes |
| 401 | `{ "error": "unauthorized" }` | no bearer token, or any other token |

- `hosts` = the platform mandate's `allowedHosts` ∪ (with `USER_ACCOUNTS=1`) the hosts of the platform seller list.
- It reads configuration loaded at startup: no ledger read, no `sweep`, no entry appended, no serialization.
- Every other role token (verifier, settlement, operator, portal, portal administration) gets 401, as on every L2
  route that accepts one role.

## L1's port

`HttpAuthorizationGate.sellers(): Promise<SellerHosts>` sends `CONTROL_TOKEN` only, never the caller's token, even on a
gate made with `forCaller`. A non-2xx throws a `PortHttpError`, as the other calls do. The adapter sets no timeout of
its own: `runGoal` races the call against a 2 s timer (as `checkAccount` in `account-check.ts` bounds the account
question), so the bound also holds for a fake gate. Fakes in tests answer `{ hosts: [] }` by default (`fakePorts`): the
run adds the configured seller's host itself.

## Tests

| ID | Covers |
|---|---|
| T-SEL-01 | the union for each configuration (mandate only; mandate and seller list); sorted and lowercase; each other role 401; with sign-in configured, a request with no caller's token, with a valid one and with a malformed one all answer the same 200 (the route reads no caller's token); the ledger unchanged after 100 calls; L1's `HttpAuthorizationGate.sellers()`, on a gate made with `forCaller`, sends no `X-Caller-Authorization` header (a loopback server records the request) |
| T-API-01..04 (amended) | the route in `docs/l2-control.openapi.yaml`, its role, its statuses and the `SellerHosts` schema, with no `X-Caller-Authorization` parameter |
