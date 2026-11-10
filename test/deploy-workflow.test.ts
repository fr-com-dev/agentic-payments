// T-E2E-AZ deployment workflow gates (SPEC.md §3.1 Azure profile, FR-023, FR-024; specs/011 contracts/
// deploy-pipeline.md). Offline checks on the six pipelines in .github/workflows (deploy-infra.yml for the platform,
// deploy-l1/l2/l3/operator/seller.yml for one unit each), on deploy.yml, the steps they all call with their unit, and
// on the infra scripts. Checked:
// - one pipeline per unit, and nothing else in the folder but the Auth0 tenant's pipeline (provision-auth0.yml, which
//   T-IAC-02 checks; the only workflow that reads GitHub secrets, and only its own three): each runs by hand or on its own tag, holds the one
//   concurrency group, and only calls deploy.yml with its unit; each image of scripts/image-closure.ts is built by
//   exactly one pipeline;
// - OIDC only, with the sign-in, target and resource names compiled from infra/main.<environment>.bicepparam by the
//   pinned Bicep CLI: no GitHub secret or variable; each step that calls Azure signs in first with a fresh GitHub
//   token, which is valid for 5 minutes (one azure/login failed with AADSTS700024 after the platform's deployment),
//   and the token request retries a transient answer (it is run against a local endpoint that answers 503 once);
// - Azure provisioned by Bicep only: every az command is a Bicep deployment (each previewed with what-if), a read,
//   a job start, an image copy or (in infra/cleanup.sh) a deletion, and infra/ holds two scripts only
//   (github-setup.sh, cleanup.sh);
// - the gate order: nothing is promoted before the regression, chain check, smoke run and log scan pass; a step is
//   skipped only by a platform run (the image steps, the promotion, the rollback) or a first deployment (the
//   checks through the other units); a failure inside a pipe fails its step;
// - step 0 first maps the unit to its image and refuses inputs that don't belong to it, before anything else (the
//   guard itself is run, for every combination of unit and inputs);
// - each job runs its own command: the deploy identity never starts the operator job with another;
// - the rollback, of the run's unit only;
// - no resource name hard-coded;
// - no secret-shaped literal.
// The live part of T-E2E-AZ is the workflow runs themselves (quickstart §4).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { IMAGES, type ImageName } from "../scripts/image-closure.js";
import { findSecretShapes } from "../scripts/secret-scan-lib.js";
import { BICEP_PATH, buildParams, leaves } from "./helpers/bicep.js";

const DIR = ".github/workflows";
/** The steps every pipeline runs, a reusable workflow. */
const SHARED = "deploy.yml";
type Step = { id?: string; name?: string; if?: string; run?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string> };
type Job = { environment?: string; steps?: Step[]; uses?: string; with?: Record<string, unknown>; secrets?: unknown; permissions?: unknown };
type Workflow = {
  name?: string;
  on?: {
    workflow_dispatch?: { inputs?: Record<string, unknown> };
    workflow_call?: { inputs?: Record<string, { type?: string; required?: boolean; default?: unknown }> };
    push?: { tags?: string[]; branches?: string[]; paths?: string[] };
    [trigger: string]: unknown;
  };
  permissions?: Record<string, string>;
  defaults?: { run?: { shell?: string } };
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  env?: Record<string, string>;
  jobs: Record<string, Job>;
};
const read = (file: string) => parse(readFileSync(`${DIR}/${file}`, "utf8")) as Workflow;
const stepsOf = (w: Workflow) => Object.values(w.jobs)[0]?.steps ?? [];
const withSteps = (w: Workflow, steps: Step[]): Workflow => ({ ...w, jobs: { deploy: { ...Object.values(w.jobs)[0], steps } } });

type Unit = "platform" | "l1" | "l2" | "l3" | "operator" | "seller";
/**
 * The pipelines: the unit each deploys (main.bicep's `unit`) and the inputs it offers. Every unit but L1 has a first
 * deployment, for a new environment (L1 runs last, through every check); only the platform takes seed-ip and
 * recover-vaults.
 */
