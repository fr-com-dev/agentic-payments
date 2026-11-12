// 013 the portal API (SPEC.md §8.2 L2-8; specs/013 contracts/portal-api.md "Routes"). Every route acts for the
// signed-in person only: the user is `res.locals.person.userId`, set by the access check from the verified token, and
// no route reads a user identifier from a path, a query or a body (FR-004). Writes go to L2 first and to the portal's
// own store second, so a failure in between never grants anything.
// 014: /api/me also says whether the person is an administrator (`admin`). Every signed-in person is a user, an
// administrator included, so nothing else here changes for them.
import express, { type Express, type Request, type Response } from "express";
import { parseUsdc } from "../shared/config.js";
import type { PlatformView, PolicyIssue, PolicyValues, PolicyView, UserView } from "../shared/contracts.js";
import type { Person } from "./access.js";
import type { BalanceCache } from "./balance.js";
import { CardVaultError } from "./card-vault.js";
import { CardRefusal, validNickname, type Card, type Cards } from "./cards.js";
import { ControlError, ControlUnavailable, type ControlPort } from "./control-client.js";
import { UNTITLED_POLICY, validDisplayName, validEmail, validPolicyName, type ProfileIssue, type ProfileStore } from "./profile-store.js";

export interface RoutesDeps {
  control: ControlPort;
  profiles: ProfileStore;
  balance: BalanceCache;
  /** Absent: cards are off (503 `cards_unavailable`). */
  cards?: Cards;
  now: () => number;
}

/** Marks the request with a fixed label for the log line (never free text, never what an outside service said). */
const note = (res: Response, label: string) => {
  res.locals.event = label;
};

/** A policy as the browser gets it: L2's view plus the name the person gave it. */
export type PortalPolicy = PolicyView & { name: string };

const BODY_LIMIT = "16kb";
const SETUP_INTENT_RE = /^seti_[A-Za-z0-9_]{1,200}$/;

/** L2's field names → the names of the fields the person filled in. */
const FIELD_NAMES: Record<string, string> = {
  autoApproveMaxAtomic: "autoApproveUsdc",
  hardCapPerPaymentAtomic: "perPaymentUsdc",
  sessionBudgetAtomic: "perRunUsdc",
  dailyBudgetAtomic: "perDayUsdc",
  maxAuthorizationsPerMinute: "paymentsPerMinute",
  expiresAt: "endsOn",
};
const USDC_FIELDS = [
  ["autoApproveUsdc", "autoApproveMaxAtomic"],
  ["perPaymentUsdc", "hardCapPerPaymentAtomic"],
  ["perRunUsdc", "sessionBudgetAtomic"],
  ["perDayUsdc", "dailyBudgetAtomic"],
] as const;
const POLICY_INPUT_KEYS = ["name", "sellers", "autoApproveUsdc", "perPaymentUsdc", "perRunUsdc", "perDayUsdc", "paymentsPerMinute", "endsOn", "paymentMethod"];
/** L2's state errors, in the portal's words. */
const CODE_NAMES: Record<string, string> = { not_registered: "profile_required", no_wallet: "wallet_required" };

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const onlyKeys = (b: Record<string, unknown>, allowed: readonly string[]) => Object.keys(b).every((k) => allowed.includes(k));
const person = (res: Response) => res.locals.person as Person;

const renameIssue = (i: PolicyIssue): PolicyIssue => ({ ...i, field: FIELD_NAMES[i.field] ?? i.field });

