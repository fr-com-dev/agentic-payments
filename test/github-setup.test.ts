// T-E2E-AZ GitHub setup (specs/011 contracts/deploy-pipeline.md; quickstart §4 step 1): infra/github-setup.sh
// against a fake `gh` (test/fixtures/fake-gh.mjs) and an `az` that only compiles parameter files with the real Bicep
// CLI (test/fixtures/fake-azure.mjs; needs BICEP_PATH). From infra/pre-deploy.<environment>.bicepparam it must
// create the GitHub environment deploy.yml's job runs in and the one provision-auth0.yml's job runs in
// (auth0-<environment>), in the repository named there, and in the latter the AUTH0_* variables that are missing
// (Terraform's: placeholders for the three without a default, the defaults for the others, of which the machine
// callers' keys, 016, as the empty map; the local origins on for dev only, Phase 3; never the portal's or the agent's
// origin, which have no value yet), never changing one that exists.
// Phase 3 (finding #2): the deploy app's federated credentials trust any job that names the environment, so each
// environment lets jobs run from its own refs only, by custom deployment branch policies: the deploy environment
// from the branch main and the pipelines' tags (exactly the push triggers of .github/workflows/deploy-*.yml), the
// Auth0 environment from main only. The script adds the missing policies and never deletes one (it reports one it
// didn't make), and keeps an environment's reviewers and wait timer when it turns the policies on.
// It sets nothing else: deploy.yml reads no secret, and the Auth0 environment's secrets are set by hand. A secret left in the repository or the deploy environment is reported, never
// used. It refuses, sending nothing, a parameter file whose GitHub environment isn't the deploy environment or whose
// Auth0 environment isn't auth0-<environment>, a malformed
// repository and a file Bicep can't compile, and changes nothing when GitHub would sign the deploy job with another
// OIDC subject than the deploy app's federated credential trusts (azure/login's AADSTS700213).
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
  envVariables?: string;
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
  const { mutate, existing = "", envSecrets = "", envVariables = "", oidc = IMMUTABLE, args = [], envSettings = {}, policies = {}, files = {} } = opts;
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
      FAKE_GH_ENV_VARIABLES: envVariables,
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

/** The Auth0 environment's variables the script creates when missing (for dev): placeholders, then the defaults. */
const VARIABLES: [string, string][] = [
  ["AUTH0_TENANT_DOMAIN", "REPLACE_ME"],
  ["AUTH0_API_IDENTIFIER", "REPLACE_ME"],
  ["AUTH0_CLIENT_PUBLIC_KEY", "REPLACE_ME"],
  ["AUTH0_MANAGE_GUARDIAN", "true"],
  ["AUTH0_GUARDIAN_POLICY", "never"],
  ["AUTH0_MACHINE_CALLER_KEYS", "{}"],
  ["AUTH0_LOCAL_ORIGINS", "true"],
  ["AUTH0_ALLOW_SIGN_UPS", "true"],
];
/**
 * The refs whose jobs may run in each environment, as type:pattern: the deploy pipelines run by hand (from main) or
 * on their own tag; the Auth0 pipeline by hand only. tagsOfPipelines() derives the tags from the workflows.
 */
const DEPLOY_REFS = ["branch:main", "tag:deploy-infra-*", "tag:deploy-l1-*", "tag:deploy-l2-*", "tag:deploy-l3-*", "tag:deploy-operator-*", "tag:deploy-portal-*", "tag:deploy-seller-*"];
const AUTH0_REFS = ["branch:main"];
/** The body that turns custom deployment branch policies on, with the environment's reviewers and wait timer. */
const body = (reviewers: { type: string; id: number }[] = [], waitTimer = 0, preventSelfReview = false) =>
  JSON.stringify({ wait_timer: waitTimer, prevent_self_review: preventSelfReview, reviewers, deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } });
const ENV = (name: string) => `repos/acme/agentic-payments/environments/${name}`;
const put = (name: string) => ["api", "--method", "PUT", ENV(name), "--input", "-", "--silent"];
const post = (name: string, ref: string) => ["api", "--method", "POST", `${ENV(name)}/deployment-branch-policies`, "-f", `name=${ref.slice(ref.indexOf(":") + 1)}`, "-f", `type=${ref.slice(0, ref.indexOf(":"))}`, "--silent"];

