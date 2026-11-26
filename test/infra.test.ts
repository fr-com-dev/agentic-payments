// T-IAC-01 Azure identity, secret, exposure and naming rules (SPEC.md §3.1 Azure profile; specs/011 contracts/
// cloud-topology.md "T-IAC-01 assertions"). Compiles infra/main.bicep (the platform and every unit) and
// infra/pre-deploy.bicep (the resource group, the Entra objects and the deploy app's roles) with the Bicep CLI, and
// asserts on the ARM JSON that would actually be deployed and on their parameter files, compiled too. main.bicep
// deploys one unit per run (`unit`: the platform, or one unit's apps), and rule 18 checks each module belongs to
// exactly one. Needs the Bicep CLI, and the Microsoft Graph extension it restores from mcr.microsoft.com: set
// BICEP_PATH (deploy.yml does);
// without it this suite is skipped. Each rule has a must-fail mutant. Every name is in the parameter files (`names`):
// names are resolved with the dev files' values, and rule 15 checks each one against the naming standard.
// 013 (specs/013 contracts/config-and-secrets.md "T-IAC-01 changes"): the portal unit joins the tables, rules 2, 3, 4
// and 8 are extended for it, and rule 21 covers user accounts and the identity parameter: since 2026-11-10 (research
// R19) people sign in with Auth0, defined in auth0/ (T-IAC-02).
// 014 (specs/014 contracts/config-and-secrets.md "T-IAC-01 changes"): rule 22 covers the portal's administration area.
// Who is an administrator is a permission of the sign-in tenant, defined in auth0/ (T-IAC-02), not an Entra object.
// 016 (specs/016 contracts/tenant-and-config.md "Tests"): every caller of the agent, a person or a machine, is the
// sign-in tenant's. Rule 11 (the agent's audience at the directory) is gone, and its number is not reused. Rule 16
// is one Entra registration, the deploy app. Rule 21 no longer keeps the sign-in settings from the agent. Rule 23 is
// new: the agent and L2 get the same sign-in settings and nothing of the directory; API_DOCS is on the agent only,
// as agent.apiDocs; the machine caller's key reaches L1's two jobs only. Rules 12 and 15 know the smoke job.
// Phase 3 (SPEC 1.19): rule 16's condition also refuses a role assignment to the deploy app itself (finding #2), and
// rule 24 is new: the ledger's MAC key reaches L2's control container only, from the l2 vault (finding #7).
// SPEC 1.23 (finding #7, the rest): rule 25 is new: the ledger's head lives in a storage account of its own, which only
// the head identity may write, and only L2's control app has that identity (at lifecycle Main, the one exception to
// rule 6 besides the agent). Rule 1 knows its role, and rules 15 and 18 its names and module.
// 020 (specs/020 contracts/config-and-secrets.md "Azure"): rule 26 is new: the portal's Coinbase connection. Its two
// secrets come from the portal vault only, always referenced; its settings from userAccounts.coinbase, which main
// checks; the portal stays one process, with the grants in their own folder of its share. Rule 21 lets the portal
// hold those two secrets, and rule 8 knows the grant key's name.
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
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
/** Storage Blob Data Contributor: (1.23) the head identity's role on the ledger head's container (rule 25). */
const BLOB_CONTRIBUTOR = "ba92f5b4-2d11-453d-a403-e96b0029c9fe";
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
  // 1.23: L2's control app also uses the ledger head's identity (rule 25).
  "l2-control": { unit: "l2", apps: "l2-apps", identities: ["l2", "l2head"], vaults: ["l2"] },
  "l3-verifier": { unit: "l3", apps: "l3-apps", identities: ["l3"], vaults: ["l3"] },
  operator: { unit: "operator", apps: "operator-apps", identities: ["op"], vaults: ["op"] },
  portal: { unit: "portal", apps: "portal-apps", identities: ["portal"], vaults: ["portal"] },
  seller: { unit: "seller", apps: "sellers", identities: ["seller"], vaults: ["seller"] },
};
/** main.bicep's platform modules: deployed only by the platform's runs (deploy-infra.yml; rule 18). */
/** v1.25: no identities module: pre-deploy.bicep makes the identities, so the deploy app's condition can name them (rule 16). */
const PLATFORM_MODULES = ["network", "logs", "registry", "vault", "storage", "ledger-head", "foundry", "environments"];
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
  // 1.23: the ledger's head, L2's alone (rule 25).
  ledgerHead: { type: "st", app: "l2head", compact: true, limits: [3, 24, /^[a-z0-9]+$/] },
  foundry: { type: "ais", app: "x402", limits: [2, 64, /^[a-z][a-z0-9-]*[a-z0-9]$/] },
  environments: { type: "cae", limits: [2, 60, /^[a-z][a-z0-9-]*[a-z0-9]$/] },
  identities: { type: "id", limits: [3, 128, /^[a-z][a-z0-9-]*[a-z0-9]$/] },
  vaults: { type: "kv", limits: [3, 24, /^[a-z](?!.*--)[a-z0-9-]*[a-z0-9]$/] },
  apps: { type: "ca", limits: [2, 32, /^[a-z](?!.*--)[a-z0-9-]*[a-z0-9]$/] },
  jobs: { type: "caj", limits: [2, 32, /^[a-z](?!.*--)[a-z0-9-]*[a-z0-9]$/] },
  deployApp: { type: "app", app: "deploy", limits: [1, 120, /^[a-z][a-z0-9-]*[a-z0-9]$/] },
  operators: { type: "grp", app: "op", limits: [1, 64, /^[a-z][a-z0-9-]*[a-z0-9]$/] },
  // v1.25: the policy assignment that refuses federated credentials on the resource group's identities (rule 16)
  policy: { type: "pol", app: "x402", limits: [1, 64, /^[a-z][a-z0-9-]*[a-z0-9]$/] },
};
/** The {app} segments: the layers, the operator, the portal, the sellers, the smoke run (016), what the layers share, the deploy app, and (1.23) the ledger's head. */
const APPS = ["l1", "l2", "l3", "op", "portal", "seller", "seller-alias", "smoke", "x402", "deploy", "l2head"];
/** An ARM format() expression's text, each {N} replaced by «its argument» ({{, }} and '' unescaped): rule 16's condition. */
function formatText(expr: unknown): string {
  const m = /^\[format\('((?:[^']|'')*)', ([\s\S]*)\)\]$/.exec(String(expr));
  if (!m) return String(expr);
  const args = splitArgs(m[2]!);
  return m[1]!.replace(/\{\{|\}\}|\{(\d+)\}/g, (t: string, i?: string) => (t === "{{" ? "{" : t === "}}" ? "}" : `«${args[Number(i)]}»`)).replace(/''/g, "'");
}

/** Payment key material (INV-2): each reaches only L2's control app (container l2), from the l2 vault (rule 2). */
const PAYMENT_KEYS = ["PAYER_PRIVATE_KEY", "USER_WALLET_MNEMONIC"];
/**
 * The dev parameter file's identity and agent objects and the head of its userAccounts object, as written. The
 * parameter-file mutants replace them whole, so they hold whatever values the file has (empty, or the tenant's once
 * pasted).
 */
const DEV_PARAMETERS = readFileSync("infra/main.dev.bicepparam", "utf8");
const DEV_IDENTITY = /param identity = \{\n[^}]*\}/.exec(DEV_PARAMETERS)?.[0] ?? "param identity = {}";
const DEV_AGENT = /param agent = \{\n[^}]*\}/.exec(DEV_PARAMETERS)?.[0] ?? "param agent = {}";
const DEV_ACCOUNTS_HEAD = /param userAccounts = \{\n  enabled: (?:true|false)\n  portalClientId: '[^']*'/.exec(DEV_PARAMETERS)?.[0] ?? "param userAccounts = {";
const IDENTITY_CHECK = "rule 21: main must refuse (fail()) user accounts turned on without an identity.issuer of the form https://…/ and an identity.audience";
/** Rule 16 (016): the directory holds one registration of ours. */
const ONE_REGISTRATION = "rule 16: the only app registration must be the deploy app: every caller of the agent, a person or a machine, gets its token from the sign-in tenant (auth0/), through no Entra app of ours";
const MAIN_PARAMETERS = "rule 16: pre-deploy's mainParameters output must be the two lines main's parameter file takes: deployClientId and operatorsGroupId";
/** Rule 23 (016): the keys of a parameter file's agent object, the machine caller's secret in the l1 vault, and what the smoke job gets. */
const AGENT_KEYS = ["clientId", "desktopClientId", "apiDocs", "machineClientId", "machineKeyId"];
/** 019 rule 23 (g). */
const DESKTOP_ID = "rule 23: the agent's AGENT_DESKTOP_CLIENT_ID must be agent.desktopClientId and nothing else: the client its sign-in settings advertise";
const MACHINE_SECRET = "machine-client-key";
const SMOKE_ENV = ["NETWORK", "AUTH_ISSUER", "AUTH_AUDIENCE", "MACHINE_CLIENT_ID", "MACHINE_CLIENT_KEY_ID", "MACHINE_CLIENT_KEY", "AGENT_URL", "AGENT_CANDIDATE_URL"];
const AGENT_CHECK = "rule 23: main must refuse (fail()) the l1 and l2 units without an identity.issuer of the form https://…/, an identity.audience and an agent.clientId, agent.apiDocs without an agent.clientId, and the l1 unit without an agent.machineClientId and an agent.machineKeyId";
/** Rule 25 (1.23): the head identity, the scope of its one role, and the address L2 writes the head to, as compiled. */
const HEAD_IDENTITY = "parameters('names').identities.l2head)";
const HEAD_CONTAINER_SCOPE = "[resourceId('Microsoft.Storage/storageAccounts/blobServices/containers', parameters('names').ledgerHead, ";
const HEAD_URL = "[format('https://{0}.blob.{1}/ledger-head', parameters('names').ledgerHead, environment().suffixes.storage)]";
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
  "Microsoft.Authorization/policyAssignments",
];
/** The only parameters a parameter file may read from the environment: deploy.yml sets them on each run. */
const PER_RUN = ["unit", "imageTag", "seedIp", "recoverVaults", "agentStableRevision"];
/** The deployment target: both parameter files of an environment must agree on it (rule 17). */
const TARGET = ["tenantId", "subscriptionId", "location", "names.resourceGroup"];
/** GitHub's immutable OIDC subject for a deploy job: the owner and repository by name and ID (rule 16). */
const IMMUTABLE_SUBJECT = "repo:<owner>@<githubOwnerId>/<name>@<githubRepositoryId>:environment:<githubEnvironment>";
const FIC_PROBLEM = `rule 16: the deploy app's one federated credential must trust only ${IMMUTABLE_SUBJECT}, for the deploy environment (SPEC 1.26: no Auth0 job signs in from GitHub)`;
/**
 * Rule 16 (Phase 3; v1.25): the condition, as text, for one action: main.bicep's roles only, and only to the principals
 * main.bicep assigns them to (assigneeIds: the identities pre-deploy makes, and the operators' group). Before v1.25 the
 * principal clause only refused the deploy app itself, so a run could give Key Vault Secrets User to any other one.
 */
const ASSIGNMENT_CLAUSE = (action: "write" | "delete", source: "Request" | "Resource") =>
  `((!(ActionMatches{'Microsoft.Authorization/roleAssignments/${action}'})) OR (@${source}[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {«variables('assignable')»} AND @${source}[Microsoft.Authorization/roleAssignments:PrincipalId] ForAnyOfAnyValues:GuidEquals {«variables('assignees')»}))`;
const ASSIGNEES_ONLY = "rule 16: the deploy app's Role Based Access Control Administrator condition must be exactly: a role assignment written or deleted holds one of main.bicep's roles and goes to one of main.bicep's principals (assigneeIds)";
/** v1.25: the principals main.bicep assigns roles to, as pre-deploy passes them: every identity it makes, and the operators' group. */
const ASSIGNEE_IDS = "[concat(map(reference('ids').outputs.ids.value, lambda('i', lambdaVariables('i').principalId)), createArray(reference('operatorsGroup').id))]";
const ASSIGNEES_PROBLEM = "rule 16: the deploy app's principals (assigneeIds) must be exactly the identities pre-deploy makes and the operators' group";
/** v1.25: the built-in policy "[Preview]: Managed Identity Federated Credentials should be from allowed issuer types". */
/** Rule 20 (SPEC 1.26). */
const NO_STATE_IN_AZURE = "rule 20: pre-deploy must make no storage account and no role assignment but the deploy app's: the Terraform state of auth0/ is a local file on the operator's host (SPEC 1.26)";
const FIC_POLICY = "tenantResourceId('Microsoft.Authorization/policyDefinitions', '2571b7c3-3056-4a61-b00a-9bc5232234f5')";
const NO_FIC = "rule 16: pre-deploy must assign, on the resource group, the built-in policy that denies every federated credential on its identities (allowFederatedCredentials false, effect Deny), and no template may make one";
/** Rule 24 (Phase 3): the ledger's MAC key, in L2's control container only. */
const MAC_SECRET: Record<string, string> = { LEDGER_MAC_KEY: "ledger-mac-key" };
/** Rule 26 (020): the portal vault's two Coinbase secrets, by the portal's variable for each. */
const COINBASE_SECRETS: Record<string, string> = { COINBASE_CLIENT_SECRET: "coinbase-client-secret", COINBASE_GRANT_KEY: "coinbase-grant-key" };
/** Rule 26: the keys of a parameter file's userAccounts.coinbase, and the dev file's object as written (the parameter-file mutants replace it whole). */
const COINBASE_KEYS = ["clientId", "enabled", "privacyPolicyUrl", "redirectUri", "supportUrl"];
const DEV_COINBASE = /  coinbase: \{\n[^}]*\n  \}/.exec(DEV_PARAMETERS)?.[0] ?? "  coinbase: {}";
/** The portal's secret lines in portal-apps.bicep, as written, in order: the rule 21 and rule 26 mutants replace the block. */
const PORTAL_SECRET_LINES = ["portal-token", "card-vault-key", "portal-admin-token", "coinbase-client-secret", "coinbase-grant-key"]
  .map((s) => "        { name: '" + s + "', keyVaultUrl: '${vaultPortal}secrets/" + s + "', identity: idPortal.id }")
  .join("\n");
