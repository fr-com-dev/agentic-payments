# Contract: PaymentSigner (`src/layer2-control/signer.ts`, L2-3)

This is the only file in the repo allowed to turn key material into an account (INV-2,
enforced by the architecture test in [feature 007](../../007-process-isolation-security/contracts/)).

```ts
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import type { NetworkProfile } from "../shared/config.js";

export class PaymentSigner {
  constructor(privateKey: `0x${string}`, net: NetworkProfile, hardCapAtomic: string);
  readonly address: string;
  sign(challenge: PaymentRequired, approved: PaymentRequirements): Promise<{
    headers: Record<string, string>;   // { "PAYMENT-SIGNATURE": <SDK-encoded> }
    payer: string;                      // authorization.from
    validBefore: number;                // Number(authorization.validBefore), seconds
  }>;
}
```

## Construction

- `account = privateKeyToAccount(privateKey)`.
- `x402Client().register(net.caip2, new ExactEvmScheme(account))`.
- SDK spend controls, the second cap independent of policy R10:
  ```ts
  { maxAmountPerPayment: false,
    allowedAssets: [{ network: net.caip2, asset: net.asset, maxAmountPerPayment: hardCapAtomic }] }
  ```

## `sign`

1. `payload = x402HTTPClient.createPaymentPayload({ ...challenge, accepts: [approved] })`.
   Only the chosen option is visible to the SDK (INV-6).
2. `headers = encodePaymentSignatureHeader(payload)`. Hand-built base64 is not allowed.
3. Any SDK error propagates. The caller maps it to `DENIED` / `signer_rejected`, with the
   detail truncated to 300 characters.

## Not provided

There is no API that exports or logs the key, and no generic "sign arbitrary data" method.
A remote signer (EXT-2) would implement the same `{ address; sign }` surface.
