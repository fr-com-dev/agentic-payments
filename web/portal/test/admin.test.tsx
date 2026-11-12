// @vitest-environment jsdom
// 014 the administration area in the web app (specs/014 contracts/portal-ui.md "Tests"): T-WEB-09..12. Who sees it,
// the waiting list and its countdown, deciding, the trail and the ledger check. The portal API is a fake; every
// method is a spy.
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app.js";
import { resolveRoute } from "../src/routes.js";
import { NO_ACTIVITY_TEXT, PAGE_SIZE, TRAIL_POLL_MS } from "../src/screens/admin/Activity.js";
import { eventText, newPaymentsText, ownerText, phoneText, sellerOf, shortUserId, timeLeftText, usdc } from "../src/screens/admin/format.js";
import { STEP_UP_FAILED_TEXT, STEP_UP_TEXT } from "../src/components/StepUp.js";
import { brokenText, verifiedText } from "../src/screens/admin/LedgerCheck.js";
import { REASON_LABELS } from "../src/messages.js";
import { APPROVE_STEP_UP_TEXT, APPROVE_TEXT, endedText, NO_SUCH_PAYMENT_TEXT, NOT_APPLYING_TEXT, outcomeText, OWN_PAYMENT_TEXT, WILL_NOT_FIT_TEXT } from "../src/screens/admin/Payment.js";
import { MINE_TEXT, NOTHING_WAITING_TEXT, POLL_MS } from "../src/screens/admin/Waiting.js";
import type { AdminEscalation, AdminEscalationDetail, AdminEvent, AdminEventPage, AdminLedgerCheck, Config, DecisionOutcome, EscalationBudget, Me } from "../src/types.js";
import { CONFIG, fakeApi, fakeAuth, refuse, world, type FakeApi, type FakeAuth, type World } from "./helpers.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setVisibility("visible");
  window.history.replaceState(null, "", "/");
});

