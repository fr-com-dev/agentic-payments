// 013 portal API docs: Swagger UI over docs/portal.openapi.yaml (SPEC.md §8.2 L2-8, SEC-13). Mounted only with
// API_DOCS=1, before the access check, like the health routes: they take no token, so they serve fixed files and the
// document only. The routes live in src/shared/api-docs.ts. The Azure deployment never sets API_DOCS.
import { fileURLToPath } from "node:url";
import type { Express } from "express";
import { mountApiDocs as mount, servedApiDocument as served, type ApiDocsSite } from "../shared/api-docs.js";

export const PORTAL_API_DOCS_FILE = fileURLToPath(new URL("../../docs/portal.openapi.yaml", import.meta.url));

const SITE: ApiDocsSite = { file: PORTAL_API_DOCS_FILE, title: "Portal API", servedBy: "The portal serving this document" };

/** The document as served: the file with `servers` pointing at this portal. Throws when the block is missing. */
export const servedPortalApiDocument = (text: string): string => served(SITE, text);

/** GET /docs, GET /docs/:asset, GET /openapi.yaml. Reads every file up front, so a missing one fails startup. */
export const mountPortalApiDocs = (app: Express): void => mount(app, SITE);
