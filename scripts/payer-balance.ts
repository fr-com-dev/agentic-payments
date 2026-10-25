// Deploy preflight (specs/011 contracts/deploy-pipeline.md step 5b): `npm run payer-balance -- <address> [--min <atomic>]`.
// A read-only USDC balanceOf on Base Sepolia. The payer address is public; this command holds no key and
// reads no env file (BASE_SEPOLIA_RPC_URL from the process environment is the only input it honours).
// Exit codes: 0 balance >= min; 2 below min ("fund the payer") or a bad argument; 1 RPC error.
import { pathToFileURL } from "node:url";
import { createPublicClient, erc20Abi, http, isAddress, type Address } from "viem";
import { networkProfile } from "../src/shared/config.js";

export const DEFAULT_MIN_ATOMIC = 50_000n; // 0.05 test USDC: one regression and one smoke run, with margin

export interface BalanceReader {
  readContract(args: { address: Address; abi: typeof erc20Abi; functionName: "balanceOf"; args: [Address] }): Promise<bigint>;
}

export async function checkBalance(client: BalanceReader, asset: Address, payer: Address, min: bigint): Promise<{ code: number; line: string }> {
  const balance = await client.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [payer] });
  if (balance >= min) return { code: 0, line: `balance=${balance}` };
  return { code: 2, line: `balance=${balance} below ${min}: fund the payer (faucet.circle.com)` };
}

async function main(argv: string[]): Promise<number> {
  const [payer] = argv;
  const at = argv.indexOf("--min");
  const minRaw = at >= 0 ? argv[at + 1] : undefined;
  if (!payer || !isAddress(payer) || (minRaw !== undefined && !/^\d+$/.test(minRaw))) {
    console.error("usage: npm run payer-balance -- <payer address> [--min <atomic>]");
    return 2;
  }
  const net = networkProfile("base-sepolia");
  try {
    const client = createPublicClient({ transport: http(net.rpcUrl) });
    const r = await checkBalance(client as unknown as BalanceReader, net.asset as Address, payer, minRaw ? BigInt(minRaw) : DEFAULT_MIN_ATOMIC);
    (r.code === 0 ? console.log : console.error)(r.line);
    return r.code;
  } catch (err) {
    console.error(`payer-balance: RPC error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
