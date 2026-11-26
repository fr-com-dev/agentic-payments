// INV-3 / SEC-2: the refusal both L1 entry points (src/main.ts, src/hosted-main.ts) print when the payer
// key is visible. It lives outside src/layer1-intent/ because rule A5 bans the key's name in L1 code,
// string literals included.
export const REFUSAL =
  "refusing to start: PAYER_PRIVATE_KEY is visible to the agent process. The payer key belongs only to L2 (INV-3).";

/**
 * 020 (SPEC §4.1 A18): the portal's Coinbase credentials. The agent can never use one, so it refuses to start when it can
 * see either, as it refuses the payer key. The name is printed, never the value.
 */
export const COINBASE_CREDENTIALS = ["COINBASE_CLIENT_SECRET", "COINBASE_GRANT_KEY"] as const;

/** The first Coinbase credential visible in `env`, if any. */
export function visibleCoinbaseCredential(env: Record<string, string | undefined>): string | undefined {
  return COINBASE_CREDENTIALS.find((name) => env[name] !== undefined);
}

export const coinbaseRefusal = (name: string) =>
  `refusing to start: ${name} is visible to the agent process. The Coinbase credentials belong only to the portal (A18).`;

