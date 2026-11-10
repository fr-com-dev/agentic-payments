// 013 user-account routes (SPEC.md §8.2 L2-5, L2-8; specs/013 contracts/control-api.md "Portal routes").
// Every route takes the portal's role token and nothing else (INV-13): this token can't authorize, approve, reject
// or reconcile, and no other token reaches these routes. Every write runs inside the serialized section, so a policy
// or account change and a payment decision are always ordered against each other (FR-036, FR-040).
// No request carries text typed by a person: bodies hold identifiers, seller hosts, ISO dates and atomic amounts.
import { randomUUID } from "node:crypto";
import express, { type Express, type Request, type RequestHandler, type Response } from "express";
import { requireRole } from "../shared/auth.js";
import type { NetworkProfile } from "../shared/config.js";
import type { PolicyValues } from "../shared/contracts.js";
import { USER_ID_RE } from "../shared/user-id.js";
import type { AuditLedger, LedgerEntry } from "./ledger.js";
import type { Serialize } from "./ledger-routes.js";
import {
  CARD_ID_RE,
  isLoosening,
  MAX_CARDS,
  nextWalletIndex,
  parsePolicyValues,
  platformView,
  POLICY_VALUE_KEYS,
  policyOwner,
  policyView,
  sameValues,
  STEP_UP_MAX_AGE_MS,
  stepUpFresh,
  TERMS_VERSION,
  userState,
  userView,
  validatePolicy,
  type PolicyRecord,
  type UserAccountsDeps,
  type UserFigures,
  type UserState,
} from "./users.js";

export interface UserRoutesDeps {
  ledger: AuditLedger;
  serialize: Serialize;
  now: () => number;
  users: UserAccountsDeps;
  net: Pick<NetworkProfile, "caip2" | "asset" | "decimals">;
  /** Test hook: an explicit token instead of resolving it from the environment. */
  tokens?: { portal?: string };
}

const DAY_MS = 86_400_000;
const BODY_LIMIT = "16kb";

/** Amounts of the user's authorizations that can still settle: no report yet, or PENDING, and the signature still valid. */
export function pendingAtomic(entries: readonly LedgerEntry[], userId: string, nowMs: number): bigint {
  const effective = new Map<string, string>();
  for (const e of entries) {
    if (e.type === "SETTLEMENT" && e.authorizationId !== undefined && e.data.anomaly !== true) effective.set(e.authorizationId, String(e.data.status));
  }
  let total = 0n;
  for (const e of entries) {
    if (e.type !== "AUTHORIZED" || e.data.userId !== userId) continue;
    const status = e.authorizationId === undefined ? undefined : effective.get(e.authorizationId);
    if (status !== undefined && status !== "PENDING") continue;
    if (BigInt(nowMs) > BigInt(e.data.validBefore as number) * 1000n) continue;
    total += BigInt(e.data.amount as string);
  }
  return total;
}

