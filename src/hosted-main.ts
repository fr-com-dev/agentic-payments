// L1-6 composition root of the hosted agent service (SPEC.md §8.1 L1-6, INV-3). It sits beside src/main.ts,
// outside src/layer1-intent/, because rule A5 bans the payer key's name in L1 code. Order matters: load the
// env file first (a file read, no network), then refuse if the payer key is visible from the process
// environment or from that file, before anything else happens.
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import { REFUSAL } from "./refusal.js";
import { loadEnv } from "./shared/config.js";

async function main(): Promise<void> {
  loadEnv("l1-hosted");
  // INV-3: this must stay right after loadEnv, before any network or model activity.
  if (process.env.PAYER_PRIVATE_KEY !== undefined) {
    console.error(REFUSAL);
    process.exit(1);
  }

  const { loadHostedConfig } = await import("./layer1-intent/hosted/config.js");
  const { keysFor } = await import("./layer1-intent/hosted/requester-auth.js");
  const { createModel } = await import("./layer1-intent/hosted/model.js");
  const { createHostedApp } = await import("./layer1-intent/hosted/server.js");
  const { HttpAuthorizationGate, HttpSettlementVerifier } = await import("./layer1-intent/ports-http.js");

  const config = loadHostedConfig();
  const { app, markReady } = createHostedApp({
    config,
    keys: keysFor(config),
    model: createModel(config),
    gate: new HttpAuthorizationGate(config.urls.control, config.tokens.control),
    settlement: new HttpSettlementVerifier(config.urls.settlement, config.tokens.verifier),
  });
  const server: Server = app.listen(config.port, config.bindHost, () => {
    console.log(`l1-hosted listening on http://${config.bindHost}:${config.port} (provider ${config.provider}, model ${config.model})`);
    markReady();
  });
  server.on("error", (err) => {
    console.error(`l1-hosted: ${err.message}`);
    process.exit(1);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main().catch((e: unknown) => {
    console.error(`l1-hosted: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
