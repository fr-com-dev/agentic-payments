# Contract: Operator commands (SPEC §13 delta)

Both commands load only the operator environment (`loadEnv("operator")`; default
`env/operator.env`, override with `ENV_FILE`). They read only `CONTROL_URL` and the operator token
(`tokenFor("operator")`), import only `src/shared/*`, and never reference `PAYER_PRIVATE_KEY` or
another role's token. The existing static test pattern for `scripts/approve.ts` applies to both.

## npm run reject -- &lt;authorizationId&gt; [operator] [reason…]

- Sends `POST {CONTROL_URL}/v1/rejections/:authorizationId` with `{ operator?, reason? }`. `reason`
  is the remaining arguments joined by single spaces, omitted when there are none.
- Exit codes:

| Exit | When | Output |
|---|---|---|
| 0 | HTTP 200 | the JSON response on stdout |
| 1 | an HTTP error (400, 401, 404, 409) | `reject: HTTP <status> <body>` on stderr |
| 1 | the network is unreachable | `reject: control service unreachable at <url>: <msg>` on stderr |
| 2 | no `authorizationId` | `usage: npm run reject -- <authorizationId> [operator] [reason]` on stderr |

## npm run escalations [-- --watch]

- **List mode**: `GET /v1/escalations`. It prints one line per pending escalation:
  `PENDING <authorizationId> session=<id> resource=<resourceKey> payTo=<addr> amount=<atomic> expiresAt=<ISO>`.
  When there are none, it prints `no pending escalations`. Exit 0, or 1 on an HTTP or network
  error.
- **Watch mode** (`--watch`):
  1. It prints the pending list.
  2. Every 1000 ms it calls `GET /v1/escalations/events?after=<cursor>` and prints one line per
     event: `<KIND> <authorizationId> session=<id> resource=<resourceKey> amount=<atomic>` plus the
     kind's fields, for example `DENIED auth_… … rejectionId=rej_… operator=alice reason="too expensive"`.
  3. It advances the cursor.
  4. On an HTTP or network error it prints `escalations: <msg> (retrying)` once per failure streak
     and keeps polling.
  5. SIGINT or SIGTERM exits 0.
- **Timing**: a recorded event is printed within 5 s (FR-021). Polling every 1 s plus the 1 s
  sweep gives at most about 2 s.
