// T-E2E-AZ deployment workflow gates (SPEC.md §3.1 Azure profile, FR-023, FR-024; specs/011 contracts/
// deploy-pipeline.md). Offline checks on the deploy workflows: deploy-infra.yml (the platform and the
// sellers), deploy-layer.yml (one layer's shared steps) and its callers deploy-l1/l2/l3.yml. Checked:
// - OIDC only, and GitHub secrets limited to six identifiers and public addresses, never a credential;
// - one concurrency group for every pipeline;
// - the gate order: nothing is promoted before the regression, chain check, smoke run and log scan pass;
// - a gate is skipped only by an explicit first deployment of L2 or L3 (never of L1), and the infra run's
//   steps after the platform only by its first, platform-only run;
// - the rollback;
// - every image of scripts/image-closure.ts built by exactly one pipeline;
// - no secret-shaped literal.
// The live part of T-E2E-AZ is the workflow runs themselves (quickstart §4).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { IMAGES, type ImageName } from "../scripts/image-closure.js";
import { findSecretShapes } from "../scripts/secret-scan-lib.js";

const DIR = ".github/workflows";
type Step = { id?: string; name?: string; if?: string; run?: string; uses?: string; with?: Record<string, unknown> };
type Job = { steps?: Step[]; uses?: string; with?: Record<string, unknown>; secrets?: unknown };
type Workflow = {
  on?: {
    workflow_dispatch?: { inputs?: Record<string, unknown> };
    push?: { tags?: string[] };
    workflow_call?: { secrets?: Record<string, unknown> };
  };
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  env?: Record<string, string>;
  jobs: Record<string, Job>;
};
const read = (file: string) => parse(readFileSync(`${DIR}/${file}`, "utf8")) as Workflow;
const stepsOf = (w: Workflow) => Object.values(w.jobs)[0]?.steps ?? [];

/** The contract's steps, in order, for one layer (deploy-layer.yml) and for deploy-infra.yml. */
const LAYER_ORDER = ["tests", "iac", "platform", "build", "image-scan", "deploy", "wait", "balance", "regression", "chain", "smoke", "log-scan", "promote"];
const INFRA_ORDER = ["tests", "iac", "platform", "build", "image-scan", "deploy", "health", "balance", "regression", "chain", "log-scan", "promote"];
/** The only layer steps a first deployment skips. */
const FIRST_DEPLOYMENT_SKIPS = ["balance", "regression", "chain", "smoke", "promote"];
const SKIP_IF = "${{ !inputs.first-deployment }}";
/** The infra steps a platform-only run (the very first, before the vaults are seeded) skips: all after the platform. */
const PLATFORM_ONLY_SKIPS = INFRA_ORDER.slice(INFRA_ORDER.indexOf("build"));
const PLATFORM_ONLY_IF = "${{ !inputs.platform-only }}";
/** Each layer pipeline and the image it deploys; deploy-infra.yml deploys the seller's. */
const CALLERS: Record<string, ImageName> = { "deploy-l1.yml": "l1-agent", "deploy-l2.yml": "l2-control", "deploy-l3.yml": "l3-verifier" };
const GROUP = "deploy-azure";
/**
 * The only GitHub secrets a workflow may read: the deploy app's OIDC identifiers, the API app's client ID and
 * two public addresses. They are secrets only so the logs mask them; no credential is stored in GitHub.
 */
export const ALLOWED_SECRETS = ["AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_SUBSCRIPTION_ID", "AGENT_API_CLIENT_ID", "SELLER_PAY_TO", "PAYER_ADDRESS"];

function common(w: Workflow, order: string[]): string[] {
  const out: string[] = [];
  if (w.permissions?.["id-token"] !== "write" || w.permissions?.contents !== "read") out.push("permissions must be id-token: write, contents: read");
  const steps = stepsOf(w);
  const at = (id: string) => steps.findIndex((s) => s.id === id);
  for (const id of order) if (at(id) < 0) out.push(`missing step ${id}`);
  for (let i = 1; i < order.length; i++) {
    if (at(order[i - 1]!) >= 0 && at(order[i]!) >= 0 && at(order[i - 1]!) > at(order[i]!)) out.push(`${order[i - 1]} must run before ${order[i]}`);
  }
  const rollback = steps.find((s) => s.id === "rollback");
  if (!rollback?.if?.includes("failure()")) out.push("rollback must run on failure");
  if (rollback?.run?.includes("traffic")) out.push("rollback must not touch the agent's traffic");
  if (!rollback?.run?.includes("last-good")) out.push("rollback must redeploy last-good");
  if (at("rollback") !== steps.length - 1) out.push("rollback must be the last step");
  if (!steps.find((s) => s.id === "build")?.run?.includes("$IMAGE_TAG") || w.env?.IMAGE_TAG !== "${{ github.sha }}") out.push("the image must be tagged with the commit");
  if (!steps.find((s) => s.id === "promote")?.run?.includes(":last-good")) out.push("promote must record last-good");
  if (!/job-regression/.test(steps.find((s) => s.id === "regression")?.run ?? "")) out.push("the regression must run job-regression");
  return out;
}

