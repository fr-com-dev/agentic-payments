# Quickstart: validate Human-in-the-Loop Approval (004)

## Prerequisites

- Node.js 22. Run `npm install`.
- Features 001, 002, 003, 005 and 006 are implemented, so the escalation and paid retry run
  end to end.
- Copy `env/operator.env.example` to `env/operator.env`. It must hold only `CONTROL_URL` and
  `OPERATOR_TOKEN`.
- Mandate defaults (CFG-3): auto-approve 20000, hard cap 100000, session budget 100000.

## 1. Policy unit checks (T-POL-13)

```bash
npx vitest run test/policy.test.ts -t "T-POL-13"
```

Expected:
- 50000 with no approval returns `ESCALATE` / `human_approval_required`.
- A matching `humanApprovedFor` returns `AUTHORIZED`.
- A different amount returns `ESCALATE`.
- An approval combined with a DENY violation returns `DENIED`.

## 2. End-to-end HITL (T-E2E-02)

```bash
npx vitest run test/e2e.local.test.ts -t "T-E2E-02"
```

Expected, in this order:
1. The first request is ESCALATED and returns an `authorizationId`.
2. An approval with the **agent** token returns 401, and the ledger has no `HUMAN_APPROVAL`.
3. An approval with the **operator** token returns 200 with `{ok, approvalId, expiresAt}`.
4. The repeated request is PAID and CONFIRMED, and its `AUTHORIZED.approvalRef` equals the
   returned `approvalId`.
5. The same request once more is ESCALATED again (the approval was consumed).
6. Two approvals of one escalation allow exactly two payments; a third request escalates.

## 3. Manual run against the local stack

```bash
npm run demo:local           # step 4 prints ESCALATED with an authorizationId
# while the L2 service is running:
ENV_FILE=env/operator.env npm run approve -- <authorizationId> alice
```

Expected:
- The command prints `{ ok: true, approvalId, expiresAt }` (about 10 minutes ahead) and exits 0.
- An unknown ID prints 404 and exits 1.
- `GET /v1/ledger/verify` with the operator token returns `ok: true`. The ledger shows
  `ESCALATED` → `HUMAN_APPROVAL` (approver `alice`) → `AUTHORIZED` (`approvalRef`).

## 4. Safety mechanism must fail without the control (Principle VIII)

Temporarily drop the "consumed" filter (step 3 of `findOpenApproval` in
[data-model.md](data-model.md)) and rerun T-E2E-02. Step 5 must now **fail**, because the
repeat is PAID and not ESCALATED. Restore the filter afterwards.

Contracts: [approvals-api.md](contracts/approvals-api.md), [approve-cli.md](contracts/approve-cli.md).
