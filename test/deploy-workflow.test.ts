// T-E2E-AZ deployment workflow gates (SPEC.md §3.1 Azure profile, FR-023, FR-024; specs/011 contracts/
// deploy-pipeline.md). Offline checks on .github/workflows/deploy.yml, which deploys everything (infra/main.bicep)
// from one commit, and on the infra scripts. Checked:
// - OIDC only, with the sign-in, target and resource names compiled from infra/main.<environment>.bicepparam by the
//   pinned Bicep CLI: no GitHub secret or variable;
// - Azure provisioned by Bicep only: every az command is a Bicep deployment (each previewed with what-if), a read,
//   a job start, an image copy or (in infra/cleanup.sh) a deletion, and infra/ holds two scripts only
//   (github-setup.sh, cleanup.sh);
// - the gate order: nothing is promoted before the regression, chain check, smoke run and log scan pass, and a
//   step is skipped only by the first, platform-only run; a failure inside a pipe fails its step;
// - each job runs its own command: the deploy identity never starts the operator job with another;
// - the rollback;
// - every image of scripts/image-closure.ts built;
// - no resource name hard-coded;
// - no secret-shaped literal.
// The live part of T-E2E-AZ is the workflow runs themselves (quickstart §4).
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { IMAGES } from "../scripts/image-closure.js";
import { findSecretShapes } from "../scripts/secret-scan-lib.js";
import { BICEP_PATH, buildParams, leaves } from "./helpers/bicep.js";

const DIR = ".github/workflows";
const FILE = "deploy.yml";
type Step = { id?: string; name?: string; if?: string; run?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string> };
type Workflow = {
  on?: { workflow_dispatch?: { inputs?: Record<string, unknown> }; push?: { tags?: string[] } };
  permissions?: Record<string, string>;
  defaults?: { run?: { shell?: string } };
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  env?: Record<string, string>;
  jobs: Record<string, { environment?: string; steps?: Step[] }>;
};
const read = () => parse(readFileSync(`${DIR}/${FILE}`, "utf8")) as Workflow;
const stepsOf = (w: Workflow) => Object.values(w.jobs)[0]?.steps ?? [];

/** The contract's steps, in order (contracts/deploy-pipeline.md). */
const ORDER = ["target", "tests", "platform", "build", "image-scan", "deploy", "wait", "balance", "regression", "chain", "smoke", "log-scan", "promote"];
/** What a platform-only run (the very first, before the vaults are seeded) skips: everything after the platform. */
const PLATFORM_ONLY_SKIPS = ORDER.slice(ORDER.indexOf("build"));
const PLATFORM_ONLY_IF = "${{ !inputs.platform-only }}";
const PERMISSIONS = JSON.stringify({ "id-token": "write", contents: "read" });
/** azure/login's inputs: OIDC, from the parameter file through the target step. */
const LOGIN = JSON.stringify({
  "client-id": "${{ steps.target.outputs.deployClientId }}",
  "tenant-id": "${{ steps.target.outputs.tenantId }}",
  "subscription-id": "${{ steps.target.outputs.subscriptionId }}",
});
/** What the target step reads from the compiled parameter file: the sign-in, and the names the steps use. */
const TARGET_OUTPUTS = ["tenantId", "subscriptionId", "deployClientId", "authAudience", "payerAddress"];
const TARGET_NAMES = ["RG=", "LOG_X402=", "CR_X402=", "CA_L1=", "CA_L3=", "CA_SELLER=", "CA_SELLER_ALIAS=", "CAJ_L1=", "CAJ_L2="];
/** The only shell scripts in infra/: what Bicep can't do (the GitHub environment) and the clean-up. */
const INFRA_SCRIPTS = ["cleanup.sh", "github-setup.sh"];
/**
 * The az commands a workflow or infra script may run: Bicep deployments, reads, job runs, image copies, the
 * runner's sign-in, and (in infra/cleanup.sh only) deletions. Anything that creates or changes a resource
 * otherwise is provisioning outside Bicep.
 */
const AZ_READS = /^az (account (show|get-access-token)|login|bicep build-params|acr (login|show|repository show-tags|import)|containerapp (show|revision (list|show)|job (show|start|execution show|logs show))|monitor log-analytics (query|workspace show)|deployment group (what-if|create)|group exists|resource list|keyvault (list|list-deleted)|cognitiveservices account (list|list-deleted)|ad (app|sp|group) list|role assignment list|rest --method GET)\b/;
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

