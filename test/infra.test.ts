// T-IAC-01 Azure identity, secret and exposure rules (SPEC.md §3.1 Azure profile; specs/011 contracts/
// cloud-topology.md "T-IAC-01 assertions"). Compiles infra/main.bicep with the Bicep CLI and asserts on the
// ARM JSON that would actually be deployed. Needs the Bicep CLI: set BICEP_PATH (the deploy workflow always
// does); without it this suite is skipped. Each rule has a must-fail mutant.
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Bicep } from "@azure/bicep-rpc-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IMAGES, type ImageName } from "../scripts/image-closure.js";

const BICEP_PATH = process.env.BICEP_PATH;

type Json = Record<string, unknown>;
interface Res {
  module: string;
  type: string;
  name: string;
  properties: Json;
  raw: Json;
  /** The `variables` of the template this resource is declared in. */
  vars: Json;
}

/** Replaces `variables('x')` with the literal value of x from the resource's own template. */
const withVars = (expr: unknown, vars: Json) =>
  String(expr).replace(/variables\('([A-Za-z0-9_]+)'\)/g, (m, name: string) => (name in vars ? JSON.stringify(vars[name]) : m));

const KV_SECRETS_USER = "4633458b-17de-408a-b874-0445c86b69e6";
const ACR_PULL = "7f951dda-4ed3-4680-a7ca-43fe172d538d";
const COGNITIVE_SERVICES_USER = "a97b65f3-24c7-4388-baec-2e87135dc908";
const EXTERNAL_OK = new Set(["ca-l1-agent", "ca-seller", "ca-seller-alias"]);
/** Unit key → its image (scripts/image-closure.ts), and the unit each app and job belongs to (rule 12). */
const UNIT_IMAGE: Record<string, ImageName> = { l1: "l1-agent", l2: "l2-control", l3: "l3-verifier", seller: "seller" };
const APP_UNIT: Record<string, string> = { "ca-l1-agent": "l1", "job-regression": "l1", "ca-l2-control": "l2", "job-operator": "l2", "ca-l3-verifier": "l3", "ca-seller": "seller", "ca-seller-alias": "seller" };

