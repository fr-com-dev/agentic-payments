// Build of the portal web app (specs/013 research R10): `npm run build:web` writes static files to dist/portal-web,
// which the portal process serves. Two pages: the app, and the sign-in library's redirect page, which must run no
// application code. JSX is compiled by Vite's own transformer (automatic runtime); no plugin is needed for a build.
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
    rollupOptions: {
      input: { index: resolve(root, "index.html"), redirect: resolve(root, "redirect.html") },
    },
  },
});
