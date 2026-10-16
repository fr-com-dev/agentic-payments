// Local chain bootstrap (SPEC.md CP-4, CP-5; feature 006 T012/T046). Composition code: scripts/** may
// derive dev accounts from the fixed mnemonic. Nothing under src/ does (INV-2).
//
// startLocalChain(): ganache on :8545 (chainId 31337, hardfork shanghai, fixed mnemonic) → compile
// MockUSDC (solc 0.8.24, evmVersion shanghai, optimizer 200) → deploy from #0 → mint 10 USDC to #2 →
// write .local/deployment.json (addresses only). The record is regenerated on every start.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import solc from "solc";
import { CHAIN_PORT, DEFAULT_DEPLOYMENT_FILE, type LocalDeployment } from "../src/shared/config.js";

/** CP-5: ganache's deterministic dev mnemonic. Test funds only; never use it on a real network. */
export const LOCAL_MNEMONIC = "myth like bonus scare over problem client lizard pioneer submit female collect";
export const LOCAL_CHAIN_ID = 31337;
/** CP-5 roles by HD index. */
export const ACCOUNT_INDEX = { deployer: 0, facilitator: 1, payer: 2, sellerPayTo: 3 } as const;
/** 10 USDC in atomic units, minted to the payer (#2). */
export const PAYER_MINT_ATOMIC = 10_000_000n;

export const localChain = (rpcUrl = `http://127.0.0.1:${CHAIN_PORT}`) =>
  defineChain({
    id: LOCAL_CHAIN_ID,
    name: "ganache-local",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });

const devAccount = (index: number) => mnemonicToAccount(LOCAL_MNEMONIC, { addressIndex: index });
export const localAddress = (role: keyof typeof ACCOUNT_INDEX): Address => devAccount(ACCOUNT_INDEX[role]).address;

/**
 * T046: dev private keys of #2 (payer) and #1 (facilitator), for the local demo only. Throws unless
 * NETWORK=local. Callers (scripts/** only) hand each key to exactly one child process; the keys are
 * never written to the deployment record, logs or env templates.
 */
export function localDevKeys(env: Record<string, string | undefined> = process.env): { payer: Hex; facilitator: Hex } {
  if ((env.NETWORK ?? "local") !== "local") {
    throw new Error(`localDevKeys() is local only (NETWORK=${env.NETWORK})`);
  }
  const key = (index: number): Hex => {
    const pk = devAccount(index).getHdKey().privateKey;
    if (!pk) throw new Error(`no private key for HD index ${index}`);
    return toHex(pk);
  };
  return { payer: key(ACCOUNT_INDEX.payer), facilitator: key(ACCOUNT_INDEX.facilitator) };
}

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

export interface CompiledContract {
  abi: Abi;
  bytecode: Hex;
}

export const MOCK_USDC_SOURCE_PATH = resolve(import.meta.dirname, "../contracts/MockUSDC.sol");