/** deploy-layer.yml: the shared steps of one layer. */
export function layerProblems(w: Workflow): string[] {
  const out = common(w, LAYER_ORDER);
  const steps = stepsOf(w);
  const at = (id: string) => steps.findIndex((s) => s.id === id);
  if (!steps.find((s) => s.id === "promote")?.run?.includes("traffic set")) out.push("promote must shift the agent's traffic");
  if (steps.slice(0, at("promote")).some((s) => s.run?.includes("traffic set"))) out.push("traffic moves before promote");
  for (const s of steps) {
    const skippable = FIRST_DEPLOYMENT_SKIPS.includes(s.id ?? "");
    if (skippable && s.if !== SKIP_IF) out.push(`${s.id} must run unless first-deployment`);
    if (!skippable && s.id !== "rollback" && s.if !== undefined) out.push(`${s.id ?? s.uses} may not be skipped`);
  }
  const build = steps.find((s) => s.id === "build")?.run ?? "";
  if (!build.includes('-f "docker/$IMAGE.Dockerfile"') || !build.includes("/x402-$IMAGE:$IMAGE_TAG")) out.push("build must build x402-<image> from docker/<image>.Dockerfile");
  if (w.env?.TEMPLATE !== "infra/${{ inputs.image }}.bicep" || !steps.find((s) => s.id === "deploy")?.run?.includes('--template-file "$TEMPLATE"')) out.push("deploy must deploy infra/<image>.bicep");
  return out;
}

/** deploy-infra.yml: the platform, then the seller's image and the sellers. */
export function infraProblems(w: Workflow): string[] {
  const out = common(w, INFRA_ORDER);
  const steps = stepsOf(w);
  if (w.concurrency?.group !== GROUP || w.concurrency["cancel-in-progress"] !== false) out.push(`concurrency must be group ${GROUP} without cancelling`);
  for (const s of steps) {
    const skippable = PLATFORM_ONLY_SKIPS.includes(s.id ?? "");
    if (skippable && s.if !== PLATFORM_ONLY_IF) out.push(`${s.id} must run unless platform-only`);
    if (!skippable && s.id !== "rollback" && s.if !== undefined) out.push(`${s.id ?? s.uses} may not be skipped`);
  }
  if (!steps.find((s) => s.id === "platform")?.run?.includes("--template-file infra/main.bicep")) out.push("platform must deploy infra/main.bicep");
  const build = steps.find((s) => s.id === "build")?.run ?? "";
  if (!build.includes(`-f ${IMAGES.seller.dockerfile} `) || !build.includes("/x402-seller:$IMAGE_TAG")) out.push(`build must build x402-seller from ${IMAGES.seller.dockerfile}`);
  if (!steps.find((s) => s.id === "deploy")?.run?.includes("--template-file infra/seller.bicep")) out.push("deploy must deploy infra/seller.bicep");
  if (steps.some((s) => s.run?.includes("traffic"))) out.push("deploy-infra must not touch the agent's traffic");
  return out;
}

