// T-E2E-AZ clean-up (specs/011 quickstart §6): infra/cleanup.sh against a fake tenant (test/fixtures/fake-azure.mjs)
// and a fake `gh` (test/fixtures/fake-gh.mjs), with the target and names from infra/pre-deploy.<environment>.bicepparam,
// compiled by the real Bicep CLI (needs BICEP_PATH). A
// confirmed run must delete the GitHub environment, the deploy app's role assignments (none left orphaned), the
// resource group, the three app registrations (the API app, the deploy app and 013's portal web app) and the
// operators' group, and nothing else: another resource group, app,
// group, role assignment or a GitHub secret stays. With --purge it purges the Foundry account and the app
// registrations; the vaults stay soft-deleted (purge protection) and are reported. --dry-run, a refusal or an
// unconfirmed run changes nothing, and so does a pre-deploy file whose resource group main's file doesn't deploy to.
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BICEP_PATH, buildParams, type MainNames, type PreDeployNames } from "./helpers/bicep.js";

const SCRIPT = "infra/cleanup.sh";
const MAIN = (BICEP_PATH ? buildParams("infra/main.dev.bicepparam") : { names: {} }) as { location: string; names: MainNames };
const M = MAIN.names;
const P = (BICEP_PATH ? buildParams("infra/pre-deploy.dev.bicepparam").names : {}) as PreDeployNames;
const SUB = "33333333-3333-4333-8333-333333333333";
const TENANT = "22222222-2222-4222-8222-222222222222";
const DEPLOY = "11111111-1111-4111-8111-111111111111";
const API = "44444444-4444-4444-8444-444444444444";
const PORTAL = "55555555-5555-4555-8555-555555555555";
const OTHER_APP = "77777777-7777-4777-8777-777777777777";
const PARAMS = readFileSync("infra/pre-deploy.dev.bicepparam", "utf8")
  .replace(/^param tenantId = '.*'$/m, `param tenantId = '${TENANT}'`)
  .replace(/^param subscriptionId = '.*'$/m, `param subscriptionId = '${SUB}'`)
  .replace(/^param githubRepository = '.*'$/m, "param githubRepository = 'acme/agentic-payments'");

interface App {
  appId: string;
  id: string;
  displayName: string;
}
interface State {
  subscription: string;
  signedInTenant: string;
  groups: Record<string, { resources: number; vaults: string[]; accounts: { name: string; location: string }[] }>;
  apps: App[];
  sps: { appId: string; id: string }[];
  entraGroups: { id: string; displayName: string }[];
  roleAssignments: { id: string; principalId: string; role: string; scope: string }[];
  deletedApps: App[];
  deletedVaults: { name: string; scheduledPurgeDate: string; vaultId: string }[];
  deletedAccounts: { name: string; location: string; id: string }[];
}

/** A deployed dev environment beside a resource group, an app, a group and a role assignment that aren't ours. */
function deployed(): State {
  const rg = `/subscriptions/${SUB}/resourceGroups/${P.resourceGroup}`;
  return {
    subscription: SUB,
    signedInTenant: TENANT,
    groups: {
      [P.resourceGroup]: { resources: 40, vaults: Object.values(M.vaults), accounts: [{ name: M.foundry, location: MAIN.location }] },
      "rg-someone-else": { resources: 2, vaults: [], accounts: [] },
    },
    apps: [
      { appId: DEPLOY, id: "obj-deploy", displayName: P.deployApp },
      { appId: API, id: "obj-api", displayName: P.apiApp },
      { appId: PORTAL, id: "obj-portal", displayName: P.portalApp },
      { appId: OTHER_APP, id: "obj-other", displayName: "someone-elses-app" },
    ],
    sps: [
      { appId: DEPLOY, id: "sp-deploy" },
      { appId: API, id: "sp-api" },
      { appId: OTHER_APP, id: "sp-other" },
    ],
    entraGroups: [
      { id: "grp-ours", displayName: P.operators },
      { id: "grp-other", displayName: "someone-elses-group" },
    ],
    roleAssignments: [
      { id: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleAssignments/ra-sub`, principalId: "sp-deploy", role: "Reader", scope: `/subscriptions/${SUB}` },
      { id: `${rg}/providers/Microsoft.Authorization/roleAssignments/ra-rg`, principalId: "sp-deploy", role: "Contributor", scope: rg },
      { id: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleAssignments/ra-other`, principalId: "sp-other", role: "Reader", scope: `/subscriptions/${SUB}` },
    ],
    deletedApps: [],
    deletedVaults: [],
    deletedAccounts: [],
  };
}

