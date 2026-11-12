// 008 e2e harness (contracts/e2e-harness.md, research R3). One in-process stack per call:
// ganache + MockUSDC, local facilitator, seller on 0.0.0.0, L2 control, L3 verifier.
// The harness may wire layers together (INV-1 permits test/**).
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type express from "express";
import type { FacilitatorClient } from "@x402/core/server";
import { createPublicClient, http, type Address } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { ACCOUNT_INDEX, LOCAL_MNEMONIC, localChain, localDevKeys, mintLocalUsdc, startLocalChain, type LocalChain } from "../../scripts/local-chain-lib.js";
import { createSellerApp } from "../../src/counterparty/seller.js";
import { createFacilitatorApp } from "../../src/counterparty/facilitator.js";
import { CHAIN_PORT, networkProfile, type NetworkProfile } from "../../src/shared/config.js";
import { AuditLedger, type LedgerEntry } from "../../src/layer2-control/ledger.js";
import { buildMandate, type SpendingMandate } from "../../src/layer2-control/mandate.js";
import { buildPlatform, type PlatformConfig } from "../../src/layer2-control/platform.js";
import { PaymentSigner, WalletKeyring } from "../../src/layer2-control/signer.js";
import { createControlService, recordPlatformConfig } from "../../src/layer2-control/service.js";
import type { UserAccountsDeps } from "../../src/layer2-control/users.js";
import type { BackchannelDeps } from "../../src/layer2-control/backchannel.js";
import { ChainSettlementVerifier, type ReadOnlyChainClient } from "../../src/layer3-settlement/verifier.js";
import { createSettlementService, HttpReconciler } from "../../src/layer3-settlement/service.js";
import DEFAULT_MANDATE from "../../config/mandate.json" with { type: "json" };

export { RegressionBaseline } from "./baseline.js";

export interface HarnessOptions {
  /** L2 test hook (T-E2E-04 uses 25). */
  signerLatencyMs?: number;
  ports?: Partial<{ chain: number; control: number; seller: number; facilitator: number; settlement: number }>;
  /** Overrides on the default mandate (shape owned by 002). Allowlists are set by the harness. */
  mandateOverrides?: Partial<SpendingMandate>;
  /**
   * 009: the seller's facilitator client, built from the local facilitator's URL (for example, a CDP
   * stub in front of it). Default: the seller's own client for that URL, as before.
   */
  sellerFacilitator?: (localFacilitatorUrl: string) => Promise<FacilitatorClient>;
  /** 010: L2's clock (escalation expiry tests). Default: Date.now, as before. */
  controlNow?: () => number;
  /** 012: L2's backchannel approval (the test builds the stand-in Auth0 and the deps). Default: off, as before. */
  controlBackchannel?: BackchannelDeps;
  /**
   * 013: user accounts on L2, with a keyring from a test mnemonic and a platform whose seller list is this harness's
   * seller. `limits` and the must-fail switches are optional. Default: off, as before.
   */
  users?: { limits?: Partial<PlatformConfig["limits"]>; switches?: Partial<UserAccountsDeps> };
  /** 014: L2's administration routes (needs `users`), for the portal's administration area. Default: off. */
  admin?: boolean;
}

/** 013: a fixed, valid 24-word phrase for the harness's user wallets. Local MockUSDC only. */
export const HARNESS_USER_MNEMONIC =
  "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title";

export interface Harness {
  urls: { seller: string; control: string; settlement: string; facilitator: string };
  tokens: { control: string; verifier: string; settlement: string; operator: string; portal: string; portalAdmin: string };
  /** 013: any L2 user-account route, with the portal's token. Only useful with `users`. */
  portal<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }>;
  /** 013: mints local MockUSDC to an address (a user's account). */
  fund(address: `0x${string}`, amountAtomic: bigint): Promise<bigint>;
  /** 013: the user wallets' keyring, when `users` is on. */
  keyring?: WalletKeyring;
  addresses: { payer: `0x${string}`; payTo: `0x${string}`; asset: `0x${string}` };
  balanceOf(addr: `0x${string}`): Promise<bigint>;
  /** Fresh temp file per harness. */
  ledgerPath: string;
  /** Parsed ledger entries, read from `ledgerPath`. */
  ledgerEntries(): LedgerEntry[];
  net: NetworkProfile;
  /** 010: runs L2's escalation sweep now (on L2's clock, see `controlNow`). */
  sweepEscalations(): Promise<unknown>;
  /** Stops every server and the chain and frees all ports. Safe to call twice. */
  close(): Promise<void>;
}

const TOKENS = { control: "h-control", verifier: "h-verifier", settlement: "h-settlement", operator: "h-operator", portal: "h-portal", portalAdmin: "h-portal-admin" };

