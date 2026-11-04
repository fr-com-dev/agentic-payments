// A fake `az` for test/cleanup.test.ts and test/github-setup.test.ts: the ARM and Graph calls of infra/cleanup.sh
// against a tenant held in the JSON file named by FAKE_AZ_STATE. Every call is appended to FAKE_AZ_LOG as one JSON
// line ({args}). `az bicep build-params` runs the real Bicep CLI (BICEP_PATH, with the real home FAKE_BICEP_HOME
// for its extension cache) and needs no tenant. It behaves as Azure does where the script depends on it:
// - deleting an app registration deletes its service principal but leaves that principal's role assignments,
//   orphaned;
// - deleting a resource group deletes the role assignments inside it, and soft-deletes its vaults (purge
//   protection: a purge fails) and its Foundry accounts (a purge succeeds);
// - a deleted app registration waits in deletedItems until purged; a deleted security group is gone;
// - an ARM call without the state's --subscription fails.
// Unknown commands exit 99.
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_AZ_LOG) appendFileSync(process.env.FAKE_AZ_LOG, `${JSON.stringify({ args })}\n`);
const firstFlag = args.findIndex((a) => a.startsWith("-"));
const cmd = (firstFlag < 0 ? args : args.slice(0, firstFlag)).join(" ");
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (cmd === "bicep build-params") {
  if (!args.includes("--stdout")) process.exit(98);
  const r = spawnSync(process.env.BICEP_PATH, ["build-params", opt("--file"), "--stdout"], {
    encoding: "utf8",
    env: { ...process.env, HOME: process.env.FAKE_BICEP_HOME ?? process.env.HOME },
  });
  process.stderr.write(r.stderr ?? "");
  // Exit once stdout is flushed: the compiled template is larger than a pipe's buffer.
  process.stdout.write(r.stdout ?? "", () => process.exit(r.status ?? 1));
} else {
  tenantCall();
}

