// T-E2E-AZ GitHub setup (specs/011 contracts/deploy-pipeline.md; quickstart §4 step 1): infra/github-setup.sh
// against a fake `gh` (test/fixtures/fake-gh.mjs) and an `az` that only compiles parameter files with the real Bicep
// CLI (test/fixtures/fake-azure.mjs; needs BICEP_PATH). From infra/pre-deploy.<environment>.bicepparam it must
// create the GitHub environment deploy.yml's job runs in, in the repository named there.
// Phase 3 (finding #2): the deploy app's federated credential trusts any job that names the environment, so the
// environment lets jobs run from its own refs only, by custom deployment branch policies: the branch main and the
// pipelines' tags (exactly the push triggers of .github/workflows/deploy-*.yml). The script adds the missing policies
// and never deletes one (it reports one it didn't make), and keeps the environment's reviewers and wait timer when it
// turns the policies on.
// It sets nothing else: no workflow reads a secret or a variable. SPEC 1.26: it makes no Auth0 environment and no
// AUTH0_* variable (the tenant is applied on the operator's host, scripts/auth0-tenant.sh), and reports the
// auth0-<environment> environment earlier versions made, without touching it. A secret left in the repository or the
// deploy environment is reported, never used. It refuses, sending nothing, a parameter file whose GitHub environment
// isn't the deploy environment, a malformed repository and a file Bicep can't compile, and changes nothing when
// GitHub would sign the deploy job with another OIDC subject than the deploy app's federated credential trusts
// (azure/login's AADSTS700213).
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { BICEP_PATH } from "./helpers/bicep.js";

const SCRIPT = "infra/github-setup.sh";
const PARAMS = readFileSync("infra/pre-deploy.dev.bicepparam", "utf8")
  .replace("param githubRepository = 'fr-com-dev/agentic-payments'", "param githubRepository = 'acme/agentic-payments'")
  .replace(/^param githubOwnerId = '.*'$/m, "param githubOwnerId = '101'")
  .replace(/^param githubRepositoryId = '.*'$/m, "param githubRepositoryId = '202'");
/** acme/agentic-payments with GitHub's immutable OIDC subject: what the credential for PARAMS trusts. */
const IMMUTABLE = JSON.stringify({ use_default: true, use_immutable_subject: true, sub_claim_prefix: "repo:acme@101/agentic-payments@202" });

interface Run {
  status: number | null;
  out: string;
  calls: string[][];
  /** What each call read on stdin (a PUT's body), by the call's index. */
  stdin: (string | null)[];
}

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

/**
 * Runs the script (or a mutant of it, `mutate` = [from, to]) from a temp repo root holding a copy of infra/ with the
 * dev parameter file `params`, with the fake `gh` and `az` on PATH. `existing` and `envSecrets` name secrets the
 * repository and the environment already hold.
 */
interface Options {
  mutate?: [string, string];
  existing?: string;
  envSecrets?: string;
  /** Environments that exist, by name only (FAKE_GH_ENVIRONMENTS). */
  environments?: string;
  oidc?: string;
  args?: string[];
  /** Environments that exist, as GitHub answers a GET of each (FAKE_GH_ENVIRONMENT_SETTINGS). */
  envSettings?: Record<string, unknown>;
  /** Each environment's deployment branch policies that exist (FAKE_GH_BRANCH_POLICIES). */
  policies?: Record<string, { name: string; type: string }[]>;
  /** More parameter files, by name (pre-deploy.prod.bicepparam). */
  files?: Record<string, string>;
}
function setup(params: string, opts: Options = {}): Run {
  const { mutate, existing = "", envSecrets = "", environments = "", oidc = IMMUTABLE, args = [], envSettings = {}, policies = {}, files = {} } = opts;
  const root = mkdtempSync(join(tmpdir(), "github-setup-"));
  tmp.push(root);
  cpSync("infra", join(root, "infra"), { recursive: true });
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "infra/pre-deploy.dev.bicepparam"), params);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, "infra", name), text);
  const text = readFileSync(SCRIPT, "utf8");
  if (mutate) expect(text.includes(mutate[0]), "github-setup.sh contains the mutation anchor").toBe(true);
  writeFileSync(join(root, SCRIPT), mutate ? text.replace(mutate[0], () => mutate[1]) : text);
  for (const [bin, fixture] of [["gh", "fake-gh.mjs"], ["az", "fake-azure.mjs"]]) {
    writeFileSync(join(root, "bin", bin!), `#!/bin/sh\nexec "${process.execPath}" "${resolve("test/fixtures", fixture!)}" "$@"\n`);
    chmodSync(join(root, "bin", bin!), 0o755);
  }
  const log = join(root, "gh.log");
  const r = spawnSync("bash", [join(root, SCRIPT), ...args], {
    env: {
      PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
      HOME: root,
      BICEP_PATH,
      FAKE_BICEP_HOME: homedir(),
      FAKE_GH_LOG: log,
      FAKE_GH_EXISTING: existing,
      FAKE_GH_ENV_SECRETS: envSecrets,
      FAKE_GH_ENVIRONMENTS: environments,
      FAKE_GH_OIDC_SUB: oidc,
      FAKE_GH_ENVIRONMENT_SETTINGS: JSON.stringify(envSettings),
      FAKE_GH_BRANCH_POLICIES: JSON.stringify(policies),
    },
    encoding: "utf8",
  });
  const logged = existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { args: string[]; stdin: string | null })
    : [];
  return { status: r.status, out: r.stdout + r.stderr, calls: logged.map((c) => c.args), stdin: logged.map((c) => c.stdin) };
}

