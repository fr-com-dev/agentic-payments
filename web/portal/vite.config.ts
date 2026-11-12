// Build of the portal web app (specs/013 research R10): `npm run build:web` writes static files to dist/portal-web,
// which the portal process serves. One page: the app (the sign-in pop-up needs no page of the portal's own). JSX is
// compiled by Vite's own transformer (automatic runtime); no plugin is needed for a build.
import { resolve } from "node:path";
import { defineConfig } from "vite";

const root = import.meta.dirname;

export default defineConfig({
  root,
  base: "/",
  build: {
    outDir: resolve(root, "../../dist/portal-web"),
    emptyOutDir: true,
    sourcemap: false,
  },
});
