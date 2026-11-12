// npm run dev-token -- [--subject <name>] [--no-role] [--expired] [--service] [--portal [--admin]] [--auth-age <seconds>]
// Prints one access token from the local dev issuer (NETWORK=local only): for the hosted agent service by default,
// or with --portal for the portal (013: scp Portal.Access, the portal's client as azp, a fresh auth_time).
// --auth-age backdates auth_time, to try the "confirm it's you" step. --admin (014, with --portal only) adds the
// Portal.Admin role; with --no-role the token carries that role alone. Exit codes: 0 printed; 2 NETWORK is not
// local or a bad argument.
import { pathToFileURL } from "node:url";
import { DEV_ADMIN_ROLE, DEV_PORTAL_CLIENT, DEV_PORTAL_SCOPE, DEV_ROLE, loadOrCreateDevIssuer, signDevToken } from "./dev-issuer-lib.js";

/** The `roles` claim for the flags given, or an error. Pure, so the flag rules are tested without a key. */
export function rolesFor(argv: readonly string[]): { roles?: string[] } | { error: string } {
  const admin = argv.includes("--admin");
  if (admin && !argv.includes("--portal")) return { error: "--admin needs --portal (only the portal knows the Portal.Admin role)" };
  const base = argv.includes("--no-role") ? [] : [DEV_ROLE];
  if (admin) return { roles: [...base, DEV_ADMIN_ROLE] };
  return argv.includes("--no-role") ? { roles: [] } : {};
}

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
  const roles = rolesFor(argv);
  if ("error" in roles) {
    console.error(`dev-token: ${roles.error}`);
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
    ...roles,
    ...(argv.includes("--service") && { idtyp: "app" as const }),
    ...(argv.includes("--expired") && { exp: Math.floor(Date.now() / 1000) - 120 }),
  });
  process.stdout.write(token + "\n");
  return 0;
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`dev-token: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