export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "x402-harness-"));
  const deploymentFile = join(dir, "deployment.json");
  const ledgerPath = join(dir, "ledger-local.jsonl");
  const servers: Server[] = [];
  let chain: LocalChain | undefined;
  let l3: { stop(): void } | undefined;
  let backchannel: { stop(): void } | undefined;
  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    l3?.stop();
    backchannel?.stop();
    await Promise.all(
      servers.map(
        (s) =>
          new Promise<void>((r) => {
            s.closeAllConnections?.();
            s.close(() => r());
          }),
      ),
    );
    await chain?.stop();
    rmSync(dir, { recursive: true, force: true });
  };

  const up = (app: express.Express, port = 0, host = "127.0.0.1") =>
    new Promise<string>((resolve, reject) => {
      const s = app.listen(port, host, () => {
        servers.push(s);
        resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`);
      });
      s.once("error", reject);
    });

  try {
    chain = await startLocalChain({ port: opts.ports?.chain ?? CHAIN_PORT, deploymentFile });
    const payTo = mnemonicToAccount(LOCAL_MNEMONIC, { addressIndex: ACCOUNT_INDEX.sellerPayTo }).address;
    const payer = mnemonicToAccount(LOCAL_MNEMONIC, { addressIndex: ACCOUNT_INDEX.payer }).address;
    const facilitatorAccount = mnemonicToAccount(LOCAL_MNEMONIC, { addressIndex: ACCOUNT_INDEX.facilitator });

    const facilitator = await up(
      createFacilitatorApp({ account: facilitatorAccount, rpcUrl: chain.rpcUrl, caip2: "eip155:31337" }),
      opts.ports?.facilitator,
    );
    const net = networkProfile("local", { env: { FACILITATOR_URL: facilitator }, deploymentFile });
    // Research R4: bind on 0.0.0.0; 127.0.0.1:<port> is allowlisted, localhost:<port> is the alias.
    const sellerFacilitator = opts.sellerFacilitator ? await opts.sellerFacilitator(facilitator) : undefined;
    const seller = await up(
      createSellerApp({ net, payTo, ...(sellerFacilitator && { facilitator: sellerFacilitator }) }),
      opts.ports?.seller,
      "0.0.0.0",
    );

    const json = { ...(DEFAULT_MANDATE as Record<string, unknown>), ...(opts.mandateOverrides ?? {}) };
    const mandate = buildMandate(json, net, { ALLOWED_HOSTS: new URL(seller).host, ALLOWED_PAYEES: payTo });
    const ledger = new AuditLedger(ledgerPath);
    const signer = new PaymentSigner(localDevKeys({ NETWORK: "local" }).payer, net, mandate.hardCapPerPaymentAtomic);
    // 013: user accounts. The seller list is this harness's seller, with its real payTo as the only payee.
    const keyring = opts.users ? new WalletKeyring(HARNESS_USER_MNEMONIC, net) : undefined;
    const platform = opts.users
      ? buildPlatform({
          platformId: "platform-harness",
          limits: {
            hardCapPerPaymentAtomic: mandate.hardCapPerPaymentAtomic,
            sessionBudgetAtomic: mandate.sessionBudgetAtomic,
            userDailyCeilingAtomic: mandate.dailyBudgetAtomic,
            maxAuthorizationsPerMinute: mandate.maxAuthorizationsPerMinute,
            maxPolicyDays: 365,
            ...opts.users.limits,
          },
          sellers: [{ host: new URL(seller).host, name: "Harness seller", payees: [payTo] }],
        })
      : undefined;
    if (platform) recordPlatformConfig(ledger, platform);
    const control = createControlService({
      mandate,
      signer,
      ledger,
      asset: { address: net.asset, decimals: net.decimals },
      tokens: { control: TOKENS.control, settlement: TOKENS.settlement, operator: TOKENS.operator, portal: TOKENS.portal, portalAdmin: TOKENS.portalAdmin },
      ...(platform && keyring && { users: { platform, keyring, ...opts.users?.switches }, net }),
      ...(platform && opts.admin && { admin: {} }),
      ...(opts.signerLatencyMs !== undefined && { signerLatencyMs: opts.signerLatencyMs }),
      ...(opts.controlNow !== undefined && { now: opts.controlNow }),
      ...(opts.controlBackchannel !== undefined && { backchannel: opts.controlBackchannel }),
    });
    backchannel = control.backchannel;
    const controlUrl = await up(control.app, opts.ports?.control);

    const verifier = new ChainSettlementVerifier({
      publicClient: createPublicClient({ transport: http(chain.rpcUrl) }) as unknown as ReadOnlyChainClient,
      net,
      waitMs: 15_000,
      pollMs: 100,
    });
    const svc = createSettlementService({
      verifier,
      reconciler: new HttpReconciler(controlUrl, TOKENS.settlement, 5_000, () => {}),
      token: TOKENS.verifier,
      log: () => {},
    });
    l3 = svc;
    const settlement = await up(svc.app, opts.ports?.settlement);

    const reader = createPublicClient({ chain: localChain(chain.rpcUrl), transport: http(chain.rpcUrl) });
    const abi = chain.abi;
    const balanceOf = async (addr: `0x${string}`) =>
      (await reader.readContract({ address: net.asset, abi, functionName: "balanceOf", args: [addr as Address] })) as bigint;

    return {
      urls: { seller, control: controlUrl, settlement, facilitator },
      tokens: { ...TOKENS },
      addresses: { payer, payTo, asset: net.asset },
      balanceOf,
      portal: async (method, path, body) => {
        const res = await fetch(`${controlUrl}${path}`, {
          method,
          headers: { authorization: `Bearer ${TOKENS.portal}`, ...(body !== undefined && { "content-type": "application/json" }) },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        });
        return { status: res.status, body: (await res.json()) as never };
      },
      fund: (address, amountAtomic) => mintLocalUsdc(chain!.rpcUrl, net.asset, address, amountAtomic),
      ...(keyring && { keyring }),
      ledgerPath,
      ledgerEntries: () =>
        (existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "")
          .split("\n")
          .filter((l) => l.length > 0)
          .map((l) => JSON.parse(l) as LedgerEntry),
      net,
      sweepEscalations: () => control.sweep(),
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}
