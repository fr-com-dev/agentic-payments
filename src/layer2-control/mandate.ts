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

/** Builds a mandate from parsed JSON, the network profile and env overrides. Pure apart from its inputs. */
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
  const payees = env.ALLOWED_PAYEES ? csv(env.ALLOWED_PAYEES) : ((json.allowedPayees as string[] | undefined) ?? []);
  const hosts = env.ALLOWED_HOSTS ? csv(env.ALLOWED_HOSTS) : ((json.allowedHosts as string[] | undefined) ?? []);
  const m: SpendingMandate = {
    mandateId: String(json.mandateId),
    expiresAt: String(json.expiresAt),
    allowedSchemes: (json.allowedSchemes as string[] | undefined) ?? ["exact"],
    allowedNetworks: [net.caip2],
    allowedAssets: { [net.caip2]: [net.asset.toLowerCase()] },
    allowedPayees: payees.map((p) => p.toLowerCase()),
    allowedHosts: hosts,
    autoApproveMaxAtomic: json.autoApproveMaxAtomic as string,
    hardCapPerPaymentAtomic: json.hardCapPerPaymentAtomic as string,
    sessionBudgetAtomic: json.sessionBudgetAtomic as string,
    dailyBudgetAtomic: json.dailyBudgetAtomic as string,
    maxAuthorizationsPerMinute: Number(json.maxAuthorizationsPerMinute),
    maxTimeoutSeconds: Number(json.maxTimeoutSeconds),
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

/** Reads `config/mandate.json` and applies the profile and env overrides (L2-1). */
export function loadMandate(
  net: Pick<NetworkProfile, "caip2" | "asset">,
  env: Env = process.env,
  file: string = DEFAULT_MANDATE_FILE,
): SpendingMandate {
  const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  return buildMandate(json, net, env);
}