/**
 * The refs whose jobs may run in the deploy environment, as type:pattern: the deploy pipelines run by hand (from main)
 * or on their own tag. tagsOfPipelines() derives the tags from the workflows.
 */
const DEPLOY_REFS = ["branch:main", "tag:deploy-infra-*", "tag:deploy-l1-*", "tag:deploy-l2-*", "tag:deploy-l3-*", "tag:deploy-operator-*", "tag:deploy-portal-*", "tag:deploy-seller-*"];
/** The body that turns custom deployment branch policies on, with the environment's reviewers and wait timer. */
const body = (reviewers: { type: string; id: number }[] = [], waitTimer = 0, preventSelfReview = false) =>
  JSON.stringify({ wait_timer: waitTimer, prevent_self_review: preventSelfReview, reviewers, deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } });
const ENV = (name: string) => `repos/acme/agentic-payments/environments/${name}`;
const put = (name: string) => ["api", "--method", "PUT", ENV(name), "--input", "-", "--silent"];
const post = (name: string, ref: string) => ["api", "--method", "POST", `${ENV(name)}/deployment-branch-policies`, "-f", `name=${ref.slice(ref.indexOf(":") + 1)}`, "-f", `type=${ref.slice(0, ref.indexOf(":"))}`, "--silent"];

/**
 * What a completed run must have done: create the deploy environment (`put`: the PUT body it must send, or false
 * where the policies were already on) and the branch policies it lacked (`heldPolicies`), and change nothing else
 * (no other environment, no secret, no variable, no policy deleted).
 */
function problems(r: Run, opts: { put?: string | false; heldPolicies?: string[] } = {}): string[] {
  if (r.status !== 0) return [`exit ${r.status}: ${r.out.trim()}`];
  const { put: want = body(), heldPolicies = [] } = opts;
  const p: string[] = [];
  const changed = r.calls.map((c, i) => [c, r.stdin[i]] as const).filter(([c]) => c.includes("--method") || ((c[0] === "secret" || c[0] === "variable") && c[1] !== "list"));
  const changes = changed.map(([c]) => c);
  const environment = [...(want === false ? [] : [put("dev")]), ...DEPLOY_REFS.filter((ref) => !heldPolicies.includes(`dev/${ref}`)).map((ref) => post("dev", ref))];
  if (JSON.stringify(changes) !== JSON.stringify(environment)) {
    p.push(`changed ${JSON.stringify(changes)}, not only the environment dev in acme/agentic-payments, open to its own refs`);
  }
  const sent = changed.find(([c]) => JSON.stringify(c) === JSON.stringify(put("dev")))?.[1]?.trim();
  if (want !== false && sent !== undefined && sent !== want) p.push(`the environment dev was sent ${sent}, not ${want}`);
  return p;
}

/** The tags the deploy pipelines run on: each .github/workflows/deploy-<unit>.yml's push trigger. */
function tagsOfPipelines(): string[] {
  return readdirSync(".github/workflows")
    .filter((f) => /^deploy-[a-z0-9]+\.yml$/.test(f))
    .flatMap((f) => ((parse(readFileSync(`.github/workflows/${f}`, "utf8")) as { on?: { push?: { tags?: string[] } } }).on?.push?.tags ?? []).map((t) => `tag:${t}`))
    .sort();
}

