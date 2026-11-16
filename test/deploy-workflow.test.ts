// T-E2E-AZ deployment workflow gates (SPEC.md §3.1 Azure profile, FR-023, FR-024; specs/011 contracts/
// deploy-pipeline.md). Offline checks on the seven pipelines in .github/workflows (deploy-infra.yml for the platform,
// deploy-l1/l2/l3/operator/portal/seller.yml for one unit each), on deploy.yml, the steps they all call with their
// unit, and on the infra scripts. Checked:
// - one pipeline per unit, and nothing else in the folder but the Auth0 tenant's pipeline (provision-auth0.yml, which
//   T-IAC-02 checks; the only workflow that reads GitHub secrets and variables, and only its own) and the pull request
//   check (checks.yml, T-CI-01 below): each runs by hand or on its own tag, holds the one
//   concurrency group, and only calls deploy.yml with its unit; each image of scripts/image-closure.ts is built by
//   exactly one pipeline;
// - OIDC only, with the sign-in, target and resource names compiled from infra/main.<environment>.bicepparam by the
//   pinned Bicep CLI: no GitHub secret or variable; each step that calls Azure signs in first with a fresh GitHub
//   token, which is valid for 5 minutes (one azure/login failed with AADSTS700024 after the platform's deployment),
//   and the token request retries a transient answer (it is run against a local endpoint that answers 503 once);
// - Azure provisioned by Bicep only: every az command is a Bicep deployment (each previewed with what-if), a read,
//   a job start, an image copy or (in infra/cleanup.sh) a deletion, and infra/ holds two scripts only
//   (github-setup.sh, cleanup.sh);
// - 016: no workflow asks for an access token: the pipeline holds no caller's token. The hosted smoke run is a job
//   (the smoke job, src/smoke-main.ts on L1's image) that gets its own from the sign-in tenant; the step only starts
//   it and reads its outcome, and the checks of its answer are unit-tested in test/smoke-client.test.ts (T-AGT-13);
// - the gate order: nothing is promoted before the regression, chain check, smoke run, portal smoke (013) and log
//   scan pass; a step is skipped only by a platform run (the image steps, the promotion, the rollback) or a first
//   deployment (the checks through the other units; the portal smoke runs on the portal's own); a failure inside a
//   pipe fails its step;
// - 013: the image scan also refuses a mnemonic or the card vault key; the wait polls the portal's new revision; the
//   portal smoke sends no token and expects health, Auth0 sign-in mode and a 401;
// - step 0 first maps the unit to its image and refuses inputs that don't belong to it, before anything else (the
//   guard itself is run, for every combination of unit and inputs);
// - each job runs its own command: the deploy identity never starts the operator job with another;
// - the rollback, of the run's unit only;
// - no resource name hard-coded;
// - no secret-shaped literal.
// The live part of T-E2E-AZ is the workflow runs themselves (quickstart §4).
// T-CI-01, the pull request check (checks.yml): every pull request to main and every push to main, never
// pull_request_target and no paths filter; read-only contents and nothing else, no GitHub environment, no secret or
// variable, a checkout that keeps no credential; every action pinned by commit SHA; deploy.yml's Bicep CLI, checked
// against its SHA-256 before it runs, in BICEP_PATH; then exactly deploy.yml's step 1 and the local demo, on Node 22
// and 26, none of it skippable or allowed to fail.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

type Unit = "platform" | "l1" | "l2" | "l3" | "operator" | "portal" | "seller";
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
  "deploy-portal.yml": { unit: "portal", inputs: ["environment", "first-deployment"] },
  "deploy-seller.yml": { unit: "seller", inputs: ["environment", "first-deployment"] },
};
/** The Auth0 tenant's pipeline (Terraform, auth0/): checked by T-IAC-02 (test/auth0-iac.test.ts), not here. */
const AUTH0 = "provision-auth0.yml";
/** The only GitHub secrets a workflow reads: the Auth0 pipeline's, from its own GitHub environment. */
const AUTH0_SECRETS = ["AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET"];
/**
 * The only GitHub variables a workflow reads: the Auth0 pipeline's Terraform variables, from the same environment.
 * 016 adds the deployed agent's origin and the machine callers' public keys (never a private one: T-IAC-02). Phase 3
 * removes the approver (SPEC v1.16) and adds the switches for the local origins and for sign-ups.
 */
const AUTH0_VARIABLES = /^AUTH0_(TENANT_DOMAIN|API_IDENTIFIER|CLIENT_PUBLIC_KEY|MANAGE_GUARDIAN|GUARDIAN_POLICY|PORTAL_ORIGIN|AGENT_ORIGIN|MACHINE_CALLER_KEYS|LOCAL_ORIGINS|ALLOW_SIGN_UPS)$/;
/** The pull request check (T-CI-01): not a pipeline, it deploys nothing. */
const CHECKS_FILE = "checks.yml";
const FILES = [SHARED, AUTH0, CHECKS_FILE, ...Object.keys(PIPELINES)].sort();
/** The image each unit's run builds, promotes and rolls back; the platform has none. */
const UNIT_IMAGES: Record<Exclude<Unit, "platform">, ImageName> = { l1: "l1-agent", l2: "l2-control", l3: "l3-verifier", operator: "operator", portal: "portal", seller: "seller" };
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
const ORDER = ["target", "tests", "build", "image-scan", "deploy", "wait", "balance", "regression", "chain", "smoke", "portal-smoke", "log-scan", "promote"];
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
  // 013: skipped on a first deployment of a unit that precedes the portal; the portal's own first deployment runs it.
  "portal-smoke": "${{ !inputs.first-deployment || inputs.unit == 'portal' }}",
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
const TARGET_OUTPUTS = ["payerAddress"];
const TARGET_SIGN_IN = [
  ["TENANT_ID", "tenantId"],
  ["SUBSCRIPTION_ID", "subscriptionId"],
  ["DEPLOY_CLIENT_ID", "deployClientId"],
];
const TARGET_NAMES = ["RG=", "LOG_X402=", "CR_X402=", "CA_L1=", "CA_L3=", "CA_PORTAL=", "CA_SELLER=", "CA_SELLER_ALIAS=", "CAJ_L1=", "CAJ_L2=", "CAJ_SMOKE="];
/**
 * 016: the whole hosted smoke step. It signs in, defines run_job and starts the smoke job with the job's own command
 * (src/smoke-main.ts, T-IAC-01 rule 23): the job gets its own token and checks the agent's answer itself.
 */
