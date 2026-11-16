// The sole key holder (SPEC.md §8.2 L2-3, INV-2, INV-6). Owner: feature 002.
// This is the only file under src/ that turns key material into an account. 013 adds the user wallets' keyring: one
// mnemonic, read here and nowhere else (rule A11), and one account per wallet index (specs/013 research R3).
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createHash } from "node:crypto";
import { english, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import type { LocalAccount } from "viem";
import { ConfigError, type NetworkProfile } from "../shared/config.js";

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

/**
 * The first ten accounts of each mnemonic this repository publishes: the local chain's (`LOCAL_MNEMONIC` in
 * scripts/local-chain-lib.ts), the local user wallets' (`DEV_USER_WALLET_MNEMONIC` in scripts/demo-lib.ts) and the
 * tests' (`TEST_MNEMONIC` in test/helpers/users.ts). Anyone can sign for them. Addresses only, lower-cased: no
 * phrase or key is written under src/. T-DEVKEY-01 derives the list again from the three phrases.
 */
export const PUBLISHED_DEV_ADDRESSES: ReadonlySet<string> = new Set(
  [
    // LOCAL_MNEMONIC, HD indexes 0-9 (deployer, facilitator, payer, seller payTo, ...)
    "0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1",
    "0xFFcf8FDEE72ac11b5c542428B35EEF5769C409f0",
    "0x22d491Bde2303f2f43325b2108D26f1eAbA1e32b",
    "0xE11BA2b4D45Eaed5996Cd0823791E0C93114882d",
    "0xd03ea8624C8C5987235048901fB614fDcA89b117",
    "0x95cED938F7991cd0dFcb48F0a06a40FA1aF46EBC",
    "0x3E5e9111Ae8eB78Fe1CC3bb8915d5D461F3Ef9A9",
    "0x28a8746e75304c0780E011BEd21C72cD78cd535E",
    "0xACa94ef8bD5ffEE41947b4585a84BdA5a3d3DA6E",
    "0x1dF62f291b2E969fB0849d99D9Ce41e2F137006e",
    // DEV_USER_WALLET_MNEMONIC, indexes 0-9
    "0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb",
    "0xf785bD075874b8423D3583728a981399f31e95aA",
    "0x60Af1c6A5D03F9f1B1b74931499bC99E72fF8DA9",
    "0xDF7F9c4b9B9b9580B265DCD892173e9bD90e067F",
    "0xC1080BB846F3B862d04e72EAd4B92A4D47233D98",
    "0xEf253B9Bb0eeBd09e16E77AB3482153570332472",
    "0x18e90265AC4994FC6305Bfe6C935b511705c818A",
    "0x8B19EDa4De09B98ffc1d1692Bbf810053E91d5AE",
    "0xe1a74C3903A574466aE3E7e428c92178504e1317",
    "0x72f17042AB498FB9F5a9F9695F58A449fC6b1f1e",
    // TEST_MNEMONIC, indexes 0-9
    "0x2f826cb22E80a2c40f149Ecb92b2Fa5ecBf67170",
    "0x300bd41A86F051B7d2ef63052Dc0c66B5164f8b5",
    "0x24B989513890DC57220f34671b1c3Eb8Ea73c639",
    "0xb675AA318107eC27a654e0a92f40Ef2c42542176",
    "0xc0976e22de1b032e1B20091Ac55BDF561E75996A",
    "0x3190B818CB25f8e949950da7063182BA4461F93c",
    "0xdA2d940a49f5197DeB84D1D9cfc26b82BaE5f931",
    "0x5173e13Eda1eDACAd7c5fee0567C5658A99E0c68",
    "0xA5686579A46C7998a8d71773F401DFAe8bD81604",
    "0x265dA5968099e9838a1B023B9F292992374A2CdA",
  ].map((a) => a.toLowerCase()),
);

/**
 * Outside `NETWORK=local`, L2 refuses to start with a payer key or a user wallet mnemonic from the published list:
 * every payment it signed could be taken by anyone. The message names the variable, never its value. A keyring is
 * recognised by its first account.
 */
export function refusePublishedDevKeys(network: string, payerAddress: string, keyring?: { addressOf(index: number): string }): void {
  if (network === "local") return;
  if (PUBLISHED_DEV_ADDRESSES.has(payerAddress.toLowerCase())) {
    throw new ConfigError(`PAYER_PRIVATE_KEY is a published development key; NETWORK=${network} needs a key of its own`);
  }
  if (keyring !== undefined && PUBLISHED_DEV_ADDRESSES.has(keyring.addressOf(0).toLowerCase())) {
    throw new ConfigError(`${USER_WALLET_ENV} is a published development mnemonic; NETWORK=${network} needs a phrase of its own`);
  }
}
