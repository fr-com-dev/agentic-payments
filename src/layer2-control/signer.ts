// The sole key holder (SPEC.md §8.2 L2-3, INV-2, INV-6). Owner: feature 002.
// This is the only file under src/ that turns key material into an account.
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
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

  constructor(privateKey: `0x${string}`, net: Pick<NetworkProfile, "caip2" | "asset">, hardCapAtomic: string) {
    const account = privateKeyToAccount(privateKey);
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
