// L3 settlement verifier (SPEC.md §8.3 L3-1). Owner: feature 005.
// INV-10: trust the chain, not the seller. CONFIRMED needs a successful receipt plus a matching
// Transfer(payer → payTo, amount) emitted by requirement.asset. INV-4: read-only; this module takes a
// public client and never anything that can sign or write.
import { decodePaymentResponseHeader } from "@x402/core/http";
import { erc20Abi, parseEventLogs, type Hex, type Log } from "viem";
import type { NetworkProfile } from "../shared/config.js";
import type {
  FinalityClass,
  SettlementClaim,
  SettlementReport,
  SettlementStatus,
  SettlementVerifierPort,
} from "../shared/contracts.js";

/** The only chain reads L3 makes (contracts/verifier.md). A viem PublicClient satisfies this shape. */
export interface ReadOnlyChainClient {
  waitForTransactionReceipt(args: { hash: Hex; timeout: number; pollingInterval: number }): Promise<{
    status: "success" | "reverted";
    blockNumber: bigint;
    logs: readonly Log[];
  }>;
  getBlockNumber(): Promise<bigint>;
  getBlock(args: { blockTag: "safe" }): Promise<{ number: bigint | null }>;
}

export interface VerifierDeps {
  publicClient: ReadOnlyChainClient;
  net: Pick<NetworkProfile, "confirmationDepth" | "supportsSafeTag">;
  /** One shared deadline for the receipt wait and the finality wait (SPEC v1.1 L3-1). */
  waitMs?: number;
  pollMs?: number;
  /**
   * SPEC v1.2 L3-1 step 2 (FR-020): check a failure claim that carries a transaction hash on-chain.
   * Default true. Test-only switch: `false` restores v1.1 for the T-CDP-06 must-fail proof.
   */
  verifyFailedClaims?: boolean;
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export const DEFAULT_WAIT_MS = 45_000;
export const DEFAULT_POLL_MS = 1_000;
/** Depth multiplier for `l1-safe` on a chain without a `safe` block tag. */
export const SAFE_DEPTH_MULTIPLIER = 5;

/** ≤ 10_000n → included; ≤ 1_000_000n → confirmed-depth; else l1-safe. */
export function finalityClassFor(amountAtomic: bigint): FinalityClass {
  if (amountAtomic <= 10_000n) return "included";
  if (amountAtomic <= 1_000_000n) return "confirmed-depth";
  return "l1-safe";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
const lower = (s: string) => s.toLowerCase();

function isReceiptTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === "WaitForTransactionReceiptTimeoutError";
}

export class ChainSettlementVerifier implements SettlementVerifierPort {
  readonly #client: ReadOnlyChainClient;
  readonly #net: VerifierDeps["net"];
  readonly #waitMs: number;
  readonly #pollMs: number;
  readonly #verifyFailedClaims: boolean;

  constructor(deps: VerifierDeps) {
    this.#client = deps.publicClient;
    this.#net = deps.net;
    this.#waitMs = deps.waitMs ?? DEFAULT_WAIT_MS;
    this.#pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
    this.#verifyFailedClaims = deps.verifyFailedClaims ?? true;
  }

