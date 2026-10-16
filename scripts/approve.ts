// HITL operator CLI (SPEC.md §13, L2-5): `npm run approve -- <authorizationId> [approver]`. Owner: feature 004.
// Reads only CONTROL_URL and OPERATOR_TOKEN (env/operator.env). Exit codes: 0 on 200, 1 on an HTTP or
// network error, 2 on a missing argument.
import { pathToFileURL } from "node:url";
import { loadEnv, serviceUrls, tokenFor } from "../src/shared/config.js";

const USAGE = "usage: npm run approve -- <authorizationId> [approver]";

export async function approve(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [authorizationId, approver] = argv;
  if (!authorizationId) {
    console.error(USAGE);
    return 2;
  }
  const url = `${serviceUrls(env).control}/v1/approvals/${encodeURIComponent(authorizationId)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenFor("operator", env)}` },
      body: JSON.stringify(approver ? { approver } : {}),
    });
  } catch (err) {
    console.error(`approve: control service unreachable at ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const text = await res.text();
  if (res.status === 200) {
    console.log(text);
    return 0;
  }
  console.error(`approve: HTTP ${res.status} ${text}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    loadEnv("operator");
    process.exitCode = await approve(process.argv.slice(2));
  } catch (err) {
    console.error(`approve: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
