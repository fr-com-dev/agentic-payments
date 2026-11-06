// The local network profile (CFG-1) for tests that need no chain: its own deployment record in a temporary
// directory, never .local/deployment.json. That file is gitignored state from `npm run local:chain`, so a test that
// reads it passes on a developer's machine and fails on a clean checkout (deploy-l1 run 42151953031). The process
// environment is ignored too, so a runner's NETWORK or FACILITATOR_URL can't change the profile.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { networkProfile, type LocalDeployment, type NetworkProfile } from "../../src/shared/config.js";

/** A deployment record of addresses only, the shape `readDeployment` accepts; the asset is ganache's first contract. */
export const TEST_DEPLOYMENT: LocalDeployment = {
  chainId: 31337,
  rpcUrl: "http://127.0.0.1:8545",
  asset: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  accounts: {
    deployer: "0x0000000000000000000000000000000000000001",
    facilitator: "0x0000000000000000000000000000000000000002",
    payer: "0x0000000000000000000000000000000000000003",
    sellerPayTo: "0x0000000000000000000000000000000000000004",
  },
  deployedAt: "2026-10-16T00:00:00.000Z",
};

/** `networkProfile("local")` as a clean checkout sees it once the chain is deployed, without reading .local/. */
export function localTestNet(): NetworkProfile {
  const deploymentFile = join(mkdtempSync(join(tmpdir(), "x402-net-")), "deployment.json");
  writeFileSync(deploymentFile, JSON.stringify(TEST_DEPLOYMENT));
  return networkProfile("local", { env: {}, deploymentFile });
}