  async verify(claim: SettlementClaim): Promise<SettlementReport> {
    const req = claim.requirement;
    let amount: bigint;
    try {
      amount = BigInt(req.amount);
    } catch {
      amount = -1n;
    }
    const finalityClass = finalityClassFor(amount < 0n ? 0n : amount);
    const base = {
      authorizationId: claim.authorizationId,
      network: req.network,
      finalityClass,
      verified: { asset: req.asset, payer: claim.payer, payTo: req.payTo, amount: req.amount },
    };
    // Set in step 2 when the facilitator reported failure but named a transaction (v1.2).
    let prefix = "";
    const report = (status: SettlementStatus, detail: string, extra: Partial<SettlementReport> = {}): SettlementReport => ({
      ...base,
      status,
      detail: prefix + detail,
      ...extra,
      observedAt: new Date().toISOString(),
    });

    try {
      if (amount < 0n) return report("MISMATCH", `requirement amount is not an atomic integer: "${req.amount}"`);

      // Step 2: the seller's claim, decoded only with the SDK helper (§10).
      if (claim.paymentResponseHeader === null || claim.paymentResponseHeader === "") {
        return report("NOT_SETTLED", "no PAYMENT-RESPONSE header");
      }
      let settle: ReturnType<typeof decodePaymentResponseHeader>;
      try {
        settle = decodePaymentResponseHeader(claim.paymentResponseHeader);
      } catch (err) {
        return report("NOT_SETTLED", `PAYMENT-RESPONSE could not be decoded: ${(err as Error).message}`);
      }
      // v1.2 (FR-020, SEC-11): a failure claim is not proof that nothing settled. Without a 32-byte hash
      // there is nothing to check; with one, the chain decides exactly as for a success claim.
      const hasHash = typeof settle.transaction === "string" && TX_HASH.test(settle.transaction);
      if (!settle.success && (!hasHash || !this.#verifyFailedClaims)) {
        return report("NOT_SETTLED", `seller reported failure: ${settle.errorReason ?? "unknown"}`);
      }
      if (!hasHash) return report("NOT_SETTLED", "PAYMENT-RESPONSE has no transaction");
      if (!settle.success) prefix = `facilitator reported failure (${settle.errorReason ?? "unknown"}); `;
      const tx = settle.transaction as Hex;

      // Step 3: network check before any chain read.
      if (settle.network !== req.network) {
        return report("MISMATCH", `settlement network ${settle.network} ≠ requirement network ${req.network}`, {
          transaction: tx,
        });
      }

      // Step 4: receipt, bounded by the one shared deadline.
      const deadline = Date.now() + this.#waitMs;
      let receipt: Awaited<ReturnType<ReadOnlyChainClient["waitForTransactionReceipt"]>>;
      try {
        receipt = await this.#client.waitForTransactionReceipt({
          hash: tx,
          timeout: Math.max(1, deadline - Date.now()),
          pollingInterval: this.#pollMs,
        });
      } catch (err) {
        if (isReceiptTimeout(err)) return report("PENDING", "receipt not available before the deadline", { transaction: tx });
        return report("PENDING", `rpc error while waiting for the receipt: ${(err as Error).message}`, { transaction: tx });
      }
      if (receipt.status !== "success") {
        return report("NOT_SETTLED", `transaction ${receipt.status}`, { transaction: tx, blockNumber: receipt.blockNumber.toString() });
      }

      // Step 5: a Transfer from requirement.asset matching (payer, payTo, amount).
      const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs as Log[] });
      const matched = transfers.some(
        (l) =>
          lower(l.address) === lower(req.asset) &&
          lower(l.args.from) === lower(claim.payer) &&
          lower(l.args.to) === lower(req.payTo) &&
          l.args.value === amount,
      );
      const blockNumber = receipt.blockNumber;
      if (!matched) {
        return report("MISMATCH", "no Transfer(payer → payTo, amount) from the asset contract in the receipt", {
          transaction: tx,
          blockNumber: blockNumber.toString(),
        });
      }

      // Step 6: finality, polled until the same deadline.
      for (;;) {
        const head = await this.#client.getBlockNumber();
        const confirmations = head >= blockNumber ? Number(head - blockNumber + 1n) : 0;
        const reached = await this.#finalityReached(finalityClass, blockNumber, confirmations);
        const extra = { transaction: tx, blockNumber: blockNumber.toString(), confirmations };
        if (reached) return report("CONFIRMED", `Transfer matched; finality ${finalityClass} reached`, extra);
        if (Date.now() + this.#pollMs > deadline) {
          return report("PENDING", `Transfer matched; finality ${finalityClass} not reached before the deadline`, extra);
        }
        await sleep(this.#pollMs);
      }
    } catch (err) {
      // Any unexpected RPC failure is conservative: PENDING keeps the amount committed and is re-checked.
      return report("PENDING", `verifier error: ${(err as Error).message}`);
    }
  }

  async #finalityReached(cls: FinalityClass, block: bigint, confirmations: number): Promise<boolean> {
    if (cls === "included") return true;
    const depth = this.#net.confirmationDepth;
    if (cls === "confirmed-depth") return confirmations >= depth;
    if (this.#net.supportsSafeTag) {
      const safe = await this.#client.getBlock({ blockTag: "safe" });
      return safe.number !== null && safe.number >= block;
    }
    return confirmations >= depth * SAFE_DEPTH_MULTIPLIER;
  }
}
