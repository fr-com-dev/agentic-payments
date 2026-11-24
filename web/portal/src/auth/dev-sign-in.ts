// 017 (SPEC.md L2-8; specs/017 research R11): whether this build of the web app has the local dev sign-in, the
// pasted token. Vite sets `MODE` at build time, so in the portal image's build (`--mode deployment`) this is the
// constant false and every piece of interface it guards (the pasted-token field and the pasted-token identity
// confirmation) is dropped from the files served. The dynamic import of ./dev.js tests the mode in main.tsx itself:
// the bundler collects a dynamic import before a constant from another module folds, so only a literal there keeps
// that module's chunk out of the build (T-WEB-16). Local builds and the tests keep the dev sign-in.
export const DEV_SIGN_IN: boolean = import.meta.env.MODE !== "deployment";
