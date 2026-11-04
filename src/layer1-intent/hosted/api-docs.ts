// L1-6 API docs: Swagger UI over docs/l1-hosted.openapi.yaml (SPEC.md §8.1 L1-6, SEC-13). Owner: v1.6.
// Mounted only with API_DOCS=1, before requester auth, like the health routes: they take no token, so they serve
// fixed files and the document only, with no model, session, L2 or L3 access. The routes live in
// src/shared/api-docs.ts, shared with L2. The Azure deployment never sets API_DOCS (T-API-08).
import { fileURLToPath } from "node:url";
import type { Express } from "express";
import { mountApiDocs as mount, servedApiDocument as served, type ApiDocsSite } from "../../shared/api-docs.js";

export const HOSTED_API_DOCS_FILE = fileURLToPath(new URL("../../../docs/l1-hosted.openapi.yaml", import.meta.url));

const SITE: ApiDocsSite = { file: HOSTED_API_DOCS_FILE, title: "L1 hosted agent API", servedBy: "The hosted agent serving this document" };

/** The document as served: the file with `servers` pointing at this agent. Throws when the block is missing. */
export const servedHostedApiDocument = (text: string): string => served(SITE, text);

/** GET /docs, GET /docs/:asset, GET /openapi.yaml. Reads every file up front, so a missing one fails startup. */
export const mountHostedApiDocs = (app: Express): void => mount(app, SITE);
