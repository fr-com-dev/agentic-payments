// The sole key holder (SPEC.md §8.2 L2-3, INV-2, INV-6). Owner: feature 002.
// This is the only file under src/ that turns key material into an account. 013 adds the user wallets' keyring: one
// mnemonic, read here and nowhere else (rule A11), and one account per wallet index (specs/013 research R3).
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createHash } from "node:crypto";
import { english, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import type { LocalAccount } from "viem";
import type { NetworkProfile } from "../shared/config.js";

export interface SignedAuthorization {
  headers: Record<string, string>;
  payer: string;
  validBefore: number;
}

/** The surface L2 uses. A remote signer (EXT-2) would implement the same shape. */
export interface PaymentSignerLike {
  readonly address: string;
  sign(challenge: PaymentRequired, approved: PaymentRequirements): Promise<SignedAuthorization>;
}

export class PaymentSigner implements PaymentSignerLike {
  readonly address: string;
  readonly #http: x402HTTPClient;

  constructor(key: `0x${string}` | LocalAccount, net: Pick<NetworkProfile, "caip2" | "asset">, hardCapAtomic: string) {
    const account = typeof key === "string" ? privateKeyToAccount(key) : key;
    this.address = account.address;
    const client = new x402Client().register(net.caip2, new ExactEvmScheme(account));
    // Independent second cap (L2-3): only the profile's asset, capped at the mandate hard cap.
    client.setSpendControls({
      maxAmountPerPayment: false,
      allowedAssets: [{ network: net.caip2, asset: net.asset, maxAmountPerPayment: hardCapAtomic }],
    });
    this.#http = new x402HTTPClient(client);
  }

  /** Signs exactly the approved requirement: the SDK sees a challenge whose `accepts` holds only it (INV-6). */
  async sign(challenge: PaymentRequired, approved: PaymentRequirements): Promise<SignedAuthorization> {
    const payload = await this.#http.createPaymentPayload({ ...challenge, accepts: [approved] });
    const auth = (payload.payload as { authorization?: { from: string; validBefore: string | number } }).authorization;
    if (!auth) throw new Error("signer: payload has no EIP-3009 authorization");
    return {
      headers: this.#http.encodePaymentSignatureHeader(payload),
      payer: auth.from,
      validBefore: Number(auth.validBefore),
    };
  }
}

/** 013: the variable that holds the user wallets' mnemonic. Named here only (rule A11); others import the constant. */
export const USER_WALLET_ENV = "USER_WALLET_MNEMONIC";
const MNEMONIC_WORDS = 24;

export class KeyringError extends Error {
  override name = "KeyringError";
}

/**
 * BIP-39 check of a 24-word English phrase: every word is on the list, and the last 8 bits equal the first byte of
 * SHA-256 over the 256 bits of entropy. A mistyped phrase is refused here instead of silently deriving other accounts.
 */
function validMnemonic24(phrase: string): boolean {
  const words = phrase.split(" ");
  if (words.length !== MNEMONIC_WORDS) return false;
  let bits = "";
  for (const w of words) {
    const i = english.indexOf(w);
    if (i < 0) return false;
    bits += i.toString(2).padStart(11, "0");
  }
  const entropy = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) entropy[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const checksum = createHash("sha256").update(entropy).digest()[0]!;
  return parseInt(bits.slice(256), 2) === checksum;
}

/**
 * 013 (L2-3): the users' accounts. One BIP-39 mnemonic; a user's account is the standard path
 * `m/44'/60'/0'/0/<walletIndex>`, with the index recorded in the ledger. The phrase never leaves this object and
 * is never logged; nothing per user is stored.
 */
export class WalletKeyring {
  readonly #mnemonic: string;
  readonly #net: Pick<NetworkProfile, "caip2" | "asset">;
  readonly #accounts = new Map<number, LocalAccount>();

  constructor(mnemonic: string, net: Pick<NetworkProfile, "caip2" | "asset">) {
    const phrase = mnemonic.trim().split(/\s+/).join(" ");
    if (!validMnemonic24(phrase)) {
      // Never echo the value: name the setting only.
      throw new KeyringError(`${USER_WALLET_ENV} is not a valid ${MNEMONIC_WORDS}-word BIP-39 mnemonic`);
    }
    this.#mnemonic = phrase;
    this.#net = net;
  }

  #account(index: number): LocalAccount {
    if (!Number.isInteger(index) || index < 0 || index > 0x7fffffff) throw new KeyringError(`bad wallet index: ${index}`);
    let account = this.#accounts.get(index);
    if (!account) {
      account = mnemonicToAccount(this.#mnemonic, { addressIndex: index });
      this.#accounts.set(index, account);
    }
    return account;
  }

  addressOf(index: number): string {
    return this.#account(index).address;
  }

  /** A signer for one user's account, with the same independent SDK cap as the platform signer (L2-3). */
  signerFor(index: number, hardCapAtomic: string): PaymentSignerLike {
    return new PaymentSigner(this.#account(index), this.#net, hardCapAtomic);
  }
}

/** Builds the keyring from the environment. A missing or invalid phrase names the variable, never its value. */
export function keyringFromEnv(env: Record<string, string | undefined>, net: Pick<NetworkProfile, "caip2" | "asset">): WalletKeyring {
  const phrase = env[USER_WALLET_ENV];
  if (phrase === undefined || phrase.trim() === "") throw new KeyringError(`missing ${USER_WALLET_ENV}`);
  return new WalletKeyring(phrase, net);
}