const ALICE = "usr_aaaaaaaaaaaaaaaaaaaaaaaa11112222";
const DANA = "usr_dddddddddddddddddddddddd33334444";
const T0 = Date.parse("2026-11-11T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const ADMIN_CONFIG: Config = { ...CONFIG, admin: { available: true } };
const all = { profile: true, wallet: true, policy: true };
const none = { profile: false, wallet: false, policy: false };

/** An administrator who is also an onboarded user, one who is only an administrator, and an ordinary user. */
const BOTH: Me = { userId: DANA, user: true, admin: true, enabled: true, onboarding: all };
const ADMIN_ONLY: Me = { userId: "usr_cccccccccccccccccccccccc55556666", user: false, admin: true, enabled: true, onboarding: none };

let n = 0;
function escalation(over: Partial<AdminEscalation> = {}): AdminEscalation {
  const id = `auth_${String(++n).padStart(8, "0")}-0000-4000-8000-000000000000`;
  return {
    authorizationId: id,
    referenceCode: id.slice(5, 13),
    owner: { userId: ALICE, platformAccount: false },
    mine: false,
    resourceKey: "http://127.0.0.1:4021/api/premium-report",
    payTo: "0xcccccccccccccccccccccccccccccccccccccccc",
    amountAtomic: "50000",
    createdAt: iso(T0),
    expiresAt: iso(T0 + 300_000),
    ...over,
  };
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** A payment that ended, as a test writes it: the fake adds the portal's read time when it answers. */
type Ended = Omit<AdminEscalationDetail, "readAt">;

interface AdminWorld {
  pending: AdminEscalation[];
  readAt: string;
  /** Every event of the ledger, oldest first. The fake pages over it exactly as L2 does. */
  events: AdminEvent[];
  /** Payments that are no longer pending, by ID, and the budget of any payment (default: plenty left). */
  ended: Record<string, Ended>;
  budgets: Record<string, EscalationBudget>;
  /** The portal's clock when one payment is read. Default: this browser's, so the two agree. */
  paymentReadAt?: string;
  ledger: AdminLedgerCheck;
}

const line = (cap: string, spent: string) => ({ capAtomic: cap, spentAtomic: spent, remainingAtomic: (BigInt(cap) - BigInt(spent)).toString() });
function budgetOf(over: Partial<EscalationBudget> = {}, user = true): EscalationBudget {
  return {
    asset: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    decimals: 6,
    applies: true,
    autoApproveMaxAtomic: "20000",
    hardCapPerPaymentAtomic: "100000",
    run: line("100000", "30000"),
    day: line("500000", "40000"),
    ...(user && { userDay: line("500000", "45000") }),
    fits: true,
    ...over,
  };
}

/** L2's paging (specs/014 data-model.md "EventPage"), over a list. */
function pageOf(all: AdminEvent[], q: { after?: number; before?: number; limit?: number } = {}): AdminEventPage {
  const limit = q.limit ?? 50;
  const pool = q.after !== undefined ? all.filter((e) => e.seq > q.after!) : q.before !== undefined ? all.filter((e) => e.seq < q.before!) : all;
  const events = q.after !== undefined ? pool.slice(0, limit) : pool.slice(Math.max(0, pool.length - limit));
  return { events, first: events[0]?.seq ?? -1, last: events.at(-1)?.seq ?? -1, cursor: all.at(-1)?.seq ?? -1, more: pool.length > events.length };
}

function event(seq: number, over: Partial<AdminEvent> = {}): AdminEvent {
  const id = `auth_${String(seq).padStart(8, "0")}-0000-4000-8000-000000000000`;
  return {
    seq,
    at: iso(T0 + seq * 1_000),
    kind: "escalated",
    authorizationId: id,
    resourceKey: "http://127.0.0.1:4021/api/premium-report",
    payTo: "0xcccccccccccccccccccccccccccccccccccccccc",
    amount: "50000",
    referenceCode: id.slice(5, 13),
    mine: false,
    ...over,
  };
}

const CAROL = "usr_cccccccccccccccccccccccc55556666";
const approvedBy = (decidedBy = CAROL, over: Partial<DecisionOutcome> = {}): DecisionOutcome =>
  ({ ok: true, state: "approved", approvalId: "apr_1", expiresAt: iso(T0 + 600_000), already: false, channel: "portal", decidedBy, ...over }) as DecisionOutcome;
const rejectedBy = (decidedBy = CAROL, over: Partial<DecisionOutcome> = {}): DecisionOutcome =>
  ({ ok: true, state: "denied", rejectionId: "rej_1", rejectedAt: iso(T0), already: false, channel: "portal", decidedBy, ...over }) as DecisionOutcome;

/** The fake portal API with the administration calls answering from `a`. A decision takes the payment off the list. */
function adminApi(w: World, a: AdminWorld): FakeApi {
  const api = fakeApi(w);
  /** A decision takes the payment off the waiting list and records how it ended. */
  const decided = (id: string, state: "approved" | "denied") => {
    const was = a.pending.find((e) => e.authorizationId === id);
    a.pending = a.pending.filter((e) => e.authorizationId !== id);
    if (was) a.ended[id] = { ...was, state, decision: { at: iso(Date.now()), channel: "portal", decidedBy: w.me.userId, ...(state === "denied" && { reasonCode: "amount_too_high" as const }) }, budget: budgetOf() };
  };
  api.adminEscalations.mockImplementation(async () => ({ ok: true, data: { pending: a.pending, readAt: a.readAt } }));
  api.adminEscalation.mockImplementation(async (id) => {
    const waiting = a.pending.find((e) => e.authorizationId === id);
    const readAt = a.paymentReadAt ?? iso(Date.now());
    if (waiting) return { ok: true, data: { ...waiting, state: "pending", budget: a.budgets[id] ?? budgetOf({}, waiting.owner.userId !== undefined), readAt } };
    return a.ended[id] ? { ok: true, data: { ...a.ended[id]!, readAt } } : refuse(404, "not found");
  });
  api.adminEvents.mockImplementation(async (q) => ({ ok: true, data: pageOf(a.events, q) }));
  api.adminLedgerCheck.mockImplementation(async () => ({ ok: true, data: a.ledger }));
  api.approveEscalation.mockImplementation(async (id) => {
    decided(id, "approved");
    return { ok: true, data: approvedBy(w.me.userId) };
  });
  api.rejectEscalation.mockImplementation(async (id) => {
    decided(id, "denied");
    return { ok: true, data: rejectedBy(w.me.userId) };
  });
  return api;
}

function renderAdmin(path: string, me: Me, a: Partial<AdminWorld> = {}, o: { config?: Config; api?: FakeApi; auth?: FakeAuth } = {}) {
  const w = world("done");
  w.me = me;
  const state: AdminWorld = { pending: [], readAt: iso(T0), events: [], ended: {}, budgets: {}, ledger: { entries: 1284, ok: true, checkedAt: iso(T0) }, ...a };
  const api = o.api ?? adminApi(w, state);
  const auth = o.auth ?? fakeAuth();
  window.history.replaceState(null, "", path);
  const view = render(<App api={api} auth={auth} config={o.config ?? ADMIN_CONFIG} />);
  return Object.assign(view, { api, auth, state });
}
const adminCalls = (api: FakeApi) =>
  [api.adminEscalations, api.adminEscalation, api.approveEscalation, api.rejectEscalation, api.adminEvents, api.adminLedgerCheck].reduce((sum, f) => sum + f.mock.calls.length, 0);

describe("T-WEB-09 who sees the administration area (FR-002..FR-006)", () => {
  it("T-WEB-09 the link appears only for an administrator", async () => {
    renderAdmin("/", BOTH);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Administration" }).getAttribute("href")).toBe("/admin");
    expect(within(nav).getByRole("link", { name: "Wallet" })).toBeTruthy();
    cleanup();

    renderAdmin("/", { ...BOTH, admin: false });
    expect(within(await screen.findByRole("navigation", { name: "Main" })).queryByRole("link", { name: "Administration" })).toBeNull();
  });

  it("T-WEB-09 a person who is only an administrator sees the area and the way out, and nothing else", async () => {
    for (const path of ["/", "/wallet", "/policies", "/onboarding/profile", "/account"]) {
      const view = renderAdmin(path, ADMIN_ONLY);
      expect(await screen.findByRole("heading", { level: 1, name: "Waiting for approval" }), path).toBeTruthy();
      expect(window.location.pathname, path).toBe("/admin");
      const nav = screen.getByRole("navigation", { name: "Main" });
      expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual(["Administration"]);
      expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
      // Nothing of a user's own: no onboarding, no wallet, no policies, no disabled banner.
      for (const call of [view.api.wallet, view.api.policies, view.api.platform]) expect(call).not.toHaveBeenCalled();
      expect(screen.queryByText(/Your account is disabled/)).toBeNull();
      cleanup();
    }
  });

  it("T-WEB-09 a person who is not an administrator gets Not found, and nothing is asked of the administration API", async () => {
    for (const path of ["/admin", "/admin/activity", "/admin/ledger", "/admin/escalations/auth_00000000-0000-4000-8000-000000000000"]) {
      const view = renderAdmin(path, { ...BOTH, admin: false });
      expect(await screen.findByRole("heading", { level: 1, name: "Not found" }), path).toBeTruthy();
      expect(adminCalls(view.api), path).toBe(0);
      cleanup();
    }
  });

  it("T-WEB-09 onboarding never stands between an administrator and the area", async () => {
    renderAdmin("/admin", { ...BOTH, onboarding: none });
    expect(await screen.findByRole("heading", { level: 1, name: "Waiting for approval" })).toBeTruthy();
    expect(window.location.pathname).toBe("/admin");
    // Not onboarded: the user's own navigation is not there yet, the administration link is.
    expect(within(screen.getByRole("navigation", { name: "Main" })).getAllByRole("link").map((a) => a.textContent)).toEqual(["Administration"]);
  });

  it("T-WEB-09 with the area off in the deployment there is nothing, even for a token that says administrator", async () => {
    const view = renderAdmin("/admin", BOTH, {}, { config: { ...CONFIG, admin: { available: false } } });
    expect(await screen.findByRole("heading", { level: 1, name: "Not found" })).toBeTruthy();
    expect(within(screen.getByRole("navigation", { name: "Main" })).queryByRole("link", { name: "Administration" })).toBeNull();
    expect(adminCalls(view.api)).toBe(0);
  });

  it("T-WEB-09 resolveRoute (pure): /admin paths are never redirected; an administrator-only person has only /admin", () => {
    const user = { user: true, admin: false };
    const both = { user: true, admin: true };
    const adminOnly = { user: false, admin: true };
    for (const path of ["/admin", "/admin/", "/admin/activity", "/admin/ledger", "/admin/escalations/auth_x"]) {
      for (const who of [user, both, adminOnly]) expect(resolveRoute(path, none, who), path).toBe(path);
    }
    for (const path of ["/", "/wallet", "/policies/new", "/onboarding/profile", "/nowhere"]) expect(resolveRoute(path, none, adminOnly), path).toBe("/admin");
    // A user, administrator or not, keeps every rule of 013; the two-argument form is unchanged.
    expect(resolveRoute("/wallet", none, both)).toBe("/onboarding/profile");
    expect(resolveRoute("/wallet", none)).toBe("/onboarding/profile");
    expect(resolveRoute("/administrator", all, both)).toBe("/administrator");
  });
});

describe("T-WEB-10 the waiting list (US1, FR-007..FR-010, NFR-008)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
  const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
  const rows = () => screen.getAllByRole("row").slice(1);

  it("T-WEB-10 the table: a caption, column headers, and each payment's reference, owner, seller, amount and time left", async () => {
    const own = escalation({ owner: { userId: DANA, platformAccount: false }, mine: true });
    const alices = escalation({ amountAtomic: "70000", expiresAt: iso(T0 + 252_000) });
    const platform = escalation({ owner: { platformAccount: true }, resourceKey: "https://api.example.test/reports/q3?fmt=pdf" });
    renderAdmin("/admin", BOTH, { pending: [own, alices, platform] });
    await settle();
    const table = screen.getByRole("table", { name: "Payments waiting for approval, oldest first" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Reference", "For", "Seller", "Amount", "Time left", "Open"]);
    const [first, second, third] = rows() as [HTMLElement, HTMLElement, HTMLElement];
    expect(within(first).getByText(own.referenceCode)).toBeTruthy();
    expect(within(first).getByText(MINE_TEXT)).toBeTruthy();
    expect(within(second).queryByText(MINE_TEXT)).toBeNull();
    // A user by identifier only: shortened on screen, whole for assistive technology.
    expect(within(second).getByLabelText(`User ${ALICE}`).textContent).toBe(`User ${shortUserId(ALICE)}`);
    expect(within(second).getByText("0.07 USDC")).toBeTruthy();
    expect(within(second).getByText("4 min 12 s")).toBeTruthy();
    expect(within(second).getByText("127.0.0.1:4021")).toBeTruthy();
    expect(within(second).getByText("/api/premium-report")).toBeTruthy();
    expect(within(third).getByText("Platform account")).toBeTruthy();
    expect(within(third).getByText("api.example.test")).toBeTruthy();
    expect(within(third).getByText("/reports/q3?fmt=pdf")).toBeTruthy();
    expect(within(second).getByRole("link", { name: `Review payment ${alices.referenceCode}` }).getAttribute("href")).toBe(`/admin/escalations/${alices.authorizationId}`);
    expect(screen.getByText(/^Read at /)).toBeTruthy();
  });

  it("T-WEB-10 nothing waiting says so, with when it was read", async () => {
    renderAdmin("/admin", BOTH);
    await settle();
    expect(screen.getByText(NOTHING_WAITING_TEXT)).toBeTruthy();
    expect(NOTHING_WAITING_TEXT).toBe("No payment is waiting for approval.");
    expect(screen.getByText(/^Read at /)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("T-WEB-10 the countdown ticks every second, on the portal's clock: a wrong local clock doesn't shift it", async () => {
    // This browser's clock is 90 s behind the portal's.
    vi.setSystemTime(T0 - 90_000);
    renderAdmin("/admin", BOTH, { pending: [escalation({ expiresAt: iso(T0 + 61_000) })], readAt: iso(T0) });
    await settle();
    expect(screen.getByText("1 min 1 s")).toBeTruthy();
    await advance(1000);
    expect(screen.getByText("1 min 0 s")).toBeTruthy();
    await advance(1000);
    expect(screen.getByText("under 1 min (59 s)")).toBeTruthy();
  });

  it("T-WEB-10 a refresh never moves focus: it stays on the same payment's link, and never jumps to the heading", async () => {
    const [a, b] = [escalation(), escalation()];
    const view = renderAdmin("/admin", BOTH, { pending: [a, b] });
    await settle();
    const review = (e: AdminEscalation) => screen.queryByRole("link", { name: `Review payment ${e.referenceCode}` });
    const link = review(b)!;
    act(() => link.focus());
    expect(document.activeElement).toBe(link);
    // The payment above it leaves and a new one arrives below: the focused link is the same element, still focused.
    const c = escalation();
    view.state.pending = [b, c];
    await advance(POLL_MS);
    expect(review(a)).toBeNull();
    expect(review(c)).not.toBeNull();
    expect(document.activeElement).toBe(link);
    expect(review(b)).toBe(link);
    // A refresh with nothing new leaves it alone too.
    await advance(POLL_MS);
    expect(document.activeElement).toBe(link);
    // The focused payment itself leaves: focus goes back to the document, not to the heading or another row.
    view.state.pending = [c];
    await advance(POLL_MS);
    expect(review(b)).toBeNull();
    expect(document.activeElement).toBe(document.body);
    expect(document.activeElement).not.toBe(screen.getByRole("heading", { level: 1 }));
  });

  it("T-WEB-10 at zero a row says Expired until the next refresh removes it", async () => {
    const view = renderAdmin("/admin", BOTH, { pending: [escalation({ expiresAt: iso(T0 + 2_000) })] });
    await settle();
    await advance(2000);
    expect(screen.getByText("Expired")).toBeTruthy();
    view.state.pending = [];
    view.state.readAt = iso(T0 + 3_000);
    await advance(POLL_MS);
    expect(screen.getByText(NOTHING_WAITING_TEXT)).toBeTruthy();
  });

  it("T-WEB-10 it refreshes every 3 s; a failed refresh keeps the last list and says so", async () => {
    const view = renderAdmin("/admin", BOTH, { pending: [escalation()] });
    await settle();
    expect(view.api.adminEscalations).toHaveBeenCalledTimes(1);
    await advance(POLL_MS);
    expect(view.api.adminEscalations).toHaveBeenCalledTimes(2);
    view.api.adminEscalations.mockResolvedValueOnce(refuse(502, "control_unavailable"));
    await advance(POLL_MS);
    expect(rows()).toHaveLength(1);
    expect(screen.getByText(/^Couldn't refresh\. Last read at /)).toBeTruthy();
    await advance(POLL_MS);
    expect(screen.queryByText(/^Couldn't refresh/)).toBeNull();
    expect(screen.getByText(/^Read at /)).toBeTruthy();
  });

  it("T-WEB-10 nothing is asked while the tab is hidden, and it catches up when it is visible again", async () => {
    const view = renderAdmin("/admin", BOTH, { pending: [escalation()] });
    await settle();
    act(() => setVisibility("hidden"));
    await advance(60_000);
    expect(view.api.adminEscalations).toHaveBeenCalledTimes(1);
    act(() => setVisibility("visible"));
    await settle();
    expect(view.api.adminEscalations).toHaveBeenCalledTimes(2);
  });

  it("T-WEB-10 the live region speaks once when a payment arrives, and not otherwise", async () => {
    const view = renderAdmin("/admin", BOTH, { pending: [escalation()] });
    await settle();
    const live = screen.getAllByRole("status").find((el) => el.getAttribute("aria-live") === "polite")!;
    // The first read announces nothing, and neither does a refresh with the same list.
    expect(live.textContent).toBe("");
    await advance(POLL_MS);
    expect(live.textContent).toBe("");
    view.state.pending = [...view.state.pending, escalation()];
    await advance(POLL_MS);
    expect(live.textContent).toBe("1 new payment is waiting");
    await advance(POLL_MS);
    expect(live.textContent).toBe("");
    view.state.pending = [];
    await advance(POLL_MS);
    expect(live.textContent).toBe("");
  });

  it("T-WEB-10 the phone column appears only when a phone request exists, in words", async () => {
    renderAdmin("/admin", BOTH, { pending: [escalation({ approvalRequest: "requested" }), escalation({ approvalRequest: "operator_only" })] });
    await settle();
    expect(screen.getByRole("columnheader", { name: "Phone" })).toBeTruthy();
    expect(within(rows()[0]!).getByText("Asked")).toBeTruthy();
    expect(within(rows()[1]!).getByText("Not asked")).toBeTruthy();
  });

  it("T-WEB-10 a resource address with markup is shown as text and creates no element", async () => {
    const evil = "http://127.0.0.1:4021/<img src=x onerror=alert(1)>";
    renderAdmin("/admin", BOTH, { pending: [escalation({ resourceKey: evil })] });
    await settle();
    expect(document.querySelector("main img")).toBeNull();
    expect(document.querySelector("main")!.textContent).toContain("img");
  });

  it("T-WEB-10 wording (pure): time left, amounts, owners, sellers and the phone", () => {
    // Rounded up to the next whole second, so the text never says less time than there is.
    expect([252_000, 60_000, 59_001, 59_000, 1, 0, -5].map(timeLeftText)).toEqual(["4 min 12 s", "1 min 0 s", "1 min 0 s", "under 1 min (59 s)", "under 1 min (1 s)", "Expired", "Expired"]);
    expect(usdc("50000")).toBe("0.05 USDC");
    expect(ownerText({ platformAccount: true })).toBe("Platform account");
    expect(ownerText({ userId: ALICE, platformAccount: false })).toBe("User …11112222");
    expect(sellerOf("https://api.example.test/a/b?c=1")).toEqual({ host: "api.example.test", path: "/a/b?c=1" });
    expect(sellerOf("not a url")).toEqual({ host: "not a url", path: "" });
    expect(["requested", "abandoned", "answered", "lapsed", "failed", "verification_failed", "capped", undefined].map(phoneText)).toEqual(["Asked", "Asked", "Answered", "No answer", "Failed", "Failed", "Not asked", ""]);
    expect([1, 2].map(newPaymentsText)).toEqual(["1 new payment is waiting", "2 new payments are waiting"]);
  });
});

describe("T-WEB-11 the time left on one payment runs on the portal's clock (contracts/portal-ui.md \"One payment\")", () => {
  beforeEach(() => vi.useFakeTimers());
  const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
  const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
  const buttons = () => ["Approve", "Reject"].map((name) => (screen.getByRole("button", { name }) as HTMLButtonElement).disabled);

  it("T-WEB-11 a browser clock 90 s behind: the time left is the portal's, and the buttons stop at the portal's zero", async () => {
    vi.setSystemTime(T0 - 90_000);
    const e = escalation({ expiresAt: iso(T0 + 61_000) });
    renderAdmin(`/admin/escalations/${e.authorizationId}`, ADMIN_ONLY, { pending: [e], paymentReadAt: iso(T0) });
    await settle();
    // On the browser's own clock this would read 2 min 31 s.
    expect(screen.getByText("1 min 1 s")).toBeTruthy();
    await advance(2000);
    expect(screen.getByText("under 1 min (59 s)")).toBeTruthy();
    expect(buttons()).toEqual([false, false]);
    await advance(59_000);
    expect(screen.getByText("Expired")).toBeTruthy();
    expect(buttons()).toEqual([true, true]);
  });

  it("T-WEB-11 a browser clock 90 s ahead: a payment with a minute left is not shown as expired", async () => {
    vi.setSystemTime(T0 + 90_000);
    const e = escalation({ expiresAt: iso(T0 + 61_000) });
    renderAdmin(`/admin/escalations/${e.authorizationId}`, ADMIN_ONLY, { pending: [e], paymentReadAt: iso(T0) });
    await settle();
    // On the browser's own clock it expired 29 s ago, and nobody could decide it.
    expect(screen.getByText("1 min 1 s")).toBeTruthy();
    expect(screen.queryByText("Expired")).toBeNull();
    expect(buttons()).toEqual([false, false]);
  });
});

describe("T-WEB-11 deciding one payment (US2, FR-011..FR-017)", () => {
  const far = () => iso(Date.now() + 240_000);
  const open = (e: AdminEscalation, me: Me = ADMIN_ONLY) => renderAdmin(`/admin/escalations/${e.authorizationId}`, me, { pending: [e], readAt: iso(Date.now()) });

  it("T-WEB-11 the screen shows exactly what would be decided, and the dialog repeats it before anything is sent", async () => {
    const user = userEvent.setup();
    const e = escalation({ expiresAt: far(), amountAtomic: "50000" });
    const view = open(e);
    expect(await screen.findByRole("heading", { level: 1, name: "One payment" })).toBeTruthy();
    // The heading is there while the payment loads; wait for the payment itself.
    expect(await screen.findByText(e.referenceCode)).toBeTruthy();
    expect(screen.getByText(e.payTo)).toBeTruthy();
    expect(screen.getByText("0.05 USDC")).toBeTruthy();
    expect(screen.getByLabelText(`User ${ALICE}`)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = screen.getByRole("dialog", { name: "Approve this payment?" });
    for (const text of [e.referenceCode, e.payTo, "0.05 USDC", "127.0.0.1:4021 /api/premium-report", APPROVE_TEXT]) expect(within(dialog).getByText(text), text).toBeTruthy();
    expect(within(dialog).getByLabelText(`User ${ALICE}`)).toBeTruthy();
    expect(within(dialog).getByText(/^\d min \d+ s$/)).toBeTruthy();
    expect(APPROVE_TEXT).toBe("Approve this one payment? The agent can then make it once, if it still fits the rules.");
    expect(view.api.approveEscalation).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(view.api.approveEscalation).not.toHaveBeenCalled();
  });

  it("T-WEB-11 approving sends only which payment; the outcome replaces the buttons", async () => {
    const user = userEvent.setup();
    const e = escalation({ expiresAt: far() });
    const view = open(e);
    await user.click(await screen.findByRole("button", { name: "Approve" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve payment" }));
    expect(await screen.findByText(outcomeText(approvedBy(ADMIN_ONLY.userId)))).toBeTruthy();
    expect(view.api.approveEscalation.mock.calls).toEqual([[e.authorizationId]]);
    // The screen then shows the payment as it now is, read again from the portal.
    expect(view.api.adminEscalation).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    expect(screen.getByRole("link", { name: "Back to the waiting list" }).getAttribute("href")).toBe("/admin");
  });

  it("T-WEB-11 an old sign-in: the approval waits behind a click on \"Confirm it's you\", and is then sent exactly once more", async () => {
    const user = userEvent.setup();
    const e = escalation({ expiresAt: far() });
    const view = open(e);
    view.api.approveEscalation.mockResolvedValueOnce(refuse(403, "step_up_required", { maxAgeSec: 900 }));
    await user.click(await screen.findByRole("button", { name: "Approve" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve payment" }));
    // The prompt says what the confirmation is for: an approval, not a change of the person's own.
    expect(APPROVE_STEP_UP_TEXT).toBe("Confirm it's you to approve.");
    expect(await screen.findByText(/^Confirm it's you to approve\./)).toBeTruthy();
    expect(screen.queryByText(new RegExp(`^${STEP_UP_TEXT.replace(".", "\\.")}`))).toBeNull();
    // Nothing happens by itself: a sign-in window only opens from a click.
    expect(view.auth.confirmIdentity).not.toHaveBeenCalled();
    expect(view.api.approveEscalation).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Confirm it's you" }));
    expect(await screen.findByText(outcomeText(approvedBy(ADMIN_ONLY.userId)))).toBeTruthy();
    expect(view.auth.confirmIdentity).toHaveBeenCalledTimes(1);
    expect(view.api.approveEscalation).toHaveBeenCalledTimes(2);
  });

  it("T-WEB-11 an identity that is not confirmed approves nothing, and there is no second automatic try", async () => {
    const user = userEvent.setup();
    const e = escalation({ expiresAt: far() });
    const auth = fakeAuth();
    auth.confirmIdentity.mockResolvedValue(false);
    const view = renderAdmin(`/admin/escalations/${e.authorizationId}`, ADMIN_ONLY, { pending: [e], readAt: iso(Date.now()) }, { auth });
    view.api.approveEscalation.mockResolvedValue(refuse(403, "step_up_required", { maxAgeSec: 900 }));
    await user.click(await screen.findByRole("button", { name: "Approve" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve payment" }));
    await user.click(await screen.findByRole("button", { name: "Confirm it's you" }));
    expect(await screen.findByText(STEP_UP_FAILED_TEXT)).toBeTruthy();
    expect(view.api.approveEscalation).toHaveBeenCalledTimes(1);
  });

  it("T-WEB-11 rejecting takes one of five fixed reasons, has no text field, and never asks for identity", async () => {
    const user = userEvent.setup();
    const e = escalation({ expiresAt: far() });
    const view = open(e);
    await user.click(await screen.findByRole("button", { name: "Reject" }));
    const dialog = screen.getByRole("dialog", { name: "Reject this payment?" });
    expect(within(dialog).getAllByRole("radio").map((r) => (r as HTMLInputElement).value)).toEqual(["not_expected", "amount_too_high", "wrong_seller", "duplicate", "other"]);
    for (const label of Object.values(REASON_LABELS)) expect(within(dialog).getByLabelText(label)).toBeTruthy();
    expect(dialog.querySelectorAll('input[type="text"], textarea')).toHaveLength(0);
    const send = within(dialog).getByRole("button", { name: "Reject payment" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await user.click(within(dialog).getByLabelText("The amount is too high"));
    expect(send.disabled).toBe(false);
    await user.click(send);
    expect(await screen.findByText(`${outcomeText(rejectedBy(ADMIN_ONLY.userId))} Reason: The amount is too high`)).toBeTruthy();
    expect(view.api.rejectEscalation.mock.calls).toEqual([[e.authorizationId, "amount_too_high"]]);
    expect(view.auth.confirmIdentity).not.toHaveBeenCalled();
  });

  it("T-WEB-11 one's own payment: seen, said to be one's own, and no way to decide it", async () => {
    const e = escalation({ expiresAt: far(), owner: { userId: DANA, platformAccount: false }, mine: true });
    const view = open(e, BOTH);
    expect(await screen.findByText(OWN_PAYMENT_TEXT)).toBeTruthy();
    expect(OWN_PAYMENT_TEXT).toContain("Another administrator, the operator or the phone approver can decide it.");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    expect(view.api.approveEscalation).not.toHaveBeenCalled();
  });

  it("T-WEB-11 an unknown payment says so, with the way back", async () => {
    renderAdmin(`/admin/escalations/${escalation().authorizationId}`, ADMIN_ONLY, { pending: [] });
    expect(await screen.findByText(NO_SUCH_PAYMENT_TEXT)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByRole("link", { name: "Back to the waiting list" })).toBeTruthy();
  });

  it("T-WEB-11 each refusal says what happened, in words, and nothing is shown as decided", async () => {
    const cases: Array<[ReturnType<typeof refuse>, string]> = [
      [refuse(409, "not_pending", { state: "denied", channel: "operator", decidedBy: "ops" }), "This payment was already rejected, from the command line."],
      [refuse(409, "not_pending", { state: "approved", channel: "backchannel", decidedBy: "auth0|x" }), "This payment was already approved, by phone."],
      [refuse(409, "not_pending", { state: "expired" }), "This payment expired before it was decided."],
      [refuse(403, "own_payment"), "You can't decide your own payment."],
      [refuse(502, "control_unavailable"), "The payment service can't be reached right now. Nothing was changed. Try again in a moment."],
    ];
    for (const [answer, text] of cases) {
      const user = userEvent.setup();
      const e = escalation({ expiresAt: far() });
      const view = open(e);
      view.api.approveEscalation.mockResolvedValueOnce(answer);
      await user.click(await screen.findByRole("button", { name: "Approve" }));
      await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve payment" }));
      expect((await screen.findByRole("alert")).textContent, text).toBe(text);
      expect(screen.queryByText(/^Approved in the portal/)).toBeNull();
      cleanup();
    }
  });

  it("T-WEB-11 a repeat that finds it already decided says so, with who decided and where", async () => {
    const user = userEvent.setup();
    const e = escalation({ expiresAt: far() });
    const view = open(e);
    view.api.approveEscalation.mockImplementationOnce(async () => {
      // The operator got there first: the payment is approved, by them, and this request recorded nothing.
      view.state.pending = [];
      view.state.ended[e.authorizationId] = { ...e, state: "approved", decision: { at: iso(T0), channel: "operator", decidedBy: "ops-jane" }, budget: budgetOf() };
      return { ok: true, data: approvedBy("ops-jane", { already: true, channel: "operator" }) };
    });
    await user.click(await screen.findByRole("button", { name: "Approve" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve payment" }));
    expect(await screen.findByText(/^Approved from the command line by ops-jane\. It was already decided; nothing new was recorded\.$/)).toBeTruthy();
  });

  it("T-WEB-11 outcome wording (pure): the path and the decider, an identifier shortened", () => {
    expect(outcomeText({ state: "approved", channel: "portal", decidedBy: CAROL })).toBe("Approved in the portal by …55556666.");
    expect(outcomeText({ state: "denied", channel: "operator", decidedBy: "ops" })).toBe("Rejected from the command line by ops.");
    expect(outcomeText({ state: "approved", channel: "backchannel", decidedBy: "auth0|x" })).toBe("Approved by phone by auth0|x.");
  });
});

describe("T-WEB-12 the activity trail (US3, FR-020, FR-021)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
  const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
  const happened = () => screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[4]!.textContent);

  it("T-WEB-12 newest first, each step in words, a decision with its path and who decided", async () => {
    const events = [
      event(1, { userId: ALICE }),
      event(2, { kind: "approval_requested" }),
      event(3, { kind: "approved", channel: "portal", decidedBy: CAROL, userId: ALICE }),
      event(4, { kind: "denied", channel: "portal", decidedBy: CAROL, reasonCode: "amount_too_high" }),
      event(5, { kind: "denied", channel: "operator", decidedBy: "ops-jane", operator: "ops-jane", reason: "not today" }),
      event(6, { kind: "approved", channel: "backchannel", decidedBy: "auth0|approver-1" }),
      event(7, { kind: "expired" }),
      event(8, { kind: "approval_lapsed" }),
      event(9, { kind: "approval_request_failed", mine: true, userId: DANA }),
    ];
    renderAdmin("/admin/activity", BOTH, { events });
    await settle();
    expect(screen.getByRole("heading", { level: 1, name: "Activity" })).toBeTruthy();
    expect(screen.getByRole("table", { name: "What happened to each payment that needed approval, newest first" })).toBeTruthy();
    expect(happened()).toEqual([
      "Phone request failed",
      "Approval not used in time",
      "Expired",
      "Approved by phone by auth0|approver-1",
      "Rejected from the command line by ops-jane: not today",
      "Rejected in the portal by …55556666: The amount is too high",
      "Approved in the portal by …55556666",
      "Phone request sent",
      "Asked for approval",
    ]);
    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]!).getByText("Your payment")).toBeTruthy();
    expect(within(rows[8]!).getByLabelText(`User ${ALICE}`)).toBeTruthy();
    expect(within(rows[7]!).getByText("Platform account")).toBeTruthy();
    expect(within(rows[8]!).getByText(events[0]!.referenceCode!)).toBeTruthy();
    expect(within(rows[8]!).getByText("0.05 USDC")).toBeTruthy();
  });

  it("T-WEB-12 nothing yet says so", async () => {
    renderAdmin("/admin/activity", ADMIN_ONLY);
    await settle();
    expect(screen.getByText(NO_ACTIVITY_TEXT)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show earlier" })).toBeNull();
  });

  it("T-WEB-12 fifty at a time: \"Show earlier\" reads back from the oldest shown, and is offered only while more exist", async () => {
    const events = Array.from({ length: 120 }, (_, i) => event(i + 1));
    const view = renderAdmin("/admin/activity", ADMIN_ONLY, { events });
    await settle();
    expect(screen.getAllByRole("row")).toHaveLength(1 + PAGE_SIZE);
    expect(view.api.adminEvents.mock.calls[0]).toEqual([{ limit: 50 }]);
    await act(async () => screen.getByRole("button", { name: "Show earlier" }).click());
    await settle();
    expect(view.api.adminEvents).toHaveBeenLastCalledWith({ before: 71, limit: 50 });
    expect(screen.getAllByRole("row")).toHaveLength(1 + 100);
    await act(async () => screen.getByRole("button", { name: "Show earlier" }).click());
    await settle();
    expect(view.api.adminEvents).toHaveBeenLastCalledWith({ before: 21, limit: 50 });
    expect(screen.getAllByRole("row")).toHaveLength(1 + 120);
    expect(screen.queryByRole("button", { name: "Show earlier" })).toBeNull();
    // Every event exactly once.
    const refs = screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[1]!.textContent);
    expect(new Set(refs).size).toBe(120);
  });

  it("T-WEB-12 while open it asks for what came after the last read, every 5 s, and adds it at the top", async () => {
    const events = [event(1), event(2)];
    const view = renderAdmin("/admin/activity", ADMIN_ONLY, { events });
    await settle();
    await advance(TRAIL_POLL_MS);
    expect(view.api.adminEvents).toHaveBeenLastCalledWith({ after: 2, limit: 50 });
    expect(screen.getAllByRole("row")).toHaveLength(1 + 2);
    view.state.events.push(event(3, { kind: "approved", channel: "portal", decidedBy: CAROL }));
    await advance(TRAIL_POLL_MS);
    expect(happened()[0]).toBe("Approved in the portal by …55556666");
    expect(screen.getAllByRole("row")).toHaveLength(1 + 3);
    await advance(TRAIL_POLL_MS);
    expect(view.api.adminEvents).toHaveBeenLastCalledWith({ after: 3, limit: 50 });
    expect(screen.getAllByRole("row")).toHaveLength(1 + 3);
  });

  it("T-WEB-12 a burst larger than a page is read to the end, in order, each event once", async () => {
    const events = [event(1)];
    const view = renderAdmin("/admin/activity", ADMIN_ONLY, { events });
    await settle();
    for (let seq = 2; seq <= 131; seq++) view.state.events.push(event(seq));
    await advance(TRAIL_POLL_MS);
    expect(screen.getAllByRole("row")).toHaveLength(1 + 131);
    const calls = view.api.adminEvents.mock.calls.slice(1).map(([q]) => q);
    expect(calls).toEqual([
      { after: 1, limit: 50 },
      { after: 51, limit: 50 },
      { after: 101, limit: 50 },
    ]);
  });

  it("T-WEB-12 what arrives while the screen is open is marked New; what was already there is not", async () => {
    const view = renderAdmin("/admin/activity", ADMIN_ONLY, { events: [event(1), event(2)] });
    await settle();
    expect(screen.queryByText("New")).toBeNull();
    view.state.events.push(event(3), event(4));
    await advance(TRAIL_POLL_MS);
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).queryByText("New") !== null)).toEqual([true, true, false, false]);
    // A later refresh with nothing new keeps the two marks and adds none.
    await advance(TRAIL_POLL_MS);
    expect(screen.getAllByText("New")).toHaveLength(2);
  });

  it("T-WEB-12 nothing is kept in the browser between visits: the web app stores nothing of its own (T-WEB-07)", async () => {
    const view = renderAdmin("/admin/activity", ADMIN_ONLY, { events: [event(1), event(2)] });
    await settle();
    view.state.events.push(event(3));
    await advance(TRAIL_POLL_MS);
    expect(screen.getAllByText("New")).toHaveLength(1);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    cleanup();
    // The next visit starts clean: everything that already happened is simply the trail.
    renderAdmin("/admin/activity", ADMIN_ONLY, { events: [event(1), event(2), event(3)] });
    await settle();
    expect(screen.queryByText("New")).toBeNull();
  });

  it("T-WEB-12 what an operator typed is shown as text and creates no element", async () => {
    const typed = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    renderAdmin("/admin/activity", ADMIN_ONLY, { events: [event(1, { kind: "denied", channel: "operator", decidedBy: "<b>ops</b>", operator: "<b>ops</b>", reason: typed })] });
    await settle();
    expect(happened()).toEqual([`Rejected from the command line by <b>ops</b>: ${typed}`]);
    const main = document.querySelector("main")!;
    expect(main.querySelector("img, script, b")).toBeNull();
  });

  it("T-WEB-12 a failed read says so and keeps what is shown", async () => {
    const view = renderAdmin("/admin/activity", ADMIN_ONLY, { events: [event(1)] });
    await settle();
    view.api.adminEvents.mockResolvedValueOnce(refuse(502, "control_unavailable"));
    await advance(TRAIL_POLL_MS);
    expect(screen.getByRole("alert").textContent).toContain("can't be reached");
    expect(screen.getAllByRole("row")).toHaveLength(2);
    await advance(TRAIL_POLL_MS);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("T-WEB-12 event wording (pure)", () => {
    expect(eventText({ kind: "approved", channel: "operator", decidedBy: "ops" })).toBe("Approved from the command line by ops");
    expect(eventText({ kind: "denied", channel: "portal", decidedBy: CAROL, reasonCode: "duplicate" })).toBe("Rejected in the portal by …55556666: It is a duplicate");
    expect(eventText({ kind: "denied", channel: "backchannel", decidedBy: "auth0|x" })).toBe("Rejected by phone by auth0|x");
    expect(eventText({ kind: "approval_request_lapsed" })).toBe("Phone request not answered");
    expect(eventText({ kind: "approval_verification_failed" })).toBe("Phone answer not accepted");
    expect(eventText({ kind: "something_new" as never })).toBe("something_new");
  });
});

describe("T-WEB-11 one payment in any state, and the budget behind it (US4, FR-022..FR-024)", () => {
  const far = () => iso(Date.now() + 240_000);
  const show = (e: AdminEscalation, a: Partial<AdminWorld> = {}) => renderAdmin(`/admin/escalations/${e.authorizationId}`, ADMIN_ONLY, { pending: [e], ...a });
  const cells = (label: string) => within(screen.getByRole("row", { name: new RegExp(`^${label}`) })).getAllByRole("cell").map((c) => c.textContent);

  it("T-WEB-11 the budget table: this run, the last 24 hours under the policy, and the user's last 24 hours", async () => {
    show(escalation({ expiresAt: far() }));
    expect(await screen.findByRole("table", { name: "The budget this payment counts against" })).toBeTruthy();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Budget", "Spent", "Limit", "Left"]);
    expect(cells("This agent run")).toEqual(["0.03 USDC", "0.10 USDC", "0.07 USDC"]);
    expect(cells("Last 24 hours, under this policy")).toEqual(["0.04 USDC", "0.50 USDC", "0.46 USDC"]);
    expect(cells("Last 24 hours, all of this user's policies")).toEqual(["0.045 USDC", "0.50 USDC", "0.455 USDC"]);
    expect(screen.queryByText(WILL_NOT_FIT_TEXT)).toBeNull();
  });

  it("T-WEB-11 the platform account's payment has two lines and no user line", async () => {
    show(escalation({ expiresAt: far(), owner: { platformAccount: true } }));
    expect(await screen.findByRole("row", { name: /^Last 24 hours, platform account/ })).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(1 + 2);
    expect(screen.queryByText(/all of this user's policies/)).toBeNull();
  });

  it("T-WEB-11 more than what is left: a warning, and the buttons stay", async () => {
    const e = escalation({ expiresAt: far() });
    show(e, { budgets: { [e.authorizationId]: budgetOf({ run: line("100000", "80000"), fits: false }) } });
    expect(await screen.findByText(WILL_NOT_FIT_TEXT)).toBeTruthy();
    expect(WILL_NOT_FIT_TEXT).toBe("Approving this will not make it payable: it is more than what is left.");
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
  });

  it("T-WEB-11 no rules apply right now: each reason in words", async () => {
    const zero = line("0", "0");
    for (const reason of ["no_active_policy", "user_disabled", "user_not_onboarded"] as const) {
      const e = escalation({ expiresAt: far() });
      show(e, { budgets: { [e.authorizationId]: budgetOf({ applies: false, notApplying: reason, run: zero, day: zero, userDay: zero, fits: false }) } });
      expect(await screen.findByText(NOT_APPLYING_TEXT[reason]!), reason).toBeTruthy();
      expect(screen.queryByText(WILL_NOT_FIT_TEXT)).toBeNull();
      cleanup();
    }
    expect(NOT_APPLYING_TEXT.no_active_policy).toBe("No rule set of this user allows this seller right now, so approving will not make it payable.");
  });

  it("T-WEB-11 a payment that already ended: how, on which path and by whom; no countdown and no buttons", async () => {
    const base = escalation({ expiresAt: iso(T0 + 300_000) });
    const cases: Array<[Partial<Ended>, RegExp]> = [
      [{ state: "approved", decision: { at: iso(T0), channel: "portal", decidedBy: CAROL } }, /^Approved in the portal by …55556666\.$/],
      [{ state: "denied", decision: { at: iso(T0), channel: "operator", decidedBy: "ops", reason: "<i>not today</i>" } }, /^Rejected from the command line by ops\. Reason: <i>not today<\/i>$/],
      [{ state: "approved", decision: { at: iso(T0), channel: "backchannel", decidedBy: "auth0|approver-1" } }, /^Approved by phone by auth0\|approver-1\.$/],
      [{ state: "denied", decision: { at: iso(T0), channel: "portal", decidedBy: CAROL, reasonCode: "duplicate" } }, /^Rejected in the portal by …55556666\. Reason: It is a duplicate$/],
      [{ state: "expired" }, /^Expired at /],
    ];
    for (const [over, text] of cases) {
      renderAdmin(`/admin/escalations/${base.authorizationId}`, ADMIN_ONLY, { ended: { [base.authorizationId]: { ...base, state: "pending", budget: budgetOf(), ...over } as Ended } });
      expect(await screen.findByText(text), String(text)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
      expect(screen.queryByText("Time left")).toBeNull();
      expect(screen.getByRole("table", { name: "The budget this payment counts against" })).toBeTruthy();
      expect(document.querySelector("main i")).toBeNull();
      cleanup();
    }
  });

  it("T-WEB-11 an activity row opens the payment's screen", async () => {
    const e = event(7, { kind: "approved", channel: "portal", decidedBy: CAROL });
    renderAdmin("/admin/activity", ADMIN_ONLY, { events: [e] });
    const link = await screen.findByRole("link", { name: `Payment ${e.referenceCode!}` });
    expect(link.getAttribute("href")).toBe(`/admin/escalations/${e.authorizationId}`);
  });

  it("T-WEB-11 a failed read says so and offers the way back", async () => {
    const e = escalation();
    const w = world("done");
    w.me = ADMIN_ONLY;
    const api = adminApi(w, { pending: [e], readAt: iso(T0), events: [], ended: {}, budgets: {}, ledger: { entries: 1, ok: true, checkedAt: iso(T0) } });
    api.adminEscalation.mockResolvedValue(refuse(502, "control_unavailable"));
    renderAdmin(`/admin/escalations/${e.authorizationId}`, ADMIN_ONLY, {}, { api });
    expect((await screen.findByRole("alert")).textContent).toContain("can't be reached");
    expect(screen.getByRole("link", { name: "Back to the waiting list" })).toBeTruthy();
  });

  it("T-WEB-11 ended wording (pure)", () => {
    expect(endedText({ state: "approved", expiresAt: iso(T0), decision: { at: iso(T0), channel: "portal", decidedBy: CAROL } })).toBe("Approved in the portal by …55556666.");
    expect(endedText({ state: "expired", expiresAt: iso(T0) })).toMatch(/^Expired at /);
  });
});

describe("T-WEB-12 the ledger check (US5, FR-025, FR-026)", () => {
  it("T-WEB-12 nothing is asked until the button is pressed; then the count, that it verifies, and when", async () => {
    const user = userEvent.setup();
    const view = renderAdmin("/admin/ledger", ADMIN_ONLY);
    expect(await screen.findByRole("heading", { level: 1, name: "Ledger check" })).toBeTruthy();
    expect(view.api.adminLedgerCheck).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Check the ledger" }));
    const text = verifiedText(view.state.ledger);
    expect(await screen.findByText(text)).toBeTruthy();
    expect(text).toMatch(/^The ledger verifies\. 1,284 entries\. Checked at /);
    expect(view.api.adminLedgerCheck).toHaveBeenCalledTimes(1);
  });

  it("T-WEB-12 a broken chain: where it breaks, that the operator must act, and nothing to repair it with", async () => {
    const user = userEvent.setup();
    const view = renderAdmin("/admin/ledger", ADMIN_ONLY, { ledger: { entries: 1284, ok: false, brokenAt: 311, checkedAt: iso(T0) } });
    await user.click(await screen.findByRole("button", { name: "Check the ledger" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(brokenText(view.state.ledger));
    expect(alert.textContent).toMatch(/^The ledger does not verify from entry 311\. The operator must act\. Nothing can be repaired here\. 1,284 entries\. Checked at /);
    // The screen offers the check and nothing else.
    expect(within(document.querySelector("main")!).getAllByRole("button").map((b) => b.textContent)).toEqual(["Check the ledger"]);
  });

  it("T-WEB-12 a failed check says so and keeps the last result", async () => {
    const user = userEvent.setup();
    const view = renderAdmin("/admin/ledger", ADMIN_ONLY);
    await user.click(await screen.findByRole("button", { name: "Check the ledger" }));
    await screen.findByText(verifiedText(view.state.ledger));
    view.api.adminLedgerCheck.mockResolvedValueOnce(refuse(502, "control_unavailable"));
    await user.click(screen.getByRole("button", { name: "Check the ledger" }));
    expect((await screen.findByRole("alert")).textContent).toContain("can't be reached");
    expect(screen.getByText(verifiedText(view.state.ledger))).toBeTruthy();
  });

  it("T-WEB-12 the sub-navigation marks the screen a person is on, and links the others", async () => {
    renderAdmin("/admin/ledger", ADMIN_ONLY);
    const nav = await screen.findByRole("navigation", { name: "Administration" });
    expect(within(nav).getByText("Ledger check").getAttribute("aria-current")).toBe("page");
    expect(within(nav).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Waiting", "/admin"],
      ["Activity", "/admin/activity"],
    ]);
  });
});

describe("T-WEB-12 an automated accessibility pass over the administration area (NFR-008)", () => {
  /** Runs axe on the whole document. Contrast is not checked here: jsdom lays nothing out (T-WEB-08 checks the stylesheet's colors). */
  async function violations(): Promise<string[]> {
    document.documentElement.lang = "en";
    document.title = "x402 portal";
    const result = await axe.run(document, { rules: { "color-contrast": { enabled: false } } });
    return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 120)).join(" | ")}`);
  }
  const far = () => iso(Date.now() + 240_000);

  it("T-WEB-12 the waiting list, with its own payment and a phone request, and when it is empty", async () => {
    renderAdmin("/admin", BOTH, { pending: [escalation({ expiresAt: far(), mine: true, owner: { userId: DANA, platformAccount: false } }), escalation({ expiresAt: far(), approvalRequest: "requested" })], readAt: iso(Date.now()) });
    await screen.findByRole("table");
    expect(await violations()).toEqual([]);
    cleanup();
    renderAdmin("/admin", ADMIN_ONLY);
    await screen.findByText(NOTHING_WAITING_TEXT);
    expect(await violations()).toEqual([]);
  });

  it("T-WEB-12 one payment: pending with a warning, each dialog open, one's own, and ended", async () => {
    const user = userEvent.setup();
    const e = escalation({ expiresAt: far() });
    renderAdmin(`/admin/escalations/${e.authorizationId}`, ADMIN_ONLY, { pending: [e], budgets: { [e.authorizationId]: budgetOf({ fits: false }) } });
    await screen.findByText(WILL_NOT_FIT_TEXT);
    expect(await violations()).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(await violations()).toEqual([]);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(await violations()).toEqual([]);
    cleanup();

    const own = escalation({ expiresAt: far(), mine: true, owner: { userId: DANA, platformAccount: false } });
    renderAdmin(`/admin/escalations/${own.authorizationId}`, BOTH, { pending: [own] });
    await screen.findByText(OWN_PAYMENT_TEXT);
    expect(await violations()).toEqual([]);
    cleanup();

    const done = escalation();
    renderAdmin(`/admin/escalations/${done.authorizationId}`, ADMIN_ONLY, { ended: { [done.authorizationId]: { ...done, state: "denied", decision: { at: iso(T0), channel: "portal", decidedBy: CAROL, reasonCode: "other" }, budget: budgetOf() } } });
    await screen.findByText(/^Rejected in the portal/);
    expect(await violations()).toEqual([]);
  });

  it("T-WEB-12 the activity trail and the ledger check, in each result", async () => {
    const user = userEvent.setup();
    renderAdmin("/admin/activity", BOTH, { events: [event(1), event(2, { kind: "denied", channel: "operator", decidedBy: "ops", reason: "no" }), event(3, { kind: "approved", channel: "portal", decidedBy: CAROL, mine: true, userId: DANA })] });
    await screen.findByRole("table");
    expect(await violations()).toEqual([]);
    cleanup();

    for (const ledger of [{ entries: 12, ok: true, checkedAt: iso(T0) }, { entries: 12, ok: false, brokenAt: 3, checkedAt: iso(T0) }]) {
      renderAdmin("/admin/ledger", ADMIN_ONLY, { ledger });
      await user.click(await screen.findByRole("button", { name: "Check the ledger" }));
      await screen.findByText(/^The ledger (verifies|does not verify)/);
      expect(await violations()).toEqual([]);
      cleanup();
    }
  });
});