/** `network`, `vault`, `apps`… from a nested deployment's (possibly expression) name. */
function moduleName(name: string): string {
  const m = /^\[format\('([a-z-]+?)-\{0\}'/.exec(name);
  return m ? m[1]! : name;
}

/** Every resource, with the module (nested deployment) it comes from; `main` for the top level. */
function flatten(template: Json, module = "main"): Res[] {
  const out: Res[] = [];
  const vars = (template.variables ?? {}) as Json;
  for (const r of (template.resources as Json[]) ?? []) {
    const type = String(r.type);
    const props = (r.properties ?? {}) as Json;
    out.push({ module, type, name: String(r.name), properties: props, raw: r, vars });
    if (type === "Microsoft.Resources/deployments") out.push(...flatten((props.template ?? {}) as Json, moduleName(String(r.name))));
  }
  return out;
}

/** Concrete names of a resource: a copy loop over `variables('xs')[copyIndex()]` expands to every element. */
function namesOf(r: Res): string[] {
  const loop = /^\[variables\('([A-Za-z0-9_]+)'\)\[copyIndex\(\)\]\]$/.exec(r.name);
  if (loop) return ((r.vars[loop[1]!] ?? []) as string[]).map(String);
  return [r.name];
}

const apps = (all: Res[]) => all.filter((r) => r.type === "Microsoft.App/containerApps" || r.type === "Microsoft.App/jobs");
type Container = { name: string; image?: string; command?: string[]; env?: { name: string; value?: string; secretRef?: string }[]; volumeMounts?: { volumeName: string; mountPath: string }[] };
const containersOf = (r: Res) => ((r.properties.template as Json)?.containers ?? []) as Container[];
const configOf = (r: Res) => (r.properties.configuration ?? {}) as Json;
const secretsOf = (r: Res) => (configOf(r).secrets ?? []) as { name: string; keyVaultUrl?: string; value?: string }[];
const deploymentParam = (all: Res[], module: string, param: string) =>
  JSON.stringify(((all.find((r) => r.type === "Microsoft.Resources/deployments" && moduleName(r.name) === module)?.properties.parameters ?? {}) as Json)[param] ?? null);

/** Rules 1–12 of contracts/cloud-topology.md. Returns one message per violation, prefixed `rule N:`. */
export function violations(arm: Json, infraFiles: Record<string, string>): string[] {
  const v: string[] = [];
  const all = flatten(arm);
  const units = ((arm.variables as Json)?.units ?? []) as { key: string; identity: string; subnet: string }[];

  // Rule 1: role assignments only where the matrix puts them.
  for (const u of units) if (u.identity !== `id-${u.key}`) v.push(`rule 1: unit ${u.key} uses identity ${u.identity}`);
  for (const ra of all.filter((r) => r.type === "Microsoft.Authorization/roleAssignments")) {
    const role = withVars(ra.properties.roleDefinitionId, ra.vars);
    const principal = String(ra.properties.principalId);
    const ok =
      (ra.module === "vault" && role.includes(KV_SECRETS_USER) && principal === "[parameters('principalId')]") ||
      (ra.module === "registry" && role.includes(ACR_PULL)) ||
      (ra.module === "foundry" && role.includes(COGNITIVE_SERVICES_USER) && principal === "[parameters('agentPrincipalId')]");
    if (!ok) v.push(`rule 1: role assignment ${ra.name} in ${ra.module} is not in the matrix`);
  }
  if (all.filter((r) => r.module === "vault" && r.type === "Microsoft.Authorization/roleAssignments").length !== 1) v.push("rule 1: a vault must grant exactly one principal");
  if (!deploymentParam(all, "vault", "principalId").includes("variables('units')[copyIndex()].identity")) v.push("rule 1: a vault's reader is not its own unit's identity");
  if (!deploymentParam(all, "foundry", "agentPrincipalId").includes("'id-l1'")) v.push("rule 1: Foundry access is not id-l1's");

  // Rule 2: the payer key only in ca-l2-control/l2, only as a reference to the l2 vault.
  for (const a of apps(all)) {
    for (const c of containersOf(a)) {
      for (const e of c.env ?? []) {
        if (e.name !== "PAYER_PRIVATE_KEY") continue;
        if (a.name !== "ca-l2-control" || c.name !== "l2") v.push(`rule 2: PAYER_PRIVATE_KEY in ${a.name}/${c.name}`);
        else if (e.value !== undefined || !e.secretRef) v.push("rule 2: PAYER_PRIVATE_KEY is not a secret reference");
        else {
          const s = secretsOf(a).find((x) => x.name === e.secretRef);
          if (!s?.keyVaultUrl?.includes("parameters('vaultUri').l2")) v.push("rule 2: PAYER_PRIVATE_KEY does not come from the l2 vault");
        }
      }
    }
    for (const s of secretsOf(a)) {
      if (s.keyVaultUrl?.includes("parameters('vaultUri').l2") && a.name !== "ca-l2-control") v.push(`rule 2: ${a.name} reads the l2 vault`);
    }
  }

  // Rule 3: only the agent and the sellers have external ingress.
  for (const a of all.filter((r) => r.type === "Microsoft.App/containerApps")) {
    const ingress = configOf(a).ingress as Json | undefined;
    for (const name of namesOf(a)) if (ingress?.external === true && !EXTERNAL_OK.has(name)) v.push(`rule 3: ${name} has external ingress`);
  }
  for (const name of ["ca-l2-control", "ca-l3-verifier"]) {
    const a = all.find((r) => r.name === name);
    if (!a || (configOf(a).ingress as Json)?.external !== false) v.push(`rule 3: ${name} must have external: false`);
  }

  // Rule 4: one L2 replica, single revision, NFS ledger at /app/.local.
  const l2 = all.find((r) => r.name === "ca-l2-control");
  if (l2) {
    const scale = ((l2.properties.template as Json)?.scale ?? {}) as Json;
    if (scale.minReplicas !== 1 || scale.maxReplicas !== 1) v.push("rule 4: ca-l2-control must run exactly one replica");
    if (configOf(l2).activeRevisionsMode !== "Single") v.push("rule 4: ca-l2-control must use single revision mode");
    const vols = ((l2.properties.template as Json)?.volumes ?? []) as { name: string; storageType: string }[];
    const nfs = vols.find((x) => x.storageType === "NfsAzureFile");
    const mount = containersOf(l2).find((c) => c.name === "l2")?.volumeMounts?.find((m) => m.volumeName === nfs?.name);
    if (!nfs || mount?.mountPath !== "/app/.local") v.push("rule 4: the l2 container must mount the NFS ledger at /app/.local");
  }

  // Rule 5: proxy sidecars have no env and no secrets.
  for (const a of apps(all)) {
    for (const c of containersOf(a).filter((x) => x.name === "proxy")) {
      if ((c.env ?? []).length > 0) v.push(`rule 5: ${a.name}/proxy has env`);
      if (JSON.stringify(c).includes("secretRef")) v.push(`rule 5: ${a.name}/proxy references a secret`);
    }
  }

  // Rule 6: identity lifecycle Main only for the agent.
  for (const a of apps(all)) {
    const settings = (configOf(a).identitySettings ?? []) as { lifecycle: string }[];
    const want = a.name === "ca-l1-agent" ? "Main" : "None";
    if (settings.length === 0 || settings.some((s) => s.lifecycle !== want)) v.push(`rule 6: ${a.name} identity lifecycle must be ${want}`);
  }

  // Rule 7: sellers live in the counterparty environment and read only the seller vault.
  for (const s of all.filter((r) => r.module === "sellers" && r.type === "Microsoft.App/containerApps")) {
    if (s.properties.environmentId !== "[parameters('cpEnvId')]") v.push(`rule 7: ${s.name} is not in cae-x402-cp`);
  }
  if (!deploymentParam(all, "sellers", "cpEnvId").includes("cpId")) v.push("rule 7: sellers are not given the counterparty environment");
  const sellerVault = deploymentParam(all, "sellers", "vaultUri");
  const sellerIdx = units.findIndex((u) => u.key === "seller");
  if (!sellerVault.includes(`variables('units')[${sellerIdx}]`)) v.push("rule 7: sellers do not read the seller vault");
  const appVaults = deploymentParam(all, "apps", "vaultUri");
  for (const key of ["l1", "l2", "l3", "op"]) {
    const idx = units.findIndex((u) => u.key === key);
    if (!new RegExp(`"${key}":"\\[reference\\(resourceId\\('Microsoft\\.Resources/deployments', format\\('vault-\\{0\\}', variables\\('units'\\)\\[${idx}\\]`).test(appVaults)) {
      v.push(`rule 7: apps vault ${key} is not unit ${key}'s vault`);
    }
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
  for (const a of apps(all)) {
    for (const c of containersOf(a)) {
      for (const e of c.env ?? []) {
        if (/PRIVATE_KEY|SECRET|TOKEN/.test(e.name) && e.value !== undefined) v.push(`rule 8: ${a.name}/${c.name} ${e.name} is a literal`);
      }
    }
  }

  // Rule 9: L2 allows exactly the seller host (never the alias) and a payee; the regression job targets the alias.
  const l2Env = l2 ? (containersOf(l2).find((c) => c.name === "l2")?.env ?? []) : [];
  const hosts = l2Env.find((e) => e.name === "ALLOWED_HOSTS")?.value ?? "";
  if (!hosts.includes("'ca-seller.{0}'") || hosts.includes("alias")) v.push("rule 9: ALLOWED_HOSTS must be the ca-seller FQDN, not the alias");
  if (!l2Env.find((e) => e.name === "ALLOWED_PAYEES")?.value) v.push("rule 9: ALLOWED_PAYEES is not set");
  const regression = all.find((r) => r.name === "job-regression");
  if (regression) {
    const alias = containersOf(regression)[0]?.env?.find((e) => e.name === "SELLER_ALIAS_URL")?.value ?? "";
    if (!alias.includes("ca-seller-alias")) v.push("rule 9: job-regression's SELLER_ALIAS_URL is not ca-seller-alias");
    if (secretsOf(regression).some((s) => !s.keyVaultUrl?.includes("parameters('vaultUri').l1"))) v.push("rule 9: job-regression reads a vault other than l1");
    if (JSON.stringify(containersOf(regression)).includes("OPERATOR_TOKEN")) v.push("rule 9: job-regression holds the operator token");
  } else {
    v.push("rule 9: job-regression is missing");
  }
  const sellerApps = all.filter((r) => r.module === "sellers" && r.type === "Microsoft.App/containerApps");
  const sellerNames = sellerApps.flatMap(namesOf).sort();
  if (JSON.stringify(sellerNames) !== JSON.stringify(["ca-seller", "ca-seller-alias"])) v.push("rule 9: ca-seller-alias is not deployed beside ca-seller");

  // Rule 10: every vault denies by default and allows only its unit's subnet.
  const vault = all.find((r) => r.module === "vault" && r.type === "Microsoft.KeyVault/vaults");
  const acls = (vault?.properties.networkAcls ?? {}) as Json;
  if (acls.defaultAction !== "Deny") v.push("rule 10: vault firewall default is not Deny");
  if (JSON.stringify(acls.virtualNetworkRules) !== JSON.stringify([{ id: "[parameters('subnetId')]" }]) || JSON.stringify(acls.ipRules ?? []) !== "[]") {
    v.push("rule 10: vault firewall must allow only its unit's subnet");
  }
  for (const u of units) if (u.subnet !== (u.key === "seller" ? "cp" : "main")) v.push(`rule 10: unit ${u.key} on subnet ${u.subnet}`);

  // Rule 11: the agent's AUTH_AUDIENCE is the API app's client ID, a required 36-character parameter. Entra
  // v2.0 tokens carry it as `aud`; a default such as the api:// URI would refuse every real token.
  const audience = ((arm.parameters as Json)?.authAudience ?? {}) as Json;
  if ("defaultValue" in audience || audience.minLength !== 36 || audience.maxLength !== 36) {
    v.push("rule 11: authAudience must be a required 36-character parameter (the API app's client ID)");
  }
  const agentEnv = apps(all).filter((r) => r.name === "ca-l1-agent").flatMap((r) => containersOf(r).flatMap((c) => c.env ?? []));
  const audienceEnv = agentEnv.find((e) => e.name === "AUTH_AUDIENCE");
  if (audienceEnv?.value !== "[parameters('authAudience')]" || deploymentParam(all, "apps", "authAudience") !== JSON.stringify({ value: "[parameters('authAudience')]" })) {
    v.push("rule 11: the agent's AUTH_AUDIENCE must come from the authAudience parameter");
  }

  // Rule 12: each app and job runs from its own unit's image (research R14), x402-<image>:<imageTag>, and that
  // image contains the entry point its command runs. The proxy sidecars run the pinned nginx image.
  const passed = (module: string, param: string) => (JSON.parse(deploymentParam(all, module, param)) as { value?: unknown } | null)?.value;
  const selects = (expr: unknown, unit: string) =>
    typeof expr === "string" && expr.endsWith(`.${unit}]`) && expr.includes(`'${unit}', format('{0}/x402-${UNIT_IMAGE[unit]}:{1}'`);
  const appImages = (passed("apps", "images") ?? {}) as Record<string, unknown>;
  for (const unit of ["l1", "l2", "l3"]) if (!selects(appImages[unit], unit)) v.push(`rule 12: apps image ${unit} is not x402-${UNIT_IMAGE[unit]}:<imageTag>`);
  if (!selects(passed("sellers", "image"), "seller")) v.push("rule 12: the sellers' image is not x402-seller:<imageTag>");
  for (const a of apps(all)) {
    const name = namesOf(a).join("/");
    for (const c of containersOf(a)) {
      if (c.image === "[parameters('proxyImage')]") continue;
      const unit = a.module === "sellers" && c.image === "[parameters('image')]" ? "seller" : /^\[parameters\('images'\)\.(l1|l2|l3)\]$/.exec(String(c.image))?.[1];
      const entry = c.command?.[1]?.replace(/^dist\//, "").replace(/\.js$/, ".ts");
      if (unit === undefined) v.push(`rule 12: ${name}/${c.name} runs no layer image`);
      else if (namesOf(a).some((n) => APP_UNIT[n] !== unit)) v.push(`rule 12: ${name}/${c.name} runs the ${UNIT_IMAGE[unit]} image, not its own unit's`);
      else if (entry === undefined || !IMAGES[UNIT_IMAGE[unit]].entries.includes(entry)) v.push(`rule 12: ${name}/${c.name} runs ${c.command?.[1]}, which the ${UNIT_IMAGE[unit]} image doesn't contain`);
    }
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

describe.skipIf(!BICEP_PATH)("T-IAC-01 Azure identity, secret and exposure rules", () => {
  let bicep: Bicep;
  const tmp: string[] = [];
  beforeAll(async () => {
    bicep = await Bicep.initialize(BICEP_PATH!);
  }, 60_000);
  afterAll(() => {
    bicep?.dispose();
    for (const d of tmp) rmSync(d, { recursive: true, force: true });
  });

  async function compile(infraDir: string): Promise<Json> {
    const r = await bicep.compile({ path: resolve(infraDir, "main.bicep") });
    const errors = r.diagnostics.filter((d) => d.level === "Error");
    expect(errors.map((d) => `${d.code} ${d.message}`)).toEqual([]);
    expect(r.success).toBe(true);
    return JSON.parse(r.contents!) as Json;
  }

  /** A copy of infra/ with one edit, compiled. */
  async function mutant(file: string, from: string, to: string): Promise<string[]> {
    const dir = mkdtempSync(join(tmpdir(), "infra-mutant-"));
    tmp.push(dir);
    cpSync("infra", dir, { recursive: true });
    const path = join(dir, file);
    const text = readFileSync(path, "utf8");
    expect(text.includes(from), `${file} contains the mutation anchor`).toBe(true);
    writeFileSync(path, text.replace(from, to));
    return violations(await compile(dir), infraSources(dir));
  }

  it("T-IAC-01 the real template passes rules 1–12", async () => {
    expect(violations(await compile("infra"), infraSources("infra"))).toEqual([]);
  }, 60_000);

  it("T-IAC-01 must-fail rule 1: a role assignment of id-l1 outside the matrix (on the l2 vault's resource group) is reported", async () => {
    const extra = `
resource extraRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid('kv-x402-l2', 'id-l1')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '${KV_SECRETS_USER}')
    principalId: identity['id-l1'].principalId
    principalType: 'ServicePrincipal'
  }
}
`;
    const v = await mutant("main.bicep", "var images = ", `${extra}\nvar images = `);
    expect(v.some((m) => m.startsWith("rule 1:"))).toBe(true);
  }, 60_000);

  it("T-IAC-01 must-fail rule 2: PAYER_PRIVATE_KEY on the agent is reported", async () => {
    const v = await mutant("modules/apps.bicep", "            { name: 'CONTROL_TOKEN', secretRef: 'control-token' }\n            { name: 'VERIFIER_TOKEN'", "            { name: 'PAYER_PRIVATE_KEY', secretRef: 'control-token' }\n            { name: 'CONTROL_TOKEN', secretRef: 'control-token' }\n            { name: 'VERIFIER_TOKEN'");
    expect(v).toContain("rule 2: PAYER_PRIVATE_KEY in ca-l1-agent/agent");
  }, 60_000);

  it("T-IAC-01 must-fail rule 3: external ingress on ca-l2-control is reported", async () => {
    const v = await mutant("modules/apps.bicep", "ingress: { external: false, targetPort: 8080", "ingress: { external: true, targetPort: 8080");
    expect(v).toContain("rule 3: ca-l2-control has external ingress");
  }, 60_000);

  it("T-IAC-01 must-fail rule 9: ALLOWED_HOSTS pointing at the alias seller is reported", async () => {
    const v = await mutant("modules/apps.bicep", "value: 'ca-seller.${cpDomain}'", "value: 'ca-seller-alias.${cpDomain}'");
    expect(v).toContain("rule 9: ALLOWED_HOSTS must be the ca-seller FQDN, not the alias");
  }, 60_000);

  it("T-IAC-01 must-fail rule 10: a vault firewall that allows by default is reported", async () => {
    const v = await mutant("modules/vault.bicep", "defaultAction: 'Deny'", "defaultAction: 'Allow'");
    expect(v).toContain("rule 10: vault firewall default is not Deny");
  }, 60_000);

  it("T-IAC-01 must-fail rule 11: an api:// default for the agent's audience is reported", async () => {
    const v = await mutant("main.bicep", "@minLength(36)\n@maxLength(36)\nparam authAudience string\n", "param authAudience string = 'api://x402-l1-agent'\n");
    expect(v).toContain("rule 11: authAudience must be a required 36-character parameter (the API app's client ID)");
  }, 60_000);

  it("T-IAC-01 must-fail rule 12: L2 running from the L1 image is reported", async () => {
    const v = await mutant("modules/apps.bicep", "image: images.l2\n          command: ['node', 'dist/src/layer2-control/service.js']", "image: images.l1\n          command: ['node', 'dist/src/layer2-control/service.js']");
    expect(v).toContain("rule 12: ca-l2-control/l2 runs the l1-agent image, not its own unit's");
  }, 60_000);

  it("T-IAC-01 must-fail rule 12: an operator command the L2 image doesn't contain is reported", async () => {
    const v = await mutant("modules/apps.bicep", "command: ['node', 'dist/scripts/escalations.js']", "command: ['node', 'dist/src/main.js']");
    expect(v).toContain("rule 12: job-operator/operator runs dist/src/main.js, which the l2-control image doesn't contain");
  }, 60_000);
});
