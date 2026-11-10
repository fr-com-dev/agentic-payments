// npm run dev-token -- [--subject <name>] [--no-role] [--expired] [--service] [--portal] [--auth-age <seconds>]
// Prints one access token from the local dev issuer (NETWORK=local only): for the hosted agent service by default,
// or with --portal for the portal (013: scp Portal.Access, the portal's client as azp, a fresh auth_time).
// --auth-age backdates auth_time, to try the "confirm it's you" step. Exit codes: 0 printed; 2 NETWORK is not local
// or a bad argument.
import { DEV_PORTAL_CLIENT, DEV_PORTAL_SCOPE, loadOrCreateDevIssuer, signDevToken } from "./dev-issuer-lib.js";

async function main(argv: string[]): Promise<number> {
  if ((process.env.NETWORK ?? "local") !== "local") {
    console.error("dev-token: NETWORK must be local; the dev issuer is never valid elsewhere");
    return 2;
  }
  const at = argv.indexOf("--subject");
  const subject = at >= 0 && argv[at + 1] ? argv[at + 1]! : "dev-user";
  const ageAt = argv.indexOf("--auth-age");
  const ageRaw = ageAt >= 0 ? argv[ageAt + 1] : undefined;
  if (ageAt >= 0 && (ageRaw === undefined || !/^\d+$/.test(ageRaw))) {
    console.error("dev-token: --auth-age needs a whole number of seconds");
    return 2;
  }
  const portal = argv.includes("--portal");
  if (portal && argv.includes("--service")) {
    console.error("dev-token: --portal and --service can't be combined (the portal refuses system identities)");
    return 2;
  }
  const issuer = await loadOrCreateDevIssuer();
  const token = await signDevToken(issuer, {
    subject,
    ...(portal && {
      scp: DEV_PORTAL_SCOPE,
      azp: DEV_PORTAL_CLIENT,
      authTime: Math.floor(Date.now() / 1000) - Number(ageRaw ?? 0),
    }),
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
