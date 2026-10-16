# Contract: Policy module API (`src/layer2-control/policy.ts`)

```ts
import type { PaymentRequirements } from "@x402/core/types";
import type { PolicyViolation } from "../shared/contracts.js";
import type { SpendingMandate } from "./mandate.js";

export interface PolicyContext {
  nowMs: number;
  requestedUrl: string;
  challengeResourceUrl: string;
  sessionCommittedAtomic: bigint;
  dailyCommittedAtomic: bigint;
  authorizationsLastMinute: number;
  humanApprovedFor?: { payTo: string; amount: string; approvalId: string };
}

export type EvalStatus = "AUTHORIZED" | "DENIED" | "ESCALATE";

export function evaluateRequirement(
  req: PaymentRequirements, m: SpendingMandate, ctx: PolicyContext,
): { status: EvalStatus; violations: PolicyViolation[] };

export function decide(
  accepts: PaymentRequirements[], m: SpendingMandate, ctx: PolicyContext,
): { status: EvalStatus; chosen?: PaymentRequirements; violations: PolicyViolation[] };
```

Purity contract (INV-5), checked by review and by T-POL-02:
- Imports are limited to types, `./mandate.js` types and pure helpers.
- No `fs`, no `fetch`, no `Date.now()`, no `Math.random()`, no logging.
- Neither function mutates its inputs.
- The output is a function of the inputs only. Two calls with deep-equal inputs give
  deep-equal outputs.