/** deploy.yml: triggers, sign-in, gate order, skips, deployments and rollback. */
export function workflowProblems(w: Workflow): string[] {
  const out: string[] = [];
  const steps = stepsOf(w);
  const at = (id: string) => steps.findIndex((s) => s.id === id);
  const step = (id: string) => steps.find((s) => s.id === id);
  if (!w.on?.workflow_dispatch || JSON.stringify(w.on.push?.tags) !== JSON.stringify(["deploy-*"])) out.push("deploy.yml must run by hand or on deploy-* tags only");
  if (JSON.stringify(Object.keys(w.on?.workflow_dispatch?.inputs ?? {}).sort()) !== JSON.stringify(["environment", "platform-only", "recover-vaults", "seed-ip"])) out.push("deploy.yml's inputs must be environment, platform-only, seed-ip and recover-vaults");
  if (JSON.stringify(w.permissions) !== PERMISSIONS) out.push("permissions must be id-token: write, contents: read");
  if (w.concurrency?.group !== "deploy-azure" || w.concurrency["cancel-in-progress"] !== false) out.push("concurrency must be group deploy-azure without cancelling");
  if (Object.values(w.jobs)[0]?.environment !== "${{ inputs.environment || 'dev' }}") out.push("the job must run in the deploy environment's GitHub environment (the federated credential's subject)");
  if (w.env?.PARAMS !== "infra/main.${{ inputs.environment || 'dev' }}.bicepparam") out.push("PARAMS must be infra/main.<environment>.bicepparam");
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
  for (const n of TARGET_NAMES) if (!target.includes(`"${n}\\(v([`)) out.push(`the target step must read ${n.slice(0, -1)} from the parameter file's names`);
  const logins = steps.filter((s) => s.uses?.startsWith("azure/login@"));
  if (logins.length !== 1 || JSON.stringify(logins[0]!.with) !== LOGIN) out.push("azure/login must sign in with OIDC only, from the parameter file (client-id, tenant-id, subscription-id)");
  if (steps.indexOf(logins[0]!) < at("target")) out.push("azure/login must come after the target step");
  for (const id of ORDER) if (at(id) < 0) out.push(`missing step ${id}`);
  for (let i = 1; i < ORDER.length; i++) {
    if (at(ORDER[i - 1]!) >= 0 && at(ORDER[i]!) >= 0 && at(ORDER[i - 1]!) > at(ORDER[i]!)) out.push(`${ORDER[i - 1]} must run before ${ORDER[i]}`);
  }
  for (const s of steps) {
    const skippable = PLATFORM_ONLY_SKIPS.includes(s.id ?? "");
    if (skippable && s.if !== PLATFORM_ONLY_IF) out.push(`${s.id} must run unless platform-only`);
    if (!skippable && s.id !== "rollback" && s.if !== undefined) out.push(`${s.id ?? s.uses} may not be skipped`);
  }
  for (const id of ["platform", "deploy"]) {
    const run = step(id)?.run ?? "";
    const whatIf = run.indexOf('az deployment group what-if -g "$RG" -p "$PARAMS"');
    if (whatIf < 0 || whatIf > run.indexOf('az deployment group create -g "$RG"')) out.push(`${id} must preview main.bicep with what-if before deploying it`);
  }
  if (step("platform")?.env?.PLATFORM_ONLY !== "true") out.push("platform must deploy main.bicep with PLATFORM_ONLY=true");
  const build = step("build")?.run ?? "";
  for (const [image, spec] of Object.entries(IMAGES)) {
    const built = image === "seller" ? build.includes(`-f ${spec.dockerfile} `) && build.includes("/x402-seller:$IMAGE_TAG") : build.includes('-f "docker/$image.Dockerfile"') && build.includes(image);
    if (!built) out.push(`build must build x402-${image} from ${spec.dockerfile}`);
  }
  if (w.env?.IMAGE_TAG !== "${{ github.sha }}") out.push("the images must be tagged with the commit");
  if (!step("regression")?.run?.includes('run_job "$CAJ_L1"')) out.push("the regression must run L1's regression job ($CAJ_L1)");
  if (!step("chain")?.run?.includes('run_job "$CAJ_L2"')) out.push("the chain check must run the operator job ($CAJ_L2), whose own command is ledger-verify");
  for (const s of steps) if (s.run?.includes("run_job ") && !s.run.startsWith('eval "$RUN_JOB"\n')) out.push(`${s.id} must define run_job first (eval "$RUN_JOB")`);
  if (!step("smoke")?.run?.includes('az account get-access-token --resource "${{ steps.target.outputs.authAudience }}"')) out.push("the smoke run's token must be for the API app's client ID (authAudience), the audience the agent accepts");
  const promote = step("promote")?.run ?? "";
  if (!promote.includes('AGENT_STABLE_REVISION="" az deployment group create')) out.push("promote must give the agent's latest revision its traffic through main.bicep");
  if (!promote.includes("--image \"x402-$image:last-good\"") || !/for image in l1-agent l2-control l3-verifier seller/.test(promote)) out.push("promote must record every image as last-good");
  for (const s of steps.slice(0, at("promote"))) if (s.run?.includes("AGENT_STABLE_REVISION=\"\"")) out.push("the agent's traffic moves before promote");
  const rollback = step("rollback");
  if (rollback?.if !== "failure() && (steps.deploy.outcome == 'success' || steps.deploy.outcome == 'failure')") out.push("rollback must run on any failure once the deploy step has run, even if that step failed");
  if (!rollback?.run?.includes("IMAGE_TAG=last-good") || !rollback.run.includes('AGENT_STABLE_REVISION="${{ steps.deploy.outputs.stable }}"')) {
    out.push("rollback must redeploy last-good, with the agent's traffic left on its previous revision");
  }
  if (at("rollback") !== steps.length - 1) out.push("rollback must be the last step");
  return out;
}