/** The refs github-setup.sh opens the deploy environment to must be exactly the deploy pipelines'. SPEC 1.26: it makes no Auth0 environment. */
export function refProblems(script: string): string[] {
  const p: string[] = [];
  const list = (name: string) => [...(new RegExp(`^${name}=\\((.*)\\)$`, "m").exec(script)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  const deploy = list("DEPLOY_REFS");
  if (JSON.stringify(deploy) !== JSON.stringify(["branch:main", ...tagsOfPipelines()])) {
    p.push(`the deploy environment must be open to the branch main and the deploy pipelines' tags (${tagsOfPipelines().join(", ")}) only, not ${deploy.join(", ")}`);
  }
  if (/AUTH0_REFS|\bprotect "\$GH_AUTH0_ENV"|gh variable set/.test(script)) p.push("github-setup.sh must make no Auth0 environment and set no variable: the tenant is applied on the operator's host (SPEC 1.26)");
  return p;
}

// Each run spawns node once per `gh` call, and the Bicep CLI once.
describe.skipIf(!BICEP_PATH)("T-E2E-AZ GitHub setup (infra/github-setup.sh against a fake gh)", { timeout: 30_000 }, () => {
  it("T-E2E-AZ github-setup.sh creates the deploy job's GitHub environment, in the repository the parameter file names, and sets no secret and no variable", () => {
    const r = setup(PARAMS);
    expect(problems(r)).toEqual([]);
    expect(r.out).toContain("environment dev: ready in acme/agentic-payments, open to the branch main, the tag deploy-infra-*, the tag deploy-l1-*");
    expect(r.out).toContain("Give it required reviewers by hand (Settings > Environments > dev > Required reviewers)");
    expect(r.calls.some((c) => c.some((a) => a.includes("auth0-dev")) && c.includes("--method"))).toBe(false);
    expect(r.out).not.toContain("warning");
  });

  it("SPEC 1.26: github-setup.sh reports the Auth0 environment an earlier version made, and leaves it as it is", () => {
    const r = setup(PARAMS, { environments: "auth0-dev" });
    expect(problems(r)).toEqual([]);
    expect(r.out).toContain("warning: acme/agentic-payments still has the GitHub environment auth0-dev, with the Auth0 Management API credential");
    expect(r.out).toContain("gh api --method DELETE repos/acme/agentic-payments/environments/auth0-dev");
  });

  it("T-E2E-AZ github-setup.sh --dry-run only reads the repository's OIDC subject", () => {
    const r = setup(PARAMS, { args: ["--dry-run"] });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([["api", "repos/acme/agentic-payments/actions/oidc/customization/sub"]]);
    expect(r.out).toContain("dry run: would create the environment dev in acme/agentic-payments, open to the branch main, the tag deploy-infra-*");
    expect(r.out).toContain("the tag deploy-seller-* only");
    expect(r.out).not.toContain("auth0-dev");
  });

  it("T-E2E-AZ github-setup.sh opens the deploy environment to main and exactly the deploy pipelines' tags, and makes no Auth0 environment", () => {
    expect(tagsOfPipelines()).toHaveLength(7);
    expect(refProblems(readFileSync(SCRIPT, "utf8"))).toEqual([]);
  });

  it.each([
    ["a pipeline's tag left out", '"tag:deploy-portal-*" ', ""],
    ["every tag", '"tag:deploy-infra-*"', '"tag:*"'],
    ["every branch", 'DEPLOY_REFS=("branch:main"', 'DEPLOY_REFS=("branch:*"'],
    ["SPEC 1.26: the Auth0 environment back", 'refs() {', 'AUTH0_REFS=("branch:main")\nrefs() {'],
  ])("T-E2E-AZ must-fail: an environment open to other refs than its pipelines' (%s) is reported", (_, from, to) => {
    const text = readFileSync(SCRIPT, "utf8");
    expect(text.includes(from), "github-setup.sh contains the mutation anchor").toBe(true);
    expect(refProblems(text.replace(from, () => to))).not.toEqual([]);
  });

  it("T-E2E-AZ must-fail: without custom branch policies, any branch's job could run in the environment, and it is reported", () => {
    const r = setup(PARAMS, { mutate: ["custom_branch_policies: true }", "custom_branch_policies: false }"] });
    expect(problems(r).join("\n")).toContain('"custom_branch_policies":false');
  });

  it("T-E2E-AZ github-setup.sh keeps an environment's reviewers and wait timer when it turns the branch policies on", () => {
    const envSettings = {
      dev: {
        name: "dev",
        protection_rules: [
          { id: 1, type: "required_reviewers", prevent_self_review: true, reviewers: [{ type: "User", reviewer: { id: 4242, login: "someone" } }, { type: "Team", reviewer: { id: 77, slug: "ops" } }] },
          { id: 2, type: "wait_timer", wait_timer: 5 },
        ],
        deployment_branch_policy: null,
      },
    };
    const keep = body([{ type: "User", id: 4242 }, { type: "Team", id: 77 }], 5, true);
    const r = setup(PARAMS, { envSettings });
    expect(problems(r, { put: keep })).toEqual([]);
    const dropped = setup(PARAMS, { envSettings, mutate: ['reviewers: [.protection_rules[]? | select(.type == "required_reviewers") | .reviewers[]? | {type, id: .reviewer.id}],', "reviewers: [],"] });
    expect(problems(dropped, { put: keep }).join("\n"), "must-fail: without them, the PUT drops the reviewers").toContain("the environment dev was sent");
  });

  it("T-E2E-AZ github-setup.sh adds only the missing branch policies, deletes none, and reports one it didn't make", () => {
    const envSettings = { dev: { name: "dev", protection_rules: [], deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } } };
    const policies = { dev: [{ name: "main", type: "branch" }, { name: "deploy-l1-*", type: "tag" }, { name: "release", type: "branch" }] };
    const r = setup(PARAMS, { envSettings, policies });
    expect(problems(r, { put: false, heldPolicies: ["dev/branch:main", "dev/tag:deploy-l1-*"] })).toEqual([]);
    expect(r.calls.some((c) => c.includes("DELETE"))).toBe(false);
    expect(r.out).toContain("warning: the environment dev also lets jobs run from the branch release, which this script didn't make");
    const again = setup(PARAMS, { envSettings, policies, mutate: ['if grep -qxF "$ref" <<< "$held"; then continue; fi', "if false; then continue; fi"] });
    expect(problems(again, { put: false, heldPolicies: ["dev/branch:main", "dev/tag:deploy-l1-*"] })[0], "must-fail: without the check, a policy that exists is made again").toMatch(/not only the environment dev/);
  });

  it("T-E2E-AZ github-setup.sh reports secrets left in the repository or the environment, and keeps them", () => {
    const r = setup(PARAMS, { existing: "AZURE_CLIENT_ID", envSecrets: "AZURE_CLIENT_SECRET" });
    expect(problems(r)).toEqual([]);
    expect(r.out).toMatch(/warning: acme\/agentic-payments holds the secrets AZURE_CLIENT_ID AZURE_CLIENT_SECRET, which no workflow reads/);
  });

  it.each([
    ["a GitHub environment other than the deploy environment", PARAMS.replace("param githubEnvironment = environment", "param githubEnvironment = 'production'"), "githubEnvironment production is not dev"],
    ["a malformed repository", PARAMS.replace("'acme/agentic-payments'", "'agentic-payments'"), "githubRepository agentic-payments is not owner/name"],
    ["a parameter file Bicep can't compile", PARAMS.replace("param githubRepository = 'acme/agentic-payments'", "param githubRepository = 42"), "Bicep can't compile"],
  ])("T-E2E-AZ github-setup.sh refuses %s, and sends nothing", (_, params, message) => {
    const r = setup(params);
    expect(r.status).toBe(2);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain(message);
  });

  it.each([
    ["another repository ID", JSON.stringify({ use_default: true, use_immutable_subject: true, sub_claim_prefix: "repo:acme@101/agentic-payments@999" }), "as repo:acme@101/agentic-payments@999:…"],
    ["the subject without IDs (immutable subject off)", JSON.stringify({ use_default: true, use_immutable_subject: false }), "as repo:acme/agentic-payments:…"],
    ["a custom claim template", JSON.stringify({ use_default: false, include_claim_keys: ["repo", "context"] }), "as a custom claim template:…"],
  ])("T-E2E-AZ github-setup.sh refuses, changing nothing, when GitHub signs the deploy job with %s", (_, oidc, message) => {
    const r = setup(PARAMS, { oidc });
    expect(r.status).toBe(2);
    expect(r.calls.filter((c) => c.includes("--method") || c[0] === "secret")).toEqual([]);
    expect(r.out).toContain(message);
    expect(r.out).toContain("but the deploy app's federated credential trusts repo:acme@101/agentic-payments@202:…");
  });

  it("T-E2E-AZ github-setup.sh refuses an environment without a pre-deploy parameter file", () => {
    const r = setup(PARAMS, { args: ["--environment", "prod"] });
    expect(r.status).toBe(2);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain("no infra/pre-deploy.prod.bicepparam");
  });

  it("T-E2E-AZ must-fail: without the subject check, the environment is made for a deploy job that can't sign in", () => {
    const oidc = JSON.stringify({ use_default: true, use_immutable_subject: false });
    const r = setup(PARAMS, { oidc, mutate: ['if [[ "$SIGNED" != "$TRUSTED" ]]; then', "if false; then"] });
    expect(r.status).toBe(0);
    expect(r.calls.some((c) => c.includes("PUT"))).toBe(true);
  });

  it("T-E2E-AZ must-fail: without the environment check, a GitHub environment the deploy job never runs in is created, and it is reported", () => {
    const params = PARAMS.replace("param githubEnvironment = environment", "param githubEnvironment = 'production'");
    const r = setup(params, { mutate: ['[[ "$GH_ENV" == "$ENVIRONMENT" ]] ||', "true ||"] });
    expect(problems(r)[0]).toMatch(/environments\/production/);
  });
});
