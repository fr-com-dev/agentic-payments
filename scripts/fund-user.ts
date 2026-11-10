// `npm run fund-user -- <address> [usdc=1]` (specs/013 quickstart §2). Mints local MockUSDC to a user's crypto
// account, so the portal's wallet shows a balance without a faucet. Local network only: MockUSDC's mint exists on the
// local chain alone, and this script signs with the chain's deployer (#0), never with a payer or a user key.
// Exit codes: 0 minted; 2 bad argument or NETWORK is not local; 1 no local deployment or an RPC error.
import { isAddress, type Address } from "viem";
import { parseUsdc, readDeployment } from "../src/shared/config.js";
import { mintLocalUsdc } from "./local-chain-lib.js";

const USDC_DECIMALS = 6;

async function main(argv: string[]): Promise<number> {
  if ((process.env.NETWORK ?? "local") !== "local") {
    console.error("fund-user: NETWORK must be local; on Base Sepolia use the faucet (faucet.circle.com)");
    return 2;
  }
  const [address, amountRaw = "1"] = argv;
  const amount = parseUsdc(amountRaw, USDC_DECIMALS);
  if (!address || !isAddress(address) || typeof amount !== "string" || amount === "0") {
    console.error("usage: npm run fund-user -- <address> [usdc=1]   (at most 6 decimals, more than 0)");
    return 2;
  }
  const deployment = readDeployment();
  if (!deployment) {
    console.error("fund-user: no local deployment (.local/deployment.json). Start the stack first: npm run stack:local -- --users");
    return 1;
  }
  const balance = await mintLocalUsdc(deployment.rpcUrl, deployment.asset, address as Address, BigInt(amount));
  console.log(`minted=${amount} balance=${balance}`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`fund-user: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
