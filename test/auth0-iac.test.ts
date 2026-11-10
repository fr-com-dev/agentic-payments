// 012 T-IAC-02: auth0/, the Auth0 tenant as Terraform (specs/012 research R17), checked offline. The checks read the
// .tf sources as text, like T-E2E-AZ reads the workflows, and cross-check what L2 depends on against the source
// (DETAILS_TYPE) and the Bicep parameter file (the ciba keys). Each check has a must-fail mutant. With Terraform on
// PATH, `terraform fmt -check` runs too; `terraform validate` runs once `terraform init` has been run by hand.
// Its pipeline, .github/workflows/provision-auth0.yml, is checked here too (pipelineProblems): by hand only, in its
// own GitHub environment, the only workflow that reads secrets and only in its plan and apply steps, the pinned
// Terraform and the locked provider, the state in Azure with OIDC and no key, and an apply of exactly the plan shown.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { DETAILS_TYPE } from "../src/layer2-control/payment-details.js";

const DIR = "auth0";
const WORKFLOW = ".github/workflows/provision-auth0.yml";
/** The only GitHub secrets any workflow reads: the Management API credential and, with credential = "secret", L2's. */
const SECRETS = ["AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "AUTH0_L2_CLIENT_SECRET"];

interface Sources {
  /** auth0/*.tf by file name. */
  tf: Record<string, string>;
  /** Every file under auth0/ except .terraform/, by name. */
  all: Record<string, string>;
  gitignore: string;
  dockerignore: string;
  bicepparam: string;
  /** .github/workflows/provision-auth0.yml. */
  workflow: string;
  /** infra/modules/state-storage.bicep: the state's container. */
  stateStorage: string;
}

function load(): Sources {
  const names = readdirSync(DIR).filter((f) => !f.startsWith(".terraform"));
  const all = Object.fromEntries(names.map((f) => [f, readFileSync(join(DIR, f), "utf8")]));
  return {
    tf: Object.fromEntries(Object.entries(all).filter(([f]) => f.endsWith(".tf"))),
    all,
    gitignore: readFileSync(".gitignore", "utf8"),
    dockerignore: readFileSync(".dockerignore", "utf8"),
    bicepparam: readFileSync("infra/main.dev.bicepparam", "utf8"),
    workflow: readFileSync(WORKFLOW, "utf8"),
    stateStorage: readFileSync("infra/modules/state-storage.bicep", "utf8"),
  };
}

/** The body of the first block whose header matches, by brace counting (the sources' strings have balanced braces). */
function block(text: string, header: RegExp): string | undefined {
  const m = header.exec(text);
  if (!m) return undefined;
  let depth = 0;
  const start = text.indexOf("{", m.index);
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start + 1, i);
  }
  return undefined;
}