/**
 * What a completed run must have done: create each environment (`put`: the PUT body it must send, or false where
 * the policies were already on) and the branch policies it lacked (`heldPolicies`), then the Auth0 environment's
 * variables that weren't `held`, and change nothing else (no secret, no variable anywhere else, no policy deleted).
 */
function problems(r: Run, held: string[] = [], opts: { put?: Record<string, string | false>; heldPolicies?: string[]; variables?: [string, string][] } = {}): string[] {
  if (r.status !== 0) return [`exit ${r.status}: ${r.out.trim()}`];
  const { put: puts = {}, heldPolicies = [], variables = VARIABLES } = opts;
  const p: string[] = [];
  const changed = r.calls.map((c, i) => [c, r.stdin[i]] as const).filter(([c]) => c.includes("--method") || ((c[0] === "secret" || c[0] === "variable") && c[1] !== "list"));
  const changes = changed.map(([c]) => c);
  const environment = (name: string, refs: string[]) => [...(puts[name] === false ? [] : [put(name)]), ...refs.filter((ref) => !heldPolicies.includes(`${name}/${ref}`)).map((ref) => post(name, ref))];
  const set = variables.filter(([name]) => !held.includes(name)).map(([name, value]) => ["variable", "set", name, "--repo", "acme/agentic-payments", "--env", "auth0-dev", "--body", value]);
  if (JSON.stringify(changes) !== JSON.stringify([...environment("dev", DEPLOY_REFS), ...environment("auth0-dev", AUTH0_REFS), ...set])) {
    p.push(`changed ${JSON.stringify(changes)}, not only the environments dev and auth0-dev in acme/agentic-payments, open to their own refs, and auth0-dev's missing variables`);
  }
  for (const name of ["dev", "auth0-dev"]) {
    const sent = changed.find(([c]) => JSON.stringify(c) === JSON.stringify(put(name)))?.[1]?.trim();
    const want = puts[name] ?? body();
    if (want !== false && sent !== undefined && sent !== want) p.push(`the environment ${name} was sent ${sent}, not ${want}`);
  }
  return p;
}

/** The tags the deploy pipelines run on: each .github/workflows/deploy-<unit>.yml's push trigger. */
function tagsOfPipelines(): string[] {
  return readdirSync(".github/workflows")
    .filter((f) => /^deploy-[a-z0-9]+\.yml$/.test(f))
    .flatMap((f) => ((parse(readFileSync(`.github/workflows/${f}`, "utf8")) as { on?: { push?: { tags?: string[] } } }).on?.push?.tags ?? []).map((t) => `tag:${t}`))
    .sort();
}

