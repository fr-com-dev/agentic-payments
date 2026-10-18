// @virtual-path: src/layer1-intent/leak.ts
import { generateJwt } from "@coinbase/cdp-sdk/auth";
export const k = [process.env.CDP_API_KEY_SECRET, generateJwt];
