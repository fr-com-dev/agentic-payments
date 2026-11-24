declare module "*.css";

// 017: Vite replaces `import.meta.env.MODE` at build time (web/portal/src/auth/dev-sign-in.ts). The tsconfig loads no
// Vite types (`types: []`), so the one field the app reads is declared here.
interface ImportMetaEnv {
  readonly MODE: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
