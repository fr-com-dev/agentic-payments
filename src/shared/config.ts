// Shared configuration (SPEC.md §3.1, §9). Pure helpers plus the one env loader every entry point uses.
// Sections have separate owners: network profiles, deployment record and formatAtomic (006);
// loadEnv, ports, bind hosts, URLs and role tokens (007).
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { config as dotenvConfig } from "dotenv";

type Env = Record<string, string | undefined>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

// ---------------------------------------------------------------------------
// CFG-1 network profiles (006)
// ---------------------------------------------------------------------------

export type NetworkName = "local" | "base-sepolia";
export type Caip2 = `${string}:${string}`;
export type Address = `0x${string}`;

export interface NetworkProfile {
  name: NetworkName;
  caip2: Caip2;
  chainId: number;
  rpcUrl: string;
  /** Throws on `local` when `.local/deployment.json` is missing (CP-5 fail-fast). */
  readonly asset: Address;
  /** False only on `local` without a deployment record. */
  hasAsset: boolean;
  decimals: number;
  assetDomain: { name: string; version: string };
  facilitatorUrl: string;
  confirmationDepth: number;
  supportsSafeTag: boolean;
}

export interface LocalDeployment {
  chainId: number;
  rpcUrl: string;
  asset: Address;
  accounts: { deployer: Address; facilitator: Address; payer: Address; sellerPayTo: Address };
  deployedAt: string;
}

export const DEFAULT_DEPLOYMENT_FILE = ".local/deployment.json";
export const BASE_SEPOLIA_USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const LOCAL_RPC_URL = "http://127.0.0.1:8545";

const DEPLOYMENT_KEYS = ["chainId", "rpcUrl", "asset", "accounts", "deployedAt"] as const;
const ACCOUNT_KEYS = ["deployer", "facilitator", "payer", "sellerPayTo"] as const;

/** Reads `.local/deployment.json`. Returns null if the file does not exist. The record holds addresses only. */
export function readDeployment(file: string = DEFAULT_DEPLOYMENT_FILE): LocalDeployment | null {
  const path = resolve(file);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const extra = Object.keys(raw).filter((k) => !(DEPLOYMENT_KEYS as readonly string[]).includes(k));
  const accounts = raw.accounts as Record<string, unknown> | undefined;
  const extraAccounts = accounts
    ? Object.keys(accounts).filter((k) => !(ACCOUNT_KEYS as readonly string[]).includes(k))
    : [];
  if (extra.length > 0 || extraAccounts.length > 0) {
    throw new ConfigError(
      `${file}: deployment record holds addresses only, never private keys; unexpected fields: ${[...extra, ...extraAccounts].join(", ")}`,
    );
  }
  for (const k of DEPLOYMENT_KEYS) {
    if (raw[k] === undefined) throw new ConfigError(`${file}: missing field ${k}`);
  }
  return raw as unknown as LocalDeployment;
}

export interface NetworkProfileOptions {
  env?: Env;
  deploymentFile?: string;
}

/** CFG-1. Selection: `NETWORK`, default `local`. An unknown name throws. */
export function networkProfile(name?: string, opts: NetworkProfileOptions = {}): NetworkProfile {
  const env = opts.env ?? process.env;
  const selected = name ?? env.NETWORK ?? "local";
  if (selected === "local") {
    const deploymentFile = opts.deploymentFile ?? DEFAULT_DEPLOYMENT_FILE;
    const dep = readDeployment(deploymentFile);
    const profile: NetworkProfile = {
      name: "local",
      caip2: "eip155:31337",
      chainId: 31337,
      rpcUrl: dep?.rpcUrl ?? LOCAL_RPC_URL,
      get asset(): Address {
        if (!dep) {
          throw new ConfigError(
            `local asset unresolved: ${deploymentFile} is missing. Start the chain with \`npm run local:chain\`.`,
          );
        }
        return dep.asset;
      },
      hasAsset: dep !== null,
      decimals: 6,
      assetDomain: { name: "USD Coin", version: "2" },
      facilitatorUrl: env.FACILITATOR_URL || "http://127.0.0.1:4022",
      confirmationDepth: 1,
      supportsSafeTag: false,
    };
    return profile;
  }
  if (selected === "base-sepolia") {
    return {
      name: "base-sepolia",
      caip2: "eip155:84532",
      chainId: 84532,
      rpcUrl: env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      asset: BASE_SEPOLIA_USDC,
      hasAsset: true,
      decimals: 6,
      assetDomain: { name: "USDC", version: "2" },
      facilitatorUrl: env.FACILITATOR_URL || "https://x402.org/facilitator",
      confirmationDepth: 2,
      supportsSafeTag: true,
    };
  }
  throw new ConfigError(`unknown network "${selected}" (expected "local" or "base-sepolia")`);
}