export function userFigures(ledger: AuditLedger, userId: string, nowMs: number): UserFigures {
  return {
    committedAtomic: pendingAtomic(ledger.entries(), userId, nowMs),
    spent24hAtomic: ledger.committedAtomic({ userId, sinceMs: nowMs - DAY_MS }, nowMs),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const onlyKeys = (b: Record<string, unknown>, allowed: readonly string[]) => Object.keys(b).every((k) => allowed.includes(k));
const refuse = (res: Response, status: number, error: string, extra: Record<string, unknown> = {}) => res.status(status).json({ error, ...extra });

export function mountUserRoutes(app: Express, deps: UserRoutesDeps): void {
  const { ledger, users, net } = deps;
  const guard = requireRole("portal-control", deps.tokens?.portal === undefined ? {} : { token: deps.tokens.portal });
  const json = express.json({ limit: BODY_LIMIT });
  // `unserializedUserWrites` is the must-fail proof of FR-036: writes then run beside a decision in flight.
  const write = <T>(fn: () => T): Promise<T> => (users.unserializedUserWrites ? Promise.resolve().then(fn) : deps.serialize(fn));

  /** Auth has run. 400 for a malformed `:userId`; otherwise the handler, with its errors turned into a 500. */
  const route =
    (handler: (req: Request, res: Response, userId: string) => unknown): RequestHandler =>
    async (req, res) => {
      const userId = String(req.params.userId);
      if (!USER_ID_RE.test(userId)) {
        refuse(res, 400, "invalid userId");
        return;
      }
      try {
        await handler(req, res, userId);
      } catch (err) {
        if (!res.headersSent) res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    };

  const viewOf = (state: UserState, t: number) =>
    userView(state, { platform: users.platform, net, nowMs: t, figures: userFigures(ledger, state.userId, t) });
  const policyViewOf = (p: PolicyRecord, state: UserState, t: number) =>
    policyView(p, { platform: users.platform, nowMs: t, enabled: state.enabled, history: true });

  /**
   * FR-004: a policy is looked up through the path's user only, so another user's ID is indistinguishable from an
   * unknown one. `skipOwnershipCheck` (test-only) looks it up by ID alone, to prove the check matters.
   */
  const findPolicy = (state: UserState, policyId: string): PolicyRecord | undefined => {
    const own = state.policies.find((p) => p.policyId === policyId);
    if (own || !users.skipOwnershipCheck) return own;
    const owner = policyOwner(ledger.entries(), policyId);
    return owner === undefined ? undefined : userState(ledger.entries(), owner).policies.find((p) => p.policyId === policyId);
  };
  const notFound = (res: Response) => refuse(res, 404, "not found");

  app.get("/v1/platform", guard, (_req, res) => {
    res.json(platformView(users.platform, net));
  });

  app.get(
    "/v1/users/:userId",
    guard,
    route((_req, res, userId) => {
      const t = deps.now();
      res.json(viewOf(userState(ledger.entries(), userId), t));
    }),
  );

  app.put(
    "/v1/users/:userId/registration",
    guard,
    json,
    route(async (req, res, userId) => {
      const body = req.body as unknown;
      if (!isObject(body) || !onlyKeys(body, ["acknowledgedTestFunds"]) || body.acknowledgedTestFunds !== true) {
        refuse(res, 400, "acknowledgedTestFunds must be true");
        return;
      }
      const view = await write(() => {
        const t = deps.now();
        if (!userState(ledger.entries(), userId).registered) {
          ledger.append({ type: "USER_REGISTERED", data: { userId, acknowledgedTestFunds: true, termsVersion: TERMS_VERSION } }, t);
        }
        return viewOf(userState(ledger.entries(), userId), t);
      });
      res.json(view);
    }),
  );

  app.put(
    "/v1/users/:userId/wallet",
    guard,
    route(async (_req, res, userId) => {
      const out = await write((): { error: string } | { view: ReturnType<typeof viewOf> } => {
        const t = deps.now();
        const state = userState(ledger.entries(), userId);
        if (!state.registered) return { error: "not_registered" };
        if (!state.wallet) {
          if (!state.enabled) return { error: "account_disabled" };
          // The index is the count of wallets so far, read and written in one serialized section: no two users
          // can share one, and a retry finds the wallet already there (FR-013).
          const walletIndex = nextWalletIndex(ledger.entries());
          ledger.append({ type: "WALLET_CREATED", data: { userId, walletIndex, address: users.keyring.addressOf(walletIndex), network: net.caip2 } }, t);
        }
        return { view: viewOf(userState(ledger.entries(), userId), t) };
      });
      if ("error" in out) refuse(res, 409, out.error);
      else res.json(out.view);
    }),
  );

  // ---- policies -----------------------------------------------------------

  type Outcome = { status: number; body: unknown };
  const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Outcome => ({ status, body: { error, ...extra } });
  const stepUp = (): Outcome => fail(403, "step_up_required", { maxAgeSec: STEP_UP_MAX_AGE_MS / 1000 });
  const send = (res: Response, o: Outcome) => res.status(o.status).json(o.body);

  const validate = (values: PolicyValues, state: UserState, self: string | undefined, addsActive: boolean, t: number) =>
    validatePolicy(values, {
      platform: users.platform,
      nowMs: t,
      others: state.policies.filter((p) => p.policyId !== self),
      addsActive,
      ...(users.skipSellerOverlapCheck && { skipSellerOverlapCheck: true }),
    });

  app.post(
    "/v1/users/:userId/policies",
    guard,
    json,
    route(async (req, res, userId) => {
      const body = req.body as unknown;
      const values = isObject(body) && onlyKeys(body, [...POLICY_VALUE_KEYS, "identityConfirmedAtMs"]) ? parsePolicyValues(body) : undefined;
      if (!values) {
        refuse(res, 400, "malformed policy");
        return;
      }
      const confirmedAt = (body as Record<string, unknown>).identityConfirmedAtMs;
      send(
        res,
        await write((): Outcome => {
          const t = deps.now();
          const state = userState(ledger.entries(), userId);
          if (!state.registered) return fail(409, "not_registered");
          if (!state.wallet) return fail(409, "no_wallet");
          if (!state.enabled) return fail(409, "account_disabled");
          // A new policy adds sellers and limits: always a loosening change (FR-007).
          if (!stepUpFresh(confirmedAt, t)) return stepUp();
          const issues = validate(values, state, undefined, true, t);
          if (issues.length > 0) return fail(422, "invalid_policy", { issues });
          const policyId = `pol_${randomUUID()}`;
          ledger.append({ type: "POLICY_CREATED", data: { userId, policyId, version: 1, ...values, identityConfirmedAtMs: confirmedAt } }, t);
          const after = userState(ledger.entries(), userId);
          return { status: 201, body: policyViewOf(after.policies.find((p) => p.policyId === policyId)!, after, t) };
        }),
      );
    }),
  );

  app.get(
    "/v1/users/:userId/policies/:policyId",
    guard,
    route((req, res, userId) => {
      const t = deps.now();
      const state = userState(ledger.entries(), userId);
      const p = findPolicy(state, String(req.params.policyId));
      if (!p) notFound(res);
      else res.json(policyViewOf(p, state, t));
    }),
  );

  app.put(
    "/v1/users/:userId/policies/:policyId",
    guard,
    json,
    route(async (req, res, userId) => {
      const body = req.body as unknown;
      const ok = isObject(body) && onlyKeys(body, [...POLICY_VALUE_KEYS, "expectedVersion", "identityConfirmedAtMs"]);
      const values = ok ? parsePolicyValues(body) : undefined;
      const expectedVersion = ok ? (body as Record<string, unknown>).expectedVersion : undefined;
      if (!values || typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
        refuse(res, 400, "malformed policy");
        return;
      }
      const confirmedAt = (body as Record<string, unknown>).identityConfirmedAtMs;
      const policyId = String(req.params.policyId);
      send(
        res,
        await write((): Outcome => {
          const t = deps.now();
          const state = userState(ledger.entries(), userId);
          const p = findPolicy(state, policyId);
          if (!p) return fail(404, "not found");
          if (p.state === "removed") return fail(409, "policy_removed");
          if (!state.enabled) return fail(409, "account_disabled");
          // The same values again (a double click, a retry): nothing to record, whatever version was expected.
          if (sameValues(p.values, values)) return { status: 200, body: policyViewOf(p, state, t) };
          if (expectedVersion !== p.version) return fail(409, "version_conflict", { current: policyViewOf(p, state, t) });
          const loosened = isLoosening(p.values, values);
          if (loosened && !stepUpFresh(confirmedAt, t)) return stepUp();
          const issues = validate(values, state, policyId, false, t);
          if (issues.length > 0) return fail(422, "invalid_policy", { issues });
          ledger.append(
            {
              type: "POLICY_CHANGED",
              data: { userId, policyId, version: p.version + 1, ...values, loosened, ...(loosened && { identityConfirmedAtMs: confirmedAt }) },
            },
            t,
          );
          const after = userState(ledger.entries(), userId);
          return { status: 200, body: policyViewOf(after.policies.find((x) => x.policyId === policyId)!, after, t) };
        }),
      );
    }),
  );

  type Action = "pause" | "resume" | "remove";
  const act = (action: Action) =>
    route(async (req, res, userId) => {
      const body = (req.body ?? {}) as unknown;
      if (!isObject(body) || !onlyKeys(body, action === "resume" ? ["identityConfirmedAtMs"] : [])) {
        refuse(res, 400, "malformed body");
        return;
      }
      const policyId = String(req.params.policyId);
      send(
        res,
        await write((): Outcome => {
          const t = deps.now();
          const state = userState(ledger.entries(), userId);
          const p = findPolicy(state, policyId);
          if (!p) return fail(404, "not found");
          const done = (): Outcome => {
            const after = userState(ledger.entries(), userId);
            return { status: 200, body: policyViewOf(after.policies.find((x) => x.policyId === policyId) ?? p, after, t) };
          };
          if (action === "remove" && p.state === "removed") return done();
          if (p.state === "removed") return fail(409, "policy_removed");
          // FR-038: no policy write while the account is disabled, removal included.
          if (!state.enabled) return fail(409, "account_disabled");
          const base = { userId, policyId, version: p.version };
          if (action === "pause") {
            if (p.state !== "paused") ledger.append({ type: "POLICY_PAUSED", data: { ...base, cause: "user" } }, t);
            return done();
          }
          if (action === "remove") {
            ledger.append({ type: "POLICY_REMOVED", data: base }, t);
            return done();
          }
          if (p.state === "active") return done();
          // Resuming restores spending: a loosening change, re-validated against today's sellers and policies.
          if (!stepUpFresh(body.identityConfirmedAtMs, t)) return stepUp();
          const issues = validate(p.values, state, policyId, true, t);
          if (issues.length > 0) return fail(422, "invalid_policy", { issues });
          ledger.append({ type: "POLICY_RESUMED", data: { ...base, identityConfirmedAtMs: body.identityConfirmedAtMs } }, t);
          return done();
        }),
      );
    });
  app.post("/v1/users/:userId/policies/:policyId/pause", guard, json, act("pause"));
  app.post("/v1/users/:userId/policies/:policyId/resume", guard, json, act("resume"));
  app.post("/v1/users/:userId/policies/:policyId/remove", guard, json, act("remove"));

  // ---- the account --------------------------------------------------------

  app.post(
    "/v1/users/:userId/disable",
    guard,
    route(async (_req, res, userId) => {
      send(
        res,
        await write((): Outcome => {
          const t = deps.now();
          const state = userState(ledger.entries(), userId);
          if (!state.registered) return fail(409, "not_registered");
          // FR-037: one entry; nothing else is touched, so nothing is lost.
          if (state.enabled) ledger.append({ type: "USER_DISABLED", data: { userId } }, t);
          return { status: 200, body: viewOf(userState(ledger.entries(), userId), t) };
        }),
      );
    }),
  );

  app.post(
    "/v1/users/:userId/enable",
    guard,
    json,
    route(async (req, res, userId) => {
      const body = (req.body ?? {}) as unknown;
      if (!isObject(body) || !onlyKeys(body, ["identityConfirmedAtMs"])) {
        refuse(res, 400, "malformed body");
        return;
      }
      send(
        res,
        await write((): Outcome => {
          const t = deps.now();
          const state = userState(ledger.entries(), userId);
          if (!state.registered) return fail(409, "not_registered");
          if (state.enabled) return { status: 200, body: viewOf(state, t) };
          if (!stepUpFresh(body.identityConfirmedAtMs, t)) return stepUp();
          // FR-039: every active policy comes back paused, recorded before the account is enabled, in this one
          // section. No decision can ever see an enabled account with a policy still active from before.
          for (const p of state.policies) {
            if (p.state === "active") {
              ledger.append({ type: "POLICY_PAUSED", data: { userId, policyId: p.policyId, version: p.version, cause: "account_enabled" } }, t);
            }
          }
          ledger.append({ type: "USER_ENABLED", data: { userId, identityConfirmedAtMs: body.identityConfirmedAtMs } }, t);
          return { status: 200, body: viewOf(userState(ledger.entries(), userId), t) };
        }),
      );
    }),
  );

  // ---- cards (FR-018..FR-021): identifiers only; a card never pays ------------

  const card = (remove: boolean) =>
    route(async (req, res, userId) => {
      const cardId = String(req.params.cardId);
      if (!CARD_ID_RE.test(cardId)) {
        refuse(res, 400, "invalid cardId");
        return;
      }
      send(
        res,
        await write((): Outcome => {
          const t = deps.now();
          const state = userState(ledger.entries(), userId);
          const has = state.cards.includes(cardId);
          if (remove) {
            // Removing only takes away; it stays possible while the account is disabled.
            if (has) ledger.append({ type: "CARD_REMOVED", data: { userId, cardId } }, t);
          } else if (!has) {
            if (!state.registered) return fail(409, "not_registered");
            if (!state.enabled) return fail(409, "account_disabled");
            if (state.cards.length >= MAX_CARDS) return fail(409, "card_limit");
            ledger.append({ type: "CARD_ADDED", data: { userId, cardId } }, t);
          }
          return { status: 200, body: { cards: userState(ledger.entries(), userId).cards } };
        }),
      );
    });
  app.put("/v1/users/:userId/cards/:cardId", guard, card(false));
  app.delete("/v1/users/:userId/cards/:cardId", guard, card(true));
}
