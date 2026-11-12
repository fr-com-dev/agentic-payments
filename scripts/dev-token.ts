// npm run dev-token -- [--subject <name>] [--no-role] [--expired] [--service] [--portal] [--auth-age <seconds>]
// Prints one access token from the local dev issuer (NETWORK=local only). By default a person's token for the hosted
// agent service: `sub` dev|<name>, the `agent:run` permission, the agent CLI's client. With --portal the same person's
// token from the portal's client, with a fresh sign-in time; --auth-age backdates that time, to try the "confirm
// it's you" step. With --service a system identity's token, in the shape of the organization's directory (app-only,
// the Agent.Run role). --no-role leaves the permission (or the role) out. Exit codes: 0 printed; 2 NETWORK is not
// local or a bad argument.
import { DEV_PORTAL_CLIENT, loadOrCreateDevIssuer, signDevToken } from "./dev-issuer-lib.js";

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
  const service = argv.includes("--service");
  const noRole = argv.includes("--no-role");
  const token = await signDevToken(issuer, {
    subject,
    ...(service && { service: true }),
    ...(portal && { azp: DEV_PORTAL_CLIENT, authTime: Math.floor(Date.now() / 1000) - Number(ageRaw ?? 0) }),
    ...(noRole && (service ? { roles: [] } : { permissions: [] })),
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
