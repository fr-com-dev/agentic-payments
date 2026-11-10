// 013 balance reads (SPEC.md §8.2 L2-8; specs/013 research R11). The portal reads a user's USDC balance itself, with
// a read-only call on the network's RPC, and shows when it was read (FR-015). An account's address is public; this
// file has no key, no wallet client and no signing call (rule A4 covers src/portal/). A failed read never fails the
// wallet view: the last value comes back marked stale.
import { createPublicClient, erc20Abi, http, type Address } from "viem";

/** At most 30 s old when shown (FR-015): 20 s in the cache, plus the read and the round trip. */
export const BALANCE_MAX_AGE_MS = 20_000;

export interface BalanceReader {
  balanceOf(asset: string, address: string): Promise<bigint>;
}

export interface Balance {
  balanceAtomic: string;
  readAt: string;
  stale: boolean;
}

/** The production reader: `balanceOf` through a public client. */
export function rpcBalanceReader(rpcUrl: string): BalanceReader {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 5_000 }) });
  return {
    balanceOf: (asset, address) =>
      client.readContract({ address: asset as Address, abi: erc20Abi, functionName: "balanceOf", args: [address as Address] }),
  };
}

export interface BalanceCache {
  /** The balance, or undefined when it was never read and the read fails now. */
  get(asset: string, address: string): Promise<Balance | undefined>;
}

export function createBalanceCache(reader: BalanceReader, o: { maxAgeMs?: number; now?: () => number } = {}): BalanceCache {
  const maxAgeMs = o.maxAgeMs ?? BALANCE_MAX_AGE_MS;
  const now = o.now ?? Date.now;
  const last = new Map<string, { atomic: string; atMs: number }>();
  return {
    async get(asset, address) {
      const key = `${asset.toLowerCase()}|${address.toLowerCase()}`;
      const cached = last.get(key);
      const t = now();
      if (cached && t - cached.atMs < maxAgeMs) return { balanceAtomic: cached.atomic, readAt: new Date(cached.atMs).toISOString(), stale: false };
      try {
        const atomic = (await reader.balanceOf(asset, address)).toString();
        last.set(key, { atomic, atMs: t });
        return { balanceAtomic: atomic, readAt: new Date(t).toISOString(), stale: false };
      } catch {
        return cached ? { balanceAtomic: cached.atomic, readAt: new Date(cached.atMs).toISOString(), stale: true } : undefined;
      }
    },
  };
}
