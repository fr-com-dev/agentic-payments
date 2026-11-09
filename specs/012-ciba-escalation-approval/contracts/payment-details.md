# Contract: payment details shown to the approver

`src/layer2-control/payment-details.ts`, pure functions with no I/O and no clock. The inputs are the
`ESCALATED` entry (ID, `resourceKey`, `payTo`, `amount`), the requirement L2 chose (`asset`,
`network`, plus the whole object for the digest), the asset's `decimals`, and the new `requestId`.
**Nothing from `PaymentIntent.purpose` or any other agent text is ever an input (FR-005).**

## Reference code

`referenceCode(escalationId)`: the 8 hex characters right after `auth_`. For example,
`auth_3f9c2a1b-7d4e-…` gives `3f9c2a1b`. It is visibly the start of the ID that the operator views
and the agent's ESCALATED report show (US1).

## Requirement digest

`requirementDigest(req)` is the lowercase hex SHA-256 of `canonicalJSON(req)`, with
`canonicalJSON` from `ledger.ts`. `req` is the chosen `PaymentRequirements` object exactly as
offered.

## `authorization_details`

There is exactly one object, in Auth0's Guardian schema (research R4). The type must be registered
on the Auth0 API (quickstart §2).

```json
[
  {
    "type": "urn:auth0:schemas:authorization-details:v1:x402-payment",
    "instruction": "Approve this payment only if you expect it",
    "properties": {
      "amount_usdc":        { "display": true,  "name": "Amount (USDC)",      "display_order": 1,  "value": "0.05" },
      "pay_to":             { "display": true,  "name": "Payee",              "display_order": 2,  "value": "0x95Aca02416F949489C1128223B35fBBE8c04f057" },
      "resource":           { "display": true,  "name": "Resource",           "display_order": 3,  "value": "https://ca-seller-eastus2-dev.example/api/premium-report" },
      "network":            { "display": true,  "name": "Network",            "display_order": 4,  "value": "eip155:84532" },
      "reference":          { "display": true,  "name": "Reference",          "display_order": 5,  "value": "3f9c2a1b" },
      "escalation_id":      { "display": false, "name": "Escalation",         "display_order": 6,  "value": "auth_3f9c2a1b-7d4e-4a51-9c0e-2b8f6d1e9a77" },
      "request_id":         { "display": false, "name": "Request",            "display_order": 7,  "value": "apq_5b2c…" },
      "amount_atomic":      { "display": false, "name": "Amount (atomic)",    "display_order": 8,  "value": "50000" },
      "asset":              { "display": false, "name": "Asset",              "display_order": 9,  "value": "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
      "requirement_sha256": { "display": false, "name": "Requirement digest", "display_order": 10, "value": "9c1f…(64 hex)" }
    }
  }
]
```

Rules:
- **`instruction`** and every `name` are fixed strings in the code.
- **Values** are strings of at most 255 characters:
  - `amount_usdc` is `formatAtomic(amount, decimals)`, computed with BigInt (Principle VI);
  - `resource` is the `resourceKey` (origin + path, no query string). If it is longer than 255
    characters, it is cut to 252 and `...` is appended.
- **Limits**: 10 properties, nesting depth 3, and well under 5 KB. These are within Auth0's
  documented limits [D].
- **Equality**: the details L2 sent are recorded verbatim in `APPROVAL_REQUESTED.data.details`.
  An answer must be canonically equal to that record, not to a recomputation (FR-022).

## Binding message

Format: `Pay_<amount_usdc>_USDC_to_<payee short>[_for_<segment>]_#<referenceCode>`

- **`<payee short>`**: the first 6 characters of `payTo`, then `..`, then the last 4, as in
  `0x95Ac..f057`.
- **`<segment>`**: the last non-empty path segment of `resourceKey`.
  - Any character outside `A–Z a–z 0–9 + - _ . , : #` becomes `-`.
  - The segment is shortened so the whole message is at most 64 characters.
  - If nothing is left, the segment and the `_for_` before it are dropped.
- **Character set**: the whole message uses only `A–Z a–z 0–9 + - _ . , : #` (Auth0 allows no
  spaces), and it is at most 64 characters [A][G].
- **Example**: `Pay_0.05_USDC_to_0x95Ac..f057_for_premium-report_#3f9c2a1b` (58 characters).

The message alone carries the amount, a short payee, the resource segment and the reference. So
if Guardian shows only the message, the approver still has what SC-002 asks for (spec,
Assumptions).

## Tests (T-CIBA-02)

- Each of the rules above.
- A planted `purpose` string never appears in the form body.
- A long path and an odd character are sanitized.
- Every message from an amount × payee × path grid matches `^[A-Za-z0-9+\-_.,:#]{1,64}$`.
- `amount_usdc` for 1, 1000, 50 000 and 100 000 atomic units.
- The digest is stable across key order.
