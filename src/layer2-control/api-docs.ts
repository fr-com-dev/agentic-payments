// L2 API docs: Swagger UI over docs/l2-control.openapi.yaml (SPEC.md §8.2 L2-5, SEC-13). Owner: v1.4.
// Mounted only with API_DOCS=1. The routes themselves live in src/shared/api-docs.ts (shared with the hosted
// agent service since v1.6): fixed files and the document, no ledger, mandate or signer access.
import { fileURLToPath } from "node:url";
import type { Express } from "express";
import { mountApiDocs as mount, servedApiDocument as served, type ApiDocsSite } from "../shared/api-docs.js";

export const API_DOCS_FILE = fileURLToPath(new URL("../../docs/l2-control.openapi.yaml", import.meta.url));

const SITE: ApiDocsSite = { file: API_DOCS_FILE, title: "L2 control API", servedBy: "The L2 instance serving this document" };

/** The document as served: the file with `servers` pointing at this L2. Throws when the block is missing. */
export const servedApiDocument = (text: string): string => served(SITE, text);

/** GET /docs, GET /docs/:asset, GET /openapi.yaml. Reads every file up front, so a missing one fails startup. */
export const mountApiDocs = (app: Express): void => mount(app, SITE);