interface Run {
  status: number | null;
  out: string;
  state: State;
  az: string[][];
  gh: string[][];
}

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

/** A temp repo root with a copy of infra/ (the script or a mutant, and the dev parameter files), and both fakes. */
function tenant(state: State, opts: { mutate?: [string, string]; params?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cleanup-"));
  tmp.push(root);
  cpSync("infra", join(root, "infra"), { recursive: true });
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "infra/pre-deploy.dev.bicepparam"), opts.params ?? PARAMS);
  const text = readFileSync(SCRIPT, "utf8");
  if (opts.mutate) expect(text.includes(opts.mutate[0]), "cleanup.sh contains the mutation anchor").toBe(true);
  writeFileSync(join(root, SCRIPT), opts.mutate ? text.replace(opts.mutate[0], () => opts.mutate![1]) : text);
  for (const [bin, fixture] of [["az", "fake-azure.mjs"], ["gh", "fake-gh.mjs"]]) {
    writeFileSync(join(root, "bin", bin!), `#!/bin/sh\nexec "${process.execPath}" "${resolve("test/fixtures", fixture!)}" "$@"\n`);
    chmodSync(join(root, "bin", bin!), 0o755);
  }
  const statePath = join(root, "state.json");
  writeFileSync(statePath, JSON.stringify(state));
  const logs = { az: join(root, "az.log"), gh: join(root, "gh.log") };
  const lines = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { args: string[] }).args) : []);
  // The logs accumulate, because the fake gh replays its log to know what the repository still holds.
  return (args: string[], input?: string): Run => {
    const before = { az: lines(logs.az).length, gh: lines(logs.gh).length };
    const r = spawnSync("bash", [join(root, SCRIPT), ...args], {
      env: {
        PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
        HOME: root,
        BICEP_PATH,
        FAKE_BICEP_HOME: homedir(),
        FAKE_AZ_STATE: statePath,
        FAKE_AZ_LOG: logs.az,
        FAKE_GH_LOG: logs.gh,
        FAKE_GH_EXISTING: "LEFTOVER_SECRET",
        FAKE_GH_ENVIRONMENTS: "dev",
      },
      encoding: "utf8",
      input,
    });
    const state = JSON.parse(readFileSync(statePath, "utf8")) as State;
    return { status: r.status, out: r.stdout + r.stderr, state, az: lines(logs.az).slice(before.az), gh: lines(logs.gh).slice(before.gh) };
  };
}

const OURS = new Set([DEPLOY, API, PORTAL]);
/** Calls that change something. */
const changes = (r: Run) => [
  ...r.az.filter((a) => a.includes("delete") || a.includes("purge") || a.includes("DELETE")),
  ...r.gh.filter((a) => a[1] === "delete" || a.includes("DELETE")),
];

