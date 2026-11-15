// L1-6 API docs: Swagger UI over docs/l1-hosted.openapi.yaml (SPEC.md §8.1 L1-6, SEC-13). Owner: v1.6.
// Mounted only with API_DOCS=1, before requester auth, like the health routes: they take no token, so they serve
// fixed files and the document only, with no model, session, L2 or L3 access. The routes live in
// src/shared/api-docs.ts, shared with L2. 016: with `API_DOCS_CLIENT_ID` the page signs a person in at the tenant
// (SEC-34). In Azure the routes exist only where the environment's parameter file turns them on (T-API-08).
import { fileURLToPath } from "node:url";
import type { Express } from "express";
import { mountApiDocs as mount, servedApiDocument as served, type ApiDocsSignIn, type ApiDocsSite } from "../../shared/api-docs.js";
import type { HostedConfig } from "./config.js";

export const HOSTED_API_DOCS_FILE = fileURLToPath(new URL("../../../docs/l1-hosted.openapi.yaml", import.meta.url));

const SITE: ApiDocsSite = { file: HOSTED_API_DOCS_FILE, title: "L1 hosted agent API", servedBy: "The hosted agent serving this document" };

/** The page's sign-in, from the agent's own settings: only with a docs client configured (a real tenant). */
export function docsSignIn(config: Pick<HostedConfig, "auth">): ApiDocsSignIn | undefined {
  const { issuer, audience, docsClientId } = config.auth;
  return docsClientId === undefined ? undefined : { issuer, clientId: docsClientId, audience };
}

/** The document as served: the file with `servers` pointing at this agent. Throws when the block is missing. */
export const servedHostedApiDocument = (text: string, signIn?: ApiDocsSignIn): string => served({ ...SITE, ...(signIn && { signIn }) }, text);

/** GET /docs, GET /docs/:asset, GET /openapi.yaml. Reads every file up front, so a missing one fails startup. */
export const mountHostedApiDocs = (app: Express, signIn?: ApiDocsSignIn): void => mount(app, { ...SITE, ...(signIn && { signIn }) });
