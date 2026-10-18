// `npm run demo:base-sepolia` (SPEC v1.2 §12 T-E2E-06, §13; specs/009 research R10). Opt-in live run:
// the seller settles through the CDP facilitator, L2 signs, L3 verifies on Base Sepolia, and the
// scripted agent runs the L1-4 plan. No chain or local facilitator is started.
//
// Exit codes: 0 baseline matched with 2 CONFIRMED, 0 payer gas and a clean secret scan; 2 failed
// preflight or mismatch; 1 port busy, readiness timeout, child crash or interrupt.
// Never prints an env value, and never names the CDP variables (architecture rule A8).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, erc20Abi, http, parseEventLogs, type Address, type Hex } from "viem";
import { cdpCredentialStatus, containsCdpSecret } from "../src/counterparty/cdp-facilitator.js";
import { BASE_SEPOLIA_USDC, DEFAULT_PORTS, facilitatorChoice, networkProfile } from "../src/shared/config.js";
import {
  OUTCOME_LINE,
  ProcessGroup,
  ROOT,
  childEnv,
  envFileFor,
  getJson,
  httpOk,
  matchesBaseline,
  portInUse,
  printSummary,
  sleep,
  type DemoProcess,
  type DemoSummary,
  type EnvFile,
} from "./demo-lib.js";

type Role = "seller" | "l2" | "l3" | "agent";
const NETWORK = "base-sepolia";

const PROCESSES: Record<Role, DemoProcess> = {
  seller: { role: "seller", tag: "seller", entry: "src/counterparty/seller.ts", args: [], envFile: "env/seller.base-sepolia.env" },
  l2: { role: "l2", tag: "l2", entry: "src/layer2-control/service.ts", args: [], envFile: "env/l2-control.base-sepolia.env" },
  l3: { role: "l3", tag: "l3", entry: "src/layer3-settlement/service.ts", args: [], envFile: "env/l3-verifier.base-sepolia.env" },
  agent: { role: "agent", tag: "agent", entry: "src/main.ts", args: ["--scripted"], envFile: "env/l1-agent.base-sepolia.env" },
};

class PreflightError extends Error {}

function preflightFail(message: string): never {
  throw new PreflightError(`demo:base-sepolia: ${message}`);
}

function loadFiles(): Record<Role, EnvFile> {
  const out = {} as Record<Role, EnvFile>;
  for (const role of Object.keys(PROCESSES) as Role[]) {
    const p = PROCESSES[role];
    if (!existsSync(resolve(ROOT, p.envFile!))) preflightFail(`missing ${p.envFile}`);
    out[role] = envFileFor(p, { allowExample: false })!;
  }
  return out;
}

/** Research R10 step 1, analysis U2: the env layout the scripted plan's outcomes depend on. */
function preflight(files: Record<Role, EnvFile>) {
  for (const role of Object.keys(files) as Role[]) {
    if (role !== "agent" && files[role].values.NETWORK !== NETWORK) preflightFail(`${PROCESSES[role].envFile} must set NETWORK=${NETWORK}`);
  }
  const seller = files.seller.values;
  let kind: string;
  try {
    kind = facilitatorChoice(networkProfile(NETWORK, { env: seller }), seller).kind;
  } catch {
    kind = "invalid";
  }
  const creds = cdpCredentialStatus(seller);
  if (kind !== "cdp" || !creds.keyId || !creds.secret) preflightFail("seller must use FACILITATOR=cdp with CDP credentials set");

  const sellerPort = Number(seller.SELLER_PORT || DEFAULT_PORTS.seller);
  const sellerUrl = (files.agent.values.SELLER_URL ?? "").replace(/\/+$/, "");
  if (sellerUrl !== `http://127.0.0.1:${sellerPort}`) {
    preflightFail(`SELLER_URL must be http://127.0.0.1:${sellerPort} (step 6 of the plan uses the localhost alias)`);
  }
  const payTo = (seller.SELLER_PAY_TO ?? "").toLowerCase();
  const l2 = files.l2.values;
  const payees = (l2.ALLOWED_PAYEES ?? "").split(",").map((s) => s.trim().toLowerCase());
  if ((l2.ALLOWED_HOSTS ?? "").trim() !== `127.0.0.1:${sellerPort}` || !/^0x[0-9a-f]{40}$/.test(payTo) || !payees.includes(payTo)) {
    preflightFail(`ALLOWED_HOSTS must be exactly 127.0.0.1:${sellerPort} and ALLOWED_PAYEES must include SELLER_PAY_TO`);
  }
  return {
    sellerPort,
    payTo: payTo as Address,
    controlPort: Number(l2.CONTROL_PORT || DEFAULT_PORTS.control),
    settlementPort: Number(files.l3.values.SETTLEMENT_PORT || DEFAULT_PORTS.settlement),
    controlToken: l2.CONTROL_TOKEN ?? "",
    operatorToken: l2.OPERATOR_TOKEN ?? "",
    rpcUrl: networkProfile(NETWORK, { env: files.l3.values }).rpcUrl,
  };
}

const SESSION_ID = `sess_live${Date.now().toString(16).slice(-6)}`;
let group: ProcessGroup | undefined;

