// L2's JSON request bodies (SPEC.md §8.2 L2-5). One parser for every route that takes a body, mounted after the
// route's guard, so a caller without the route's token gets 401 before a byte of the body is read (INV-13).
// L2's callers (L1, L3, the portal and the operator scripts) never compress a request, so a body with a
// Content-Encoding other than identity is refused (415) instead of inflated: nothing L2 reads can grow on the way
// in. A body that can't be read gets a fixed JSON answer from `refuseUnreadBody`, never Express's default handler,
// which logs the error, and a body-parser error carries the raw body.
import express, { type ErrorRequestHandler, type RequestHandler } from "express";

/** Every body L2 takes but a payment request's: settlement reports, decisions, user and administration writes. */
export const BODY_LIMIT = "16kb";
/** A payment request (`POST /v1/authorize`) carries the seller's whole 402 answer. */
export const AUTHORIZE_BODY_LIMIT = "256kb";

/** JSON of at most `limit`, read as sent (`inflate: false`: 415 for a compressed body). */
export const jsonBody = (limit: string = BODY_LIMIT): RequestHandler => express.json({ limit, inflate: false });

/** The fixed answers to a body that can't be read. Nothing of the request is repeated. */
export interface BodyRefusals {
  /** Not JSON, or cut off (400). */
  malformed: string;
  /** Over the limit (413), compressed (415), or any other body-parser refusal. */
  refused: string;
}

export const GENERIC_BODY_REFUSALS: BodyRefusals = { malformed: "malformed request body", refused: "request body refused" };

/**
 * Answers a body-parser error (it has a `type` and a 4xx `status`) with that status and a fixed message, and
 * passes every other error on unchanged. Mount it after the routes it covers.
 */
export function refuseUnreadBody(messages: BodyRefusals = GENERIC_BODY_REFUSALS): ErrorRequestHandler {
  return (err: unknown, _req, res, next) => {
    const e = err as { type?: unknown; status?: unknown } | null;
    const status = typeof e?.status === "number" && e.status >= 400 && e.status < 500 ? e.status : undefined;
    if (res.headersSent || typeof e?.type !== "string" || status === undefined) {
      next(err);
      return;
    }
    res.status(status).json({ error: status === 400 ? messages.malformed : messages.refused });
  };
}
