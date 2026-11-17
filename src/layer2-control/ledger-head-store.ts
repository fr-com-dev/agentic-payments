// 1.23 (SPEC.md §8.2 L2-4, CFG-2, SEC-39): where L2 keeps the ledger's head (ledger-head.ts).
// - `https://<account>.blob.<suffix>/<container>`: one blob in Azure Blob Storage, written with the managed identity
//   whose client ID is LEDGER_HEAD_CLIENT_ID (in Azure, L2's head identity, the only principal with a data role on
//   that container: T-IAC-01 rule 25). Tokens come from the Container Apps identity endpoint (IDENTITY_ENDPOINT,
//   IDENTITY_HEADER) over plain fetch, so L2's image takes no new package. Writes are conditional on the ETag L2 last
//   saw (If-Match, or If-None-Match: * for the first), so a replaced L2 can never move the head back.
// - `file:///<directory>`: a file in a local directory, for local runs. It has none of the blob's protection: the
//   directory is as writable as the ledger's.
// Unset: no head (as before 1.23). Neither store ever logs or returns a token.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError } from "../shared/config.js";
import type { HeadStore, LedgerHead } from "./ledger-head.js";

export const HEAD_URL_ENV = "LEDGER_HEAD_URL";
export const HEAD_CLIENT_ENV = "LEDGER_HEAD_CLIENT_ID";
/** The blob service version: bearer tokens need 2017-11-09 or later. */
export const BLOB_API_VERSION = "2023-11-03";
export const STORAGE_RESOURCE = "https://storage.azure.com/";
/** Each request to the identity endpoint or the blob service; a head write runs inside the serialized section. */
export const HEAD_TIMEOUT_MS = 5_000;
/** A head is about 200 bytes; anything much larger is not one. */
const MAX_HEAD_BYTES = 4_096;
const CLIENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Env = Record<string, string | undefined>;

/** The head's name beside a ledger file: `ledger-<network>.jsonl` → `ledger-<network>.head.json`. */
export function headNameFor(ledgerPath: string): string {
  return basename(ledgerPath).replace(/\.jsonl$/, "") + ".head.json";
}

/** Local runs: the head as a file, replaced by write-then-rename; the compare-and-swap is on the file's digest. */
export class FileHeadStore implements HeadStore {
  private seen: string | null | undefined;

  constructor(readonly filePath: string) {}

  get where(): string {
    return this.filePath;
  }

  private current(): { text: string; digest: string } | null {
    if (!existsSync(this.filePath)) return null;
    const text = readFileSync(this.filePath, "utf8");
    return { text, digest: createHash("sha256").update(text, "utf8").digest("hex") };
  }

  async read(): Promise<unknown> {
    const cur = this.current();
    this.seen = cur?.digest ?? null;
    if (cur === null) return undefined;
    try {
      return JSON.parse(cur.text) as unknown;
    } catch {
      return null;
    }
  }

  async write(head: LedgerHead): Promise<void> {
    if (this.seen === undefined) throw new Error("the head was not read first");
    if ((this.current()?.digest ?? null) !== this.seen) throw new Error("the ledger head was changed by another writer");
    const text = JSON.stringify(head) + "\n";
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, this.filePath);
    this.seen = createHash("sha256").update(text, "utf8").digest("hex");
  }
}

export interface BlobHeadStoreOptions {
  /** `https://<account>.blob.<suffix>/<container>`, no query. */
  containerUrl: string;
  blobName: string;
  /** The user-assigned identity's client ID. */
  clientId: string;
  /** IDENTITY_ENDPOINT and IDENTITY_HEADER, which Container Apps sets in a container that may use an identity. */
  identityEndpoint: string;
  identityHeader: string;
  /** Test hooks. */
  fetch?: typeof fetch;
  now?: () => number;
}

/** Azure: one blob, read and written with the head identity's token. */
export class BlobHeadStore implements HeadStore {
  private etag: string | null | undefined;
  private token: { value: string; refreshAtMs: number } | undefined;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly blobUrl: string;

  constructor(private readonly o: BlobHeadStoreOptions) {
    this.fetch = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
    this.blobUrl = `${o.containerUrl.replace(/\/+$/, "")}/${encodeURIComponent(o.blobName)}`;
  }

  get where(): string {
    return this.blobUrl;
  }

  /** A storage token for the head identity, kept until five minutes before it expires. */
  private async bearer(): Promise<string> {
    if (this.token !== undefined && this.now() < this.token.refreshAtMs) return this.token.value;
    const u = new URL(this.o.identityEndpoint);
    u.searchParams.set("resource", STORAGE_RESOURCE);
    u.searchParams.set("api-version", "2019-08-01");
    u.searchParams.set("client_id", this.o.clientId);
    let res: Response;
    try {
      res = await this.fetch(u, { headers: { "x-identity-header": this.o.identityHeader }, redirect: "error", signal: AbortSignal.timeout(HEAD_TIMEOUT_MS) });
    } catch {
      throw new Error("the managed identity endpoint is unreachable");
    }
    if (res.status !== 200) throw new Error(`the managed identity endpoint answered HTTP ${res.status}`);
    const body = (await res.json().catch(() => null)) as { access_token?: unknown; expires_on?: unknown } | null;
    const expiresOnMs = Number(body?.expires_on) * 1000;
    if (typeof body?.access_token !== "string" || body.access_token === "" || !Number.isFinite(expiresOnMs)) {
      throw new Error("the managed identity endpoint gave no usable token");
    }
    this.token = { value: body.access_token, refreshAtMs: expiresOnMs - 300_000 };
    return this.token.value;
  }

