// API docs: Swagger UI over one OpenAPI document (SPEC.md §8.2 L2-5, §8.1 L1-6, CP-1, SEC-13). Owner: v1.4 (L2); shared by
// L2, the hosted agent service and the seller since v1.6. Each mounts it only with API_DOCS=1, through its own wrapper
// (src/layer2-control/, src/layer1-intent/hosted/ and src/counterparty/api-docs.ts) that names its document. These routes
// take no token, so they serve fixed files and nothing else: no ledger, mandate, signer, model, session or facilitator access.
// Swagger UI comes from the pinned swagger-ui-dist package, never a CDN, and the page's CSP allows scripts and
// requests to this origin only, because the page shares an origin with the API and the tokens typed into it.
// 016 (SEC-34): a site may let the page sign a person in at the sign-in tenant (`signIn`): authorization code with
// PKCE through a public client, so the page holds no secret; the token stays in the page's memory and is gone on
// reload; and the one origin added to the CSP is the tenant's, for the token request only. Scripts stay 'self'.
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
  /**
   * 016: sign-in at the tenant from the page ("Authorize"). Absent: the page offers only the schemes a token is
   * pasted into, and the document's sign-in scheme is left out of what is served.
   */
  signIn?: ApiDocsSignIn;
}

/** The public settings the page signs in with. None is a secret. */
export interface ApiDocsSignIn {
  /** The sign-in tenant's issuer, `https://<domain>/`. */
  issuer: string;
  /** A public client of the tenant (authorization code with PKCE, no secret). */
  clientId: string;
  /** The API the token is for. */
  audience: string;
}

/** The origin the committed document uses for the tenant's two addresses; the served one names the real tenant. */
export const SIGN_IN_PLACEHOLDER = "https://sign-in-tenant.invalid/";
/** What the committed document wraps its sign-in scheme and its use in: left out when a site has no `signIn`. */
const SIGN_IN_BLOCK = /^[ \t]*# sign-in:begin.*\n(?:.*\n)*?[ \t]*# sign-in:end.*\n/gm;

/** The top-level `servers` block, replaced when served so "Try it out" calls the service that serves the page. */
const SERVERS_BLOCK = /^servers:\n(?: {2}.*\n)+/m;

/** The page's policy. With sign-in, the tenant's origin is added to `connect-src` and to nothing else. */
const csp = (signIn?: ApiDocsSignIn) =>
  [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src 'self'${signIn ? ` ${new URL(signIn.issuer).origin}` : ""}`,
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

/**
 * validatorUrl null: no request to swagger.io. Authorization is not persisted to localStorage (default), so a
 * reload forgets the token. With sign-in: PKCE, the client and the audience the tenant needs on its authorize
 * address; the redirect page is this origin's own. The values are public and written as JSON.
 */
export function initializerScript(signIn?: ApiDocsSignIn): string {
  const base = 'window.ui = SwaggerUIBundle({ url: "/openapi.yaml", dom_id: "#swagger-ui", validatorUrl: null';
  if (!signIn) return `${base} });\n`;
  const oauth = { clientId: signIn.clientId, usePkceWithAuthorizationCodeGrant: true, additionalQueryStringParams: { audience: signIn.audience } };
  return `${base}, oauth2RedirectUrl: window.location.origin + "/docs/oauth2-redirect.html" });\nwindow.ui.initOAuth(${JSON.stringify(oauth)});\n`;
}

/**
 * The only files under /docs/. The style sheet and the bundle come from swagger-ui-dist; the initializer is ours.
 * With sign-in, the package's redirect page and its script are added: the page holds no inline script.
 */
function loadAssets(signIn?: ApiDocsSignIn): Map<string, { type: string; body: string }> {
  const req = createRequire(import.meta.url);
  const dist = (file: string) => readFileSync(req.resolve(`swagger-ui-dist/${file}`), "utf8");
  return new Map([
    ["swagger-ui.css", { type: "text/css", body: dist("swagger-ui.css") }],
    ["swagger-ui-bundle.js", { type: "text/javascript", body: dist("swagger-ui-bundle.js") }],
    ["swagger-initializer.js", { type: "text/javascript", body: initializerScript(signIn) }],
    ...(signIn
      ? ([
          ["oauth2-redirect.html", { type: "text/html", body: dist("oauth2-redirect.html") }],
          ["oauth2-redirect.js", { type: "text/javascript", body: dist("oauth2-redirect.js") }],
        ] as const)
      : []),
  ]);
}

/**
 * The document as served: the file with `servers` pointing at this origin. With `signIn`, the sign-in scheme's two
 * addresses name the tenant; without it, the scheme and every use of it are left out. Throws when the servers block
 * is missing, or when sign-in is asked for and the document has no scheme to fill.
 */
export function servedApiDocument(site: Pick<ApiDocsSite, "file" | "servedBy" | "signIn">, text: string): string {
  if (!SERVERS_BLOCK.test(text)) throw new Error(`${site.file}: no top-level servers block`);
  const served = text.replace(SERVERS_BLOCK, `servers:\n  - url: /\n    description: ${site.servedBy}\n`);
  if (!site.signIn) return served.replace(SIGN_IN_BLOCK, "");
  // The placeholder is a marker in a file of this repository, not an address to check: cut the text at each one
  // and join the pieces with the tenant.
  const pieces = served.split(SIGN_IN_PLACEHOLDER);
  if (pieces.length === 1) throw new Error(`${site.file}: no sign-in scheme to fill (${SIGN_IN_PLACEHOLDER})`);
  return pieces.join(site.signIn.issuer);
}

/** GET /docs, GET /docs/:asset, GET /openapi.yaml. Reads every file up front, so a missing one fails startup. */
export function mountApiDocs(app: Express, site: ApiDocsSite): void {
  const document = servedApiDocument(site, readFileSync(site.file, "utf8"));
  const assets = loadAssets(site.signIn);
  const html = page(site.title);
  const policy = csp(site.signIn);

  app.get("/docs", (_req, res) => {
    res.set("content-security-policy", policy).type("html").send(html);
  });

  app.get("/docs/:asset", (req, res) => {
    const asset = assets.get(String(req.params.asset));
    if (asset === undefined) {
      res.status(404).json({ error: "not found" });
      return;
    }
    // The redirect page is a page too: it runs under the same policy.
    if (asset.type === "text/html") res.set("content-security-policy", policy);
    res.type(asset.type).send(asset.body);
  });

  app.get("/openapi.yaml", (_req, res) => {
    res.type("application/yaml").send(document);
  });
}
