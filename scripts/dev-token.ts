// npm run dev-token -- [--subject <name>] [--no-role] [--expired] [--service]
// Prints one access token from the local dev issuer for the hosted agent service (NETWORK=local only).
// Exit codes: 0 printed; 2 NETWORK is not local.
import { loadOrCreateDevIssuer, signDevToken } from "./dev-issuer-lib.js";

async function main(argv: string[]): Promise<number> {
  if ((process.env.NETWORK ?? "local") !== "local") {
    console.error("dev-token: NETWORK must be local; the dev issuer is never valid elsewhere");
    return 2;
  }
  const at = argv.indexOf("--subject");
  const subject = at >= 0 && argv[at + 1] ? argv[at + 1]! : "dev-user";
  const issuer = await loadOrCreateDevIssuer();
  const token = await signDevToken(issuer, {
    subject,
    ...(argv.includes("--no-role") && { roles: [] }),
    ...(argv.includes("--service") && { idtyp: "app" as const }),
    ...(argv.includes("--expired") && { exp: Math.floor(Date.now() / 1000) - 120 }),
  });
  process.stdout.write(token + "\n");
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`dev-token: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
