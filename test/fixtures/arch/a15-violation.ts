// @virtual-path: src/hosted-main.ts
import { MachineCaller } from "./machine-caller/token.js";
export const key = process.env["MACHINE_CLIENT_KEY"];
export const caller = MachineCaller;