const PIPELINES: Record<string, { unit: Unit; inputs: string[] }> = {
  "deploy-infra.yml": { unit: "platform", inputs: ["environment", "first-deployment", "recover-vaults", "seed-ip"] },
  "deploy-l1.yml": { unit: "l1", inputs: ["environment"] },
  "deploy-l2.yml": { unit: "l2", inputs: ["environment", "first-deployment"] },
  "deploy-l3.yml": { unit: "l3", inputs: ["environment", "first-deployment"] },
  "deploy-operator.yml": { unit: "operator", inputs: ["environment", "first-deployment"] },
  "deploy-seller.yml": { unit: "seller", inputs: ["environment", "first-deployment"] },
};
/** The Auth0 tenant's pipeline (Terraform, auth0/): checked by T-IAC-02 (test/auth0-iac.test.ts), not here. */
const AUTH0 = "provision-auth0.yml";
/** The only GitHub secrets a workflow reads: the Auth0 pipeline's, from its own GitHub environment. */
const AUTH0_SECRETS = ["AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "AUTH0_L2_CLIENT_SECRET"];
const FILES = [SHARED, AUTH0, ...Object.keys(PIPELINES)].sort();
/** The image each unit's run builds, promotes and rolls back; the platform has none. */
const UNIT_IMAGES: Record<Exclude<Unit, "platform">, ImageName> = { l1: "l1-agent", l2: "l2-control", l3: "l3-verifier", operator: "operator", seller: "seller" };
/** What each pipeline passes to deploy.yml: its unit, its environment, and each input it offers. */
const PASSED: Record<string, string> = {
  environment: "${{ inputs.environment || 'dev' }}",
  "first-deployment": "${{ inputs.first-deployment || false }}",
  "seed-ip": "${{ inputs.seed-ip || '' }}",
  "recover-vaults": "${{ inputs.recover-vaults || false }}",
};
/** deploy.yml's inputs. */
const SHARED_INPUTS = ["environment", "first-deployment", "recover-vaults", "seed-ip", "unit"];

/** deploy.yml's steps, in order (contracts/deploy-pipeline.md), and when each runs; the rollback is the last. */
const ORDER = ["target", "tests", "build", "image-scan", "deploy", "wait", "balance", "regression", "chain", "smoke", "log-scan", "promote"];
const NOT_PLATFORM = "${{ inputs.unit != 'platform' }}";
const CHECKS = "${{ !inputs.first-deployment }}";
const STEP_IF: Record<string, string | undefined> = {
  build: NOT_PLATFORM,
  "image-scan": NOT_PLATFORM,
  // A unit always waits for its own apps; the platform waits for the units, which a first deployment doesn't have.
  wait: "${{ inputs.unit != 'platform' || !inputs.first-deployment }}",
  balance: CHECKS,
  regression: CHECKS,
  chain: CHECKS,
  smoke: CHECKS,
  "log-scan": CHECKS,
  promote: "${{ inputs.unit != 'platform' && !inputs.first-deployment }}",
  rollback: "failure() && inputs.unit != 'platform' && (steps.deploy.outcome == 'success' || steps.deploy.outcome == 'failure')",
};
const PERMISSIONS = JSON.stringify({ "id-token": "write", contents: "read" });
/**
 * The sign-in every step that calls Azure starts with (`eval "$SIGN_IN"`): a fresh GitHub OIDC token (GitHub's are
 * valid for 5 minutes, and az can't renew one), the CLI's cached tokens cleared, then the deploy app, tenant and
 * subscription the target step read from the parameter file. No secret, no password. The token request retries a
 * transient answer: one 503 from GitHub failed run 42158206985 (signInRetryProblems runs it against a local server).
 */
const SIGN_IN = [
  'oidc=$(curl -fsS --retry 5 --retry-max-time 120 --max-time 30 -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=api://AzureADTokenExchange" | jq -er .value)',
  "az account clear",
  'az login --service-principal -u "$DEPLOY_CLIENT_ID" -t "$TENANT_ID" --federated-token "$oidc" -o none',
  'az account set -s "$SUBSCRIPTION_ID"',
  "",
].join("\n");
/** What the target step reads from the compiled parameter file: its outputs, the sign-in, and the names the steps use. */
const TARGET_OUTPUTS = ["authAudience", "payerAddress"];
const TARGET_SIGN_IN = [
  ["TENANT_ID", "tenantId"],
  ["SUBSCRIPTION_ID", "subscriptionId"],
  ["DEPLOY_CLIENT_ID", "deployClientId"],
];
const TARGET_NAMES = ["RG=", "LOG_X402=", "CR_X402=", "CA_L1=", "CA_L3=", "CA_SELLER=", "CA_SELLER_ALIAS=", "CAJ_L1=", "CAJ_L2="];
/** The inputs step 0's guard reads, as environment variables: an input is never pasted into a script. */
const TARGET_INPUTS = JSON.stringify({
  INPUT_FIRST_DEPLOYMENT: "${{ inputs.first-deployment }}",
  INPUT_SEED_IP: "${{ inputs.seed-ip }}",
  INPUT_RECOVER_VAULTS: "${{ inputs.recover-vaults }}",
});
/** Step 0's guard ends where the Bicep CLI download begins: nothing is fetched or deployed before it. */
const GUARD_END = 'mkdir -p "$RUNNER_TEMP/bicep"';
/**
 * Whether step 0 refuses a unit with these inputs: seed-ip and recover-vaults belong to the platform; recover-vaults
 * follows infra/cleanup.sh, so the units are gone (a first deployment); L1 is deployed last, through every check. A
 * tag has no inputs, so it is a run with none set.
 */
const refused = (unit: string, first: boolean, seedIp: string, recover: boolean) =>
  !(unit in PIPELINES_BY_UNIT) || (unit !== "platform" && (seedIp !== "" || recover)) || (recover && !first) || (unit === "l1" && first);
const PIPELINES_BY_UNIT = Object.fromEntries(Object.entries(PIPELINES).map(([f, p]) => [p.unit, f]));
/** The only shell scripts in infra/: what Bicep can't do (the GitHub environment) and the clean-up. */
const INFRA_SCRIPTS = ["cleanup.sh", "github-setup.sh"];
/**
 * The az commands a workflow or infra script may run: Bicep deployments, reads, job runs, image copies, the
 * runner's sign-in (login, and the CLI's own account cache: set, clear), and (in infra/cleanup.sh only) deletions.
 * Anything that creates or changes a resource otherwise is provisioning outside Bicep.
 */
const AZ_READS = /^az (account (show|get-access-token|set|clear)|login|bicep build-params|acr (login|show|repository show-tags|import)|containerapp (show|revision (list|show)|job (show|start|execution show|logs show))|monitor log-analytics (query|workspace show)|deployment group (what-if|create)|group exists|resource list|keyvault (list|list-deleted)|cognitiveservices account (list|list-deleted)|ad (app|sp|group) list|role assignment list|rest --method GET)\b/;
const AZ_DELETIONS = /^az (group delete|role assignment delete|ad (app|group) delete|cognitiveservices account purge|rest --method DELETE)\b/;

/** Every `az …` command line in a script, from the `az` on (comments and echoed text excluded). */
function azCommands(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => !/^\s*#/.test(l) && !/^\s*echo /.test(l))
    .flatMap((l) => [...l.matchAll(/(?:^|[\s$(|;&])(az [a-z][^|;)"]*)/g)].map((m) => m[1]!.trim()));
}

/** Provisioning outside Bicep: an az command that isn't a deployment, a read, a job run, an image copy or an allowed deletion. */
export function provisioningOutsideBicep(file: string, text: string, deletions = false): string[] {
  return azCommands(text)
    .filter((c) => !AZ_READS.test(c) && !(deletions && AZ_DELETIONS.test(c)))
    .map((c) => `${file} runs "${c.split(" ").slice(0, 4).join(" ")}": Azure is provisioned by Bicep only`);
}

/** The folder holds the six pipelines and deploy.yml, and the pipelines' units build every image exactly once. */
export function folderProblems(files: string[]): string[] {
  const out: string[] = [];
  if (JSON.stringify([...files].sort()) !== JSON.stringify(FILES)) out.push(`${DIR} must hold exactly ${FILES.join(", ")}: one pipeline per unit, the steps they share, and the Auth0 tenant's pipeline`);
  const built = Object.values(PIPELINES).flatMap((p) => (p.unit === "platform" ? [] : [UNIT_IMAGES[p.unit]]));
  if (JSON.stringify([...built].sort()) !== JSON.stringify(Object.keys(IMAGES).sort())) out.push("each image of scripts/image-closure.ts must be built by exactly one pipeline");
  return out;
}

/** A pipeline: its triggers and inputs, the concurrency group, and one call of deploy.yml with its unit, nothing else. */
export function pipelineProblems(file: string, w: Workflow): string[] {
  const out: string[] = [];
  const spec = PIPELINES[file];
  if (!spec) return [`${file} is not a pipeline`];
  const name = file.replace(/\.yml$/, "");
  const tag = `${name}-*`;
  if (w.name !== name) out.push(`${file} must be named ${name}`);
  const triggers = Object.keys(w.on ?? {}).sort();
  if (JSON.stringify(triggers) !== JSON.stringify(["push", "workflow_dispatch"]) || JSON.stringify(w.on?.push) !== JSON.stringify({ tags: [tag] })) {
    out.push(`${file} must run by hand or on ${tag} tags only`);
  }
  if (JSON.stringify(Object.keys(w.on?.workflow_dispatch?.inputs ?? {}).sort()) !== JSON.stringify(spec.inputs)) out.push(`${file}'s inputs must be ${spec.inputs.join(", ")}`);
  if (JSON.stringify(w.permissions) !== PERMISSIONS) out.push(`${file}'s permissions must be id-token: write, contents: read`);
  if (w.concurrency?.group !== "deploy-azure" || w.concurrency["cancel-in-progress"] !== false) out.push(`${file} must hold the concurrency group deploy-azure without cancelling: one deployment at a time, whichever the pipeline`);
  const jobs = Object.values(w.jobs ?? {});
  const job = jobs[0];
  if (jobs.length !== 1 || job?.uses !== `./${DIR}/${SHARED}` || job.steps !== undefined) out.push(`${file} must have one job, which calls ./${DIR}/${SHARED}`);
  const want = { unit: spec.unit, ...Object.fromEntries(spec.inputs.map((i) => [i, PASSED[i]])) };
  if (JSON.stringify(Object.entries(job?.with ?? {}).sort()) !== JSON.stringify(Object.entries(want).sort())) out.push(`${file} must pass ${SHARED} unit ${spec.unit} and its own inputs only`);
  if (job?.secrets !== undefined) out.push(`${file} passes secrets: the pipelines take every value from the parameter file`);
  return out;
}

/** deploy.yml: its inputs, sign-in, gate order, skips, deployments and rollback. */
export function workflowProblems(w: Workflow): string[] {
  const out: string[] = [];
  const steps = stepsOf(w);
  const at = (id: string) => steps.findIndex((s) => s.id === id);
  const step = (id: string) => steps.find((s) => s.id === id);
  if (JSON.stringify(Object.keys(w.on ?? {})) !== JSON.stringify(["workflow_call"])) out.push(`${SHARED} must only be called by the pipelines (workflow_call)`);
  if (JSON.stringify(Object.keys(w.on?.workflow_call?.inputs ?? {}).sort()) !== JSON.stringify(SHARED_INPUTS)) out.push(`${SHARED}'s inputs must be ${SHARED_INPUTS.join(", ")}`);
  if (JSON.stringify(w.permissions) !== PERMISSIONS) out.push("permissions must be id-token: write, contents: read");
  if (w.concurrency !== undefined || Object.values(w.jobs).some((j) => "concurrency" in j)) out.push(`${SHARED} must leave the concurrency group to the pipelines: a called workflow sharing it deadlocks with its caller`);
  if (Object.values(w.jobs)[0]?.environment !== "${{ inputs.environment }}") out.push("the job must run in the deploy environment's GitHub environment (the federated credential's subject)");
  if (w.env?.PARAMS !== "infra/main.${{ inputs.environment }}.bicepparam") out.push("PARAMS must be infra/main.<environment>.bicepparam");
  if (w.env?.UNIT !== "${{ inputs.unit }}") out.push("UNIT must be the pipeline's unit: main.bicep deploys that unit only");
  if (w.defaults?.run?.shell !== "bash") out.push("every step must run with pipefail (defaults.run.shell: bash), so a failure inside a pipe fails its gate");
  if (!steps[0]?.uses?.startsWith("actions/checkout@") || steps[1]?.id !== "target") out.push("the target step must run right after the checkout");
  const target = step("target")?.run ?? "";
  if (
    !target.includes("releases/download/${BICEP_VERSION}/bicep-linux-x64") ||
    !target.includes('echo "$RUNNER_TEMP/bicep" >> "$GITHUB_PATH"') ||
    !target.includes('echo "BICEP_PATH=$RUNNER_TEMP/bicep/bicep" >> "$GITHUB_ENV"') ||
    !target.includes('"$RUNNER_TEMP/bicep/bicep" build-params "$PARAMS" --stdout')
  ) {
    out.push("the target step must put the pinned Bicep CLI first on PATH (and in BICEP_PATH) and compile the parameter file with it");
  }
  for (const p of TARGET_OUTPUTS) if (!target.includes(`"${p}=\\(v(["${p}"]))"`)) out.push(`the target step must read ${p} from the parameter file`);
  for (const [e, p] of TARGET_SIGN_IN) if (!target.includes(`"${e}=\\(v(["${p}"]))"`)) out.push(`the target step must read ${p} from the parameter file (${e}, for the sign-in)`);
  for (const n of TARGET_NAMES) if (!target.includes(`"${n}\\(v([`)) out.push(`the target step must read ${n.slice(0, -1)} from the parameter file's names`);
  if (w.env?.SIGN_IN !== SIGN_IN) out.push("SIGN_IN must sign in with OIDC only: a fresh GitHub token, then the deploy app, tenant and subscription from the parameter file");
  if (steps.some((s) => s.uses?.startsWith("azure/login@"))) out.push("no azure/login: it signs in once, and GitHub's token is valid for 5 minutes; each step that calls Azure signs in itself (SIGN_IN)");
  for (const s of steps) {
    const callsAzure = azCommands(s.run ?? "").length > 0 || (s.run ?? "").includes("run_job ");
    if (callsAzure && !s.run!.startsWith('eval "$SIGN_IN"\n')) out.push(`${s.id} calls Azure, so it must sign in first (eval "$SIGN_IN"): GitHub's token is valid for 5 minutes`);
  }
  for (const id of ORDER) if (at(id) < 0) out.push(`missing step ${id}`);
  for (let i = 1; i < ORDER.length; i++) {
    if (at(ORDER[i - 1]!) >= 0 && at(ORDER[i]!) >= 0 && at(ORDER[i - 1]!) > at(ORDER[i]!)) out.push(`${ORDER[i - 1]} must run before ${ORDER[i]}`);
  }
  for (const s of steps) {
    const want = STEP_IF[s.id ?? ""];
    if (want !== undefined && s.if !== want) out.push(`${s.id} must run ${want === CHECKS ? "unless first-deployment" : `if ${want}`}`);
    if (want === undefined && s.if !== undefined) out.push(`${s.id ?? s.uses} may not be skipped`);
  }
  const deploy = step("deploy");
  const run = deploy?.run ?? "";
  const whatIf = run.indexOf('az deployment group what-if -g "$RG" -p "$PARAMS"');
  if (whatIf < 0 || whatIf > run.indexOf('az deployment group create -g "$RG" -n "x402-$UNIT-$IMAGE_TAG"')) out.push("deploy must preview main.bicep (with UNIT) with what-if before deploying it");
  if (deploy?.env?.SEED_IP !== "${{ inputs.seed-ip }}" || deploy.env.RECOVER_VAULTS !== "${{ inputs.recover-vaults }}") out.push("deploy must pass seed-ip and recover-vaults to the parameter file as SEED_IP and RECOVER_VAULTS");
  const build = step("build")?.run ?? "";
  if (!build.includes('docker build -f "$DOCKERFILE" -t "$SERVER/x402-$IMAGE:$IMAGE_TAG" .') || !build.includes('docker push "$SERVER/x402-$IMAGE:$IMAGE_TAG"')) out.push("build must build and push the unit's image, x402-$IMAGE:$IMAGE_TAG, from its Dockerfile");
  if (w.env?.IMAGE_TAG !== "${{ github.sha }}") out.push("the images must be tagged with the commit");
  const wait = step("wait")?.run ?? "";
  if (!/if \[\[ "\$UNIT" == platform \|\| "\$UNIT" == l2 \]\]; then\n\s+ok=""\n\s+for _ in \$\(seq 1 20\); do\n\s+if run_job "\$CAJ_L2" 120/.test(wait)) out.push("wait must wait for L2's ledger lock handover (ledger-verify through the operator job) after a platform or an L2 deployment");
  if (!wait.includes('for app in "$CA_SELLER" "$CA_SELLER_ALIAS"; do')) out.push("wait must wake both sellers before the checks");
  if (!step("regression")?.run?.includes('run_job "$CAJ_L1"')) out.push("the regression must run L1's regression job ($CAJ_L1)");
  if (!step("chain")?.run?.includes('run_job "$CAJ_L2"')) out.push("the chain check must run the operator job ($CAJ_L2), whose own command is ledger-verify");
  for (const s of steps) {
    const defined = s.run?.indexOf('eval "$RUN_JOB"\n') ?? -1;
    if (s.run?.includes("run_job ") && (defined < 0 || defined > s.run.indexOf("run_job "))) out.push(`${s.id} must define run_job before calling it (eval "$RUN_JOB")`);
  }
  if (!step("smoke")?.run?.includes('az account get-access-token --resource "${{ steps.target.outputs.authAudience }}"')) out.push("the smoke run's token must be for the API app's client ID (authAudience), the audience the agent accepts");
  // 012 (research R14): the hosted smoke run buys only auto-approved items; any escalation fails it.
  if (!step("smoke")?.run?.includes(`jq -e '[.steps[] | select(.result.outcome == "ESCALATED")] | length == 0'`)) out.push("the smoke run must fail when any step escalated (a deployment check never asks the approver)");
  const promote = step("promote")?.run ?? "";
  if (!/if \[\[ "\$UNIT" == l1 \]\]; then\n\s+AGENT_STABLE_REVISION="" az deployment group create/.test(promote)) out.push("promote must give the agent's latest revision its traffic through main.bicep, on L1 only");
  if (!promote.includes('--source "${{ steps.build.outputs.acr }}/x402-$IMAGE:$IMAGE_TAG" --image "x402-$IMAGE:last-good"')) out.push("promote must record the unit's image as last-good");
  for (const s of steps.slice(0, at("promote"))) if (s.run?.includes('AGENT_STABLE_REVISION=""')) out.push("the agent's traffic moves before promote");
  const rollback = step("rollback");
  if (!rollback?.run?.includes('--repository "x402-$IMAGE"') || !rollback.run.includes("IMAGE_TAG=last-good") || !rollback.run.includes('AGENT_STABLE_REVISION="${{ steps.deploy.outputs.stable }}"')) {
    out.push("rollback must redeploy the unit's last-good, with the agent's traffic left on its previous revision");
  }
  if (at("rollback") !== steps.length - 1) out.push("rollback must be the last step");
  return out;
}

/**
 * Step 0 starts by mapping the unit to its image and refusing inputs that don't belong to it, before it downloads or
 * deploys anything (2026-11-04: a run with seed-ip set went on to build the images). The guard is the run up to the
 * Bicep download; it is run in bash for every unit (and one unknown) with every combination of the inputs.
 */
export function unitGuardProblems(w: Workflow): string[] {
  const target = stepsOf(w).find((s) => s.id === "target");
  const out: string[] = [];
  if (JSON.stringify(target?.env) !== TARGET_INPUTS) out.push("the target step must take first-deployment, seed-ip and recover-vaults as INPUT_* environment variables, never pasted into its script");
  const run = target?.run ?? "";
  const end = run.indexOf(GUARD_END);
  if (!run.startsWith('case "$UNIT" in') || end < 0) return [...out, "the target step must start by mapping the unit to its image and refusing the inputs that don't belong to it"];
  const guard = run.slice(0, end);
  const dir = mkdtempSync(join(tmpdir(), "deploy-guard-"));
  try {
    for (const unit of [...Object.keys(PIPELINES_BY_UNIT), "l4"]) {
      for (const first of [false, true]) {
        for (const seedIp of ["", "203.0.113.7"]) {
          for (const recover of [false, true]) {
            const ghEnv = join(dir, `${unit}-${first}-${seedIp ? "ip" : "none"}-${recover}`);
            const env = { PATH: process.env.PATH ?? "", UNIT: unit, INPUT_FIRST_DEPLOYMENT: String(first), INPUT_SEED_IP: seedIp, INPUT_RECOVER_VAULTS: String(recover), GITHUB_ENV: ghEnv };
            const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", guard], { env, encoding: "utf8" });
            const want = refused(unit, first, seedIp, recover);
            const inputs = `unit ${unit}, first-deployment=${first}, seed-ip=${seedIp || "(empty)"} and recover-vaults=${recover}`;
            if ((r.status !== 0) !== want) {
              out.push(`with ${inputs}, the target step must ${want ? "refuse" : "go on"}`);
              continue;
            }
            if (want) continue;
            const image = unit === "platform" ? "" : UNIT_IMAGES[unit as keyof typeof UNIT_IMAGES];
            const dockerfile = image ? IMAGES[image].dockerfile : "";
            if (readFileSync(ghEnv, "utf8") !== `IMAGE=${image}\nDOCKERFILE=${dockerfile}\n`) out.push(`with ${inputs}, the target step must build ${image ? `x402-${image} from ${dockerfile}` : "no image"}`);
          }
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

/**
 * No GitHub secret or variable: every value comes from the parameter files. The one exception is the Auth0 pipeline,
 * which reads the Auth0 Management API credential from its own GitHub environment (T-IAC-02 checks where it goes).
 */
export function secretProblems(file: string, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\$\{\{\s*(secrets|vars)\.([A-Za-z0-9_]+)/g)) {
    if (file === AUTH0 && m[1] === "secrets" && AUTH0_SECRETS.includes(m[2]!)) continue;
    out.push(`${file} reads ${m[1]}.${m[2]}: values come from infra/main.<environment>.bicepparam`);
  }
  return out;
}

/**
 * Each job runs its own command: a start that overrides it (approve, reject) would let the deploy identity act as an
 * operator. The operator job's own command is ledger-verify (T-IAC-01 rule 12), the only one the workflow needs.
 */
export function jobStartProblems(file: string, text: string): string[] {
  return text
    .split("\n")
    .filter((l) => /\baz containerapp job start\b/.test(l) && /\s--(command|args|image|yaml|env-vars|container-name)\b/.test(l))
    .map((l) => `${file} starts a job with an override (${l.trim()}): the deploy identity runs only a job's own command`);
}

/** infra/ holds two shell scripts only: the GitHub environment (which Bicep can't make) and the clean-up. */
export function infraScriptProblems(files: string[]): string[] {
  return files.filter((f) => f.endsWith(".sh") && !INFRA_SCRIPTS.includes(f)).map((f) => `infra/${f}: infra/ holds only ${INFRA_SCRIPTS.join(" and ")}; everything else is Bicep or its parameter files`);
}

/** Every resource name a parameter file holds (main's and pre-deploy's for dev), so a workflow names none itself. */
export function hardCodedNames(file: string, text: string): string[] {
  const names = ["main", "pre-deploy"].flatMap((t) => leaves(buildParams(`infra/${t}.dev.bicepparam`).names, ["names"]));
  return names.filter(([, n]) => text.includes(n)).map(([k, n]) => `${file} hard-codes ${n}: use ${k} from the parameter file`);
}

const RETRY_PROBLEM = "SIGN_IN's token request must retry a transient answer from GitHub (one 503 failed run 42158206985) and pass the token on";
/**
 * SIGN_IN's token request (its first line only: az never runs), in bash with pipefail as a step runs it, against a
 * local stand-in for GitHub's OIDC endpoint that answers 503 once, as GitHub did in run 42158206985, then the token.
 * The request must retry, ask for the Azure token exchange audience with the runner's request token, and leave the
 * token in $oidc.
 */
export async function signInRetryProblems(signIn: string): Promise<string[]> {
  const requests: { authorization?: string; audience: string | null }[] = [];
  const server = createServer((req, res) => {
    requests.push({ authorization: req.headers.authorization, audience: new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("audience") });
    if (requests.length === 1) res.writeHead(503).end();
    else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ count: 1, value: "github-oidc-token" }));
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as AddressInfo;
  const env = {
    PATH: process.env.PATH ?? "",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-request-token",
    ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${port}/idtoken?api-version=2.0`,
  };
  const script = `${signIn.split("\n")[0]}\nprintf '%s' "$oidc"`;
  const run = await new Promise<{ code: number | null; stdout: string }>((done) => {
    const child = spawn("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], { env });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.on("close", (code) => done({ code, stdout }));
  });
  server.closeAllConnections();
  server.close();
  const out: string[] = [];
  if (run.code !== 0 || run.stdout !== "github-oidc-token") out.push(RETRY_PROBLEM);
  if (requests.some((r) => r.authorization !== "bearer runner-request-token" || r.audience !== "api://AzureADTokenExchange")) {
    out.push("SIGN_IN must ask GitHub for the api://AzureADTokenExchange audience with the runner's request token");
  }
  return out;
}

describe("T-E2E-AZ deployment workflow gates", () => {
  const w = read(SHARED);
  const text = readFileSync(`${DIR}/${SHARED}`, "utf8");
  // A missing pipeline is reported by folderProblems, not thrown here.
  const present = FILES.filter((f) => existsSync(`${DIR}/${f}`));
  const texts = Object.fromEntries(present.map((f) => [f, readFileSync(`${DIR}/${f}`, "utf8")]));

  it("T-E2E-AZ one pipeline per unit: deploy-infra, -l1, -l2, -l3, -operator and -seller, each by hand or on its own tag, in one concurrency group, calling deploy.yml with its unit", () => {
    expect(folderProblems(readdirSync(DIR))).toEqual([]);
    for (const file of Object.keys(PIPELINES).filter((f) => present.includes(f))) expect(pipelineProblems(file, read(file)), file).toEqual([]);
  });

  it("T-E2E-AZ deploy.yml: OIDC from the parameter file in each step that calls Azure, what-if before each deployment, every gate before promoting, the unit's rollback on failure", () => {
    expect(workflowProblems(w)).toEqual([]);
  });

  it("T-E2E-AZ step 0 maps the unit to its image and refuses inputs that don't belong to it, before anything else runs", () => {
    expect(unitGuardProblems(w)).toEqual([]);
  });

  it("T-E2E-AZ must-fail: no guard, a guard that lets seed-ip through on a unit or L1 run a first deployment, a unit built from another image, or the inputs pasted into the script, is reported", () => {
    const run = stepsOf(w).find((s) => s.id === "target")!.run!;
    const withTarget = (f: (s: Step) => Step): Workflow => withSteps(w, stepsOf(w).map((s) => (s.id === "target" ? f(s) : s)));
    const guard = run.slice(0, run.indexOf(GUARD_END));
    expect(unitGuardProblems(withTarget((s) => ({ ...s, run: run.slice(guard.length) })))).toEqual([
      "the target step must start by mapping the unit to its image and refusing the inputs that don't belong to it",
    ]);
    const recoverOnly = run.replace('( -n "$INPUT_SEED_IP" || "$INPUT_RECOVER_VAULTS" == true )', '"$INPUT_RECOVER_VAULTS" == true');
    expect(recoverOnly).not.toBe(run);
    expect(unitGuardProblems(withTarget((s) => ({ ...s, run: recoverOnly })))).toContain("with unit l2, first-deployment=false, seed-ip=203.0.113.7 and recover-vaults=false, the target step must refuse");
    const firstL1 = run.replace('[[ "$UNIT" == l1 && "$INPUT_FIRST_DEPLOYMENT" == true ]]', "false");
    expect(unitGuardProblems(withTarget((s) => ({ ...s, run: firstL1 })))).toContain("with unit l1, first-deployment=true, seed-ip=(empty) and recover-vaults=false, the target step must refuse");
    const swapped = run.replace("operator) image=operator dockerfile=docker/operator.Dockerfile", "operator) image=l2-control dockerfile=docker/l2-control.Dockerfile");
    expect(unitGuardProblems(withTarget((s) => ({ ...s, run: swapped })))).toContain(
      "with unit operator, first-deployment=false, seed-ip=(empty) and recover-vaults=false, the target step must build x402-operator from docker/operator.Dockerfile",
    );
    const pasted = run.replace('-n "$INPUT_SEED_IP"', '-n "${{ inputs.seed-ip }}"');
    expect(unitGuardProblems(withTarget((s) => ({ ...s, env: undefined, run: pasted })))).toContain(
      "the target step must take first-deployment, seed-ip and recover-vaults as INPUT_* environment variables, never pasted into its script",
    );
  });

  it("T-E2E-AZ the workflows read no GitHub secret or variable, hold no secret-shaped literal, and start every job with its own command", () => {
    for (const [file, t] of Object.entries(texts)) {
      expect(secretProblems(file, t)).toEqual([]);
      expect(findSecretShapes(t)).toEqual([]);
      expect(jobStartProblems(file, t)).toEqual([]);
    }
  });

  it.skipIf(!BICEP_PATH)("T-E2E-AZ the workflows name no resource themselves: every name comes from the parameter file", () => {
    for (const [file, t] of Object.entries(texts)) expect(hardCodedNames(file, t)).toEqual([]);
  });

  it("T-E2E-AZ Azure is provisioned by Bicep only: the workflows and the two infra scripts run no other provisioning az command", () => {
    expect(infraScriptProblems(readdirSync("infra"))).toEqual([]);
    for (const [file, t] of Object.entries(texts)) expect(provisioningOutsideBicep(file, t)).toEqual([]);
    for (const script of INFRA_SCRIPTS) {
      expect(provisioningOutsideBicep(script, readFileSync(`infra/${script}`, "utf8"), script === "cleanup.sh")).toEqual([]);
    }
  });

  it("T-E2E-AZ must-fail: a pipeline outside the group, on another unit, on deploy-* tags, on a merge, with secrets, or with steps of its own, and a missing or extra pipeline, are reported", () => {
    const l2 = read("deploy-l2.yml");
    const job = Object.values(l2.jobs)[0]!;
    expect(pipelineProblems("deploy-l2.yml", { ...l2, concurrency: { group: "deploy-l2", "cancel-in-progress": false } })).toEqual([
      "deploy-l2.yml must hold the concurrency group deploy-azure without cancelling: one deployment at a time, whichever the pipeline",
    ]);
    expect(pipelineProblems("deploy-l2.yml", { ...l2, jobs: { deploy: { ...job, with: { ...job.with, unit: "l3" } } } })).toEqual(["deploy-l2.yml must pass deploy.yml unit l2 and its own inputs only"]);
    expect(pipelineProblems("deploy-l2.yml", { ...l2, on: { ...l2.on, push: { tags: ["deploy-*"] } } })).toEqual(["deploy-l2.yml must run by hand or on deploy-l2-* tags only"]);
    expect(pipelineProblems("deploy-l2.yml", { ...l2, on: { ...l2.on, push: { tags: ["deploy-l2-*"], branches: ["main"] } } })).toEqual(["deploy-l2.yml must run by hand or on deploy-l2-* tags only"]);
    expect(pipelineProblems("deploy-l2.yml", { ...l2, jobs: { deploy: { ...job, secrets: "inherit" } } })).toEqual(["deploy-l2.yml passes secrets: the pipelines take every value from the parameter file"]);
    expect(pipelineProblems("deploy-l2.yml", { ...l2, jobs: { deploy: { ...job, uses: undefined, steps: stepsOf(w) } } })).toContain("deploy-l2.yml must have one job, which calls ./.github/workflows/deploy.yml");
    const l1 = read("deploy-l1.yml");
    const l1Job = Object.values(l1.jobs)[0]!;
    expect(pipelineProblems("deploy-l1.yml", { ...l1, jobs: { deploy: { ...l1Job, with: { ...l1Job.with, "seed-ip": PASSED["seed-ip"] } } } })).toEqual(["deploy-l1.yml must pass deploy.yml unit l1 and its own inputs only"]);
    expect(folderProblems(readdirSync(DIR).filter((f) => f !== "deploy-operator.yml"))).toEqual([
      `${DIR} must hold exactly ${FILES.join(", ")}: one pipeline per unit, the steps they share, and the Auth0 tenant's pipeline`,
    ]);
    expect(folderProblems([...readdirSync(DIR), "deploy-all.yml"])).toHaveLength(1);
  });

  it("T-E2E-AZ must-fail: deploy.yml with its own trigger or concurrency group (a deadlock with its callers) is reported", () => {
    expect(workflowProblems({ ...w, on: { ...w.on, workflow_dispatch: {} } })).toContain(`${SHARED} must only be called by the pipelines (workflow_call)`);
    expect(workflowProblems({ ...w, concurrency: { group: "deploy-azure", "cancel-in-progress": false } })).toContain(
      `${SHARED} must leave the concurrency group to the pipelines: a called workflow sharing it deadlocks with its caller`,
    );
  });

  it("T-E2E-AZ must-fail: promoting before the regression is reported", () => {
    const steps = [...stepsOf(w)];
    const promote = steps.splice(steps.findIndex((s) => s.id === "promote"), 1)[0]!;
    steps.splice(steps.findIndex((s) => s.id === "regression"), 0, promote);
    expect(workflowProblems(withSteps(w, steps))).toContain("log-scan must run before promote");
  });

  it("T-E2E-AZ must-fail: a regression skipped by any other condition, a platform run that builds an image or promotes, or a rollback of the platform, is reported", () => {
    const skip = (id: string, cond: string) => withSteps(w, stepsOf(w).map((s) => (s.id === id ? { ...s, if: cond } : s)));
    expect(workflowProblems(skip("regression", "${{ false }}"))).toContain("regression must run unless first-deployment");
    expect(workflowProblems(skip("build", "${{ !inputs.first-deployment }}"))).toContain(`build must run if ${NOT_PLATFORM}`);
    expect(workflowProblems(skip("promote", CHECKS))).toContain(`promote must run if ${STEP_IF.promote}`);
    expect(workflowProblems(skip("rollback", "failure() && (steps.deploy.outcome == 'success' || steps.deploy.outcome == 'failure')"))).toContain(`rollback must run if ${STEP_IF.rollback}`);
    expect(workflowProblems(skip("wait", NOT_PLATFORM))).toContain(`wait must run if ${STEP_IF.wait}`);
  });

  it("T-E2E-AZ must-fail: a GitHub secret, or a sign-in that isn't OIDC from the parameter file, is reported", () => {
    const secret = text.replace('-u "$DEPLOY_CLIENT_ID"', '-u "${{ secrets.AZURE_CLIENT_ID }}"');
    expect(secretProblems(SHARED, secret)).toEqual([`${SHARED} reads secrets.AZURE_CLIENT_ID: values come from infra/main.<environment>.bicepparam`]);
    const password = text.replace('--federated-token "$oidc"', '-p "${{ secrets.AZURE_CLIENT_SECRET }}"');
    expect(secretProblems(SHARED, password)).toEqual([`${SHARED} reads secrets.AZURE_CLIENT_SECRET: values come from infra/main.<environment>.bicepparam`]);
    // The Auth0 pipeline's secrets are its own: no deploy pipeline may read them, and it may read no other.
    const auth0 = text.replace('-u "$DEPLOY_CLIENT_ID"', '-u "${{ secrets.AUTH0_CLIENT_SECRET }}"');
    expect(secretProblems(SHARED, auth0)).toEqual([`${SHARED} reads secrets.AUTH0_CLIENT_SECRET: values come from infra/main.<environment>.bicepparam`]);
    expect(secretProblems(AUTH0, "${{ secrets.AUTH0_CLIENT_ID }} ${{ secrets.AZURE_CLIENT_SECRET }} ${{ vars.AUTH0_CLIENT_ID }}")).toEqual([
      `${AUTH0} reads secrets.AZURE_CLIENT_SECRET: values come from infra/main.<environment>.bicepparam`,
      `${AUTH0} reads vars.AUTH0_CLIENT_ID: values come from infra/main.<environment>.bicepparam`,
    ]);
    expect(workflowProblems(parse(password) as Workflow)).toContain(
      "SIGN_IN must sign in with OIDC only: a fresh GitHub token, then the deploy app, tenant and subscription from the parameter file",
    );
  });

  it("T-E2E-AZ SIGN_IN retries GitHub's token request: one 503, as in run 42158206985, then the token", { timeout: 30_000 }, async () => {
    expect(await signInRetryProblems(w.env?.SIGN_IN ?? "")).toEqual([]);
  });

  it("T-E2E-AZ must-fail: a token request without the retry, or for another audience, is reported", { timeout: 30_000 }, async () => {
    const signIn = w.env?.SIGN_IN ?? "";
    const once = signIn.replace("--retry 5 --retry-max-time 120 --max-time 30 ", "");
    expect(once).not.toBe(signIn);
    expect(await signInRetryProblems(once)).toEqual([RETRY_PROBLEM]);
    const audience = signIn.replace("audience=api://AzureADTokenExchange", "audience=api://another");
    expect(await signInRetryProblems(audience)).toEqual(["SIGN_IN must ask GitHub for the api://AzureADTokenExchange audience with the runner's request token"]);
  });

  it("T-E2E-AZ must-fail: one azure/login for the whole job (the run that failed with AADSTS700024), or a step calling Azure without signing in first, is reported", () => {
    const login = { uses: "azure/login@v2", with: { "client-id": "${{ env.DEPLOY_CLIENT_ID }}", "tenant-id": "${{ env.TENANT_ID }}", "subscription-id": "${{ env.SUBSCRIPTION_ID }}" } };
    const once = stepsOf(w).map((s) => (s.run?.startsWith('eval "$SIGN_IN"\n') ? { ...s, run: s.run.slice('eval "$SIGN_IN"\n'.length) } : s));
    once.splice(once.findIndex((s) => s.id === "build"), 0, login);
    const problems = workflowProblems(withSteps(w, once));
    expect(problems).toContain("no azure/login: it signs in once, and GitHub's token is valid for 5 minutes; each step that calls Azure signs in itself (SIGN_IN)");
    for (const id of ["build", "deploy", "wait", "regression", "chain", "smoke", "log-scan", "promote", "rollback"]) {
      expect(problems).toContain(`${id} calls Azure, so it must sign in first (eval "$SIGN_IN"): GitHub's token is valid for 5 minutes`);
    }
    const late = stepsOf(w).map((s) => (s.id === "smoke" ? { ...s, run: s.run!.replace('eval "$SIGN_IN"\n', "") + 'eval "$SIGN_IN"\n' } : s));
    expect(workflowProblems(withSteps(w, late))).toEqual([`smoke calls Azure, so it must sign in first (eval "$SIGN_IN"): GitHub's token is valid for 5 minutes`]);
  });

  it("T-E2E-AZ must-fail: provisioning outside Bicep (a resource group made with az, traffic moved with az) is reported", () => {
    const group = text.replace('az deployment group what-if -g "$RG" -p "$PARAMS"\n', 'az group create -n "$RG" -l eastus2\n          az deployment group what-if -g "$RG" -p "$PARAMS"\n');
    expect(provisioningOutsideBicep(SHARED, group)).toEqual([`${SHARED} runs "az group create -n": Azure is provisioned by Bicep only`]);
    const traffic = text.replace('AGENT_STABLE_REVISION="" az deployment group create -g "$RG" -n "x402-l1-promote-$IMAGE_TAG" -p "$PARAMS" -o none', 'az containerapp ingress traffic set -n "$CA_L1" -g "$RG" --revision-weight latest=100');
    expect(provisioningOutsideBicep(SHARED, traffic)).toEqual([`${SHARED} runs "az containerapp ingress traffic": Azure is provisioned by Bicep only`]);
  });

  it("T-E2E-AZ must-fail: a deployment without what-if, an image built under another name, or a promotion of another image, is reported", () => {
    const steps = stepsOf(w).map((s) =>
      s.id === "deploy"
        ? { ...s, run: s.run!.replace('az deployment group what-if -g "$RG" -p "$PARAMS"\n', "") }
        : s.id === "build"
          ? { ...s, run: s.run!.replace('-t "$SERVER/x402-$IMAGE:$IMAGE_TAG" .', '-t "$SERVER/x402-l2-control:$IMAGE_TAG" .') }
          : s.id === "promote"
            ? { ...s, run: s.run!.replace('--image "x402-$IMAGE:last-good"', '--image "x402-l2-control:last-good"') }
            : s,
    );
    const problems = workflowProblems(withSteps(w, steps));
    expect(problems).toContain("deploy must preview main.bicep (with UNIT) with what-if before deploying it");
    expect(problems).toContain("build must build and push the unit's image, x402-$IMAGE:$IMAGE_TAG, from its Dockerfile");
    expect(problems).toContain("promote must record the unit's image as last-good");
  });

  it("T-E2E-AZ must-fail: starting the operator job with an approve command is reported", () => {
    const start = 'az containerapp job start -n "$job" -g "$RG" --query name -o tsv';
    expect(text.includes(start)).toBe(true);
    const approve = text.replace(start, 'az containerapp job start -n "$job" -g "$RG" --container-name operator --command node --args dist/scripts/approve.js --query name -o tsv');
    expect(jobStartProblems(SHARED, approve)).toHaveLength(1);
  });

  it("T-E2E-AZ must-fail: the target step run late, a missing name, an L2 deployment that doesn't wait for the lock handover, or a gate fed by a pipe without pipefail is reported", () => {
    const steps = [...stepsOf(w)];
    steps.splice(3, 0, steps.splice(1, 1)[0]!);
    expect(workflowProblems(withSteps(w, steps))).toContain("the target step must run right after the checkout");
    const noName = stepsOf(w).map((s) => (s.id === "target" ? { ...s, run: s.run!.replace('"CAJ_L2=\\(v(["jobs", "l2"]))"', '"X=1"') } : s));
    expect(workflowProblems(withSteps(w, noName))).toContain("the target step must read CAJ_L2 from the parameter file's names");
    const noHandover = stepsOf(w).map((s) => (s.id === "wait" ? { ...s, run: s.run!.replace('if [[ "$UNIT" == platform || "$UNIT" == l2 ]]', 'if [[ "$UNIT" == platform ]]') } : s));
    expect(workflowProblems(withSteps(w, noHandover))).toContain("wait must wait for L2's ledger lock handover (ledger-verify through the operator job) after a platform or an L2 deployment");
    expect(workflowProblems({ ...w, defaults: undefined })).toContain("every step must run with pipefail (defaults.run.shell: bash), so a failure inside a pipe fails its gate");
  });

  it("T-E2E-AZ must-fail: a rollback that redeploys the new image instead of last-good, or a smoke token for another audience, is reported", () => {
    const steps = stepsOf(w).map((s) =>
      s.id === "rollback"
        ? { ...s, run: s.run!.replace("IMAGE_TAG=last-good ", "") }
        : s.id === "smoke"
          ? { ...s, run: s.run!.replace('--resource "${{ steps.target.outputs.authAudience }}"', '--resource "api://x402-agent"') }
          : s,
    );
    const problems = workflowProblems(withSteps(w, steps));
    expect(problems).toContain("rollback must redeploy the unit's last-good, with the agent's traffic left on its previous revision");
    expect(problems).toContain("the smoke run's token must be for the API app's client ID (authAudience), the audience the agent accepts");
  });

  it("T-E2E-AZ 012 must-fail: a smoke run that lets an escalation pass is reported", () => {
    const steps = stepsOf(w).map((s) =>
      s.id === "smoke" ? { ...s, run: s.run!.replace(`jq -e '[.steps[] | select(.result.outcome == "ESCALATED")] | length == 0' "$RUNNER_TEMP/smoke.json" > /dev/null\n`, "") } : s,
    );
    expect(workflowProblems(withSteps(w, steps))).toEqual(["the smoke run must fail when any step escalated (a deployment check never asks the approver)"]);
  });

  it.skipIf(!BICEP_PATH)("T-E2E-AZ must-fail: a hard-coded resource name is reported", () => {
    const app = buildParams("infra/main.dev.bicepparam").names as { apps: { l1: string } };
    const named = text.replace('-n "$CA_L1" -g', `-n ${app.apps.l1} -g`);
    expect(hardCodedNames(SHARED, named)).toEqual([`${SHARED} hard-codes ${app.apps.l1}: use names.apps.l1 from the parameter file`]);
  });

  it("T-E2E-AZ must-fail: a third shell script in infra/ is reported", () => {
    expect(infraScriptProblems([...readdirSync("infra"), "naming.sh"])).toEqual([
      "infra/naming.sh: infra/ holds only cleanup.sh and github-setup.sh; everything else is Bicep or its parameter files",
    ]);
  });
});
