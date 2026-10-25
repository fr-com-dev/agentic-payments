// T-AGT-03 Entra setup (specs/011 contracts/access-and-sessions.md): infra/entra-app.sh against a fake `az`
// (test/fixtures/fake-az.mjs). The script must print the API app's client ID as AUTH_AUDIENCE (Entra v2.0
// tokens carry it as `aud`, never the api:// URI), expose `user_impersonation` with the Azure CLI
// pre-authorized so a person can get a token, require assignment, assign Agent.Run once per principal, and
// stay idempotent across re-runs.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = "infra/entra-app.sh";
const ROLE_ID = "5b2c3a7e-6f1d-4c55-9f0e-0a1b2c3d4e51";
const AZURE_CLI_APP_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";
const CLIENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HAS_JQ = spawnSync("jq", ["--version"]).status === 0;

interface Scope {
  id: string;
  value: string;
  type: string;
  isEnabled: boolean;
}
interface FakeState {
  app?: {
    appId: string;
    identifierUris?: string[];
    appRoles: { id: string; value: string; allowedMemberTypes: string[] }[];
    api: { requestedAccessTokenVersion: number | null; oauth2PermissionScopes: Scope[]; preAuthorizedApplications: { appId: string; delegatedPermissionIds: string[] }[] };
  };
  sp?: { appRoleAssignmentRequired?: boolean };
  assignments?: { principalId: string; resourceId: string; appRoleId: string }[];
}
interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  state: FakeState;
}

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

/** A temp dir with an `az` on PATH that runs the fake, and an empty Graph state. */
function fakeTenant() {
  const dir = mkdtempSync(join(tmpdir(), "entra-app-"));
  tmp.push(dir);
  const az = join(dir, "az");
  writeFileSync(az, `#!/bin/sh\nexec "${process.execPath}" "${resolve("test/fixtures/fake-az.mjs")}" "$@"\n`);
  chmodSync(az, 0o755);
  const statePath = join(dir, "state.json");
  writeFileSync(statePath, "{}");
  const run = (args: string[], script = SCRIPT): Run => {
    const r = spawnSync("bash", [script, ...args], {
      env: { PATH: `${dir}:${process.env.PATH ?? ""}`, HOME: dir, FAKE_AZ_STATE: statePath },
      encoding: "utf8",
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, state: JSON.parse(readFileSync(statePath, "utf8")) as FakeState };
  };
  return { dir, run };
}

/** What a completed run must leave behind; one message per problem. */
function problems(r: Run): string[] {
  const p: string[] = [];
  if (r.status !== 0) return [`exit ${r.status}: ${r.stderr.trim()}`];
  const app = r.state.app;
  if (!app) return ["no app registration"];
  const audience = /^AUTH_AUDIENCE=(.*)$/m.exec(r.stdout)?.[1];
  if (audience !== app.appId || !CLIENT_ID_RE.test(audience)) p.push(`AUTH_AUDIENCE is ${audience}, not the app's client ID ${app.appId}`);
  if (!/^AUTH_TENANT_ID=\S+$/m.test(r.stdout)) p.push("AUTH_TENANT_ID not printed");
  if (app.api.requestedAccessTokenVersion !== 2) p.push("access tokens are not v2.0");
  const roles = app.appRoles.filter((x) => x.value === "Agent.Run");
  if (roles.length !== 1 || roles[0]!.id !== ROLE_ID || roles[0]!.allowedMemberTypes.join() !== "User,Application") p.push("Agent.Run role wrong");
  const scopes = app.api.oauth2PermissionScopes.filter((x) => x.value === "user_impersonation");
  if (scopes.length !== 1 || !scopes[0]!.isEnabled || scopes[0]!.type !== "Admin") p.push("user_impersonation scope missing or not admin-consent");
  const cli = app.api.preAuthorizedApplications.filter((x) => x.appId === AZURE_CLI_APP_ID);
  if (cli.length !== 1 || cli[0]!.delegatedPermissionIds.join() !== scopes[0]?.id) p.push("Azure CLI not pre-authorized for user_impersonation");
  if (r.state.sp?.appRoleAssignmentRequired !== true) p.push("assignment is not required");
  return p;
}

function mutantScript(dir: string, from: string, to: string): string {
  const text = readFileSync(SCRIPT, "utf8");
  expect(text.includes(from), "entra-app.sh contains the mutation anchor").toBe(true);
  const path = join(dir, "entra-app.sh");
  writeFileSync(path, text.replace(from, to));
  return path;
}

// Each run spawns node once per `az` call, so a test takes seconds.
describe.skipIf(!HAS_JQ)("T-AGT-03 Entra setup (infra/entra-app.sh against a fake az)", { timeout: 30_000 }, () => {
  it("T-AGT-03 entra-app.sh prints the client ID as AUTH_AUDIENCE, exposes user_impersonation with the Azure CLI pre-authorized, and assigns Agent.Run", () => {
    const { run } = fakeTenant();
    const r = run(["--deploy-sp", "deploy-app", "--assign-user", "alice@contoso.test"]);
    expect(problems(r)).toEqual([]);
    expect(r.stdout).not.toContain("api://");
    expect(r.state.app!.identifierUris).toEqual(["api://x402-l1-agent"]);
    expect((r.state.assignments ?? []).map((a) => [a.principalId, a.appRoleId])).toEqual([
      ["sp-object-of-deploy-app", ROLE_ID],
      ["user-object-of-alice@contoso.test", ROLE_ID],
    ]);
  });

  it("T-AGT-03 entra-app.sh re-runs (also with no --assign-user, under set -u) without duplicating the scope, the pre-authorization or an assignment", () => {
    const { run } = fakeTenant();
    run(["--deploy-sp", "deploy-app", "--assign-user", "alice@contoso.test"]);
    const again = run(["--deploy-sp", "deploy-app", "--assign-user", "alice@contoso.test"]);
    expect(problems(again)).toEqual([]);
    const bare = run([]);
    expect(problems(bare)).toEqual([]);
    expect(bare.state.app!.api.oauth2PermissionScopes).toHaveLength(1);
    expect(bare.state.app!.api.preAuthorizedApplications).toHaveLength(1);
    expect(bare.state.assignments).toHaveLength(2);
  });

  it("T-AGT-03 must-fail: printing the identifier URI as AUTH_AUDIENCE is reported", () => {
    const { dir, run } = fakeTenant();
    const script = mutantScript(dir, 'echo "AUTH_AUDIENCE=$APP_ID"', 'echo "AUTH_AUDIENCE=$IDENTIFIER_URI"');
    expect(problems(run([], script)).some((m) => m.startsWith("AUTH_AUDIENCE is api://x402-l1-agent"))).toBe(true);
  });

  it("T-AGT-03 must-fail: without the pre-authorization, people have no way to get a token, and it is reported", () => {
    const { dir, run } = fakeTenant();
    const script = mutantScript(dir, "patch_api '{api: (.preAuthorizedApplications", ": '{api: (.preAuthorizedApplications");
    expect(problems(run([], script))).toContain("Azure CLI not pre-authorized for user_impersonation");
  });
});
