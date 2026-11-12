// 013 composition root of the portal (SPEC.md §8.2 L2-8, §3.3; specs/013 contracts/config-and-secrets.md). It sits
// beside src/hosted-main.ts, outside src/portal/, because rules A11 and A12 ban the payment keys' names in portal
// code. Order matters: load the env file first (a file read, no network), then refuse if a payment key is visible
// from the process environment or from that file, before anything else is imported or done. The portal faces
// browsers; it must never be able to sign.
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import { loadEnv } from "./shared/config.js";

/** Payment key material no portal process may ever see: the platform account's key and the user wallets' mnemonic. */
const PAYMENT_KEYS = ["PAYER_PRIVATE_KEY", "USER_WALLET_MNEMONIC"] as const;

export const portalRefusal = (name: string) =>
  `refusing to start: ${name} is visible to the portal process. Payment keys belong only to L2 (INV-2).`;

async function main(): Promise<void> {
  loadEnv("portal");
  // This must stay right after loadEnv, before any network activity. The name is printed, never the value.
  for (const name of PAYMENT_KEYS) {
    if (process.env[name] !== undefined) {
      console.error(portalRefusal(name));
      process.exit(1);
    }
  }

  const { loadPortalConfig } = await import("./portal/config.js");
  const { personKeys } = await import("./shared/identity-token.js");
  const { ControlClient } = await import("./portal/control-client.js");
  const { AdminClient } = await import("./portal/admin-client.js");
  const { ProfileStore } = await import("./portal/profile-store.js");
  const { createBalanceCache, rpcBalanceReader } = await import("./portal/balance.js");
  const { CardVault } = await import("./portal/card-vault.js");
  const { createPortalApp } = await import("./portal/server.js");

  const config = loadPortalConfig();
  const { app, markReady } = createPortalApp({
    config,
    keys: personKeys(config.auth),
    control: new ControlClient(config.controlUrl, config.portalToken),
    profiles: new ProfileStore(config.profileDir),
    balance: createBalanceCache(rpcBalanceReader(config.rpcUrl)),
    ...(config.cardVault && { vault: new CardVault(config.cardVault) }),
    // 014: the administration area, with its own role token. Off unless PORTAL_ADMIN=1.
    ...(config.admin && { admin: new AdminClient(config.controlUrl, config.admin.token) }),
  });
  const server: Server = app.listen(config.port, config.bindHost, () => {
    console.log(
      `portal listening on http://${config.bindHost}:${config.port} (network ${config.network}, sign-in ${config.auth.mode}, cards ${config.cardVault ? "on (test mode)" : "off"}, administration ${config.admin ? "on" : "off"})`,
    );
    if (config.apiDocs) console.log(`portal API docs on http://${config.bindHost}:${config.port}/docs (API_DOCS=1, no token)`);
    markReady();
  });
  server.on("error", (err) => {
    console.error(`portal: ${err.message}`);
    process.exit(1);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main().catch((e: unknown) => {
    console.error(`portal: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
