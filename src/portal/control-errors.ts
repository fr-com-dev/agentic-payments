// What a call to L2 can fail with, for both of the portal's clients: the user-account one (./control-client.ts) and
// the administration one (./admin-client.ts, 014). They share these two classes and nothing else: each client has
// its own token and its own paths (rule A13).

/** L2 answered with a documented error (403, 404, 409, 422...). `body` is its JSON. */
export class ControlError extends Error {
  override name = "ControlError";
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(`control service answered ${status}`);
  }
  get code(): string {
    return typeof this.body.error === "string" ? this.body.error : "error";
  }
}

/** L2 could not be reached, timed out, or failed (5xx, a bad token). Nothing was changed that the caller knows of. */
export class ControlUnavailable extends Error {
  override name = "ControlUnavailable";
}
