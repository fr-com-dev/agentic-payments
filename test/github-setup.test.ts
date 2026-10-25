// T-E2E-AZ GitHub setup (specs/011 contracts/deploy-pipeline.md; quickstart §4 prerequisites): infra/github-setup.sh
// against a fake `gh` (test/fixtures/fake-gh.mjs). From env/infra.env it must create the deploy environment and set
// exactly the secrets deploy-layer.yml declares, each value on stdin (never in an argument, never printed). It must
// refuse the whole file, before sending anything, on an unknown key, a credential, or a value of the wrong shape.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

const SCRIPT = "infra/github-setup.sh";
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
/** The secrets the workflows read: what the reusable layer workflow declares (T-E2E-AZ ties it to the allowed six). */
const DECLARED = Object.keys(
  (parse(readFileSync(".github/workflows/deploy-layer.yml", "utf8")) as { on: { workflow_call: { secrets: Record<string, unknown> } } }).on.workflow_call
    .secrets,
);
const SHAPE: Record<string, RegExp> = {
  AZURE_CLIENT_ID: GUID_RE,
  AZURE_TENANT_ID: GUID_RE,
  AZURE_SUBSCRIPTION_ID: GUID_RE,
  AGENT_API_CLIENT_ID: GUID_RE,
  SELLER_PAY_TO: ADDRESS_RE,
  PAYER_ADDRESS: ADDRESS_RE,
};
const PRIVATE_KEY = `0x${"c3".repeat(32)}`;
/** The non-empty secret values in `vars`; the repository and environment names are meant to appear. */
const secretValues = (vars: Record<string, string>) => Object.entries(vars).flatMap(([k, v]) => (SHAPE[k] && v !== "" ? [v] : []));
const GOOD: Record<string, string> = {
  GITHUB_REPO: "acme/agentic-payments",
  GITHUB_ENVIRONMENT: "dev",
  AZURE_CLIENT_ID: "11111111-1111-4111-8111-111111111111",
  AZURE_TENANT_ID: "22222222-2222-4222-8222-222222222222",
  AZURE_SUBSCRIPTION_ID: "33333333-3333-4333-8333-333333333333",
  AGENT_API_CLIENT_ID: "44444444-4444-4444-8444-444444444444",
  SELLER_PAY_TO: `0x${"a1".repeat(20)}`,
  PAYER_ADDRESS: `0x${"b2".repeat(20)}`,
};

interface Call {
  args: string[];
  stdin: string | null;
}
interface Run {
  status: number | null;
  out: string;
  calls: Call[];
}

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

const envText = (vars: Record<string, string>) =>
  Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

/**
 * Runs the script (or a mutant of it, `mutate` = [from, to]) from a temp repo root holding infra/params/dev.bicepparam
 * and env/infra.env, with a fake `gh` on PATH. `existing` names secrets the repository already holds.
 */