const COINBASE_CHECK = "rule 26: main must refuse (fail()) userAccounts.coinbase.enabled without userAccounts.enabled, a clientId, a redirectUri of the form https://…/wallet/coinbase, a privacyPolicyUrl and a supportUrl";
/** The compiled subject of a federated credential for the GitHub environment a parameter names. */
const subjectFor = (envParam: string) =>
  `[format('repo:{0}@{1}/{2}@{3}:environment:{4}', split(parameters('githubRepository'), '/')[0], parameters('githubOwnerId'), split(parameters('githubRepository'), '/')[1], parameters('githubRepositoryId'), parameters('${envParam}'))]`;
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
 * Rules 1–26 of contracts/cloud-topology.md (21: specs/013 contracts/config-and-secrets.md; 22: specs/014; 23: specs/016
 * contracts/tenant-and-config.md; 24: SPEC 1.19; 25: SPEC 1.23; 26: specs/020 contracts/config-and-secrets.md; there
 * is no rule 11 since 016), on the compiled templates, the compiled parameter
 * files (`params`, by file name) and the infra sources. Returns one message per violation, prefixed `rule N:`.
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
    [MN.jobs.smoke]: "l1-agent",
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
  // v1.25: pre-deploy makes one identity per name of names.identities (rule 16 names their principals); main makes none.
  if (deploymentParam(pre, "identities", "keys") !== JSON.stringify({ value: "[objectKeys(parameters('names').identities)]" })) v.push("rule 1: pre-deploy must make one identity per name of names.identities");
  for (const r of main.filter((x) => x.type === "Microsoft.ManagedIdentity/userAssignedIdentities")) v.push(`rule 1: main makes the identity ${label(r)}; pre-deploy makes them`);
  for (const key of units.map((u) => u.key)) if (!(key in (PN.identities ?? {}))) v.push(`rule 1: pre-deploy makes no identity for unit ${key}`);
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
      (ra.module === "deploy-access" && (role.includes(CONTRIBUTOR) || role.includes(RBAC_ADMINISTRATOR)) && principal === "[parameters('principalId')]") ||
      (ra.module === "ledger-head" && role.includes(BLOB_CONTRIBUTOR) && principal.includes("parameters('names').identities.l2head)") && String(ra.raw.scope).startsWith(HEAD_CONTAINER_SCOPE));
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
  // The two public services that verify tokens limit requests per client address before they do (SEC-14, SEC-19),
  // and (v1.24, SEC-41) both sellers limit the priced requests that can reach the facilitator. The ingress is the one
  // proxy in front of each, so each is told to trust exactly one: with none, every caller would share one count.
  for (const [name, container] of [[MN.apps.l1, "agent"], [MN.apps.portal, "portal"], [MN.apps.seller, "seller"], [MN.apps.sellerAlias, "seller"]] as const) {
    const a = byName(name);
    if (!a) continue; // another unit's deployment
    const env = containersOf(a).find((c) => c.name === container)?.env ?? [];
    if (env.find((e) => e.name === "TRUSTED_PROXY_HOPS")?.value !== "1") v.push(`rule 3: ${name}/${container} is behind the ingress and must set TRUSTED_PROXY_HOPS to 1, for its per-address request limit`);
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

  // Rule 6: identity lifecycle Main only for the agent, and (1.23) for the ledger head's identity on L2's control app,
  // which writes the head with it. L2's own identity stays None: Container Apps gives an app's identities to every
  // main container, the proxy sidecar included, and L2's identity reads the l2 vault.
  for (const a of apps(main)) {
    const settings = (configOf(a).identitySettings ?? []) as { identity: string; lifecycle: string }[];
    const isL2 = namesOf(a).includes(MN.apps.l2);
    const want = (s: { identity: string }) => (namesOf(a).includes(MN.apps.l1) || (isL2 && String(s.identity).includes(HEAD_IDENTITY)) ? "Main" : "None");
    if (settings.length === 0 || settings.some((s) => s.lifecycle !== want(s))) v.push(`rule 6: ${label(a)} identity lifecycle must be Main for the agent and for L2's head identity only, None otherwise`);
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
        if (/PRIVATE_KEY|SECRET|TOKEN|MNEMONIC|CARD_VAULT_KEY|^MACHINE_CLIENT_KEY$|^LEDGER_MAC_KEY$|^COINBASE_GRANT_KEY$/.test(e.name) && e.value !== undefined) v.push(`rule 8: ${label(a)}/${c.name} ${e.name} is a literal`);
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

  // (No rule 11 since 016: it was the agent's audience at the directory. What the agent verifies now is rule 23.)

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
    for (const platform of ["registry", "vaults", "environments"]) {
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
  const agentEnv = apps(main).filter((r) => namesOf(r).includes(MN.apps.l1)).flatMap((r) => containersOf(r).flatMap((c) => c.env ?? []));
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

  // Rule 16: the Entra objects (pre-deploy.bicep). Since 016 the directory gives nobody access to a service: every
  // caller of the agent, a person or a machine, gets its token from the sign-in tenant (auth0/, T-IAC-02; specs/016
  // research R12). So there is one app registration, the deploy app, and one service principal, its own; no app role
  // is assigned to anyone; and nothing is left of the API app 011 made for the agent's callers (its role, scopes,
  // pre-authorization and claim, agentUsers, the retirePortalScope switch, its line in the output) or of the web app
  // 013 first made for the portal. The deploy app has no API, no permissions and no secret: GitHub signs in as it
  // through one federated credential, for the repository's deploy environment (SPEC 1.26 removed the second, for the
  // Auth0 environment: the tenant's Terraform runs on the operator's host). The deploy app's roles are Contributor and Role Based Access Control Administrator on the
  // resource group only, the latter limited by condition to exactly the roles main.bicep assigns. Phase 3: the
  // condition also refuses an assignment whose principal is the deploy app itself, written or deleted, so it can't
  // give itself one of those roles (Key Vault Secrets User on a vault).
  const graph = (type: string) => pre.filter((r) => r.type === `Microsoft.Graph/${type}@v1.0`);
  const entraApps = graph("applications");
  const deployApp = entraApps.find((r) => namesOf(r).includes(PN.deployApp));
  if (entraApps.length !== 1 || !deployApp) v.push(ONE_REGISTRATION);
  for (const a of entraApps) for (const k of ["spa", "web", "publicClient", "isFallbackPublicClient"]) if (k in a.properties) v.push(`rule 16: ${label(a)} must have no ${k}: nobody signs in through it`);
  const GONE: Record<string, string> = {
    portalOrigin: "the portal's origin is a Terraform variable of auth0/",
    portalPreAuthorized: "the portal's origin is a Terraform variable of auth0/",
    agentUsers: "who may run the agent is a role of the sign-in tenant (auth0/), assigned there",
    retirePortalScope: "the API app the scope belonged to is gone",
    githubAuth0Environment: "the Auth0 tenant's Terraform runs on the operator's host, so no Auth0 job signs in from GitHub (SPEC 1.26)",
  };
  for (const [gone, why] of Object.entries(GONE)) if (gone in ((arms["pre-deploy"].parameters ?? {}) as Json)) v.push(`rule 16: pre-deploy must have no ${gone} parameter: ${why}`);
  const mainParameters = JSON.stringify(((arms["pre-deploy"].outputs ?? {}) as Json).mainParameters ?? "");
  if (JSON.stringify([...mainParameters.matchAll(/param (\w+) = /g)].map((m) => m[1])) !== JSON.stringify(["deployClientId", "operatorsGroupId"])) v.push(MAIN_PARAMETERS);
  for (const a of entraApps) {
    for (const k of ["passwordCredentials", "keyCredentials"]) if (k in a.properties) v.push(`rule 16: ${label(a)} has ${k}`);
    if (a.properties.signInAudience !== "AzureADMyOrg") v.push(`rule 16: ${label(a)} must be single-tenant`);
    // No API: no role to hold, no scope to consent to, no token to ask for.
    for (const k of ["api", "appRoles", "identifierUris", "requiredResourceAccess", "optionalClaims"]) if (k in a.properties) v.push(`rule 16: ${label(a)} must have no ${k}: no token is issued for an Entra app of ours`);
  }
  const servicePrincipals = graph("servicePrincipals");
  if (servicePrincipals.length !== 1 || servicePrincipals[0]!.properties.appId !== "[reference('deployApp').appId]") v.push("rule 16: the only service principal must be the deploy app's");
  if (graph("appRoleAssignedTo").length > 0) v.push("rule 16: no app role may be assigned: the directory gives nobody access to the agent");
  const fics = graph("applications/federatedIdentityCredentials");
  const subjectOf = (f: Res) => {
    const subject = String(f.properties.subject);
    const viaVar = /^\[variables\('(\w+)'\)\]$/.exec(subject);
    return viaVar ? String(f.vars[viaVar[1]!]) : subject;
  };
  if (
    fics.length !== 1 ||
    fics.some((f) => !String(f.properties.name).includes("reference('deployApp')") || f.properties.issuer !== "https://token.actions.githubusercontent.com" || JSON.stringify(f.properties.audiences) !== '["api://AzureADTokenExchange"]') ||
    JSON.stringify(fics.map(subjectOf)) !== JSON.stringify([subjectFor("githubEnvironment")])
  ) {
    v.push(FIC_PROBLEM);
  }
  const group = graph("groups")[0]?.properties ?? {};
  if (group.securityEnabled !== true || group.mailEnabled !== false || !JSON.stringify(group.members ?? {}).includes("operatorUser")) {
    v.push("rule 16: the operators' group must be a security group of the operators");
  }
  const access = pre.filter((r) => r.type === "Microsoft.Authorization/roleAssignments" && r.module === "deploy-access");
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
  if (formatText(administrator?.properties.condition) !== `${ASSIGNMENT_CLAUSE("write", "Request")} AND ${ASSIGNMENT_CLAUSE("delete", "Resource")}`) v.push(ASSIGNEES_ONLY);
  if (deploymentParam(pre, "deploy-access", "assigneeIds") !== JSON.stringify({ value: ASSIGNEE_IDS })) v.push(ASSIGNEES_PROBLEM);
  // v1.25: no federated credential on an identity of the resource group: the built-in policy, denying all of them,
  // assigned on the resource group by pre-deploy (where the deploy app can't change it), and none in any template.
  const policies = all.filter((r) => r.type === "Microsoft.Authorization/policyAssignments");
  const policy = policies[0];
  const policyParams = JSON.stringify(policy?.properties.parameters ?? {});
  if (
    policies.length !== 1 ||
    policy!.root !== "pre-deploy" ||
    deployment(pre, policy!.module)?.raw.resourceGroup !== "[parameters('names').resourceGroup]" ||
    !withVars(policy!.properties.policyDefinitionId, policy!.vars).includes(FIC_POLICY) ||
    (policy!.properties.enforcementMode ?? "Default") !== "Default" ||
    policyParams !== JSON.stringify({ allowFederatedCredentials: { value: false }, effect: { value: "Deny" } }) ||
    all.some((r) => r.type.toLowerCase().startsWith("microsoft.managedidentity/userassignedidentities/federatedidentitycredentials"))
  ) {
    v.push(NO_FIC);
  }

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
    // v1.25: pre-deploy makes the identities main's apps look up, so both files name the same ones.
    const ids = (p: Json) => JSON.stringify(Object.entries(((p.names as Json | undefined)?.identities ?? {}) as Json).sort());
    if (ids(pre) !== ids(mainParams)) v.push(`rule 17: pre-deploy.${env}.bicepparam and main.${env}.bicepparam name different identities: pre-deploy makes the ones main's apps look up`);
    for (const p of ["githubOwnerId", "githubRepositoryId"]) if (!/^[1-9][0-9]*$/.test(String(pre[p]))) v.push(`rule 17: pre-deploy.${env}.bicepparam's ${p} ${pre[p]} is not a numeric GitHub ID`);
  }

  // Rule 19 (012, SPEC L2-7, FR-003, FR-030): L2's Auth0 client credential reaches only L2's control app (container
  // l2), as a reference to the l2 vault's ciba-client-credential, named CIBA_CLIENT_KEY or CIBA_CLIENT_SECRET by
  // ciba.credential. Every other CIBA_* value comes from the ciba parameter, which main passes to l2-apps whole, and
  // main refuses (fail()) an enabled ciba it can't use. No other app, job or container sees anything of it.
  // 015 (SPEC v1.16 L2-7; specs/015 contracts/config-and-secrets.md "T-IAC-01 rule 19, as amended"): no approver is
  // configured anywhere. The ciba parameter has exactly six keys, none of them an approver; no app, L2's included,
  // has a CIBA_APPROVER variable (L2 refuses to start with one); and main refuses ciba.enabled without
  // userAccounts.enabled, because a request goes to the user a payment is for.
  const CIBA_SECRET = "ciba-client-credential";
  const CIBA_KEYS = ["audience", "clientId", "clientKeyId", "credential", "enabled", "issuer"];
  for (const [file, values] of Object.entries(params)) {
    if (!/^main\.[a-z0-9]+\.bicepparam$/.test(file)) continue;
    const keys = Object.keys((values.ciba ?? {}) as Json).sort();
    if (JSON.stringify(keys) !== JSON.stringify(CIBA_KEYS)) v.push(`rule 19: ${file}'s ciba must have exactly the keys ${CIBA_KEYS.join(", ")} (it has ${keys.join(", ")})`);
  }
  for (const a of apps(main)) {
    for (const c of containersOf(a)) {
      for (const e of c.env ?? []) if (e.name === "CIBA_APPROVER") v.push(`rule 19: ${label(a)}/${c.name} has CIBA_APPROVER; no approver is configured (SPEC v1.16)`);
    }
  }
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
      CIBA_CLIENT_KEY_ID: "[parameters('ciba').clientKeyId]",
    };
    for (const [name, want] of Object.entries(FROM_PARAM)) {
      const got = env.find((e) => e.name === name);
      if (got?.value !== want || got.secretRef !== undefined) v.push(`rule 19: ${name} must come from the ciba parameter`);
    }
  }
  if (deploymentParam(main, "l2-apps", "ciba") !== JSON.stringify({ value: "[parameters('ciba')]" })) v.push("rule 19: main must pass the ciba parameter to l2-apps whole");
  const cibaChecked = String(((arms.main.variables ?? {}) as Json).cibaChecked ?? "");
  for (const part of ["fail(", "startsWith(parameters('ciba').issuer, 'https://')", "contains(createArray('key', 'secret'), parameters('ciba').credential)", "parameters('ciba').clientId", "parameters('ciba').audience"]) {
    if (!cibaChecked.includes(part)) {
      v.push("rule 19: main must refuse (fail()) a ciba with another credential kind, or enabled without an https:// issuer, a clientId and an audience");
      break;
    }
  }
  if (cibaChecked.includes("parameters('ciba').approver")) v.push("rule 19: main's ciba check still asks for an approver");
  if (!cibaChecked.includes("fail(") || !cibaChecked.includes("parameters('userAccounts').enabled")) v.push("rule 19: main must refuse (fail()) ciba.enabled without userAccounts.enabled");

  // Rule 20 (SPEC 1.26): the Terraform state of auth0/ is a local file on the operator's host (scripts/auth0-tenant.sh),
  // not in Azure. pre-deploy makes no storage account, and no role assignment outside deploy-access: the state's
  // account and the deploy app's Storage Blob Data Contributor on its container, which 012 made here, are gone.
  if (pre.some((r) => r.type === "Microsoft.Storage/storageAccounts") || pre.some((r) => r.type === "Microsoft.Authorization/roleAssignments" && r.module !== "deploy-access")) {
    v.push(NO_STATE_IN_AZURE);
  }

  // Rule 21 (013, SPEC L2-8; specs/013 contracts/config-and-secrets.md): user accounts. L2's control app (container
  // l2) always references the l2 vault's portal-token and user-wallet-mnemonic, so every environment seeds them (the
  // placeholder off while userAccounts.enabled is false); USER_ACCOUNTS comes from userAccounts, and PLATFORM_SELLERS
  // is one seller: the host L2 allows (ALLOWED_HOSTS' own expression, never the alias), userAccounts.sellerName and
  // sellerPayTo. The portal reads only its own vault, always both of its secrets; it gets no payment key and no token
  // but PORTAL_TOKEN, which only it and L2 hold, and the card vault key, which only it holds. Its other values come
  // from parameters, it calls L2 only, and it never serves the API docs. main passes userAccounts whole to the two
  // modules that read it, and refuses (fail()) one it can't use.
  // People's sign-in (research R19): the identity parameter, Terraform's output, is Auth0's issuer and the API's
  // identifier. The portal takes AUTH_ISSUER and AUTH_AUDIENCE from it; nothing of the directory reaches the portal,
  // and nothing of the agent's either (no list of the agent's clients, no machine caller's setting). main passes
  // identity whole to the portal's module, and refuses (fail()) user accounts turned on without a usable one. What the
  // agent and L2 get of the sign-in tenant is rule 23.
  const UA = "parameters('userAccounts')";
  const ID = "parameters('identity')";
  const L2_USER_SECRETS: Record<string, string> = { PORTAL_TOKEN: "portal-token", USER_WALLET_MNEMONIC: "user-wallet-mnemonic" };
  const PORTAL_SECRETS: Record<string, string> = { PORTAL_TOKEN: "portal-token", CARD_VAULT_KEY: "card-vault-key" };
  /** 014 (rule 22): the administration role's token, in L2 and in the portal, each from its own vault. */
  const ADMIN_SECRET: Record<string, string> = { PORTAL_ADMIN_TOKEN: "portal-admin-token" };
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
    if (!alwaysReferenced(l2, "l2", L2_USER_SECRETS, "l2")) v.push(`rule 21: ${MN.apps.l2}/l2 must always reference the l2 vault's ${Object.values(L2_USER_SECRETS).join(" and ")}, as ${Object.keys(L2_USER_SECRETS).join(" and ")}`);
    if (l2Env.find((e) => e.name === "USER_ACCOUNTS")?.value !== `[if(${UA}.enabled, '1', '0')]`) v.push("rule 21: USER_ACCOUNTS must come from the userAccounts parameter");
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
      v.push("rule 21: PLATFORM_SELLERS must be one seller: ALLOWED_HOSTS' own host, userAccounts.sellerName and sellerPayTo");
    }
  }
  for (const a of apps(main)) {
    const isL2 = namesOf(a).includes(MN.apps.l2);
    const isPortal = namesOf(a).includes(MN.apps.portal);
    for (const s of secretsOf(a)) {
      if (s.name === "user-wallet-mnemonic" && !isL2) v.push(`rule 21: ${label(a)} has the user wallet mnemonic`);
      if (s.name === "portal-token" && !isL2 && !isPortal) v.push(`rule 21: ${label(a)} has the portal token`);
      if (s.name === "card-vault-key" && !isPortal) v.push(`rule 21: ${label(a)} has the card vault key`);
      if (isPortal && JSON.stringify(vaultKeysOf(a, s.keyVaultUrl)) !== '["portal"]') v.push(`rule 21: ${label(a)} reads ${s.name} from a vault other than the portal's`);
    }
    for (const c of containersOf(a)) {
      for (const e of c.env ?? []) {
        if (isPortal && /^API_DOCS/.test(e.name)) v.push(`rule 21: ${e.name} in ${label(a)}/${c.name}: the portal never serves the API docs in Azure`);
        if ((e.name === "PORTAL_TOKEN" || e.secretRef === "portal-token") && !((isL2 && c.name === "l2") || isPortal)) v.push(`rule 21: ${e.name} in ${label(a)}/${c.name}`);
        if ((/^CARD_VAULT/.test(e.name) || e.secretRef === "card-vault-key") && !isPortal) v.push(`rule 21: ${e.name} in ${label(a)}/${c.name}`);
        if (/^(USER_ACCOUNTS|PLATFORM_SELLERS|PLATFORM_FILE)$/.test(e.name) && !(isL2 && c.name === "l2")) v.push(`rule 21: ${e.name} in ${label(a)}/${c.name}`);
        if (isPortal && (PAYMENT_KEYS.includes(e.name) || (/TOKEN/.test(e.name) && e.name !== "PORTAL_TOKEN" && e.name !== "PORTAL_ADMIN_TOKEN"))) v.push(`rule 21: ${e.name} in ${label(a)}/${c.name}`);
      }
    }
  }
  if (portal) {
    // 014 and 020: beside its own two, the portal holds the administration token (rule 22) and the two Coinbase secrets (rule 26).
    if (!alwaysReferenced(portal, "portal", PORTAL_SECRETS, "portal") || secretsOf(portal).some((s) => !Object.values({ ...PORTAL_SECRETS, ...ADMIN_SECRET, ...COINBASE_SECRETS }).includes(String(s.name)))) {
      v.push(`rule 21: ${MN.apps.portal}/portal must always reference the portal vault's ${Object.values(PORTAL_SECRETS).join(" and ")}, as ${Object.keys(PORTAL_SECRETS).join(" and ")}, and hold no other secret`);
    }
    const env = containersOf(portal).find((c) => c.name === "portal")?.env ?? [];
    const FROM_PARAM: Record<string, string> = {
      AUTH_ISSUER: `[${ID}.issuer]`,
      AUTH_AUDIENCE: `[${ID}.audience]`,
      PORTAL_CLIENT_ID: `[${UA}.portalClientId]`,
      CARD_VAULT: `[if(equals(${UA}.cardVault, 'stripe'), 'stripe', '')]`,
      CARD_VAULT_PUBLISHABLE_KEY: `[${UA}.cardVaultPublishableKey]`,
    };
    for (const [name, want] of Object.entries(FROM_PARAM)) {
      const got = env.find((e) => e.name === name);
      if (got?.value !== want || got.secretRef !== undefined) v.push(`rule 21: the portal's ${name} must come from its parameter`);
    }
    // The portal accepts Auth0 tokens of its own client only: nothing of the directory, no list of the agent's
    // clients and nothing of the machine caller reaches it.
    for (const e of env) if (/^(AUTH_TENANT_ID|SERVICE_AUDIENCE|AGENT_CLIENT_IDS|MACHINE_CLIENT_\w+)$/.test(e.name)) v.push(`rule 21: ${e.name} in ${label(portal)}/portal: the portal gets nothing of the directory, of the agent's clients or of the machine caller`);
    const portalParams = (((deployment(main, "portal-apps")?.properties.template ?? {}) as Json).parameters ?? {}) as Json;
    for (const param of ["authTenantId", "authAudience", "agent"]) if (param in portalParams) v.push(`rule 21: portal-apps must take no ${param} parameter: the portal gets nothing of the directory or of the agent's`);
    const control = resolved(env.find((e) => e.name === "CONTROL_URL")?.value ?? "", portal.vars, devParams.main!);
    if (JSON.stringify(control) !== JSON.stringify([`http://${MN.apps.l2}.internal.*`])) v.push("rule 21: the portal's CONTROL_URL must be L2's internal address");
    if (env.some((e) => /^(SETTLEMENT_URL|SELLER_URL|SELLER_ALIAS_URL)$/.test(e.name))) v.push("rule 21: the portal calls L2 only");
  }
  for (const module of ["l2-apps", "portal-apps"]) {
    if (deploymentParam(main, module, "userAccounts") !== JSON.stringify({ value: `[${UA}]` })) v.push(`rule 21: main must pass the userAccounts parameter to ${module} whole`);
  }
  for (const module of ["portal-apps"]) {
    if (deploymentParam(main, module, "identity") !== JSON.stringify({ value: `[${ID}]` })) v.push(`rule 21: main must pass the identity parameter to ${module} whole`);
  }
  const userAccountsChecked = String(((arms.main.variables ?? {}) as Json).userAccountsChecked ?? "");
  for (const part of ["fail(", `contains(createArray('off', 'stripe'), ${UA}.cardVault)`, `or(and(not(${UA}.enabled), not(equals(parameters('unit'), 'portal'))), not(empty(${UA}.portalClientId)))`, `startsWith(${UA}.cardVaultPublishableKey, 'pk_test_')`]) {
    if (!userAccountsChecked.includes(part)) {
      v.push("rule 21: main must refuse (fail()) a userAccounts whose cardVault is not off or stripe, that is enabled without a portalClientId (not empty: an Auth0 client ID is not a GUID), or whose cardVault is stripe without a pk_test_ publishable key");
      break;
    }
  }
  const identityChecked = String(((arms.main.variables ?? {}) as Json).identityChecked ?? "");
  if (!identityChecked.startsWith(`[if(or(not(${UA}.enabled), and(and(startsWith(${ID}.issuer, 'https://'), endsWith(${ID}.issuer, '/')), not(empty(${ID}.audience)))), ${UA}.enabled, fail(`)) {
    v.push(IDENTITY_CHECK);
  }
  // Each environment's parameter file: the identity object has exactly the keys the templates read (the agent's
  // client is in the agent object, rule 23), and user accounts are on only with a usable identity (what main's
  // fail() would refuse at deployment, found here first).
  for (const [file, p] of Object.entries(params).filter(([f]) => /^main\.[a-z0-9]+\.bicepparam$/.test(f))) {
    const id = (p.identity ?? {}) as Json;
    const accounts = (p.userAccounts ?? {}) as Json;
    if (JSON.stringify(Object.keys(id).sort()) !== '["audience","issuer"]' || typeof id.issuer !== "string" || typeof id.audience !== "string") {
      v.push(`rule 21: ${file}'s identity must be exactly issuer and audience`);
    } else if (accounts.enabled === true && (!/^https:\/\/[^/]+\/$/.test(id.issuer) || id.audience === "")) {
      v.push(`rule 21: ${file} turns user accounts on without an identity.issuer of the form https://<domain>/ and an identity.audience`);
    }
  }

  // Rule 22 (014, SPEC L2-8; specs/014 contracts/config-and-secrets.md): the portal's administration area. L2's
  // control container and the portal each always reference portal-admin-token, each from its own vault, so every
  // environment seeds it (the placeholder off while userAccounts.administration is false). PORTAL_ADMIN in both
  // comes from that one parameter. No other app holds the secret or the variable, and main refuses (fail())
  // administration without user accounts.
  const ADMIN_FLAG = `[if(${UA}.administration, '1', '0')]`;
  if (l2) {
    if (!alwaysReferenced(l2, "l2", ADMIN_SECRET, "l2")) v.push(`rule 22: ${MN.apps.l2}/l2 must always reference the l2 vault's portal-admin-token, as PORTAL_ADMIN_TOKEN`);
    if (l2Env.find((e) => e.name === "PORTAL_ADMIN")?.value !== ADMIN_FLAG) v.push("rule 22: L2's PORTAL_ADMIN must come from userAccounts.administration");
  }
  if (portal) {
    if (!alwaysReferenced(portal, "portal", ADMIN_SECRET, "portal")) v.push(`rule 22: ${MN.apps.portal}/portal must always reference the portal vault's portal-admin-token, as PORTAL_ADMIN_TOKEN`);
    const portalEnv = containersOf(portal).find((c) => c.name === "portal")?.env ?? [];
    if (portalEnv.find((e) => e.name === "PORTAL_ADMIN")?.value !== ADMIN_FLAG) v.push("rule 22: the portal's PORTAL_ADMIN must come from userAccounts.administration");
  }
  for (const a of apps(main)) {
    const isL2 = namesOf(a).includes(MN.apps.l2);
    const isPortal = namesOf(a).includes(MN.apps.portal);
    for (const s of secretsOf(a)) {
      if (s.name === "portal-admin-token" && !isL2 && !isPortal) v.push(`rule 22: ${label(a)} has the portal administration token`);
    }
    for (const c of containersOf(a)) {
      for (const e of c.env ?? []) {
        const mine = (isL2 && c.name === "l2") || isPortal;
        if ((/^PORTAL_ADMIN(_TOKEN)?$/.test(e.name) || e.secretRef === "portal-admin-token") && !mine) v.push(`rule 22: ${e.name} in ${label(a)}/${c.name}`);
        // One secret, one variable: the administration token never arrives under another name, nor another secret under its name.
        if (mine && (e.name === "PORTAL_ADMIN_TOKEN") !== (e.secretRef === "portal-admin-token")) v.push(`rule 22: ${e.name} in ${label(a)}/${c.name} must be the portal-admin-token secret and nothing else`);
      }
    }
  }
  if (!userAccountsChecked.includes(`not(${UA}.administration)`) && !userAccountsChecked.includes(`or(not(${UA}.administration), ${UA}.enabled)`)) {
    v.push("rule 22: main must refuse (fail()) userAccounts.administration without userAccounts.enabled");
  }

  // Rule 23 (016, SPEC L1-6 and L2-5; specs/016 contracts/tenant-and-config.md "Azure"): the agent's callers are
  // the sign-in tenant's, people and machines alike.
  // (a) The agent's container and L2's each get AUTH_ISSUER and AUTH_AUDIENCE from the identity parameter and
  //     AGENT_CLIENT_IDS from agent.clientId, beside agent.desktopClientId when it is set (019), and main passes both
  //     parameters whole to both modules: the two units
  //     verify a caller's token against the same tenant, API and client. Wherever else the tenant is named (the
  //     portal, L1's two jobs) it is that same identity, and no other container gets a list of the agent's clients.
  //     L2 also gets the portal's client, the one it never accepts as a caller's.
  // (b) Nothing of the directory: no container gets AUTH_TENANT_ID or SERVICE_AUDIENCE, main has no authAudience
  //     parameter, and no module takes the directory's tenant or an audience of it.
  // (c) API_DOCS is on the agent's container only, as agent.apiDocs and nothing else, with the client its docs page
  //     signs people in through; no job and no other unit gets either variable.
  // (d) The machine caller's key is the l1 vault's machine-client-key, referenced by the regression job and the
  //     smoke job and by nothing else, the agent's own container included (rule 8: never a literal). The two jobs
  //     get the tenant from identity and the client's ID and its key's ID from agent. The smoke job's own command is
  //     the smoke client, and it gets the agent's address and its candidate label's and nothing else: no role token.
  // (e) agent in every main.<environment>.bicepparam has exactly the keys clientId, desktopClientId (019), apiDocs,
  //     machineClientId and machineKeyId.
  // (g) 019: AGENT_DESKTOP_CLIENT_ID is on the agent's container only, as agent.desktopClientId: the client its
  //     sign-in settings advertise, one of its AGENT_CLIENT_IDS.
  // (f) main refuses (fail()) the l1 and l2 units without a usable identity and an agent.clientId, the docs without
  //     that client, and the l1 unit without the machine client's ID and its key's ID.
  const AG = "parameters('agent')";
  const agentApp = byName(MN.apps.l1);
  const smoke = byName(MN.jobs.smoke);
  const fromParam = (env: Container["env"], name: string, want: string) => {
    const got = (env ?? []).find((e) => e.name === name);
    return got?.value === want && got.secretRef === undefined;
  };
  const TENANT: Record<string, string> = { AUTH_ISSUER: `[${ID}.issuer]`, AUTH_AUDIENCE: `[${ID}.audience]` };
  // 019: the agent's client, and the desktop client beside it when the environment's tenant has one.
  const SIGN_IN: Record<string, string> = { ...TENANT, AGENT_CLIENT_IDS: `[if(empty(${AG}.desktopClientId), ${AG}.clientId, format('{0},{1}', ${AG}.clientId, ${AG}.desktopClientId))]` };
  const verifiers: [string, Res | undefined, string][] = [["the agent", agentApp, "agent"], ["L2", l2, "l2"]];
  for (const [what, app, container] of verifiers) {
    const env = app ? containersOf(app).find((c) => c.name === container)?.env : undefined;
    for (const [name, want] of Object.entries(SIGN_IN)) {
      if (!fromParam(env, name, want)) v.push(`rule 23: ${what}'s ${name} must come from the ${name === "AGENT_CLIENT_IDS" ? "agent" : "identity"} parameter: the agent and L2 verify a caller's token against the same tenant, API and client`);
    }
  }
  if (!fromParam(l2Env, "PORTAL_CLIENT_ID", `[${UA}.portalClientId]`)) v.push("rule 23: L2's PORTAL_CLIENT_ID must come from userAccounts.portalClientId: the client L2 never accepts as a caller's");
  for (const d of main.filter((r) => r.module === "main" && r.type === "Microsoft.Resources/deployments")) {
    const m = moduleName(d.name);
    const passed = (d.properties.parameters ?? {}) as Json;
    if (m === "l1-apps" || m === "l2-apps") {
      for (const [param, expr] of [["identity", ID], ["agent", AG]] as const) {
        if (JSON.stringify(passed[param] ?? null) !== JSON.stringify({ value: `[${expr}]` })) v.push(`rule 23: main must pass the ${param} parameter to ${m} whole`);
      }
    } else if ("agent" in passed) {
      v.push(`rule 23: main passes the agent parameter to ${m}: only the agent and L2 read it`);
    }
    const declared = (((d.properties.template ?? {}) as Json).parameters ?? {}) as Json;
    for (const param of ["authTenantId", "authAudience"]) if (param in declared) v.push(`rule 23: ${m} takes ${param}: nothing verifies the directory's tokens`);
  }
  if ("authAudience" in ((arms.main.parameters ?? {}) as Json)) v.push("rule 23: main must have no authAudience parameter: nothing verifies the directory's tokens");
  const machineJobs = [MN.jobs.l1, MN.jobs.smoke];
  for (const a of apps(main)) {
    const isAgent = namesOf(a).includes(MN.apps.l1);
    const isL2 = namesOf(a).includes(MN.apps.l2);
    const isMachineJob = namesOf(a).some((n) => machineJobs.includes(n));
    for (const s of secretsOf(a)) {
      if ((s.name === MACHINE_SECRET || String(s.keyVaultUrl ?? "").includes(`secrets/${MACHINE_SECRET}`)) && !isMachineJob) v.push(`rule 23: ${label(a)} has the machine caller's key`);
    }
    for (const c of containersOf(a)) {
      const where = `${label(a)}/${c.name}`;
      const verifier = (isAgent && c.name === "agent") || (isL2 && c.name === "l2");
      for (const e of c.env ?? []) {
        if (TENANT[e.name] !== undefined && !verifier && !fromParam([e], e.name, TENANT[e.name]!)) v.push(`rule 23: ${e.name} in ${where} is not the identity parameter's: every unit names the same sign-in tenant`);
        if (e.name === "AGENT_CLIENT_IDS" && !verifier) v.push(`rule 23: AGENT_CLIENT_IDS in ${where}: only the agent and L2 accept the agent's clients`);
        if (/^(AUTH_TENANT_ID|SERVICE_AUDIENCE)$/.test(e.name)) v.push(`rule 23: ${e.name} in ${where}: nothing verifies the directory's tokens`);
        if (/^API_DOCS/.test(e.name) && !(isAgent && c.name === "agent")) v.push(`rule 23: ${e.name} in ${where}: in Azure only the agent can serve the docs`);
        if (e.name === "AGENT_DESKTOP_CLIENT_ID" && !(isAgent && c.name === "agent")) v.push(`rule 23: AGENT_DESKTOP_CLIENT_ID in ${where}: only the agent serves the desktop client's sign-in settings`);
        if ((/^MACHINE_CLIENT_/.test(e.name) || e.secretRef === MACHINE_SECRET) && !isMachineJob) v.push(`rule 23: ${e.name} in ${where}: only L1's regression job and smoke job call as the machine caller`);
        // One secret, one variable: the key never arrives under another name, nor another secret under its name.
        if (isMachineJob && (e.name === "MACHINE_CLIENT_KEY") !== (e.secretRef === MACHINE_SECRET)) v.push(`rule 23: ${e.name} in ${where} must be the ${MACHINE_SECRET} secret and nothing else`);
      }
    }
  }
  if (agentApp) {
    const env = containersOf(agentApp).find((c) => c.name === "agent")?.env;
    if (!fromParam(env, "API_DOCS", `[if(${AG}.apiDocs, '1', '0')]`)) v.push("rule 23: the agent's API_DOCS must be agent.apiDocs and nothing else: each environment's parameter file says whether its agent serves the docs");
    if (!fromParam(env, "API_DOCS_CLIENT_ID", `[if(${AG}.apiDocs, ${AG}.clientId, '')]`)) v.push("rule 23: the agent's API_DOCS_CLIENT_ID must be agent.clientId while agent.apiDocs is on, and empty otherwise");
    if (!fromParam(env, "AGENT_DESKTOP_CLIENT_ID", `[${AG}.desktopClientId]`)) v.push(DESKTOP_ID);
  }
  const callers: [string, Res | undefined][] = [["the regression job", regression], ["the smoke job", smoke]];
  for (const [what, job] of callers) {
    if (!job) {
      // Rule 9 reports a missing regression job.
      if (what === "the smoke job") v.push(`rule 23: the smoke job ${MN.jobs.smoke} is missing`);
      continue;
    }
    const container = containersOf(job)[0];
    if (!alwaysReferenced(job, container?.name ?? "", { MACHINE_CLIENT_KEY: MACHINE_SECRET }, "l1")) v.push(`rule 23: ${what} must reference the l1 vault's ${MACHINE_SECRET}, as MACHINE_CLIENT_KEY`);
    for (const [name, want] of Object.entries({ ...TENANT, MACHINE_CLIENT_ID: `[${AG}.machineClientId]`, MACHINE_CLIENT_KEY_ID: `[${AG}.machineKeyId]` })) {
      if (!fromParam(container?.env, name, want)) v.push(`rule 23: ${what}'s ${name} must come from the ${name.startsWith("AUTH_") ? "identity" : "agent"} parameter`);
    }
  }
  if (smoke) {
    const container = containersOf(smoke)[0];
    const env = container?.env ?? [];
    if (JSON.stringify(container?.command) !== JSON.stringify(["node", "dist/src/smoke-main.js"])) v.push("rule 23: the smoke job's own command must be the smoke client: deploy.yml starts it without an override");
    if (JSON.stringify(env.map((e) => e.name).sort()) !== JSON.stringify([...SMOKE_ENV].sort()) || secretsOf(smoke).length !== 1) {
      v.push(`rule 23: the smoke job must get exactly ${SMOKE_ENV.join(", ")}, and one secret: it calls the agent's public API only, with no role token`);
    }
    const address = (name: string) => JSON.stringify(resolved(env.find((e) => e.name === name)?.value ?? "", smoke.vars, devParams.main!));
    const labelled = agentApp !== undefined && JSON.stringify(configOf(agentApp).ingress ?? {}).includes("'label', 'candidate'");
    if (address("AGENT_URL") !== JSON.stringify([`https://${MN.apps.l1}.*`]) || address("AGENT_CANDIDATE_URL") !== JSON.stringify([`https://${MN.apps.l1}---candidate.*`]) || !labelled) {
      v.push("rule 23: the smoke job's AGENT_URL must be the agent's address, and AGENT_CANDIDATE_URL the address of its candidate label, which the agent's new revision gets");
    }
  }
  for (const [file, p] of Object.entries(params).filter(([f]) => /^main\.[a-z0-9]+\.bicepparam$/.test(f))) {
    const ag = (p.agent ?? {}) as Json;
    const keys = Object.keys(ag);
    if (JSON.stringify([...keys].sort()) !== JSON.stringify([...AGENT_KEYS].sort())) v.push(`rule 23: ${file}'s agent must have exactly the keys ${AGENT_KEYS.join(", ")} (it has ${keys.join(", ")})`);
    else if (typeof ag.apiDocs !== "boolean" || ["clientId", "desktopClientId", "machineClientId", "machineKeyId"].some((k) => typeof ag[k] !== "string")) v.push(`rule 23: ${file}'s agent.apiDocs must be true or false, and its four IDs strings`);
  }
  const unitsChecked = `or(not(contains(createArray('l1', 'l2'), parameters('unit'))), and(and(and(startsWith(${ID}.issuer, 'https://'), endsWith(${ID}.issuer, '/')), not(empty(${ID}.audience))), not(empty(${AG}.clientId))))`;
  const docsChecked = `or(or(not(equals(parameters('unit'), 'l1')), not(${AG}.apiDocs)), not(empty(${AG}.clientId)))`;
  const machineChecked = `or(not(equals(parameters('unit'), 'l1')), and(not(empty(${AG}.machineClientId)), not(empty(${AG}.machineKeyId))))`;
  const agentChecked = String(((arms.main.variables ?? {}) as Json).agentChecked ?? "");
  if (!agentChecked.startsWith(`[if(and(and(${unitsChecked}, ${docsChecked}), ${machineChecked}), ${AG}.apiDocs, fail(`)) v.push(AGENT_CHECK);

  // Rule 24 (Phase 3, SPEC 1.19): the ledger's MAC key. L2's control container always references the l2 vault's
  // ledger-mac-key, as LEDGER_MAC_KEY, so every environment seeds it (the placeholder off until an operator seeds a
  // real key). No other app, job or container holds the secret or the variable (the operator job verifies the chain
  // through L2), and it is never a literal (rule 8).
  if (l2 && !alwaysReferenced(l2, "l2", MAC_SECRET, "l2")) v.push(`rule 24: ${MN.apps.l2}/l2 must always reference the l2 vault's ledger-mac-key, as LEDGER_MAC_KEY`);
  for (const a of apps(main)) {
    const isL2 = namesOf(a).includes(MN.apps.l2);
    for (const s of secretsOf(a)) {
      if ((s.name === MAC_SECRET.LEDGER_MAC_KEY || String(s.keyVaultUrl ?? "").includes(`secrets/${MAC_SECRET.LEDGER_MAC_KEY}`)) && !isL2) v.push(`rule 24: ${label(a)} has the ledger's MAC key`);
    }
    for (const c of containersOf(a)) {
      const mine = isL2 && c.name === "l2";
      for (const e of c.env ?? []) {
        if ((e.name === "LEDGER_MAC_KEY" || e.secretRef === MAC_SECRET.LEDGER_MAC_KEY) && !mine) v.push(`rule 24: ${e.name} in ${label(a)}/${c.name}: only L2's control container holds the ledger's MAC key`);
        // One secret, one variable: the key never arrives under another name, nor another secret under its name.
        if (mine && (e.name === "LEDGER_MAC_KEY") !== (e.secretRef === MAC_SECRET.LEDGER_MAC_KEY)) v.push(`rule 24: ${e.name} in ${label(a)}/${c.name} must be the ledger-mac-key secret and nothing else`);
      }
    }
  }

  // Rule 25 (1.23, SPEC L2-4, SEC-39; finding #7): the ledger's head. One StorageV2 account, names.ledgerHead, that
  // takes Entra sign-in only (no account key, no anonymous access, HTTPS with TLS 1.2) and only the x402 subnet, with
  // one private container, ledger-head. One role there: Storage Blob Data Contributor on the container, for the head
  // identity (names.identities.l2head), which pre-deploy makes (v1.25; the module looks it up). Only L2's control app has that identity (at lifecycle
  // Main, rule 6), and only its l2 container gets LEDGER_HEAD_URL, the container's address built from names, and
  // LEDGER_HEAD_CLIENT_ID, that identity's client ID. Without it L2 would keep no head, and a cut ledger would open.
  const head = main.filter((r) => r.module === "ledger-head");
  const headAccounts = main.filter((r) => r.type === "Microsoft.Storage/storageAccounts" && String(nameExpr(r)) === "[parameters('names').ledgerHead]");
  const ha = headAccounts[0]?.properties ?? {};
  const headAcls = (ha.networkAcls ?? {}) as Json;
  const headSubnets = (headAcls.virtualNetworkRules ?? []) as { id: string; action?: string }[];
  if (headAccounts.length !== 1 || headAccounts[0]!.module !== "ledger-head" || headAccounts[0]!.raw.kind !== "StorageV2" || ha.allowSharedKeyAccess !== false || ha.allowBlobPublicAccess !== false || ha.supportsHttpsTrafficOnly !== true || ha.minimumTlsVersion !== "TLS1_2") {
    v.push("rule 25: the ledger head's storage account (names.ledgerHead, StorageV2) must take Entra sign-in only: no account key, no anonymous access, HTTPS with TLS 1.2");
  }
  if (headAcls.defaultAction !== "Deny" || headAcls.bypass !== "None" || headSubnets.length !== 1 || !String(headSubnets[0]!.id).includes("parameters('names').subnets.x402)") || "ipRules" in headAcls) {
    v.push("rule 25: the ledger head's storage account must deny by default and allow only the x402 subnet");
  }
  const headContainers = head.filter((r) => r.type === "Microsoft.Storage/storageAccounts/blobServices/containers");
  if (headContainers.length !== 1 || !/'ledger-head'\)\]$/.test(headContainers[0]!.name) || headContainers[0]!.properties.publicAccess !== "None") v.push("rule 25: the ledger head must have one private container, ledger-head");
  const headRoles = main.filter((r) => r.type === "Microsoft.Authorization/roleAssignments" && (r.module === "ledger-head" || JSON.stringify(r.raw).includes("parameters('names').ledgerHead")));
  if (headRoles.length !== 1 || headRoles[0]!.module !== "ledger-head" || !roleOf(headRoles[0]!).includes(BLOB_CONTRIBUTOR) || !String(headRoles[0]!.raw.scope).startsWith(HEAD_CONTAINER_SCOPE) || !String(headRoles[0]!.properties.principalId).includes(HEAD_IDENTITY)) {
    v.push("rule 25: only the head identity may write the ledger's head: Storage Blob Data Contributor on the ledger-head container only");
  }
  // v1.25: pre-deploy makes the head identity with the others (so the deploy app's condition admits its role); main only looks it up.
  if (!("l2head" in (PN.identities ?? {}))) v.push("rule 25: pre-deploy must make the head identity, names.identities.l2head");
  for (const a of apps(main)) {
    const isL2 = namesOf(a).includes(MN.apps.l2);
    if (JSON.stringify(a.raw.identity ?? {}).includes(HEAD_IDENTITY) && !isL2) v.push(`rule 25: ${label(a)} has the ledger head's identity`);
    for (const c of containersOf(a)) {
      const mine = isL2 && c.name === "l2";
      for (const e of (c.env ?? []).filter((x) => x.name.startsWith("LEDGER_HEAD_"))) if (!mine) v.push(`rule 25: ${e.name} in ${label(a)}/${c.name}: only L2's control container writes the ledger's head`);
    }
  }
  if (l2) {
    const env = containersOf(l2).find((c) => c.name === "l2")?.env ?? [];
    const url = env.find((e) => e.name === "LEDGER_HEAD_URL");
    const client = env.find((e) => e.name === "LEDGER_HEAD_CLIENT_ID");
    if (url?.value !== HEAD_URL || url.secretRef !== undefined) v.push(`rule 25: ${MN.apps.l2}/l2 must get LEDGER_HEAD_URL, the ledger-head container of names.ledgerHead (${HEAD_URL})`);
    if (!String(client?.value ?? "").includes(HEAD_IDENTITY) || !String(client?.value).endsWith(".clientId]") || !JSON.stringify(l2.raw.identity ?? {}).includes(HEAD_IDENTITY)) {
      v.push(`rule 25: ${MN.apps.l2} must have the head identity, and its l2 container that identity's client ID as LEDGER_HEAD_CLIENT_ID`);
    }
    if (!JSON.stringify(deployment(main, "l2-apps")?.raw.dependsOn ?? []).includes("'ledger-head'")) v.push("rule 25: L2's apps must be deployed after the ledger's head");
  }

  // Rule 26 (020, SPEC CFG-2 and §3.3; specs/020 contracts/config-and-secrets.md "Azure"): the portal's Coinbase
  // connection. The portal always references the portal vault's coinbase-client-secret and coinbase-grant-key, as
  // COINBASE_CLIENT_SECRET and COINBASE_GRANT_KEY, in arrays no flag can empty, so every environment seeds both (the
  // placeholder off while userAccounts.coinbase.enabled is false); each secret arrives under its one name only, and
  // never from another vault. No other app, job or container references either, or gets a Coinbase setting, and no
  // template writes either into a vault. CONNECTED_PLATFORMS is coinbase exactly when userAccounts.coinbase.enabled
  // is true, and the portal's other Coinbase values come from userAccounts.coinbase, which main refuses (fail())
  // enabled without user accounts, the project's client, a redirect at the portal's own https://…/wallet/coinbase,
  // and the two addresses Coinbase's terms ask for. The portal stays one process (one replica at most, single
  // revision): each person's rotating refresh token is serialized there (research R5). The grants live in the
  // portal's share, in their own folder beside PROFILE_DIR, never inside it.
  const CB = `${UA}.coinbase`;
  const isCoinbaseSecret = (s: { name: string; keyVaultUrl?: string }) => Object.values(COINBASE_SECRETS).some((x) => s.name === x || String(s.keyVaultUrl ?? "").includes(`secrets/${x}`));
  /** An app's secrets as a list: an expression (a flag's concat) is reported by alwaysReferenced, not read here. */
  const secretList = (a: Res) => (Array.isArray(configOf(a).secrets) ? secretsOf(a) : []);
  if (portal) {
    if (!alwaysReferenced(portal, "portal", COINBASE_SECRETS, "portal")) {
      v.push(`rule 26: ${MN.apps.portal}/portal must always reference the portal vault's ${Object.values(COINBASE_SECRETS).join(" and ")}, as ${Object.keys(COINBASE_SECRETS).join(" and ")}`);
    }
    for (const s of secretList(portal).filter(isCoinbaseSecret)) {
      if (s.value !== undefined || JSON.stringify(vaultKeysOf(portal, s.keyVaultUrl)) !== '["portal"]') v.push(`rule 26: ${label(portal)}'s ${s.name} must be a reference to the portal vault`);
    }
    const env = containersOf(portal).find((c) => c.name === "portal")?.env ?? [];
    for (const e of env) {
      // One secret, one variable: a Coinbase secret never arrives under another name, nor another secret under its name.
      for (const [name, secret] of Object.entries(COINBASE_SECRETS)) {
        if ((e.name === name) !== (e.secretRef === secret)) v.push(`rule 26: ${e.name} in ${label(portal)}/portal must be the ${secret} secret and nothing else`);
      }
    }
    if (!fromParam(env, "CONNECTED_PLATFORMS", `[if(${CB}.enabled, 'coinbase', '')]`)) v.push("rule 26: the portal's CONNECTED_PLATFORMS must be coinbase exactly when userAccounts.coinbase.enabled is true, and empty otherwise");
    const FROM_COINBASE: Record<string, string> = { COINBASE_CLIENT_ID: "clientId", COINBASE_REDIRECT_URI: "redirectUri", PRIVACY_POLICY_URL: "privacyPolicyUrl", SUPPORT_URL: "supportUrl" };
    for (const [name, key] of Object.entries(FROM_COINBASE)) if (!fromParam(env, name, `[${CB}.${key}]`)) v.push(`rule 26: the portal's ${name} must come from userAccounts.coinbase`);
    const scale = ((portal.properties.template as Json)?.scale ?? {}) as Json;
    if (scale.maxReplicas !== 1 || configOf(portal).activeRevisionsMode !== "Single") {
      v.push(`rule 26: ${MN.apps.portal} must run one replica at most, in single revision mode: one process serializes each person's rotating Coinbase refresh token`);
    }
    // The grants' folder: an absolute, normalized literal in the profiles share's mount, a sibling of PROFILE_DIR.
    const nfs = volumesOf(portal).find((x) => x.storageType === "NfsAzureFile" && storageOf(portal, x) === "profiles");
    const share = containersOf(portal).find((c) => c.name === "portal")?.volumeMounts?.find((m) => m.volumeName === nfs?.name)?.mountPath;
    const literalPath = (name: string) => {
      const e = env.find((x) => x.name === name);
      const p = e?.secretRef === undefined && typeof e?.value === "string" && !e.value.startsWith("[") ? e.value : undefined;
      return p !== undefined && posix.isAbsolute(p) && posix.normalize(p) === p ? p : undefined;
    };
    const grants = literalPath("CONNECTION_DIR");
    const profiles = literalPath("PROFILE_DIR");
    if (share === undefined || grants === undefined || profiles === undefined || !grants.startsWith(`${share}/`) || posix.dirname(grants) !== posix.dirname(profiles) || grants === profiles) {
      v.push("rule 26: the portal's CONNECTION_DIR must be a folder of its own beside PROFILE_DIR, in the portal's share");
    }
  }
  for (const a of apps(main)) {
    const isPortal = namesOf(a).includes(MN.apps.portal);
    // Read as text, so a secret inside an expression (a flag's concat) is found too.
    const secretText = JSON.stringify(configOf(a).secrets ?? []);
    for (const secret of Object.values(COINBASE_SECRETS)) if (secretText.includes(secret) && !isPortal) v.push(`rule 26: ${label(a)} has a Coinbase secret (${secret})`);
    for (const c of containersOf(a)) {
      const mine = isPortal && c.name === "portal";
      for (const e of c.env ?? []) {
        if ((/^(COINBASE_\w+|CONNECTED_PLATFORMS|CONNECTION_DIR)$/.test(e.name) || Object.values(COINBASE_SECRETS).includes(String(e.secretRef))) && !mine) v.push(`rule 26: ${e.name} in ${label(a)}/${c.name}: only the portal connects platforms`);
      }
    }
  }
  for (const r of all.filter((x) => x.type === "Microsoft.KeyVault/vaults/secrets")) {
    for (const secret of Object.values(COINBASE_SECRETS)) if (withVars(r.name, r.vars).includes(secret)) v.push(`rule 26: no template may write ${secret} into a vault: the portal vault's Coinbase secrets are seeded by hand`);
  }
  const coinbaseChecked = String(((arms.main.variables ?? {}) as Json).coinbaseChecked ?? "");
  const coinbaseParts = `and(and(and(and(and(${UA}.enabled, not(empty(${CB}.clientId))), startsWith(${CB}.redirectUri, 'https://')), endsWith(${CB}.redirectUri, '/wallet/coinbase')), not(empty(${CB}.privacyPolicyUrl))), not(empty(${CB}.supportUrl)))`;
  if (!coinbaseChecked.startsWith(`[if(or(not(${CB}.enabled), ${coinbaseParts}), ${CB}.enabled, fail(`)) v.push(COINBASE_CHECK);
  // Each environment's parameter file: coinbase has exactly the keys the templates read, and is on only with what
  // main's fail() would ask for at deployment (found here first).
  for (const [file, p] of Object.entries(params).filter(([f]) => /^main\.[a-z0-9]+\.bicepparam$/.test(f))) {
    const accounts = (p.userAccounts ?? {}) as Json;
    const cb = (accounts.coinbase ?? {}) as Json;
    const keys = Object.keys(cb).sort();
    if (JSON.stringify(keys) !== JSON.stringify(COINBASE_KEYS)) v.push(`rule 26: ${file}'s userAccounts.coinbase must have exactly the keys ${COINBASE_KEYS.join(", ")} (it has ${keys.join(", ")})`);
    else if (typeof cb.enabled !== "boolean" || COINBASE_KEYS.some((k) => k !== "enabled" && typeof cb[k] !== "string")) v.push(`rule 26: ${file}'s userAccounts.coinbase.enabled must be true or false, and its other values strings`);
    else if (cb.enabled && !(accounts.enabled === true && cb.clientId !== "" && String(cb.redirectUri).startsWith("https://") && String(cb.redirectUri).endsWith("/wallet/coinbase") && cb.privacyPolicyUrl !== "" && cb.supportUrl !== "")) {
      v.push(`rule 26: ${file} turns Coinbase on without userAccounts.enabled, a clientId, a redirectUri of the form https://…/wallet/coinbase, a privacyPolicyUrl and a supportUrl`);
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

  /** A copy of infra/ with one edit (or, with `also`, several in the same file), compiled. */
  async function mutant(file: string, from: string, to: string, also: [from: string, to: string][] = []): Promise<string[]> {
    const dir = mkdtempSync(join(tmpdir(), "infra-mutant-"));
    tmp.push(dir);
    cpSync("infra", dir, { recursive: true });
    const path = join(dir, file);
    let text = readFileSync(path, "utf8");
    for (const [a, b] of [[from, to] as [string, string], ...also]) {
      expect(text.includes(a), `${file} contains the mutation anchor ${a}`).toBe(true);
      text = text.replace(a, () => b);
    }
    writeFileSync(path, text);
    const { arms, params } = await compile(dir);
    return violations(arms, params, infraSources(dir));
  }

  it("T-IAC-01 the real templates and parameter files pass rules 1–26", async () => {
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
    expect(onPortal).toContain(`rule 21: USER_WALLET_MNEMONIC in ${N.main.apps.portal}/portal`);
    const literal = await mutant("modules/l2-apps.bicep", "{ name: 'USER_WALLET_MNEMONIC', secretRef: 'user-wallet-mnemonic' }", "{ name: 'USER_WALLET_MNEMONIC', value: 'off' }");
    expect(literal).toContain("rule 2: USER_WALLET_MNEMONIC is not a secret reference");
    expect(literal).toContain(`rule 8: ${N.main.apps.l2}/l2 USER_WALLET_MNEMONIC is a literal`);
  }, 120_000);

  it("T-IAC-01 must-fail rule 2: the portal reading the l2 vault is reported", async () => {
    const v = await mutant("modules/portal-apps.bicep", "keyVaultUrl: '${vaultPortal}secrets/portal-token'", "keyVaultUrl: 'https://${names.vaults.l2}${az.environment().suffixes.keyvaultDns}/secrets/portal-token'");
    expect(v).toContain(`rule 2: ${N.main.apps.portal} reads the l2 vault`);
    expect(v).toContain("rule 13: portal-apps looks up vaults l2,portal, not its own (portal)");
    expect(v).toContain(`rule 21: ${N.main.apps.portal} reads portal-token from a vault other than the portal's`);
  }, 60_000);

  it("T-IAC-01 must-fail rule 3: a public service that doesn't trust the ingress for the client's address is reported", async () => {
    const v = await mutant("modules/portal-apps.bicep", "            { name: 'TRUSTED_PROXY_HOPS', value: '1' }\n", "");
    expect(v).toContain(`rule 3: ${N.main.apps.portal}/portal is behind the ingress and must set TRUSTED_PROXY_HOPS to 1, for its per-address request limit`);
    const two = await mutant("modules/l1-apps.bicep", "{ name: 'TRUSTED_PROXY_HOPS', value: '1' }", "{ name: 'TRUSTED_PROXY_HOPS', value: '2' }");
    expect(two).toContain(`rule 3: ${N.main.apps.l1}/agent is behind the ingress and must set TRUSTED_PROXY_HOPS to 1, for its per-address request limit`);
    // v1.24: the sellers too (one template line deploys both)
    const seller = await mutant("modules/sellers.bicep", "            { name: 'TRUSTED_PROXY_HOPS', value: '1' }\n", "");
    for (const app of [N.main.apps.seller, N.main.apps.sellerAlias]) {
      expect(seller).toContain(`rule 3: ${app}/seller is behind the ingress and must set TRUSTED_PROXY_HOPS to 1, for its per-address request limit`);
    }
  }, 180_000);

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
    expect(v.some((m) => m.startsWith(`rule 21: ${N.main.apps.portal}/portal must always reference the portal vault's`))).toBe(true);
  }, 60_000);

  it("T-IAC-01 must-fail rule 9: ALLOWED_HOSTS pointing at the alias seller is reported", async () => {
    const v = await mutant("modules/l2-apps.bicep", "var sellerHost = '${names.apps.seller}.${sellerDomain}'", "var sellerHost = '${names.apps.sellerAlias}.${sellerDomain}'");
    expect(v).toContain("rule 9: ALLOWED_HOSTS must be the seller's FQDN, not the alias");
    expect(v).toContain("rule 21: PLATFORM_SELLERS must be one seller: ALLOWED_HOSTS' own host, userAccounts.sellerName and sellerPayTo");
  }, 60_000);

  it("T-IAC-01 must-fail rule 10: a vault firewall that allows by default is reported", async () => {
    const v = await mutant("modules/vault.bicep", "defaultAction: 'Deny'", "defaultAction: 'Allow'");
    expect(v).toContain("rule 10: vault firewall default is not Deny");
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
    const v = await mutant("main.bicep", "dependsOn: [registry, vaults, envs, foundry]", "dependsOn: [registry, envs, foundry]");
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

  it("T-IAC-01 must-fail rule 15: the retired portal web app's name, or the retired API app's, back in the parameter file is reported", async () => {
    const v = await mutant("pre-deploy.dev.bicepparam", "  deployApp: 'app-deploy-${location}-${environment}'\n", "  deployApp: 'app-deploy-${location}-${environment}'\n  portalApp: 'app-portal-${location}-${environment}'\n");
    expect(v).toContain("rule 15: pre-deploy.dev.bicepparam's names.portalApp is not a standard name");
    // 016: the directory holds no app for the agent's callers, so its name is no longer one of the standard's.
    const api = await mutant("pre-deploy.dev.bicepparam", "  deployApp: 'app-deploy-${location}-${environment}'\n", "  deployApp: 'app-deploy-${location}-${environment}'\n  apiApp: 'app-l1-${location}-${environment}'\n");
    expect(api).toContain("rule 15: pre-deploy.dev.bicepparam's names.apiApp is not a standard name");
  }, 120_000);

  it("T-IAC-01 must-fail rules 12 and 15: a smoke job that runs an entry point L1's image doesn't contain, or whose name is outside the standard, is reported", async () => {
    const entry = await mutant("modules/l1-apps.bicep", "command: ['node', 'dist/src/smoke-main.js']", "command: ['node', 'dist/scripts/ledger-verify.js']");
    expect(entry).toContain(`rule 12: ${N.main.jobs.smoke}/smoke runs dist/scripts/ledger-verify.js, which the l1-agent image doesn't contain`);
    expect(entry).toContain("rule 23: the smoke job's own command must be the smoke client: deploy.yml starts it without an override");
    const name = await mutant("main.dev.bicepparam", "    smoke: 'caj-smoke-${location}-${environment}'", "    smoke: 'caj-agent-smoke-${location}-${environment}'");
    expect(name).toContain(`rule 15: main.dev.bicepparam's names.jobs.smoke is caj-agent-smoke-${N.location}-dev, not the standard ${N.main.jobs.smoke}`);
    // Without the job, its name is declared but not deployed, and rule 23 misses it.
    const start = "// ---------------------------------------------------------------------------------------------\n// Smoke job (016";
    const text = readFileSync("infra/modules/l1-apps.bicep", "utf8");
    const whole = text.slice(text.indexOf(start), text.indexOf("output agentFqdn"));
    const none = await mutant("modules/l1-apps.bicep", whole, "");
    expect(none).toContain(`rule 15: names.jobs.smoke ${N.main.jobs.smoke} is in the parameter file but not deployed`);
    expect(none).toContain(`rule 23: the smoke job ${N.main.jobs.smoke} is missing`);
  }, 180_000);

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
    expect(v).toContain(FIC_PROBLEM);
    const plain = await mutant(
      "pre-deploy.bicep",
      "var githubSubject = 'repo:${split(githubRepository, '/')[0]}@${githubOwnerId}/${split(githubRepository, '/')[1]}@${githubRepositoryId}:environment:${githubEnvironment}'",
      "#disable-next-line no-unused-params\nvar githubSubject = 'repo:${githubRepository}:environment:${githubEnvironment}'",
    );
    expect(plain).toContain(FIC_PROBLEM);
    // SPEC 1.26: the Auth0 job's credential, back again.
    const second = await mutant(
      "pre-deploy.bicep",
      "resource deploySp 'Microsoft.Graph/servicePrincipals@v1.0' = {",
      "resource auth0Credential 'Microsoft.Graph/applications/federatedIdentityCredentials@v1.0' = {\n  name: '${deployApp.uniqueName}/github-auth0-${githubEnvironment}'\n  audiences: ['api://AzureADTokenExchange']\n  issuer: 'https://token.actions.githubusercontent.com'\n  subject: 'repo:${split(githubRepository, '/')[0]}@${githubOwnerId}/${split(githubRepository, '/')[1]}@${githubRepositoryId}:environment:auth0-${githubEnvironment}'\n  dependsOn: [githubCredential]\n}\n\nresource deploySp 'Microsoft.Graph/servicePrincipals@v1.0' = {",
    );
    expect(second).toContain(FIC_PROBLEM);
  }, 60_000);

  it("T-IAC-01 must-fail rule 20 (SPEC 1.26): a storage account for the Terraform state in pre-deploy, or a role on it, is reported", async () => {
    const account = await mutant(
      "modules/identities.bicep",
      "output ids array",
      "resource st 'Microsoft.Storage/storageAccounts@2023-05-01' = {\n  name: 'sttfstate${location}'\n  location: location\n  kind: 'StorageV2'\n  sku: { name: 'Standard_LRS' }\n}\n\noutput ids array",
    );
    expect(account).toContain(NO_STATE_IN_AZURE);
    const role = await mutant(
      "modules/no-federated-credentials.bicep",
      "param names object",
      "param names object\n\nresource stateAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {\n  name: guid(resourceGroup().id, 'tfstate')\n  properties: {\n    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')\n    principalId: '00000000-0000-0000-0000-000000000000'\n    principalType: 'ServicePrincipal'\n  }\n}",
    );
    expect(role).toContain(NO_STATE_IN_AZURE);
  }, 120_000);

  it("T-IAC-01 must-fail rule 16 (SPEC 1.26): the Auth0 job's GitHub environment back in pre-deploy is reported", async () => {
    const v = await mutant(
      "pre-deploy.bicep",
      "param githubEnvironment string",
      "param githubEnvironment string\n#disable-next-line no-unused-params\nparam githubAuth0Environment string = 'auth0-dev'",
    );
    expect(v).toContain("rule 16: pre-deploy must have no githubAuth0Environment parameter: the Auth0 tenant's Terraform runs on the operator's host, so no Auth0 job signs in from GitHub (SPEC 1.26)");
  }, 60_000);

  it("T-IAC-01 must-fail rule 16: an unconditioned Role Based Access Control Administrator, or one that may grant Owner, is reported", async () => {
    const condition = /\n {4}conditionVersion: '2\.0'\n {4}condition: .*\n/.exec(readFileSync("infra/modules/deploy-access.bicep", "utf8"))![0];
    const v = await mutant("modules/deploy-access.bicep", condition, "\n");
    expect(v.some((m) => m.startsWith("rule 16: the deploy app's Role Based Access Control Administrator must be limited"))).toBe(true);
    const owner = await mutant("modules/deploy-access.bicep", "  'ba92f5b4-2d11-453d-a403-e96b0029c9fe'\n]", "  'ba92f5b4-2d11-453d-a403-e96b0029c9fe'\n  '8e3af657-a8ff-443c-a75c-2fe8c4bcb635'\n]");
    expect(owner.some((m) => m.startsWith("rule 16: the deploy app's Role Based Access Control Administrator must be limited"))).toBe(true);
  }, 60_000);

  it("T-IAC-01 must-fail rule 16 (Phase 3, v1.25): a condition that lets the deploy app give a role to a principal of its own choosing, itself included, or take one away from one, is reported", async () => {
    const write = " AND @Request[Microsoft.Authorization/roleAssignments:PrincipalId] ForAnyOfAnyValues:GuidEquals {${assignees}}";
    const remove = " AND @Resource[Microsoft.Authorization/roleAssignments:PrincipalId] ForAnyOfAnyValues:GuidEquals {${assignees}}";
    expect(await mutant("modules/deploy-access.bicep", write, "")).toEqual([ASSIGNEES_ONLY]);
    expect(await mutant("modules/deploy-access.bicep", remove, "")).toEqual([ASSIGNEES_ONLY]);
    const either = await mutant("modules/deploy-access.bicep", `{\${assignable}}${write}`, `{\${assignable}}${write.replace(" AND ", " OR ")}`);
    expect(either).toEqual([ASSIGNEES_ONLY]);
    // everyone but the list
    const inverted = await mutant("modules/deploy-access.bicep", "ForAnyOfAnyValues:GuidEquals {${assignees}}))'", "ForAnyOfAnyValues:GuidNotEquals {${assignees}}))'");
    expect(inverted).toEqual([ASSIGNEES_ONLY]);
    // the 1.19 condition: any principal but the deploy app itself (a run could give Key Vault Secrets User to anyone else)
    const selfOnly = await mutant("modules/deploy-access.bicep", write, " AND @Request[Microsoft.Authorization/roleAssignments:PrincipalId] ForAnyOfAllValues:GuidNotEquals {${principalId}}");
    expect(selfOnly).toEqual([ASSIGNEES_ONLY]);
  }, 180_000);

  it("T-IAC-01 must-fail rule 16 (v1.25): the deploy app among the principals it may give roles to, a principal list without the identities, or another principal added, is reported", async () => {
    const list = "assigneeIds: concat(map(ids.outputs.ids, i => i.principalId), [operatorsGroup.id])";
    expect(await mutant("pre-deploy.bicep", list, "assigneeIds: concat(map(ids.outputs.ids, i => i.principalId), [operatorsGroup.id, deploySp.id])")).toEqual([ASSIGNEES_PROBLEM]);
    expect(await mutant("pre-deploy.bicep", list, "assigneeIds: [operatorsGroup.id]")).toEqual([ASSIGNEES_PROBLEM]);
    expect(await mutant("pre-deploy.bicep", list, "assigneeIds: concat(map(ids.outputs.ids, i => i.principalId), [operatorsGroup.id, '00000000-0000-0000-0000-000000000001'])")).toEqual([ASSIGNEES_PROBLEM]);
  }, 120_000);

  it("T-IAC-01 must-fail rule 16 (v1.25): no policy against federated credentials, one that only audits or allows them, one at the subscription, or a federated credential in a template, is reported", async () => {
    expect(await mutant("modules/no-federated-credentials.bicep", "      effect: { value: 'Deny' }", "      effect: { value: 'Audit' }")).toEqual([NO_FIC]);
    expect(await mutant("modules/no-federated-credentials.bicep", "      allowFederatedCredentials: { value: false }", "      allowFederatedCredentials: { value: true }")).toEqual([NO_FIC]);
    expect(await mutant("modules/no-federated-credentials.bicep", "    enforcementMode: 'Default'", "    enforcementMode: 'DoNotEnforce'")).toEqual([NO_FIC]);
    const module = /\nmodule noFederatedCredentials [\s\S]*?\n\}\n/.exec(readFileSync("infra/pre-deploy.bicep", "utf8"))![0];
    const gone = await mutant("pre-deploy.bicep", module, "\n");
    expect(gone).toContain(NO_FIC);
    const fic = await mutant(
      "modules/l2-apps.bicep",
      "resource idL2 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: names.identities.l2 }\n",
      "resource idL2 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: names.identities.l2 }\nresource backdoor 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {\n  parent: idL2\n  name: 'gh'\n  properties: { issuer: 'https://token.actions.githubusercontent.com', subject: 'repo:someone/else:ref:refs/heads/main', audiences: ['api://AzureADTokenExchange'] }\n}\n",
    );
    expect(fic).toContain(NO_FIC);
  }, 180_000);

  it("T-IAC-01 must-fail rules 1 and 17 (v1.25): an identity made by main again, a unit without one in pre-deploy, or the two files naming different identities, is reported", async () => {
    const again = await mutant(
      "main.bicep",
      "module logs 'modules/logs.bicep' = if (platform) {",
      "module ids 'modules/identities.bicep' = if (platform) {\n  name: 'identities'\n  params: { location: location, names: names, keys: map(units, u => u.key) }\n}\n\nmodule logs 'modules/logs.bicep' = if (platform) {",
    );
    expect(again.some((m) => m.startsWith("rule 1: main makes the identity ") && m.includes(N.main.identities.l1))).toBe(true);
    expect(again).toContain("rule 18: the identities module belongs to no unit");
    const missing = await mutant("pre-deploy.dev.bicepparam", "    seller: 'id-seller-${location}-${environment}'\n", "");
    expect(missing).toContain("rule 1: pre-deploy makes no identity for unit seller");
    expect(missing).toContain("rule 17: pre-deploy.dev.bicepparam and main.dev.bicepparam name different identities: pre-deploy makes the ones main's apps look up");
    // 1.23's head identity too: its one role is refused unless pre-deploy makes it
    const noHead = await mutant("pre-deploy.dev.bicepparam", "    l2head: 'id-l2head-${location}-${environment}'\n", "");
    expect(noHead).toContain("rule 25: pre-deploy must make the head identity, names.identities.l2head");
  }, 180_000);

  it("T-IAC-01 must-fail rule 12: the portal on L2's image, or running an entry point its image doesn't contain, is reported", async () => {
    const image = await mutant("main.bicep", "image: '${acrServer}/x402-portal:${imageTag}'", "image: '${acrServer}/x402-l2-control:${imageTag}'");
    expect(image).toContain("rule 12: portal-apps's image is not x402-portal:<imageTag> from the platform's registry");
    const entry = await mutant("modules/portal-apps.bicep", "command: ['node', 'dist/src/portal-main.js']", "command: ['node', 'dist/src/layer2-control/service.js']");
    expect(entry).toContain(`rule 12: ${N.main.apps.portal}/portal runs dist/src/layer2-control/service.js, which the portal image doesn't contain`);
  }, 120_000);

  it("T-IAC-01 must-fail rule 16: a web app registered in Entra again, a redirect URI on the deploy app, the portal's origin as a parameter, or a third line in the output, is reported", async () => {
    const anchor = "// ---- The deploy app: what GitHub Actions sign in as";
    const webApp = "resource portalApp 'Microsoft.Graph/applications@v1.0' = {\n  uniqueName: names.operators\n  displayName: names.operators\n  signInAudience: 'AzureADMyOrg'\n  spa: {\n    redirectUris: ['http://localhost:4025/redirect.html']\n  }\n}\n\n";
    const again = await mutant("pre-deploy.bicep", anchor, `${webApp}${anchor}`);
    expect(again).toContain(ONE_REGISTRATION);
    expect(again).toContain(`rule 16: ${N.pre.operators} must have no spa: nobody signs in through it`);
    const redirect = await mutant("pre-deploy.bicep", "  uniqueName: names.deployApp\n  displayName: names.deployApp\n  signInAudience: 'AzureADMyOrg'\n", "  uniqueName: names.deployApp\n  displayName: names.deployApp\n  signInAudience: 'AzureADMyOrg'\n  web: {\n    redirectUris: ['https://portal.example/redirect.html']\n  }\n");
    expect(redirect).toContain(`rule 16: ${N.pre.deployApp} must have no web: nobody signs in through it`);
    const origin = await mutant("pre-deploy.bicep", "param operators array\n", "param operators array\n#disable-next-line no-unused-params\nparam portalOrigin string = ''\n");
    expect(origin).toContain("rule 16: pre-deploy must have no portalOrigin parameter: the portal's origin is a Terraform variable of auth0/");
    expect(origin).toContain("rule 17: pre-deploy.dev.bicepparam doesn't set portalOrigin");
    const third = await mutant("pre-deploy.bicep", "  'param operatorsGroupId = \\'${operatorsGroup.id}\\''\n", "  'param operatorsGroupId = \\'${operatorsGroup.id}\\''\n  'param userAccounts = { ..., portalClientId: \\'${deployApp.appId}\\', ... }'\n");
    expect(third).toContain(MAIN_PARAMETERS);
  }, 240_000);

  it("T-IAC-01 must-fail rule 16 (016): the directory's API app for the agent's callers registered again, its role assigned, its audience back in the output, an API on the deploy app, or agentUsers back, is reported", async () => {
    const anchor = "// ---- The deploy app: what GitHub Actions sign in as";
    // What 011 made: an app with the Agent.Run role and a service principal that requires assignment.
    const apiApp = [
      "resource apiApp 'Microsoft.Graph/applications@v1.0' = {",
      "  uniqueName: names.operators",
      "  displayName: names.operators",
      "  signInAudience: 'AzureADMyOrg'",
      "  api: { requestedAccessTokenVersion: 2 }",
      "  appRoles: [",
      "    { id: '5b2c3a7e-6f1d-4c55-9f0e-0a1b2c3d4e51', value: 'Agent.Run', displayName: 'Agent.Run', description: 'Run the agent', allowedMemberTypes: ['User', 'Application'], isEnabled: true }",
      "  ]",
      "}",
      "",
      "resource apiSp 'Microsoft.Graph/servicePrincipals@v1.0' = {",
      "  appId: apiApp.appId",
      "  appRoleAssignmentRequired: true",
      "}",
      "",
      "",
    ].join("\n");
    const again = await mutant("pre-deploy.bicep", anchor, `${apiApp}${anchor}`);
    expect(again).toContain(ONE_REGISTRATION);
    expect(again).toContain(`rule 16: ${N.pre.operators} must have no appRoles: no token is issued for an Entra app of ours`);
    expect(again).toContain("rule 16: the only service principal must be the deploy app's");
    // The deploy app given a role of that app again, as for the old smoke step, which asked for a token itself.
    const assignment = "resource deployAgentRun 'Microsoft.Graph/appRoleAssignedTo@v1.0' = {\n  appRoleId: '5b2c3a7e-6f1d-4c55-9f0e-0a1b2c3d4e51'\n  principalId: deploySp.id\n  resourceId: apiSp.id\n}\n\n";
    const operatorsAnchor = "// ---- Who may start the operator job";
    const assigned = await mutant("pre-deploy.bicep", anchor, `${apiApp}${anchor}`, [[operatorsAnchor, `${assignment}${operatorsAnchor}`]]);
    expect(assigned).toContain("rule 16: no app role may be assigned: the directory gives nobody access to the agent");
    const audience = await mutant("pre-deploy.bicep", "  'param deployClientId = \\'${deployApp.appId}\\''\n", "  'param deployClientId = \\'${deployApp.appId}\\''\n  'param authAudience = \\'${deployApp.appId}\\''\n");
    expect(audience).toEqual([MAIN_PARAMETERS]);
    const api = await mutant("pre-deploy.bicep", "  uniqueName: names.deployApp\n  displayName: names.deployApp\n  signInAudience: 'AzureADMyOrg'\n", "  uniqueName: names.deployApp\n  displayName: names.deployApp\n  signInAudience: 'AzureADMyOrg'\n  identifierUris: ['api://${names.deployApp}']\n  api: { requestedAccessTokenVersion: 2 }\n");
    expect(api).toContain(`rule 16: ${N.pre.deployApp} must have no api: no token is issued for an Entra app of ours`);
    expect(api).toContain(`rule 16: ${N.pre.deployApp} must have no identifierUris: no token is issued for an Entra app of ours`);
    const users = await mutant("pre-deploy.bicep", "param operators array\n", "param operators array\n#disable-next-line no-unused-params\nparam agentUsers array = []\n");
    expect(users).toContain("rule 16: pre-deploy must have no agentUsers parameter: who may run the agent is a role of the sign-in tenant (auth0/), assigned there");
    const retire = await mutant("pre-deploy.bicep", "param operators array\n", "param operators array\n#disable-next-line no-unused-params\nparam retirePortalScope bool = false\n");
    expect(retire).toContain("rule 16: pre-deploy must have no retirePortalScope parameter: the API app the scope belonged to is gone");
  }, 360_000);

  it("T-IAC-01 must-fail rule 22: the administration token as a literal, missing, read from L2's vault by the portal, under another secret, on another app, or a flag written in a template, is reported", async () => {
    const l2Always = `rule 22: ${N.main.apps.l2}/l2 must always reference the l2 vault's portal-admin-token, as PORTAL_ADMIN_TOKEN`;
    const portalAlways = `rule 22: ${N.main.apps.portal}/portal must always reference the portal vault's portal-admin-token, as PORTAL_ADMIN_TOKEN`;
    const missing = await mutant("modules/l2-apps.bicep", "            { name: 'PORTAL_ADMIN_TOKEN', secretRef: 'portal-admin-token' }\n", "");
    expect(missing).toContain(l2Always);
    const literal = await mutant(
      "modules/portal-apps.bicep",
      "        { name: 'portal-admin-token', keyVaultUrl: '${vaultPortal}secrets/portal-admin-token', identity: idPortal.id }",
      "        #disable-next-line use-secure-value-for-secure-inputs\n        { name: 'portal-admin-token', value: 'off' }",
    );
    expect(literal).toContain(portalAlways);
    // The portal's copy comes from the portal's own vault: read from L2's, it is not "its own" (and rule 2 sees the vault).
    const fromL2 = await mutant(
      "modules/portal-apps.bicep",
      "keyVaultUrl: '${vaultPortal}secrets/portal-admin-token'",
      "keyVaultUrl: 'https://${names.vaults.l2}${az.environment().suffixes.keyvaultDns}/secrets/portal-admin-token'",
    );
    expect(fromL2).toContain(portalAlways);
    expect(fromL2).toContain(`rule 2: ${N.main.apps.portal} reads the l2 vault`);
    const sameAsUser = await mutant("modules/portal-apps.bicep", "            { name: 'PORTAL_ADMIN_TOKEN', secretRef: 'portal-admin-token' }", "            { name: 'PORTAL_ADMIN_TOKEN', secretRef: 'portal-token' }");
    expect(sameAsUser).toContain(portalAlways);
    expect(sameAsUser).toContain(`rule 22: PORTAL_ADMIN_TOKEN in ${N.main.apps.portal}/portal must be the portal-admin-token secret and nothing else`);
    const flag = await mutant("modules/l2-apps.bicep", "            { name: 'PORTAL_ADMIN', value: userAccounts.administration ? '1' : '0' }", "            { name: 'PORTAL_ADMIN', value: '1' }");
    expect(flag).toContain("rule 22: L2's PORTAL_ADMIN must come from userAccounts.administration");
    const portalFlag = await mutant("modules/portal-apps.bicep", "            { name: 'PORTAL_ADMIN', value: userAccounts.administration ? '1' : '0' }", "            { name: 'PORTAL_ADMIN', value: userAccounts.enabled ? '1' : '0' }");
    expect(portalFlag).toContain("rule 22: the portal's PORTAL_ADMIN must come from userAccounts.administration");
    const onL3 = await mutant("modules/l3-apps.bicep", "            { name: 'VERIFIER_TOKEN', secretRef: 'verifier-token' }\n", "            { name: 'VERIFIER_TOKEN', secretRef: 'verifier-token' }\n            { name: 'PORTAL_ADMIN_TOKEN', secretRef: 'verifier-token' }\n");
    expect(onL3).toContain(`rule 22: PORTAL_ADMIN_TOKEN in ${N.main.apps.l3}/l3`);
    const unchecked = await mutant("main.bicep", " && (!userAccounts.administration || userAccounts.enabled)", "");
    expect(unchecked).toContain("rule 22: main must refuse (fail()) userAccounts.administration without userAccounts.enabled");
  }, 300_000);

  it("T-IAC-01 must-fail rule 24 (Phase 3): the ledger's MAC key missing, a literal, from another vault, under another name, or on another app, is reported", async () => {
    const always = `rule 24: ${N.main.apps.l2}/l2 must always reference the l2 vault's ledger-mac-key, as LEDGER_MAC_KEY`;
    const env = "            { name: 'LEDGER_MAC_KEY', secretRef: 'ledger-mac-key' }";
    const missing = await mutant("modules/l2-apps.bicep", `${env}\n`, "");
    expect(missing).toEqual([always]);
    const literal = await mutant("modules/l2-apps.bicep", env, "            { name: 'LEDGER_MAC_KEY', value: 'off' }");
    expect(literal).toEqual(expect.arrayContaining([always, `rule 8: ${N.main.apps.l2}/l2 LEDGER_MAC_KEY is a literal`, "rule 24: LEDGER_MAC_KEY in " + N.main.apps.l2 + "/l2 must be the ledger-mac-key secret and nothing else"]));
    const elsewhere = await mutant("modules/l2-apps.bicep", "keyVaultUrl: '${vaultL2}secrets/ledger-mac-key'", "keyVaultUrl: 'https://${names.vaults.l1}${az.environment().suffixes.keyvaultDns}/secrets/ledger-mac-key'");
    expect(elsewhere).toContain(always);
    const renamed = await mutant("modules/l2-apps.bicep", env, "            { name: 'LEDGER_KEY', secretRef: 'ledger-mac-key' }");
    expect(renamed).toEqual(expect.arrayContaining([always, `rule 24: LEDGER_KEY in ${N.main.apps.l2}/l2 must be the ledger-mac-key secret and nothing else`]));
    const onOperator = await mutant("modules/operator-apps.bicep", "            { name: 'OPERATOR_TOKEN', secretRef: 'operator-token' }\n", "            { name: 'OPERATOR_TOKEN', secretRef: 'operator-token' }\n            { name: 'LEDGER_MAC_KEY', secretRef: 'operator-token' }\n");
    expect(onOperator).toContain(`rule 24: LEDGER_MAC_KEY in ${N.main.jobs.l2}/operator: only L2's control container holds the ledger's MAC key`);
    const onL3 = await mutant("modules/l3-apps.bicep", "      secrets: [\n", "      secrets: [\n        { name: 'ledger-mac-key', keyVaultUrl: '${vaultL3}secrets/ledger-mac-key', identity: idL3.id }\n");
    expect(onL3).toContain(`rule 24: ${N.main.apps.l3} has the ledger's MAC key`);
  }, 180_000);

  it("T-IAC-01 must-fail rule 25 (1.23): a ledger head readable with an account key, open to the network, or writable by more than the head identity, is reported", async () => {
    const key = await mutant("modules/ledger-head.bicep", "allowSharedKeyAccess: false", "allowSharedKeyAccess: true");
    expect(key).toEqual(["rule 25: the ledger head's storage account (names.ledgerHead, StorageV2) must take Entra sign-in only: no account key, no anonymous access, HTTPS with TLS 1.2"]);
    const open = await mutant("modules/ledger-head.bicep", "defaultAction: 'Deny'", "defaultAction: 'Allow'");
    expect(open).toEqual(["rule 25: the ledger head's storage account must deny by default and allow only the x402 subnet"]);
    const ROLE = "rule 25: only the head identity may write the ledger's head: Storage Blob Data Contributor on the ledger-head container only";
    const wide = await mutant("modules/ledger-head.bicep", "  scope: container\n", "  scope: st\n");
    expect(wide).toEqual(expect.arrayContaining([ROLE, expect.stringMatching(/^rule 1: role assignment .* in ledger-head is not in the matrix$/)]));
    const owner = await mutant("modules/ledger-head.bicep", "var blobContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'", "var blobContributorRoleId = '8e3af657-a8ff-443c-a75c-2fe8c4bcb635'");
    expect(owner).toEqual(expect.arrayContaining([ROLE, expect.stringMatching(/^rule 16: the deploy app's Role Based Access Control Administrator must be limited to main.bicep's roles/)]));
    const agent = await mutant("modules/ledger-head.bicep", "    principalId: writer.properties.principalId\n", "    principalId: reference(resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', names.identities.l1), '2023-01-31').principalId\n");
    expect(agent).toEqual(expect.arrayContaining([ROLE, expect.stringMatching(/^rule 1: role assignment .* in ledger-head is not in the matrix$/)]));
  }, 180_000);

  it("T-IAC-01 must-fail rules 25 and 6 (1.23): L2 without its head, L2's own identity handed to its containers, or the head identity on another app, is reported", async () => {
    const url = "            { name: 'LEDGER_HEAD_URL', value: 'https://${names.ledgerHead}.blob.${az.environment().suffixes.storage}/ledger-head' }\n";
    const noHead = await mutant("modules/l2-apps.bicep", url, "");
    expect(noHead).toEqual([`rule 25: ${N.main.apps.l2}/l2 must get LEDGER_HEAD_URL, the ledger-head container of names.ledgerHead (${"[format('https://{0}.blob.{1}/ledger-head', parameters('names').ledgerHead, environment().suffixes.storage)]"})`]);
    const RULE_6 = `rule 6: ${N.main.apps.l2} identity lifecycle must be Main for the agent and for L2's head identity only, None otherwise`;
    expect(await mutant("modules/l2-apps.bicep", "{ identity: idL2.id, lifecycle: 'None' }", "{ identity: idL2.id, lifecycle: 'Main' }")).toEqual([RULE_6]);
    expect(await mutant("modules/l2-apps.bicep", "{ identity: idHead.id, lifecycle: 'Main' }", "{ identity: idHead.id, lifecycle: 'None' }")).toEqual([RULE_6]);
    const onAgent = await mutant(
      "modules/l1-apps.bicep",
      "  identity: { type: 'UserAssigned', userAssignedIdentities: { '${idL1.id}': {} } }\n",
      "  identity: { type: 'UserAssigned', userAssignedIdentities: { '${idL1.id}': {}, '${resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', names.identities.l2head)}': {} } }\n",
    );
    expect(onAgent).toEqual(expect.arrayContaining([`rule 25: ${N.main.apps.l1} has the ledger head's identity`, expect.stringMatching(/^rule 13: l1-apps looks up identities l1,l2head/)]));
    const early = await mutant("main.bicep", "  dependsOn: [registry, vaults, envs, ledgerHead]\n", "  dependsOn: [registry, vaults, envs]\n");
    expect(early).toEqual(["rule 25: L2's apps must be deployed after the ledger's head"]);
  }, 180_000);

  // ---- Rule 26 (020): the portal's Coinbase connection -----------------------------------------------------------
  const PORTAL_APPS = "modules/portal-apps.bicep";
  it("T-IAC-01 must-fail rule 26: a Coinbase secret missing, a literal, from another vault, behind a flag, under another name, on another app, or written into a vault by a template, is reported", async () => {
    const P = N.main.apps.portal;
    const always = `rule 26: ${P}/portal must always reference the portal vault's coinbase-client-secret and coinbase-grant-key, as COINBASE_CLIENT_SECRET and COINBASE_GRANT_KEY`;
    const KEY = "            { name: 'COINBASE_GRANT_KEY', secretRef: 'coinbase-grant-key' }";
    const SECRET = "            { name: 'COINBASE_CLIENT_SECRET', secretRef: 'coinbase-client-secret' }";
    expect(await mutant(PORTAL_APPS, `${KEY}\n`, "")).toEqual([always]);
    const literal = await mutant(PORTAL_APPS, KEY, "            { name: 'COINBASE_GRANT_KEY', value: 'off' }");
    expect(literal).toEqual(expect.arrayContaining([always, `rule 8: ${P}/portal COINBASE_GRANT_KEY is a literal`, `rule 26: COINBASE_GRANT_KEY in ${P}/portal must be the coinbase-grant-key secret and nothing else`]));
    const literalSecret = await mutant(
      PORTAL_APPS,
      "        { name: 'coinbase-client-secret', keyVaultUrl: '${vaultPortal}secrets/coinbase-client-secret', identity: idPortal.id }",
      "        #disable-next-line use-secure-value-for-secure-inputs\n        { name: 'coinbase-client-secret', value: 'off' }",
    );
    expect(literalSecret).toEqual(expect.arrayContaining([always, `rule 26: ${P}'s coinbase-client-secret must be a reference to the portal vault`]));
    // From L2's vault: not the portal's own (and rule 2 sees the vault).
    const fromL2 = await mutant(PORTAL_APPS, "keyVaultUrl: '${vaultPortal}secrets/coinbase-grant-key'", "keyVaultUrl: 'https://${names.vaults.l2}${az.environment().suffixes.keyvaultDns}/secrets/coinbase-grant-key'");
    expect(fromL2).toEqual(expect.arrayContaining([always, `rule 26: ${P}'s coinbase-grant-key must be a reference to the portal vault`, `rule 2: ${P} reads the l2 vault`]));
    // Behind the feature's flag, in the secrets array or in the variable's reference: an environment with it off would seed nothing.
    const flagged = await mutant(
      PORTAL_APPS,
      `      secrets: [\n${PORTAL_SECRET_LINES}\n      ]`,
      "      secrets: concat([{ name: 'portal-token', keyVaultUrl: '${vaultPortal}secrets/portal-token', identity: idPortal.id }, { name: 'card-vault-key', keyVaultUrl: '${vaultPortal}secrets/card-vault-key', identity: idPortal.id }, { name: 'portal-admin-token', keyVaultUrl: '${vaultPortal}secrets/portal-admin-token', identity: idPortal.id }], userAccounts.coinbase.enabled ? [{ name: 'coinbase-client-secret', keyVaultUrl: '${vaultPortal}secrets/coinbase-client-secret', identity: idPortal.id }, { name: 'coinbase-grant-key', keyVaultUrl: '${vaultPortal}secrets/coinbase-grant-key', identity: idPortal.id }] : [])",
    );
    expect(flagged).toContain(always);
    const flaggedRef = await mutant(PORTAL_APPS, KEY, "            { name: 'COINBASE_GRANT_KEY', secretRef: userAccounts.coinbase.enabled ? 'coinbase-grant-key' : 'portal-token' }");
    expect(flaggedRef).toEqual(expect.arrayContaining([always, `rule 26: COINBASE_GRANT_KEY in ${P}/portal must be the coinbase-grant-key secret and nothing else`]));
    // One secret, one variable.
    const otherSecret = await mutant(PORTAL_APPS, SECRET, "            { name: 'COINBASE_CLIENT_SECRET', secretRef: 'card-vault-key' }");
    expect(otherSecret).toEqual(expect.arrayContaining([always, `rule 26: COINBASE_CLIENT_SECRET in ${P}/portal must be the coinbase-client-secret secret and nothing else`]));
    const otherName = await mutant(PORTAL_APPS, KEY, "            { name: 'GRANT_KEY', secretRef: 'coinbase-grant-key' }");
    expect(otherName).toEqual(expect.arrayContaining([always, `rule 26: GRANT_KEY in ${P}/portal must be the coinbase-grant-key secret and nothing else`]));
    // Another app: a secret of its own vault, or a variable under the secret's name.
    const onL3 = await mutant("modules/l3-apps.bicep", "      secrets: [\n", "      secrets: [\n        { name: 'coinbase-grant-key', keyVaultUrl: '${vaultL3}secrets/coinbase-grant-key', identity: idL3.id }\n");
    expect(onL3).toContain(`rule 26: ${N.main.apps.l3} has a Coinbase secret (coinbase-grant-key)`);
    const onAgent = await mutant("modules/l1-apps.bicep", "            { name: 'CONTROL_TOKEN', secretRef: 'control-token' }\n            { name: 'VERIFIER_TOKEN'", "            { name: 'COINBASE_CLIENT_SECRET', secretRef: 'control-token' }\n            { name: 'CONTROL_TOKEN', secretRef: 'control-token' }\n            { name: 'VERIFIER_TOKEN'");
    expect(onAgent).toContain(`rule 26: COINBASE_CLIENT_SECRET in ${N.main.apps.l1}/agent: only the portal connects platforms`);
    // No template puts them in a vault, the portal's or another: they are seeded by hand.
    const written = `
resource kvL2 'Microsoft.KeyVault/vaults@2023-07-01' existing = { name: names.vaults.l2 }
resource leaked 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kvL2
  name: 'coinbase-grant-key'
  #disable-next-line use-secure-value-for-secure-inputs
  properties: { value: 'off' }
}
`;
    const inVault = await mutant("main.bicep", "// ---- The platform (", `${written}\n// ---- The platform (`);
    expect(inVault).toContain("rule 26: no template may write coinbase-grant-key into a vault: the portal vault's Coinbase secrets are seeded by hand");
  }, 600_000);

  it("T-IAC-01 must-fail rule 26: CONNECTED_PLATFORMS on without userAccounts.coinbase.enabled, a Coinbase setting written in a template or taken from another value, or one on another app, is reported", async () => {
    const PLATFORMS = "rule 26: the portal's CONNECTED_PLATFORMS must be coinbase exactly when userAccounts.coinbase.enabled is true, and empty otherwise";
    const ON = "{ name: 'CONNECTED_PLATFORMS', value: userAccounts.coinbase.enabled ? 'coinbase' : '' }";
    expect(await mutant(PORTAL_APPS, ON, "{ name: 'CONNECTED_PLATFORMS', value: 'coinbase' }")).toEqual([PLATFORMS]);
    expect(await mutant(PORTAL_APPS, ON, "{ name: 'CONNECTED_PLATFORMS', value: userAccounts.enabled ? 'coinbase' : '' }")).toEqual([PLATFORMS]);
    expect(await mutant(PORTAL_APPS, `            ${ON}\n`, "")).toEqual([PLATFORMS]);
    const from = (name: string) => `rule 26: the portal's ${name} must come from userAccounts.coinbase`;
    expect(await mutant(PORTAL_APPS, "{ name: 'COINBASE_CLIENT_ID', value: userAccounts.coinbase.clientId }", "{ name: 'COINBASE_CLIENT_ID', value: 'coinbase-client' }")).toEqual([from("COINBASE_CLIENT_ID")]);
    expect(await mutant(PORTAL_APPS, "{ name: 'COINBASE_REDIRECT_URI', value: userAccounts.coinbase.redirectUri }", "{ name: 'COINBASE_REDIRECT_URI', value: userAccounts.coinbase.supportUrl }")).toEqual([from("COINBASE_REDIRECT_URI")]);
    expect(await mutant(PORTAL_APPS, "            { name: 'PRIVACY_POLICY_URL', value: userAccounts.coinbase.privacyPolicyUrl }\n", "")).toEqual([from("PRIVACY_POLICY_URL")]);
    expect(await mutant(PORTAL_APPS, "{ name: 'SUPPORT_URL', value: userAccounts.coinbase.supportUrl }", "{ name: 'SUPPORT_URL', value: 'https://support.example.com/' }")).toEqual([from("SUPPORT_URL")]);
    const onL2 = await mutant("modules/l2-apps.bicep", "            { name: 'USER_ACCOUNTS', value: userAccounts.enabled ? '1' : '0' }\n", "            { name: 'USER_ACCOUNTS', value: userAccounts.enabled ? '1' : '0' }\n            { name: 'CONNECTED_PLATFORMS', value: userAccounts.coinbase.enabled ? 'coinbase' : '' }\n");
    expect(onL2).toEqual([`rule 26: CONNECTED_PLATFORMS in ${N.main.apps.l2}/l2: only the portal connects platforms`]);
  }, 600_000);

  it("T-IAC-01 must-fail rule 26: main without one part of its Coinbase check, or with a check that never fails, is reported", async () => {
    for (const part of ["(userAccounts.enabled && ", " && !empty(userAccounts.coinbase.clientId)", " && startsWith(userAccounts.coinbase.redirectUri, 'https://')", " && endsWith(userAccounts.coinbase.redirectUri, '/wallet/coinbase')", " && !empty(userAccounts.coinbase.privacyPolicyUrl)", " && !empty(userAccounts.coinbase.supportUrl)"]) {
      expect(await mutant("main.bicep", part, part.startsWith("(") ? "(" : ""), part).toEqual([COINBASE_CHECK]);
    }
    expect(await mutant("main.bicep", "var coinbaseChecked = !userAccounts.coinbase.enabled || (", "var coinbaseChecked = true || (")).toEqual([COINBASE_CHECK]);
  }, 600_000);

  it("T-IAC-01 must-fail rule 26: a parameter file whose coinbase has other keys or a switch that isn't true or false, or that turns Coinbase on without what main asks for, is reported", async () => {
    const KEYS = `rule 26: main.dev.bicepparam's userAccounts.coinbase must have exactly the keys ${COINBASE_KEYS.join(", ")}`;
    expect(await mutant("main.dev.bicepparam", DEV_COINBASE, DEV_COINBASE.replace(/\n {2}\}$/, "\n    scopes: 'wallet:accounts:read'\n  }"))).toEqual([`${KEYS} (it has clientId, enabled, privacyPolicyUrl, redirectUri, scopes, supportUrl)`]);
    expect(await mutant("main.dev.bicepparam", DEV_COINBASE, DEV_COINBASE.replace(/\n {4}supportUrl: [^\n]*/, ""))).toEqual([`${KEYS} (it has clientId, enabled, privacyPolicyUrl, redirectUri)`]);
    expect(await mutant("main.dev.bicepparam", DEV_COINBASE, DEV_COINBASE.replace(/enabled: (?:true|false)/, "enabled: 'false'"))).toEqual(["rule 26: main.dev.bicepparam's userAccounts.coinbase.enabled must be true or false, and its other values strings"]);
    const ON_WITHOUT = "rule 26: main.dev.bicepparam turns Coinbase on without userAccounts.enabled, a clientId, a redirectUri of the form https://…/wallet/coinbase, a privacyPolicyUrl and a supportUrl";
    const coinbase = (o: Partial<Record<"clientId" | "redirectUri" | "privacyPolicyUrl" | "supportUrl", string>> = {}) => {
      const x = { clientId: "coinbase-client", redirectUri: "https://portal.example.com/wallet/coinbase", privacyPolicyUrl: "https://portal.example.com/privacy", supportUrl: "mailto:support@example.com", ...o };
      return `  coinbase: {\n    enabled: true\n    clientId: '${x.clientId}'\n    redirectUri: '${x.redirectUri}'\n    privacyPolicyUrl: '${x.privacyPolicyUrl}'\n    supportUrl: '${x.supportUrl}'\n  }`;
    };
    const accountsOn: [string, string][] = [[DEV_ACCOUNTS_HEAD, DEV_ACCOUNTS_HEAD.replace(/enabled: (?:true|false)/, "enabled: true")]];
    // Not vacuous: with user accounts on and every value, Coinbase may be on.
    expect(await mutant("main.dev.bicepparam", DEV_COINBASE, coinbase(), accountsOn)).toEqual([]);
    const accountsOff: [string, string][] = [[DEV_ACCOUNTS_HEAD, DEV_ACCOUNTS_HEAD.replace(/enabled: (?:true|false)/, "enabled: false")]];
    expect(await mutant("main.dev.bicepparam", DEV_COINBASE, coinbase(), accountsOff)).toEqual([ON_WITHOUT]);
    for (const o of [{ clientId: "" }, { redirectUri: "http://localhost:4025/wallet/coinbase" }, { redirectUri: "https://portal.example.com/wallet" }, { privacyPolicyUrl: "" }, { supportUrl: "" }]) {
      expect(await mutant("main.dev.bicepparam", DEV_COINBASE, coinbase(o), accountsOn), JSON.stringify(o)).toEqual([ON_WITHOUT]);
    }
  }, 600_000);

  it("T-IAC-01 must-fail rule 26: a portal with two replicas or several revisions, or with its grants inside its profiles, outside its share, at a relative path or nowhere, is reported", async () => {
    const ONE = `rule 26: ${N.main.apps.portal} must run one replica at most, in single revision mode: one process serializes each person's rotating Coinbase refresh token`;
    expect(await mutant(PORTAL_APPS, "scale: { minReplicas: 0, maxReplicas: 1 }", "scale: { minReplicas: 0, maxReplicas: 2 }")).toEqual(expect.arrayContaining([ONE, expect.stringMatching(/^rule 4: .* must run one replica at most/)]));
    expect(await mutant(PORTAL_APPS, "activeRevisionsMode: 'Single'", "activeRevisionsMode: 'Multiple'")).toEqual(expect.arrayContaining([ONE, `rule 4: ${N.main.apps.portal} must use single revision mode`]));
    const DIR = "rule 26: the portal's CONNECTION_DIR must be a folder of its own beside PROFILE_DIR, in the portal's share";
    const AT = "{ name: 'CONNECTION_DIR', value: '/app/.local/portal/connections' }";
    for (const to of ["/app/.local/portal/profiles/connections", "/app/.local/portal/profiles", "/app/.local/connections", "/app/.local/portal/../connections", ".local/portal/connections"]) {
      expect(await mutant(PORTAL_APPS, AT, `{ name: 'CONNECTION_DIR', value: '${to}' }`), to).toEqual([DIR]);
    }
    expect(await mutant(PORTAL_APPS, `            ${AT}\n`, "")).toEqual([DIR]);
  }, 600_000);

  it("T-IAC-01 must-fail rule 21: L2 without one of its always-referenced secrets, with one behind the flag's value, or with a literal USER_ACCOUNTS, is reported", async () => {
    const always = `rule 21: ${N.main.apps.l2}/l2 must always reference the l2 vault's portal-token and user-wallet-mnemonic, as PORTAL_TOKEN and USER_WALLET_MNEMONIC`;
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
    expect(flagged).toContain("rule 21: USER_ACCOUNTS must come from the userAccounts parameter");
  }, 180_000);

  it("T-IAC-01 must-fail rule 21: PLATFORM_SELLERS naming the alias, a second seller, or another payee, is reported", async () => {
    const message = "rule 21: PLATFORM_SELLERS must be one seller: ALLOWED_HOSTS' own host, userAccounts.sellerName and sellerPayTo";
    const from = "string([{ host: sellerHost, name: userAccounts.sellerName, payees: [sellerPayTo] }])";
    expect(await mutant("modules/l2-apps.bicep", from, "string([{ host: '${names.apps.sellerAlias}.${sellerDomain}', name: userAccounts.sellerName, payees: [sellerPayTo] }])")).toContain(message);
    expect(await mutant("modules/l2-apps.bicep", from, "string([{ host: sellerHost, name: userAccounts.sellerName, payees: [sellerPayTo] }, { host: 'seller.example', name: 'another', payees: [] }])")).toContain(message);
    expect(await mutant("modules/l2-apps.bicep", from, "string([{ host: sellerHost, name: userAccounts.sellerName, payees: [] }])")).toContain(message);
  }, 180_000);

  it("T-IAC-01 must-fail rule 21: a portal with another role's token, the portal token on L3, API docs turned on at the portal, or a portal that calls L3, is reported", async () => {
    const anchor = "            { name: 'PORTAL_TOKEN', secretRef: 'portal-token' }\n            { name: 'CARD_VAULT_KEY'";
    const control = await mutant("modules/portal-apps.bicep", anchor, `            { name: 'CONTROL_TOKEN', secretRef: 'portal-token' }\n${anchor}`);
    expect(control).toContain(`rule 21: CONTROL_TOKEN in ${N.main.apps.portal}/portal`);
    const payer = await mutant("modules/portal-apps.bicep", anchor, `            { name: 'PAYER_PRIVATE_KEY', secretRef: 'portal-token' }\n${anchor}`);
    expect(payer).toContain(`rule 21: PAYER_PRIVATE_KEY in ${N.main.apps.portal}/portal`);
    expect(payer).toContain(`rule 2: PAYER_PRIVATE_KEY in ${N.main.apps.portal}/portal`);
    const docs = await mutant("modules/portal-apps.bicep", anchor, `            { name: 'API_DOCS', value: '1' }\n${anchor}`);
    expect(docs).toContain(`rule 21: API_DOCS in ${N.main.apps.portal}/portal: the portal never serves the API docs in Azure`);
    expect(docs).toContain(`rule 23: API_DOCS in ${N.main.apps.portal}/portal: in Azure only the agent can serve the docs`);
    const l3 = await mutant("modules/portal-apps.bicep", anchor, `            { name: 'SETTLEMENT_URL', value: 'http://\${names.apps.l3}.internal.\${mainDomain}' }\n${anchor}`);
    expect(l3).toContain("rule 21: the portal calls L2 only");
    const onL3 = await mutant("modules/l3-apps.bicep", "            { name: 'VERIFIER_TOKEN', secretRef: 'verifier-token' }\n", "            { name: 'VERIFIER_TOKEN', secretRef: 'verifier-token' }\n            { name: 'PORTAL_TOKEN', secretRef: 'verifier-token' }\n");
    expect(onL3).toContain(`rule 21: PORTAL_TOKEN in ${N.main.apps.l3}/l3`);
  }, 240_000);

  it("T-IAC-01 must-fail rule 21: a client ID written in a template, a portal secret behind a flag, userAccounts passed in part, or main without its check, is reported", async () => {
    const written = await mutant("modules/portal-apps.bicep", "{ name: 'PORTAL_CLIENT_ID', value: userAccounts.portalClientId }", "{ name: 'PORTAL_CLIENT_ID', value: '00000000-0000-4000-8000-000000000000' }");
    expect(written).toContain("rule 21: the portal's PORTAL_CLIENT_ID must come from its parameter");
    const flagged = await mutant(
      "modules/portal-apps.bicep",
      // 014: the block has a third secret, the administration token (rule 22); 020: and the two Coinbase secrets
      // (rule 26). The mutation is the same one.
      `      secrets: [\n${PORTAL_SECRET_LINES}\n      ]`,
      "      secrets: concat([{ name: 'portal-token', keyVaultUrl: '${vaultPortal}secrets/portal-token', identity: idPortal.id }, { name: 'portal-admin-token', keyVaultUrl: '${vaultPortal}secrets/portal-admin-token', identity: idPortal.id }, { name: 'coinbase-client-secret', keyVaultUrl: '${vaultPortal}secrets/coinbase-client-secret', identity: idPortal.id }, { name: 'coinbase-grant-key', keyVaultUrl: '${vaultPortal}secrets/coinbase-grant-key', identity: idPortal.id }], userAccounts.cardVault == 'stripe' ? [{ name: 'card-vault-key', keyVaultUrl: '${vaultPortal}secrets/card-vault-key', identity: idPortal.id }] : [])",
    );
    expect(flagged.some((m) => m.startsWith(`rule 21: ${N.main.apps.portal}/portal must always reference the portal vault's portal-token and card-vault-key`))).toBe(true);
    const part = await mutant("main.bicep", "    ciba: ciba\n    userAccounts: userAccounts\n", "    ciba: ciba\n    userAccounts: { enabled: userAccounts.enabled, sellerName: userAccounts.sellerName }\n");
    expect(part).toContain("rule 21: main must pass the userAccounts parameter to l2-apps whole");
    const CHECK = "rule 21: main must refuse (fail()) a userAccounts whose cardVault is not off or stripe, that is enabled without a portalClientId (not empty: an Auth0 client ID is not a GUID), or whose cardVault is stripe without a pk_test_ publishable key";
    const unchecked = await mutant("main.bicep", " && ((!userAccounts.enabled && unit != 'portal') || !empty(userAccounts.portalClientId))", "");
    expect(unchecked).toContain(CHECK);
    // The portal doesn't start without the web app's client ID, so its own deployment needs it even while the feature is off.
    const portalUnchecked = await mutant("main.bicep", "(!userAccounts.enabled && unit != 'portal')", "!userAccounts.enabled");
    expect(portalUnchecked).toContain(CHECK);
    // The first build's check, for an Entra client ID: it would refuse every Auth0 client ID.
    const guid = await mutant("main.bicep", "!empty(userAccounts.portalClientId))", "length(userAccounts.portalClientId) == 36)");
    expect(guid).toContain(CHECK);
  }, 300_000);

  it("T-IAC-01 must-fail rule 21: the portal's sign-in taken from another parameter or written in a template, or a portal given the directory's tenant, the agent's clients or the machine caller's settings, is reported", async () => {
    const otherAudience = await mutant("modules/portal-apps.bicep", "{ name: 'AUTH_AUDIENCE', value: identity.audience }", "{ name: 'AUTH_AUDIENCE', value: userAccounts.portalClientId }");
    expect(otherAudience).toContain("rule 21: the portal's AUTH_AUDIENCE must come from its parameter");
    expect(otherAudience).toContain(`rule 23: AUTH_AUDIENCE in ${N.main.apps.portal}/portal is not the identity parameter's: every unit names the same sign-in tenant`);
    const issuer = await mutant("modules/portal-apps.bicep", "{ name: 'AUTH_ISSUER', value: identity.issuer }", "{ name: 'AUTH_ISSUER', value: 'https://tenant.example/' }");
    expect(issuer).toContain("rule 21: the portal's AUTH_ISSUER must come from its parameter");
    const NOTHING = "the portal gets nothing of the directory, of the agent's clients or of the machine caller";
    const ISSUER = "            { name: 'AUTH_ISSUER', value: identity.issuer }\n";
    const tenant = await mutant("modules/portal-apps.bicep", ISSUER, `${ISSUER}            { name: 'AUTH_TENANT_ID', value: tenant().tenantId }\n`);
    expect(tenant).toContain(`rule 21: AUTH_TENANT_ID in ${N.main.apps.portal}/portal: ${NOTHING}`);
    expect(tenant).toContain(`rule 23: AUTH_TENANT_ID in ${N.main.apps.portal}/portal: nothing verifies the directory's tokens`);
    // 016: the agent has clients and a machine caller now; none of it is the portal's.
    const clients = await mutant("modules/portal-apps.bicep", ISSUER, `${ISSUER}            { name: 'AGENT_CLIENT_IDS', value: userAccounts.portalClientId }\n`);
    expect(clients).toContain(`rule 21: AGENT_CLIENT_IDS in ${N.main.apps.portal}/portal: ${NOTHING}`);
    expect(clients).toContain(`rule 23: AGENT_CLIENT_IDS in ${N.main.apps.portal}/portal: only the agent and L2 accept the agent's clients`);
    const machine = await mutant("modules/portal-apps.bicep", ISSUER, `${ISSUER}            { name: 'MACHINE_CLIENT_ID', value: userAccounts.portalClientId }\n`);
    expect(machine).toContain(`rule 21: MACHINE_CLIENT_ID in ${N.main.apps.portal}/portal: ${NOTHING}`);
    const agentParam = await mutant("modules/portal-apps.bicep", "param identity object\n", "param identity object\n#disable-next-line no-unused-params\nparam agent object = {}\n");
    expect(agentParam).toContain("rule 21: portal-apps must take no agent parameter: the portal gets nothing of the directory or of the agent's");
  }, 360_000);

  it("T-IAC-01 must-fail rule 21: identity passed in part, the portal given an audience of the directory, or main without its identity check, is reported", async () => {
    const part = await mutant("main.bicep", "    userAccounts: userAccounts\n    identity: identity\n  }\n  dependsOn: [registry, vaults, envs]", "    userAccounts: userAccounts\n    identity: { issuer: identity.issuer, audience: identity.audience }\n  }\n  dependsOn: [registry, vaults, envs]");
    expect(part).toContain("rule 21: main must pass the identity parameter to portal-apps whole");
    const entra = await mutant("modules/portal-apps.bicep", "param identity object\n", "param identity object\n#disable-next-line no-unused-params\nparam authAudience string = ''\n");
    expect(entra).toContain("rule 21: portal-apps must take no authAudience parameter: the portal gets nothing of the directory or of the agent's");
    const IDENTITY = IDENTITY_CHECK;
    const noSlash = await mutant("main.bicep", " && endsWith(identity.issuer, '/')", "");
    expect(noSlash).toContain(IDENTITY);
    const noAudience = await mutant("main.bicep", " && !empty(identity.audience)", "");
    expect(noAudience).toContain(IDENTITY);
    const never = await mutant("main.bicep", "var identityChecked = !userAccounts.enabled || (", "var identityChecked = true || (");
    expect(never).toContain(IDENTITY);
  }, 360_000);

  it("T-IAC-01 must-fail rule 21: a parameter file whose identity has other keys, lists the agent's clients, or turns user accounts on without an issuer, is reported", async () => {
    const KEYS = "rule 21: main.dev.bicepparam's identity must be exactly issuer and audience";
    const NO_ISSUER = "rule 21: main.dev.bicepparam turns user accounts on without an identity.issuer of the form https://<domain>/ and an identity.audience";
    const keys = await mutant("main.dev.bicepparam", DEV_IDENTITY, "param identity = {\n  issuer: ''\n  apiAudience: ''\n}");
    expect(keys).toContain(KEYS);
    // The agent's client is in the agent object (rule 23), never a list in identity.
    const clients = await mutant("main.dev.bicepparam", DEV_IDENTITY, "param identity = {\n  issuer: ''\n  audience: ''\n  agentClientIds: ['cli']\n}");
    expect(clients).toContain(KEYS);
    const enabled: [string, string][] = [[DEV_ACCOUNTS_HEAD, "param userAccounts = {\n  enabled: true\n  portalClientId: 'web'"]];
    const tenant = (issuer: string, audience = "https://x402-api/dev") => `param identity = {\n  issuer: '${issuer}'\n  audience: '${audience}'\n}`;
    expect(await mutant("main.dev.bicepparam", DEV_IDENTITY, tenant("", ""), enabled)).toEqual([NO_ISSUER]);
    // Not vacuous: with a tenant's values, user accounts may be on. An issuer without its trailing slash is not one.
    expect(await mutant("main.dev.bicepparam", DEV_IDENTITY, tenant("https://x402-dev.us.auth0.com/"), enabled)).toEqual([]);
    expect(await mutant("main.dev.bicepparam", DEV_IDENTITY, tenant("https://x402-dev.us.auth0.com"), enabled)).toEqual([NO_ISSUER]);
    expect(await mutant("main.dev.bicepparam", DEV_IDENTITY, tenant("https://x402-dev.us.auth0.com/", ""), enabled)).toEqual([NO_ISSUER]);
  }, 360_000);

  // ---- Rule 23 (016): one must-fail test per clause ---------------------------------------------------------------
  const SAME = "the agent and L2 verify a caller's token against the same tenant, API and client";

  it("T-IAC-01 must-fail rule 23 (a): an agent or an L2 without a sign-in setting, with another client list than the other's, with a tenant written in the template, or given identity or agent in part, is reported", async () => {
    const otherClient = await mutant("modules/l1-apps.bicep", "{ name: 'AGENT_CLIENT_IDS', value: empty(agent.desktopClientId) ? agent.clientId : '${agent.clientId},${agent.desktopClientId}' }", "{ name: 'AGENT_CLIENT_IDS', value: agent.machineClientId }");
    expect(otherClient).toEqual([`rule 23: the agent's AGENT_CLIENT_IDS must come from the agent parameter: ${SAME}`]);
    const missing = await mutant("modules/l2-apps.bicep", "            { name: 'AUTH_AUDIENCE', value: identity.audience }\n", "");
    expect(missing).toEqual([`rule 23: L2's AUTH_AUDIENCE must come from the identity parameter: ${SAME}`]);
    // L2 pointed at the approval client's tenant setting instead of the sign-in tenant every unit names.
    const otherTenant = await mutant("modules/l2-apps.bicep", "{ name: 'AUTH_ISSUER', value: identity.issuer }", "{ name: 'AUTH_ISSUER', value: ciba.issuer }");
    expect(otherTenant).toEqual([`rule 23: L2's AUTH_ISSUER must come from the identity parameter: ${SAME}`]);
    const written = await mutant("modules/l1-apps.bicep", "{ name: 'AUTH_ISSUER', value: identity.issuer }", "{ name: 'AUTH_ISSUER', value: 'https://tenant.example/' }");
    expect(written).toEqual([`rule 23: the agent's AUTH_ISSUER must come from the identity parameter: ${SAME}`]);
    const part = await mutant("main.bicep", "    identity: identity\n    agent: agent\n    modelDeployment: modelDeployment\n", "    identity: { issuer: identity.issuer, audience: identity.audience }\n    agent: { clientId: agent.clientId, apiDocs: false, machineClientId: agent.machineClientId, machineKeyId: agent.machineKeyId }\n    modelDeployment: modelDeployment\n");
    expect(part).toEqual(["rule 23: main must pass the identity parameter to l1-apps whole", "rule 23: main must pass the agent parameter to l1-apps whole"]);
    // The portal's client is the one L2 never accepts as a caller's: L2 has to be told which it is.
    const noPortal = await mutant("modules/l2-apps.bicep", "            { name: 'PORTAL_CLIENT_ID', value: userAccounts.portalClientId }\n", "");
    expect(noPortal).toEqual(["rule 23: L2's PORTAL_CLIENT_ID must come from userAccounts.portalClientId: the client L2 never accepts as a caller's"]);
    // A list of the agent's clients anywhere else, here on L3.
    const onL3 = await mutant("modules/l3-apps.bicep", "            { name: 'VERIFIER_TOKEN', secretRef: 'verifier-token' }\n", "            { name: 'VERIFIER_TOKEN', secretRef: 'verifier-token' }\n            { name: 'AGENT_CLIENT_IDS', value: 'cli' }\n");
    expect(onL3).toEqual([`rule 23: AGENT_CLIENT_IDS in ${N.main.apps.l3}/l3: only the agent and L2 accept the agent's clients`]);
  }, 420_000);

  it("T-IAC-01 must-fail rule 23 (b): the directory's tenant or audience back on the agent, on L2 or on a job, or back as a parameter of main, is reported", async () => {
    const DIRECTORY = "nothing verifies the directory's tokens";
    const CLIENTS = "            { name: 'AGENT_CLIENT_IDS', value: empty(agent.desktopClientId) ? agent.clientId : '${agent.clientId},${agent.desktopClientId}' }\n";
    const tenant = await mutant("modules/l1-apps.bicep", CLIENTS, `${CLIENTS}            { name: 'AUTH_TENANT_ID', value: tenant().tenantId }\n`);
    expect(tenant).toEqual([`rule 23: AUTH_TENANT_ID in ${N.main.apps.l1}/agent: ${DIRECTORY}`]);
    const audience = await mutant("modules/l2-apps.bicep", CLIENTS, `${CLIENTS}            { name: 'SERVICE_AUDIENCE', value: identity.audience }\n`);
    expect(audience).toEqual([`rule 23: SERVICE_AUDIENCE in ${N.main.apps.l2}/l2: ${DIRECTORY}`]);
    const onJob = await mutant("modules/l1-apps.bicep", "            { name: 'AGENT_URL', value: agentUrl }\n", "            { name: 'AGENT_URL', value: agentUrl }\n            { name: 'AUTH_TENANT_ID', value: tenant().tenantId }\n");
    expect(onJob).toContain(`rule 23: AUTH_TENANT_ID in ${N.main.jobs.smoke}/smoke: ${DIRECTORY}`);
    // 011's parameters: the API app's client ID in main, the directory's tenant in L1's module.
    const param = await mutant("main.bicep", "param sellerPayTo string\n", "param sellerPayTo string\n#disable-next-line no-unused-params\nparam authAudience string = ''\n");
    expect(param).toContain("rule 23: main must have no authAudience parameter: nothing verifies the directory's tokens");
    const handed = await mutant("modules/l1-apps.bicep", "param agent object\n", "param agent object\n#disable-next-line no-unused-params\nparam authTenantId string = ''\n");
    expect(handed).toEqual(["rule 23: l1-apps takes authTenantId: nothing verifies the directory's tokens"]);
  }, 420_000);

  it("T-IAC-01 must-fail rule 23 (c): API_DOCS written in the template, behind another switch, on a job or on L2, or a docs client that isn't the agent's, is reported", async () => {
    const SWITCH = "rule 23: the agent's API_DOCS must be agent.apiDocs and nothing else: each environment's parameter file says whether its agent serves the docs";
    const DOCS = "{ name: 'API_DOCS', value: agent.apiDocs ? '1' : '0' }";
    expect(await mutant("modules/l1-apps.bicep", DOCS, "{ name: 'API_DOCS', value: '1' }")).toEqual([SWITCH]);
    expect(await mutant("modules/l1-apps.bicep", DOCS, "{ name: 'API_DOCS', value: empty(agent.clientId) ? '0' : '1' }")).toEqual([SWITCH]);
    expect(await mutant("modules/l1-apps.bicep", `            ${DOCS}\n`, "")).toEqual([SWITCH]);
    const ONLY = "in Azure only the agent can serve the docs";
    const onJob = await mutant("modules/l1-apps.bicep", "            { name: 'AGENT_URL', value: agentUrl }\n", "            { name: 'AGENT_URL', value: agentUrl }\n            { name: 'API_DOCS', value: agent.apiDocs ? '1' : '0' }\n");
    expect(onJob).toContain(`rule 23: API_DOCS in ${N.main.jobs.smoke}/smoke: ${ONLY}`);
    const onL2 = await mutant("modules/l2-apps.bicep", "            { name: 'AGENT_CLIENT_IDS', value: empty(agent.desktopClientId) ? agent.clientId : '${agent.clientId},${agent.desktopClientId}' }\n", "            { name: 'AGENT_CLIENT_IDS', value: empty(agent.desktopClientId) ? agent.clientId : '${agent.clientId},${agent.desktopClientId}' }\n            { name: 'API_DOCS', value: agent.apiDocs ? '1' : '0' }\n");
    expect(onL2).toEqual([`rule 23: API_DOCS in ${N.main.apps.l2}/l2: ${ONLY}`]);
    const client = await mutant("modules/l1-apps.bicep", "{ name: 'API_DOCS_CLIENT_ID', value: agent.apiDocs ? agent.clientId : '' }", "{ name: 'API_DOCS_CLIENT_ID', value: agent.machineClientId }");
    expect(client).toEqual(["rule 23: the agent's API_DOCS_CLIENT_ID must be agent.clientId while agent.apiDocs is on, and empty otherwise"]);
  }, 420_000);

  it("T-IAC-01 must-fail rule 23 (019): L2's list without the desktop client, the agent's advertised client from elsewhere, or the desktop client's ID on another unit, is reported", async () => {
    // The agent would accept a desktop token that L2 then refuses: every payment of such a run fails.
    const l2Drops = await mutant("modules/l2-apps.bicep", "{ name: 'AGENT_CLIENT_IDS', value: empty(agent.desktopClientId) ? agent.clientId : '${agent.clientId},${agent.desktopClientId}' }", "{ name: 'AGENT_CLIENT_IDS', value: agent.clientId }");
    expect(l2Drops).toEqual([`rule 23: L2's AGENT_CLIENT_IDS must come from the agent parameter: ${SAME}`]);
    const agentDrops = await mutant("modules/l1-apps.bicep", "{ name: 'AGENT_CLIENT_IDS', value: empty(agent.desktopClientId) ? agent.clientId : '${agent.clientId},${agent.desktopClientId}' }", "{ name: 'AGENT_CLIENT_IDS', value: agent.clientId }");
    expect(agentDrops).toEqual([`rule 23: the agent's AGENT_CLIENT_IDS must come from the agent parameter: ${SAME}`]);
    const advertised = await mutant("modules/l1-apps.bicep", "{ name: 'AGENT_DESKTOP_CLIENT_ID', value: agent.desktopClientId }", "{ name: 'AGENT_DESKTOP_CLIENT_ID', value: agent.clientId }");
    expect(advertised).toEqual([DESKTOP_ID]);
    const onL2 = await mutant("modules/l2-apps.bicep", "            { name: 'AGENT_CLIENT_IDS', value: empty(agent.desktopClientId) ? agent.clientId : '${agent.clientId},${agent.desktopClientId}' }\n", "            { name: 'AGENT_CLIENT_IDS', value: empty(agent.desktopClientId) ? agent.clientId : '${agent.clientId},${agent.desktopClientId}' }\n            { name: 'AGENT_DESKTOP_CLIENT_ID', value: agent.desktopClientId }\n");
    expect(onL2).toEqual([`rule 23: AGENT_DESKTOP_CLIENT_ID in ${N.main.apps.l2}/l2: only the agent serves the desktop client's sign-in settings`]);
  }, 420_000);

  it("T-IAC-01 must-fail rule 23 (d): the machine caller's key as a literal, missing from a job, read from another vault, on the agent's container, or a job with another client's ID, a role token on the smoke job or a wrong candidate address, is reported", async () => {
    const REGRESSION = `rule 23: the regression job must reference the l1 vault's ${MACHINE_SECRET}, as MACHINE_CLIENT_KEY`;
    const SMOKE = `rule 23: the smoke job must reference the l1 vault's ${MACHINE_SECRET}, as MACHINE_CLIENT_KEY`;
    const KEY = "{ name: 'MACHINE_CLIENT_KEY', secretRef: 'machine-client-key' }";
    // The first of the two is the regression job's.
    const literal = await mutant("modules/l1-apps.bicep", KEY, "{ name: 'MACHINE_CLIENT_KEY', value: 'off' }");
    expect(literal).toContain(`rule 8: ${N.main.jobs.l1}/regression MACHINE_CLIENT_KEY is a literal`);
    expect(literal).toContain(REGRESSION);
    const missing = await mutant("modules/l1-apps.bicep", `            ${KEY}\n            { name: 'AGENT_URL'`, "            { name: 'AGENT_URL'");
    expect(missing).toContain(SMOKE);
    const underAnother = await mutant("modules/l1-apps.bicep", KEY, "{ name: 'MACHINE_CLIENT_KEY', secretRef: 'control-token' }");
    expect(underAnother).toContain(REGRESSION);
    expect(underAnother).toContain(`rule 23: MACHINE_CLIENT_KEY in ${N.main.jobs.l1}/regression must be the ${MACHINE_SECRET} secret and nothing else`);
    const otherVault = await mutant(
      "modules/l1-apps.bicep",
      "        { name: 'machine-client-key', keyVaultUrl: '${vaultL1}secrets/machine-client-key', identity: idL1.id }\n      ]\n      identitySettings: [{ identity: idL1.id, lifecycle: 'None' }]\n    }\n    template: {\n      containers: [\n        {\n          name: 'smoke'",
      "        { name: 'machine-client-key', keyVaultUrl: 'https://${names.vaults.op}${az.environment().suffixes.keyvaultDns}/secrets/machine-client-key', identity: idL1.id }\n      ]\n      identitySettings: [{ identity: idL1.id, lifecycle: 'None' }]\n    }\n    template: {\n      containers: [\n        {\n          name: 'smoke'",
    );
    expect(otherVault).toContain(SMOKE);
    expect(otherVault).toContain("rule 13: l1-apps looks up vaults l1,op, not its own (l1)");
    // The agent's own container: it serves callers, it is not one.
    const onAgent = await mutant(
      "modules/l1-apps.bicep",
      "        { name: 'session-ref-secret', keyVaultUrl: '${vaultL1}secrets/session-ref-secret', identity: idL1.id }\n",
      "        { name: 'session-ref-secret', keyVaultUrl: '${vaultL1}secrets/session-ref-secret', identity: idL1.id }\n        { name: 'machine-client-key', keyVaultUrl: '${vaultL1}secrets/machine-client-key', identity: idL1.id }\n",
      [["            { name: 'SESSION_REF_SECRET', secretRef: 'session-ref-secret' }\n", "            { name: 'SESSION_REF_SECRET', secretRef: 'session-ref-secret' }\n            { name: 'MACHINE_CLIENT_KEY', secretRef: 'machine-client-key' }\n"]],
    );
    expect(onAgent).toEqual([
      `rule 23: ${N.main.apps.l1} has the machine caller's key`,
      `rule 23: MACHINE_CLIENT_KEY in ${N.main.apps.l1}/agent: only L1's regression job and smoke job call as the machine caller`,
    ]);
    const onL2 = await mutant("modules/l2-apps.bicep", "            { name: 'AGENT_CLIENT_IDS', value: empty(agent.desktopClientId) ? agent.clientId : '${agent.clientId},${agent.desktopClientId}' }\n", "            { name: 'AGENT_CLIENT_IDS', value: empty(agent.desktopClientId) ? agent.clientId : '${agent.clientId},${agent.desktopClientId}' }\n            { name: 'MACHINE_CLIENT_ID', value: agent.machineClientId }\n");
    expect(onL2).toEqual([`rule 23: MACHINE_CLIENT_ID in ${N.main.apps.l2}/l2: only L1's regression job and smoke job call as the machine caller`]);
    // The agent's own client is a person's: a job calling with it would not be the machine caller.
    const otherClient = await mutant("modules/l1-apps.bicep", "{ name: 'MACHINE_CLIENT_ID', value: agent.machineClientId }", "{ name: 'MACHINE_CLIENT_ID', value: agent.clientId }");
    expect(otherClient).toEqual(["rule 23: the regression job's MACHINE_CLIENT_ID must come from the agent parameter"]);
    const EXACTLY = `rule 23: the smoke job must get exactly ${SMOKE_ENV.join(", ")}, and one secret: it calls the agent's public API only, with no role token`;
    const roleToken = await mutant(
      "modules/l1-apps.bicep",
      "        { name: 'machine-client-key', keyVaultUrl: '${vaultL1}secrets/machine-client-key', identity: idL1.id }\n      ]\n      identitySettings: [{ identity: idL1.id, lifecycle: 'None' }]\n    }\n    template: {\n      containers: [\n        {\n          name: 'smoke'",
      "        { name: 'machine-client-key', keyVaultUrl: '${vaultL1}secrets/machine-client-key', identity: idL1.id }\n        { name: 'control-token', keyVaultUrl: '${vaultL1}secrets/control-token', identity: idL1.id }\n      ]\n      identitySettings: [{ identity: idL1.id, lifecycle: 'None' }]\n    }\n    template: {\n      containers: [\n        {\n          name: 'smoke'",
      [["            { name: 'AGENT_URL', value: agentUrl }\n", "            { name: 'AGENT_URL', value: agentUrl }\n            { name: 'CONTROL_TOKEN', secretRef: 'control-token' }\n"]],
    );
    expect(roleToken).toEqual([EXACTLY]);
    const ADDRESSES = "rule 23: the smoke job's AGENT_URL must be the agent's address, and AGENT_CANDIDATE_URL the address of its candidate label, which the agent's new revision gets";
    const noLabel = await mutant("modules/l1-apps.bicep", "var agentCandidateUrl = 'https://${names.apps.l1}---candidate.${mainDomain}'", "var agentCandidateUrl = 'https://${names.apps.l1}---latest.${mainDomain}'");
    expect(noLabel).toEqual([ADDRESSES]);
    const otherApp = await mutant("modules/l1-apps.bicep", "var agentUrl = 'https://${names.apps.l1}.${mainDomain}'", "var agentUrl = 'https://${names.apps.portal}.${mainDomain}'");
    expect(otherApp).toEqual([ADDRESSES]);
    const unlabelled = await mutant("modules/l1-apps.bicep", "{ latestRevision: true, weight: 0, label: 'candidate' }", "{ latestRevision: true, weight: 0, label: 'next' }");
    expect(unlabelled).toEqual([ADDRESSES]);
  }, 600_000);

  it("T-IAC-01 must-fail rule 23 (e): a parameter file whose agent has another key, lacks one, or holds a switch that isn't true or false, is reported", async () => {
    const keys = (has: string) => `rule 23: main.dev.bicepparam's agent must have exactly the keys ${AGENT_KEYS.join(", ")} (it has ${has})`;
    const agent = (lines: string[]) => `param agent = {\n${lines.map((l) => `  ${l}\n`).join("")}}`;
    // Not vacuous: the real object has exactly the five, and a tenant's values pass.
    const { params } = await compile("infra");
    expect(Object.keys(params["main.dev.bicepparam"]!.agent as Json)).toEqual(AGENT_KEYS);
    expect(await mutant("main.dev.bicepparam", DEV_AGENT, agent(["clientId: 'AgentClient01'", "desktopClientId: 'DesktopClient01'", "apiDocs: false", "machineClientId: 'ChecksClient01'", "machineKeyId: 'checks-key-1'"]))).toEqual([]);
    // The private key is a secret of the l1 vault, never a value of the parameter file.
    const extra = await mutant("main.dev.bicepparam", DEV_AGENT, agent(["clientId: ''", "desktopClientId: ''", "apiDocs: true", "machineClientId: ''", "machineKeyId: ''", "machineKey: 'off'"]));
    expect(extra).toEqual([keys("clientId, desktopClientId, apiDocs, machineClientId, machineKeyId, machineKey")]);
    const fewer = await mutant("main.dev.bicepparam", DEV_AGENT, agent(["clientId: ''", "machineClientId: ''", "machineKeyId: ''", "apiDocs: true"]));
    expect(fewer).toEqual([keys("clientId, machineClientId, machineKeyId, apiDocs")]);
    const text = await mutant("main.dev.bicepparam", DEV_AGENT, agent(["clientId: ''", "desktopClientId: ''", "apiDocs: '1'", "machineClientId: ''", "machineKeyId: ''"]));
    expect(text).toEqual(["rule 23: main.dev.bicepparam's agent.apiDocs must be true or false, and its four IDs strings"]);
  }, 300_000);

  it("T-IAC-01 must-fail rule 23 (f): main without its check for the l2 unit, for the agent's client, for the docs' client or for the machine caller, or with a check that never fails, is reported", async () => {
    const onlyL1 = await mutant("main.bicep", "(!contains(['l1', 'l2'], unit) || (", "(!contains(['l1'], unit) || (");
    expect(onlyL1).toEqual([AGENT_CHECK]);
    const noClient = await mutant("main.bicep", " && !empty(identity.audience) && !empty(agent.clientId)))", " && !empty(identity.audience)))");
    expect(noClient).toEqual([AGENT_CHECK]);
    const noDocs = await mutant("main.bicep", " && (unit != 'l1' || !agent.apiDocs || !empty(agent.clientId))", "");
    expect(noDocs).toEqual([AGENT_CHECK]);
    const noMachine = await mutant("main.bicep", " && (unit != 'l1' || (!empty(agent.machineClientId) && !empty(agent.machineKeyId)))", "");
    expect(noMachine).toEqual([AGENT_CHECK]);
    const noKeyId = await mutant("main.bicep", "(!empty(agent.machineClientId) && !empty(agent.machineKeyId))", "(!empty(agent.machineClientId))");
    expect(noKeyId).toEqual([AGENT_CHECK]);
    const never = await mutant("main.bicep", "var agentChecked = (", "var agentChecked = true || (");
    expect(never).toEqual([AGENT_CHECK]);
  }, 360_000);

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
    expect(unchecked).toContain("rule 19: main must refuse (fail()) a ciba with another credential kind, or enabled without an https:// issuer, a clientId and an audience");
  }, 120_000);

  it("T-IAC-01 must-fail rule 19 (015): an approver key in ciba, CIBA_APPROVER put back in the L2 app, or main accepting ciba without user accounts, is reported", async () => {
    // The real files: exactly the six keys, and no approver anywhere a deployment is configured.
    const { params } = await compile("infra");
    expect(Object.keys(params["main.dev.bicepparam"]!.ciba as Json).sort()).toEqual(["audience", "clientId", "clientKeyId", "credential", "enabled", "issuer"]);
    for (const f of ["main.bicep", "main.dev.bicepparam", "modules/l2-apps.bicep"]) expect(readFileSync(join("infra", f), "utf8"), f).not.toMatch(/CIBA_APPROVER|ciba\.approver|\bapprover\s*:/i);

    const key = await mutant("main.dev.bicepparam", "  credential: 'key'\n  clientKeyId: ''\n}", "  credential: 'key'\n  clientKeyId: ''\n  approver: 'auth0|someone'\n}");
    expect(key).toEqual(["rule 19: main.dev.bicepparam's ciba must have exactly the keys audience, clientId, clientKeyId, credential, enabled, issuer (it has approver, audience, clientId, clientKeyId, credential, enabled, issuer)"]);

    const variable = await mutant(
      "modules/l2-apps.bicep",
      "            { name: 'CIBA_AUDIENCE', value: ciba.audience }\n",
      "            { name: 'CIBA_AUDIENCE', value: ciba.audience }\n            { name: 'CIBA_APPROVER', value: 'auth0|someone' }\n",
    );
    expect(variable.some((m) => /^rule 19: .*\/l2 has CIBA_APPROVER; no approver is configured/.test(m))).toBe(true);

    const noFail = await mutant("main.bicep", " && !empty(ciba.audience) && userAccounts.enabled)", " && !empty(ciba.audience))");
    expect(noFail).toEqual(["rule 19: main must refuse (fail()) ciba.enabled without userAccounts.enabled"]);
  }, 180_000);

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
    // 013 and 016: neither people's sign-in nor the agent's client or its docs switch is a per-run value.
    const docs = await mutant("main.dev.bicepparam", "  apiDocs: true\n", "  apiDocs: bool(readEnvironmentVariable('API_DOCS', 'false'))\n");
    expect(docs).toContain(`rule 17: main.dev.bicepparam reads apiDocs: bool(readEnvironmentVariable('API_DOCS', 'false')) from the environment; only ${PER_RUN.join(", ")} may be`);
    const issuer = await mutant("main.dev.bicepparam", DEV_IDENTITY, "param identity = {\n  issuer: readEnvironmentVariable('AUTH_ISSUER', '')\n  audience: ''\n}");
    expect(issuer).toContain(`rule 17: main.dev.bicepparam reads issuer: readEnvironmentVariable('AUTH_ISSUER', '') from the environment; only ${PER_RUN.join(", ")} may be`);
    const name = await mutant("pre-deploy.dev.bicepparam", "var environment = 'dev'", "var environment = readEnvironmentVariable('ENVIRONMENT', 'dev')");
    expect(name).toContain(`rule 17: pre-deploy.dev.bicepparam reads var environment = readEnvironmentVariable('ENVIRONMENT', 'dev') from the environment; only ${PER_RUN.join(", ")} may be`);
  }, 180_000);
});
