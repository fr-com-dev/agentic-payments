// T-E2E-AZ GitHub setup (specs/011 contracts/deploy-pipeline.md; quickstart §4 step 1): infra/github-setup.sh
// against a fake `gh` (test/fixtures/fake-gh.mjs) and an `az` that only compiles parameter files with the real Bicep
// CLI (test/fixtures/fake-azure.mjs; needs BICEP_PATH). From infra/pre-deploy.<environment>.bicepparam it must
// create the GitHub environment deploy.yml's job runs in, in the repository named there, and set nothing else:
// deploy.yml reads no secret. A secret left in the repository or the environment is reported, never used. It
// refuses, sending nothing, a parameter file whose GitHub environment isn't the deploy environment, a malformed
// repository and a file Bicep can't compile.
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BICEP_PATH } from "./helpers/bicep.js";

const SCRIPT = "infra/github-setup.sh";
const PARAMS = readFileSync("infra/pre-deploy.dev.bicepparam", "utf8").replace("param githubRepository = 'fr-com-dev/agentic-payments'", "param githubRepository = 'acme/agentic-payments'");

interface Run {
  status: number | null;
  out: string;
  calls: string[][];
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
function setup(params: string, opts: { mutate?: [string, string]; existing?: string; envSecrets?: string; args?: string[] } = {}): Run {
  const { mutate, existing = "", envSecrets = "", args = [] } = opts;
  const root = mkdtempSync(join(tmpdir(), "github-setup-"));
  tmp.push(root);
  cpSync("infra", join(root, "infra"), { recursive: true });
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "infra/pre-deploy.dev.bicepparam"), params);
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
    },
    encoding: "utf8",
  });
  const calls = existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as { args: string[] }).args)
    : [];
  return { status: r.status, out: r.stdout + r.stderr, calls };
}

/** What a completed run must have done: create the environment once, and change nothing else. */
function problems(r: Run): string[] {
  if (r.status !== 0) return [`exit ${r.status}: ${r.out.trim()}`];
  const p: string[] = [];
  const changes = r.calls.filter((c) => c.includes("--method") || (c[0] === "secret" && c[1] !== "list"));
  if (JSON.stringify(changes) !== JSON.stringify([["api", "--method", "PUT", "repos/acme/agentic-payments/environments/dev", "--silent"]])) {
    p.push(`changed ${JSON.stringify(changes)}, not only the environment dev in acme/agentic-payments`);
  }
  return p;
}

// Each run spawns node once per `gh` call, and the Bicep CLI once.
describe.skipIf(!BICEP_PATH)("T-E2E-AZ GitHub setup (infra/github-setup.sh against a fake gh)", { timeout: 30_000 }, () => {
  it("T-E2E-AZ github-setup.sh creates the deploy job's GitHub environment, in the repository the parameter file names, and sets no secret", () => {
    const r = setup(PARAMS);
    expect(problems(r)).toEqual([]);
    expect(r.out).toContain("environment dev: ready in acme/agentic-payments");
    expect(r.out).not.toContain("warning");
  });

  it("T-E2E-AZ github-setup.sh --dry-run sends nothing", () => {
    const r = setup(PARAMS, { args: ["--dry-run"] });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain("dry run: would create the environment dev in acme/agentic-payments");
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

  it("T-E2E-AZ github-setup.sh refuses an environment without a pre-deploy parameter file", () => {
    const r = setup(PARAMS, { args: ["--environment", "prod"] });
    expect(r.status).toBe(2);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain("no infra/pre-deploy.prod.bicepparam");
  });

  it("T-E2E-AZ must-fail: without the environment check, a GitHub environment the deploy job never runs in is created, and it is reported", () => {
    const params = PARAMS.replace("param githubEnvironment = environment", "param githubEnvironment = 'production'");
    const r = setup(params, { mutate: ['[[ "$GH_ENV" == "$ENVIRONMENT" ]] ||', "true ||"] });
    expect(problems(r)[0]).toMatch(/environments\/production/);
  });
});