/** deploy-l1/l2/l3.yml: manual or tag triggers, the shared group, and the layer's own image. */
export function callerProblems(file: string, w: Workflow, image: ImageName): string[] {
  const out: string[] = [];
  const short = file.replace(/^deploy-|\.yml$/g, "");
  if (!w.on?.workflow_dispatch || JSON.stringify(w.on.push?.tags) !== JSON.stringify([`deploy-${short}-*`])) out.push(`${file} must run by hand or on deploy-${short}-* tags only`);
  if (w.permissions?.["id-token"] !== "write" || w.permissions?.contents !== "read") out.push(`${file}: permissions must be id-token: write, contents: read`);
  if (w.concurrency?.group !== GROUP || w.concurrency["cancel-in-progress"] !== false) out.push(`${file}: concurrency must be group ${GROUP} without cancelling`);
  const job = Object.values(w.jobs)[0];
  if (job?.uses !== "./.github/workflows/deploy-layer.yml" || job.with?.image !== image) out.push(`${file} must deploy ${image} through deploy-layer.yml`);
  const firstDeployment = "first-deployment" in (job?.with ?? {}) || "first-deployment" in (w.on?.workflow_dispatch?.inputs ?? {});
  if (image === "l1-agent" && firstDeployment) out.push(`${file}: L1 never skips its gates (no first-deployment)`);
  for (const path of [`infra/${image}.bicep`, `infra/params/dev-${image}.bicepparam`, IMAGES[image].dockerfile]) if (!existsSync(path)) out.push(`${file}: ${path} is missing`);
  if (IMAGES[image].dockerfile !== `docker/${image}.Dockerfile`) out.push(`${file}: ${image}'s Dockerfile is not docker/${image}.Dockerfile`);
  return out;
}