function setup(env: string, opts: { mutate?: [string, string]; existing?: string; args?: string[] } = {}): Run {
  const { mutate, existing = "", args = [] } = opts;
  const root = mkdtempSync(join(tmpdir(), "github-setup-"));
  tmp.push(root);
  mkdirSync(join(root, "infra/params"), { recursive: true });
  mkdirSync(join(root, "env"));
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "infra/params/dev.bicepparam"), "");
  writeFileSync(join(root, "env/infra.env"), env);
  const script = join(root, SCRIPT);
  if (mutate) {
    const text = readFileSync(SCRIPT, "utf8");
    expect(text.includes(mutate[0]), "github-setup.sh contains the mutation anchor").toBe(true);
    writeFileSync(script, text.replace(mutate[0], () => mutate[1]));
  } else copyFileSync(SCRIPT, script);
  const gh = join(root, "bin/gh");
  writeFileSync(gh, `#!/bin/sh\nexec "${process.execPath}" "${resolve("test/fixtures/fake-gh.mjs")}" "$@"\n`);
  chmodSync(gh, 0o755);
  const log = join(root, "gh.log");
  const r = spawnSync("bash", [script, ...args], {
    env: { PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`, HOME: root, FAKE_GH_LOG: log, FAKE_GH_EXISTING: existing },
    encoding: "utf8",
  });
  const calls = existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Call)
    : [];
  return { status: r.status, out: r.stdout + r.stderr, calls };
}

/** What a completed run must have done with `vars`; one message per problem. */
function problems(r: Run, vars: Record<string, string>): string[] {
  if (r.status !== 0) return [`exit ${r.status}: ${r.out.trim()}`];
  const p: string[] = [];
  const repo = vars.GITHUB_REPO!;
  const env = r.calls.filter((c) => c.args[0] === "api");
  if (env.length !== 1 || env[0]!.args.join(" ") !== `api --method PUT repos/${repo}/environments/${vars.GITHUB_ENVIRONMENT} --silent`) {
    p.push("the environment was not created once in the repository");
  }
  const sets = r.calls.filter((c) => c.args[0] === "secret" && c.args[1] === "set");
  const expected = DECLARED.filter((n) => (vars[n] ?? "") !== "");
  if (JSON.stringify(sets.map((c) => c.args[2]).sort()) !== JSON.stringify([...expected].sort())) {
    p.push(`set ${sets.map((c) => c.args[2]).join(",")}, not ${expected.join(",")}`);
  }
  for (const c of sets) {
    const name = c.args[2]!;
    const value = c.stdin ?? "";
    if (!c.args.includes("--repo") || c.args[c.args.indexOf("--repo") + 1] !== repo) p.push(`${name} was not set in ${repo}`);
    if (value !== vars[name]) p.push(`${name} did not arrive on stdin`);
    if (!SHAPE[name]?.test(value)) p.push(`${name} was sent with a value of the wrong shape`);
    if (secretValues(vars).some((v) => c.args.some((a) => a.includes(v)))) p.push(`a value is in the arguments of gh secret set ${name}`);
  }
  if (secretValues(vars).some((v) => r.out.includes(v))) p.push("a value was printed");
  return p;
}

// Each run spawns node once per `gh` call.
describe("T-E2E-AZ GitHub setup (infra/github-setup.sh against a fake gh)", { timeout: 30_000 }, () => {
  it("T-E2E-AZ github-setup.sh creates the environment and sets exactly the declared secrets, on stdin and never printed", () => {
    expect(DECLARED).toHaveLength(6);
    const r = setup(`# comment\n\n${envText(GOOD)}\n`);
    expect(problems(r, GOOD)).toEqual([]);
    expect(r.calls.filter((c) => c.args[1] === "list")).toHaveLength(1);
    expect(r.out).not.toContain("warning");
  });

  it("T-E2E-AZ github-setup.sh reads quoted and exported values and CRLF lines, and skips AGENT_API_CLIENT_ID until entra-app.sh has run", () => {
    const vars = { ...GOOD, AGENT_API_CLIENT_ID: "" };
    const text = Object.entries(vars)
      .map(([k, v], i) => (i % 3 === 0 ? `export ${k}="${v}"` : i % 3 === 1 ? `${k} = '${v}'` : `${k}=${v}`))
      .join("\r\n");
    const r = setup(text);
    expect(problems(r, vars)).toEqual([]);
    expect(r.out).toContain("secret AGENT_API_CLIENT_ID: skipped");
  });

  it("T-E2E-AZ github-setup.sh --dry-run validates and sends nothing", () => {
    const r = setup(envText(GOOD), { args: ["--dry-run"] });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
    for (const n of DECLARED) expect(r.out).toContain(`would set the secret ${n}`);
    for (const v of secretValues(GOOD)) expect(r.out).not.toContain(v);
  });

  it("T-E2E-AZ github-setup.sh warns about any other secret in the repository", () => {
    const r = setup(envText(GOOD), { existing: "CDP_API_KEY_SECRET" });
    expect(problems(r, GOOD)).toEqual([]);
    expect(r.out).toMatch(/warning: acme\/agentic-payments also holds the secrets CDP_API_KEY_SECRET/);
  });

  it.each([
    ["a payer key", { PAYER_PRIVATE_KEY: PRIVATE_KEY }, "PAYER_PRIVATE_KEY is a credential"],
    ["a CDP key", { CDP_API_KEY_SECRET: "c2VjcmV0LXZhbHVlLXRoYXQtaXMtbG9uZw==" }, "CDP_API_KEY_SECRET is a credential"],
    ["an unknown key", { RESOURCE_GROUP: "rg-x402-dev" }, "unknown key RESOURCE_GROUP"],
    ["a private key pasted as an address", { PAYER_ADDRESS: PRIVATE_KEY }, "PAYER_ADDRESS is not a 0x address"],
    ["a client ID that isn't a GUID", { AZURE_CLIENT_ID: "x402-deploy" }, "AZURE_CLIENT_ID is not a GUID"],
    ["the deploy app as the API app", { AGENT_API_CLIENT_ID: GOOD.AZURE_CLIENT_ID! }, "AGENT_API_CLIENT_ID equals AZURE_CLIENT_ID"],
    ["an environment with no parameters", { GITHUB_ENVIRONMENT: "prod" }, "has no infra/params/prod.bicepparam"],
    ["a missing secret", { SELLER_PAY_TO: "" }, "SELLER_PAY_TO is empty"],
  ])("T-E2E-AZ github-setup.sh refuses %s, and sends nothing", (_, change, message) => {
    const r = setup(envText({ ...GOOD, ...change }));
    expect(r.status).toBe(2);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain(message);
    expect(r.out).toContain("nothing was sent to GitHub");
    expect(r.out).not.toContain(PRIVATE_KEY);
  });

  it("T-E2E-AZ github-setup.sh refuses a key set twice, and a line that isn't KEY=VALUE, without printing the line", () => {
    const r = setup(`${envText(GOOD)}\nPAYER_ADDRESS=${GOOD.PAYER_ADDRESS}\n${PRIVATE_KEY}\n`);
    expect(r.status).toBe(2);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain("PAYER_ADDRESS is set twice");
    expect(r.out).toContain("line 10 is not KEY=VALUE");
    expect(r.out).not.toContain(PRIVATE_KEY);
  });

  it("T-E2E-AZ must-fail: with a looser address check, a private key pasted as PAYER_ADDRESS reaches GitHub, and it is reported", () => {
    const vars = { ...GOOD, PAYER_ADDRESS: PRIVATE_KEY };
    const r = setup(envText(vars), { mutate: ["ADDRESS='^0x[0-9a-fA-F]{40}$'", "ADDRESS='^0x[0-9a-fA-F]+$'"] });
    expect(problems(r, vars)).toContain("PAYER_ADDRESS was sent with a value of the wrong shape");
  });

  it("T-E2E-AZ must-fail: a value passed with --body shows in gh's arguments, and it is reported", () => {
    const r = setup(envText(GOOD), {
      mutate: ['printf \'%s\' "$value" | gh secret set "$name" --repo "$REPO"', 'gh secret set "$name" --repo "$REPO" --body "$value"'],
    });
    expect(problems(r, GOOD)).toContain("a value is in the arguments of gh secret set AZURE_CLIENT_ID");
  });
});
