# Contract: Operator approve CLI (`scripts/approve.ts`)

## Invocation

```bash
ENV_FILE=env/operator.env npm run approve -- <authorizationId> [approver]
```

| Argument | Required | Notes |
|---|---|---|
| `authorizationId` | yes | the ID the agent reported for an ESCALATED payment |
| `approver` | no | the name recorded in the ledger; defaults to `"operator"` |

## Environment (`env/operator.env`, template `env/operator.env.example`)

| Variable | Required | Notes |
|---|---|---|
| `CONTROL_URL` | yes | e.g. `http://127.0.0.1:4020` |
| `OPERATOR_TOKEN` | yes | the operator credential; never shared with L1 or L3 |

The CLI MUST NOT read or require `PAYER_PRIVATE_KEY`, `CONTROL_TOKEN`, `VERIFIER_TOKEN`,
`SETTLEMENT_TOKEN` or `ANTHROPIC_API_KEY`.

## Behavior

1. With no `authorizationId`, print usage and exit 2.
2. Send `POST {CONTROL_URL}/v1/approvals/{authorizationId}` with body `{ approver }`, as
   specified in [approvals-api.md](approvals-api.md).
3. Print the JSON response.

## Exit codes

| Condition | Exit | Output |
|---|---|---|
| 200 | 0 | `{ ok, approvalId, expiresAt }` |
| 401 / 404 / 400 | 1 | the HTTP status and the error body |
| L2 unreachable | 1 | the network error message |
| Missing argument | 2 | usage |
