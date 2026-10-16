// Type shim for the solc-js package, which ships no TypeScript declarations (used by local-chain-lib.ts).
declare module "solc" {
  const solc: {
    compile(input: string, options?: { import?: (path: string) => { contents?: string; error?: string } }): string;
    version(): string;
  };
  export default solc;
}