/** No GitHub secret or variable: every value comes from the parameter files. */
export function secretProblems(file: string, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\$\{\{\s*(secrets|vars)\.([A-Za-z0-9_]+)/g)) out.push(`${file} reads ${m[1]}.${m[2]}: values come from infra/main.<environment>.bicepparam`);
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

describe("T-E2E-AZ deployment workflow gates", () => {
  const w = read();
  const text = readFileSync(`${DIR}/${FILE}`, "utf8");

  it("T-E2E-AZ one workflow deploys everything: OIDC from the parameter file, what-if before each deployment, every gate before promoting, rollback on failure", () => {
    expect(readdirSync(DIR)).toEqual([FILE]);
    expect(workflowProblems(w)).toEqual([]);
  });

  it("T-E2E-AZ the workflow reads no GitHub secret or variable, holds no secret-shaped literal, and starts every job with its own command", () => {
    expect(secretProblems(FILE, text)).toEqual([]);
    expect(findSecretShapes(text)).toEqual([]);
    expect(jobStartProblems(FILE, text)).toEqual([]);
  });

  it.skipIf(!BICEP_PATH)("T-E2E-AZ the workflow names no resource itself: every name comes from the parameter file", () => {
    expect(hardCodedNames(FILE, text)).toEqual([]);
  });

  it("T-E2E-AZ Azure is provisioned by Bicep only: the workflow and the two infra scripts run no other provisioning az command", () => {
    expect(infraScriptProblems(readdirSync("infra"))).toEqual([]);
    expect(provisioningOutsideBicep(FILE, text)).toEqual([]);
    for (const script of INFRA_SCRIPTS) {
      expect(provisioningOutsideBicep(script, readFileSync(`infra/${script}`, "utf8"), script === "cleanup.sh")).toEqual([]);
    }
  });

  it("T-E2E-AZ must-fail: promoting before the regression is reported", () => {
    const steps = [...stepsOf(w)];
    const promote = steps.splice(steps.findIndex((s) => s.id === "promote"), 1)[0]!;
    steps.splice(steps.findIndex((s) => s.id === "regression"), 0, promote);
    expect(workflowProblems({ ...w, jobs: { deploy: { ...Object.values(w.jobs)[0], steps } } })).toContain("log-scan must run before promote");
  });

  it("T-E2E-AZ must-fail: a regression skipped by any other condition is reported", () => {
    const steps = stepsOf(w).map((s) => (s.id === "regression" ? { ...s, if: "${{ false }}" } : s));
    expect(workflowProblems({ ...w, jobs: { deploy: { ...Object.values(w.jobs)[0], steps } } })).toContain("regression must run unless platform-only");
  });

  it("T-E2E-AZ must-fail: a GitHub secret, or a sign-in that isn't OIDC from the parameter file, is reported", () => {
    const secret = text.replace("${{ steps.target.outputs.deployClientId }}", "${{ secrets.AZURE_CLIENT_ID }}");
    expect(secretProblems(FILE, secret)).toEqual([`${FILE} reads secrets.AZURE_CLIENT_ID: values come from infra/main.<environment>.bicepparam`]);
    const creds = { creds: '{"clientId":"x","clientSecret":"${{ secrets.AZURE_CLIENT_SECRET }}"}' };
    const steps = stepsOf(w).map((s) => (s.uses?.startsWith("azure/login@") ? { ...s, with: creds } : s));
    expect(workflowProblems({ ...w, jobs: { deploy: { ...Object.values(w.jobs)[0], steps } } })).toContain(
      "azure/login must sign in with OIDC only, from the parameter file (client-id, tenant-id, subscription-id)",
    );
  });

  it("T-E2E-AZ must-fail: provisioning outside Bicep (a resource group made with az, traffic moved with az) is reported", () => {
    const group = text.replace('az deployment group what-if -g "$RG" -p "$PARAMS"\n          az deployment group create -g "$RG" -n "x402-platform', 'az group create -n "$RG" -l eastus2\n          az deployment group what-if -g "$RG" -p "$PARAMS"\n          az deployment group create -g "$RG" -n "x402-platform');
    expect(provisioningOutsideBicep(FILE, group)).toEqual([`${FILE} runs "az group create -n": Azure is provisioned by Bicep only`]);
    const traffic = text.replace('AGENT_STABLE_REVISION="" az deployment group create -g "$RG" -n "x402-promote-$IMAGE_TAG" -p "$PARAMS" -o none', 'az containerapp ingress traffic set -n "$CA_L1" -g "$RG" --revision-weight latest=100');
    expect(provisioningOutsideBicep(FILE, traffic)).toEqual([`${FILE} runs "az containerapp ingress traffic": Azure is provisioned by Bicep only`]);
  });

  it("T-E2E-AZ must-fail: a deployment without what-if, or a missing image, is reported", () => {
    const steps = stepsOf(w).map((s) =>
      s.id === "deploy" ? { ...s, run: s.run!.replace('az deployment group what-if -g "$RG" -p "$PARAMS"\n', "") } : s.id === "build" ? { ...s, run: s.run!.replace("-f Dockerfile ", "-f docker/l1-agent.Dockerfile ") } : s,
    );
    const problems = workflowProblems({ ...w, jobs: { deploy: { ...Object.values(w.jobs)[0], steps } } });
    expect(problems).toContain("deploy must preview main.bicep with what-if before deploying it");
    expect(problems).toContain("build must build x402-seller from Dockerfile");
  });

  it("T-E2E-AZ must-fail: starting the operator job with an approve command is reported", () => {
    const start = 'az containerapp job start -n "$job" -g "$RG" --query name -o tsv';
    expect(text.includes(start)).toBe(true);
    const approve = text.replace(start, 'az containerapp job start -n "$job" -g "$RG" --container-name operator --command node --args dist/scripts/approve.js --query name -o tsv');
    expect(jobStartProblems(FILE, approve)).toHaveLength(1);
  });

  it("T-E2E-AZ must-fail: the target step run late, a missing name or a gate fed by a pipe without pipefail is reported", () => {
    const steps = [...stepsOf(w)];
    steps.splice(3, 0, steps.splice(1, 1)[0]!);
    expect(workflowProblems({ ...w, jobs: { deploy: { ...Object.values(w.jobs)[0], steps } } })).toContain("the target step must run right after the checkout");
    const noName = stepsOf(w).map((s) => (s.id === "target" ? { ...s, run: s.run!.replace('"CAJ_L2=\\(v(["jobs", "l2"]))"', '"X=1"') } : s));
    expect(workflowProblems({ ...w, jobs: { deploy: { ...Object.values(w.jobs)[0], steps: noName } } })).toContain("the target step must read CAJ_L2 from the parameter file's names");
    expect(workflowProblems({ ...w, defaults: undefined })).toContain("every step must run with pipefail (defaults.run.shell: bash), so a failure inside a pipe fails its gate");
  });

  it("T-E2E-AZ must-fail: a rollback skipped when the deploy step itself failed, or a smoke token for another audience, is reported", () => {
    const steps = stepsOf(w).map((s) =>
      s.id === "rollback"
        ? { ...s, if: "failure() && steps.deploy.outcome == 'success'" }
        : s.id === "smoke"
          ? { ...s, run: s.run!.replace('--resource "${{ steps.target.outputs.authAudience }}"', '--resource "api://x402-agent"') }
          : s,
    );
    const problems = workflowProblems({ ...w, jobs: { deploy: { ...Object.values(w.jobs)[0], steps } } });
    expect(problems).toContain("rollback must run on any failure once the deploy step has run, even if that step failed");
    expect(problems).toContain("the smoke run's token must be for the API app's client ID (authAudience), the audience the agent accepts");
  });

  it.skipIf(!BICEP_PATH)("T-E2E-AZ must-fail: a hard-coded resource name is reported", () => {
    const app = buildParams("infra/main.dev.bicepparam").names as { apps: { l1: string } };
    const named = text.replace('-n "$CA_L1" -g', `-n ${app.apps.l1} -g`);
    expect(hardCodedNames(FILE, named)).toEqual([`${FILE} hard-codes ${app.apps.l1}: use names.apps.l1 from the parameter file`]);
  });

  it("T-E2E-AZ must-fail: a third shell script in infra/ is reported", () => {
    expect(infraScriptProblems([...readdirSync("infra"), "naming.sh"])).toEqual([
      "infra/naming.sh: infra/ holds only cleanup.sh and github-setup.sh; everything else is Bicep or its parameter files",
    ]);
  });
});
