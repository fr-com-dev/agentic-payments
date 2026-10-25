// INV-3 / SEC-2: the refusal both L1 entry points (src/main.ts, src/hosted-main.ts) print when the payer
// key is visible. It lives outside src/layer1-intent/ because rule A5 bans the key's name in L1 code,
// string literals included.
export const REFUSAL =
  "refusing to start: PAYER_PRIVATE_KEY is visible to the agent process. The payer key belongs only to L2 (INV-3).";
