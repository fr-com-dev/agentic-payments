// Local facilitator (SPEC.md CP-2). LOCAL ONLY: verifies and settles x402 `exact` EIP-3009 payments on
// the local chain and pays gas. This file is a factory: it receives a ready account and never handles
// key material (INV-2). The process entry, key handling and listen live in scripts/facilitator.ts.
import express from "express";
import { createWalletClient, defineChain, http, publicActions, type LocalAccount } from "viem";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import type { Caip2 } from "../shared/config.js";

export interface FacilitatorAppOptions {
  /** The facilitator's own gas-paying account (#1 locally), already constructed by the caller. */
  account: LocalAccount;
  rpcUrl: string;
  caip2: Caip2;
}

interface FacilitatorRequest {
  x402Version: number;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

/** Validates the CP-2 request body shape; throws on anything malformed (mapped to 400). */
function parseRequest(body: unknown): FacilitatorRequest {
  const b = body as Partial<FacilitatorRequest> | undefined;
  if (!b || typeof b !== "object") throw new Error("invalid_request: body must be a JSON object");
  if (typeof b.x402Version !== "number") throw new Error("invalid_request: x402Version must be a number");
  if (!b.paymentPayload || typeof b.paymentPayload !== "object") throw new Error("invalid_request: paymentPayload missing");
  if (!b.paymentRequirements || typeof b.paymentRequirements !== "object") {
    throw new Error("invalid_request: paymentRequirements missing");
  }
  return b as FacilitatorRequest;
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

export function createFacilitatorApp({ account, rpcUrl, caip2 }: FacilitatorAppOptions): express.Express {
  const chainId = Number(caip2.split(":")[1]);
  const chain = defineChain({
    id: chainId,
    name: `local-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const client = createWalletClient({ account, chain, transport: http(rpcUrl) }).extend(publicActions);
  const signer = toFacilitatorEvmSigner(
    { ...client, address: account.address } as unknown as Parameters<typeof toFacilitatorEvmSigner>[0],
    { confirmationTimeoutMs: 30_000 },
  );
  const facilitator = new x402Facilitator().register(caip2, new ExactEvmScheme(signer));

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/supported", (_req, res) => {
    res.json(facilitator.getSupported());
  });

  app.post("/verify", async (req, res) => {
    try {
      const { paymentPayload, paymentRequirements } = parseRequest(req.body);
      res.json(await facilitator.verify(paymentPayload, paymentRequirements));
    } catch (err) {
      res.status(400).json({ isValid: false, invalidReason: reason(err) });
    }
  });

  app.post("/settle", async (req, res) => {
    try {
      const { paymentPayload, paymentRequirements } = parseRequest(req.body);
      res.json(await facilitator.settle(paymentPayload, paymentRequirements));
    } catch (err) {
      res.status(400).json({ success: false, errorReason: reason(err), transaction: "", network: caip2 });
    }
  });

  // Malformed JSON bodies are a client error with the same x402 shape, never a 500.
  app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (req.path === "/settle") res.status(400).json({ success: false, errorReason: reason(err), transaction: "", network: caip2 });
    else res.status(400).json({ isValid: false, invalidReason: reason(err) });
  });

  return app;
}