/** What a confirmed clean-up must have done; one message per problem. */
function problems(r: Run, purge: boolean): string[] {
  if (r.status !== 0) return [`exit ${r.status}: ${r.out.trim()}`];
  const p: string[] = [];
  if (!r.gh.some((a) => a.includes("DELETE") && a.includes("repos/acme/agentic-payments/environments/dev"))) p.push("the GitHub environment was not deleted");
  if (r.gh.some((a) => a[0] === "secret" && a[1] === "delete")) p.push("a GitHub secret was deleted");
  if (P.resourceGroup in r.state.groups) p.push(`${P.resourceGroup} still exists`);
  if (!("rg-someone-else" in r.state.groups)) p.push("a resource group that isn't ours was deleted");
  for (const a of r.state.apps) if (OURS.has(a.appId)) p.push(`the app registration ${a.displayName} still exists`);
  if (!r.state.apps.some((a) => a.appId === OTHER_APP)) p.push("an app registration that isn't ours was deleted");
  if (r.state.entraGroups.some((g) => g.displayName === P.operators)) p.push(`${P.operators} still exists`);
  if (!r.state.entraGroups.some((g) => g.id === "grp-other")) p.push("a group that isn't ours was deleted");
  const principals = new Set(r.state.sps.map((s) => s.id));
  for (const ra of r.state.roleAssignments) if (!principals.has(ra.principalId)) p.push(`the role assignment ${ra.id.split("/").pop()} is left orphaned (its principal was deleted)`);
  if (!r.state.roleAssignments.some((ra) => ra.principalId === "sp-other")) p.push("a role assignment that isn't ours was deleted");
  const softApps = r.state.deletedApps.filter((a) => OURS.has(a.appId)).length;
  if (purge && (softApps > 0 || r.state.deletedAccounts.length > 0)) p.push("--purge left soft-deleted app registrations or Foundry accounts");
  if (!purge && (softApps !== OURS.size || r.state.deletedAccounts.length !== 1)) p.push("without --purge, the app registrations and the Foundry account must stay soft-deleted");
  for (const v of Object.values(M.vaults)) if (!r.out.includes(`soft-deleted: the vault ${v}`)) p.push(`the soft-deleted vault ${v} was not reported`);
  if (r.az.some((a) => a[0] === "keyvault" && a[1] === "purge")) p.push("tried to purge a vault with purge protection");
  return p;
}

