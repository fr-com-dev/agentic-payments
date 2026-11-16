// L2 refuses a published development key outside NETWORK=local (SPEC.md §8.2 L2-3; T-DEVKEY-01). The repository
// ships three mnemonics anyone can read; a payer key or a user wallet phrase taken from one of them would let
// anyone sign for the accounts L2 pays from.
import { generateMnemonic, mnemonicToAccount, privateKeyToAccount, english } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { DEV_USER_WALLET_MNEMONIC } from "../scripts/demo-lib.js";
import { localDevKeys, LOCAL_MNEMONIC } from "../scripts/local-chain-lib.js";
import { ConfigError } from "../src/shared/config.js";
import { PUBLISHED_DEV_ADDRESSES, refusePublishedDevKeys, USER_WALLET_ENV, WalletKeyring } from "../src/layer2-control/signer.js";
import { TEST_MNEMONIC } from "./helpers/users.js";

const NET = { caip2: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" } as const;
const PHRASES = { LOCAL_MNEMONIC, DEV_USER_WALLET_MNEMONIC, TEST_MNEMONIC };
const freshPayer = () => privateKeyToAccount(`0x${"7".repeat(63)}1`).address;
const freshKeyring = () => new WalletKeyring(generateMnemonic(english, 256), NET);

describe("T-DEVKEY-01 L2 refuses a published development key outside local", () => {
  it("T-DEVKEY-01 the list is the first ten accounts of each published phrase, and nothing else", () => {
    const derived = Object.values(PHRASES).flatMap((m) => Array.from({ length: 10 }, (_, i) => mnemonicToAccount(m, { addressIndex: i }).address.toLowerCase()));
    expect([...PUBLISHED_DEV_ADDRESSES].sort()).toEqual([...new Set(derived)].sort());
    expect(PUBLISHED_DEV_ADDRESSES.size).toBe(30);
  });

  it("T-DEVKEY-01 on base-sepolia the local payer key and each published 24-word phrase stop L2, naming the variable only", () => {
    const devPayer = privateKeyToAccount(localDevKeys({ NETWORK: "local" }).payer).address;
    expect(() => refusePublishedDevKeys("base-sepolia", devPayer)).toThrow(ConfigError);
    expect(() => refusePublishedDevKeys("base-sepolia", devPayer)).toThrow(/^PAYER_PRIVATE_KEY is a published development key/);
    for (const phrase of [DEV_USER_WALLET_MNEMONIC, TEST_MNEMONIC]) {
      const keyring = new WalletKeyring(phrase, NET);
      let message = "";
      try {
        refusePublishedDevKeys("base-sepolia", freshPayer(), keyring);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(new RegExp(`^${USER_WALLET_ENV} is a published development mnemonic`));
      expect(message).not.toContain(phrase.split(" ")[0]!);
    }
    // Any account of the chain's phrase is refused as a payer, not only the one the demo uses.
    for (let i = 0; i < 10; i++) {
      expect(() => refusePublishedDevKeys("base-sepolia", mnemonicToAccount(LOCAL_MNEMONIC, { addressIndex: i }).address)).toThrow(ConfigError);
    }
  });

  it("T-DEVKEY-01 locally the published keys are allowed, and elsewhere keys of their own pass", () => {
    const devPayer = privateKeyToAccount(localDevKeys({ NETWORK: "local" }).payer).address;
    expect(() => refusePublishedDevKeys("local", devPayer, new WalletKeyring(DEV_USER_WALLET_MNEMONIC, NET))).not.toThrow();
    expect(() => refusePublishedDevKeys("base-sepolia", freshPayer(), freshKeyring())).not.toThrow();
    expect(() => refusePublishedDevKeys("base-sepolia", freshPayer())).not.toThrow();
  });
});
