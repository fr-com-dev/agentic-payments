// Scripted read-only chain client for L3 unit tests (005 T002). It implements only the reads the
// verifier is allowed to make: receipt, head block number and the `safe` block.
import { encodeAbiParameters, keccak256, pad, toHex, type Hex, type Log } from "viem";
import type { ReadOnlyChainClient } from "../../src/layer3-settlement/verifier.js";

const TRANSFER_TOPIC = keccak256(toHex("Transfer(address,address,uint256)"));

/** An ERC-20 Transfer log as it appears in a receipt. */
export function transferLog(asset: string, from: string, to: string, value: bigint, blockNumber = 10n): Log {
  return {
    address: asset as Hex,
    topics: [TRANSFER_TOPIC, pad(from as Hex, { size: 32 }), pad(to as Hex, { size: 32 })],
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
    blockNumber,
    blockHash: `0x${"ab".repeat(32)}`,
    logIndex: 0,
    transactionHash: `0x${"cd".repeat(32)}`,
    transactionIndex: 0,
    removed: false,
  } as Log;
}

export interface FakeChainScript {
  receipt?: { status: "success" | "reverted"; blockNumber: bigint; logs: Log[] };
  /** Delay before the receipt is available; past the timeout the call fails like viem's timeout. */
  receiptDelayMs?: number;
  /** Throw this (non-timeout) error from the receipt wait. */
  receiptError?: Error;
  /** Head block numbers returned by successive getBlockNumber calls; the last value repeats. */
  heads?: bigint[];
  /** Safe block numbers returned by successive getBlock({blockTag:"safe"}) calls; the last value repeats. */
  safe?: bigint[];
}

export interface FakeChainClient extends ReadOnlyChainClient {
  calls: { receipt: number; head: number; safe: number; lastTimeout?: number };
}

export function fakePublicClient(script: FakeChainScript): FakeChainClient {
  const calls: FakeChainClient["calls"] = { receipt: 0, head: 0, safe: 0 };
  const next = (arr: bigint[] | undefined, i: number, fallback: bigint) =>
    arr && arr.length > 0 ? arr[Math.min(i, arr.length - 1)]! : fallback;
  return {
    calls,
    async waitForTransactionReceipt({ timeout }) {
      calls.receipt += 1;
      calls.lastTimeout = timeout;
      if (script.receiptError) throw script.receiptError;
      const delay = script.receiptDelayMs ?? 0;
      if (!script.receipt || delay > timeout) {
        await new Promise((r) => setTimeout(r, timeout));
        const err = new Error(`Timed out while waiting for transaction receipt (${timeout} ms)`);
        err.name = "WaitForTransactionReceiptTimeoutError";
        throw err;
      }
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      return script.receipt;
    },
    async getBlockNumber() {
      const v = next(script.heads, calls.head, script.receipt?.blockNumber ?? 0n);
      calls.head += 1;
      return v;
    },
    async getBlock() {
      const v = next(script.safe, calls.safe, 0n);
      calls.safe += 1;
      return { number: v };
    },
  };
}
