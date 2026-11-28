// 021 (SPEC §15 EXT-10, L1-6; specs/021 contracts/discovery-index.md): the one client of the public x402 discovery
// index (Coinbase's Bazaar). Rule A19 keeps the index's path in this file and lets only ./agent.ts import it.
// What the index returns is text written by strangers (SEC-60): a listing becomes a result only through `toResults`,
// which keeps fixed fields and drops the rest, and the index's own text (an error body, a status line, a library
// message) never leaves this file (SEC-64). The request carries the cut query and the network filters only: no
// token, user, session, run or goal (NFR-002, SEC-61).
import { z } from "zod";
import { CDP_FACILITATOR_URL, formatAtomic } from "../../shared/config.js";

/**
 * A search gives up after this long (FR-009). It is also what all the searches of one run may take together (NFR-004):
 * the run hands each search what is left (./agent.ts), so a slow or unreachable index adds at most 5 s to a run.
 */
export const SEARCH_TIMEOUT_MS = 5_000;
/** The largest answer read; a longer body is a failed search. */
export const MAX_ANSWER_BYTES = 256 * 1024;
/** The query is cut to this many characters before it is sent or recorded (FR-008). */
export const QUERY_MAX_CHARS = 200;
/** Results the model sees per search (FR-006). */
export const MAX_RESULTS = 10;
/** Listings read from one answer; the rest are ignored. */
const MAX_LISTINGS_READ = 50;
/** Listings asked for (`limit`). */
const ASK_LIMIT = 20;
const ABOUT_MAX_CHARS = 300;
const MAX_INPUTS = 8;
const URL_MAX_CHARS = 2_048;
const AMOUNT_RE = /^[1-9][0-9]{0,30}$/;
const INPUT_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const INPUT_TYPES = ["string", "number", "integer", "boolean"] as const;
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type InputType = (typeof INPUT_TYPES)[number];

/** The network a search filters by: the deployment's profile. */
export interface SearchNetwork {
  name: string;
  caip2: string;
  asset: string;
  decimals: number;
}

/** What the model sees of one listing (FR-007, data-model.md "Search result"): these fields and nothing else. */
export interface SearchResult {
  url: string;
  host: string;
  priceAtomic: string;
  priceUsd: string;
  network: string;
  about: string;
  inputs: { name: string; type: InputType; required: boolean }[];
  onSellerList: boolean;
}

export interface SearchOutput {
  outcome: "OK" | "UNAVAILABLE" | "LIMIT_REACHED";
  results: SearchResult[];
}

export const UNAVAILABLE: SearchOutput = Object.freeze({ outcome: "UNAVAILABLE", results: [] }) as SearchOutput;
export const LIMIT_REACHED: SearchOutput = Object.freeze({ outcome: "LIMIT_REACHED", results: [] }) as SearchOutput;

/** The index's address when `DISCOVERY_URL` is absent: the public one on Base Sepolia; the local chain has none. */
export function defaultDiscoveryUrl(network: string): string | undefined {
  return network === "base-sepolia" ? `${CDP_FACILITATOR_URL}/discovery/search` : undefined;
}

/** The query as it is sent and recorded: its first 200 characters (code points, so no character is split). */
export const cutQuery = (query: string): string => Array.from(query).slice(0, QUERY_MAX_CHARS).join("");

// The answer's top level. Unknown keys (x402Version, searchMethod, partialResults, meta, …) are ignored.
const AnswerSchema = z.object({ resources: z.array(z.unknown()) });

/** Reads at most `cap` bytes of a body; null when it is longer. */
async function readCapped(res: Response, cap: number): Promise<string | null> {
  const declared = res.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && BigInt(declared) > BigInt(cap)) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface SearchIndexOptions {
  /** The index's search address (`DISCOVERY_URL`, or `defaultDiscoveryUrl`). */
  url: string;
  query: string;
  network: SearchNetwork;
  fetchImpl?: typeof fetch;
  /** How long this call may take, at most SEARCH_TIMEOUT_MS: the run's search time that is left. Default: 5 s. */
  timeoutMs?: number;
  /** Test hook (T-AGT-23 must-fail): no 5 s bound on the call. Never set by the entry point. */
  skipSearchTimeout?: boolean;
}

/**
 * One call to the index. Any failure (a network error, a redirect, the timeout, a status other than 200, a body over
 * 256 KB, a body that is not JSON, a top level the schema refuses) is `null`: the caller answers the fixed
 * UNAVAILABLE, and no text of the index's leaves this function.
 */