/** `YYYY-MM-DD` → the end of that day, UTC. Undefined when it is not a real date. */
export function endOfDayUtc(endsOn: unknown): string | undefined {
  if (typeof endsOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(endsOn)) return undefined;
  const ms = Date.parse(`${endsOn}T23:59:59.999Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== endsOn) return undefined;
  return new Date(ms).toISOString();
}

type Parsed = { values: PolicyValues; name: string } | { issues: PolicyIssue[] } | { malformed: true };

/** The person's input → L2's values. Amounts are parsed exactly: a seventh decimal is an issue, never rounded (FR-025). */
export function parsePolicyInput(body: unknown, decimals: number): Parsed {
  if (!isObject(body) || !onlyKeys(body, [...POLICY_INPUT_KEYS, "expectedVersion"])) return { malformed: true };
  if (!Array.isArray(body.sellers) || body.sellers.some((s) => typeof s !== "string")) return { malformed: true };
  if (typeof body.paymentsPerMinute !== "number" || typeof body.paymentMethod !== "string") return { malformed: true };
  for (const [field] of USDC_FIELDS) if (typeof body[field] !== "string") return { malformed: true };
  const issues: PolicyIssue[] = [];
  const name = validPolicyName(body.name);
  if (name === undefined) issues.push({ field: "name", code: "invalid_name" });
  const amounts: Record<string, string> = {};
  for (const [field, target] of USDC_FIELDS) {
    const parsed = parseUsdc(body[field] as string, decimals);
    if (typeof parsed === "string") amounts[target] = parsed;
    else issues.push({ field, code: parsed.error });
  }
  const expiresAt = endOfDayUtc(body.endsOn);
  if (expiresAt === undefined) issues.push({ field: "endsOn", code: "invalid_date" });
  if (issues.length > 0) return { issues };
  return {
    name: name!,
    values: {
      sellers: body.sellers as string[],
      autoApproveMaxAtomic: amounts.autoApproveMaxAtomic!,
      hardCapPerPaymentAtomic: amounts.hardCapPerPaymentAtomic!,
      sessionBudgetAtomic: amounts.sessionBudgetAtomic!,
      dailyBudgetAtomic: amounts.dailyBudgetAtomic!,
      maxAuthorizationsPerMinute: body.paymentsPerMinute,
      expiresAt: expiresAt!,
      paymentMethod: body.paymentMethod as "crypto_account",
    },
  };
}

/** Mounts every /api route on the app itself (not a sub-router), so the mounted routes can be compared with the OpenAPI document. */
export function mountPortalRoutes(r: Express, d: RoutesDeps): void {
  const json = express.json({ limit: BODY_LIMIT });

  const named = (userId: string, p: PolicyView): PortalPolicy => ({ ...p, name: d.profiles.get(userId)?.policyNames[p.policyId] ?? UNTITLED_POLICY });
  const setName = (userId: string, policyId: string, name: string) =>
    d.profiles.update(userId, (p) => ({ ...p, policyNames: { ...p.policyNames, [policyId]: name } }), d.now());

  /** Turns every failure into the status and body the contract lists. Nothing internal is ever echoed. */
  const handle =
    (fn: (req: Request, res: Response) => Promise<unknown>) =>
    async (req: Request, res: Response): Promise<void> => {
      try {
        await fn(req, res);
      } catch (err) {
        if (res.headersSent) return;
        if (err instanceof ControlUnavailable) {
          res.status(502).json({ error: "control_unavailable" });
        } else if (err instanceof ControlError) {
          const body = err.body;
          const code = CODE_NAMES[err.code] ?? err.code;
          if (code === "invalid_policy" && Array.isArray(body.issues)) {
            res.status(422).json({ error: code, issues: (body.issues as PolicyIssue[]).map(renameIssue) });
          } else if (code === "version_conflict" && isObject(body.current)) {
            res.status(409).json({ error: code, current: named(person(res).userId, body.current as unknown as PolicyView) });
          } else if (code === "step_up_required") {
            res.status(403).json({ error: code, maxAgeSec: body.maxAgeSec });
          } else {
            res.status(err.status).json({ error: code });
          }
        } else if (err instanceof CardRefusal) {
          res.status(err.status).json({ error: err.code, ...(err.vaultCode !== undefined && { vaultCode: err.vaultCode }) });
        } else if (err instanceof CardVaultError) {
          // The vault failed. Only cards are affected; the label says how, never what the vault said.
          note(res, err.kind === "auth" ? "card_vault_auth" : err.kind === "live_mode" ? "card_vault_live_mode" : "card_vault_unavailable");
          res.status(err.kind === "not_found" ? 404 : 503).json({ error: err.kind === "not_found" ? "not found" : "card_vault_unavailable" });
        } else {
          note(res, "internal_error");
          res.status(500).json({ error: "internal error" });
        }
      }
    };

  /** The body of /api/me. 014: `admin` says whether the administration area is theirs to use. */
  const me = (res: Response, user: UserView) => {
    const { userId, admin } = person(res);
    const profile = d.profiles.get(userId);
    return {
      userId,
      enabled: user.enabled,
      onboarding: user.onboarding,
      ...(profile && { profile: { displayName: profile.displayName, contactEmail: profile.contactEmail } }),
      admin,
    };
  };

  // ---- profile ------------------------------------------------------------

  r.get(
    "/api/me",
    handle(async (_req, res) => {
      res.json(me(res, await d.control.user(person(res).userId)));
    }),
  );

  r.put(
    "/api/profile",
    json,
    handle(async (req, res) => {
      const { userId } = person(res);
      const body = req.body as unknown;
      if (!isObject(body) || !onlyKeys(body, ["displayName", "contactEmail", "acknowledgedTestFunds"])) {
        res.status(400).json({ error: "malformed body" });
        return;
      }
      const user = await d.control.user(userId);
      const issues: ProfileIssue[] = [];
      const displayName = validDisplayName(body.displayName);
      const contactEmail = validEmail(body.contactEmail);
      if (displayName === undefined) issues.push({ field: "displayName", code: "invalid_name" });
      if (contactEmail === undefined) issues.push({ field: "contactEmail", code: "invalid_email" });
      // The first save records the acknowledgement in the ledger; without it there is no profile (FR-009).
      if (!user.registered && body.acknowledgedTestFunds !== true) issues.push({ field: "acknowledgedTestFunds", code: "required" });
      if (issues.length > 0) {
        res.status(422).json({ error: "invalid_profile", issues });
        return;
      }
      // The personal data is written first: the ledger entry that follows is the one that can't be taken back.
      const current = d.profiles.get(userId);
      d.profiles.put({
        userId,
        displayName: displayName!,
        contactEmail: contactEmail!,
        policyNames: current?.policyNames ?? {},
        ...(current?.cardVaultCustomer !== undefined && { cardVaultCustomer: current.cardVaultCustomer }),
        updatedAt: new Date(d.now()).toISOString(),
      });
      res.json(me(res, user.registered ? user : await d.control.register(userId)));
    }),
  );

  r.get(
    "/api/platform",
    handle(async (_req, res) => {
      const p = await d.control.platform();
      // The payee addresses are L2's business; a person picks sellers by name and host.
      res.json({ limits: p.limits, sellers: p.sellers.map((s) => ({ host: s.host, name: s.name })), network: p.network, asset: p.asset, decimals: p.decimals });
    }),
  );

  // ---- wallet -------------------------------------------------------------

  const minAtomic = (a: string, b: string) => (BigInt(a) <= BigInt(b) ? a : b);

  async function walletView(res: Response, userId: string, user: UserView, platform: PlatformView) {
    let cards: Card[] = [];
    let cardsFailed = false;
    if (d.cards) {
      try {
        cards = await d.cards.list(userId, user.cards);
      } catch (err) {
        // The vault (or the reconcile through L2) failed: the wallet still shows; only the card list is missing.
        if (!(err instanceof CardVaultError) && !(err instanceof ControlUnavailable)) throw err;
        cardsFailed = true;
        note(res, "card_vault_unavailable");
      }
    }
    const base = { cards, cardsAvailable: d.cards !== undefined && !cardsFailed, disabled: !user.enabled };
    const w = user.wallet;
    if (!w) return base;
    const balance = await d.balance.get(w.asset, w.address);
    const caps = user.policies
      .filter((p) => p.state === "active" && !p.expired)
      .map((p) => minAtomic(p.values.hardCapPerPaymentAtomic, platform.limits.hardCapPerPaymentAtomic));
    return {
      account: {
        address: w.address,
        network: w.network,
        asset: w.asset,
        decimals: w.decimals,
        ...(balance && { balanceAtomic: balance.balanceAtomic, balanceReadAt: balance.readAt }),
        balanceStale: balance === undefined || balance.stale,
        committedAtomic: w.committedAtomic,
        spent24hAtomic: w.spent24hAtomic,
        dailyCeilingAtomic: w.dailyCeilingAtomic,
        dailyRemainingAtomic: w.dailyRemainingAtomic,
        lowBalance: balance !== undefined && caps.some((cap) => BigInt(balance.balanceAtomic) < BigInt(cap)),
      },
      ...base,
    };
  }

  r.get(
    "/api/wallet",
    handle(async (_req, res) => {
      const { userId } = person(res);
      const user = await d.control.user(userId);
      if (!user.registered) {
        res.status(409).json({ error: "profile_required" });
        return;
      }
      res.json(await walletView(res, userId, user, await d.control.platform()));
    }),
  );

  r.put(
    "/api/wallet/account",
    handle(async (_req, res) => {
      const { userId } = person(res);
      const user = await d.control.createWallet(userId);
      res.json(await walletView(res, userId, user, await d.control.platform()));
    }),
  );

  // ---- cards --------------------------------------------------------------

  const cardsOrRefuse = (res: Response): Cards | undefined => {
    if (!d.cards) res.status(503).json({ error: "cards_unavailable" });
    return d.cards;
  };

  r.post(
    "/api/cards/setup",
    handle(async (_req, res) => {
      const cards = cardsOrRefuse(res);
      if (!cards) return;
      const { userId } = person(res);
      const user = await d.control.user(userId);
      if (!user.registered) {
        res.status(409).json({ error: "profile_required" });
        return;
      }
      res.json(await cards.setup(userId, { enabled: user.enabled, cards: user.cards }));
    }),
  );

  r.post(
    "/api/cards",
    json,
    handle(async (req, res) => {
      const cards = cardsOrRefuse(res);
      if (!cards) return;
      const body = req.body as unknown;
      const nickname = isObject(body) ? validNickname(body.nickname) : null;
      if (!isObject(body) || !onlyKeys(body, ["setupIntentId", "nickname"]) || typeof body.setupIntentId !== "string" || !SETUP_INTENT_RE.test(body.setupIntentId) || nickname === null) {
        res.status(400).json({ error: "malformed body" });
        return;
      }
      res.status(201).json(await cards.confirm(person(res).userId, body.setupIntentId, nickname));
    }),
  );

  r.delete(
    "/api/cards/:cardId",
    handle(async (req, res) => {
      const cards = cardsOrRefuse(res);
      if (!cards) return;
      const { userId } = person(res);
      await cards.remove(userId, String(req.params.cardId));
      const user = await d.control.user(userId);
      res.json({ cards: await cards.list(userId, user.cards) });
    }),
  );

  // ---- policies -----------------------------------------------------------

  r.get(
    "/api/policies",
    handle(async (_req, res) => {
      const { userId } = person(res);
      const user = await d.control.user(userId);
      res.json({ policies: user.policies.map((p) => named(userId, p)) });
    }),
  );

  r.post(
    "/api/policies",
    json,
    handle(async (req, res) => {
      const { userId, identityConfirmedAtMs } = person(res);
      if (isObject(req.body) && "expectedVersion" in req.body) {
        res.status(400).json({ error: "malformed body" });
        return;
      }
      const platform = await d.control.platform();
      const input = parsePolicyInput(req.body, platform.decimals);
      if ("malformed" in input) {
        res.status(400).json({ error: "malformed body" });
        return;
      }
      if ("issues" in input) {
        res.status(422).json({ error: "invalid_policy", issues: input.issues });
        return;
      }
      const policy = await d.control.createPolicy(userId, input.values, identityConfirmedAtMs);
      // L2 accepted: only now is the name kept, in the portal's own store.
      setName(userId, policy.policyId, input.name);
      res.status(201).json(named(userId, policy));
    }),
  );

  r.get(
    "/api/policies/:policyId",
    handle(async (req, res) => {
      const { userId } = person(res);
      res.json(named(userId, await d.control.policy(userId, String(req.params.policyId))));
    }),
  );

  r.put(
    "/api/policies/:policyId",
    json,
    handle(async (req, res) => {
      const { userId, identityConfirmedAtMs } = person(res);
      const policyId = String(req.params.policyId);
      const expectedVersion = isObject(req.body) ? req.body.expectedVersion : undefined;
      const platform = await d.control.platform();
      const input = parsePolicyInput(req.body, platform.decimals);
      if ("malformed" in input || typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
        res.status(400).json({ error: "malformed body" });
        return;
      }
      if ("issues" in input) {
        res.status(422).json({ error: "invalid_policy", issues: input.issues });
        return;
      }
      // The same values with a new name is a rename: L2 records nothing for it, and the name is the portal's.
      const policy = await d.control.changePolicy(userId, policyId, input.values, expectedVersion, identityConfirmedAtMs);
      setName(userId, policyId, input.name);
      res.json(named(userId, policy));
    }),
  );

  const act = (action: "pause" | "resume" | "remove") =>
    handle(async (req, res) => {
      const { userId, identityConfirmedAtMs } = person(res);
      const policyId = String(req.params.policyId);
      const policy =
        action === "pause"
          ? await d.control.pausePolicy(userId, policyId)
          : action === "resume"
            ? await d.control.resumePolicy(userId, policyId, identityConfirmedAtMs)
            : await d.control.removePolicy(userId, policyId);
      res.json(named(userId, policy));
    });
  r.post("/api/policies/:policyId/pause", act("pause"));
  r.post("/api/policies/:policyId/resume", act("resume"));
  r.post("/api/policies/:policyId/remove", act("remove"));

  // ---- the account ----------------------------------------------------------

  r.post(
    "/api/account/disable",
    json,
    handle(async (req, res) => {
      const { userId } = person(res);
      const body = req.body as unknown;
      // One deliberate step: the request must say so.
      if (!isObject(body) || !onlyKeys(body, ["confirm"]) || body.confirm !== true) {
        res.status(400).json({ error: "confirm must be true" });
        return;
      }
      res.json(me(res, await d.control.disable(userId)));
    }),
  );

  r.post(
    "/api/account/enable",
    handle(async (_req, res) => {
      const { userId, identityConfirmedAtMs } = person(res);
      res.json(me(res, await d.control.enable(userId, identityConfirmedAtMs)));
    }),
  );
}