/** Compiles a single-contract source with the pinned settings. `source` defaults to MockUSDC.sol. */
export function compileMockUsdc(source: string = readFileSync(MOCK_USDC_SOURCE_PATH, "utf8")): CompiledContract {
  const input = {
    language: "Solidity",
    sources: { "MockUSDC.sol": { content: source } },
    settings: {
      evmVersion: "shanghai",
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input))) as {
    errors?: Array<{ severity: string; formattedMessage: string }>;
    contracts?: Record<string, Record<string, { abi: Abi; evm: { bytecode: { object: string } } }>>;
  };
  const errors = (output.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length > 0) throw new Error(`solc: ${errors.map((e) => e.formattedMessage).join("\n")}`);
  const c = output.contracts?.["MockUSDC.sol"]?.["MockUSDC"];
  if (!c) throw new Error("solc: MockUSDC not found in output");
  return { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` };
}

// ---------------------------------------------------------------------------
// Ganache
// ---------------------------------------------------------------------------

type GanacheServer = { listen(port: number, host?: string): Promise<void>; close(): Promise<void> };
type Ganache = { server(options: object): GanacheServer };

/** ganache's harmless native-binding fallback notice (§16): "µWS … not compatible", "Falling back to a NodeJS implementation", uws_<platform>. */
export const GANACHE_NOISE = /µWS|uws_|Falling back to a NodeJS implementation/;

/** Runs `fn` with console.warn/console.error lines matching GANACHE_NOISE dropped. */
async function quietGanache<T>(fn: () => Promise<T>): Promise<T> {
  const origWarn = console.warn;
  const origError = console.error;
  const keep = (args: unknown[]) => !args.some((a) => typeof a === "string" && GANACHE_NOISE.test(a));
  console.warn = (...args: unknown[]) => void (keep(args) && origWarn(...args));
  console.error = (...args: unknown[]) => void (keep(args) && origError(...args));
  try {
    return await fn();
  } finally {
    console.warn = origWarn;
    console.error = origError;
  }
}

export interface LocalChainOptions {
  port?: number;
  /** Where to write the deployment record. Default `.local/deployment.json`. */
  deploymentFile?: string;
  /** MockUSDC source override (tests use this to compile deliberately weakened variants). */
  source?: string;
}

export interface LocalChain {
  rpcUrl: string;
  deployment: LocalDeployment;
  abi: Abi;
  stop(): Promise<void>;
}

/** Starts ganache, deploys MockUSDC, mints 10 USDC to #2 and writes the deployment record. */
export async function startLocalChain(opts: LocalChainOptions = {}): Promise<LocalChain> {
  const port = opts.port ?? CHAIN_PORT;
  const rpcUrl = `http://127.0.0.1:${port}`;
  const server = await quietGanache(async () => {
    const ganache = ((await import("ganache")) as unknown as { default: Ganache }).default;
    const s = ganache.server({
      chain: { chainId: LOCAL_CHAIN_ID, hardfork: "shanghai" },
      wallet: { mnemonic: LOCAL_MNEMONIC, totalAccounts: 10, defaultBalance: 1000 },
      logging: { quiet: true },
    });
    await s.listen(port, "127.0.0.1");
    return s;
  });
  try {
    const { abi, bytecode } = compileMockUsdc(opts.source);
    const asset = await deployMockUsdc(rpcUrl, abi, bytecode);
    const deployment: LocalDeployment = {
      chainId: LOCAL_CHAIN_ID,
      rpcUrl,
      asset,
      accounts: {
        deployer: localAddress("deployer"),
        facilitator: localAddress("facilitator"),
        payer: localAddress("payer"),
        sellerPayTo: localAddress("sellerPayTo"),
      },
      deployedAt: new Date().toISOString(),
    };
    const file = resolve(opts.deploymentFile ?? DEFAULT_DEPLOYMENT_FILE);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(deployment, null, 2) + "\n");
    return { rpcUrl, deployment, abi, stop: () => server.close() };
  } catch (err) {
    await server.close();
    throw err;
  }
}

/** Deploys a compiled MockUSDC from #0 and mints 10 USDC to #2. Returns the token address. */
export async function deployMockUsdc(rpcUrl: string, abi: Abi, bytecode: Hex): Promise<Address> {
  const chain = localChain(rpcUrl);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const deployer = createWalletClient({ account: devAccount(ACCOUNT_INDEX.deployer), chain, transport: http(rpcUrl) });
  const hash = await deployer.deployContract({ abi, bytecode });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("MockUSDC deployment failed");
  const asset = receipt.contractAddress;
  const mintHash = await deployer.writeContract({
    address: asset,
    abi,
    functionName: "mint",
    args: [localAddress("payer"), PAYER_MINT_ATOMIC],
  });
  const mintReceipt = await publicClient.waitForTransactionReceipt({ hash: mintHash });
  if (mintReceipt.status !== "success") throw new Error("MockUSDC mint failed");
  return asset;
}