/** Secrets are only the allowed identifiers; Azure sign-in is OIDC; the layer callers pass them on. */
export function secretProblems(file: string, text: string, w: Workflow): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\$\{\{\s*secrets\.([A-Za-z0-9_]+)/g)) {
    if (!ALLOWED_SECRETS.includes(m[1]!)) out.push(`${file} reads secret ${m[1]}, which is not an allowed identifier`);
  }
  if (/\$\{\{\s*vars\./.test(text)) out.push(`${file} reads vars.*: the identifiers are GitHub secrets`);
  for (const s of stepsOf(w).filter((x) => x.uses?.startsWith("azure/login@"))) {
    if (JSON.stringify(Object.keys(s.with ?? {}).sort()) !== JSON.stringify(["client-id", "subscription-id", "tenant-id"])) {
      out.push(`${file}: azure/login must sign in with OIDC only (client-id, tenant-id, subscription-id)`);
    }
  }
  const job = Object.values(w.jobs)[0];
  if (job?.uses !== undefined && job.secrets !== "inherit") out.push(`${file} must pass its secrets with secrets: inherit`);
  const declared = w.on?.workflow_call?.secrets;
  if (w.on?.workflow_call !== undefined && JSON.stringify(Object.keys(declared ?? {}).sort()) !== JSON.stringify([...ALLOWED_SECRETS].sort())) {
    out.push(`${file} must declare exactly the allowed secrets`);
  }
  return out;
}

/** The operator job runs from the L2 image, so each command it is started with must be one of its entries. */
export function operatorProblems(file: string, w: Workflow): string[] {
  const out: string[] = [];
  for (const s of stepsOf(w)) {
    for (const m of (s.run ?? "").matchAll(/job-operator node (\S+)/g)) {
      const entry = m[1]!.replace(/^dist\//, "").replace(/\.js$/, ".ts");
      if (!IMAGES["l2-control"].entries.includes(entry)) out.push(`${file} ${s.id}: job-operator runs ${m[1]}, which the l2-control image doesn't contain`);
    }
  }
  return out;
}

describe("T-E2E-AZ deployment workflow gates", () => {
  const files = readdirSync(DIR).sort();
  const layer = read("deploy-layer.yml");
  const infra = read("deploy-infra.yml");

  it("T-E2E-AZ the workflows are the infra pipeline, the shared layer steps and one pipeline per layer", () => {
    expect(files).toEqual(["deploy-infra.yml", "deploy-l1.yml", "deploy-l2.yml", "deploy-l3.yml", "deploy-layer.yml"]);
    expect([...Object.values(CALLERS), "seller"].sort()).toEqual(Object.keys(IMAGES).sort());
  });

  it("T-E2E-AZ each layer run signs in with OIDC, runs every gate in order before promoting, and rolls back on failure", () => {
    expect(layerProblems(layer)).toEqual([]);
    for (const [file, image] of Object.entries(CALLERS)) expect(callerProblems(file, read(file), image)).toEqual([]);
  });

  it("T-E2E-AZ the infra run deploys the platform, then the sellers, and repeats the regression before promoting", () => {
    expect(infraProblems(infra)).toEqual([]);
  });

  it("T-E2E-AZ the workflows read only the allowed identifier secrets, sign in with OIDC, hold no secret-shaped literal, and run only L2 commands on job-operator", () => {
    for (const file of files) {
      const text = readFileSync(`${DIR}/${file}`, "utf8");
      expect(secretProblems(file, text, read(file))).toEqual([]);
      expect(findSecretShapes(text), file).toEqual([]);
      expect(operatorProblems(file, read(file))).toEqual([]);
    }
  });

  it("T-E2E-AZ must-fail: promoting before the regression is reported", () => {
    const steps = [...stepsOf(layer)];
    const promote = steps.splice(steps.findIndex((s) => s.id === "promote"), 1)[0]!;
    steps.splice(steps.findIndex((s) => s.id === "regression"), 0, promote);
    expect(layerProblems({ ...layer, jobs: { deploy: { steps } } })).toContain("log-scan must run before promote");
  });

  it("T-E2E-AZ must-fail: a regression skipped by any other condition is reported", () => {
    const steps = stepsOf(layer).map((s) => (s.id === "regression" ? { ...s, if: "${{ false }}" } : s));
    expect(layerProblems({ ...layer, jobs: { deploy: { steps } } })).toContain("regression must run unless first-deployment");
  });

  it("T-E2E-AZ must-fail: an infra regression skipped by any other condition is reported", () => {
    const steps = stepsOf(infra).map((s) => (s.id === "regression" ? { ...s, if: "${{ false }}" } : s));
    expect(infraProblems({ ...infra, jobs: { deploy: { steps } } })).toContain("regression must run unless platform-only");
  });

  it("T-E2E-AZ must-fail: a first deployment of L1 is reported", () => {
    const w = read("deploy-l1.yml");
    const job = Object.values(w.jobs)[0]!;
    const mutated = { ...w, jobs: { deploy: { ...job, with: { ...job.with, "first-deployment": true } } } };
    expect(callerProblems("deploy-l1.yml", mutated, "l1-agent")).toContain("deploy-l1.yml: L1 never skips its gates (no first-deployment)");
  });

  it("T-E2E-AZ must-fail: a layer pipeline deploying another layer's image is reported", () => {
    const w = read("deploy-l2.yml");
    const job = Object.values(w.jobs)[0]!;
    const mutated = { ...w, jobs: { deploy: { ...job, with: { ...job.with, image: "l1-agent" } } } };
    expect(callerProblems("deploy-l2.yml", mutated, "l2-control")).toContain("deploy-l2.yml must deploy l2-control through deploy-layer.yml");
  });

  it("T-E2E-AZ must-fail: an infra run that doesn't build the seller's image is reported", () => {
    const steps = stepsOf(infra).map((s) => (s.id === "build" ? { ...s, run: s.run!.replaceAll("-f Dockerfile", "-f docker/l1-agent.Dockerfile") } : s));
    expect(infraProblems({ ...infra, jobs: { deploy: { steps } } })).toContain("build must build x402-seller from Dockerfile");
  });

  it("T-E2E-AZ must-fail: a credential read from GitHub secrets, or a sign-in with a client secret, is reported", () => {
    const text = readFileSync(`${DIR}/deploy-layer.yml`, "utf8").replace("${{ secrets.PAYER_ADDRESS }}", "${{ secrets.PAYER_PRIVATE_KEY }}");
    expect(secretProblems("deploy-layer.yml", text, layer)).toContain("deploy-layer.yml reads secret PAYER_PRIVATE_KEY, which is not an allowed identifier");
    const steps = stepsOf(infra).map((s) => (s.uses?.startsWith("azure/login@") ? { ...s, with: { ...s.with, "client-secret": "${{ secrets.AZURE_CLIENT_SECRET }}" } } : s));
    expect(secretProblems("deploy-infra.yml", "", { ...infra, jobs: { deploy: { steps } } })).toContain(
      "deploy-infra.yml: azure/login must sign in with OIDC only (client-id, tenant-id, subscription-id)",
    );
  });

  it("T-E2E-AZ must-fail: starting job-operator with a command the L2 image doesn't contain is reported", () => {
    const steps = stepsOf(layer).map((s) => (s.id === "chain" ? { ...s, run: s.run!.replace("node dist/scripts/ledger-verify.js", "node dist/src/main.js") } : s));
    expect(operatorProblems("deploy-layer.yml", { ...layer, jobs: { deploy: { steps } } })).toContain(
      "deploy-layer.yml chain: job-operator runs dist/src/main.js, which the l2-control image doesn't contain",
    );
  });
});
