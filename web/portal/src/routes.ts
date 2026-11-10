// Screens and their paths (specs/013 contracts/portal-ui.md "Screens"). A small route table over the History API:
// no router package. `resolveRoute` is pure, so the redirect rules are tested without a browser.
import type { Onboarding } from "./types.js";

export type Screen =
  | { name: "home" }
  | { name: "profile-step" }
  | { name: "wallet-step" }
  | { name: "policy-step" }
  | { name: "profile" }
  | { name: "wallet" }
  | { name: "policies" }
  | { name: "policy-new" }
  | { name: "policy-edit"; policyId: string }
  | { name: "policy-history"; policyId: string }
  | { name: "account" }
  | { name: "not-found" };

export function matchRoute(path: string): Screen {
  const p = path.replace(/\/+$/, "") || "/";
  if (p === "/") return { name: "home" };
  if (p === "/onboarding/profile") return { name: "profile-step" };
  if (p === "/onboarding/wallet") return { name: "wallet-step" };
  if (p === "/onboarding/policy") return { name: "policy-step" };
  if (p === "/profile") return { name: "profile" };
  if (p === "/wallet") return { name: "wallet" };
  if (p === "/policies") return { name: "policies" };
  if (p === "/policies/new") return { name: "policy-new" };
  if (p === "/account") return { name: "account" };
  let m = /^\/policies\/([^/]+)\/history$/.exec(p);
  if (m) return { name: "policy-history", policyId: decodeURIComponent(m[1]!) };
  m = /^\/policies\/([^/]+)$/.exec(p);
  if (m) return { name: "policy-edit", policyId: decodeURIComponent(m[1]!) };
  return { name: "not-found" };
}

/** The first onboarding step that is not done, or null when all three are (FR-008). */
export function firstStepNotDone(o: Onboarding): string | null {
  if (!o.profile) return "/onboarding/profile";
  if (!o.wallet) return "/onboarding/wallet";
  if (!o.policy) return "/onboarding/policy";
  return null;
}

/**
 * Where a person actually lands for a path. A step that is already done, or a screen whose step is not done yet,
 * goes to the first step not done; a finished onboarding step goes home.
 */
export function resolveRoute(path: string, o: Onboarding): string {
  const screen = matchRoute(path);
  const next = firstStepNotDone(o);
  const needs: Record<string, keyof Onboarding | "all" | "none"> = {
    home: "none",
    "profile-step": "none",
    "wallet-step": "profile",
    "policy-step": "wallet",
    profile: "all",
    wallet: "profile",
    policies: "wallet",
    "policy-new": "wallet",
    "policy-edit": "wallet",
    "policy-history": "wallet",
    account: "profile",
    "not-found": "none",
  };
  const need = needs[screen.name]!;
  const missing = need === "all" ? next !== null : need !== "none" && !o[need];
  if (missing) return next ?? "/";
  // An onboarding step that is already done has nothing to show: go to the next one, or home.
  if (screen.name === "profile-step" && o.profile) return next ?? "/";
  if (screen.name === "wallet-step" && o.wallet) return next ?? "/";
  if (screen.name === "policy-step" && o.policy) return "/";
  // Home is the onboarding guide until all three steps are done.
  if (screen.name === "home" && next !== null) return next;
  return path;
}
