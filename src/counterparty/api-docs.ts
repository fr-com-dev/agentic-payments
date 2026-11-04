// Seller API docs: Swagger UI over docs/seller.openapi.yaml (SPEC.md CP-1, SEC-13). Owner: v1.6.
// Mounted only with API_DOCS=1, before the payment middleware like the catalog: free routes that serve fixed files
// and the document only, with no facilitator call. The routes live in src/shared/api-docs.ts, shared with L2 and
// the hosted agent. The Azure deployment never sets API_DOCS (T-API-08). A browser can't sign an x402 payment, so
// "Try it out" on a priced route shows its 402 challenge.
import { fileURLToPath } from "node:url";
import type { Express } from "express";
import { mountApiDocs as mount, servedApiDocument as served, type ApiDocsSite } from "../shared/api-docs.js";

export const SELLER_API_DOCS_FILE = fileURLToPath(new URL("../../docs/seller.openapi.yaml", import.meta.url));

const SITE: ApiDocsSite = { file: SELLER_API_DOCS_FILE, title: "Seller API", servedBy: "The seller serving this document" };

/** The document as served: the file with `servers` pointing at this seller. Throws when the block is missing. */
export const servedSellerApiDocument = (text: string): string => served(SITE, text);

/** GET /docs, GET /docs/:asset, GET /openapi.yaml. Reads every file up front, so a missing one fails startup. */
export const mountSellerApiDocs = (app: Express): void => mount(app, SITE);
