// RegressionBaseline (008 data-model, T027): the scripted plan's expected result under the default
// mandate and catalog (SPEC.md §8.1 L1-4, §12 T-E2E-01). Shared by test/e2e.local.test.ts and
// scripts/demo-local.ts. It has no imports so the demo can load it without the test harness.

export const RegressionBaseline = {
  outcomes: ["FREE", "PAID", "PAID", "ESCALATED", "DENIED", "DENIED"],
  onChainDeltaAtomic: "6000",
  confirmedSettlements: 2,
  ledgerChainOk: true,
  spentOrReservedAtomic: "6000",
} as const;