/** HCL without comments, so a comment never satisfies or trips a check. */
const code = (text: string) => text.replace(/#.*$/gm, "").replace(/\/\/.*$/gm, "");
const has = (body: string | undefined, re: RegExp) => body !== undefined && re.test(body);

/** One message per problem. Empty for the real sources. */
export function auth0Problems(s: Sources): string[] {
  const p: string[] = [];
  const tf = code(Object.values(s.tf).join("\n"));

  // Provider: the official one, pinned within 1.x, credentials from the environment only.
  const req = block(tf, /required_providers\s*\{/) ?? "";
  if (!/source\s*=\s*"auth0\/auth0"/.test(req) || !/version\s*=\s*">= 1\.60\.0, < 2\.0\.0"/.test(req)) p.push("the provider must be auth0/auth0 pinned to >= 1.60.0, < 2.0.0");
  if (!/required_version\s*=\s*">= 1\.11\.0"/.test(tf)) p.push("Terraform must be >= 1.11.0 (write-only arguments keep the client secret out of state)");
  const provider = block(tf, /provider\s+"auth0"\s*\{/) ?? "";
  if (/client_id|client_secret|api_token|client_assertion/.test(provider)) p.push("the provider block must take credentials from the environment only, never from a file");

  // The payment-details type: the one L2 sends.
  const type = /details_type\s*=\s*"([^"]+)"/.exec(tf)?.[1];
  if (type !== DETAILS_TYPE) p.push(`local.details_type must equal DETAILS_TYPE (${DETAILS_TYPE}), the type L2 sends`);

  // The API.
  const api = block(tf, /resource\s+"auth0_resource_server"\s+"payments"\s*\{/);
  if (!api) p.push("the approval API (auth0_resource_server.payments) is missing");
  else {
    if (!has(api, /signing_alg\s*=\s*"RS256"/)) p.push("the API must sign with RS256 (L2 accepts RS256 only)");
    if (!has(api, /token_dialect\s*=\s*"rfc9068_profile(_authz)?"/)) p.push("the API must use the RFC 9068 token profile (tokens carry jti)");
    if (!has(api, /allow_offline_access\s*=\s*false/)) p.push("the API must not allow offline access (no refresh tokens)");
    if (!has(api, /consent_policy\s*=\s*"null"/)) p.push('the API must use standard consent (consent_policy = "null"); CIBA is not supported with transactional-authorization-with-mfa');
    if (!has(block(api, /authorization_details\s*\{/), /type\s*=\s*local\.details_type/)) p.push("the API must register local.details_type as an authorization_details type");
    const sta = block(api, /subject_type_authorization\s*\{/);
    if (!has(block(sta ?? "", /user\s*\{/), /policy\s*=\s*"require_client_grant"/)) p.push("users may request the type only through a client grant (user policy require_client_grant)");
    if (!has(block(sta ?? "", /client\s*\{/), /policy\s*=\s*"deny_all"/)) p.push("no machine-to-machine token for the API (client policy deny_all)");
  }

  // L2's client.
  const client = block(tf, /resource\s+"auth0_client"\s+"l2"\s*\{/);
  if (!client) p.push("L2's client (auth0_client.l2) is missing");
  else {
    if (!has(client, /grant_types\s*=\s*\["urn:openid:params:grant-type:ciba"\]/)) p.push("L2's client must have the CIBA grant and no other");
    if (!has(client, /async_approval_notification_channels\s*=\s*\["guardian-push"\]/)) p.push("L2's client must notify through guardian-push only");
    if (!has(client, /is_first_party\s*=\s*true/) || !has(client, /oidc_conformant\s*=\s*true/) || !has(client, /app_type\s*=\s*"regular_web"/)) {
      p.push("L2's client must be a first-party, OIDC-conformant regular_web (confidential) client");
    }
  }

  // The grant.
  const grant = block(tf, /resource\s+"auth0_client_grant"\s+"l2_ciba"\s*\{/);
  if (!has(grant, /client_id\s*=\s*auth0_client\.l2\.client_id/) || !has(grant, /subject_type\s*=\s*"user"/) || !has(grant, /authorization_details_types\s*=\s*\[local\.details_type\]/)) {
    p.push("a user-delegated client grant must let L2's client, and only it, request local.details_type");
  }

  // The credential: the public key, RS256, or a write-only secret.
  const cred = block(tf, /resource\s+"auth0_client_credentials"\s+"l2"\s*\{/) ?? "";
  if (!/credential_type\s*=\s*"public_key"/.test(cred) || !/pem\s*=\s*file\(var\.client_public_key_file\)/.test(cred)) p.push("the private_key_jwt credential must be the public key read from client_public_key_file");
  const algs = [...cred.matchAll(/algorithm\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  if (algs.length === 0 || algs.some((a) => a !== "RS256")) p.push("the credential's algorithm must be RS256 (what L2 signs; Auth0 never takes ES256)");
  if (/\bclient_secret\s*=/.test(cred)) p.push("the client secret must be write-only (client_secret_wo), never stored in state");
  const secretVar = block(tf, /variable\s+"client_secret"\s*\{/) ?? "";
  if (!/sensitive\s*=\s*true/.test(secretVar) || !/ephemeral\s*=\s*true/.test(secretVar)) p.push("var.client_secret must be sensitive and ephemeral");

  // Guardian push, never destroyed.
  const guardian = block(tf, /resource\s+"auth0_guardian"\s+"this"\s*\{/) ?? "";
  if (!/enabled\s*=\s*true/.test(block(guardian, /push\s*\{/) ?? "") || !/provider\s*=\s*"guardian"/.test(guardian)) p.push("Guardian push through the Guardian app must be on");
  if (!/prevent_destroy\s*=\s*true/.test(guardian)) p.push("auth0_guardian must never be destroyed (it would turn off every MFA factor of the tenant)");

  // Nothing here manages users or holds secrets.
  if (/resource\s+"auth0_user"/.test(tf) || /\bpassword\s*=/.test(tf)) p.push("users and passwords are never managed here");
  for (const [f, text] of Object.entries(s.all)) {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) p.push(`${f} holds a private key`);
    if (/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/.test(text)) p.push(`${f} holds a JWT`);
    if (f.endsWith(".tfstate") || f.endsWith(".tfplan")) p.push(`${f} must not be committed`);
    // An environment's tfvars are committed for the pipeline, so they hold no credential.
    if (f.endsWith(".tfvars") && /^\s*(client_secret|\w*(password|token|private_key)\w*)\s*=/m.test(code(text))) p.push(`${f} holds a credential: it is committed, and secrets come from the pipeline's GitHub environment only`);
  }

  // The output L2's parameter file takes: exactly the keys main.bicep reads.
  const want = Object.keys(bicepCiba(s.bicepparam)).sort();
  const out = block(block(tf, /output\s+"bicepparam_ciba"\s*\{/) ?? "", /value\s*=\s*\{/) ?? "";
  const got = [...out.matchAll(/^\s*(\w+)\s*=/gm)].map((m) => m[1]!).sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) p.push(`output bicepparam_ciba must have exactly the ciba keys of the parameter file (${want.join(", ")}), got ${got.join(", ")}`);

  // The state: a blob in Azure, read and written with an Entra sign-in; nothing of it is written in the folder.
  const backend = block(tf, /backend\s+"azurerm"\s*\{/);
  if (!has(backend, /use_azuread_auth\s*=\s*true/)) p.push('the state must be in Azure with an Entra sign-in (backend "azurerm", use_azuread_auth = true)');
  if (has(backend, /access_key|sas_token|client_secret|storage_account_name|container_name|\bkey\s*=/)) p.push("the backend block must hold no key and no name: the pipeline passes the account, container and key from the parameter file");

  // Local state and plans never reach git or an image.
  for (const pattern of ["auth0/.terraform/", "auth0/*.tfstate", "auth0/*.tfstate.*", "auth0/*.tfplan"]) {
    if (!s.gitignore.split("\n").includes(pattern)) p.push(`.gitignore must have ${pattern}`);
  }
  if (!s.dockerignore.split("\n").includes("auth0")) p.push(".dockerignore must exclude auth0");
  return p;
}

type Step = { id?: string; if?: string; run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Pipeline = {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  env?: Record<string, string>;
  jobs?: Record<string, { environment?: string; env?: unknown; steps?: Step[] }>;
};

/** One message per problem of the pipeline that applies auth0/. Empty for the real workflow. */
export function pipelineProblems(s: Sources): string[] {
  const p: string[] = [];
  const w = parse(s.workflow) as Pipeline;
  const jobs = Object.values(w.jobs ?? {});
  const job = jobs[0];
  const steps = job?.steps ?? [];
  const step = (id: string) => steps.find((x) => x.id === id);
  const run = (id: string) => step(id)?.run ?? "";
  const scripts = steps.map((x) => x.run ?? "").join("\n");

  if (JSON.stringify(Object.keys(w.on ?? {})) !== '["workflow_dispatch"]') p.push("the pipeline must run by hand only (workflow_dispatch): never on a push, a pull request or a schedule");
  if (JSON.stringify(w.permissions) !== JSON.stringify({ "id-token": "write", contents: "read" })) p.push("the pipeline's permissions must be id-token: write and contents: read only");
  if (w.concurrency?.group !== "provision-auth0" || w.concurrency["cancel-in-progress"] !== false) p.push("the pipeline must hold the concurrency group provision-auth0 without cancelling: one run at a time for the tenant");
  if (jobs.length !== 1 || job?.environment !== "auth0-${{ inputs.environment }}") p.push("the pipeline's one job must run in the GitHub environment auth0-<environment>, which holds the Auth0 credential, never the deploy environment");

  // Secrets: the three of the Auth0 environment, only as the plan and apply steps' environment.
  const read = [...s.workflow.matchAll(/\$\{\{\s*(secrets|vars)\.([A-Za-z0-9_]+)/g)].map((m) => `${m[1]}.${m[2]}`);
  for (const name of read) if (!SECRETS.map((x) => `secrets.${x}`).includes(name)) p.push(`the pipeline reads ${name}: only ${SECRETS.join(", ")} may be read`);
  const elsewhere = JSON.stringify({ ...w, jobs: { job: { ...job, steps: steps.map((x) => (x.id === "plan" || x.id === "apply" ? { ...x, env: undefined } : x)) } } });
  if (elsewhere.includes("secrets.")) p.push("the secrets must reach only the plan and apply steps, as their environment: never the job, another step or a script");
  if (/\$\{\{\s*inputs\./.test(scripts)) p.push("an input is never pasted into a script");
  if (/ARM_CLIENT_SECRET|ARM_ACCESS_KEY|ARM_SAS_TOKEN|AUTH0_API_TOKEN/.test(s.workflow)) p.push("the pipeline must hold no Azure credential and no Auth0 token: OIDC for the state, the Management API application for Auth0");
  if (w.env?.ARM_USE_OIDC !== "true" || w.env.ARM_USE_AZUREAD !== "true" || !/"ARM_CLIENT_ID=\\\(v\(\["deployClientId"\]\)\)"/.test(run("target"))) {
    p.push("the state's sign-in must be OIDC as the deploy app of the parameter file, with Entra authorization (ARM_USE_OIDC, ARM_USE_AZUREAD)");
  }

  // The tools: Terraform pinned by version and SHA-256, the provider exactly as the lock file has it.
  if (!/^\d+\.\d+\.\d+$/.test(w.env?.TERRAFORM_VERSION ?? "") || !/^[0-9a-f]{64}$/.test(w.env?.TERRAFORM_SHA256 ?? "") || !/echo "\$TERRAFORM_SHA256 {2}\$RUNNER_TEMP\/terraform\.zip" \| sha256sum -c -/.test(run("target"))) {
    p.push("Terraform must be pinned by version and checked against its SHA-256 before it runs");
  }
  if (!/terraform -chdir=auth0 init -lockfile=readonly/.test(run("init"))) p.push("init must use the provider exactly as .terraform.lock.hcl pins it (-lockfile=readonly)");
  const container = /resource container [^\n]+\{\s*parent: blobs\s*name: '([a-z0-9-]+)'/.exec(s.stateStorage)?.[1];
  if (
    !run("init").includes('-backend-config="storage_account_name=$STATE_STORAGE"') ||
    !run("init").includes(`-backend-config="container_name=${container}"`) ||
    !run("init").includes('-backend-config="key=auth0.$ENVIRONMENT.tfstate"') ||
    !/"STATE_STORAGE=\\\(v\(\["names", "stateStorage"\]\)\)"/.test(run("target"))
  ) {
    p.push("the state must be the blob auth0.<environment>.tfstate in the container and account of infra/pre-deploy.<environment>.bicepparam (names.stateStorage)");
  }

  // The order, and an apply of exactly the plan shown, only when asked.
  const order = ["target", "tests", "init", "plan", "apply"].map((id) => steps.findIndex((x) => x.id === id));
  if (order.some((i, n) => i < 0 || (n > 0 && i <= order[n - 1]!))) p.push("the steps must be, in order: the tools and values, the offline checks, init, plan, apply");
  if (!run("tests").includes("vitest run test/auth0-iac.test.ts")) p.push("the offline checks (T-IAC-02) must run before init");
  if (!run("plan").includes('-var-file="$ENVIRONMENT.tfvars"') || !run("plan").includes('-out="$RUNNER_TEMP/auth0.tfplan"') || !run("plan").includes("GITHUB_STEP_SUMMARY")) {
    p.push("the plan must come from auth0/<environment>.tfvars, be saved, and be shown in the run's summary");
  }
  const applies = scripts.split("\n").filter((l) => /\bterraform\b.*\b(apply|destroy|import|state|taint|untaint)\b/.test(l));
  if (
    step("apply")?.if !== "${{ inputs.apply }}" ||
    applies.length !== 1 ||
    !/^\s*terraform -chdir=auth0 apply -no-color -lock-timeout=120s "\$RUNNER_TEMP\/auth0\.tfplan"$/.test(applies[0]!) ||
    !run("apply").includes(applies[0]!) ||
    /-auto-approve|-var-file|-target|-replace/.test(scripts.replace('-var-file="$ENVIRONMENT.tfvars" -out=', ""))
  ) {
    p.push("the only change to the tenant must be the apply step, when the apply input is checked, applying exactly the saved plan");
  }
  return p;
}

/** The ciba object in a parameter file, parsed from its text (keys and literal values). */
function bicepCiba(bicepparam: string): Record<string, string> {
  const body = block(bicepparam, /param ciba = \{/) ?? "";
  return Object.fromEntries([...body.matchAll(/^\s*(\w+):\s*(.+)$/gm)].map((m) => [m[1]!, m[2]!.trim()]));
}

const mutate = (s: Sources, file: string, from: string | RegExp, to: string): Sources => {
  const text = (file in s.tf ? s.tf[file] : s.all[file])!;
  expect(typeof from === "string" ? text.includes(from) : from.test(text), `${file} contains the mutation anchor`).toBe(true);
  const next = text.replace(from, to);
  return { ...s, tf: file in s.tf ? { ...s.tf, [file]: next } : s.tf, all: { ...s.all, [file]: next } };
};

const terraform = spawnSync("terraform", ["version"], { encoding: "utf8" }).status === 0;

describe("T-IAC-02 Auth0 tenant as code (auth0/)", () => {
  it("the real configuration has no problem", () => {
    expect(auth0Problems(load())).toEqual([]);
  });

  it("the parameter file's ciba object is the one main.bicep reads, and starts off", () => {
    expect(bicepCiba(load().bicepparam)).toMatchObject({ enabled: "false", credential: "'key'" });
  });

  it.each<[string, string, string | RegExp, string, string]>([
    ["an ES256 credential", "main.tf", 'algorithm       = "RS256"', 'algorithm       = "ES256"', "the credential's algorithm must be RS256 (what L2 signs; Auth0 never takes ES256)"],
    ["a second grant type", "main.tf", '["urn:openid:params:grant-type:ciba"]', '["urn:openid:params:grant-type:ciba", "client_credentials"]', "L2's client must have the CIBA grant and no other"],
    ["e-mail notifications", "main.tf", '["guardian-push"]', '["guardian-push", "email"]', "L2's client must notify through guardian-push only"],
    ["transactional consent", "main.tf", 'consent_policy = "null"', 'consent_policy = "transactional-authorization-with-mfa"', 'the API must use standard consent (consent_policy = "null"); CIBA is not supported with transactional-authorization-with-mfa'],
    ["another details type", "main.tf", 'authorization-details:v1:x402-payment"', 'authorization-details:v1:x402-pay"', `local.details_type must equal DETAILS_TYPE (${DETAILS_TYPE}), the type L2 sends`],
    ["machine tokens allowed", "main.tf", /client \{\n\s+policy = "deny_all"/, 'client {\n      policy = "require_client_grant"', "no machine-to-machine token for the API (client policy deny_all)"],
    ["users without a grant", "main.tf", 'policy = "require_client_grant"', 'policy = "allow_all"', "users may request the type only through a client grant (user policy require_client_grant)"],
    ["HS256 tokens", "main.tf", 'signing_alg          = "RS256"', 'signing_alg          = "HS256"', "the API must sign with RS256 (L2 accepts RS256 only)"],
    ["no prevent_destroy on Guardian", "main.tf", "prevent_destroy = true", "prevent_destroy = false", "auth0_guardian must never be destroyed (it would turn off every MFA factor of the tenant)"],
    ["a stored client secret", "main.tf", "client_secret_wo         = ", "client_secret            = ", "the client secret must be write-only (client_secret_wo), never stored in state"],
    ["a non-ephemeral secret variable", "variables.tf", "  ephemeral   = true\n", "", "var.client_secret must be sensitive and ephemeral"],
    ["provider credentials in a file", "versions.tf", "domain = var.tenant_domain", 'domain = var.tenant_domain\n  client_id = "abc"', "the provider block must take credentials from the environment only, never from a file"],
    ["an unpinned provider", "versions.tf", '">= 1.60.0, < 2.0.0"', '">= 1.0.0"', "the provider must be auth0/auth0 pinned to >= 1.60.0, < 2.0.0"],
    ["a managed user", "main.tf", "data \"auth0_user\" \"approver\" {", 'resource "auth0_user" "approver" {\n  password = "x"\n}\ndata "auth0_user" "approver" {', "users and passwords are never managed here"],
    ["a local state", "versions.tf", /  backend "azurerm" \{\n    use_azuread_auth = true\n  \}\n/, "", 'the state must be in Azure with an Entra sign-in (backend "azurerm", use_azuread_auth = true)'],
    ["a state account key", "versions.tf", "    use_azuread_auth = true\n", '    use_azuread_auth = true\n    access_key       = "abc"\n', "the backend block must hold no key and no name: the pipeline passes the account, container and key from the parameter file"],
    ["an output missing clientKeyId", "outputs.tf", '    clientKeyId = ""\n', "", "output bicepparam_ciba must have exactly the ciba keys of the parameter file (approver, audience, clientId, clientKeyId, credential, enabled, issuer), got approver, audience, clientId, credential, enabled, issuer"],
  ])("must fail: %s is reported", (_label, file, from, to, message) => {
    expect(auth0Problems(mutate(load(), file, from, to))).toContain(message);
  });

  it("must fail: a private key in the folder, committed state, and missing ignores are reported", () => {
    const s = load();
    const withKey = { ...s, all: { ...s.all, "key.pem": "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n", "terraform.tfstate": "{}" } };
    expect(auth0Problems(withKey)).toEqual(expect.arrayContaining(["key.pem holds a private key", "terraform.tfstate must not be committed"]));
    const withSecret = { ...s, all: { ...s.all, "dev.tfvars": 'environment = "dev"\nclient_secret = "0123456789abcdef"\n' } };
    expect(auth0Problems(withSecret)).toContain("dev.tfvars holds a credential: it is committed, and secrets come from the pipeline's GitHub environment only");
    expect(auth0Problems({ ...s, all: { ...s.all, "dev.tfvars": s.all["dev.tfvars.example"]! } })).toEqual([]);
    const ignores = { ...s, gitignore: s.gitignore.replace("auth0/*.tfstate\n", ""), dockerignore: s.dockerignore.replace("auth0\n", "") };
    expect(auth0Problems(ignores)).toEqual(expect.arrayContaining([".gitignore must have auth0/*.tfstate", ".dockerignore must exclude auth0"]));
  });

  it("the pipeline (provision-auth0.yml) has no problem", () => {
    expect(pipelineProblems(load())).toEqual([]);
  });

  const SECRET_SCOPE = "the secrets must reach only the plan and apply steps, as their environment: never the job, another step or a script";
  const ONLY_APPLY = "the only change to the tenant must be the apply step, when the apply input is checked, applying exactly the saved plan";
  it.each<[string, string | RegExp, string, string]>([
    ["a run on every push", "on:\n  workflow_dispatch:", "on:\n  push:\n    branches: [main]\n  workflow_dispatch:", "the pipeline must run by hand only (workflow_dispatch): never on a push, a pull request or a schedule"],
    ["write permission on the repository", "  contents: read", "  contents: write", "the pipeline's permissions must be id-token: write and contents: read only"],
    ["the deploy environment", "    environment: auth0-${{ inputs.environment }}", "    environment: ${{ inputs.environment }}", "the pipeline's one job must run in the GitHub environment auth0-<environment>, which holds the Auth0 credential, never the deploy environment"],
    ["cancelled runs", "  cancel-in-progress: false", "  cancel-in-progress: true", "the pipeline must hold the concurrency group provision-auth0 without cancelling: one run at a time for the tenant"],
    ["another secret", "          L2_CLIENT_SECRET: ${{ secrets.AUTH0_L2_CLIENT_SECRET }}\n        run: |\n          if [[ -z", "          L2_CLIENT_SECRET: ${{ secrets.PAYER_PRIVATE_KEY }}\n        run: |\n          if [[ -z", "the pipeline reads secrets.PAYER_PRIVATE_KEY: only AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET, AUTH0_L2_CLIENT_SECRET may be read"],
    ["a GitHub variable", "  TF_INPUT: \"0\"", "  TF_INPUT: \"0\"\n  TENANT: ${{ vars.AUTH0_DOMAIN }}", "the pipeline reads vars.AUTH0_DOMAIN: only AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET, AUTH0_L2_CLIENT_SECRET may be read"],
    ["the credential in every step", "  TF_INPUT: \"0\"", "  TF_INPUT: \"0\"\n  AUTH0_CLIENT_SECRET: ${{ secrets.AUTH0_CLIENT_SECRET }}", SECRET_SCOPE],
    ["the credential in the tests step", "        id: tests\n", "        id: tests\n        env:\n          AUTH0_CLIENT_SECRET: ${{ secrets.AUTH0_CLIENT_SECRET }}\n", SECRET_SCOPE],
    ["an input pasted into a script", 'if [[ ! "$ENVIRONMENT" =~', 'if [[ ! "${{ inputs.environment }}" =~', "an input is never pasted into a script"],
    ["an Azure client secret", "  ARM_USE_AZUREAD: \"true\"", "  ARM_USE_AZUREAD: \"true\"\n  ARM_CLIENT_SECRET: abc", "the pipeline must hold no Azure credential and no Auth0 token: OIDC for the state, the Management API application for Auth0"],
    ["a state read with the account key", "  ARM_USE_AZUREAD: \"true\"", "  ARM_USE_AZUREAD: \"false\"", "the state's sign-in must be OIDC as the deploy app of the parameter file, with Entra authorization (ARM_USE_OIDC, ARM_USE_AZUREAD)"],
    ["an unchecked Terraform download", /\n +echo "\$TERRAFORM_SHA256 {2}\$RUNNER_TEMP\/terraform\.zip" \| sha256sum -c -/, "", "Terraform must be pinned by version and checked against its SHA-256 before it runs"],
    ["a provider the lock file doesn't pin", "init -lockfile=readonly", "init -upgrade", "init must use the provider exactly as .terraform.lock.hcl pins it (-lockfile=readonly)"],
    ["another state container", 'container_name=tfstate"', 'container_name=state"', "the state must be the blob auth0.<environment>.tfstate in the container and account of infra/pre-deploy.<environment>.bicepparam (names.stateStorage)"],
    ["one state for every environment", 'key=auth0.$ENVIRONMENT.tfstate"', 'key=auth0.tfstate"', "the state must be the blob auth0.<environment>.tfstate in the container and account of infra/pre-deploy.<environment>.bicepparam (names.stateStorage)"],
    ["no offline checks", "npx vitest run test/auth0-iac.test.ts", "true", "the offline checks (T-IAC-02) must run before init"],
    ["an apply on every run", "        if: ${{ inputs.apply }}\n", "", ONLY_APPLY],
    ["an apply of a new plan", 'apply -no-color -lock-timeout=120s "$RUNNER_TEMP/auth0.tfplan"', 'apply -no-color -lock-timeout=120s -auto-approve -var-file="$ENVIRONMENT.tfvars"', ONLY_APPLY],
    ["a destroy", "          terraform -chdir=auth0 validate -no-color", "          terraform -chdir=auth0 destroy -auto-approve", ONLY_APPLY],
    ["a plan that isn't shown", '          } >> "$GITHUB_STEP_SUMMARY"\n\n      # Exactly', "          } > /dev/null\n\n      # Exactly", "the plan must come from auth0/<environment>.tfvars, be saved, and be shown in the run's summary"],
  ])("must fail (pipeline): %s is reported", (_label, from, to, message) => {
    const s = load();
    expect(typeof from === "string" ? s.workflow.includes(from) : from.test(s.workflow), "the workflow contains the mutation anchor").toBe(true);
    expect(pipelineProblems({ ...s, workflow: s.workflow.replace(from, () => to) })).toContain(message);
  });

  it.skipIf(!terraform)("terraform fmt -check passes", () => {
    const r = spawnSync("terraform", [`-chdir=${DIR}`, "fmt", "-check", "-diff"], { encoding: "utf8" });
    expect(r.stdout + r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it.skipIf(!terraform || !existsSync(join(DIR, ".terraform")))("terraform validate passes (after terraform init)", () => {
    const r = spawnSync("terraform", [`-chdir=${DIR}`, "validate", "-no-color"], { encoding: "utf8" });
    expect(r.stdout + r.stderr).toContain("The configuration is valid");
    expect(r.status).toBe(0);
  });
});
