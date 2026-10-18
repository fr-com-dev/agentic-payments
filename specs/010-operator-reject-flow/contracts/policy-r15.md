# Contract: Policy rule R15 `human_rejected` (SPEC L2-2 delta)

## Context field

```ts
humanRejected?: { rejectionId: string }
```

`service.ts` sets it inside the serialized authorize section, from
`findRejection(ledger.entries(), sessionId, resourceKey(intent.resourceUrl))`. It is present if and
only if a `HUMAN_REJECTION` exists for that (session, resource key), whatever the amount or payee.
The policy never reads the ledger, the clock or any free text (INV-5).

## Rule row (SPEC §8.2 table; evaluated after R13, before the DENIED return)

| # | Rule ID | Condition for violation | Effect |
|---|---|---|---|
| R15 | `human_rejected` | `ctx.humanRejected` is present | DENY |

- It is collected with the R1–R13 violations; evaluation does not stop at it, so every violated rule
  is listed.
- R9 (`amount_invalid`) still returns immediately, before R15, as it does for every other rule.
- Because R14 runs only when there is no DENY, a rejected session and resource can never escalate,
  and no approval can lift it (INV-12, FR-013).
- Detail: `rejected by the operator (<rejectionId>)`. It **never** contains the operator label or
  the reason, because the detail reaches the LLM agent (SEC-12).

## Tests (T-POL-15)

| Case | Expectation |
|---|---|
| a 50000 request with `humanRejected`, all else valid | DENIED with exactly `["human_rejected"]` |
| a 5000 request (below auto-approve) with `humanRejected` | DENIED `["human_rejected"]` |
| `humanRejected` together with a matching `humanApprovedFor` | DENIED `["human_rejected"]`; the approval does not apply |
| `humanRejected` and over the session budget | DENIED; the rules include both `session_budget_exceeded` and `human_rejected` |
| no `humanRejected` (the must-fail control) | the same 50000 request is ESCALATE `human_approval_required` |
| detail text | matches `/^rejected by the operator \(rej_[\w-]+\)$/` and contains neither the label nor the reason |
