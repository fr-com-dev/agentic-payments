// Credential-shape patterns for scanning logs (SPEC.md §11 SEC-16; specs/011 research R13). Used by
// `npm run scan-logs` in the deploy workflow over the Log Analytics rows of a deployment, and by tests.
// Shape-based on purpose: the scanning machine must never hold the secrets themselves. Exact-value
// coverage (planted known values) is proven offline by T-AGT-05 and the demo tests. A bare 0x + 64 hex
// value is not a pattern here: a private key has the same shape as a transaction hash.
export const SECRET_SHAPES: readonly { name: string; re: RegExp }[] = [
  { name: "JWT", re: /eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/ },
  { name: "bearer token", re: /Bearer\s+[A-Za-z0-9._~+/-]{16,}/ },
  { name: "PEM private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "payment signature header", re: /PAYMENT-SIGNATURE["']?\s*[:=]/i },
  { name: "API key header", re: /x-api-key["']?\s*[:=]\s*\S+/i },
  // `NAME=secretref:x` is a Container Apps reference to a Key Vault secret, not a value.
  { name: "secret assignment", re: /\b[A-Z0-9_]*(PRIVATE_KEY|SECRET|TOKEN)=(?!secretref:)\S+/ },
];

/** The names of the patterns found in `text`. Never the matched text itself. */
export function findSecretShapes(text: string): string[] {
  return SECRET_SHAPES.filter((s) => s.re.test(text)).map((s) => s.name);
}
