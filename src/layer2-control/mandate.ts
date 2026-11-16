// Spending mandate (SPEC.md §8.2 L2-1, §9 CFG-3). Owner: feature 002.
// Networks and assets always come from the active network profile, never from the JSON file.
// A mandate that breaks `autoApproveMax < hardCap ≤ sessionBudget` fails to load (fail closed).
import { readFileSync } from "node:fs";
import type { NetworkProfile } from "../shared/config.js";

export interface SpendingMandate {
  mandateId: string;
  expiresAt: string;
  allowedSchemes: string[];
  allowedNetworks: string[];
  allowedAssets: Record<string, string[]>;
  allowedPayees: string[];
  allowedHosts: string[];
  autoApproveMaxAtomic: string;
  hardCapPerPaymentAtomic: string;
  sessionBudgetAtomic: string;
  dailyBudgetAtomic: string;
  maxAuthorizationsPerMinute: number;
  maxTimeoutSeconds: number;
}

export const DEFAULT_MANDATE_FILE = "config/mandate.json";

export class MandateError extends Error {
  override name = "MandateError";
}

type Env = Record<string, string | undefined>;
const ATOMIC = /^\d+$/;
const ATOMIC_FIELDS = ["autoApproveMaxAtomic", "hardCapPerPaymentAtomic", "sessionBudgetAtomic", "dailyBudgetAtomic"] as const;

const csv = (raw: string) =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** A whole number from `min` to `max`, or a MandateError naming the field. */
function wholeNumber(json: Record<string, unknown>, field: string, min: number, max: number): number {
  const v = json[field];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new MandateError(`${field} must be a whole number from ${min} to ${max}`);
  }
  return v;
}

/**
 * Builds a mandate from parsed JSON, the network profile and env overrides. Pure apart from its inputs.
 * 1.19: every field is checked, not only the amounts. A missing rate used to read as NaN, which R13 never trips
 * (`n >= NaN` is false), and a scheme list given as a string matched any substring of it.
 */
export function buildMandate(
  json: Record<string, unknown>,
  net: Pick<NetworkProfile, "caip2" | "asset">,
  env: Env = {},
): SpendingMandate {
  for (const f of ATOMIC_FIELDS) {
    if (typeof json[f] !== "string" || !ATOMIC.test(json[f] as string)) {
      throw new MandateError(`${f} must be an atomic-unit decimal string`);
    }
  }
  if (typeof json.mandateId !== "string" || json.mandateId.length === 0) throw new MandateError("mandateId must be a non-empty string");
  const schemes = json.allowedSchemes ?? ["exact"];
  if (!isStringList(schemes) || schemes.length === 0 || schemes.some((s) => s.length === 0)) {
    throw new MandateError("allowedSchemes must be a non-empty list of scheme names");
  }
  for (const f of ["allowedPayees", "allowedHosts"] as const) {
    if (json[f] !== undefined && !isStringList(json[f])) throw new MandateError(`${f} must be a list of strings`);
  }
  const payees = env.ALLOWED_PAYEES ? csv(env.ALLOWED_PAYEES) : ((json.allowedPayees as string[] | undefined) ?? []);
  const hosts = env.ALLOWED_HOSTS ? csv(env.ALLOWED_HOSTS) : ((json.allowedHosts as string[] | undefined) ?? []);
  const m: SpendingMandate = {
    mandateId: json.mandateId,
    expiresAt: String(json.expiresAt),
    allowedSchemes: schemes,
    allowedNetworks: [net.caip2],
    allowedAssets: { [net.caip2]: [net.asset.toLowerCase()] },
    allowedPayees: payees.map((p) => p.toLowerCase()),
    // R6 compares with `new URL(...).host`, which is lower case: an upper-case entry would match nothing.
    allowedHosts: hosts.map((h) => h.toLowerCase()),
    autoApproveMaxAtomic: json.autoApproveMaxAtomic as string,
    hardCapPerPaymentAtomic: json.hardCapPerPaymentAtomic as string,
    sessionBudgetAtomic: json.sessionBudgetAtomic as string,
    dailyBudgetAtomic: json.dailyBudgetAtomic as string,
    maxAuthorizationsPerMinute: wholeNumber(json, "maxAuthorizationsPerMinute", 1, 600),
    maxTimeoutSeconds: wholeNumber(json, "maxTimeoutSeconds", 1, 3600),
  };
  if (Number.isNaN(Date.parse(m.expiresAt))) throw new MandateError(`expiresAt is not an ISO date: ${m.expiresAt}`);
  const auto = BigInt(m.autoApproveMaxAtomic);
  const cap = BigInt(m.hardCapPerPaymentAtomic);
  const session = BigInt(m.sessionBudgetAtomic);
  if (!(auto < cap && cap <= session)) {
    throw new MandateError(
      `mandate constraint violated: need autoApproveMax (${auto}) < hardCap (${cap}) ≤ sessionBudget (${session}) (CFG-3)`,
    );
  }
  return m;
}

/**
 * 1.19 (L2-1, R5): outside `NETWORK=local`, every payment must be bound to known payees. R5 lets any payee through
 * when its list is empty, so an empty `allowedPayees` (the platform account's) or an empty `payees` of a seller on
 * the platform list (a user's payments there) would pay whatever address a challenge names. L2 refuses to start
 * instead. The error names the setting, never a value.
 */
export function checkPayeeBinding(
  network: string,
  mandate: Pick<SpendingMandate, "allowedPayees">,
  sellers: readonly { host: string; payees: readonly string[] }[] = [],
): void {
  if (network === "local") return;
  if (mandate.allowedPayees.length === 0) {
    throw new MandateError("ALLOWED_PAYEES (or allowedPayees in the mandate) must name the seller's payees outside NETWORK=local");
  }
  const unbound = sellers.findIndex((s) => s.payees.length === 0);
  if (unbound >= 0) {
    throw new MandateError(`the platform seller list's entry ${unbound} has no payees: every seller needs its payees outside NETWORK=local`);
  }
}

/** Reads `config/mandate.json` and applies the profile and env overrides (L2-1). */
export function loadMandate(
  net: Pick<NetworkProfile, "caip2" | "asset">,
  env: Env = process.env,
  file: string = DEFAULT_MANDATE_FILE,
): SpendingMandate {
  const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  return buildMandate(json, net, env);
}