  private async request(method: "GET" | "PUT", headers: Record<string, string>, body?: string): Promise<Response> {
    const token = await this.bearer();
    try {
      return await this.fetch(this.blobUrl, {
        method,
        headers: { authorization: `Bearer ${token}`, "x-ms-version": BLOB_API_VERSION, "x-ms-date": new Date(this.now()).toUTCString(), ...headers },
        ...(body !== undefined && { body }),
        redirect: "error",
        signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
      });
    } catch {
      throw new Error("the head's blob service is unreachable");
    }
  }

  async read(): Promise<unknown> {
    const res = await this.request("GET", {});
    if (res.status === 404 && res.headers.get("x-ms-error-code") === "BlobNotFound") {
      this.etag = null;
      return undefined;
    }
    if (res.status !== 200) throw new Error(`reading the head answered HTTP ${res.status}${errorCode(res)}`);
    const text = await res.text();
    const etag = res.headers.get("etag");
    if (etag === null) throw new Error("the head's blob has no ETag");
    this.etag = etag;
    if (Buffer.byteLength(text, "utf8") > MAX_HEAD_BYTES) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }

  async write(head: LedgerHead): Promise<void> {
    if (this.etag === undefined) throw new Error("the head was not read first");
    const condition: Record<string, string> = this.etag === null ? { "if-none-match": "*" } : { "if-match": this.etag };
    const res = await this.request("PUT", { "x-ms-blob-type": "BlockBlob", "content-type": "application/json", ...condition }, JSON.stringify(head) + "\n");
    if (res.status === 412 || (res.status === 409 && this.etag === null)) throw new Error("the ledger head was changed by another writer");
    if (res.status !== 201) throw new Error(`writing the head answered HTTP ${res.status}${errorCode(res)}`);
    const etag = res.headers.get("etag");
    if (etag === null) throw new Error("the head's blob has no ETag");
    this.etag = etag;
  }
}

/** Azure Storage's error code, which names the problem (AuthorizationPermissionMismatch, ContainerNotFound) and nothing secret. */
function errorCode(res: Response): string {
  const code = res.headers.get("x-ms-error-code");
  return code !== null && /^[A-Za-z]{1,64}$/.test(code) ? ` (${code})` : "";
}

/**
 * LEDGER_HEAD_URL (CFG-2): unset or empty is no head; `https://…/<container>` is the blob store, and then
 * LEDGER_HEAD_CLIENT_ID is required; `file:///<directory>` is the file store. Checked before the ledger lock, with
 * the rest of L2's settings. An error names the variable, never a value it doesn't own.
 */
export function ledgerHeadStoreFromEnv(env: Env, ledgerPath: string, deps: Pick<BlobHeadStoreOptions, "fetch" | "now"> = {}): HeadStore | undefined {
  const raw = env[HEAD_URL_ENV];
  if (raw === undefined || raw === "") {
    if (env[HEAD_CLIENT_ENV] !== undefined && env[HEAD_CLIENT_ENV] !== "") throw new ConfigError(`${HEAD_CLIENT_ENV} is set but ${HEAD_URL_ENV} is not`);
    return undefined;
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError(`${HEAD_URL_ENV} must be https://<account>.blob.<suffix>/<container> or file:///<directory>`);
  }
  const name = headNameFor(ledgerPath);
  if (u.protocol === "file:" && u.search === "" && u.hash === "") return new FileHeadStore(join(fileURLToPath(u), name));
  const segments = u.pathname.split("/").filter((s) => s !== "");
  if (u.protocol !== "https:" || u.search !== "" || u.hash !== "" || u.username !== "" || u.password !== "" || !u.hostname.includes(".blob.") || segments.length !== 1) {
    throw new ConfigError(`${HEAD_URL_ENV} must be https://<account>.blob.<suffix>/<container> or file:///<directory>`);
  }
  const clientId = env[HEAD_CLIENT_ENV] ?? "";
  if (!CLIENT_ID_RE.test(clientId)) throw new ConfigError(`${HEAD_CLIENT_ENV} must be the client ID of the identity that writes the ledger head`);
  const identityEndpoint = env.IDENTITY_ENDPOINT ?? "";
  const identityHeader = env.IDENTITY_HEADER ?? "";
  if (identityEndpoint === "" || identityHeader === "") {
    throw new ConfigError(`${HEAD_URL_ENV} needs a managed identity in the container (IDENTITY_ENDPOINT and IDENTITY_HEADER are not set)`);
  }
  return new BlobHeadStore({ containerUrl: `${u.origin}/${segments[0]}`, blobName: name, clientId, identityEndpoint, identityHeader, ...deps });
}