async function run(): Promise<number> {
  let files: Record<Role, EnvFile>;
  let cfg: ReturnType<typeof preflight>;
  try {
    files = loadFiles();
    cfg = preflight(files);
  } catch (err) {
    if (err instanceof PreflightError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }

  const ports = { seller: cfg.sellerPort, l2: cfg.controlPort, l3: cfg.settlementPort };
  for (const [role, port] of Object.entries(ports)) {
    if (await portInUse(port)) {
      console.error(`demo: port busy: ${port} (${role}). Stop whatever is listening there and retry.`);
      return 1;
    }
  }

  const g = new ProcessGroup(Object.values(ports));
  group = g;
  const captured: string[] = []; // every child line, for the secret scan (SC-004 live part)
  const start = (role: Role, onLine?: (l: string) => void) =>
    g.start(PROCESSES[role], childEnv(PROCESSES[role], files[role], { network: NETWORK, sessionId: SESSION_ID }), (line) => {
      captured.push(line);
      onLine?.(line);
    });

  const controlUrl = `http://127.0.0.1:${cfg.controlPort}`;
  const ready: Record<Exclude<Role, "agent">, () => Promise<boolean>> = {
    seller: () => httpOk(`http://127.0.0.1:${cfg.sellerPort}/api/catalog`),
    l2: () => httpOk(`${controlUrl}/v1/budget/${SESSION_ID}`, { authorization: `Bearer ${cfg.controlToken}` }),
    l3: () => portInUse(cfg.settlementPort),
  };
  for (const role of ["seller", "l2", "l3"] as const) {
    start(role);
    await g.waitReady(role, ready[role]);
  }

  // Read-only chain access: head reads only, because public RPCs may prune historical state.
  const client = createPublicClient({ transport: http(cfg.rpcUrl) });
  const payeeBalance = () =>
    client.readContract({ address: BASE_SEPOLIA_USDC, abi: erc20Abi, functionName: "balanceOf", args: [cfg.payTo] });
  const before = await payeeBalance();

  const outcomes: string[] = [];
  const paid: Array<{ tx: Hex | null; settlement: string }> = [];
  const agent = start("agent", (line) => {
    const m = OUTCOME_LINE.exec(line);
    if (!m) return;
    outcomes.push(m[1]!);
    if (m[1] === "PAID") {
      paid.push({
        tx: (/\btx=(0x[0-9a-fA-F]{64})\b/.exec(line)?.[1] as Hex | undefined) ?? null,
        settlement: /\bsettlement=(\S+)/.exec(line)?.[1] ?? "unknown",
      });
    }
  });
  const agentCode = await agent.exited;
  if (g.crash) throw new Error(g.crash);
  if (agentCode !== 0) throw new Error(`agent exited with code ${agentCode}`);

  // A load-balanced RPC can lag a block or two behind L3's view; poll briefly for the expected delta.
  let after = await payeeBalance();
  for (let i = 0; i < 5 && after - before < 6000n; i++) {
    await sleep(2_000);
    after = await payeeBalance();
  }

  // Analysis U1: the payer is the Transfer's `from` in the first settlement receipt; gas counts only
  // settlement transactions the payer itself sent (CDP submits them, so the expected total is 0).
  let payer: Address | null = null;
  let gasWei = 0n;
  const receipts = [];
  for (const { tx } of paid) if (tx) receipts.push(await client.getTransactionReceipt({ hash: tx }));
  for (const receipt of receipts) {
    const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs });
    const toPayee = transfers.find((l) => l.address.toLowerCase() === BASE_SEPOLIA_USDC.toLowerCase() && l.args.to.toLowerCase() === cfg.payTo);
    payer ??= toPayee ? (toPayee.args.from.toLowerCase() as Address) : null;
  }
  for (const receipt of receipts) {
    if (payer && receipt.from.toLowerCase() === payer) gasWei += receipt.gasUsed * receipt.effectiveGasPrice;
  }

  const summary: DemoSummary = {
    network: NETWORK,
    session: SESSION_ID,
    outcomes,
    spentAtomic: after - before,
    budget: await getJson(`${controlUrl}/v1/budget/${SESSION_ID}`, cfg.controlToken),
    chain: await getJson(`${controlUrl}/v1/ledger/verify`, cfg.operatorToken),
  };
  await g.shutdown();

  const ledgerPath = resolve(ROOT, `.local/ledger-${NETWORK}.jsonl`);
  const scanned = captured.join("\n") + "\n" + (existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "");
  const leaked = containsCdpSecret(files.seller.values, scanned);
  const confirmed = paid.filter((p) => p.settlement === "CONFIRMED").length;

  printSummary(summary, [
    `settlements:        ${confirmed} CONFIRMED`,
    `payer gas spent:    ${payer ? `${gasWei} wei` : "unknown (no settlement receipt)"}`,
    `secret scan:        ${leaked ? "FOUND" : "clean"}`,
  ]);
  return matchesBaseline(summary) && confirmed === 2 && payer !== null && gasWei === 0n && !leaked ? 0 : 2;
}

let interrupted = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (interrupted) return;
    interrupted = true;
    console.error(`demo: ${sig} received, stopping all processes`);
    void (group?.shutdown() ?? Promise.resolve()).then(() => process.exit(1));
  });
}

run()
  .then(async (code) => {
    await group?.shutdown();
    process.exit(code);
  })
  .catch(async (err: unknown) => {
    console.error(`demo: ${err instanceof Error ? err.message : String(err)}`);
    await group?.shutdown();
    process.exit(1);
  });
