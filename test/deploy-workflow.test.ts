// T-E2E-AZ deployment workflow gates (SPEC.md §3.1 Azure profile, FR-023, FR-024; specs/011 contracts/
// deploy-pipeline.md). Offline checks on .github/workflows/deploy-azure.yml: OIDC only, the gate order
// (nothing is promoted before the regression, chain check, smoke run and log scan pass), the rollback,
// and no secret-shaped literal. The live part of T-E2E-AZ is the workflow run itself (quickstart §4).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { findSecretShapes } from "../scripts/secret-scan-lib.js";

const FILE = ".github/workflows/deploy-azure.yml";
type Step = { id?: string; name?: string; if?: string; run?: string; uses?: string };
type Workflow = { permissions?: Record<string, string>; jobs: Record<string, { steps: Step[] }> };

/** The deploy-pipeline contract's steps 1–10, in order (3a is the first-deployment bootstrap). */
const ORDER = ["tests", "iac", "base", "build", "image-scan", "deploy", "wait-l2", "balance", "regression", "chain", "smoke", "log-scan", "promote"];

export function gateProblems(w: Workflow): string[] {
  const out: string[] = [];
  if (w.permissions?.["id-token"] !== "write" || w.permissions?.contents !== "read") out.push("permissions must be id-token: write, contents: read");
  const steps = Object.values(w.jobs)[0]?.steps ?? [];
  const at = (id: string) => steps.findIndex((s) => s.id === id);
  for (const id of ORDER) if (at(id) < 0) out.push(`missing step ${id}`);
  for (let i = 1; i < ORDER.length; i++) {
    if (at(ORDER[i - 1]!) >= 0 && at(ORDER[i]!) >= 0 && at(ORDER[i - 1]!) > at(ORDER[i]!)) out.push(`${ORDER[i - 1]} must run before ${ORDER[i]}`);
  }
  const promote = steps.find((s) => s.id === "promote");
  if (!promote?.run?.includes("traffic set")) out.push("promote must shift the agent's traffic");
  if (steps.slice(0, at("promote")).some((s) => s.run?.includes("traffic set"))) out.push("traffic moves before promote");
  const rollback = steps.find((s) => s.id === "rollback");
  if (!rollback?.if?.includes("failure()")) out.push("rollback must run on failure");
  if (rollback?.run?.includes("traffic")) out.push("rollback must not touch the agent's traffic");
  if (!rollback?.run?.includes("last-good")) out.push("rollback must redeploy last-good");
  if (at("rollback") !== steps.length - 1) out.push("rollback must be the last step");
  if (!steps.find((s) => s.id === "build")?.run?.includes("$IMAGE_TAG")) out.push("the image must be tagged with the commit");
  if (!steps.find((s) => s.id === "regression")?.run?.includes("job-regression")) out.push("the regression must run job-regression");
  return out;
}

describe("T-E2E-AZ deployment workflow gates", () => {
  const text = readFileSync(FILE, "utf8");
  const workflow = parse(text) as Workflow;

  it("T-E2E-AZ the workflow signs in with OIDC, runs every gate in order before promoting, and rolls back on failure", () => {
    expect(gateProblems(workflow)).toEqual([]);
    expect(text).toContain("IMAGE_TAG: ${{ github.sha }}");
    expect(text).not.toMatch(/secrets\./);
  });

  it("T-E2E-AZ the workflow holds no secret-shaped literal", () => {
    expect(findSecretShapes(text)).toEqual([]);
  });

  it("T-E2E-AZ must-fail: promoting before the regression is reported", () => {
    const steps = [...Object.values(workflow.jobs)[0]!.steps];
    const promote = steps.splice(steps.findIndex((s) => s.id === "promote"), 1)[0]!;
    steps.splice(steps.findIndex((s) => s.id === "regression"), 0, promote);
    const mutated = { ...workflow, jobs: { deploy: { steps } } };
    expect(gateProblems(mutated)).toContain("log-scan must run before promote");
  });
});
