// npm run dev-token -- [--subject <name>] [--no-role] [--expired] [--service] [--portal [--admin]] [--auth-age <seconds>]
// Prints one access token from the local dev issuer (NETWORK=local only). By default a person's token for the hosted
// agent service: `sub` dev|<name>, the `agent:run` permission, the agent CLI's client. With --portal the same person's
// token from the portal's client, with a fresh sign-in time; --auth-age backdates that time, to try the "confirm
// it's you" step. --admin (014, with --portal only) adds the `portal:admin` permission; with --no-role the token
// carries that permission alone: an administrator who is not a user. With --service a system identity's token, in
// the shape of the organization's directory (app-only, the Agent.Run role). --no-role leaves the permission (or the
// role) out. Exit codes: 0 printed; 2 NETWORK is not local or a bad argument.
import { pathToFileURL } from "node:url";
import { DEV_ADMIN_PERMISSION, DEV_PERMISSION, DEV_PORTAL_CLIENT, loadOrCreateDevIssuer, signDevToken } from "./dev-issuer-lib.js";

/** A person's `permissions` claim for the flags given, or an error. Pure, so the flag rules are tested without a key. */
export function permissionsFor(argv: readonly string[]): { permissions?: string[] } | { error: string } {
  const admin = argv.includes("--admin");
  if (admin && !argv.includes("--portal")) return { error: "--admin needs --portal (only the portal knows the portal:admin permission)" };
  const base = argv.includes("--no-role") ? [] : [DEV_PERMISSION];
  if (admin) return { permissions: [...base, DEV_ADMIN_PERMISSION] };
  return argv.includes("--no-role") ? { permissions: [] } : {};
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
  const permissions = permissionsFor(argv);
  if ("error" in permissions) {
    console.error(`dev-token: ${permissions.error}`);
    return 2;
  }
  const issuer = await loadOrCreateDevIssuer();
  const service = argv.includes("--service");
  const noRole = argv.includes("--no-role");
  const token = await signDevToken(issuer, {
    subject,
    ...(service && { service: true }),
    ...(portal && { azp: DEV_PORTAL_CLIENT, authTime: Math.floor(Date.now() / 1000) - Number(ageRaw ?? 0) }),
    ...(service ? noRole && { roles: [] } : permissions),
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
