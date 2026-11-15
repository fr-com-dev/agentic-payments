// @virtual-path: src/layer1-intent/hosted/run-log.ts
import type { CallerGates } from "../../shared/contracts.js";
export const header = { "X-Caller-Authorization": "Bearer leaked" };
export const leak = (gates: CallerGates, token: string) => gates.forCaller(token);
