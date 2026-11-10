// The Bicep CLI from the tests (T-IAC-01, T-E2E-AZ): every value a deployment uses, its names included, is in a
// parameter file, and only Bicep reads one. Set BICEP_PATH (deploy.yml does; `az bicep install` puts it at
// ~/.azure/bin/bicep); without it the suites that need it are skipped.
import { spawnSync } from "node:child_process";

export const BICEP_PATH = process.env.BICEP_PATH;

/** A parameter file compiled by the Bicep CLI: each parameter's value, as its deployment would get it. */
export function buildParams(file: string): Record<string, unknown> {
  const r = spawnSync(BICEP_PATH!, ["build-params", file, "--stdout"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`bicep build-params ${file}: ${r.stderr}`);
  const params = (JSON.parse(JSON.parse(r.stdout).parametersJson) as { parameters: Record<string, { value: unknown }> }).parameters;
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v.value]));
}

/** main.bicep's names for an environment (main.<environment>.bicepparam). */
export interface MainNames {
  resourceGroup: string;
  network: string;
  subnets: Record<"x402" | "seller", string>;
  logs: string;
  registry: string;
  storage: string;
  foundry: string;
  environments: Record<"x402" | "seller", string>;
  identities: Record<"l1" | "l2" | "l3" | "op" | "portal" | "seller", string>;
  vaults: Record<"l1" | "l2" | "l3" | "op" | "portal" | "seller", string>;
  apps: Record<"l1" | "l2" | "l3" | "portal" | "seller" | "sellerAlias", string>;
  jobs: Record<"l1" | "l2", string>;
}
/** pre-deploy.bicep's names for an environment (pre-deploy.<environment>.bicepparam). */
export interface PreDeployNames {
  resourceGroup: string;
  apiApp: string;
  deployApp: string;
  /** 013: the portal web app's registration (a public client). */
  portalApp: string;
  operators: string;
  stateStorage: string;
}

/** Every string leaf of an object, with its dotted path. */
export function leaves(value: unknown, path: string[] = []): [string, string][] {
  if (typeof value === "string") return [[path.join("."), value]];
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => leaves(v, [...path, k]));
  return [];
}
