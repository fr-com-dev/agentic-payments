// `npm run local:chain` (SPEC.md CP-5, M2). Starts ganache on :8545, deploys MockUSDC, mints 10 USDC to
// #2, writes .local/deployment.json, and keeps running until SIGINT/SIGTERM. ganache's harmless uws
// fallback warning is filtered inside local-chain-lib.
import { formatAtomic } from "../src/shared/config.js";
import { PAYER_MINT_ATOMIC, startLocalChain } from "./local-chain-lib.js";

const chain = await startLocalChain();
const { deployment } = chain;
console.log(`local chain ready on ${deployment.rpcUrl} (chainId ${deployment.chainId})`);
console.log(`MockUSDC ${deployment.asset}`);
console.log(`payer #2 ${deployment.accounts.payer}: ${formatAtomic(PAYER_MINT_ATOMIC.toString(), 6)} USDC`);
console.log(`seller payTo #3 ${deployment.accounts.sellerPayTo}`);
console.log("deployment written to .local/deployment.json");

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`local chain stopping (${signal})`);
  await chain.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
