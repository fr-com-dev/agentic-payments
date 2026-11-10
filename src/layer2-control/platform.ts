// 013 platform configuration (SPEC.md §9 CFG-4, L2-8; specs/013 data-model.md "Platform configuration"). The
// operator's ceilings for every user and the seller list users may pick from. Read once at startup, only when user
// accounts are on; any error stops L2 before it takes the ledger lock. A user's policy can be stricter than these
// limits, never looser (NFR-001).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PlatformLimits, PlatformSeller } from "../shared/contracts.js";
import { canonicalJSON } from "./ledger.js";

export interface PlatformConfig {
  platformId: string;
  limits: PlatformLimits;
  sellers: PlatformSeller[];
}

export const DEFAULT_PLATFORM_FILE = "config/platform.json";
export const MAX_SELLERS = 200;
export const SELLER_NAME_MAX = 60;

export class PlatformError extends Error {
  override name = "PlatformError";
}

type Env = Record<string, string | undefined>;
const ATOMIC = /^\d+$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HOST = /^[a-z0-9.-]+(:\d{1,5})?$/;
const LIMIT_AMOUNTS = ["hardCapPerPaymentAtomic", "sessionBudgetAtomic", "userDailyCeilingAtomic"] as const;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** `host[:port]` exactly as R6 compares it: what `new URL(...).host` gives for a URL at that seller. */
export function validSellerHost(host: unknown): host is string {
  if (typeof host !== "string" || !HOST.test(host)) return false;
  try {
    return new URL(`http://${host}`).host === host;
  } catch {
    return false;
  }
}

function buildSellers(raw: unknown, where: string): PlatformSeller[] {
  if (!Array.isArray(raw)) throw new PlatformError(`${where} must be an array`);
  if (raw.length > MAX_SELLERS) throw new PlatformError(`${where} holds more than ${MAX_SELLERS} sellers`);
  const seen = new Set<string>();
  return raw.map((s, i) => {
    const at = `${where}[${i}]`;
    if (!isObject(s)) throw new PlatformError(`${at} must be an object`);
    if (!validSellerHost(s.host)) throw new PlatformError(`${at}.host must be a lower-case host[:port]`);
    if (seen.has(s.host)) throw new PlatformError(`${at}.host is listed twice`);
    seen.add(s.host);
    if (typeof s.name !== "string" || s.name.trim().length < 1 || s.name.length > SELLER_NAME_MAX) {
      throw new PlatformError(`${at}.name must be 1 to ${SELLER_NAME_MAX} characters`);
    }
    const payees = s.payees ?? [];
    if (!Array.isArray(payees) || payees.some((p) => typeof p !== "string" || !ADDRESS.test(p))) {
      throw new PlatformError(`${at}.payees must be an array of addresses`);
    }
    return { host: s.host, name: s.name.trim(), payees: (payees as string[]).map((p) => p.toLowerCase()) };
  });
}

/** Builds the config from parsed JSON and the environment override. Pure apart from its inputs. */
export function buildPlatform(json: unknown, env: Env = {}): PlatformConfig {
  if (!isObject(json)) throw new PlatformError("the platform config must be a JSON object");
  if (typeof json.platformId !== "string" || json.platformId.length === 0) throw new PlatformError("platformId must be a non-empty string");
  const l = json.limits;
  if (!isObject(l)) throw new PlatformError("limits must be an object");
  for (const f of LIMIT_AMOUNTS) {
    if (typeof l[f] !== "string" || !ATOMIC.test(l[f] as string)) throw new PlatformError(`limits.${f} must be an atomic-unit decimal string`);
  }
  if (BigInt(l.hardCapPerPaymentAtomic as string) > BigInt(l.sessionBudgetAtomic as string)) {
    throw new PlatformError("limits.hardCapPerPaymentAtomic must not exceed limits.sessionBudgetAtomic");
  }
  const rate = l.maxAuthorizationsPerMinute;
  if (typeof rate !== "number" || !Number.isInteger(rate) || rate < 1 || rate > 600) {
    throw new PlatformError("limits.maxAuthorizationsPerMinute must be an integer from 1 to 600");
  }
  const days = l.maxPolicyDays;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 3650) {
    throw new PlatformError("limits.maxPolicyDays must be an integer from 1 to 3650");
  }
  let sellers: PlatformSeller[];
  if (env.PLATFORM_SELLERS !== undefined && env.PLATFORM_SELLERS !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.PLATFORM_SELLERS);
    } catch {
      throw new PlatformError("PLATFORM_SELLERS is not valid JSON");
    }
    sellers = buildSellers(parsed, "PLATFORM_SELLERS");
  } else {
    sellers = buildSellers(json.sellers ?? [], "sellers");
  }
  return {
    platformId: json.platformId,
    limits: {
      hardCapPerPaymentAtomic: l.hardCapPerPaymentAtomic as string,
      sessionBudgetAtomic: l.sessionBudgetAtomic as string,
      userDailyCeilingAtomic: l.userDailyCeilingAtomic as string,
      maxAuthorizationsPerMinute: rate,
      maxPolicyDays: days,
    },
    sellers,
  };
}

/** Reads `config/platform.json` (or `PLATFORM_FILE`) and applies `PLATFORM_SELLERS`. */
export function loadPlatform(env: Env = process.env, file: string = env.PLATFORM_FILE || DEFAULT_PLATFORM_FILE): PlatformConfig {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new PlatformError(`cannot read the platform config ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return buildPlatform(json, env);
}

/** SHA-256 of the canonical JSON: stable under key order, different for any changed value. */
export function platformDigest(config: PlatformConfig): string {
  return createHash("sha256").update(canonicalJSON(config), "utf8").digest("hex");
}

export function sellerFor(config: PlatformConfig, host: string): PlatformSeller | undefined {
  return config.sellers.find((s) => s.host === host);
}