// Each run spawns node once per `az` and `gh` call, and the Bicep CLI twice, so a test takes seconds.
describe.skipIf(!BICEP_PATH)("T-E2E-AZ clean-up (infra/cleanup.sh against a fake tenant and gh)", { timeout: 60_000 }, () => {
  it("T-E2E-AZ cleanup.sh deletes the GitHub environment, the deploy app's role assignments, the resource group, the three app registrations and the operators' group, and nothing else", () => {
    const r = tenant(deployed())(["--yes"]);
    expect(problems(r, false)).toEqual([]);
    expect(r.out).toContain("kept: the GitHub secrets LEFTOVER_SECRET");
    expect(r.out).toContain("Run this again with --purge");
    expect(r.out).toContain("run deploy-infra.yml with first-deployment and recover-vaults");
  });

  it("T-E2E-AZ cleanup.sh --dry-run (even with --yes) prints the plan and changes nothing", () => {
    const r = tenant(deployed())(["--dry-run", "--yes"]);
    expect(r.status).toBe(0);
    expect(changes(r)).toEqual([]);
    expect(r.state).toEqual(deployed());
    for (const line of [
      `clean-up of dev (${MAIN.location}) in subscription ${SUB}, tenant ${TENANT}:`,
      "GitHub acme/agentic-payments: delete the environment dev",
      `role assignment of ${P.deployApp}: Contributor on /subscriptions/${SUB}/resourceGroups/${P.resourceGroup}`,
      `resource group ${P.resourceGroup}: 40 resources, with the vaults ${M.vaults.l1}`,
      `app registration ${P.deployApp} (${DEPLOY})`,
      `app registration ${P.apiApp} (${API})`,
      `app registration ${P.portalApp} (${PORTAL})`,
      `group ${P.operators} (grp-ours), for good`,
      "dry run: nothing was deleted",
    ]) {
      expect(r.out).toContain(line);
    }
  });

  it("T-E2E-AZ cleanup.sh --purge also purges the Foundry account and the app registrations; the vaults stay (purge protection)", () => {
    const r = tenant(deployed())(["--yes", "--purge"]);
    expect(problems(r, true)).toEqual([]);
    expect(r.state.deletedVaults.map((v) => v.name).sort()).toEqual(Object.values(M.vaults).sort());
  });

  it("T-E2E-AZ cleanup.sh run again with --purge purges what the first run left soft-deleted, and then has nothing left to do", () => {
    const run = tenant(deployed());
    expect(problems(run(["--yes"]), false)).toEqual([]);
    const again = run(["--yes", "--purge"]);
    expect(again.status).toBe(0);
    expect(again.state.deletedAccounts).toEqual([]);
    expect(again.state.deletedApps.filter((a) => OURS.has(a.appId))).toEqual([]);
    const third = run(["--yes", "--purge"]);
    expect(third.out).toContain("nothing to clean up");
    expect(changes(third)).toEqual([]);
  });

  it("T-E2E-AZ cleanup.sh deletes only after the resource group's name is typed", () => {
    const wrong = tenant(deployed())([], "dev\n");
    expect(wrong.status).toBe(1);
    expect(wrong.out).toContain("not confirmed: nothing was deleted");
    expect(changes(wrong)).toEqual([]);
    const none = tenant(deployed())([]);
    expect(none.status).toBe(1);
    expect(changes(none)).toEqual([]);
    expect(problems(tenant(deployed())([], `${P.resourceGroup}\n`), false)).toEqual([]);
  });

  it.each([
    ["az signed in to another tenant", (s: State) => ({ ...s, signedInTenant: "99999999-9999-4999-8999-999999999999" }), PARAMS, ["--yes"], "az is signed in to the tenant 99999999"],
    ["a resource group main's parameter file doesn't deploy to", (s: State) => s, PARAMS.replace(/^ {2}resourceGroup: '.*'$/m, "  resourceGroup: 'rg-production'"), ["--yes"], `resource group rg-production is not ${M.resourceGroup}, the one main.dev.bicepparam deploys to`],
    ["an environment without a pre-deploy parameter file", (s: State) => s, PARAMS, ["--yes", "--environment", "prod"], "no infra/pre-deploy.prod.bicepparam"],
  ])("T-E2E-AZ cleanup.sh refuses %s, and deletes nothing", (_, state, params, args, message) => {
    const r = tenant(state(deployed()), { params })(args);
    expect(r.status).toBe(2);
    expect(r.out).toContain(message);
    expect(r.out).toContain("nothing was deleted");
    expect(changes(r)).toEqual([]);
  });

  it("T-E2E-AZ must-fail: without deleting the deploy app's role assignments first, one is left orphaned, and it is reported", () => {
    const r = tenant(deployed(), { mutate: ['az role assignment delete --ids "${IDS[@]}" --subscription "$SUB"', ":"] })(["--yes"]);
    expect(problems(r, false)).toContain("the role assignment ra-sub is left orphaned (its principal was deleted)");
  });

  it("T-E2E-AZ must-fail: a clean-up that doesn't know the portal web app leaves its registration, and it is reported", () => {
    const r = tenant(deployed(), { mutate: ['for name in "$APP_L1" "$APP_DEPLOY" "$APP_PORTAL"; do', 'for name in "$APP_L1" "$APP_DEPLOY"; do'] })(["--yes"]);
    expect(problems(r, false)).toContain(`the app registration ${P.portalApp} still exists`);
  });

  it("T-E2E-AZ must-fail: without the dry-run guard, --dry-run deletes, and it is reported", () => {
    const r = tenant(deployed(), { mutate: ["if $DRY_RUN; then", "if false; then"] })(["--dry-run", "--yes"]);
    expect(changes(r).length).toBeGreaterThan(0);
    expect(r.state).not.toEqual(deployed());
  });
});