export async function searchIndex(o: SearchIndexOptions): Promise<unknown[] | null> {
  const timeoutMs = Math.min(o.timeoutMs ?? SEARCH_TIMEOUT_MS, SEARCH_TIMEOUT_MS);
  if (!o.skipSearchTimeout && !(timeoutMs > 0)) return null;
  try {
    const u = new URL(o.url);
    u.searchParams.set("query", cutQuery(o.query));
    u.searchParams.set("network", o.network.caip2);
    u.searchParams.set("scheme", "exact");
    u.searchParams.set("limit", String(ASK_LIMIT));
    const res = await (o.fetchImpl ?? fetch)(u, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      ...(!o.skipSearchTimeout && { signal: AbortSignal.timeout(Math.ceil(timeoutMs)) }),
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const text = await readCapped(res, MAX_ANSWER_BYTES);
    if (text === null) return null;
    const parsed = AnswerSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.resources.slice(0, MAX_LISTINGS_READ) : null;
  } catch {
    return null;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The listing's address, when it is one the agent could fetch on this network; else null. */
function resourceUrl(resource: unknown, network: SearchNetwork): URL | null {
  if (typeof resource !== "string" || resource.length > URL_MAX_CHARS) return null;
  let u: URL;
  try {
    u = new URL(resource);
  } catch {
    return null;
  }
  if (u.username !== "" || u.password !== "") return null;
  if (u.protocol === "https:") return u;
  if (u.protocol === "http:" && network.name === "local" && LOOPBACK_HOSTNAMES.has(u.hostname)) return u;
  return null;
}

/** The first payment option in the deployment's network, `exact` scheme and asset, with a well-formed amount. */
function priceOf(accepts: unknown, network: SearchNetwork): string | null {
  if (!Array.isArray(accepts)) return null;
  for (const a of accepts) {
    if (!isRecord(a)) continue;
    if (a.scheme !== "exact" || a.network !== network.caip2) continue;
    if (typeof a.asset !== "string" || a.asset.toLowerCase() !== network.asset.toLowerCase()) continue;
    if (typeof a.amount !== "string" || !AMOUNT_RE.test(a.amount)) continue;
    return a.amount;
  }
  return null;
}

/** Plain text: whitespace collapsed, control and format characters removed, at most 300 characters. */
export function aboutOf(description: unknown): string {
  if (typeof description !== "string") return "";
  const plain = description
    .replace(/\s+/gu, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/ {2,}/g, " ")
    .trim();
  return Array.from(plain).slice(0, ABOUT_MAX_CHARS).join("").trim();
}

/** The declared inputs: names, types and whether each is required. Anything malformed gives []. */
export function inputsOf(extensions: unknown): SearchResult["inputs"] {
  try {
    if (!isRecord(extensions) || !isRecord(extensions.bazaar)) return [];
    const schema = extensions.bazaar.schema;
    if (!isRecord(schema) || !isRecord(schema.properties) || !isRecord(schema.properties.input)) return [];
    const params = schema.properties.input.properties;
    if (params === undefined) return [];
    if (!isRecord(params)) return [];
    const out: SearchResult["inputs"] = [];
    for (const group of [params.queryParams, params.pathParams]) {
      if (group === undefined) continue;
      if (!isRecord(group)) return [];
      const props = group.properties;
      if (props === undefined) continue;
      if (!isRecord(props)) return [];
      const required = Array.isArray(group.required) ? group.required.filter((r): r is string => typeof r === "string") : [];
      for (const [name, prop] of Object.entries(props)) {
        if (out.length >= MAX_INPUTS) return out;
        if (!INPUT_NAME_RE.test(name)) continue;
        const declared = isRecord(prop) ? prop.type : undefined;
        const type = (INPUT_TYPES as readonly unknown[]).includes(declared) ? (declared as InputType) : "string";
        out.push({ name, type, required: required.includes(name) });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export interface ToResultsOptions {
  /** Test hook (T-DISC-02 must-fail): the listings pass through unfiltered. Never set by the entry point. */
  rawListings?: boolean;
  /** Test hook (T-AGT-22 must-fail): every result counts as on the seller list. Never set by the entry point. */
  skipSellerList?: boolean;
}

/**
 * The fixed view of the listings (contracts/discovery-index.md "Reading the answer"): only listings in the
 * deployment's network, the `exact` scheme and its asset, with an address the agent could fetch; deduplicated by
 * address; results on the seller list first, then the rest, each group in the index's order; at most 10.
 */
export function toResults(listings: readonly unknown[], network: SearchNetwork, sellerHosts: readonly string[], o: ToResultsOptions = {}): SearchResult[] {
  if (o.rawListings) return listings.slice(0, MAX_RESULTS) as SearchResult[];
  const kept: SearchResult[] = [];
  const seen = new Set<string>();
  for (const l of listings) {
    if (!isRecord(l)) continue;
    // FR-006: x402 v2 HTTP resources only. A listing that says it is another version, or another kind (an MCP tool),
    // is dropped; one that says neither is judged by its address and payment options alone.
    if (l.x402Version !== undefined && l.x402Version !== 2) continue;
    if (l.type !== undefined && l.type !== "http") continue;
    const u = resourceUrl(l.resource, network);
    if (u === null) continue;
    const priceAtomic = priceOf(l.accepts, network);
    if (priceAtomic === null) continue;
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    kept.push({
      url: u.href,
      host: u.host,
      priceAtomic,
      priceUsd: formatAtomic(priceAtomic, network.decimals),
      network: network.caip2,
      about: aboutOf(l.description),
      inputs: inputsOf(l.extensions),
      onSellerList: o.skipSellerList === true || sellerHosts.includes(u.host),
    });
  }
  return [...kept.filter((r) => r.onSellerList), ...kept.filter((r) => !r.onSellerList)].slice(0, MAX_RESULTS);
}

export interface SearchResourcesOptions extends SearchIndexOptions, ToResultsOptions {
  sellerHosts: readonly string[];
}

/** One search as the tool answers it: OK with the results, or the fixed UNAVAILABLE. */
export async function searchResources(o: SearchResourcesOptions): Promise<SearchOutput> {
  const listings = await searchIndex(o);
  if (listings === null) return { ...UNAVAILABLE, results: [] };
  return { outcome: "OK", results: toResults(listings, o.network, o.sellerHosts, o) };
}
