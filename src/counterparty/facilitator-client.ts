// Facilitator client selection and failure categories (SPEC v1.2 CP-1, CP-3; specs/009 research R4).
// Holds no credentials: a CDP client is built by cdp-facilitator.ts and passed in.
import {
  FacilitatorCapabilityError,
  FacilitatorResponseError,
  FacilitatorTimeoutError,
  HTTPFacilitatorClient,
  RouteConfigurationError,
  type FacilitatorClient,
} from "@x402/core/server";
import { SettleError, VerifyError } from "@x402/core/types";
import type { FacilitatorChoice } from "../shared/config.js";

export type FailureCategory = "unavailable" | "authentication" | "rate-limited" | "unsupported";
export type FacilitatorOperation = "supported" | "verify" | "settle";
export type FailureHook = (category: FailureCategory, operation: FacilitatorOperation, err: unknown) => void;

/**
 * A FacilitatorResponseError, so @x402/express answers 502 `{error: message}` during a paid retry.
 * The message carries only the category; the upstream error stays in `cause` for redacted logging.
 */
export class FacilitatorUnavailableError extends FacilitatorResponseError {
  override name = "FacilitatorUnavailableError";
  readonly category: FailureCategory;
  readonly operation: FacilitatorOperation;

  constructor(category: FailureCategory, operation: FacilitatorOperation, cause?: unknown) {
    super(`facilitator ${category}`);
    this.category = category;
    this.operation = operation;
    if (cause !== undefined) this.cause = cause;
  }
}

const STATUS = /failed \((\d{3})\)/;
const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]);

/** Research R4. Walks the `cause` chain; the status comes from the pinned SDK's "failed (<status>)" message. */
export function categorize(err: unknown): FailureCategory {
  let current: unknown = err;
  for (let depth = 0; depth < 10 && current !== null && current !== undefined; depth++) {
    if (current instanceof FacilitatorUnavailableError) return current.category;
    if (current instanceof RouteConfigurationError || current instanceof FacilitatorCapabilityError) return "unsupported";
    if (current instanceof FacilitatorTimeoutError) return "unavailable";
    if (current instanceof Error) {
      const status = STATUS.exec(current.message);
      if (status) {
        const code = Number(status[1]);
        if (code === 401 || code === 403) return "authentication";
        if (code === 402 || code === 429) return "rate-limited";
        return "unavailable";
      }
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string" && NETWORK_CODES.has(code)) return "unavailable";
    }
    current = (current as { cause?: unknown }).cause;
  }
  return "unavailable";
}

/** The deepest error message in the cause chain, for the seller's one-line failure log. */
export function failureDetail(err: unknown): string {
  let message = err instanceof Error ? err.message : String(err);
  let current: unknown = err instanceof Error ? err.cause : undefined;
  for (let depth = 0; depth < 10 && current !== null && current !== undefined; depth++) {
    if (current instanceof Error) message = current.message;
    current = (current as { cause?: unknown }).cause;
  }
  return message;
}

/**
 * Wraps any facilitator client. VerifyError and SettleError pass through unchanged, so the SDK's x402
 * rejections stay byte-identical (FR-013). Every other error becomes a FacilitatorUnavailableError.
 */
export class CategorizedFacilitatorClient implements FacilitatorClient {
  readonly inner: FacilitatorClient;
  #onFailure: FailureHook | undefined;

  constructor(inner: FacilitatorClient, onFailure?: FailureHook) {
    this.inner = inner;
    this.#onFailure = onFailure;
  }

  /** The wrapped client's base URL, when it has one. */
  get url(): string | undefined {
    return (this.inner as { url?: string }).url;
  }

  /** Installs the failure hook unless one was given at construction. */
  setFailureHook(hook: FailureHook): void {
    this.#onFailure ??= hook;
  }

  verify(...args: Parameters<FacilitatorClient["verify"]>) {
    return this.#call("verify", () => this.inner.verify(...args));
  }

  settle(...args: Parameters<FacilitatorClient["settle"]>) {
    return this.#call("settle", () => this.inner.settle(...args));
  }

  getSupported() {
    return this.#call("supported", () => this.inner.getSupported());
  }

  async #call<T>(operation: FacilitatorOperation, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof VerifyError || err instanceof SettleError) throw err;
      const category = categorize(err);
      this.#onFailure?.(category, operation, err);
      throw new FacilitatorUnavailableError(category, operation, err);
    }
  }
}

export interface FacilitatorClientOptions {
  /** Required for the `cdp` choice: the JWT-authenticated client from cdp-facilitator.ts. */
  cdp?: FacilitatorClient;
  onFailure?: FailureHook;
}

/** One categorized client per seller process (FR-005: the choice never changes at runtime). */
export function facilitatorClientFor(choice: FacilitatorChoice, opts: FacilitatorClientOptions = {}): CategorizedFacilitatorClient {
  if (choice.kind === "cdp") {
    if (!opts.cdp) throw new Error("facilitatorClientFor: FACILITATOR=cdp needs a CDP client from cdp-facilitator.ts");
    return new CategorizedFacilitatorClient(opts.cdp, opts.onFailure);
  }
  const inner = new HTTPFacilitatorClient({
    url: choice.url,
    ...(choice.timeoutMs !== undefined && { timeoutMs: choice.timeoutMs }),
  });
  return new CategorizedFacilitatorClient(inner, opts.onFailure);
}