const SMOKE_RUN = 'eval "$SIGN_IN"\neval "$RUN_JOB"\nrun_job "$CAJ_SMOKE"\n';
const SMOKE_PROBLEM = 'the smoke step must be the sign-in, RUN_JOB and run_job "$CAJ_SMOKE", and nothing else: the smoke job gets its own token and checks the agent\'s answer itself (src/smoke-main.ts)';
/** Step 2b's pattern: an assignment of a key, a secret, a token, or (013) a mnemonic or the card vault key, in the image. */
const IMAGE_SCAN = "grep -E 'PRIVATE_KEY[=]|_SECRET[=]|_TOKEN[=]|_MNEMONIC[=]|CARD_VAULT_KEY[=]'";
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
 * Anything that creates or changes a resource otherwise is provisioning outside Bicep. Asking for an access token is
 * not among them (016: tokenProblems names it).
 */
const AZ_READS = /^az (account (show|set|clear)|login|bicep build-params|acr (login|show|repository show-tags|import)|containerapp (show|revision (list|show)|job (show|start|execution show|logs show))|monitor log-analytics (query|workspace show)|deployment group (what-if|create)|group exists|resource list|keyvault (list|list-deleted)|cognitiveservices account (list|list-deleted)|ad (app|sp|group) list|role assignment list|rest --method GET)\b/;
const AZ_DELETIONS = /^az (group delete|role assignment delete|ad (app|group) delete|cognitiveservices account purge|rest --method DELETE)\b/;

