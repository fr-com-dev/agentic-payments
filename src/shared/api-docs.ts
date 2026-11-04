// API docs: Swagger UI over one OpenAPI document (SPEC.md §8.2 L2-5, §8.1 L1-6, CP-1, SEC-13). Owner: v1.4 (L2); shared by
// L2, the hosted agent service and the seller since v1.6. Each mounts it only with API_DOCS=1, through its own wrapper
// (src/layer2-control/, src/layer1-intent/hosted/ and src/counterparty/api-docs.ts) that names its document. These routes
// take no token, so they serve fixed files and nothing else: no ledger, mandate, signer, model, session or facilitator access.
// Swagger UI comes from the pinned swagger-ui-dist package, never a CDN, and the page's CSP allows scripts and
// requests to this origin only, because the page shares an origin with the API and the tokens typed into it.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Express } from "express";

/** One service's API docs. */
export interface ApiDocsSite {
  /** Absolute path of the OpenAPI document, read once at mount time. */
  file: string;
  /** The page's title. */
  title: string;
  /** The description of the served document's only server, `/`. */
  servedBy: string;
}

/** The top-level `servers` block, replaced when served so "Try it out" calls the service that serves the page. */
const SERVERS_BLOCK = /^servers:\n(?: {2}.*\n)+/m;

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const page = (title: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="/docs/swagger-ui.css">
</head>
<body>
<div id="swagger-ui"></div>
<script src="/docs/swagger-ui-bundle.js"></script>
<script src="/docs/swagger-initializer.js"></script>
</body>
</html>
`;

// validatorUrl null: no request to swagger.io. Authorization is not persisted to localStorage (default).
const INITIALIZER = `window.ui = SwaggerUIBundle({ url: "/openapi.yaml", dom_id: "#swagger-ui", validatorUrl: null });\n`;

/** The only files under /docs/. Two come from swagger-ui-dist; the initializer is ours. */
function loadAssets(): Map<string, { type: string; body: string }> {
  const req = createRequire(import.meta.url);
  const dist = (file: string) => readFileSync(req.resolve(`swagger-ui-dist/${file}`), "utf8");
  return new Map([
    ["swagger-ui.css", { type: "text/css", body: dist("swagger-ui.css") }],
    ["swagger-ui-bundle.js", { type: "text/javascript", body: dist("swagger-ui-bundle.js") }],
    ["swagger-initializer.js", { type: "text/javascript", body: INITIALIZER }],
  ]);
}

/** The document as served: the file with `servers` pointing at this origin. Throws when the block is missing. */
export function servedApiDocument(site: Pick<ApiDocsSite, "file" | "servedBy">, text: string): string {
  if (!SERVERS_BLOCK.test(text)) throw new Error(`${site.file}: no top-level servers block`);
  return text.replace(SERVERS_BLOCK, `servers:\n  - url: /\n    description: ${site.servedBy}\n`);
}

/** GET /docs, GET /docs/:asset, GET /openapi.yaml. Reads every file up front, so a missing one fails startup. */
export function mountApiDocs(app: Express, site: ApiDocsSite): void {
  const document = servedApiDocument(site, readFileSync(site.file, "utf8"));
  const assets = loadAssets();
  const html = page(site.title);

  app.get("/docs", (_req, res) => {
    res.set("content-security-policy", CSP).type("html").send(html);
  });

  app.get("/docs/:asset", (req, res) => {
    const asset = assets.get(String(req.params.asset));
    if (asset === undefined) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.type(asset.type).send(asset.body);
  });

  app.get("/openapi.yaml", (_req, res) => {
    res.type("application/yaml").send(document);
  });
}
