// Local facilitator process entry (SPEC.md CP-2, §3.1). LOCAL ONLY. This is the only place the facilitator
// key becomes an account; it sits in scripts/**, outside the buyer layers, so INV-2 is untouched.
import { privateKeyToAccount } from "viem/accounts";
import { createFacilitatorApp } from "../src/counterparty/facilitator.js";
import { FACILITATOR_BIND_HOST, facilitatorPort, loadEnv, networkProfile } from "../src/shared/config.js";

loadEnv("facilitator");

// Guard first, before any key is read (NFR-003).
if ((process.env.NETWORK ?? "local") !== "local") {
  console.error(`facilitator: local only (NETWORK=${process.env.NETWORK}); Base Sepolia uses the hosted facilitator`);
  process.exit(1);
}

const key = process.env.FACILITATOR_PRIVATE_KEY;
if (!key) {
  console.error("facilitator: FACILITATOR_PRIVATE_KEY not set (env/facilitator.env; the local demo supplies account #1)");
  process.exit(1);
}

const account = privateKeyToAccount(key as `0x${string}`);
const net = networkProfile("local");
const port = facilitatorPort();
createFacilitatorApp({ account, rpcUrl: net.rpcUrl, caip2: net.caip2 }).listen(port, FACILITATOR_BIND_HOST, () => {
  console.log(`facilitator listening on ${FACILITATOR_BIND_HOST}:${port} (${net.caip2}, rpc ${net.rpcUrl}, signer ${account.address})`);
});
