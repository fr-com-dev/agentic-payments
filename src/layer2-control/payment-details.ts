// Payment details shown to the approver (SPEC L2-7; specs/012 contracts/payment-details.md). Owner: feature 012.
// Pure: no I/O and no clock. Every value comes from the ESCALATED entry and the requirement L2 chose; the agent's
// free text is never an input (FR-005, INV-5). Amounts are atomic strings formatted with BigInt only (Principle VI).
import { createHash } from "node:crypto";
import type { PaymentRequirements } from "@x402/core/types";
import { formatAtomic } from "../shared/config.js";
import { canonicalJSON } from "./ledger.js";

/** Guardian push is used only for requests that live 300 s or less (FR-006). */
export const MAX_REQUESTED_EXPIRY_S = 300;
/** Auth0's binding_message limit. */
export const BINDING_MESSAGE_MAX = 64;
export const REFERENCE_CODE_LENGTH = 8;
/** Auth0's Guardian schema: the stock Guardian app displays only this format (research R4). */
export const DETAILS_TYPE = "urn:auth0:schemas:authorization-details:v1:x402-payment";
export const DETAILS_INSTRUCTION = "Approve this payment only if you expect it";
const VALUE_MAX = 255;
/** Auth0 allows only these characters in binding_message: no spaces, no slash. */
const MESSAGE_CHARS = /^[A-Za-z0-9+\-_.,:#]+$/;

export interface DetailsProperty {
  display: boolean;
  name: string;
  display_order: number;
  value: string;
}

export interface PaymentDetailsObject {
  type: typeof DETAILS_TYPE;
  instruction: string;
  properties: Record<string, DetailsProperty>;
}

/** The 8 hex characters after `auth_`: visibly the start of the escalation ID the operator and the agent see. */
export function referenceCode(escalationId: string): string {
  return escalationId.replace(/^auth_/, "").replace(/-/g, "").slice(0, REFERENCE_CODE_LENGTH);
}

/** Lowercase hex SHA-256 of the canonical JSON of the requirement exactly as offered. */
export function requirementDigest(req: PaymentRequirements): string {
  return createHash("sha256").update(canonicalJSON(req), "utf8").digest("hex");
}

const cap = (s: string) => (s.length > VALUE_MAX ? `${s.slice(0, VALUE_MAX - 3)}...` : s);

export interface PaymentDetailsInput {
  escalationId: string;
  requestId: string;
  resourceKey: string;
  payTo: string;
  amount: string;
  asset: string;
  network: string;
  requirement: PaymentRequirements;
  decimals: number;
}

/** The single authorization_details object, in Auth0's Guardian schema, with 10 properties. */
export function paymentDetails(p: PaymentDetailsInput): PaymentDetailsObject[] {
  const rows: [key: string, display: boolean, name: string, value: string][] = [
    ["amount_usdc", true, "Amount (USDC)", formatAtomic(p.amount, p.decimals)],
    ["pay_to", true, "Payee", p.payTo],
    ["resource", true, "Resource", p.resourceKey],
    ["network", true, "Network", p.network],
    ["reference", true, "Reference", referenceCode(p.escalationId)],
    ["escalation_id", false, "Escalation", p.escalationId],
    ["request_id", false, "Request", p.requestId],
    ["amount_atomic", false, "Amount (atomic)", p.amount],
    ["asset", false, "Asset", p.asset],
    ["requirement_sha256", false, "Requirement digest", requirementDigest(p.requirement)],
  ];
  const properties: Record<string, DetailsProperty> = {};
  rows.forEach(([key, display, name, value], i) => {
    properties[key] = { display, name, display_order: i + 1, value: cap(String(value)) };
  });
  return [{ type: DETAILS_TYPE, instruction: DETAILS_INSTRUCTION, properties }];
}

export interface BindingMessageInput {
  amount: string;
  decimals: number;
  payTo: string;
  resourceKey: string;
  escalationId: string;
}

/** `Pay_<usdc>_USDC_to_<payee short>[_for_<segment>]_#<ref>`, at most 64 characters from Auth0's set. */
export function bindingMessage(p: BindingMessageInput): string {
  const payee = p.payTo.length > 12 ? `${p.payTo.slice(0, 6)}..${p.payTo.slice(-4)}` : p.payTo;
  const head = `Pay_${formatAtomic(p.amount, p.decimals)}_USDC_to_${payee}`;
  const tail = `_#${referenceCode(p.escalationId)}`;
  let segment = "";
  try {
    const parts = new URL(p.resourceKey).pathname.split("/").filter((s) => s.length > 0);
    segment = (parts[parts.length - 1] ?? "").replace(/[^A-Za-z0-9+\-_.,:#]/g, "-");
  } catch {
    segment = "";
  }
  const room = BINDING_MESSAGE_MAX - head.length - tail.length - "_for_".length;
  segment = room > 0 ? segment.slice(0, room) : "";
  const message = segment.length > 0 ? `${head}_for_${segment}${tail}` : `${head}${tail}`;
  if (message.length > BINDING_MESSAGE_MAX || !MESSAGE_CHARS.test(message)) {
    throw new Error(`binding message does not fit Auth0's limits (${message.length} characters)`);
  }
  return message;
}

/** min(300, whole seconds left in the escalation's window). */
export function requestedExpirySeconds(escalationExpiresAtMs: number, nowMs: number): number {
  return Math.min(MAX_REQUESTED_EXPIRY_S, Math.floor((escalationExpiresAtMs - nowMs) / 1000));
}

/** Field-for-field equality, by canonical JSON (FR-022). */
export function detailsEqual(a: unknown, b: unknown): boolean {
  return canonicalJSON(a) === canonicalJSON(b);
}