// ---------------------------------------------------------------------------
// CP-3 facilitator selection (009, SPEC v1.2). Pure; never reads the CDP credential (A8).
// ---------------------------------------------------------------------------

export type FacilitatorKind = "local" | "public" | "cdp";

export const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
/** Per-request timeout for hosted facilitators (FR-017). The local facilitator keeps the SDK default. */
export const HOSTED_FACILITATOR_TIMEOUT_MS = 30_000;

export interface FacilitatorChoice {
  kind: FacilitatorKind;
  url: string;
  /** Absent for `local`: the SDK default applies, so the local baseline is unchanged. */
  timeoutMs?: number;
  authenticated: boolean;
}

/**
 * CP-3 (contracts/seller-config.md). Resolves the seller's facilitator once at startup from
 * `FACILITATOR` (default `local` on local, `cdp` on base-sepolia). Every invalid combination throws.
 */
export function facilitatorChoice(net: NetworkProfile, env: Env = process.env): FacilitatorChoice {
  const raw = env.FACILITATOR || undefined;
  if (raw !== undefined && raw !== "local" && raw !== "public" && raw !== "cdp") {
    throw new ConfigError(`unknown FACILITATOR "${raw}" (expected local, public or cdp)`);
  }
  const kind: FacilitatorKind = raw ?? (net.name === "local" ? "local" : "cdp");
  if (net.name === "local") {
    if (kind !== "local") throw new ConfigError(`FACILITATOR=${kind} is not valid on NETWORK=local`);
    return { kind, url: net.facilitatorUrl, authenticated: false };
  }
  if (kind === "local") throw new ConfigError("FACILITATOR=local is only valid on NETWORK=local");
  if (kind === "public") {
    return { kind, url: net.facilitatorUrl, timeoutMs: HOSTED_FACILITATOR_TIMEOUT_MS, authenticated: false };
  }
  if (env.FACILITATOR_URL) throw new ConfigError("FACILITATOR=cdp cannot be combined with FACILITATOR_URL");
  return { kind, url: CDP_FACILITATOR_URL, timeoutMs: HOSTED_FACILITATOR_TIMEOUT_MS, authenticated: true };
}

/** Formats an atomic-unit decimal string with BigInt math only (Principle VI). Display use only. */
export function formatAtomic(amountAtomic: string, decimals: number): string {
  if (!/^\d+$/.test(amountAtomic)) throw new ConfigError(`not an atomic amount: "${amountAtomic}"`);
  if (!Number.isInteger(decimals) || decimals < 0) throw new ConfigError(`bad decimals: ${decimals}`);
  const value = BigInt(amountAtomic);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const frac = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac.length > 0 ? `${whole}.${frac}` : whole.toString();
}

// ---------------------------------------------------------------------------
// CFG-2 environment loading (007)
// ---------------------------------------------------------------------------

export type EnvRole = "l1-agent" | "l2-control" | "l3-verifier" | "seller" | "facilitator" | "operator";

/**
 * Loads exactly one env file: `ENV_FILE`, or `env/<role>.env` by default (SPEC §3.1, CFG-2).
 * Variables already in the process environment win (no override). A root `.env` is never loaded.
 * Returns the path that was loaded, or null when the default file does not exist.
 */
