// @virtual-path: src/layer1-intent/x.ts
const header = "PAYMENT-REQUIRED";
export const decode = (v: string) => [header, Buffer.from(v, "base64")];