/** Every `az …` command line in a script, from the `az` on (comments and echoed text excluded). */
function azCommands(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => !/^\s*#/.test(l) && !/^\s*echo /.test(l))
    .flatMap((l) => [...l.matchAll(/(?:^|[\s$(|;&])(az [a-z][^|;)"]*)/g)].map((m) => m[1]!.trim()));
}

/** An az command that asks for an access token (016: tokenProblems reports it, not provisioningOutsideBicep). */
const AZ_TOKEN = /^az account get-access-token\b/;

/** Provisioning outside Bicep: an az command that isn't a deployment, a read, a job run, an image copy or an allowed deletion. */
export function provisioningOutsideBicep(file: string, text: string, deletions = false): string[] {
  return azCommands(text)
    .filter((c) => !AZ_READS.test(c) && !AZ_TOKEN.test(c) && !(deletions && AZ_DELETIONS.test(c)))
    .map((c) => `${file} runs "${c.split(" ").slice(0, 4).join(" ")}": Azure is provisioned by Bicep only`);
}

/**
 * 016 (FR-022, FR-023): no workflow or infra script asks for an access token. The deploy identity is not a caller of
 * the agent, and the pipeline never holds a caller's token: the checks that need one are jobs, which get their own
 * from the sign-in tenant.
 */
export function tokenProblems(file: string, text: string): string[] {
  return azCommands(text)
    .filter((c) => AZ_TOKEN.test(c))
    .map((c) => `${file} asks for an access token (${c.split(" ").slice(0, 5).join(" ")}): the pipeline holds no caller's token; the smoke job and the regression job get their own`);
}

const FOLDER_PROBLEM = `${DIR} must hold exactly ${FILES.join(", ")}: one pipeline per unit, the steps they share, the Auth0 tenant's pipeline and the pull request check`;

/** The folder holds the seven pipelines, deploy.yml, the Auth0 pipeline and the pull request check, and the pipelines' units build every image exactly once. */
export function folderProblems(files: string[]): string[] {
  const out: string[] = [];
  if (JSON.stringify([...files].sort()) !== JSON.stringify(FILES)) out.push(FOLDER_PROBLEM);
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

/** A step or job of the pull request check, with the keys that could skip it, excuse it or let it outlive its run. */
type CheckStep = Step & { "continue-on-error"?: unknown; "timeout-minutes"?: unknown };
type CheckJob = Omit<Job, "steps"> & {
  steps?: CheckStep[];
  if?: string;
  needs?: unknown;
  "continue-on-error"?: unknown;
  "timeout-minutes"?: number;
  strategy?: { "fail-fast"?: boolean; matrix?: Record<string, unknown> };
};
/** Node 22, what the images and deploy.yml run, and Node 26, what development runs (SPEC §5). */
const CHECKS_NODES = ["22", "26"];
/** After deploy.yml's step 1, the local demo, which exits non-zero when its summary leaves the baseline. */
const CHECKS_DEMO = "npm run demo:local";
/** An action pinned by its full commit SHA: a tag can be moved to other code. */
const PINNED_ACTION = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/;
/** The Bicep CLI's checksum, checked before the binary is made executable or put on PATH. */
const BICEP_CHECKSUM = 'echo "$BICEP_SHA256  $RUNNER_TEMP/bicep/bicep" | sha256sum -c -';
const CHECKS_TRIGGER = `${CHECKS_FILE} must run on every pull request to main and every push to main: pull_request and push with branches [main] only, no paths filter, never pull_request_target`;
/** The commands deploy.yml's step 1 runs, one per line. */
const gateCommands = (deploy: Workflow) =>
  (stepsOf(deploy).find((s) => s.id === "tests")?.run ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/**
 * T-CI-01, the pull request check: on every pull request to main and every push to main, with nothing a deployment
 * has (no secret, variable, GitHub environment or token beyond reading the code), it runs deploy.yml's Bicep CLI,
 * checked against its SHA-256, then exactly deploy.yml's step 1 and the local demo, on Node 22 and 26. Nothing in it
 * may be skipped or allowed to fail, or the check is green without the checks.
 */
export function checksProblems(w: Workflow, deploy: Workflow): string[] {
  const out: string[] = [];
  if (w.name !== "checks") out.push(`${CHECKS_FILE} must be named checks`);
  const on = w.on ?? {};
  if (
    JSON.stringify(Object.keys(on).sort()) !== JSON.stringify(["pull_request", "push"]) ||
    JSON.stringify(on.pull_request) !== JSON.stringify({ branches: ["main"] }) ||
    JSON.stringify(on.push) !== JSON.stringify({ branches: ["main"] })
  ) {
    out.push(CHECKS_TRIGGER);
  }
  if (JSON.stringify(w.permissions) !== JSON.stringify({ contents: "read" })) out.push(`${CHECKS_FILE}'s permissions must be contents: read and nothing else: the check deploys nothing`);
  if (w.concurrency?.group !== "checks-${{ github.ref }}") out.push(`${CHECKS_FILE} must hold its own concurrency group per ref (checks-\${{ github.ref }}), never deploy-azure`);
  if (w.defaults?.run?.shell !== "bash") out.push(`${CHECKS_FILE}'s steps must run with pipefail (defaults.run.shell: bash)`);
  if (w.env?.BICEP_VERSION === undefined || w.env.BICEP_VERSION !== deploy.env?.BICEP_VERSION) out.push(`${CHECKS_FILE}'s BICEP_VERSION must be deploy.yml's (${deploy.env?.BICEP_VERSION}): the check compiles the templates with the CLI that deploys them`);
  if (!/^[0-9a-f]{64}$/.test(w.env?.BICEP_SHA256 ?? "")) out.push(`${CHECKS_FILE}'s BICEP_SHA256 must be the release asset's SHA-256 (64 hex digits)`);
  const jobs = Object.values(w.jobs ?? {}) as CheckJob[];
  const job = jobs[0];
  if (jobs.length !== 1 || !job) return [...out, `${CHECKS_FILE} must have one job`];
  if (job.environment !== undefined) out.push(`${CHECKS_FILE}'s job must run in no GitHub environment: the deploy environments' federated credentials trust their jobs`);
  if (job.permissions !== undefined || job.secrets !== undefined || job.uses !== undefined) out.push(`${CHECKS_FILE}'s job must widen no permission, pass no secret and call no workflow`);
  if (job.if !== undefined || job.needs !== undefined || job["continue-on-error"] !== undefined) out.push(`${CHECKS_FILE}'s job may not be skipped or allowed to fail`);
  const timeout = job["timeout-minutes"];
  if (typeof timeout !== "number" || timeout < 1 || timeout > 60) out.push(`${CHECKS_FILE}'s job must time out within 60 minutes`);
  if (JSON.stringify(job.strategy) !== JSON.stringify({ "fail-fast": false, matrix: { node: CHECKS_NODES } })) out.push(`${CHECKS_FILE} must run on Node ${CHECKS_NODES.join(" and ")}, each to the end (fail-fast: false)`);
  const steps = job.steps ?? [];
  for (const s of steps) {
    if (s.uses !== undefined && !PINNED_ACTION.test(s.uses)) out.push(`${CHECKS_FILE} uses ${s.uses}: pin every action by its full commit SHA`);
    if (s.if !== undefined || s["continue-on-error"] !== undefined) out.push(`${CHECKS_FILE}'s step ${s.name ?? s.uses} may not be skipped or allowed to fail`);
  }
  if (!steps[0]?.uses?.startsWith("actions/checkout@") || steps[0].with?.["persist-credentials"] !== false) out.push(`${CHECKS_FILE} must start with a checkout that keeps no credential (persist-credentials: false): npm install runs the pull request's install scripts`);
  const node = steps[1];
  if (!node?.uses?.startsWith("actions/setup-node@") || node.with?.["node-version"] !== "${{ matrix.node }}" || node.with["package-manager-cache"] !== false) {
    out.push(`${CHECKS_FILE}'s second step must set up the matrix's Node, with no dependency cache`);
  }
  const bicepAt = steps.findIndex((s) => (s.run ?? "").includes("bicep-linux-x64"));
  const bicep = steps[bicepAt]?.run ?? "";
  const download = bicep.indexOf('curl -fsSL -o "$RUNNER_TEMP/bicep/bicep" "https://github.com/Azure/bicep/releases/download/${BICEP_VERSION}/bicep-linux-x64"');
  const checksum = bicep.indexOf(BICEP_CHECKSUM);
  const used = ["chmod +x", "$GITHUB_PATH", "BICEP_PATH="].map((t) => bicep.indexOf(t));
  if (bicepAt !== 2 || download < 0 || checksum < download || used.some((i) => i < checksum)) {
    out.push(`${CHECKS_FILE}'s third step must download deploy.yml's Bicep CLI and check its SHA-256 before making it executable or putting it on PATH`);
  }
  if (!bicep.includes('echo "BICEP_PATH=$RUNNER_TEMP/bicep/bicep" >> "$GITHUB_ENV"')) out.push(`${CHECKS_FILE} must set BICEP_PATH, or T-IAC-01 and the infra scripts' tests are skipped`);
  const commands = steps.slice(bicepAt + 1).flatMap((s) => (s.uses !== undefined ? [`uses ${s.uses}`] : (s.run ?? "").split("\n").map((l) => l.trim()).filter(Boolean)));
  const want = [...gateCommands(deploy), CHECKS_DEMO];
  if (JSON.stringify(commands) !== JSON.stringify(want)) out.push(`after the Bicep CLI, ${CHECKS_FILE} must run exactly deploy.yml's step 1 and then the local demo: ${want.join("; ")}`);
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
  if (!step("image-scan")?.run?.includes(IMAGE_SCAN)) out.push("the image scan must refuse an assignment of a private key, a secret, a token, a mnemonic or the card vault key");
  const wait = step("wait")?.run ?? "";
  if (!/if \[\[ "\$UNIT" == platform \|\| "\$UNIT" == l2 \]\]; then\n\s+ok=""\n\s+for _ in \$\(seq 1 20\); do\n\s+if run_job "\$CAJ_L2" 120/.test(wait)) out.push("wait must wait for L2's ledger lock handover (ledger-verify through the operator job) after a platform or an L2 deployment");
  if (!wait.includes('if [[ "$UNIT" == l1 || "$UNIT" == l3 || "$UNIT" == portal ]]; then') || !/\bl1\) app="\$CA_L1" ;; l3\) app="\$CA_L3" ;; portal\) app="\$CA_PORTAL" ;;/.test(wait)) {
    out.push("wait must wait for the new revision of L1, L3 or the portal after its own deployment");
  }
  if (!wait.includes('for app in "$CA_SELLER" "$CA_SELLER_ALIAS"; do')) out.push("wait must wake both sellers before the checks");
  if (!step("regression")?.run?.includes('run_job "$CAJ_L1"')) out.push("the regression must run L1's regression job ($CAJ_L1)");
  if (!step("chain")?.run?.includes('run_job "$CAJ_L2"')) out.push("the chain check must run the operator job ($CAJ_L2), whose own command is ledger-verify");
  for (const s of steps) {
    const defined = s.run?.indexOf('eval "$RUN_JOB"\n') ?? -1;
    if (s.run?.includes("run_job ") && (defined < 0 || defined > s.run.indexOf("run_job "))) out.push(`${s.id} must define run_job before calling it (eval "$RUN_JOB")`);
  }
  // 016: the hosted smoke run is the smoke job, started with its own command. The step asks for no token and makes no
  // request itself: the job's exit code is the check (012 research R14: any escalation fails it, inside the job).
  if (step("smoke")?.run !== SMOKE_RUN) out.push(SMOKE_PROBLEM);
  for (const s of steps) for (const p of tokenProblems(s.id ?? s.uses ?? "a step", s.run ?? "")) out.push(p);
  // 013: the portal smoke. The pipeline holds no token, and the portal accepts only a person's from its own client, so
  // the check sends none: the portal answers, verifies Auth0 tokens (not the dev issuer's), and refuses without one.
  const portal = step("portal-smoke")?.run ?? "";
  if (!portal.includes('az containerapp show -n "$CA_PORTAL" -g "$RG" --query properties.configuration.ingress.fqdn')) out.push("the portal smoke must go to the portal's own address ($CA_PORTAL)");
  if (!portal.includes('curl -fsS -m 10 -o /dev/null "https://$PORTAL/healthz"')) out.push("the portal smoke must wait for /healthz to answer 200");
  if (!portal.includes(`curl -fsS -m 30 "https://$PORTAL/api/config" | jq -e '.auth.mode == "auth0"' > /dev/null`)) out.push('the portal smoke must get /api/config with "mode":"auth0": a deployed portal never trusts the dev issuer');
  if (!/code=\$\(curl -sS -m 30 -o \/dev\/null -w '%\{http_code\}' "https:\/\/\$PORTAL\/api\/me"\)\n\s*if \[ "\$code" != 401 \]; then [^\n]*exit 1; fi/.test(portal)) out.push("the portal smoke must get 401 from /api/me without a token");
  if (/get-access-token|authorization|Bearer/i.test(portal)) out.push("the portal smoke must send no token: the portal refuses application identities");
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
 * which reads the Auth0 Management API credential and Terraform's variables from its own GitHub environment (T-IAC-02
 * checks where they go).
 */
export function secretProblems(file: string, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\$\{\{\s*(secrets|vars)\.([A-Za-z0-9_]+)/g)) {
    if (file === AUTH0 && (m[1] === "secrets" ? AUTH0_SECRETS.includes(m[2]!) : AUTH0_VARIABLES.test(m[2]!))) continue;
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

  it("T-E2E-AZ one pipeline per unit: deploy-infra, -l1, -l2, -l3, -operator, -portal and -seller, each by hand or on its own tag, in one concurrency group, calling deploy.yml with its unit", () => {
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
    const portalImage = run.replace("portal) image=portal dockerfile=docker/portal.Dockerfile", "portal) image=l2-control dockerfile=docker/l2-control.Dockerfile");
    expect(portalImage).not.toBe(run);
    expect(unitGuardProblems(withTarget((s) => ({ ...s, run: portalImage })))).toContain(
      "with unit portal, first-deployment=true, seed-ip=(empty) and recover-vaults=false, the target step must build x402-portal from docker/portal.Dockerfile",
    );
    const noPortal = run.replace(/\n\s*portal\) image=portal dockerfile=docker\/portal\.Dockerfile ;;/, "");
    expect(noPortal).not.toBe(run);
    expect(unitGuardProblems(withTarget((s) => ({ ...s, run: noPortal })))).toContain("with unit portal, first-deployment=false, seed-ip=(empty) and recover-vaults=false, the target step must go on");
    const pasted = run.replace('-n "$INPUT_SEED_IP"', '-n "${{ inputs.seed-ip }}"');
    expect(unitGuardProblems(withTarget((s) => ({ ...s, env: undefined, run: pasted })))).toContain(
      "the target step must take first-deployment, seed-ip and recover-vaults as INPUT_* environment variables, never pasted into its script",
    );
  });

  it("T-E2E-AZ the workflows read no GitHub secret or variable, hold no secret-shaped literal, ask for no access token, and start every job with its own command", () => {
    for (const [file, t] of Object.entries(texts)) {
      expect(secretProblems(file, t)).toEqual([]);
      expect(findSecretShapes(t)).toEqual([]);
      expect(tokenProblems(file, t)).toEqual([]);
      expect(jobStartProblems(file, t)).toEqual([]);
    }
    for (const script of INFRA_SCRIPTS) expect(tokenProblems(script, readFileSync(`infra/${script}`, "utf8"))).toEqual([]);
  });

  it("T-E2E-AZ 016 must-fail: a step that asks for an access token, a smoke step that calls the agent itself or checks its answer itself, or one that starts another job, is reported", () => {
    const smoke = (run: string) => withSteps(w, stepsOf(w).map((s) => (s.id === "smoke" ? { ...s, run } : s)));
    // 011's step: a token for the directory's API app, then the request and the checks, in the workflow.
    const old = [
      'eval "$SIGN_IN"',
      'AGENT=$(az containerapp show -n "$CA_L1" -g "$RG" --query properties.configuration.ingress.fqdn -o tsv)',
      'ACCESS=$(az account get-access-token --resource "$AUDIENCE" --query accessToken -o tsv)',
      'curl -fsS -m 210 -X POST "https://$AGENT/v1/runs" -H "authorization: Bearer $ACCESS" -H "content-type: application/json" -d \'{"goal":"x"}\' > "$RUNNER_TEMP/smoke.json"',
      "jq -e '.status == \"completed\"' \"$RUNNER_TEMP/smoke.json\" > /dev/null",
      "",
    ].join("\n");
    const TOKEN = "asks for an access token (az account get-access-token --resource): the pipeline holds no caller's token; the smoke job and the regression job get their own";
    expect(workflowProblems(smoke(old))).toEqual([SMOKE_PROBLEM, `smoke ${TOKEN}`]);
    // In any step, and in any workflow's text.
    const inWait = withSteps(w, stepsOf(w).map((s) => (s.id === "wait" ? { ...s, run: s.run!.replace('eval "$RUN_JOB"\n', 'eval "$RUN_JOB"\nACCESS=$(az account get-access-token --resource "$AUDIENCE" --query accessToken -o tsv)\n') } : s)));
    expect(workflowProblems(inWait)).toEqual([`wait ${TOKEN}`]);
    expect(tokenProblems(SHARED, text.replace('run_job "$CAJ_SMOKE"', 'az account get-access-token --resource "$AUDIENCE"'))).toEqual([`${SHARED} ${TOKEN}`]);
    expect(provisioningOutsideBicep(SHARED, 'az account get-access-token --scope "api://x/.default"')).toEqual([]);
    expect(tokenProblems(SHARED, 'az account get-access-token --scope "api://x/.default"')).toHaveLength(1);
    // The job is the check: a step that adds a request of its own, drops RUN_JOB, or starts another job is not it.
    expect(workflowProblems(smoke(`${SMOKE_RUN}curl -fsS "https://agent.example/healthz"\n`))).toEqual([SMOKE_PROBLEM]);
    expect(workflowProblems(smoke('eval "$SIGN_IN"\neval "$RUN_JOB"\nrun_job "$CAJ_L1"\n'))).toEqual([SMOKE_PROBLEM]);
    expect(workflowProblems(smoke('eval "$SIGN_IN"\neval "$RUN_JOB"\nrun_job "$CAJ_SMOKE" || true\n'))).toEqual([SMOKE_PROBLEM]);
    const noName = stepsOf(w).map((s) => (s.id === "target" ? { ...s, run: s.run!.replace('"CAJ_SMOKE=\\(v(["jobs", "smoke"]))"', '"X=1"') } : s));
    expect(workflowProblems(withSteps(w, noName))).toEqual(["the target step must read CAJ_SMOKE from the parameter file's names"]);
    // The step 0 of 011 read the directory's audience for that token: nothing reads one now.
    expect(text).not.toMatch(/authAudience|get-access-token|Bearer/);
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
      FOLDER_PROBLEM,
    ]);
    expect(folderProblems([...readdirSync(DIR), "deploy-all.yml"])).toHaveLength(1);
    // 013: without the portal's pipeline, its image is built by none.
    expect(folderProblems(readdirSync(DIR).filter((f) => f !== "deploy-portal.yml"))).toEqual([
      FOLDER_PROBLEM,
    ]);
    const portal = read("deploy-portal.yml");
    const portalJob = Object.values(portal.jobs)[0]!;
    expect(pipelineProblems("deploy-portal.yml", { ...portal, jobs: { deploy: { ...portalJob, with: { ...portalJob.with, unit: "l2" } } } })).toEqual(["deploy-portal.yml must pass deploy.yml unit portal and its own inputs only"]);
    expect(pipelineProblems("deploy-portal.yml", { ...portal, on: { ...portal.on, push: { tags: ["deploy-l2-*"] } } })).toEqual(["deploy-portal.yml must run by hand or on deploy-portal-* tags only"]);
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

  it("T-E2E-AZ 013 must-fail: a portal smoke skipped on the portal's own first deployment, run before the hosted smoke, sending a token, or without one of its three checks, is reported", () => {
    const edit = (f: (run: string) => string) => withSteps(w, stepsOf(w).map((s) => (s.id === "portal-smoke" ? { ...s, run: f(s.run!) } : s)));
    const skipped = withSteps(w, stepsOf(w).map((s) => (s.id === "portal-smoke" ? { ...s, if: CHECKS } : s)));
    expect(workflowProblems(skipped)).toEqual([`portal-smoke must run if ${STEP_IF["portal-smoke"]}`]);
    const steps = [...stepsOf(w)];
    const smoke = steps.splice(steps.findIndex((s) => s.id === "portal-smoke"), 1)[0]!;
    steps.splice(steps.findIndex((s) => s.id === "smoke"), 0, smoke);
    expect(workflowProblems(withSteps(w, steps))).toEqual(["smoke must run before portal-smoke"]);
    expect(workflowProblems(withSteps(w, stepsOf(w).filter((s) => s.id !== "portal-smoke")))).toContain("missing step portal-smoke");
    expect(workflowProblems(edit((run) => run.replace('"https://$PORTAL/api/me")', '-H "authorization: Bearer $ACCESS" "https://$PORTAL/api/me")')))).toContain(
      "the portal smoke must send no token: the portal refuses application identities",
    );
    expect(workflowProblems(edit((run) => run.replace(`| jq -e '.auth.mode == "auth0"' > /dev/null`, "> /dev/null")))).toEqual([
      'the portal smoke must get /api/config with "mode":"auth0": a deployed portal never trusts the dev issuer',
    ]);
    // People sign in with Auth0 (specs/013 research R19): a portal still in the first build's Entra mode fails the check.
    expect(workflowProblems(edit((run) => run.replace('.auth.mode == "auth0"', '.auth.mode == "entra"')))).toEqual([
      'the portal smoke must get /api/config with "mode":"auth0": a deployed portal never trusts the dev issuer',
    ]);
    expect(workflowProblems(edit((run) => run.replace('if [ "$code" != 401 ]', 'if [ "$code" = 500 ]')))).toEqual(["the portal smoke must get 401 from /api/me without a token"]);
    expect(workflowProblems(edit((run) => run.replace('-n "$CA_PORTAL"', '-n "$CA_L1"')))).toEqual(["the portal smoke must go to the portal's own address ($CA_PORTAL)"]);
  });

  it("T-E2E-AZ 013 must-fail: an image scan that lets a mnemonic or the card vault key through, or a portal deployment that doesn't wait for its revision, is reported", () => {
    const scan = (from: string) => withSteps(w, stepsOf(w).map((s) => (s.id === "image-scan" ? { ...s, run: s.run!.replace(from, "") } : s)));
    for (const part of ["|_MNEMONIC[=]", "|CARD_VAULT_KEY[=]"]) {
      expect(text.includes(part)).toBe(true);
      expect(workflowProblems(scan(part))).toEqual(["the image scan must refuse an assignment of a private key, a secret, a token, a mnemonic or the card vault key"]);
    }
    // The pattern itself, as grep runs it: each assignment is caught, a plain mention isn't.
    const pattern = /grep -E '([^']+)'/.exec(IMAGE_SCAN)![1]!;
    const caught = (line: string) => spawnSync("grep", ["-E", pattern], { input: `${line}\n`, encoding: "utf8" }).status === 0;
    for (const line of ["USER_WALLET_MNEMONIC=abandon abandon", "ENV CARD_VAULT_KEY=rk_test_x", "PAYER_PRIVATE_KEY=0x1", "PORTAL_TOKEN=x", "CIBA_CLIENT_SECRET=x"]) expect(caught(line), line).toBe(true);
    for (const line of ["NODE_ENV=production", "CARD_VAULT_PUBLISHABLE_KEY=pk_test_x", "# USER_WALLET_MNEMONIC is seeded by hand"]) expect(caught(line), line).toBe(false);
    const noWait = withSteps(w, stepsOf(w).map((s) => (s.id === "wait" ? { ...s, run: s.run!.replace('if [[ "$UNIT" == l1 || "$UNIT" == l3 || "$UNIT" == portal ]]', 'if [[ "$UNIT" == l1 || "$UNIT" == l3 ]]') } : s)));
    expect(workflowProblems(noWait)).toEqual(["wait must wait for the new revision of L1, L3 or the portal after its own deployment"]);
  });

  it("T-E2E-AZ must-fail: a GitHub secret, or a sign-in that isn't OIDC from the parameter file, is reported", () => {
    const secret = text.replace('-u "$DEPLOY_CLIENT_ID"', '-u "${{ secrets.AZURE_CLIENT_ID }}"');
    expect(secretProblems(SHARED, secret)).toEqual([`${SHARED} reads secrets.AZURE_CLIENT_ID: values come from infra/main.<environment>.bicepparam`]);
    const password = text.replace('--federated-token "$oidc"', '-p "${{ secrets.AZURE_CLIENT_SECRET }}"');
    expect(secretProblems(SHARED, password)).toEqual([`${SHARED} reads secrets.AZURE_CLIENT_SECRET: values come from infra/main.<environment>.bicepparam`]);
    // The Auth0 pipeline's secrets are its own: no deploy pipeline may read them, and it may read no other.
    const auth0 = text.replace('-u "$DEPLOY_CLIENT_ID"', '-u "${{ secrets.AUTH0_CLIENT_SECRET }}"');
    expect(secretProblems(SHARED, auth0)).toEqual([`${SHARED} reads secrets.AUTH0_CLIENT_SECRET: values come from infra/main.<environment>.bicepparam`]);
    expect(secretProblems(SHARED, text.replace('-u "$DEPLOY_CLIENT_ID"', '-u "${{ vars.AUTH0_TENANT_DOMAIN }}"'))).toEqual([`${SHARED} reads vars.AUTH0_TENANT_DOMAIN: values come from infra/main.<environment>.bicepparam`]);
    // Constitution V: L2's client secret is held by L2 only, never by GitHub.
    expect(secretProblems(AUTH0, "${{ secrets.AUTH0_L2_CLIENT_SECRET }}")).toEqual([`${AUTH0} reads secrets.AUTH0_L2_CLIENT_SECRET: values come from infra/main.<environment>.bicepparam`]);
    expect(secretProblems(AUTH0, "${{ secrets.AUTH0_CLIENT_ID }} ${{ vars.AUTH0_TENANT_DOMAIN }} ${{ secrets.AZURE_CLIENT_SECRET }} ${{ vars.AUTH0_CLIENT_ID }}")).toEqual([
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
    for (const id of ["build", "deploy", "wait", "regression", "chain", "smoke", "portal-smoke", "log-scan", "promote", "rollback"]) {
      expect(problems).toContain(`${id} calls Azure, so it must sign in first (eval "$SIGN_IN"): GitHub's token is valid for 5 minutes`);
    }
    const late = stepsOf(w).map((s) => (s.id === "chain" ? { ...s, run: s.run!.replace('eval "$SIGN_IN"\n', "") + 'eval "$SIGN_IN"\n' } : s));
    expect(workflowProblems(withSteps(w, late))).toEqual([`chain calls Azure, so it must sign in first (eval "$SIGN_IN"): GitHub's token is valid for 5 minutes`]);
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

  it("T-E2E-AZ must-fail: a rollback that redeploys the new image instead of last-good is reported", () => {
    const steps = stepsOf(w).map((s) => (s.id === "rollback" ? { ...s, run: s.run!.replace("IMAGE_TAG=last-good ", "") } : s));
    expect(workflowProblems(withSteps(w, steps))).toEqual(["rollback must redeploy the unit's last-good, with the agent's traffic left on its previous revision"]);
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

describe("T-CI-01 the pull request check", () => {
  const deploy = read(SHARED);
  const checks = read(CHECKS_FILE);
  const text = readFileSync(`${DIR}/${CHECKS_FILE}`, "utf8");
  const job = () => Object.values(checks.jobs)[0] as CheckJob;
  const withJob = (f: (j: CheckJob) => CheckJob): Workflow => ({ ...checks, jobs: { checks: f(job()) as Job } });
  const withStep = (name: string, f: (s: CheckStep) => CheckStep) => withJob((j) => ({ ...j, steps: j.steps!.map((s) => (s.name === name ? f(s) : s)) }));
  const BICEP_STEP = "the pinned Bicep CLI, in BICEP_PATH";
  const bicepRun = () => job().steps!.find((s) => s.name === BICEP_STEP)!.run!;
  const commandsProblem = (d: Workflow) => `after the Bicep CLI, ${CHECKS_FILE} must run exactly deploy.yml's step 1 and then the local demo: ${[...gateCommands(d), CHECKS_DEMO].join("; ")}`;
  const COMMANDS = commandsProblem(deploy);
  const BICEP_ORDER = `${CHECKS_FILE}'s third step must download deploy.yml's Bicep CLI and check its SHA-256 before making it executable or putting it on PATH`;
  const UNSKIPPABLE = (step: string) => `${CHECKS_FILE}'s step ${step} may not be skipped or allowed to fail`;

  it("T-CI-01 checks.yml: every pull request to main and push to main, contents: read only, no environment, actions pinned by SHA, deploy.yml's Bicep CLI checked by SHA-256, then deploy.yml's step 1 and the local demo on Node 22 and 26", () => {
    expect(checksProblems(checks, deploy)).toEqual([]);
    // Not vacuous: deploy.yml's step 1 is the four commands .github/dependabot.yml says a merge needs.
    expect(gateCommands(deploy)).toEqual(["npm install --no-audit --no-fund", "npm run audit:shipped", "npm run typecheck", "npm test"]);
    expect(readFileSync(".github/dependabot.yml", "utf8")).toContain(CHECKS_FILE);
  });

  it("T-CI-01 must-fail: pull_request_target, a paths filter, no pull request trigger, wider permissions, a GitHub environment, a secret, or the deploy concurrency group, is reported", () => {
    expect(checksProblems({ ...checks, on: { ...checks.on, pull_request_target: { branches: ["main"] } } }, deploy)).toEqual([CHECKS_TRIGGER]);
    expect(checksProblems({ ...checks, on: { ...checks.on, pull_request: { branches: ["main"], paths: ["src/**"] } } }, deploy)).toEqual([CHECKS_TRIGGER]);
    expect(checksProblems({ ...checks, on: { push: { branches: ["main"] } } }, deploy)).toEqual([CHECKS_TRIGGER]);
    expect(checksProblems({ ...checks, permissions: { "id-token": "write", contents: "read" } }, deploy)).toEqual([`${CHECKS_FILE}'s permissions must be contents: read and nothing else: the check deploys nothing`]);
    expect(checksProblems(withJob((j) => ({ ...j, permissions: { contents: "write" } })), deploy)).toEqual([`${CHECKS_FILE}'s job must widen no permission, pass no secret and call no workflow`]);
    expect(checksProblems(withJob((j) => ({ ...j, environment: "dev" })), deploy)).toEqual([
      `${CHECKS_FILE}'s job must run in no GitHub environment: the deploy environments' federated credentials trust their jobs`,
    ]);
    const secret = text.replace("run: npm test\n", "run: npm test\n        env:\n          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}\n");
    expect(secret).not.toBe(text);
    expect(secretProblems(CHECKS_FILE, secret)).toEqual([`${CHECKS_FILE} reads secrets.NPM_TOKEN: values come from infra/main.<environment>.bicepparam`]);
    expect(secretProblems(CHECKS_FILE, text.replace("npm run typecheck", "npm run typecheck ${{ vars.EXTRA }}"))).toEqual([`${CHECKS_FILE} reads vars.EXTRA: values come from infra/main.<environment>.bicepparam`]);
    expect(checksProblems({ ...checks, concurrency: { group: "deploy-azure", "cancel-in-progress": false } }, deploy)).toEqual([
      `${CHECKS_FILE} must hold its own concurrency group per ref (checks-\${{ github.ref }}), never deploy-azure`,
    ]);
  });

  it("T-CI-01 must-fail: npm ci, a check that can't fail, a dropped check, a skipped or excused step or job, or a command deploy.yml's step 1 gained and the check didn't, is reported", () => {
    expect(checksProblems(withStep("install", (s) => ({ ...s, run: "npm ci" })), deploy)).toEqual([COMMANDS]);
    expect(checksProblems(withStep("every suite", (s) => ({ ...s, run: "npm test || true" })), deploy)).toEqual([COMMANDS]);
    expect(checksProblems(withStep("every suite", (s) => ({ ...s, run: "npx vitest run test/policy.test.ts" })), deploy)).toEqual([COMMANDS]);
    expect(checksProblems(withJob((j) => ({ ...j, steps: j.steps!.filter((s) => s.name !== "the local demo against its baseline") })), deploy)).toEqual([COMMANDS]);
    expect(checksProblems(withJob((j) => ({ ...j, steps: j.steps!.filter((s) => s.name !== "audit of what the images ship (T-IMG-02)") })), deploy)).toEqual([COMMANDS]);
    expect(checksProblems(withStep("every suite", (s) => ({ ...s, "continue-on-error": true })), deploy)).toEqual([UNSKIPPABLE("every suite")]);
    expect(checksProblems(withStep("typecheck", (s) => ({ ...s, if: "${{ github.actor != 'dependabot[bot]' }}" })), deploy)).toEqual([UNSKIPPABLE("typecheck")]);
    for (const k of ["if", "continue-on-error", "needs"] as const) {
      expect(checksProblems(withJob((j) => ({ ...j, [k]: k === "needs" ? ["build"] : "${{ true }}" })), deploy), k).toEqual([`${CHECKS_FILE}'s job may not be skipped or allowed to fail`]);
    }
    expect(checksProblems(withJob((j) => ({ ...j, "timeout-minutes": undefined })), deploy)).toEqual([`${CHECKS_FILE}'s job must time out within 60 minutes`]);
    const gained = withSteps(deploy, stepsOf(deploy).map((s) => (s.id === "tests" ? { ...s, run: `${s.run!}npm run build\n` } : s)));
    expect(checksProblems(checks, gained)).toEqual([commandsProblem(gained)]);
    expect(commandsProblem(gained)).toContain("npm test; npm run build; npm run demo:local");
  });

  it("T-CI-01 must-fail: an action by tag, a checkout that keeps its credential, another Node or a cache, another Bicep CLI, no checksum or one checked too late, or no BICEP_PATH, is reported", () => {
    expect(checksProblems(withJob((j) => ({ ...j, steps: j.steps!.map((s, i) => (i === 0 ? { ...s, uses: "actions/checkout@v7" } : s)) })), deploy)).toEqual([
      `${CHECKS_FILE} uses actions/checkout@v7: pin every action by its full commit SHA`,
    ]);
    expect(checksProblems(withJob((j) => ({ ...j, steps: j.steps!.map((s, i) => (i === 0 ? { ...s, with: {} } : s)) })), deploy)).toEqual([
      `${CHECKS_FILE} must start with a checkout that keeps no credential (persist-credentials: false): npm install runs the pull request's install scripts`,
    ]);
    expect(checksProblems(withJob((j) => ({ ...j, steps: j.steps!.map((s, i) => (i === 1 ? { ...s, with: { ...s.with, "package-manager-cache": true } } : s)) })), deploy)).toEqual([
      `${CHECKS_FILE}'s second step must set up the matrix's Node, with no dependency cache`,
    ]);
    expect(checksProblems(withJob((j) => ({ ...j, strategy: { "fail-fast": false, matrix: { node: ["26"] } } })), deploy)).toEqual([`${CHECKS_FILE} must run on Node 22 and 26, each to the end (fail-fast: false)`]);
    expect(checksProblems(withJob((j) => ({ ...j, strategy: { matrix: { node: CHECKS_NODES } } })), deploy)).toEqual([`${CHECKS_FILE} must run on Node 22 and 26, each to the end (fail-fast: false)`]);
    expect(checksProblems({ ...checks, env: { ...checks.env, BICEP_VERSION: "v0.49.2" } }, deploy)).toEqual([
      `${CHECKS_FILE}'s BICEP_VERSION must be deploy.yml's (${deploy.env?.BICEP_VERSION}): the check compiles the templates with the CLI that deploys them`,
    ]);
    expect(checksProblems({ ...checks, env: { ...checks.env, BICEP_SHA256: "" } }, deploy)).toEqual([`${CHECKS_FILE}'s BICEP_SHA256 must be the release asset's SHA-256 (64 hex digits)`]);
    const run = bicepRun();
    expect(run).toContain(`${BICEP_CHECKSUM}\n`);
    expect(checksProblems(withStep(BICEP_STEP, (s) => ({ ...s, run: run.replace(`${BICEP_CHECKSUM}\n`, "") })), deploy)).toEqual([BICEP_ORDER]);
    const late = run.replace(`${BICEP_CHECKSUM}\n`, "").replace(/(chmod \+x [^\n]+\n)/, `$1${BICEP_CHECKSUM}\n`);
    expect(late).not.toBe(run);
    expect(checksProblems(withStep(BICEP_STEP, (s) => ({ ...s, run: late })), deploy)).toEqual([BICEP_ORDER]);
    const noPath = run.replace('echo "BICEP_PATH=$RUNNER_TEMP/bicep/bicep" >> "$GITHUB_ENV"\n', "");
    expect(noPath).not.toBe(run);
    expect(checksProblems(withStep(BICEP_STEP, (s) => ({ ...s, run: noPath })), deploy)).toEqual([BICEP_ORDER, `${CHECKS_FILE} must set BICEP_PATH, or T-IAC-01 and the infra scripts' tests are skipped`]);
  });

  it.skipIf(spawnSync("sha256sum", ["--version"]).status !== 0)("T-CI-01 the step's SHA-256 check, run as the step runs it, passes the published bytes and refuses any other", () => {
    const dir = mkdtempSync(join(tmpdir(), "bicep-checksum-"));
    try {
      mkdirSync(join(dir, "bicep"));
      const published = "the bytes GitHub published";
      const status = (bytes: string) => {
        writeFileSync(join(dir, "bicep", "bicep"), bytes);
        const env = { PATH: process.env.PATH ?? "", RUNNER_TEMP: dir, BICEP_SHA256: createHash("sha256").update(published).digest("hex") };
        return spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", BICEP_CHECKSUM], { env, encoding: "utf8" }).status;
      };
      expect(status(published)).toBe(0);
      expect(status(`${published}, and a planted payload`)).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("T-CI-01 must-fail: a folder without the pull request check is reported", () => {
    expect(folderProblems(readdirSync(DIR).filter((f) => f !== CHECKS_FILE))).toEqual([FOLDER_PROBLEM]);
  });
});