export function loadEnv(role: EnvRole): string | null {
  const explicit = process.env.ENV_FILE;
  const file = explicit && explicit.length > 0 ? explicit : `env/${role}.env`;
  if (basename(file) === ".env") {
    throw new ConfigError(`refusing to load a root-style ".env" (${file}); use env/<role>.env (CFG-2)`);
  }
  const path = resolve(file);
  if (!existsSync(path)) {
    if (explicit) throw new ConfigError(`ENV_FILE not found: ${file}`);
    return null;
  }
  dotenvConfig({ path, override: false, quiet: true });
  return path;
}

// ---------------------------------------------------------------------------
// §3.1 ports and bind hosts (007)
// ---------------------------------------------------------------------------

/** L2 and L3 bind to loopback only. Not configurable (NFR-001). */
export const CONTROL_BIND_HOST = "127.0.0.1";
export const SETTLEMENT_BIND_HOST = "127.0.0.1";
/** The seller plays an external party and listens on all interfaces (§3.1). */
export const SELLER_BIND_HOST = "0.0.0.0";
export const FACILITATOR_BIND_HOST = "127.0.0.1";
/** The local chain port is fixed. */
export const CHAIN_PORT = 8545;

export const DEFAULT_PORTS = { control: 4020, seller: 4021, facilitator: 4022, settlement: 4023 } as const;

function portFrom(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new ConfigError(`${name} is not a valid port: "${raw}"`);
  return n;
}

export const controlPort = (env: Env = process.env) => portFrom(env, "CONTROL_PORT", DEFAULT_PORTS.control);
export const sellerPort = (env: Env = process.env) => portFrom(env, "SELLER_PORT", DEFAULT_PORTS.seller);
export const facilitatorPort = (env: Env = process.env) =>
  portFrom(env, "FACILITATOR_PORT", DEFAULT_PORTS.facilitator);
export const settlementPort = (env: Env = process.env) =>
  portFrom(env, "SETTLEMENT_PORT", DEFAULT_PORTS.settlement);

/** `API_DOCS=1` serves Swagger UI on L2 (L2-5). Off when unset, empty or `0`; any other value is a startup error. */
export function apiDocsEnabled(env: Env = process.env): boolean {
  const raw = env.API_DOCS;
  if (raw === undefined || raw === "" || raw === "0") return false;
  if (raw === "1") return true;
  throw new ConfigError(`API_DOCS must be 1 or 0: "${raw}"`);
}

/** Service URLs for clients. Each has an explicit env override and a loopback default. */
export function serviceUrls(env: Env = process.env) {
  return {
    control: env.CONTROL_URL || `http://127.0.0.1:${controlPort(env)}`,
    settlement: env.SETTLEMENT_URL || `http://127.0.0.1:${settlementPort(env)}`,
    seller: env.SELLER_URL || `http://127.0.0.1:${sellerPort(env)}`,
  };
}

// ---------------------------------------------------------------------------
// INV-13 role tokens (007)
// ---------------------------------------------------------------------------

export type Role = "agent-control" | "agent-verifier" | "verifier-control" | "operator";

export const ROLE_TOKEN_VAR: Record<Role, string> = {
  "agent-control": "CONTROL_TOKEN",
  "agent-verifier": "VERIFIER_TOKEN",
  "verifier-control": "SETTLEMENT_TOKEN",
  operator: "OPERATOR_TOKEN",
};

export const DEV_TOKENS: Record<string, string> = {
  CONTROL_TOKEN: "dev-control-token",
  VERIFIER_TOKEN: "dev-verifier-token",
  SETTLEMENT_TOKEN: "dev-settlement-token",
  OPERATOR_TOKEN: "dev-operator-token",
};

/**
 * Resolves the bearer token for a role (CFG-2). Dev defaults apply only when `NETWORK=local` and
 * the variable is unset. An empty string is always an error; off `local`, an unset token is an error.
 * Entry points let the ConfigError escape so the process exits 1 at startup.
 */
export function tokenFor(role: Role, env: Env = process.env): string {
  const name = ROLE_TOKEN_VAR[role];
  const value = env[name];
  if (value === "") throw new ConfigError(`empty ${name}`);
  if (value !== undefined) return value;
  if ((env.NETWORK ?? "local") === "local") return DEV_TOKENS[name]!;
  throw new ConfigError(`missing ${name}`);
}
