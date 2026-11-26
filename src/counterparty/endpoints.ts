// Seller endpoints declared with TC39 decorators (SPEC.md CP-1, v1.7). A controller class declares each endpoint
// once, on its handler method: its route (@Get, here) and its monetization tier (@Free, @PayPerUse, @Premium or
// @Enterprise, ./monetization.ts). The seller derives everything else from that one declaration: the Express
// routes, the x402 payment requirements and the catalog, so a route, its price and its catalog entry can't drift.
// tsc and tsx lower the decorators (Node can't run them natively yet); vitest.config.ts lowers them for tests.
import type { Express, Request } from "express";
import type { Monetization } from "./monetization.js";

/** 021: the type of a query input, as JSON Schema names it. */
export type InputType = "string" | "number" | "integer" | "boolean";
export const INPUT_TYPES: readonly InputType[] = ["string", "number", "integer", "boolean"];

/**
 * 021 (CP-1): one query input an endpoint reads, declared with its route. The catalog shows its name, type and whether
 * it is required; the payment challenge's discovery declaration also carries `about` and `example`.
 */
export interface QueryInput {
  name: string;
  type: InputType;
  required: boolean;
  /** Plain text, 1–200 characters. */
  about: string;
  /** A value of `type`. The seller's own answer to the examples is the declaration's example output. */
  example: string | number | boolean;
}

/** How `@Get` takes an input: everything but the name, which is its key. */
export type QueryInputDeclaration = Omit<QueryInput, "name" | "required"> & { required?: boolean };

/** Where an endpoint answers. `query` names the query parameters it reads; the catalog shows them. */
export interface Route {
  method: "GET";
  path: string;
  query: readonly string[];
  /** 021: the same inputs, typed, in declaration order. */
  inputs: readonly QueryInput[];
}

/** A declared endpoint: the handler returns the JSON body. */
export interface Endpoint {
  name: string;
  route: Route;
  monetization: Monetization;
  handler: (req: Request) => unknown;
}

/** A controller or decorator mistake: thrown while the seller is built, never while it serves. */
export class EndpointDeclarationError extends Error {
  override name = "EndpointDeclarationError";
}

type Method = (this: unknown, ...args: never[]) => unknown;
type Declaration = { name: string; route?: Route; monetization?: Monetization };

/** What the decorators recorded, keyed by the handler they decorate. */
const declarations = new WeakMap<object, Declaration>();

/**
 * Records one part of an endpoint's declaration. Each part may be given once: a second route or a second tier on the
 * same handler is an error. Only public instance methods can be endpoints.
 */
export function declarePart(method: Method, context: ClassMethodDecoratorContext, part: Pick<Declaration, "route" | "monetization">): void {
  const name = String(context.name);
  if (context.static || context.private) throw new EndpointDeclarationError(`${name}: an endpoint must be a public instance method`);
  const declaration = declarations.get(method) ?? { name };
  if (part.route && declaration.route) throw new EndpointDeclarationError(`${name}: has two routes`);
  if (part.monetization && declaration.monetization) throw new EndpointDeclarationError(`${name}: has two monetization tiers`);
  declarations.set(method, { ...declaration, ...part });
}

const INPUT_NAME_RE = /^[a-z][a-zA-Z0-9]{0,39}$/;
const INPUT_ABOUT_MAX = 200;

const exampleFits = (type: InputType, v: unknown): boolean =>
  type === "string" ? typeof v === "string" : type === "boolean" ? typeof v === "boolean" : type === "integer" ? Number.isInteger(v) : typeof v === "number" && Number.isFinite(v);

/** 021: checks one declared input; a mistake is refused while the seller is built. */
function queryInput(at: string, name: string, d: QueryInputDeclaration): QueryInput {
  if (!INPUT_NAME_RE.test(name)) throw new EndpointDeclarationError(`${at}: the input name "${name}" must match ${INPUT_NAME_RE.source}`);
  if (!INPUT_TYPES.includes(d.type)) throw new EndpointDeclarationError(`${at}: input ${name} has type "${String(d.type)}"; one of ${INPUT_TYPES.join(", ")}`);
  if (typeof d.about !== "string" || d.about.trim() === "" || d.about.length > INPUT_ABOUT_MAX) {
    throw new EndpointDeclarationError(`${at}: input ${name} needs an about of 1–${INPUT_ABOUT_MAX} characters`);
  }
  if (!exampleFits(d.type, d.example)) throw new EndpointDeclarationError(`${at}: input ${name}'s example is not a ${d.type}`);
  return { name, type: d.type, required: d.required === true, about: d.about, example: d.example };
}

/**
 * `@Get("/api/weather", { query: { city: { type: "string", required: true, about: "…", example: "Lima" } } })`: the
 * endpoint answers GET on `path` and reads those query inputs (021: typed, each with a description and an example).
 */
export function Get(path: string, options: { query?: Readonly<Record<string, QueryInputDeclaration>> } = {}) {
  if (!/^\/[A-Za-z0-9/_-]*$/.test(path)) throw new EndpointDeclarationError(`@Get("${path}"): a path starts with / and has no query or pattern`);
  const inputs = Object.entries(options.query ?? {}).map(([name, d]) => queryInput(`@Get("${path}")`, name, d));
  return <T extends Method>(method: T, context: ClassMethodDecoratorContext): T => {
    declarePart(method, context, { route: { method: "GET", path, query: inputs.map((i) => i.name), inputs } });
    return method;
  };
}

/**
 * Every endpoint `controller` declares, in declaration order. Fails when a decorated method lacks its route or its
 * tier, or when two endpoints share a route. Undecorated methods are helpers, not endpoints.
 */
export function declaredEndpoints(controller: abstract new (...args: never[]) => object): Endpoint[] {
  const proto = controller.prototype as Record<string, unknown>;
  const endpoints: Endpoint[] = [];
  for (const key of Object.getOwnPropertyNames(proto)) {
    const method = key === "constructor" ? undefined : proto[key];
    const declaration = typeof method === "function" ? declarations.get(method) : undefined;
    if (declaration === undefined) continue;
    if (!declaration.route) throw new EndpointDeclarationError(`${declaration.name}: has a monetization tier but no route (@Get)`);
    if (!declaration.monetization) {
      throw new EndpointDeclarationError(`${declaration.name}: GET ${declaration.route.path} has no monetization tier (@Free, @PayPerUse, @Premium or @Enterprise)`);
    }
    endpoints.push({ name: declaration.name, route: declaration.route, monetization: declaration.monetization, handler: method as Endpoint["handler"] });
  }
  const seen = new Set<string>();
  for (const e of endpoints) {
    const key = `${e.route.method} ${e.route.path}`;
    if (seen.has(key)) throw new EndpointDeclarationError(`${key}: declared by two endpoints`);
    seen.add(key);
  }
  return endpoints;
}

/** The path a client calls, with the query parameters the endpoint reads: `/api/weather?city=`. */
export const advertisedPath = (route: Route): string =>
  route.query.length === 0 ? route.path : `${route.path}?${route.query.map((q) => `${q}=`).join("&")}`;

/** Mounts each endpoint's handler on `app`, called on `instance`; its return value is the JSON body. */
export function mountEndpoints(app: Express, instance: object, endpoints: readonly Endpoint[]): void {
  for (const e of endpoints) {
    app.get(e.route.path, async (req, res, next) => {
      try {
        res.json(await e.handler.call(instance, req));
      } catch (err) {
        next(err);
      }
    });
  }
}
