// Operator reject CLI (SPEC.md §13, L2-5, L2-4.3): `npm run reject -- <authorizationId> [operator] [reason]`.
// Owner: feature 010. Reads only CONTROL_URL and OPERATOR_TOKEN (env/operator.env). Exit codes: 0 on 200,
// 1 on an HTTP or network error (409 included), 2 on a missing argument. Mirrors scripts/approve.ts.
import { pathToFileURL } from "node:url";
import { loadEnv, serviceUrls, tokenFor } from "../src/shared/config.js";

const USAGE = "usage: npm run reject -- <authorizationId> [operator] [reason]";

export async function reject(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [authorizationId, operator, ...reasonParts] = argv;
  if (!authorizationId) {
    console.error(USAGE);
    return 2;
  }
  const reason = reasonParts.join(" ");
  const url = `${serviceUrls(env).control}/v1/rejections/${encodeURIComponent(authorizationId)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenFor("operator", env)}` },
      body: JSON.stringify({ ...(operator && { operator }), ...(reason.length > 0 && { reason }) }),
    });
  } catch (err) {
    console.error(`reject: control service unreachable at ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const text = await res.text();
  if (res.status === 200) {
    console.log(text);
    return 0;
  }
  console.error(`reject: HTTP ${res.status} ${text}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    loadEnv("operator");
    process.exitCode = await reject(process.argv.slice(2));
  } catch (err) {
    console.error(`reject: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
