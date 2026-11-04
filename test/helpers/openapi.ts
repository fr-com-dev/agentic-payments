// OpenAPI document helpers for T-API-01..08 (test/openapi.test.ts for L2, test/openapi-hosted.test.ts for the
// hosted agent): operations and routes, a JSON Schema subset checker, and a small HTTP client.
import { readFileSync } from "node:fs";
import type { Express } from "express";
import { parse } from "yaml";

export const METHODS = ["get", "post", "put", "patch", "delete"] as const;

export type Schema = {
  $ref?: string;
  /** One type, or a list (OpenAPI 3.1, e.g. `[string, "null"]`). */
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  oneOf?: Schema[];
};
export type Response = { $ref?: string; headers?: Record<string, unknown>; content?: Record<string, { schema: Schema }> };
export type Operation = {
  tags?: string[];
  security?: Record<string, string[]>[];
  parameters?: { name: string; schema: Schema }[];
  responses: Record<string, Response>;
};
export type OpenApiDoc = {
  paths: Record<string, Partial<Record<(typeof METHODS)[number], Operation>>>;
  components: { schemas: Record<string, Schema>; responses: Record<string, Response> };
};

export const loadDoc = (file: string) => parse(readFileSync(file, "utf8")) as OpenApiDoc;

/** Every operation as [method, document path, operation]. */
export function operations(doc: OpenApiDoc): [string, string, Operation][] {
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    METHODS.filter((m) => item[m] !== undefined).map((m): [string, string, Operation] => [m.toUpperCase(), path, item[m]!]),
  );
}

/** `/v1/approvals/{authorizationId}` → `/v1/approvals/:authorizationId` (Express form). */
export const expressPath = (path: string) => path.replace(/\{(\w+)\}/g, ":$1");

export function documentedRoutes(doc: OpenApiDoc, filter: (op: Operation) => boolean = () => true): string[] {
  return operations(doc)
    .filter(([, , op]) => filter(op))
    .map(([m, p]) => `${m} ${expressPath(p)}`)
    .sort();
}

/** The Swagger UI operations, mounted only with API_DOCS=1. */
export const isDocsRoute = (op: Operation) => op.tags?.includes("docs") === true;

export function mountedRoutes(app: Express): string[] {
  const { stack } = app.router as unknown as { stack: { route?: { path: string; methods: Record<string, boolean> } }[] };
  return stack
    .flatMap((l) => (l.route ? Object.keys(l.route.methods).map((m) => `${m.toUpperCase()} ${l.route!.path}`) : []))
    .sort();
}

export function routeDiff(documented: string[], mounted: string[]) {
  return {
    undocumented: mounted.filter((r) => !documented.includes(r)),
    unmounted: documented.filter((r) => !mounted.includes(r)),
  };
}

export const resolve = <T>(doc: OpenApiDoc, ref: string): T => {
  const [, section, name] = ref.match(/^#\/components\/(schemas|responses)\/(\w+)$/) ?? [];
  const found = section === "schemas" ? doc.components.schemas[name!] : section === "responses" ? doc.components.responses[name!] : undefined;
  if (found === undefined) throw new Error(`unresolved $ref ${ref}`);
  return found as T;
};

/**
 * Checks `value` against the subset of JSON Schema the documents use ($ref, oneOf, const, enum, type or a list of
 * types, pattern, minLength, maxLength, properties, required, additionalProperties, items). One message per violation.
 */
export function conformance(doc: OpenApiDoc, schema: Schema, value: unknown, at = "$"): string[] {
  if (schema.$ref) return conformance(doc, resolve<Schema>(doc, schema.$ref), value, at);
  if (schema.oneOf) {
    const n = schema.oneOf.filter((s) => conformance(doc, s, value, at).length === 0).length;
    return n === 1 ? [] : [`${at}: matches ${n} oneOf branches`];
  }
  if ("const" in schema && value !== schema.const) return [`${at}: expected ${JSON.stringify(schema.const)}`];
  if (schema.enum && !schema.enum.includes(value)) return [`${at}: ${JSON.stringify(value)} not in enum`];
  const isObject = value !== null && typeof value === "object" && !Array.isArray(value);
  const typeOk: Record<string, boolean> = {
    object: isObject,
    array: Array.isArray(value),
    string: typeof value === "string",
    integer: Number.isInteger(value),
    number: typeof value === "number",
    boolean: typeof value === "boolean",
    null: value === null,
  };
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk[t])) return [`${at}: expected ${types.join(" or ")}`];
  }
  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return [`${at}: does not match ${schema.pattern}`];
    if (schema.minLength !== undefined && value.length < schema.minLength) return [`${at}: shorter than ${schema.minLength}`];
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return [`${at}: longer than ${schema.maxLength}`];
  }
  const errors: string[] = [];
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errors.push(...conformance(doc, schema.items!, v, `${at}[${i}]`)));
  if (isObject) {
    const obj = value as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in obj)) errors.push(`${at}.${k}: missing`);
    for (const [k, v] of Object.entries(obj)) {
      const prop = schema.properties?.[k];
      if (prop) errors.push(...conformance(doc, prop, v, `${at}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${at}.${k}: not documented`);
      else if (typeof schema.additionalProperties === "object") errors.push(...conformance(doc, schema.additionalProperties, v, `${at}.${k}`));
    }
  }
  return errors;
}

/** The documented response for one (operation, status), with its $ref resolved, or undefined when not documented. */
export function documentedResponse(doc: OpenApiDoc, method: string, path: string, status: number): Response | undefined {
  const op = doc.paths[path]?.[method.toLowerCase() as (typeof METHODS)[number]];
  const res = op?.responses[String(status)];
  if (!res) return undefined;
  return res.$ref ? resolve<Response>(doc, res.$ref) : res;
}

/** The documented content (media type → schema) for one (operation, status), or undefined when the status is not documented. */
export function responseContent(doc: OpenApiDoc, method: string, path: string, status: number): Response["content"] | undefined {
  const res = documentedResponse(doc, method, path, status);
  return res === undefined ? undefined : (res.content ?? {});
}

/** `body` is the parsed JSON (empty for other media types); `text` is the raw body; `type` has no parameters. */
export async function send(base: string, method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(token !== undefined && { authorization: `Bearer ${token}` }) },
    ...(method !== "GET" && { body: typeof body === "string" ? body : JSON.stringify(body ?? {}) }),
  });
  const text = await res.text();
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
  const json = type === "application/json" ? (JSON.parse(text) as Record<string, unknown>) : {};
  return { status: res.status, type, text, body: json, headers: res.headers };
}
