# Contract: L2 ledger endpoints (L2-5, owned by 003)

The L2 control service binds to `127.0.0.1:${CONTROL_PORT:-4020}`. Other L2 endpoints are
owned elsewhere:
- `/v1/authorize` and `/v1/budget`: see
  [../../002-spending-policy-authorization/contracts/](../../002-spending-policy-authorization/contracts/)
- `/v1/approvals`: see
  [../../004-human-approval-escalation/contracts/](../../004-human-approval-escalation/contracts/)

## `POST /v1/reconcile`

| Item | Value |
|---|---|
| Caller | L3 verifier only (feature 005), through `ReconciliationPort` |
| Auth | `Authorization: Bearer ${SETTLEMENT_TOKEN}`, enforced by `requireRole("verifier-control")` (007) before body parsing. Any other token returns **401**, and nothing is appended. |
| Body | `SettlementReport` (SPEC.md §7) |
| 200 | `{ "ok": true, "anomaly": boolean }` |
| 400 | Malformed body: `authorizationId` or any of `verified.{asset, payer, payTo, amount}` is missing. Nothing is appended. |
| 404 | No AUTHORIZED entry exists for `authorizationId`. Nothing is appended. |
| 401 | Missing or wrong token, including `CONTROL_TOKEN` and `OPERATOR_TOKEN` (T-E2E-05) |

Example (a forged amount after CONFIRMED):

```http
POST /v1/reconcile
Authorization: Bearer dev-settlement-token

{"authorizationId":"auth_…","status":"CONFIRMED","transaction":"0xabc…","network":"eip155:31337",
 "finalityClass":"included","detail":"ok","observedAt":"2026-10-16T12:00:00Z",
 "verified":{"asset":"0x…","payer":"0x…","payTo":"0x…","amount":"999"}}
```

The response is `{"ok":true,"anomaly":true}`. The stored entry has `status:"MISMATCH"` and a
detail naming `amount`. The effective status stays CONFIRMED.

## `GET /v1/ledger/verify`

| Item | Value |
|---|---|
| Caller | Human operator |
| Auth | `Bearer ${OPERATOR_TOKEN}`. Any other token returns **401**. |
| 200 | `{ "entries": number, "ok": boolean, "brokenAt"?: number }` |

`brokenAt` is the 0-based line index of the first line that fails to parse, recompute its hash,
or link to the previous hash. On an untampered prefix it equals that entry's `seq`.
