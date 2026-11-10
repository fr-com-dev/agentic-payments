// T-IAC-01 Azure identity, secret, exposure and naming rules (SPEC.md §3.1 Azure profile; specs/011 contracts/
// cloud-topology.md "T-IAC-01 assertions"). Compiles infra/main.bicep (the platform and every unit) and
// infra/pre-deploy.bicep (the resource group, the Entra objects and the deploy app's roles) with the Bicep CLI, and
// asserts on the ARM JSON that would actually be deployed and on their parameter files, compiled too. main.bicep
// deploys one unit per run (`unit`: the platform, or one unit's apps), and rule 18 checks each module belongs to
// exactly one. Needs the Bicep CLI, and the Microsoft Graph extension it restores from mcr.microsoft.com: set
// BICEP_PATH (deploy.yml does);
// without it this suite is skipped. Each rule has a must-fail mutant. Every name is in the parameter files (`names`):
// names are resolved with the dev files' values, and rule 15 checks each one against the naming standard.
// 013 (specs/013 contracts/config-and-secrets.md "T-IAC-01 changes"): the portal unit joins the tables, rules 2, 3, 4,
// 8 and 16 are extended for it, and rule 20 covers user accounts.
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Bicep } from "@azure/bicep-rpc-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IMAGES, type ImageName } from "../scripts/image-closure.js";
import { BICEP_PATH, leaves, type MainNames, type PreDeployNames } from "./helpers/bicep.js";

type Json = Record<string, unknown>;
interface Res {
  /** The template it comes from: main or pre-deploy. */
  root: string;
  /** The module (nested deployment) it is declared in; the template's name at the top level. */
  module: string;
  type: string;
  name: string;
  properties: Json;
  raw: Json;
  /** The `variables` of the template this resource is declared in. */
  vars: Json;
}

/** Each parameter file's compiled values, by file name (main.dev.bicepparam): what its deployment gets. */
export type Params = Record<string, Json>;

/** Replaces `variables('x')` with the value of x from the resource's own template, also inside that value. */
function withVars(expr: unknown, vars: Json): string {
  let s = String(expr);
  for (let i = 0; i < 5; i++) {
    const next = s.replace(/variables\('([A-Za-z0-9_]+)'\)/g, (m, name: string) => (name in vars ? JSON.stringify(vars[name]) : m));
    if (next === s) break;
    s = next;
  }
  return s;
}

/** Splits ARM function arguments at top-level commas, minding quotes, parentheses and brackets. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") quoted = !quoted;
    else if (!quoted && (c === "(" || c === "[")) depth++;
    else if (!quoted && (c === ")" || c === "]")) depth--;
    else if (!quoted && depth === 0 && c === ",") {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(s.slice(start).trim());
  return out;
}

/** `parameters('x')` with its `.key` and `[expr]` accessors, as x and the accessors (`'key'` or the expression). */
function parameterPath(s: string): [string, string[]] | undefined {
  const m = /^parameters\('(\w+)'\)/.exec(s);
  if (!m) return undefined;
  const accessors: string[] = [];
  for (let i = m[0].length; i < s.length; ) {
    const key = /^\.(\w+)/.exec(s.slice(i));
    if (key) {
      accessors.push(`'${key[1]}'`);
      i += key[0].length;
    } else if (s[i] === "[") {
      let depth = 0;
      let quoted = false;
      let end = i;
      for (; end < s.length; end++) {
        const c = s[end];
        if (c === "'") quoted = !quoted;
        else if (!quoted && c === "[") depth++;
        else if (!quoted && c === "]" && --depth === 0) break;
      }
      accessors.push(s.slice(i + 1, end));
      i = end + 1;
    } else return undefined;
  }
  return [m[1]!, accessors];
}

/**
 * The strings an ARM expression in a name can take: literals, format(), resourceId() (its last segment), parameters
 * (also a property or an element of an object parameter, every element when the key is unknown), variables (also a
 * property of an object variable) and a copy loop over a variable (one string per element). Anything else is `*`.
 */
export function resolveArm(expr: string, vars: Json, params: Json): string[] {
  const s = expr.trim();
  let m: RegExpExecArray | null;
  if ((m = /^'((?:[^']|'')*)'$/.exec(s))) return [m[1]!.replace(/''/g, "'")];
  const path = parameterPath(s);
  if (path) {
    let values: unknown[] = [params[path[0]]];
    for (const a of path[1]) {
      const keys = /^'(\w+)'$/.test(a) ? [a.slice(1, -1)] : resolveArm(a, vars, params);
      values = values.flatMap((v) => (v && typeof v === "object" ? (keys.includes("*") ? Object.values(v) : keys.map((k) => (v as Json)[k])) : [undefined]));
    }
    return values.map((v) => (typeof v === "string" ? v : "*"));
  }
  if ((m = /^variables\('(\w+)'\)\[copyIndex\(\)\]$/.exec(s))) return ((vars[m[1]!] ?? ["*"]) as unknown[]).map(String);
  if ((m = /^variables\('(\w+)'\)((?:\.\w+)*)$/.exec(s))) {
    let v: unknown = vars[m[1]!];
    for (const k of m[2]!.split(".").filter(Boolean)) v = (v as Json | undefined)?.[k];
    return typeof v === "string" ? resolved(v, vars, params) : ["*"];
  }
  if ((m = /^resourceId\(([\s\S]*)\)$/.exec(s))) return resolveArm(splitArgs(m[1]!).at(-1)!, vars, params);
  // A DNS suffix starts with a dot, which ends the name before it (crx402eastus2dev.azurecr.io).
  if ((m = /^environment\(\)\.suffixes\.(\w+)$/.exec(s))) return [`.${m[1]}`];
  if ((m = /^format\(([\s\S]*)\)$/.exec(s))) {
    const [fmt, ...args] = splitArgs(m[1]!).map((a) => resolveArm(a, vars, params));
    let out = fmt ?? ["*"];
    args.forEach((values, i) => {
      out = out.flatMap((o) => values.map((v) => o.split(`{${i}}`).join(v)));
    });
    return out;
  }
  return ["*"];
}
/** Every whole `format(…)` call in a text, its parentheses matched (quotes minded), outermost first. */
function formatCalls(text: string): string[] {
  const out: string[] = [];
  for (let start = text.indexOf("format("); start >= 0; start = text.indexOf("format(", start + 1)) {
    let depth = 0;
    let quoted = false;
    for (let i = start + "format".length; i < text.length; i++) {
      const c = text[i];
      if (c === "'") quoted = !quoted;
      else if (!quoted && c === "(") depth++;
      else if (!quoted && c === ")" && --depth === 0) {
        out.push(text.slice(start, i + 1));
        break;
      }
    }
  }
  return out;
}
/** A name or other string property, resolved: `[expr]` is an expression, anything else a literal. */
function resolved(value: unknown, vars: Json, params: Json): string[] {
  const s = String(value);
  return s.startsWith("[") && s.endsWith("]") ? resolveArm(s.slice(1, -1), vars, params) : [s];
}

const KV_SECRETS_USER = "4633458b-17de-408a-b874-0445c86b69e6";
const ACR_PULL = "7f951dda-4ed3-4680-a7ca-43fe172d538d";
const COGNITIVE_SERVICES_USER = "a97b65f3-24c7-4388-baec-2e87135dc908";
const JOBS_OPERATOR = "b9a307c4-5aa3-4b52-ba60-2b17c136cd7b";
const CONTRIBUTOR = "b24988ac-6180-42a0-ab88-20f7382dd24c";
const RBAC_ADMINISTRATOR = "f58310d9-a9f6-439a-9e8d-f62e7b41a168";
const AGENT_RUN = "5b2c3a7e-6f1d-4c55-9f0e-0a1b2c3d4e51";
const USER_IMPERSONATION = "5b2c3a7e-6f1d-4c55-9f0e-0a1b2c3d4e52";
const PORTAL_ACCESS = "5b2c3a7e-6f1d-4c55-9f0e-0a1b2c3d4e53";
const AZURE_CLI = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";
/** The web app's local redirect URI (the portal on its default port); the deployed one comes from portalOrigin. */
const LOCAL_REDIRECT = "http://localhost:4025/redirect.html";
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** The two templates: everything in the resource group, and what precedes it. */
export const TEMPLATES = ["main", "pre-deploy"] as const;
export type Templates = Record<(typeof TEMPLATES)[number], Json>;
/**
 * Each unit's apps module in main.bicep, by its image: the unit whose runs deploy it (main.bicep's `unit`, rule 18),
 * and the identities and vaults it may use (rules 12 and 13).
 */
const UNITS: Record<ImageName, { unit: string; apps: string; identities: string[]; vaults: string[] }> = {
  "l1-agent": { unit: "l1", apps: "l1-apps", identities: ["l1"], vaults: ["l1"] },
  "l2-control": { unit: "l2", apps: "l2-apps", identities: ["l2"], vaults: ["l2"] },
  "l3-verifier": { unit: "l3", apps: "l3-apps", identities: ["l3"], vaults: ["l3"] },
  operator: { unit: "operator", apps: "operator-apps", identities: ["op"], vaults: ["op"] },
  portal: { unit: "portal", apps: "portal-apps", identities: ["portal"], vaults: ["portal"] },
  seller: { unit: "seller", apps: "sellers", identities: ["seller"], vaults: ["seller"] },
};
/** main.bicep's platform modules: deployed only by the platform's runs (deploy-infra.yml; rule 18). */
const PLATFORM_MODULES = ["network", "logs", "identities", "registry", "vault", "storage", "foundry", "environments"];
/** What one deployment of main.bicep deploys (`unit`): the platform, or one unit's apps. */
const DEPLOY_UNITS = ["platform", ...Object.values(UNITS).map((u) => u.unit)];
/**
 * The naming standard, {type}-{app}-{location}-{environment}, by a name's place in a parameter file's `names` (rule
 * 15): a group's keys are the {app} (sellerAlias is seller-alias); the registry and storage drop the hyphens. Each
 * type carries Azure's rule for its names.
 */
const STANDARD: Record<string, { type: string; app?: string; compact?: boolean; limits: [number, number, RegExp] }> = {
  resourceGroup: { type: "rg", app: "x402", limits: [1, 90, /^[a-z0-9-]+$/] },
  network: { type: "vnet", app: "x402", limits: [2, 64, /^[a-z][a-z0-9-]*[a-z0-9]$/] },
  subnets: { type: "snet", limits: [1, 80, /^[a-z][a-z0-9-]*[a-z0-9]$/] },
  logs: { type: "log", app: "x402", limits: [4, 63, /^[a-z][a-z0-9-]*[a-z0-9]$/] },
  registry: { type: "cr", app: "x402", compact: true, limits: [5, 50, /^[a-z0-9]+$/] },
  storage: { type: "st", app: "x402", compact: true, limits: [3, 24, /^[a-z0-9]+$/] },
  foundry: { type: "ais", app: "x402", limits: [2, 64, /^[a-z][a-z0-9-]*[a-z0-9]$/] },
  environments: { type: "cae", limits: [2, 60, /^[a-z][a-z0-9-]*[a-z0-9]$/] },
  identities: { type: "id", limits: [3, 128, /^[a-z][a-z0-9-]*[a-z0-9]$/] },
  vaults: { type: "kv", limits: [3, 24, /^[a-z](?!.*--)[a-z0-9-]*[a-z0-9]$/] },
  apps: { type: "ca", limits: [2, 32, /^[a-z](?!.*--)[a-z0-9-]*[a-z0-9]$/] },
  jobs: { type: "caj", limits: [2, 32, /^[a-z](?!.*--)[a-z0-9-]*[a-z0-9]$/] },
  apiApp: { type: "app", app: "l1", limits: [1, 120, /^[a-z][a-z0-9-]*[a-z0-9]$/] },
  deployApp: { type: "app", app: "deploy", limits: [1, 120, /^[a-z][a-z0-9-]*[a-z0-9]$/] },
  portalApp: { type: "app", app: "portal", limits: [1, 120, /^[a-z][a-z0-9-]*[a-z0-9]$/] },
  operators: { type: "grp", app: "op", limits: [1, 64, /^[a-z][a-z0-9-]*[a-z0-9]$/] },
};
/** The {app} segments: the layers, the operator, the portal, the sellers, what the layers share, and the deploy app. */
const APPS = ["l1", "l2", "l3", "op", "portal", "seller", "seller-alias", "x402", "deploy"];
/** Payment key material (INV-2): each reaches only L2's control app (container l2), from the l2 vault (rule 2). */
const PAYMENT_KEYS = ["PAYER_PRIVATE_KEY", "USER_WALLET_MNEMONIC"];
/** The x402 environment's NFS storages, and the one app key (names.apps.<key>) that may mount each (rule 4). */
const STORAGE_OWNER: Record<string, "l2" | "portal"> = { ledger: "l2", profiles: "portal" };
/** The resource types whose names come from `names` (rule 15). */
const NAMED_TYPES = [
  "Microsoft.Resources/resourceGroups",
  "Microsoft.Network/virtualNetworks",
  "Microsoft.OperationalInsights/workspaces",
  "Microsoft.ManagedIdentity/userAssignedIdentities",
  "Microsoft.ContainerRegistry/registries",
  "Microsoft.KeyVault/vaults",
  "Microsoft.Storage/storageAccounts",
  "Microsoft.CognitiveServices/accounts",
  "Microsoft.App/managedEnvironments",
  "Microsoft.App/containerApps",
  "Microsoft.App/jobs",
  "Microsoft.Graph/applications@v1.0",
  "Microsoft.Graph/groups@v1.0",
];
/** The only parameters a parameter file may read from the environment: deploy.yml sets them on each run. */
const PER_RUN = ["unit", "imageTag", "seedIp", "recoverVaults", "agentStableRevision"];
/** The deployment target: both parameter files of an environment must agree on it (rule 17). */
const TARGET = ["tenantId", "subscriptionId", "location", "names.resourceGroup"];
/** GitHub's immutable OIDC subject for a deploy job: the owner and repository by name and ID (rule 16). */
const IMMUTABLE_SUBJECT = "repo:<owner>@<githubOwnerId>/<name>@<githubRepositoryId>:environment:<githubEnvironment>";
/** A dotted path's value in an object. */
const at = (o: unknown, path: string) => path.split(".").reduce<unknown>((v, k) => (v as Json | undefined)?.[k], o);

