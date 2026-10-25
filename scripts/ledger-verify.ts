// Operator CLI (SPEC.md §13, L2-5): `npm run ledger-verify`. Owner: feature 011 (cloud regression chain check).
// Calls GET /v1/ledger/verify with OPERATOR_TOKEN. Reads only CONTROL_URL and OPERATOR_TOKEN
// (env/operator.env). Exit codes: 0 when the chain verifies; 1 on an HTTP or network error or `ok: false`.
import { pathToFileURL } from "node:url";
import { loadEnv, serviceUrls, tokenFor } from "../src/shared/config.js";

export async function ledgerVerify(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const url = `${serviceUrls(env).control}/v1/ledger/verify`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${tokenFor("operator", env)}` } });
  } catch (err) {
    console.error(`ledger-verify: control service unreachable at ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const text = await res.text();
  if (res.status !== 200) {
    console.error(`ledger-verify: HTTP ${res.status} ${text}`);
    return 1;
  }
  const check = JSON.parse(text) as { entries: number; ok: boolean; brokenAt?: number };
  console.log(`entries=${check.entries} ok=${check.ok}${check.brokenAt !== undefined ? ` brokenAt=${check.brokenAt}` : ""}`);
  return check.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    loadEnv("operator");
    process.exitCode = await ledgerVerify();
  } catch (err) {
    console.error(`ledger-verify: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