/** A call against the fake tenant in FAKE_AZ_STATE. */
function tenantCall() {
  const statePath = process.env.FAKE_AZ_STATE;
  const s = JSON.parse(readFileSync(statePath, "utf8"));
  const fail = (msg) => {
    process.stderr.write(`fake az: ${msg}\n`);
    process.exit(1);
  };
  const tsv = (rows) => process.stdout.write(rows.map((r) => `${r.join("\t")}\n`).join(""));
  const save = () => writeFileSync(statePath, JSON.stringify(s, null, 2));
  const rgId = (rg) => `/subscriptions/${s.subscription}/resourceGroups/${rg}`;
  const arm = () => {
    if (opt("--subscription") !== s.subscription) fail(`wrong or missing --subscription ${opt("--subscription")}`);
  };
  const group = (rg) => s.groups[rg] ?? fail(`ResourceGroupNotFound ${rg}`);
  /** --filter "appId eq 'x'" or "displayName eq 'x'". */
  const appFilter = () => {
    const m = /^(appId|displayName) eq '([^']*)'$/.exec(opt("--filter") ?? "") ?? fail(`filter ${opt("--filter")}`);
    return (a) => a[m[1]] === m[2];
  };

  if (cmd === "account show") {
    process.stdout.write(`${s.signedInTenant}\n`);
  } else if (cmd === "ad app list") {
    if (opt("--query") !== "[].[appId,id,displayName]") fail(`ad app list --query ${opt("--query")}`);
    tsv(s.apps.filter(appFilter()).map((a) => [a.appId, a.id, a.displayName]));
  } else if (cmd === "ad group list") {
    if (opt("--query") !== "[].[id,displayName]") fail(`ad group list --query ${opt("--query")}`);
    tsv(s.entraGroups.filter(appFilter()).map((g) => [g.id, g.displayName]));
  } else if (cmd === "ad group delete") {
    if (!s.entraGroups.some((g) => g.id === opt("--group"))) fail(`no group ${opt("--group")}`);
    s.entraGroups = s.entraGroups.filter((g) => g.id !== opt("--group"));
  } else if (cmd === "ad sp list") {
    const sp = s.sps.find(appFilter());
    process.stdout.write(sp ? `${sp.id}\n` : "");
  } else if (cmd === "ad app delete") {
    const app = s.apps.find((a) => a.appId === opt("--id")) ?? fail(`no app ${opt("--id")}`);
    s.apps = s.apps.filter((a) => a !== app);
    s.sps = s.sps.filter((x) => x.appId !== app.appId);
    s.deletedApps.push(app);
  } else if (cmd === "role assignment list") {
    arm();
    if (!args.includes("--all")) fail("role assignment list without --all misses other scopes");
    tsv(s.roleAssignments.filter((r) => r.principalId === opt("--assignee")).map((r) => [r.id, r.role, r.scope]));
  } else if (cmd === "role assignment delete") {
    arm();
    const ids = args.slice(args.indexOf("--ids") + 1).filter((_, i, xs) => !xs.slice(0, i + 1).some((x) => x.startsWith("--")));
    s.roleAssignments = s.roleAssignments.filter((r) => !ids.includes(r.id));
  } else if (cmd === "group exists") {
    arm();
    process.stdout.write(`${opt("--name") in s.groups}\n`);
  } else if (cmd === "resource list") {
    arm();
    process.stdout.write(`${group(opt("-g")).resources}\n`);
  } else if (cmd === "keyvault list") {
    arm();
    tsv(group(opt("-g")).vaults.map((v) => [v]));
  } else if (cmd === "cognitiveservices account list") {
    arm();
    tsv(group(opt("-g")).accounts.map((a) => [a.name, a.location]));
  } else if (cmd === "group delete") {
    arm();
    const rg = opt("--name");
    const g = group(rg);
    if (!args.includes("--yes")) fail("group delete without --yes waits for a prompt");
    for (const v of g.vaults) s.deletedVaults.push({ name: v, scheduledPurgeDate: "2027-01-30T00:00:00Z", vaultId: `${rgId(rg)}/providers/Microsoft.KeyVault/vaults/${v}` });
    for (const a of g.accounts) s.deletedAccounts.push({ ...a, id: `/subscriptions/${s.subscription}/providers/Microsoft.CognitiveServices/locations/${a.location}/resourceGroups/${rg}/deletedAccounts/${a.name}` });
    s.roleAssignments = s.roleAssignments.filter((r) => !r.scope.toLowerCase().startsWith(rgId(rg).toLowerCase()));
    delete s.groups[rg];
  } else if (cmd === "cognitiveservices account list-deleted") {
    arm();
    tsv(s.deletedAccounts.map((a) => [a.name, a.location, a.id]));
  } else if (cmd === "cognitiveservices account purge") {
    arm();
    const a = s.deletedAccounts.find((x) => x.name === opt("--name") && x.location === opt("--location") && x.id.includes(`/resourceGroups/${opt("--resource-group")}/`));
    if (!a) fail(`no deleted account ${opt("--name")}`);
    s.deletedAccounts = s.deletedAccounts.filter((x) => x !== a);
  } else if (cmd === "keyvault list-deleted") {
    arm();
    tsv(s.deletedVaults.map((v) => [v.name, v.scheduledPurgeDate, v.vaultId]));
  } else if (cmd === "keyvault purge") {
    fail("Operation 'DeletedVaultPurge' is not allowed: the vault has purge protection");
  } else if (cmd === "rest") {
    const uri = opt("--uri");
    if (opt("--method") === "GET" && uri.startsWith("https://graph.microsoft.com/v1.0/directory/deletedItems/microsoft.graph.application?")) {
      if (opt("--query") !== "value[].[id,appId,displayName]") fail(`rest GET --query ${opt("--query")}`);
      tsv(s.deletedApps.map((a) => [a.id, a.appId, a.displayName]));
    } else if (opt("--method") === "DELETE" && uri.startsWith("https://graph.microsoft.com/v1.0/directory/deletedItems/")) {
      const id = uri.slice(uri.lastIndexOf("/") + 1);
      if (!s.deletedApps.some((a) => a.id === id)) fail(`Request_ResourceNotFound ${id}`);
      s.deletedApps = s.deletedApps.filter((a) => a.id !== id);
    } else fail(`rest ${opt("--method")} ${uri}`);
  } else {
    process.stderr.write(`fake az: unknown command: ${args.join(" ")}\n`);
    process.exit(99);
  }
  save();
}