/** `network`, `vault`, `l1-apps`… from a nested deployment's (possibly expression) name. */
function moduleName(name: string): string {
  const m = /^\[format\('([a-z-]+?)-\{0\}'/.exec(name);
  return m ? m[1]! : name;
}

/** Every deployed resource (not `existing` lookups), with its module; `root` at the top level. */
function flatten(template: Json, root: string, module = root): Res[] {
  const out: Res[] = [];
  const vars = (template.variables ?? {}) as Json;
  const resources = (Array.isArray(template.resources) ? template.resources : Object.values((template.resources ?? {}) as Json)) as Json[];
  for (const r of resources) {
    if (r.existing === true) continue;
    const type = String(r.type);
    const props = (r.properties ?? {}) as Json;
    out.push({ root, module, type, name: String(r.name ?? props.uniqueName ?? ""), properties: props, raw: r, vars });
    if (type === "Microsoft.Resources/deployments") out.push(...flatten((props.template ?? {}) as Json, root, moduleName(String(r.name))));
  }
  return out;
}

/** The raw name expression of a resource (a Graph object's uniqueName). */
const nameExpr = (r: Res) => String(r.type.startsWith("Microsoft.Graph/") ? r.properties.uniqueName : r.name);

const apps = (all: Res[]) => all.filter((r) => r.type === "Microsoft.App/containerApps" || r.type === "Microsoft.App/jobs");
type Container = { name: string; image?: string; command?: string[]; env?: { name: string; value?: string; secretRef?: string }[]; volumeMounts?: { volumeName: string; mountPath: string }[] };
type Volume = { name: string; storageType: string; storageName?: string };
const volumesOf = (r: Res) => ((r.properties.template as Json)?.volumes ?? []) as Volume[];
const containersOf = (r: Res) => ((r.properties.template as Json)?.containers ?? []) as Container[];
const configOf = (r: Res) => (r.properties.configuration ?? {}) as Json;
const secretsOf = (r: Res) => (configOf(r).secrets ?? []) as { name: string; keyVaultUrl?: string; value?: string }[];
const deployment = (all: Res[], module: string) => all.find((r) => r.type === "Microsoft.Resources/deployments" && moduleName(r.name) === module);
const deploymentParam = (all: Res[], module: string, param: string) =>
  JSON.stringify(((deployment(all, module)?.properties.parameters ?? {}) as Json)[param] ?? null);
/** The vault keys a secret reference points at (names.vaults.<key>), through its module's variables. */
const vaultKeysOf = (r: Res, url: string | undefined) => [...withVars(url ?? "", r.vars).matchAll(/parameters\('names'\)\.vaults\.(\w+)/g)].map((m) => m[1]!);
/** The `param name = value` lines of a parameter file. */
const paramLines = (text: string) => new Map([...text.matchAll(/^param (\w+) = (.+)$/gm)].map((m) => [m[1]!, m[2]!.trim()]));

/**
 * Rules 1–20 of contracts/cloud-topology.md, on the compiled templates, the compiled parameter files (`params`, by
 * file name) and the infra sources. Returns one message per violation, prefixed `rule N:`.
 */
export function violations(arms: Templates, params: Params, infraFiles: Record<string, string>): string[] {
  const v: string[] = [];
  const devParams: Record<string, Json> = { main: params["main.dev.bicepparam"] ?? {}, "pre-deploy": params["pre-deploy.dev.bicepparam"] ?? {} };
  const MN = devParams.main!.names as MainNames;
  const PN = devParams["pre-deploy"]!.names as PreDeployNames;
  /** A resource's names in the dev environment; a copy loop expands to every element. */
  const namesOf = (r: Res) => resolved(nameExpr(r), r.vars, devParams[r.root]!);
  const EXTERNAL_OK = new Set([MN.apps.l1, MN.apps.portal, MN.apps.seller, MN.apps.sellerAlias]);
  /** The unit (image) each app and job belongs to (rule 12). */
  const APP_UNIT: Record<string, ImageName> = {
    [MN.apps.l1]: "l1-agent",
    [MN.jobs.l1]: "l1-agent",
    [MN.apps.l2]: "l2-control",
    [MN.jobs.l2]: "operator",
    [MN.apps.l3]: "l3-verifier",
    [MN.apps.portal]: "portal",
    [MN.apps.seller]: "seller",
    [MN.apps.sellerAlias]: "seller",
  };
  const all = TEMPLATES.flatMap((name) => flatten(arms[name], name));
  const main = all.filter((r) => r.root === "main");
  const pre = all.filter((r) => r.root === "pre-deploy");
  const units = ((arms.main.variables as Json)?.units ?? []) as { key: string; subnet: string }[];
  const byName = (name: string | undefined) => main.find((r) => namesOf(r).includes(name ?? ""));
  const label = (r: Res) => namesOf(r).join("/");
  const roleOf = (ra: Res) => withVars(ra.properties.roleDefinitionId, ra.vars);

  // Rule 1: role assignments only where the matrix puts them.
  if (!deploymentParam(main, "identities", "keys").includes("map(variables('units')")) v.push("rule 1: the identities are not one per unit");
  if (!deploymentParam(main, "registry", "identityKeys").includes("map(variables('units')")) v.push("rule 1: not every unit's identity pulls from the registry");
  for (const ra of all.filter((r) => r.type === "Microsoft.Authorization/roleAssignments")) {
    const role = roleOf(ra);
    const principal = String(ra.properties.principalId);
    const scope = resolved(ra.raw.scope ?? "", ra.vars, devParams[ra.root]!);
    const ok =
      (ra.module === "vault" && role.includes(KV_SECRETS_USER) && principal.includes("parameters('names').identities[parameters('key')]")) ||
      (ra.module === "registry" && role.includes(ACR_PULL) && principal.includes("parameters('names').identities[parameters('identityKeys')[copyIndex()]]")) ||
      (ra.module === "foundry" && role.includes(COGNITIVE_SERVICES_USER) && principal.includes("parameters('names').identities.l1)")) ||
      (ra.module === "operator-apps" && role.includes(JOBS_OPERATOR) && principal === "[parameters('operatorsGroupId')]" && scope.some((s) => s === MN.jobs.l2 || s.endsWith(`/${MN.jobs.l2}`))) ||
      (ra.module === "deploy-access" && (role.includes(CONTRIBUTOR) || role.includes(RBAC_ADMINISTRATOR)) && principal === "[parameters('principalId')]");
    if (!ok) v.push(`rule 1: role assignment ${ra.name} in ${ra.module} is not in the matrix`);
  }
  for (const module of ["vault", "foundry", "registry"]) {
    if (main.filter((r) => r.module === module && r.type === "Microsoft.Authorization/roleAssignments").length !== 1) v.push(`rule 1: ${module} must grant exactly one role assignment (per vault, or one loop)`);
  }

  // Rule 2: the payment keys (the payer key, and 013's user wallet mnemonic) only in L2's control app (container
  // l2), only as references to the l2 vault. No other app reads the l2 vault.
  for (const a of apps(main)) {
    for (const c of containersOf(a)) {
      for (const e of c.env ?? []) {
        if (!PAYMENT_KEYS.includes(e.name)) continue;
        if (!namesOf(a).includes(MN.apps.l2) || c.name !== "l2") v.push(`rule 2: ${e.name} in ${label(a)}/${c.name}`);
        else if (e.value !== undefined || !e.secretRef) v.push(`rule 2: ${e.name} is not a secret reference`);
        else if (JSON.stringify(vaultKeysOf(a, secretsOf(a).find((x) => x.name === e.secretRef)?.keyVaultUrl)) !== '["l2"]') v.push(`rule 2: ${e.name} does not come from the l2 vault`);
      }
    }
    for (const s of secretsOf(a)) {
      if (vaultKeysOf(a, s.keyVaultUrl).includes("l2") && !namesOf(a).includes(MN.apps.l2)) v.push(`rule 2: ${label(a)} reads the l2 vault`);
    }
  }

  // Rule 3: only the agent, the portal (013) and the sellers have external ingress.
  for (const a of main.filter((r) => r.type === "Microsoft.App/containerApps")) {
    const ingress = configOf(a).ingress as Json | undefined;
    for (const name of namesOf(a)) if (ingress?.external === true && !EXTERNAL_OK.has(name)) v.push(`rule 3: ${name} has external ingress`);
  }
  for (const name of [MN.apps.l2, MN.apps.l3]) {
    const a = byName(name);
    if (!a || (configOf(a).ingress as Json)?.external !== false) v.push(`rule 3: ${name} must have external: false`);
  }

  // Rule 4: one L2 replica, single revision, NFS ledger at /app/.local.
  const l2 = byName(MN.apps.l2);
  if (l2) {
    const scale = ((l2.properties.template as Json)?.scale ?? {}) as Json;
    if (scale.minReplicas !== 1 || scale.maxReplicas !== 1) v.push(`rule 4: ${MN.apps.l2} must run exactly one replica`);
    if (configOf(l2).activeRevisionsMode !== "Single") v.push(`rule 4: ${MN.apps.l2} must use single revision mode`);
    const vols = ((l2.properties.template as Json)?.volumes ?? []) as { name: string; storageType: string }[];
    const nfs = vols.find((x) => x.storageType === "NfsAzureFile");
    const mount = containersOf(l2).find((c) => c.name === "l2")?.volumeMounts?.find((m) => m.volumeName === nfs?.name);
    if (!nfs || mount?.mountPath !== "/app/.local") v.push("rule 4: the l2 container must mount the NFS ledger at /app/.local");
  }
  // Rule 4, extended (013): each NFS storage of the x402 environment has one app. The ledger storage is mounted by
  // L2's control app only, and the profiles storage by the portal only, which never reaches the ledger file. The
  // platform makes exactly these two, each on its own share; the portal, whose profile files have one writer, runs
  // one replica at most in single revision mode with profiles at /app/.local/portal.
  /** A volume's environment storage: a literal, or the module parameter main.bicep sets. */
  const storageOf = (a: Res, vol: Volume): string => {
    const param = /^\[parameters\('(\w+)'\)\]$/.exec(vol.storageName ?? "")?.[1];
    if (!param) return String(vol.storageName);
    return String((((deployment(main, a.module)?.properties.parameters ?? {}) as Json)[param] as Json | undefined)?.value ?? "*");
  };
  for (const a of apps(main)) {
    for (const vol of volumesOf(a).filter((x) => x.storageType !== "Secret" && x.storageType !== "EmptyDir")) {
      const storage = storageOf(a, vol);
      const owner = STORAGE_OWNER[storage];
      if (vol.storageType !== "NfsAzureFile" || owner === undefined) v.push(`rule 4: ${label(a)} mounts ${storage} (${vol.storageType}), which is not one of the environment's storages (${Object.keys(STORAGE_OWNER).join(", ")})`);
      else if (!namesOf(a).includes(MN.apps[owner])) v.push(`rule 4: ${label(a)} mounts the ${storage} storage, which only ${MN.apps[owner]} may`);
    }
  }
  const envStorages = main.filter((r) => r.type === "Microsoft.App/managedEnvironments/storages");
  const shares = main.filter((r) => r.type === "Microsoft.Storage/storageAccounts/fileServices/shares");
  const lastSegment = (r: Res) => withVars(r.name, r.vars).match(/'([a-z]+)'\)\]$/)?.[1] ?? r.name.split("/").pop()!;
  if (JSON.stringify(envStorages.map(lastSegment).sort()) !== JSON.stringify(Object.keys(STORAGE_OWNER).sort())) v.push(`rule 4: the environment's storages must be exactly ${Object.keys(STORAGE_OWNER).join(" and ")}`);
  if (JSON.stringify(shares.map(lastSegment).sort()) !== JSON.stringify(Object.keys(STORAGE_OWNER).sort())) v.push(`rule 4: the storage account's shares must be exactly ${Object.keys(STORAGE_OWNER).join(" and ")}`);
  for (const st of envStorages) {
    const nfs = (st.properties.nfsAzureFile ?? {}) as Json;
    const storage = lastSegment(st);
    if (!resolved(st.name, st.vars, devParams.main!).every((n) => n.startsWith(MN.environments.x402)) || nfs.accessMode !== "ReadWrite" || !String(nfs.shareName).endsWith(`/${storage}', parameters('names').storage)]`)) {
      v.push(`rule 4: the ${storage} storage must be the ${storage} NFS share, read-write, in ${MN.environments.x402}`);
    }
  }
  for (const sh of shares) if (sh.properties.enabledProtocols !== "NFS") v.push(`rule 4: the ${lastSegment(sh)} share must be NFS (the account has shared-key access off)`);
  const portal = byName(MN.apps.portal);
  if (portal) {
    const scale = ((portal.properties.template as Json)?.scale ?? {}) as Json;
    if (scale.maxReplicas !== 1) v.push(`rule 4: ${MN.apps.portal} must run one replica at most (its profile files have one writer)`);
    if (configOf(portal).activeRevisionsMode !== "Single") v.push(`rule 4: ${MN.apps.portal} must use single revision mode`);
    const nfs = volumesOf(portal).find((x) => x.storageType === "NfsAzureFile" && storageOf(portal, x) === "profiles");
    const mount = containersOf(portal).find((c) => c.name === "portal")?.volumeMounts?.find((m) => m.volumeName === nfs?.name);
    if (!nfs || mount?.mountPath !== "/app/.local/portal") v.push("rule 4: the portal container must mount the NFS profiles storage at /app/.local/portal");
  } else {
    v.push(`rule 4: the portal app ${MN.apps.portal} is missing`);
  }

  // Rule 5: proxy sidecars have no env and no secrets.
  for (const a of apps(main)) {
    for (const c of containersOf(a).filter((x) => x.name === "proxy")) {
      if ((c.env ?? []).length > 0) v.push(`rule 5: ${label(a)}/proxy has env`);
      if (JSON.stringify(c).includes("secretRef")) v.push(`rule 5: ${label(a)}/proxy references a secret`);
    }
  }

  // Rule 6: identity lifecycle Main only for the agent.
  for (const a of apps(main)) {
    const settings = (configOf(a).identitySettings ?? []) as { lifecycle: string }[];
    const want = namesOf(a).includes(MN.apps.l1) ? "Main" : "None";
    if (settings.length === 0 || settings.some((s) => s.lifecycle !== want)) v.push(`rule 6: ${label(a)} identity lifecycle must be ${want}`);
  }

  // Rule 7: the sellers live in their own environment and read only the seller vault.
  for (const s of main.filter((r) => r.module === "sellers" && r.type === "Microsoft.App/containerApps")) {
    if (JSON.stringify(resolved(s.properties.environmentId, s.vars, devParams.main!)) !== JSON.stringify([MN.environments.seller])) v.push(`rule 7: ${label(s)} is not in ${MN.environments.seller}`);
    if (secretsOf(s).some((x) => JSON.stringify(vaultKeysOf(s, x.keyVaultUrl)) !== '["seller"]')) v.push(`rule 7: ${label(s)} reads a vault other than the seller's`);
  }

  // Rule 8: no secret value anywhere in the infrastructure sources; secret-named env never takes a literal.
  const SHAPES: [string, RegExp][] = [
    ["private key", /0x[0-9a-fA-F]{64}\b/],
    ["PEM block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ["JWT", /eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/],
    ["Anthropic key", /sk-ant-[\w-]{8,}/],
  ];
  for (const [file, text] of Object.entries(infraFiles)) {
    for (const [what, re] of SHAPES) if (re.test(text)) v.push(`rule 8: ${what} in ${file}`);
  }
  for (const a of apps(main)) {
    for (const c of containersOf(a)) {
      for (const e of c.env ?? []) {
        if (/PRIVATE_KEY|SECRET|TOKEN|MNEMONIC|CARD_VAULT_KEY/.test(e.name) && e.value !== undefined) v.push(`rule 8: ${label(a)}/${c.name} ${e.name} is a literal`);
      }
    }
  }

  // Rule 9: L2 allows exactly the seller host (never the alias) and a payee; the regression job targets the alias.
  const l2Env = l2 ? (containersOf(l2).find((c) => c.name === "l2")?.env ?? []) : [];
  const hosts = resolved(l2Env.find((e) => e.name === "ALLOWED_HOSTS")?.value ?? "", l2?.vars ?? {}, devParams.main!);
  if (JSON.stringify(hosts) !== JSON.stringify([`${MN.apps.seller}.*`])) v.push("rule 9: ALLOWED_HOSTS must be the seller's FQDN, not the alias");
  if (!l2Env.find((e) => e.name === "ALLOWED_PAYEES")?.value) v.push("rule 9: ALLOWED_PAYEES is not set");
  const regression = byName(MN.jobs.l1);
  if (regression) {
    const alias = resolved(containersOf(regression)[0]?.env?.find((e) => e.name === "SELLER_ALIAS_URL")?.value ?? "", regression.vars, devParams.main!);
    if (JSON.stringify(alias) !== JSON.stringify([`https://${MN.apps.sellerAlias}.*`])) v.push("rule 9: the regression job's SELLER_ALIAS_URL is not the alias seller");
    if (secretsOf(regression).some((s) => JSON.stringify(vaultKeysOf(regression, s.keyVaultUrl)) !== '["l1"]')) v.push("rule 9: the regression job reads a vault other than l1");
    if (JSON.stringify(containersOf(regression)).includes("OPERATOR_TOKEN")) v.push("rule 9: the regression job holds the operator token");
  } else {
    v.push(`rule 9: the regression job ${MN.jobs.l1} is missing`);
  }
  const sellerNames = main.filter((r) => r.module === "sellers" && r.type === "Microsoft.App/containerApps").flatMap(namesOf).sort();
  if (JSON.stringify(sellerNames) !== JSON.stringify([MN.apps.seller, MN.apps.sellerAlias].sort())) v.push("rule 9: the alias seller is not deployed beside the seller");

  // Rule 10: every vault denies by default and allows only its unit's subnet, plus an operator's IP only while the
  // vaults are seeded (seedIp, which only deploy.yml sets).
  const vault = main.find((r) => r.module === "vault" && r.type === "Microsoft.KeyVault/vaults");
  const acls = (vault?.properties.networkAcls ?? {}) as Json;
  const vnetRules = (acls.virtualNetworkRules ?? []) as { id: string }[];
  if (acls.defaultAction !== "Deny") v.push("rule 10: vault firewall default is not Deny");
  if (vnetRules.length !== 1 || vnetRules[0]!.id !== "[resourceId('Microsoft.Network/virtualNetworks/subnets', parameters('names').network, parameters('names').subnets[parameters('subnet')])]") {
    v.push("rule 10: vault firewall must allow only its unit's subnet");
  }
  if (acls.ipRules !== "[if(empty(parameters('seedIp')), createArray(), createArray(createObject('value', parameters('seedIp'))))]") v.push("rule 10: vault IP rules must come only from seedIp");
  if (vault?.properties.enablePurgeProtection !== true || vault.properties.createMode !== "[if(parameters('recover'), 'recover', 'default')]" || deploymentParam(main, "vault", "recover") !== JSON.stringify({ value: "[parameters('recoverVaults')]" })) {
    v.push("rule 10: vaults must keep purge protection, and be recovered only through recoverVaults");
  }
  for (const u of units) if (u.subnet !== (u.key === "seller" ? "seller" : "x402")) v.push(`rule 10: unit ${u.key} on subnet ${u.subnet}`);

  // Rule 11: the agent's AUTH_AUDIENCE is the API app's client ID, a required 36-character parameter. Entra
  // v2.0 tokens carry it as `aud`; a default such as the api:// URI would refuse every real token.
  const audience = ((arms.main.parameters as Json)?.authAudience ?? {}) as Json;
  if ("defaultValue" in audience || audience.minLength !== 36 || audience.maxLength !== 36) {
    v.push("rule 11: authAudience must be a required 36-character parameter (the API app's client ID)");
  }
  const agentEnv = apps(main).filter((r) => namesOf(r).includes(MN.apps.l1)).flatMap((r) => containersOf(r).flatMap((c) => c.env ?? []));
  if (agentEnv.find((e) => e.name === "AUTH_AUDIENCE")?.value !== "[parameters('authAudience')]" || deploymentParam(main, "l1-apps", "authAudience") !== JSON.stringify({ value: "[parameters('authAudience')]" })) {
    v.push("rule 11: the agent's AUTH_AUDIENCE must come from the authAudience parameter");
  }

  // Rule 12: each app and job runs from its own unit's image, x402-<unit>:<imageTag> in the platform's registry,
  // and that image contains the entry point its command runs. The proxy sidecars run the pinned nginx.
  for (const [unit, u] of Object.entries(UNITS) as [ImageName, (typeof UNITS)[ImageName]][]) {
    const image = deploymentParam(main, u.apps, "image");
    if (!image.includes(`/x402-${unit}:{1}'`) || !image.includes("variables('acrServer')") || !image.includes("parameters('imageTag')")) {
      v.push(`rule 12: ${u.apps}'s image is not x402-${unit}:<imageTag> from the platform's registry`);
    }
    for (const a of apps(main).filter((r) => r.module === u.apps)) {
      const name = label(a);
      for (const c of containersOf(a)) {
        const entry = c.command?.[1]?.replace(/^dist\//, "").replace(/\.js$/, ".ts");
        if (c.image === "[parameters('proxyImage')]") continue;
        if (c.image !== "[parameters('image')]") v.push(`rule 12: ${name}/${c.name} doesn't run its unit's image`);
        else if (namesOf(a).some((n) => APP_UNIT[n] !== unit)) v.push(`rule 12: ${name}/${c.name} runs the ${unit} image, not its own unit's`);
        else if (entry === undefined || !IMAGES[unit].entries.includes(entry)) v.push(`rule 12: ${name}/${c.name} runs ${c.command?.[1]}, which the ${unit} image doesn't contain`);
      }
    }
  }
  const operatorJob = byName(MN.jobs.l2);
  if (JSON.stringify(operatorJob ? containersOf(operatorJob)[0]?.command : null) !== JSON.stringify(["node", "dist/scripts/ledger-verify.js"])) {
    v.push("rule 12: the operator job's own command must be ledger-verify: deploy.yml starts it without an override");
  }
  const proxyPin = String((arms.main.variables as Json)?.proxyImage ?? "");
  for (const module of ["l2-apps", "l3-apps"]) {
    if (deploymentParam(main, module, "proxyImage") !== JSON.stringify({ value: "[variables('proxyImage')]" }) || !/@sha256:[0-9a-f]{64}$/.test(proxyPin)) {
      v.push(`rule 12: ${module}'s proxy image is not the pinned nginx`);
    }
  }

  // Rule 13: each unit's apps look up only their own identities and vaults, and are deployed after the platform.
  for (const u of Object.values(UNITS)) {
    const text = JSON.stringify(deployment(main, u.apps)?.properties.template ?? {});
    const used = (re: RegExp) => [...new Set([...text.matchAll(re)].map((m) => m[1]!))].sort();
    const ids = used(/parameters\('names'\)\.identities\.(\w+)/g);
    const vaults = used(/parameters\('names'\)\.vaults\.(\w+)/g);
    if (JSON.stringify(ids) !== JSON.stringify([...u.identities].sort())) v.push(`rule 13: ${u.apps} looks up identities ${ids.join(",")}, not its own (${u.identities.join(",")})`);
    if (JSON.stringify(vaults) !== JSON.stringify([...u.vaults].sort())) v.push(`rule 13: ${u.apps} looks up vaults ${vaults.join(",")}, not its own (${u.vaults.join(",")})`);
    const after = JSON.stringify(deployment(main, u.apps)?.raw.dependsOn ?? []);
    for (const platform of ["identities", "registry", "vaults", "environments"]) {
      if (!after.includes(`'${platform}'`) && !after.includes(`"${platform}"`)) v.push(`rule 13: ${u.apps} doesn't wait for the platform's ${platform}`);
    }
  }

  // Rule 14: the model is keyless. Foundry refuses API keys, no container gets an Anthropic key, and the agent
  // reaches the Claude deployment with its own managed identity (id-l1) at the platform's Foundry endpoint.
  const ais = main.find((r) => r.module === "foundry" && r.type === "Microsoft.CognitiveServices/accounts");
  if (ais?.properties.disableLocalAuth !== true) v.push("rule 14: Foundry accepts API keys (disableLocalAuth must be true)");
  for (const a of apps(main)) {
    for (const c of containersOf(a)) if ((c.env ?? []).some((e) => e.name === "ANTHROPIC_API_KEY")) v.push(`rule 14: ANTHROPIC_API_KEY in ${label(a)}/${c.name}`);
    for (const s of secretsOf(a)) if (/anthropic/i.test(s.name)) v.push(`rule 14: ${label(a)} has an Anthropic secret (${s.name})`);
  }
  const agentVars = Object.fromEntries(agentEnv.map((e) => [e.name, e.value]));
  if (agentVars.MODEL_PROVIDER !== "foundry") v.push("rule 14: the agent's MODEL_PROVIDER must be foundry");
  if (!String(agentVars.AZURE_CLIENT_ID).includes("parameters('names').identities.l1)") || !String(agentVars.AZURE_CLIENT_ID).endsWith(".clientId]")) v.push("rule 14: the agent must sign in to Foundry as id-l1");
  if (!String(agentVars.FOUNDRY_BASE_URL).includes("parameters('names').foundry)") || !String(agentVars.FOUNDRY_BASE_URL).includes("/anthropic/v1")) {
    v.push("rule 14: the agent's FOUNDRY_BASE_URL is not the platform's Foundry endpoint");
  }
  const model = main.find((r) => r.module === "foundry" && r.type === "Microsoft.CognitiveServices/accounts/deployments");
  const modelProps = (model?.properties ?? {}) as { model?: Json; modelProviderData?: Json };
  if (
    deploymentParam(main, "foundry", "modelName") !== JSON.stringify({ value: "[variables('modelDeployment')]" }) ||
    deploymentParam(main, "l1-apps", "modelDeployment") !== JSON.stringify({ value: "[variables('modelDeployment')]" }) ||
    agentVars.ANTHROPIC_MODEL !== "[parameters('modelDeployment')]" ||
    modelProps.model?.format !== "Anthropic" ||
    (model?.raw.sku as Json | undefined)?.name !== "GlobalStandard"
  ) {
    v.push("rule 14: the agent's ANTHROPIC_MODEL must be the Foundry Claude deployment (Anthropic, Global Standard)");
  }
  if (JSON.stringify(Object.keys(modelProps.modelProviderData ?? {}).sort()) !== JSON.stringify(["countryCode", "industry", "organizationName"])) {
    v.push("rule 14: the Claude deployment must declare its organization, country and industry (modelProviderData)");
  }

  // Rule 15: every name is in the parameter files' `names`, and is the standard {type}-{app}-{location}-{environment}
  // for its place there (the registry's and storage's without hyphens), within Azure's rules for its type. The
  // templates name nothing themselves: each resource's name is one of `names`, each of `names` is deployed, every
  // module gets `names` whole, and no template builds a string from the location or writes a name out.
  for (const [file, p] of Object.entries(params)) {
    const env = /^[a-z-]+\.([a-z0-9]+)\.bicepparam$/.exec(file)?.[1];
    for (const [path, name] of leaves(p.names, ["names"])) {
      const [, group, key, ...rest] = path.split(".");
      const std = STANDARD[group!];
      const app = std?.app ?? (key ?? "").replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      if (!std || (std.app === undefined) !== (key !== undefined) || rest.length > 0 || !APPS.includes(app)) {
        v.push(`rule 15: ${file}'s ${path} is not a standard name`);
        continue;
      }
      const want = [std.type, app, p.location, env].join(std.compact ? "" : "-");
      if (name !== want) v.push(`rule 15: ${file}'s ${path} is ${name}, not the standard ${want}`);
      const [min, max, re] = std.limits;
      if (name.length < min || name.length > max || !re.test(name)) v.push(`rule 15: ${file}'s ${path} ${name} breaks Azure's rule for its type (${min}-${max} characters, ${re})`);
    }
  }
  const declared = new Map<string, string>([...leaves(MN, ["names"]), ...leaves(PN, ["names"])].map(([k, n]) => [n, k]));
  const deployed = new Set<string>();
  const fromNames = (expr: unknown) => String(expr).startsWith("[parameters('names').");
  for (const r of all.filter((x) => NAMED_TYPES.includes(x.type))) {
    for (const name of namesOf(r)) {
      if (!fromNames(nameExpr(r)) || !declared.has(name)) v.push(`rule 15: ${r.type} ${name} in ${r.module} isn't named from the names parameter`);
      deployed.add(name);
    }
    if (r.type === "Microsoft.Network/virtualNetworks") {
      for (const sn of (r.properties.subnets ?? []) as { name: string }[]) {
        for (const name of resolved(sn.name, r.vars, devParams[r.root]!)) {
          if (!fromNames(sn.name) || !declared.has(name)) v.push(`rule 15: subnet ${name} isn't named from the names parameter`);
          deployed.add(name);
        }
      }
    }
  }
  for (const [name, path] of declared) if (!deployed.has(name)) v.push(`rule 15: ${path} ${name} is in the parameter file but not deployed`);
  for (const d of main.filter((r) => r.type === "Microsoft.Resources/deployments")) {
    const passed = ((d.properties.parameters ?? {}) as Json).names;
    if (passed !== undefined && JSON.stringify(passed) !== JSON.stringify({ value: "[parameters('names')]" })) v.push(`rule 15: the ${moduleName(d.name)} module doesn't get the names parameter whole`);
  }
  for (const name of TEMPLATES) {
    // JSON escapes nothing in these expressions but the quotes of strings, which hold no format() call.
    const text = JSON.stringify(arms[name]);
    for (const call of formatCalls(text).filter((c) => c.includes("parameters('location')"))) {
      for (const built of resolveArm(call, {}, devParams[name]!)) v.push(`rule 15: ${name} builds ${built} from the location: every name comes from the names parameter`);
    }
    for (const [n, path] of declared) if (text.includes(n)) v.push(`rule 15: ${name} writes out ${n}: use ${path}`);
  }

  // Rule 16: the Entra objects (pre-deploy.bicep). The API app takes v2.0 tokens for its standard URI, has one
  // role (Agent.Run, assignment required) and two admin scopes, each with one pre-authorized client: the Azure CLI
  // for user_impersonation (the agent), and 013's portal web app for Portal.Access. Its access tokens carry the
  // optional claims auth_time, and idtyp for user tokens too. The web app is a public single-page client: no secret,
  // no certificate, no role, no API, no permissions of its own, and only its own /redirect.html as redirect URIs.
  // The deploy app has no API, no permissions and no secret: GitHub signs in as it through one federated
  // credential, for the repository's deploy environment. Agent.Run goes to the deploy app and agentUsers only. The deploy app's roles are
  // Contributor and Role Based Access Control Administrator on the resource group only, the latter limited by
  // condition to exactly the roles main.bicep assigns.
  const graph = (type: string) => pre.filter((r) => r.type === `Microsoft.Graph/${type}@v1.0`);
  const entraApps = graph("applications");
  const appNamed = (n: string | undefined) => entraApps.find((r) => namesOf(r).includes(n ?? ""));
  const apiApp = appNamed(PN.apiApp);
  const deployApp = appNamed(PN.deployApp);
  const portalApp = appNamed(PN.portalApp);
  const api = (apiApp?.properties.api ?? {}) as Json;
  const appRoles = (apiApp?.properties.appRoles ?? []) as Json[];
  const scopes = (api.oauth2PermissionScopes ?? []) as Json[];
  if (api.requestedAccessTokenVersion !== 2) v.push("rule 16: the API app must receive v2.0 access tokens");
  if (JSON.stringify(((apiApp?.properties.identifierUris ?? []) as string[]).flatMap((u) => resolved(u, apiApp!.vars, devParams["pre-deploy"]!))) !== JSON.stringify([`api://${PN.apiApp}`])) {
    v.push(`rule 16: the API app's identifier URI must be api://${PN.apiApp}`);
  }
  if (appRoles.length !== 1 || appRoles[0]!.value !== "Agent.Run" || !withVars(appRoles[0]!.id, apiApp!.vars).includes(AGENT_RUN) || JSON.stringify(appRoles[0]!.allowedMemberTypes) !== '["User","Application"]') {
    v.push("rule 16: the API app's only role must be Agent.Run, for users and applications");
  }
  const scopeIds = Object.fromEntries(scopes.map((s) => [String(s.value), s.type === "Admin" ? (withVars(s.id, apiApp?.vars ?? {}).match(GUID) ?? []).join() : "not admin consent only"]));
  if (scopes.length !== 2 || JSON.stringify(Object.entries(scopeIds).sort()) !== JSON.stringify([["Portal.Access", PORTAL_ACCESS], ["user_impersonation", USER_IMPERSONATION]])) {
    v.push("rule 16: the API app's scopes must be user_impersonation and Portal.Access, each admin consent only, with its fixed ID");
  }
  // Each pre-authorized client with the scope IDs it gets: the Azure CLI by its well-known ID, the web app by reference.
  const preAuthorized = ((api.preAuthorizedApplications ?? []) as { appId?: unknown; delegatedPermissionIds?: unknown[] }[]).map((a) => {
    const client = withVars(a.appId, apiApp?.vars ?? {});
    return [client.match(GUID)?.join() ?? client, (a.delegatedPermissionIds ?? []).flatMap((id) => withVars(id, apiApp?.vars ?? {}).match(GUID) ?? [String(id)]).join()];
  });
  if (JSON.stringify(preAuthorized.sort()) !== JSON.stringify([[AZURE_CLI, USER_IMPERSONATION], ["[reference('portalApp').appId]", PORTAL_ACCESS]].sort())) {
    v.push("rule 16: only the Azure CLI (for user_impersonation only) and the portal web app (for Portal.Access only) may be pre-authorized");
  }
  const claims = (((apiApp?.properties.optionalClaims ?? {}) as Json).accessToken ?? []) as { name?: string; additionalProperties?: string[] }[];
  const otherTokens = Object.keys((apiApp?.properties.optionalClaims ?? {}) as Json).filter((k) => k !== "accessToken");
  if (
    otherTokens.length > 0 ||
    JSON.stringify(claims.map((c) => [c.name, c.additionalProperties ?? []]).sort()) !== JSON.stringify([["auth_time", []], ["idtyp", ["include_user_token"]]])
  ) {
    v.push("rule 16: the API app's access tokens must carry the optional claims auth_time, and idtyp with include_user_token, and no other");
  }
  if (!portalApp) v.push(`rule 16: the portal web app ${PN.portalApp} is missing`);
  else {
    for (const k of ["api", "appRoles", "identifierUris", "requiredResourceAccess", "web", "publicClient", "isFallbackPublicClient"]) if (k in portalApp.properties) v.push(`rule 16: the portal web app must have no ${k}`);
    const redirects = String(((portalApp.properties.spa ?? {}) as Json).redirectUris ?? "");
    const literals = [...redirects.matchAll(/'([a-z]+:\/\/[^']*)'/g)].map((m) => m[1]);
    if (JSON.stringify(literals) !== JSON.stringify([LOCAL_REDIRECT]) || !redirects.includes("if(empty(parameters('portalOrigin')), createArray(), createArray(format('{0}/redirect.html', parameters('portalOrigin'))))")) {
      v.push(`rule 16: the portal web app's redirect URIs must be ${LOCAL_REDIRECT}, and portalOrigin's /redirect.html once it is set (a single-page app: spa.redirectUris)`);
    }
  }
  if (!JSON.stringify(((arms["pre-deploy"].outputs ?? {}) as Json).mainParameters ?? "").includes("reference('portalApp').appId")) {
    v.push("rule 16: pre-deploy's mainParameters output must give the portal web app's client ID (userAccounts.portalClientId)");
  }
  for (const a of entraApps) {
    for (const k of ["passwordCredentials", "keyCredentials"]) if (k in a.properties) v.push(`rule 16: ${label(a)} has ${k}`);
    if (a.properties.signInAudience !== "AzureADMyOrg") v.push(`rule 16: ${label(a)} must be single-tenant`);
  }
  for (const k of ["api", "appRoles", "identifierUris", "requiredResourceAccess"]) if (deployApp && k in deployApp.properties) v.push(`rule 16: the deploy app must have no ${k}`);
  const apiSp = graph("servicePrincipals").find((r) => String(r.properties.appId).includes("reference('apiApp')"));
  if (apiSp?.properties.appRoleAssignmentRequired !== true) v.push("rule 16: the API app's service principal must require assignment");
  const fics = graph("applications/federatedIdentityCredentials");
  const fic = fics[0]?.properties ?? {};
  if (
    fics.length !== 1 ||
    !String(fic.name).includes("reference('deployApp')") ||
    fic.issuer !== "https://token.actions.githubusercontent.com" ||
    JSON.stringify(fic.audiences) !== '["api://AzureADTokenExchange"]' ||
    (fic.subject === "[variables('githubSubject')]" ? fics[0]!.vars.githubSubject : fic.subject) !==
      "[format('repo:{0}@{1}/{2}@{3}:environment:{4}', split(parameters('githubRepository'), '/')[0], parameters('githubOwnerId'), split(parameters('githubRepository'), '/')[1], parameters('githubRepositoryId'), parameters('githubEnvironment'))]"
  ) {
    v.push(`rule 16: the deploy app's one federated credential must trust only ${IMMUTABLE_SUBJECT}`);
  }
  const assigned = graph("appRoleAssignedTo");
  const principals = assigned.map((r) => String(r.properties.principalId)).sort();
  if (
    assigned.some((r) => !withVars(r.properties.appRoleId, r.vars).includes(AGENT_RUN) || r.properties.resourceId !== "[reference('apiSp').id]") ||
    JSON.stringify(principals) !== JSON.stringify(["[reference('deploySp').id]", "[reference(format('agentUser[{0}]', copyIndex())).id]"].sort())
  ) {
    v.push("rule 16: Agent.Run must go to the deploy app and agentUsers only");
  }
  const group = graph("groups")[0]?.properties ?? {};
  if (group.securityEnabled !== true || group.mailEnabled !== false || !JSON.stringify(group.members ?? {}).includes("operatorUser")) {
    v.push("rule 16: the operators' group must be a security group of the operators");
  }
  const access = pre.filter((r) => r.type === "Microsoft.Authorization/roleAssignments");
  const contributor = access.find((r) => roleOf(r).includes(CONTRIBUTOR));
  const administrator = access.find((r) => roleOf(r).includes(RBAC_ADMINISTRATOR));
  const mainRoles = [...new Set(main.filter((r) => r.type === "Microsoft.Authorization/roleAssignments").flatMap((r) => roleOf(r).match(GUID) ?? []))].sort();
  const allowed = [...new Set(withVars(administrator?.properties.condition ?? "", administrator?.vars ?? {}).match(GUID) ?? [])].sort();
  if (access.length !== 2 || !contributor || contributor.properties.condition !== undefined || deployment(pre, "deploy-access")?.raw.resourceGroup !== "[parameters('names').resourceGroup]") {
    v.push("rule 16: the deploy app's roles must be Contributor and Role Based Access Control Administrator, on its resource group only");
  }
  if (!administrator || administrator.properties.conditionVersion !== "2.0" || JSON.stringify(allowed) !== JSON.stringify(mainRoles)) {
    v.push(`rule 16: the deploy app's Role Based Access Control Administrator must be limited to main.bicep's roles (${mainRoles.join(", ")})`);
  }
  if (deploymentParam(pre, "deploy-access", "principalId") !== JSON.stringify({ value: "[reference('deploySp').id]" })) v.push("rule 16: the deploy app's roles must go to its service principal");

  // Rule 17: every value a deployment uses is in its parameter file, the target and the names included. Each
  // template parameter is set there; only deploy.yml's five per-run values come from the environment. Both files of
  // an environment name the same tenant, subscription, location and resource group, the GitHub environment is the
  // deploy environment, and each template refuses to run anywhere else.
  for (const tpl of TEMPLATES) {
    const declaredParams = Object.keys((arms[tpl].parameters ?? {}) as Json);
    const target = String(((arms[tpl].variables ?? {}) as Json).target ?? "");
    const checks = tpl === "main" ? ["tenant().tenantId", "subscription().subscriptionId", "resourceGroup().name"] : ["tenant().tenantId", "subscription().subscriptionId"];
    if (!target.includes("fail(") || checks.some((c) => !target.includes(`equals(${c}, parameters('`))) {
      v.push(`rule 17: ${tpl} must refuse to run outside its parameter file's ${tpl === "main" ? "tenant, subscription and resource group" : "tenant and subscription"}`);
    }
    for (const file of Object.keys(infraFiles).filter((f) => f.endsWith(".bicepparam") && f.slice(f.lastIndexOf("/") + 1).startsWith(`${tpl}.`))) {
      const rel = file.slice(file.lastIndexOf("/") + 1);
      const lines = paramLines(infraFiles[file]!);
      for (const p of declaredParams) if (!lines.has(p)) v.push(`rule 17: ${rel} doesn't set ${p}`);
      for (const line of infraFiles[file]!.split("\n").filter((l) => l.includes("readEnvironmentVariable") && !l.trim().startsWith("//"))) {
        const p = /^param (\w+) = /.exec(line)?.[1];
        if (!p || !PER_RUN.includes(p)) v.push(`rule 17: ${rel} reads ${p ?? line.trim()} from the environment; only ${PER_RUN.join(", ")} may be`);
      }
    }
  }
  for (const file of Object.keys(params).filter((f) => /^pre-deploy\.[a-z0-9]+\.bicepparam$/.test(f))) {
    const env = /^pre-deploy\.([a-z0-9]+)\.bicepparam$/.exec(file)![1]!;
    const pre = params[file]!;
    const mainParams = params[`main.${env}.bicepparam`] ?? {};
    for (const p of TARGET) if (at(pre, p) === undefined || at(pre, p) !== at(mainParams, p)) v.push(`rule 17: pre-deploy.${env}.bicepparam and main.${env}.bicepparam name different ${p}s (${at(pre, p)}, ${at(mainParams, p)})`);
    if (pre.githubEnvironment !== env) v.push(`rule 17: pre-deploy.${env}.bicepparam's githubEnvironment ${pre.githubEnvironment} is not ${env}, the environment deploy.yml's job runs in`);
    for (const p of ["githubOwnerId", "githubRepositoryId"]) if (!/^[1-9][0-9]*$/.test(String(pre[p]))) v.push(`rule 17: pre-deploy.${env}.bicepparam's ${p} ${pre[p]} is not a numeric GitHub ID`);
  }

  // Rule 19 (012, SPEC L2-7, FR-003, FR-030): L2's Auth0 client credential reaches only L2's control app (container
  // l2), as a reference to the l2 vault's ciba-client-credential, named CIBA_CLIENT_KEY or CIBA_CLIENT_SECRET by
  // ciba.credential. Every other CIBA_* value comes from the ciba parameter, which main passes to l2-apps whole, and
  // main refuses (fail()) an enabled ciba it can't use. No other app, job or container sees anything of it.
  const CIBA_SECRET = "ciba-client-credential";
  for (const a of apps(main)) {
    const isL2 = namesOf(a).includes(MN.apps.l2);
    for (const s of secretsOf(a)) if (s.name === CIBA_SECRET && !isL2) v.push(`rule 19: ${label(a)} has the CIBA credential`);
    for (const c of containersOf(a)) {
      for (const e of c.env ?? []) {
        if ((e.name.includes("CIBA_") || e.secretRef === CIBA_SECRET) && (!isL2 || c.name !== "l2")) v.push(`rule 19: ${e.name} in ${label(a)}/${c.name}`);
      }
    }
  }
  if (l2) {
    const env = containersOf(l2).find((c) => c.name === "l2")?.env ?? [];
    const cred = env.find((e) => e.secretRef === CIBA_SECRET);
    const secret = secretsOf(l2).find((x) => x.name === CIBA_SECRET);
    if (!cred || !secret) v.push(`rule 19: ${MN.apps.l2}/l2 doesn't reference ${CIBA_SECRET}`);
    else {
      if (cred.name !== "[if(equals(parameters('ciba').credential, 'secret'), 'CIBA_CLIENT_SECRET', 'CIBA_CLIENT_KEY')]") v.push("rule 19: the CIBA credential must be CIBA_CLIENT_KEY or CIBA_CLIENT_SECRET, chosen by ciba.credential");
      if (secret.value !== undefined || JSON.stringify(vaultKeysOf(l2, secret.keyVaultUrl)) !== '["l2"]') v.push("rule 19: the CIBA credential is not a reference to the l2 vault");
    }
    const FROM_PARAM: Record<string, string> = {
      CIBA_APPROVAL: "[if(parameters('ciba').enabled, '1', '0')]",
      CIBA_ISSUER: "[parameters('ciba').issuer]",
      CIBA_CLIENT_ID: "[parameters('ciba').clientId]",
      CIBA_AUDIENCE: "[parameters('ciba').audience]",
      CIBA_APPROVER: "[parameters('ciba').approver]",
      CIBA_CLIENT_KEY_ID: "[parameters('ciba').clientKeyId]",
    };
    for (const [name, want] of Object.entries(FROM_PARAM)) {
      const got = env.find((e) => e.name === name);
      if (got?.value !== want || got.secretRef !== undefined) v.push(`rule 19: ${name} must come from the ciba parameter`);
    }
  }
  if (deploymentParam(main, "l2-apps", "ciba") !== JSON.stringify({ value: "[parameters('ciba')]" })) v.push("rule 19: main must pass the ciba parameter to l2-apps whole");
  const cibaChecked = String(((arms.main.variables ?? {}) as Json).cibaChecked ?? "");
  for (const part of ["fail(", "startsWith(parameters('ciba').issuer, 'https://')", "contains(createArray('key', 'secret'), parameters('ciba').credential)", "parameters('ciba').clientId", "parameters('ciba').audience", "parameters('ciba').approver"]) {
    if (!cibaChecked.includes(part)) {
      v.push("rule 19: main must refuse (fail()) a ciba with another credential kind, or enabled without an https:// issuer, a clientId, an audience and an approver");
      break;
    }
  }

  // Rule 20 (013, SPEC L2-8; specs/013 contracts/config-and-secrets.md): user accounts. L2's control app (container
  // l2) always references the l2 vault's portal-token and user-wallet-mnemonic, so every environment seeds them (the
  // placeholder off while userAccounts.enabled is false); USER_ACCOUNTS comes from userAccounts, and PLATFORM_SELLERS
  // is one seller: the host L2 allows (ALLOWED_HOSTS' own expression, never the alias), userAccounts.sellerName and
  // sellerPayTo. The portal reads only its own vault, always both of its secrets; it gets no payment key and no token
  // but PORTAL_TOKEN, which only it and L2 hold, and the card vault key, which only it holds. Its other values come
  // from parameters, it calls L2 only, and nothing in infra/ turns API docs on. main passes userAccounts whole to
  // the three modules that read it, and refuses (fail()) one it can't use.
  const UA = "parameters('userAccounts')";
  const L2_USER_SECRETS: Record<string, string> = { PORTAL_TOKEN: "portal-token", USER_WALLET_MNEMONIC: "user-wallet-mnemonic" };
  const PORTAL_SECRETS: Record<string, string> = { PORTAL_TOKEN: "portal-token", CARD_VAULT_KEY: "card-vault-key" };
  /** Each env name's secret is referenced, from the app's own vault, in arrays no flag can empty. */
  const alwaysReferenced = (a: Res, container: string, want: Record<string, string>, vaultKey: string): boolean => {
    const env = containersOf(a).find((c) => c.name === container)?.env;
    if (!Array.isArray(configOf(a).secrets) || !Array.isArray(env)) return false;
    return Object.entries(want).every(([name, secret]) => {
      const s = secretsOf(a).find((x) => x.name === secret);
      const e = env.find((x) => x.name === name);
      return s !== undefined && s.value === undefined && JSON.stringify(vaultKeysOf(a, s.keyVaultUrl)) === `["${vaultKey}"]` && String(s.keyVaultUrl).includes(`secrets/${secret}`) && e?.secretRef === secret && e.value === undefined;
    });
  };
  if (l2) {
    if (!alwaysReferenced(l2, "l2", L2_USER_SECRETS, "l2")) v.push(`rule 20: ${MN.apps.l2}/l2 must always reference the l2 vault's ${Object.values(L2_USER_SECRETS).join(" and ")}, as ${Object.keys(L2_USER_SECRETS).join(" and ")}`);
    if (l2Env.find((e) => e.name === "USER_ACCOUNTS")?.value !== `[if(${UA}.enabled, '1', '0')]`) v.push("rule 20: USER_ACCOUNTS must come from the userAccounts parameter");
    const sellers = String(l2Env.find((e) => e.name === "PLATFORM_SELLERS")?.value ?? "");
    const host = String(l2Env.find((e) => e.name === "ALLOWED_HOSTS")?.value ?? "[]").slice(1, -1);
    if (
      !sellers.startsWith("[string(createArray(createObject(") ||
      sellers.split("createObject(").length !== 2 ||
      !sellers.includes(`'host', ${host}`) ||
      !sellers.includes(`'name', ${UA}.sellerName`) ||
      !sellers.includes("'payees', createArray(parameters('sellerPayTo'))") ||
      sellers.includes("sellerAlias")
    ) {
      v.push("rule 20: PLATFORM_SELLERS must be one seller: ALLOWED_HOSTS' own host, userAccounts.sellerName and sellerPayTo");
    }
  }
  for (const a of apps(main)) {
    const isL2 = namesOf(a).includes(MN.apps.l2);
    const isPortal = namesOf(a).includes(MN.apps.portal);
    for (const s of secretsOf(a)) {
      if (s.name === "user-wallet-mnemonic" && !isL2) v.push(`rule 20: ${label(a)} has the user wallet mnemonic`);
      if (s.name === "portal-token" && !isL2 && !isPortal) v.push(`rule 20: ${label(a)} has the portal token`);
      if (s.name === "card-vault-key" && !isPortal) v.push(`rule 20: ${label(a)} has the card vault key`);
      if (isPortal && JSON.stringify(vaultKeysOf(a, s.keyVaultUrl)) !== '["portal"]') v.push(`rule 20: ${label(a)} reads ${s.name} from a vault other than the portal's`);
    }
    for (const c of containersOf(a)) {
      for (const e of c.env ?? []) {
        if (e.name === "API_DOCS") v.push(`rule 20: API_DOCS in ${label(a)}/${c.name}: the API docs are never served in Azure`);
        if ((e.name === "PORTAL_TOKEN" || e.secretRef === "portal-token") && !((isL2 && c.name === "l2") || isPortal)) v.push(`rule 20: ${e.name} in ${label(a)}/${c.name}`);
        if ((/^CARD_VAULT/.test(e.name) || e.secretRef === "card-vault-key") && !isPortal) v.push(`rule 20: ${e.name} in ${label(a)}/${c.name}`);
        if (/^(USER_ACCOUNTS|PLATFORM_SELLERS|PLATFORM_FILE)$/.test(e.name) && !(isL2 && c.name === "l2")) v.push(`rule 20: ${e.name} in ${label(a)}/${c.name}`);
        if (isPortal && (PAYMENT_KEYS.includes(e.name) || (/TOKEN/.test(e.name) && e.name !== "PORTAL_TOKEN"))) v.push(`rule 20: ${e.name} in ${label(a)}/${c.name}`);
      }
    }
  }
  if (portal) {
    if (!alwaysReferenced(portal, "portal", PORTAL_SECRETS, "portal") || secretsOf(portal).length !== Object.keys(PORTAL_SECRETS).length) {
      v.push(`rule 20: ${MN.apps.portal}/portal must always reference the portal vault's ${Object.values(PORTAL_SECRETS).join(" and ")}, as ${Object.keys(PORTAL_SECRETS).join(" and ")}, and hold no other secret`);
    }
    const env = containersOf(portal).find((c) => c.name === "portal")?.env ?? [];
    const FROM_PARAM: Record<string, string> = {
      AUTH_TENANT_ID: "[parameters('authTenantId')]",
      AUTH_AUDIENCE: "[parameters('authAudience')]",
      PORTAL_CLIENT_ID: `[${UA}.portalClientId]`,
      CARD_VAULT: `[if(equals(${UA}.cardVault, 'stripe'), 'stripe', '')]`,
      CARD_VAULT_PUBLISHABLE_KEY: `[${UA}.cardVaultPublishableKey]`,
    };
    for (const [name, want] of Object.entries(FROM_PARAM)) {
      const got = env.find((e) => e.name === name);
      if (got?.value !== want || got.secretRef !== undefined) v.push(`rule 20: the portal's ${name} must come from its parameter`);
    }
    for (const [param, from] of [["authTenantId", "tenantId"], ["authAudience", "authAudience"]]) {
      if (deploymentParam(main, "portal-apps", param!) !== JSON.stringify({ value: `[parameters('${from}')]` })) v.push(`rule 20: main must pass ${from} to portal-apps as ${param}`);
    }
    const control = resolved(env.find((e) => e.name === "CONTROL_URL")?.value ?? "", portal.vars, devParams.main!);
    if (JSON.stringify(control) !== JSON.stringify([`http://${MN.apps.l2}.internal.*`])) v.push("rule 20: the portal's CONTROL_URL must be L2's internal address");
    if (env.some((e) => /^(SETTLEMENT_URL|SELLER_URL|SELLER_ALIAS_URL)$/.test(e.name))) v.push("rule 20: the portal calls L2 only");
  }
  if (agentEnv.find((e) => e.name === "PORTAL_CLIENT_ID")?.value !== `[${UA}.portalClientId]`) v.push("rule 20: the agent's PORTAL_CLIENT_ID (the azp it refuses) must come from the userAccounts parameter");
  for (const module of ["l1-apps", "l2-apps", "portal-apps"]) {
    if (deploymentParam(main, module, "userAccounts") !== JSON.stringify({ value: `[${UA}]` })) v.push(`rule 20: main must pass the userAccounts parameter to ${module} whole`);
  }
  const userAccountsChecked = String(((arms.main.variables ?? {}) as Json).userAccountsChecked ?? "");
  for (const part of ["fail(", `contains(createArray('off', 'stripe'), ${UA}.cardVault)`, `equals(length(${UA}.portalClientId), 36)`, "not(equals(parameters('unit'), 'portal'))", `startsWith(${UA}.cardVaultPublishableKey, 'pk_test_')`]) {
    if (!userAccountsChecked.includes(part)) {
      v.push("rule 20: main must refuse (fail()) a userAccounts whose cardVault is not off or stripe, that is enabled without a 36-character portalClientId, or whose cardVault is stripe without a pk_test_ publishable key");
      break;
    }
  }

  // Rule 18: each module is deployed by exactly one unit's runs: the platform's modules by the platform's
  // (deploy-infra.yml), each unit's apps by that unit's (deploy-<unit>.yml), so a pipeline changes nothing of another
  // unit's. `unit` is required and names one of them.
  const unitParam = ((arms.main.parameters as Json)?.unit ?? {}) as Json;
  if ("defaultValue" in unitParam || JSON.stringify([...((unitParam.allowedValues ?? []) as string[])].sort()) !== JSON.stringify([...DEPLOY_UNITS].sort())) {
    v.push(`rule 18: unit must be a required parameter, one of ${DEPLOY_UNITS.join(", ")}`);
  }
  if ((arms.main.variables as Json)?.platform !== "[equals(parameters('unit'), 'platform')]") v.push("rule 18: main's platform variable must be unit == 'platform'");
  const unitOf = new Map(Object.values(UNITS).map((u) => [u.apps, u.unit]));
  for (const d of main.filter((r) => r.module === "main" && r.type === "Microsoft.Resources/deployments")) {
    const m = moduleName(d.name);
    const unit = unitOf.get(m);
    const want = unit ? `[equals(parameters('unit'), '${unit}')]` : PLATFORM_MODULES.includes(m) ? "[variables('platform')]" : undefined;
    if (want === undefined) v.push(`rule 18: the ${m} module belongs to no unit`);
    else if (d.raw.condition !== want) v.push(`rule 18: the ${m} module must be deployed only by ${unit ? `unit ${unit}'s` : "the platform's"} runs`);
  }

  return v;
}

function infraSources(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[p] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

describe.skipIf(!BICEP_PATH)("T-IAC-01 Azure identity, secret, exposure and naming rules", () => {
  let bicep: Bicep;
  /** The dev environment's names and location, from the real parameter files. */
  let N: { main: MainNames; pre: PreDeployNames; location: string };
  const tmp: string[] = [];
  beforeAll(async () => {
    bicep = await Bicep.initialize(BICEP_PATH!);
    const { params } = await compile("infra");
    N = { main: params["main.dev.bicepparam"]!.names as MainNames, pre: params["pre-deploy.dev.bicepparam"]!.names as PreDeployNames, location: String(params["main.dev.bicepparam"]!.location) };
  }, 60_000);
  afterAll(() => {
    bicep?.dispose();
    for (const d of tmp) rmSync(d, { recursive: true, force: true });
  });

  /** main.bicep and pre-deploy.bicep in `infraDir`, and every parameter file there, compiled. */
  async function compile(infraDir: string): Promise<{ arms: Templates; params: Params }> {
    const arms: Partial<Templates> = {};
    for (const name of TEMPLATES) {
      const r = await bicep.compile({ path: resolve(infraDir, `${name}.bicep`) });
      const errors = r.diagnostics.filter((d) => d.level === "Error");
      expect(errors.map((d) => `${name}: ${d.code} ${d.message}`)).toEqual([]);
      expect(r.success).toBe(true);
      arms[name] = JSON.parse(r.contents!) as Json;
    }
    const params: Params = {};
    for (const file of readdirSync(infraDir).filter((f) => f.endsWith(".bicepparam"))) {
      const r = await bicep.compileParams({ path: resolve(infraDir, file), parameterOverrides: {} });
      expect(r.diagnostics.filter((d) => d.level === "Error").map((d) => `${file}: ${d.code} ${d.message}`)).toEqual([]);
      const values = (JSON.parse(r.parameters!) as { parameters: Record<string, { value: unknown }> }).parameters;
      params[file] = Object.fromEntries(Object.entries(values).map(([k, x]) => [k, x.value]));
    }
    return { arms: arms as Templates, params };
  }

  /** A copy of infra/ with one edit, compiled. */
  async function mutant(file: string, from: string, to: string): Promise<string[]> {
    const dir = mkdtempSync(join(tmpdir(), "infra-mutant-"));
    tmp.push(dir);
    cpSync("infra", dir, { recursive: true });
    const path = join(dir, file);
    const text = readFileSync(path, "utf8");
    expect(text.includes(from), `${file} contains the mutation anchor`).toBe(true);
    writeFileSync(path, text.replace(from, () => to));
    const { arms, params } = await compile(dir);
    return violations(arms, params, infraSources(dir));
  }

  it("T-IAC-01 the real templates and parameter files pass rules 1–20", async () => {
    const { arms, params } = await compile("infra");
    expect(violations(arms, params, infraSources("infra"))).toEqual([]);
  }, 60_000);

  it("T-IAC-01 must-fail rule 1: a role assignment of id-l1 outside the matrix is reported", async () => {
    const extra = `
resource idL1 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: names.identities.l1 }
resource extraRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid('kv-l2', 'id-l1')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '${KV_SECRETS_USER}')
    principalId: idL1.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
`;
    const v = await mutant("main.bicep", "// ---- The platform (", `${extra}\n// ---- The platform (`);
    expect(v.some((m) => m.startsWith("rule 1: role assignment") && m.endsWith("in main is not in the matrix"))).toBe(true);
  }, 60_000);

  it("T-IAC-01 must-fail rule 2: PAYER_PRIVATE_KEY on the agent is reported", async () => {
    const v = await mutant("modules/l1-apps.bicep", "            { name: 'CONTROL_TOKEN', secretRef: 'control-token' }\n            { name: 'VERIFIER_TOKEN'", "            { name: 'PAYER_PRIVATE_KEY', secretRef: 'control-token' }\n            { name: 'CONTROL_TOKEN', secretRef: 'control-token' }\n            { name: 'VERIFIER_TOKEN'");
    expect(v).toContain(`rule 2: PAYER_PRIVATE_KEY in ${N.main.apps.l1}/agent`);
  }, 60_000);

  it("T-IAC-01 must-fail rule 2: the user wallet mnemonic on the portal, or as a literal on L2, is reported", async () => {
    const onPortal = await mutant("modules/portal-apps.bicep", "            { name: 'PORTAL_TOKEN', secretRef: 'portal-token' }\n", "            { name: 'PORTAL_TOKEN', secretRef: 'portal-token' }\n            { name: 'USER_WALLET_MNEMONIC', secretRef: 'portal-token' }\n");
    expect(onPortal).toContain(`rule 2: USER_WALLET_MNEMONIC in ${N.main.apps.portal}/portal`);
    expect(onPortal).toContain(`rule 20: USER_WALLET_MNEMONIC in ${N.main.apps.portal}/portal`);
    const literal = await mutant("modules/l2-apps.bicep", "{ name: 'USER_WALLET_MNEMONIC', secretRef: 'user-wallet-mnemonic' }", "{ name: 'USER_WALLET_MNEMONIC', value: 'off' }");
    expect(literal).toContain("rule 2: USER_WALLET_MNEMONIC is not a secret reference");
    expect(literal).toContain(`rule 8: ${N.main.apps.l2}/l2 USER_WALLET_MNEMONIC is a literal`);
  }, 120_000);

  it("T-IAC-01 must-fail rule 2: the portal reading the l2 vault is reported", async () => {
    const v = await mutant("modules/portal-apps.bicep", "keyVaultUrl: '${vaultPortal}secrets/portal-token'", "keyVaultUrl: 'https://${names.vaults.l2}${az.environment().suffixes.keyvaultDns}/secrets/portal-token'");
    expect(v).toContain(`rule 2: ${N.main.apps.portal} reads the l2 vault`);
    expect(v).toContain("rule 13: portal-apps looks up vaults l2,portal, not its own (portal)");
    expect(v).toContain(`rule 20: ${N.main.apps.portal} reads portal-token from a vault other than the portal's`);
  }, 60_000);

  it("T-IAC-01 must-fail rule 3: external ingress on L2's control app is reported", async () => {
    const v = await mutant("modules/l2-apps.bicep", "ingress: { external: false, targetPort: 8080", "ingress: { external: true, targetPort: 8080");
    expect(v).toContain(`rule 3: ${N.main.apps.l2} has external ingress`);
  }, 60_000);

  it("T-IAC-01 must-fail rule 3: with the portal public, external ingress on L3's verifier is still reported", async () => {
    const v = await mutant("modules/l3-apps.bicep", "ingress: { external: false, targetPort: 8080", "ingress: { external: true, targetPort: 8080");
    expect(v).toContain(`rule 3: ${N.main.apps.l3} has external ingress`);
    expect(v).toContain(`rule 3: ${N.main.apps.l3} must have external: false`);
    expect(v.some((m) => m.includes(N.main.apps.portal))).toBe(false);
  }, 60_000);

  it("T-IAC-01 must-fail rule 4: the portal mounting the ledger, L2 mounting the profiles, or a third storage, is reported", async () => {
    const ledger = await mutant("main.bicep", "    profilesStorageName: 'profiles'\n", "    profilesStorageName: 'ledger'\n");
    expect(ledger).toContain(`rule 4: ${N.main.apps.portal} mounts the ledger storage, which only ${N.main.apps.l2} may`);
    expect(ledger).toContain("rule 4: the portal container must mount the NFS profiles storage at /app/.local/portal");
    const profiles = await mutant("main.bicep", "    ledgerStorageName: 'ledger'\n", "    ledgerStorageName: 'profiles'\n");
    expect(profiles).toContain(`rule 4: ${N.main.apps.l2} mounts the profiles storage, which only ${N.main.apps.portal} may`);
    const third = await mutant("modules/environments.bicep", "resource profiles 'Microsoft.App/managedEnvironments/storages@2025-01-01' = {\n  parent: main\n  name: 'profiles'", "resource profiles 'Microsoft.App/managedEnvironments/storages@2025-01-01' = {\n  parent: main\n  name: 'shared'");
    expect(third).toContain("rule 4: the environment's storages must be exactly ledger and profiles");
  }, 120_000);

  it("T-IAC-01 must-fail rule 4: a portal with two replicas, or with its profiles mounted elsewhere, is reported", async () => {
    const two = await mutant("modules/portal-apps.bicep", "scale: { minReplicas: 0, maxReplicas: 1 }", "scale: { minReplicas: 0, maxReplicas: 2 }");
    expect(two).toContain(`rule 4: ${N.main.apps.portal} must run one replica at most (its profile files have one writer)`);
    const elsewhere = await mutant("modules/portal-apps.bicep", "mountPath: '/app/.local/portal'", "mountPath: '/app/.local'");
    expect(elsewhere).toContain("rule 4: the portal container must mount the NFS profiles storage at /app/.local/portal");
  }, 120_000);

  it("T-IAC-01 must-fail rule 8: the card vault key as a literal is reported", async () => {
    const v = await mutant("modules/portal-apps.bicep", "{ name: 'CARD_VAULT_KEY', secretRef: 'card-vault-key' }", "{ name: 'CARD_VAULT_KEY', value: 'off' }");
    expect(v).toContain(`rule 8: ${N.main.apps.portal}/portal CARD_VAULT_KEY is a literal`);
    expect(v.some((m) => m.startsWith(`rule 20: ${N.main.apps.portal}/portal must always reference the portal vault's`))).toBe(true);
  }, 60_000);

  it("T-IAC-01 must-fail rule 9: ALLOWED_HOSTS pointing at the alias seller is reported", async () => {
    const v = await mutant("modules/l2-apps.bicep", "var sellerHost = '${names.apps.seller}.${sellerDomain}'", "var sellerHost = '${names.apps.sellerAlias}.${sellerDomain}'");
    expect(v).toContain("rule 9: ALLOWED_HOSTS must be the seller's FQDN, not the alias");
    expect(v).toContain("rule 20: PLATFORM_SELLERS must be one seller: ALLOWED_HOSTS' own host, userAccounts.sellerName and sellerPayTo");
  }, 60_000);

  it("T-IAC-01 must-fail rule 10: a vault firewall that allows by default is reported", async () => {
    const v = await mutant("modules/vault.bicep", "defaultAction: 'Deny'", "defaultAction: 'Allow'");
    expect(v).toContain("rule 10: vault firewall default is not Deny");
  }, 60_000);

  it("T-IAC-01 must-fail rule 11: an api:// default for the agent's audience is reported", async () => {
    const v = await mutant("main.bicep", "@minLength(36)\n@maxLength(36)\nparam authAudience string\n", "param authAudience string = 'api://x402-agent'\n");
    expect(v).toContain("rule 11: authAudience must be a required 36-character parameter (the API app's client ID)");
  }, 60_000);

  it("T-IAC-01 must-fail rule 12: L2's apps on the L1 image are reported", async () => {
    const v = await mutant("main.bicep", "image: '${acrServer}/x402-l2-control:${imageTag}'", "image: '${acrServer}/x402-l1-agent:${imageTag}'");
    expect(v).toContain("rule 12: l2-apps's image is not x402-l2-control:<imageTag> from the platform's registry");
  }, 60_000);

  it("T-IAC-01 must-fail rule 12: an operator job whose own command isn't ledger-verify, or that the operator image doesn't contain, is reported", async () => {
    const v = await mutant("modules/operator-apps.bicep", "command: ['node', 'dist/scripts/ledger-verify.js']", "command: ['node', 'dist/src/layer2-control/service.js']");
    expect(v).toContain(`rule 12: ${N.main.jobs.l2}/operator runs dist/src/layer2-control/service.js, which the operator image doesn't contain`);
    expect(v).toContain("rule 12: the operator job's own command must be ledger-verify: deploy.yml starts it without an override");
    const approve = await mutant("modules/operator-apps.bicep", "command: ['node', 'dist/scripts/ledger-verify.js']", "command: ['node', 'dist/scripts/approve.js']");
    expect(approve).toContain("rule 12: the operator job's own command must be ledger-verify: deploy.yml starts it without an override");
  }, 60_000);

  it("T-IAC-01 must-fail rule 13: L1's apps reading the l2 vault are reported", async () => {
    const v = await mutant("modules/l1-apps.bicep", "var vaultL1 = 'https://${names.vaults.l1}", "var vaultL1 = 'https://${names.vaults.l2}");
    expect(v).toContain("rule 13: l1-apps looks up vaults l2, not its own (l1)");
  }, 60_000);

  it("T-IAC-01 must-fail rule 12: the operator job back on L2's image is reported", async () => {
    const v = await mutant("main.bicep", "image: '${acrServer}/x402-operator:${imageTag}'", "image: '${acrServer}/x402-l2-control:${imageTag}'");
    expect(v).toContain("rule 12: operator-apps's image is not x402-operator:<imageTag> from the platform's registry");
  }, 60_000);

  it("T-IAC-01 must-fail rule 13: L2's apps reading the operator's vault are reported", async () => {
    const v = await mutant("modules/l2-apps.bicep", "var vaultL2 = 'https://${names.vaults.l2}", "var vaultOp = 'https://${names.vaults.op}${az.environment().suffixes.keyvaultDns}/'\noutput opVault string = vaultOp\nvar vaultL2 = 'https://${names.vaults.l2}");
    expect(v).toContain("rule 13: l2-apps looks up vaults l2,op, not its own (l2)");
  }, 60_000);

  it("T-IAC-01 must-fail rule 13: L1's apps deployed without waiting for the vaults are reported", async () => {
    const v = await mutant("main.bicep", "dependsOn: [ids, registry, vaults, envs, foundry]", "dependsOn: [ids, registry, envs, foundry]");
    expect(v).toContain("rule 13: l1-apps doesn't wait for the platform's vaults");
  }, 60_000);

  it("T-IAC-01 must-fail rule 18: a unit's apps deployed by the platform's runs, a platform module deployed by every run, or a unit outside the list, is reported", async () => {
    const v = await mutant("main.bicep", "module l1 'modules/l1-apps.bicep' = if (unit == 'l1') {", "module l1 'modules/l1-apps.bicep' = if (unit == 'l1' || platform) {");
    expect(v).toContain("rule 18: the l1-apps module must be deployed only by unit l1's runs");
    const always = await mutant("main.bicep", "module foundry 'modules/foundry.bicep' = if (platform) {", "module foundry 'modules/foundry.bicep' = {");
    expect(always).toContain("rule 18: the foundry module must be deployed only by the platform's runs");
    const all = await mutant("main.bicep", "@allowed(['platform', 'l1', 'l2', 'l3', 'operator', 'portal', 'seller'])", "@allowed(['platform', 'l1', 'l2', 'l3', 'operator', 'portal', 'seller', 'all'])");
    expect(all).toContain(`rule 18: unit must be a required parameter, one of ${DEPLOY_UNITS.join(", ")}`);
  }, 60_000);

  it("T-IAC-01 must-fail rule 14: a Foundry account that accepts API keys is reported", async () => {
    const v = await mutant("modules/foundry.bicep", "disableLocalAuth: true", "disableLocalAuth: false");
    expect(v).toContain("rule 14: Foundry accepts API keys (disableLocalAuth must be true)");
  }, 60_000);

  it("T-IAC-01 must-fail rule 14: an Anthropic key on the agent is reported", async () => {
    const v = await mutant(
      "modules/l1-apps.bicep",
      "            { name: 'MODEL_PROVIDER', value: 'foundry' }\n",
      "            { name: 'MODEL_PROVIDER', value: 'anthropic' }\n            { name: 'ANTHROPIC_API_KEY', secretRef: 'control-token' }\n",
    );
    expect(v).toContain(`rule 14: ANTHROPIC_API_KEY in ${N.main.apps.l1}/agent`);
    expect(v).toContain("rule 14: the agent's MODEL_PROVIDER must be foundry");
  }, 60_000);

  it("T-IAC-01 must-fail rule 15: a name in the parameter file outside the standard is reported", async () => {
    const v = await mutant("main.dev.bicepparam", "    x402: 'cae-x402-${location}-${environment}'", "    x402: 'cae-main-${location}-${environment}'");
    expect(v).toContain(`rule 15: main.dev.bicepparam's names.environments.x402 is cae-main-${N.location}-dev, not the standard ${N.main.environments.x402}`);
  }, 60_000);

  it("T-IAC-01 must-fail rule 15: a template that names a resource itself is reported", async () => {
    const v = await mutant("modules/environments.bicep", "  name: names.environments.x402\n", "  name: 'cae-x402-${location}-dev'\n");
    expect(v).toContain(`rule 15: Microsoft.App/managedEnvironments ${N.main.environments.x402} in environments isn't named from the names parameter`);
    expect(v).toContain(`rule 15: main builds ${N.main.environments.x402} from the location: every name comes from the names parameter`);
  }, 60_000);

  it("T-IAC-01 must-fail rule 15: L3 calling L2 under a name the template writes out is reported", async () => {
    const v = await mutant("modules/l3-apps.bicep", "var controlUrl = 'http://${names.apps.l2}", `var controlUrl = 'http://${N.main.apps.l2}`);
    expect(v).toContain(`rule 15: main writes out ${N.main.apps.l2}: use names.apps.l2`);
  }, 60_000);

  it("T-IAC-01 must-fail rule 15: a module that doesn't get the names whole is reported", async () => {
    const v = await mutant("main.bicep", "  params: { location: location, names: names }\n}\n\nmodule logs", "  params: { location: location, names: union(names, { network: 'vnet-x402' }) }\n}\n\nmodule logs");
    expect(v).toContain("rule 15: the network module doesn't get the names parameter whole");
  }, 60_000);

  it("T-IAC-01 must-fail rule 15: an environment whose vault names exceed 24 characters is reported", async () => {
    const v = await mutant("main.dev.bicepparam", "param location = 'eastus2'", "param location = 'southeastasia'");
    expect(v).toContain(`rule 15: main.dev.bicepparam's names.vaults.seller kv-seller-southeastasia-dev breaks Azure's rule for its type (3-24 characters, ${STANDARD.vaults!.limits[2]})`);
  }, 60_000);

  it("T-IAC-01 must-fail rule 16: a federated credential trusting a branch, or a subject without the immutable IDs, is reported", async () => {
    const v = await mutant("pre-deploy.bicep", "  subject: githubSubject", "  subject: 'repo:${githubRepository}:ref:refs/heads/main'");
    expect(v).toContain(`rule 16: the deploy app's one federated credential must trust only ${IMMUTABLE_SUBJECT}`);
    const plain = await mutant(
      "pre-deploy.bicep",
      "var githubSubject = 'repo:${split(githubRepository, '/')[0]}@${githubOwnerId}/${split(githubRepository, '/')[1]}@${githubRepositoryId}:environment:${githubEnvironment}'",
      "#disable-next-line no-unused-params\nvar githubSubject = 'repo:${githubRepository}:environment:${githubEnvironment}'",
    );
    expect(plain).toContain(`rule 16: the deploy app's one federated credential must trust only ${IMMUTABLE_SUBJECT}`);
  }, 60_000);

  it("T-IAC-01 must-fail rule 16: an unconditioned Role Based Access Control Administrator, or one that may grant Owner, is reported", async () => {
    const condition = /\n {4}conditionVersion: '2\.0'\n {4}condition: .*\n/.exec(readFileSync("infra/modules/deploy-access.bicep", "utf8"))![0];
    const v = await mutant("modules/deploy-access.bicep", condition, "\n");
    expect(v.some((m) => m.startsWith("rule 16: the deploy app's Role Based Access Control Administrator must be limited"))).toBe(true);
    const owner = await mutant("modules/deploy-access.bicep", "  'b9a307c4-5aa3-4b52-ba60-2b17c136cd7b'\n]", "  'b9a307c4-5aa3-4b52-ba60-2b17c136cd7b'\n  '8e3af657-a8ff-443c-a75c-2fe8c4bcb635'\n]");
    expect(owner.some((m) => m.startsWith("rule 16: the deploy app's Role Based Access Control Administrator must be limited"))).toBe(true);
  }, 60_000);

  it("T-IAC-01 must-fail rule 16: an API app on v1.0 tokens is reported", async () => {
    const v = await mutant("pre-deploy.bicep", "requestedAccessTokenVersion: 2", "requestedAccessTokenVersion: 1");
    expect(v).toContain("rule 16: the API app must receive v2.0 access tokens");
  }, 60_000);

  it("T-IAC-01 must-fail rule 12: the portal on L2's image, or running an entry point its image doesn't contain, is reported", async () => {
    const image = await mutant("main.bicep", "image: '${acrServer}/x402-portal:${imageTag}'", "image: '${acrServer}/x402-l2-control:${imageTag}'");
    expect(image).toContain("rule 12: portal-apps's image is not x402-portal:<imageTag> from the platform's registry");
    const entry = await mutant("modules/portal-apps.bicep", "command: ['node', 'dist/src/portal-main.js']", "command: ['node', 'dist/src/layer2-control/service.js']");
    expect(entry).toContain(`rule 12: ${N.main.apps.portal}/portal runs dist/src/layer2-control/service.js, which the portal image doesn't contain`);
  }, 120_000);

  it("T-IAC-01 must-fail rule 16: a web app pre-authorized for the agent's scope, a third pre-authorized client, or a scope open to user consent, is reported", async () => {
    const both = await mutant("pre-deploy.bicep", "{ appId: portalApp.appId, delegatedPermissionIds: [portalAccessId] }", "{ appId: portalApp.appId, delegatedPermissionIds: [portalAccessId, userImpersonationId] }");
    expect(both).toContain("rule 16: only the Azure CLI (for user_impersonation only) and the portal web app (for Portal.Access only) may be pre-authorized");
    const third = await mutant("pre-deploy.bicep", "      { appId: portalApp.appId, delegatedPermissionIds: [portalAccessId] }\n", "      { appId: portalApp.appId, delegatedPermissionIds: [portalAccessId] }\n      { appId: deployApp.appId, delegatedPermissionIds: [portalAccessId] }\n");
    expect(third).toContain("rule 16: only the Azure CLI (for user_impersonation only) and the portal web app (for Portal.Access only) may be pre-authorized");
    const user = await mutant("pre-deploy.bicep", "        value: 'Portal.Access'\n        type: 'Admin'", "        value: 'Portal.Access'\n        type: 'User'");
    expect(user).toContain("rule 16: the API app's scopes must be user_impersonation and Portal.Access, each admin consent only, with its fixed ID");
  }, 120_000);

  it("T-IAC-01 must-fail rule 16: an API app without the idtyp claim, or whose idtyp leaves user tokens out, is reported", async () => {
    const message = "rule 16: the API app's access tokens must carry the optional claims auth_time, and idtyp with include_user_token, and no other";
    expect(await mutant("pre-deploy.bicep", "      { name: 'idtyp', additionalProperties: ['include_user_token'] }\n", "")).toContain(message);
    expect(await mutant("pre-deploy.bicep", "{ name: 'idtyp', additionalProperties: ['include_user_token'] }", "{ name: 'idtyp' }")).toContain(message);
  }, 120_000);

  it("T-IAC-01 must-fail rule 16: a web app with a secret, a role, permissions of its own, or a redirect URI that isn't its own page, is reported", async () => {
    const anchor = "  signInAudience: 'AzureADMyOrg'\n  spa: {";
    const secret = await mutant("pre-deploy.bicep", anchor, `  passwordCredentials: [{ displayName: 'portal' }]\n${anchor}`);
    expect(secret).toContain(`rule 16: ${N.pre.portalApp} has passwordCredentials`);
    const role = await mutant("pre-deploy.bicep", anchor, `  appRoles: [{ id: agentRunRoleId, value: 'Portal.Admin', displayName: 'Portal.Admin', description: 'x', allowedMemberTypes: ['User'], isEnabled: true }]\n${anchor}`);
    expect(role).toContain("rule 16: the portal web app must have no appRoles");
    const permissions = await mutant("pre-deploy.bicep", anchor, `  requiredResourceAccess: [{ resourceAppId: '00000003-0000-0000-c000-000000000000', resourceAccess: [{ id: 'e1fe6dd8-ba31-4d61-89e7-88639da4683d', type: 'Scope' }] }]\n${anchor}`);
    expect(permissions).toContain("rule 16: the portal web app must have no requiredResourceAccess");
    const redirect = await mutant("pre-deploy.bicep", "concat(['http://localhost:4025/redirect.html'], ", "concat(['http://localhost:4025/redirect.html', 'https://portal.example/redirect.html'], ");
    expect(redirect).toContain(`rule 16: the portal web app's redirect URIs must be ${LOCAL_REDIRECT}, and portalOrigin's /redirect.html once it is set (a single-page app: spa.redirectUris)`);
    const web = await mutant("pre-deploy.bicep", "  spa: {\n    redirectUris: concat(", "  web: {\n    redirectUris: concat(");
    expect(web).toContain("rule 16: the portal web app must have no web");
  }, 180_000);

  it("T-IAC-01 must-fail rule 20: L2 without one of its always-referenced secrets, with one behind the flag's value, or with a literal USER_ACCOUNTS, is reported", async () => {
    const always = `rule 20: ${N.main.apps.l2}/l2 must always reference the l2 vault's portal-token and user-wallet-mnemonic, as PORTAL_TOKEN and USER_WALLET_MNEMONIC`;
    const missing = await mutant("modules/l2-apps.bicep", "            { name: 'PORTAL_TOKEN', secretRef: 'portal-token' }\n", "");
    expect(missing).toContain(always);
    const literal = await mutant(
      "modules/l2-apps.bicep",
      "        { name: 'portal-token', keyVaultUrl: '${vaultL2}secrets/portal-token', identity: idL2.id }",
      "        #disable-next-line use-secure-value-for-secure-inputs\n        { name: 'portal-token', value: 'off' }",
    );
    expect(literal).toContain(always);
    const flagged = await mutant(
      "modules/l2-apps.bicep",
      "            { name: 'USER_ACCOUNTS', value: userAccounts.enabled ? '1' : '0' }",
      "            { name: 'USER_ACCOUNTS', value: '1' }",
    );
    expect(flagged).toContain("rule 20: USER_ACCOUNTS must come from the userAccounts parameter");
  }, 180_000);

  it("T-IAC-01 must-fail rule 20: PLATFORM_SELLERS naming the alias, a second seller, or another payee, is reported", async () => {
    const message = "rule 20: PLATFORM_SELLERS must be one seller: ALLOWED_HOSTS' own host, userAccounts.sellerName and sellerPayTo";
    const from = "string([{ host: sellerHost, name: userAccounts.sellerName, payees: [sellerPayTo] }])";
    expect(await mutant("modules/l2-apps.bicep", from, "string([{ host: '${names.apps.sellerAlias}.${sellerDomain}', name: userAccounts.sellerName, payees: [sellerPayTo] }])")).toContain(message);
    expect(await mutant("modules/l2-apps.bicep", from, "string([{ host: sellerHost, name: userAccounts.sellerName, payees: [sellerPayTo] }, { host: 'seller.example', name: 'another', payees: [] }])")).toContain(message);
    expect(await mutant("modules/l2-apps.bicep", from, "string([{ host: sellerHost, name: userAccounts.sellerName, payees: [] }])")).toContain(message);
  }, 180_000);

  it("T-IAC-01 must-fail rule 20: a portal with another role's token, the portal token on L3, API docs turned on, or a portal that calls L3, is reported", async () => {
    const anchor = "            { name: 'PORTAL_TOKEN', secretRef: 'portal-token' }\n            { name: 'CARD_VAULT_KEY'";
    const control = await mutant("modules/portal-apps.bicep", anchor, `            { name: 'CONTROL_TOKEN', secretRef: 'portal-token' }\n${anchor}`);
    expect(control).toContain(`rule 20: CONTROL_TOKEN in ${N.main.apps.portal}/portal`);
    const payer = await mutant("modules/portal-apps.bicep", anchor, `            { name: 'PAYER_PRIVATE_KEY', secretRef: 'portal-token' }\n${anchor}`);
    expect(payer).toContain(`rule 20: PAYER_PRIVATE_KEY in ${N.main.apps.portal}/portal`);
    expect(payer).toContain(`rule 2: PAYER_PRIVATE_KEY in ${N.main.apps.portal}/portal`);
    const docs = await mutant("modules/portal-apps.bicep", anchor, `            { name: 'API_DOCS', value: '1' }\n${anchor}`);
    expect(docs).toContain(`rule 20: API_DOCS in ${N.main.apps.portal}/portal: the API docs are never served in Azure`);
    const l3 = await mutant("modules/portal-apps.bicep", anchor, `            { name: 'SETTLEMENT_URL', value: 'http://\${names.apps.l3}.internal.\${mainDomain}' }\n${anchor}`);
    expect(l3).toContain("rule 20: the portal calls L2 only");
    const onL3 = await mutant("modules/l3-apps.bicep", "            { name: 'VERIFIER_TOKEN', secretRef: 'verifier-token' }\n", "            { name: 'VERIFIER_TOKEN', secretRef: 'verifier-token' }\n            { name: 'PORTAL_TOKEN', secretRef: 'verifier-token' }\n");
    expect(onL3).toContain(`rule 20: PORTAL_TOKEN in ${N.main.apps.l3}/l3`);
  }, 240_000);

  it("T-IAC-01 must-fail rule 20: a client ID written in a template, a portal secret behind a flag, userAccounts passed in part, or main without its check, is reported", async () => {
    const written = await mutant("modules/portal-apps.bicep", "{ name: 'PORTAL_CLIENT_ID', value: userAccounts.portalClientId }", "{ name: 'PORTAL_CLIENT_ID', value: '00000000-0000-4000-8000-000000000000' }");
    expect(written).toContain("rule 20: the portal's PORTAL_CLIENT_ID must come from its parameter");
    const agent = await mutant("modules/l1-apps.bicep", "            { name: 'PORTAL_CLIENT_ID', value: userAccounts.portalClientId }\n", "");
    expect(agent).toContain("rule 20: the agent's PORTAL_CLIENT_ID (the azp it refuses) must come from the userAccounts parameter");
    const flagged = await mutant(
      "modules/portal-apps.bicep",
      "      secrets: [\n        { name: 'portal-token', keyVaultUrl: '${vaultPortal}secrets/portal-token', identity: idPortal.id }\n        { name: 'card-vault-key', keyVaultUrl: '${vaultPortal}secrets/card-vault-key', identity: idPortal.id }\n      ]",
      "      secrets: concat([{ name: 'portal-token', keyVaultUrl: '${vaultPortal}secrets/portal-token', identity: idPortal.id }], userAccounts.cardVault == 'stripe' ? [{ name: 'card-vault-key', keyVaultUrl: '${vaultPortal}secrets/card-vault-key', identity: idPortal.id }] : [])",
    );
    expect(flagged.some((m) => m.startsWith(`rule 20: ${N.main.apps.portal}/portal must always reference the portal vault's portal-token and card-vault-key`))).toBe(true);
    const part = await mutant("main.bicep", "    ciba: ciba\n    userAccounts: userAccounts\n", "    ciba: ciba\n    userAccounts: { enabled: userAccounts.enabled, sellerName: userAccounts.sellerName }\n");
    expect(part).toContain("rule 20: main must pass the userAccounts parameter to l2-apps whole");
    const unchecked = await mutant("main.bicep", " && ((!userAccounts.enabled && unit != 'portal') || length(userAccounts.portalClientId) == 36)", "");
    expect(unchecked).toContain("rule 20: main must refuse (fail()) a userAccounts whose cardVault is not off or stripe, that is enabled without a 36-character portalClientId, or whose cardVault is stripe without a pk_test_ publishable key");
    // The portal doesn't start without the web app's client ID, so its own deployment needs it even while the feature is off.
    const portalUnchecked = await mutant("main.bicep", "(!userAccounts.enabled && unit != 'portal')", "!userAccounts.enabled");
    expect(portalUnchecked).toContain("rule 20: main must refuse (fail()) a userAccounts whose cardVault is not off or stripe, that is enabled without a 36-character portalClientId, or whose cardVault is stripe without a pk_test_ publishable key");
  }, 240_000);

  it("T-IAC-01 must-fail rule 19: the CIBA credential on the agent, as a literal, or under one name only is reported", async () => {
    const onAgent = await mutant(
      "modules/l1-apps.bicep",
      "            { name: 'CONTROL_TOKEN', secretRef: 'control-token' }\n",
      "            { name: 'CONTROL_TOKEN', secretRef: 'control-token' }\n            { name: 'CIBA_CLIENT_KEY', secretRef: 'control-token' }\n",
    );
    expect(onAgent.some((m) => m.startsWith("rule 19: CIBA_CLIENT_KEY in ca-l1-"))).toBe(true);
    const literal = await mutant(
      "modules/l2-apps.bicep",
      "        { name: 'ciba-client-credential', keyVaultUrl: '${vaultL2}secrets/ciba-client-credential', identity: idL2.id }",
      "        #disable-next-line use-secure-value-for-secure-inputs\n        { name: 'ciba-client-credential', value: 'off' }",
    );
    expect(literal).toContain("rule 19: the CIBA credential is not a reference to the l2 vault");
    const oneName = await mutant("modules/l2-apps.bicep", "{ name: ciba.credential == 'secret' ? 'CIBA_CLIENT_SECRET' : 'CIBA_CLIENT_KEY', secretRef", "{ name: 'CIBA_CLIENT_KEY', secretRef");
    expect(oneName).toContain("rule 19: the CIBA credential must be CIBA_CLIENT_KEY or CIBA_CLIENT_SECRET, chosen by ciba.credential");
  }, 120_000);

  it("T-IAC-01 must-fail rule 19: a CIBA value written in the template, or main without its ciba check, is reported", async () => {
    const written = await mutant("modules/l2-apps.bicep", "{ name: 'CIBA_ISSUER', value: ciba.issuer }", "{ name: 'CIBA_ISSUER', value: 'https://tenant.example/' }");
    expect(written).toContain("rule 19: CIBA_ISSUER must come from the ciba parameter");
    const unchecked = await mutant("main.bicep", "startsWith(ciba.issuer, 'https://') && ", "");
    expect(unchecked).toContain("rule 19: main must refuse (fail()) a ciba with another credential kind, or enabled without an https:// issuer, a clientId, an audience and an approver");
  }, 120_000);

  it("T-IAC-01 must-fail rule 17: main.bicep without its target check is reported", async () => {
    const v = await mutant(
      "main.bicep",
      "var target = tenant().tenantId == tenantId && subscription().subscriptionId == subscriptionId && resourceGroup().name == names.resourceGroup",
      "var target = tenant().tenantId == tenantId",
    );
    expect(v).toContain("rule 17: main must refuse to run outside its parameter file's tenant, subscription and resource group");
  }, 60_000);

  it("T-IAC-01 must-fail rule 17: a configuration value read from the environment, or a target the two files disagree on, is reported", async () => {
    const v = await mutant("main.dev.bicepparam", "param sellerPayTo = '0x", "param sellerPayTo = readEnvironmentVariable('SELLER_PAY_TO', '') // '0x");
    expect(v).toContain(`rule 17: main.dev.bicepparam reads sellerPayTo from the environment; only ${PER_RUN.join(", ")} may be`);
    const other = await mutant("main.dev.bicepparam", "param subscriptionId = '", "param subscriptionId = '0");
    expect(other.some((m) => m.startsWith("rule 17: pre-deploy.dev.bicepparam and main.dev.bicepparam name different subscriptionIds"))).toBe(true);
    const id = await mutant("pre-deploy.dev.bicepparam", "param githubOwnerId = '274163174'", "param githubOwnerId = 'fr-com-dev'");
    expect(id).toContain("rule 17: pre-deploy.dev.bicepparam's githubOwnerId fr-com-dev is not a numeric GitHub ID");
    const name = await mutant("pre-deploy.dev.bicepparam", "var environment = 'dev'", "var environment = readEnvironmentVariable('ENVIRONMENT', 'dev')");
    expect(name).toContain(`rule 17: pre-deploy.dev.bicepparam reads var environment = readEnvironmentVariable('ENVIRONMENT', 'dev') from the environment; only ${PER_RUN.join(", ")} may be`);
  }, 60_000);
});
