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
  /** 1.23: the ledger head's storage account. */
  ledgerHead: string;
  foundry: string;
  environments: Record<"x402" | "seller", string>;
  /** One per unit, and (1.23) l2head: the one identity that may write the ledger's head. */
  identities: Record<"l1" | "l2" | "l3" | "op" | "portal" | "seller" | "l2head", string>;
  vaults: Record<"l1" | "l2" | "l3" | "op" | "portal" | "seller", string>;
  apps: Record<"l1" | "l2" | "l3" | "portal" | "seller" | "sellerAlias", string>;
  /** l1: the regression job; l2: the operator job; smoke (016): the hosted smoke run, a job of the L1 unit. */
  jobs: Record<"l1" | "l2" | "smoke", string>;
}
/** pre-deploy.bicep's names for an environment (pre-deploy.<environment>.bicepparam). */
export interface PreDeployNames {
  resourceGroup: string;
  deployApp: string;
  operators: string;
  /** v1.25: the units' identities, made by pre-deploy (the same names as main's). */
  identities: Record<string, string>;
  /** v1.25: the policy assignment that refuses federated credentials on them. */
  policy: string;
}

/** Every string leaf of an object, with its dotted path. */
export function leaves(value: unknown, path: string[] = []): [string, string][] {
  if (typeof value === "string") return [[path.join("."), value]];
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => leaves(v, [...path, k]));
  return [];
}
