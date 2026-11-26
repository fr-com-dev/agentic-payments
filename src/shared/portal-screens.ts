// 017 the portal web app's screens (SPEC.md §8.2 L2-8; specs/017 research R8). The portal answers 200 with the web
// app's page for these paths only, so a probe for a file that doesn't exist gets a real 404. The web app's own
// matcher stays in web/portal/src/routes.ts (`matchRoute`); T-WEB-14 keeps the two equal, one row per screen but
// "not-found". Pure: no I/O, no Node or DOM types, so both the portal and the web app's tests import it.

export interface PortalScreen {
  /** The web app's screen name (`Screen["name"]` in web/portal/src/routes.ts). */
  name: string;
  /** Anchored, on the path without its trailing slashes. */
  pattern: RegExp;
  /** A path that `matchRoute` maps to `name`. */
  example: string;
}

export const PORTAL_SCREENS: readonly PortalScreen[] = [
  { name: "home", pattern: /^\/$/, example: "/" },
  { name: "profile-step", pattern: /^\/onboarding\/profile$/, example: "/onboarding/profile" },
  { name: "wallet-step", pattern: /^\/onboarding\/wallet$/, example: "/onboarding/wallet" },
  { name: "policy-step", pattern: /^\/onboarding\/policy$/, example: "/onboarding/policy" },
  { name: "profile", pattern: /^\/profile$/, example: "/profile" },
  { name: "wallet", pattern: /^\/wallet$/, example: "/wallet" },
  // 020: where Coinbase sends the browser back (specs/020 contracts/portal-ui.md "Screens").
  { name: "coinbase-return", pattern: /^\/wallet\/coinbase$/, example: "/wallet/coinbase" },
  { name: "policies", pattern: /^\/policies$/, example: "/policies" },
  { name: "policy-new", pattern: /^\/policies\/new$/, example: "/policies/new" },
  { name: "policy-edit", pattern: /^\/policies\/[^/]+$/, example: "/policies/p-1" },
  { name: "policy-history", pattern: /^\/policies\/[^/]+\/history$/, example: "/policies/p-1/history" },
  { name: "account", pattern: /^\/account$/, example: "/account" },
  { name: "admin-waiting", pattern: /^\/admin$/, example: "/admin" },
  { name: "admin-activity", pattern: /^\/admin\/activity$/, example: "/admin/activity" },
  { name: "admin-ledger", pattern: /^\/admin\/ledger$/, example: "/admin/ledger" },
  { name: "admin-payment", pattern: /^\/admin\/escalations\/[^/]+$/, example: "/admin/escalations/a-1" },
];

/** True when `path` (a URL path, trailing slashes allowed) is one of the web app's screens. */
export function isScreenPath(path: string): boolean {
  const p = path.replace(/\/+$/, "") || "/";
  return PORTAL_SCREENS.some((s) => s.pattern.test(p));
}