/** The refs github-setup.sh opens each environment to must be exactly the deploy pipelines' and the Auth0 pipeline's. */
export function refProblems(script: string): string[] {
  const p: string[] = [];
  const list = (name: string) => [...(new RegExp(`^${name}=\\((.*)\\)$`, "m").exec(script)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  const deploy = list("DEPLOY_REFS");
  const auth0 = list("AUTH0_REFS");
  if (JSON.stringify(deploy) !== JSON.stringify(["branch:main", ...tagsOfPipelines()])) {
    p.push(`the deploy environment must be open to the branch main and the deploy pipelines' tags (${tagsOfPipelines().join(", ")}) only, not ${deploy.join(", ")}`);
  }
  if (JSON.stringify(auth0) !== JSON.stringify(AUTH0_REFS)) p.push(`the Auth0 environment must be open to the branch main only (provision-auth0.yml runs by hand), not ${auth0.join(", ")}`);
  return p;
}

// Each run spawns node once per `gh` call, and the Bicep CLI once.
describe.skipIf(!BICEP_PATH)("T-E2E-AZ GitHub setup (infra/github-setup.sh against a fake gh)", { timeout: 30_000 }, () => {
  it("T-E2E-AZ github-setup.sh creates the deploy job's and the Auth0 job's GitHub environments, in the repository the parameter file names, and sets no secret", () => {
    const r = setup(PARAMS);
    expect(problems(r)).toEqual([]);
    expect(r.out).toContain("environment dev: ready in acme/agentic-payments, open to the branch main, the tag deploy-infra-*, the tag deploy-l1-*");
    expect(r.out).toContain("Give it required reviewers by hand (Settings > Environments > dev > Required reviewers)");
    expect(r.out).toContain("environment auth0-dev: ready in acme/agentic-payments, open to the branch main only. Give it required reviewers");
    expect(r.out).not.toContain("warning");
  });

  it("T-E2E-AZ github-setup.sh --dry-run only reads the repository's OIDC subject", () => {
    const r = setup(PARAMS, { args: ["--dry-run"] });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([["api", "repos/acme/agentic-payments/actions/oidc/customization/sub"]]);
    expect(r.out).toContain("dry run: would create the environment dev in acme/agentic-payments, open to the branch main, the tag deploy-infra-*");
    expect(r.out).toContain("the tag deploy-seller-* only");
    expect(r.out).toContain("dry run: would create the environment auth0-dev in acme/agentic-payments, open to the branch main only, and its missing AUTH0_* variables");
  });

  it("T-E2E-AZ github-setup.sh opens the deploy environment to main and exactly the deploy pipelines' tags, and the Auth0 environment to main only", () => {
    expect(tagsOfPipelines()).toHaveLength(7);
    expect(refProblems(readFileSync(SCRIPT, "utf8"))).toEqual([]);
  });

  it.each([
    ["a pipeline's tag left out", '"tag:deploy-portal-*" ', ""],
    ["every tag", '"tag:deploy-infra-*"', '"tag:*"'],
    ["every branch", 'DEPLOY_REFS=("branch:main"', 'DEPLOY_REFS=("branch:*"'],
    ["the Auth0 environment open to a tag", 'AUTH0_REFS=("branch:main")', 'AUTH0_REFS=("branch:main" "tag:deploy-infra-*")'],
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
    expect(problems(r, [], { put: { dev: keep } })).toEqual([]);
    const dropped = setup(PARAMS, { envSettings, mutate: ['reviewers: [.protection_rules[]? | select(.type == "required_reviewers") | .reviewers[]? | {type, id: .reviewer.id}],', "reviewers: [],"] });
    expect(problems(dropped, [], { put: { dev: keep } }).join("\n"), "must-fail: without them, the PUT drops the reviewers").toContain("the environment dev was sent");
  });

  it("T-E2E-AZ github-setup.sh adds only the missing branch policies, deletes none, and reports one it didn't make", () => {
    const envSettings = { dev: { name: "dev", protection_rules: [], deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } } };
    const policies = { dev: [{ name: "main", type: "branch" }, { name: "deploy-l1-*", type: "tag" }, { name: "release", type: "branch" }] };
    const r = setup(PARAMS, { envSettings, policies });
    expect(problems(r, [], { put: { dev: false }, heldPolicies: ["dev/branch:main", "dev/tag:deploy-l1-*"] })).toEqual([]);
    expect(r.calls.some((c) => c.includes("DELETE"))).toBe(false);
    expect(r.out).toContain("warning: the environment dev also lets jobs run from the branch release, which this script didn't make");
    const again = setup(PARAMS, { envSettings, policies, mutate: ['if grep -qxF "$ref" <<< "$held"; then continue; fi', "if false; then continue; fi"] });
    expect(problems(again, [], { put: { dev: false }, heldPolicies: ["dev/branch:main", "dev/tag:deploy-l1-*"] })[0], "must-fail: without the check, a policy that exists is made again").toMatch(/not only the environments dev and auth0-dev/);
  });

  it("T-E2E-AZ github-setup.sh creates the Auth0 environment's eight variables, the three without a default as placeholders to replace, and neither origin", () => {
    const r = setup(PARAMS);
    expect(problems(r)).toEqual([]);
    expect(r.calls.some((c) => c.includes("AUTH0_PORTAL_ORIGIN") || c.includes("AUTH0_AGENT_ORIGIN") || c.includes("AUTH0_APPROVER_USER_ID"))).toBe(false);
    expect(r.out).toContain("replace the placeholders before the first run (gh variable set <name> --repo acme/agentic-payments --env auth0-dev): AUTH0_TENANT_DOMAIN AUTH0_API_IDENTIFIER AUTH0_CLIENT_PUBLIC_KEY.");
  });

  it("T-E2E-AZ github-setup.sh allows the local origins in dev only", () => {
    const prod = PARAMS.replace("var environment = 'dev'", "var environment = 'prod'");
    const r = setup(PARAMS, { args: ["--environment", "prod"], files: { "pre-deploy.prod.bicepparam": prod } });
    expect(r.status, r.out).toBe(0);
    expect(r.calls).toContainEqual(["variable", "set", "AUTH0_LOCAL_ORIGINS", "--repo", "acme/agentic-payments", "--env", "auth0-prod", "--body", "false"]);
    const mutated = setup(PARAMS, { args: ["--environment", "prod"], files: { "pre-deploy.prod.bicepparam": prod }, mutate: ['if [[ "$ENVIRONMENT" == "dev" ]]; then LOCAL_ORIGINS=true; fi', "LOCAL_ORIGINS=true"] });
    expect(mutated.calls, "must-fail: without the check, a deployed environment's tenant allows localhost").toContainEqual(["variable", "set", "AUTH0_LOCAL_ORIGINS", "--repo", "acme/agentic-payments", "--env", "auth0-prod", "--body", "true"]);
  });

  it("T-E2E-AZ github-setup.sh keeps an Auth0 variable that exists, and creates only the missing ones", () => {
    const held = ["AUTH0_TENANT_DOMAIN", "AUTH0_GUARDIAN_POLICY"];
    const r = setup(PARAMS, { envVariables: held.join(" ") });
    expect(problems(r, held)).toEqual([]);
    expect(r.out).toContain("variable AUTH0_TENANT_DOMAIN: already in auth0-dev, kept");
    expect(r.out).toContain("AUTH0_API_IDENTIFIER AUTH0_CLIENT_PUBLIC_KEY.");
    const all = setup(PARAMS, { envVariables: VARIABLES.map(([name]) => name).join(" ") });
    expect(problems(all, VARIABLES.map(([name]) => name))).toEqual([]);
    expect(all.out).not.toContain("replace the placeholders");
  });

  it("T-E2E-AZ must-fail: without the check for existing variables, a tenant domain already set is overwritten with the placeholder, and it is reported", () => {
    const r = setup(PARAMS, { envVariables: "AUTH0_TENANT_DOMAIN", mutate: ['if grep -qxF "$name" <<< "$HELD"; then', "if false; then"] });
    expect(problems(r, ["AUTH0_TENANT_DOMAIN"])[0]).toMatch(/"variable","set","AUTH0_TENANT_DOMAIN".*"REPLACE_ME"/);
  });

  it("T-E2E-AZ github-setup.sh reports secrets left in the repository or the environment, and keeps them", () => {
    const r = setup(PARAMS, { existing: "AZURE_CLIENT_ID", envSecrets: "AZURE_CLIENT_SECRET" });
    expect(problems(r)).toEqual([]);
    expect(r.out).toMatch(/warning: acme\/agentic-payments holds the secrets AZURE_CLIENT_ID AZURE_CLIENT_SECRET, which no workflow reads/);
  });

  it.each([
    ["a GitHub environment other than the deploy environment", PARAMS.replace("param githubEnvironment = environment", "param githubEnvironment = 'production'"), "githubEnvironment production is not dev"],
    ["an Auth0 environment other than auth0-<environment>", PARAMS.replace("param githubAuth0Environment = 'auth0-${environment}'", "param githubAuth0Environment = environment"), "githubAuth0Environment dev is not auth0-dev"],
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

  it("T-E2E-AZ must-fail: without the Auth0 environment check, the Auth0 job's secrets would go in the deploy environment, and it is reported", () => {
    const params = PARAMS.replace("param githubAuth0Environment = 'auth0-${environment}'", "param githubAuth0Environment = environment");
    const r = setup(params, { mutate: ['[[ "$GH_AUTH0_ENV" == "auth0-$ENVIRONMENT" ]] ||', "true ||"] });
    expect(problems(r)[0]).toMatch(/not only the environments dev and auth0-dev/);
    expect(r.calls.some((c) => c[0] === "variable" && c[1] === "set" && c.includes("dev") && !c.includes("auth0-dev"))).toBe(true);
  });

  it("T-E2E-AZ must-fail: without the environment check, a GitHub environment the deploy job never runs in is created, and it is reported", () => {
    const params = PARAMS.replace("param githubEnvironment = environment", "param githubEnvironment = 'production'");
    const r = setup(params, { mutate: ['[[ "$GH_ENV" == "$ENVIRONMENT" ]] ||', "true ||"] });
    expect(problems(r)[0]).toMatch(/environments\/production/);
  });
});
