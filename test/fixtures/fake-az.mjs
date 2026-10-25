// A fake `az` for test/entra-app.test.ts: just enough of `az ad` and `az rest` (Microsoft Graph) for
// infra/entra-app.sh, with the state in the JSON file named by FAKE_AZ_STATE. A PATCH of an application's
// `api` replaces it whole, and enforces two Graph rules the script must respect: an enabled scope can't be
// removed or changed, and a pre-authorization may only name a scope that exists. Unknown commands exit 99.
import { readFileSync, writeFileSync } from "node:fs";

const statePath = process.env.FAKE_AZ_STATE;
const s = JSON.parse(readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
const firstFlag = args.findIndex((a) => a.startsWith("-"));
const cmd = (firstFlag < 0 ? args : args.slice(0, firstFlag)).join(" ");
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = (v) => process.stdout.write(`${v}\n`);
const fail = (msg) => {
  process.stderr.write(`fake az: ${msg}\n`);
  process.exit(1);
};
const save = () => writeFileSync(statePath, JSON.stringify(s, null, 2));

const APP_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const APP_OBJECT_ID = "bbbbbbbb-0000-4000-8000-000000000002";
const SP_ID = "cccccccc-0000-4000-8000-000000000003";
const TENANT = "dddddddd-0000-4000-8000-000000000004";
const emptyApi = { acceptMappedClaims: null, knownClientApplications: [], oauth2PermissionScopes: [], preAuthorizedApplications: [], requestedAccessTokenVersion: null };

if (cmd === "ad app list") out(s.app ? s.app.appId : "");
else if (cmd === "ad app create") {
  s.app = { appId: APP_ID, id: APP_OBJECT_ID, appRoles: JSON.parse(readFileSync(opt("--app-roles").slice(1), "utf8")), api: emptyApi };
  out(APP_ID);
} else if (cmd === "ad app update") {
  if (opt("--app-roles")) s.app.appRoles = JSON.parse(readFileSync(opt("--app-roles").slice(1), "utf8"));
  if (opt("--identifier-uris")) s.app.identifierUris = [opt("--identifier-uris")];
  if (opt("--set")) fail(`--set is not simulated: ${opt("--set")}`);
} else if (cmd === "ad app show") {
  if (opt("--query") === "id") out(s.app.id);
  else if (opt("--query") === "api") out(JSON.stringify(s.app.api));
  else fail(`ad app show --query ${opt("--query")}`);
} else if (cmd === "ad sp list") out(s.sp ? s.sp.id : "");
else if (cmd === "ad sp create") {
  s.sp = { id: SP_ID, appId: opt("--id") };
  out(SP_ID);
} else if (cmd === "ad sp update") {
  const m = /^appRoleAssignmentRequired=(true|false)$/.exec(opt("--set") ?? "");
  if (!m) fail(`ad sp update ${args.join(" ")}`);
  s.sp.appRoleAssignmentRequired = m[1] === "true";
} else if (cmd === "ad sp show") out(`sp-object-of-${opt("--id")}`);
else if (cmd === "ad user show") out(`user-object-of-${opt("--id")}`);
else if (cmd === "account show") out(TENANT);
else if (cmd === "rest") {
  const method = opt("--method");
  const uri = opt("--uri");
  if (method === "PATCH" && uri.endsWith(`/applications/${s.app.id}`)) {
    const { api } = JSON.parse(readFileSync(opt("--body").slice(1), "utf8"));
    for (const old of s.app.api.oauth2PermissionScopes.filter((x) => x.isEnabled)) {
      const now = api.oauth2PermissionScopes?.find((x) => x.id === old.id);
      if (JSON.stringify(now) !== JSON.stringify(old)) fail(`CannotDeleteOrUpdateEnabledEntitlement: scope ${old.id}`);
    }
    const scopeIds = new Set((api.oauth2PermissionScopes ?? []).map((x) => x.id));
    for (const p of api.preAuthorizedApplications ?? []) {
      for (const id of p.delegatedPermissionIds) if (!scopeIds.has(id)) fail(`pre-authorization names an unknown scope ${id}`);
    }
    s.app.api = api;
    s.patches = (s.patches ?? 0) + 1;
  } else if (method === "GET" && uri.endsWith(`/servicePrincipals/${s.sp.id}/appRoleAssignedTo`)) {
    const principal = /principalId=='([^']+)'/.exec(opt("--query"))[1];
    const role = /appRoleId=='([^']+)'/.exec(opt("--query"))[1];
    out((s.assignments ?? []).filter((a) => a.principalId === principal && a.appRoleId === role).length);
  } else if (method === "POST" && uri.endsWith(`/servicePrincipals/${s.sp.id}/appRoleAssignedTo`)) {
    (s.assignments ??= []).push(JSON.parse(opt("--body")));
  } else fail(`rest ${method} ${uri}`);
} else {
  process.stderr.write(`fake az: unknown command: ${args.join(" ")}\n`);
  process.exit(99);
}
save();
