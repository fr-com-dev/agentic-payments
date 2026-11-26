// @vitest-environment jsdom
// 013 US2 web and T-WEB-06 (specs/013 FR-013, FR-015, FR-016, FR-018..FR-022): the wallet step and screen show the
// account's public address and figures and no way to move funds out; cards are saved for later, never to pay, and
// the card's number never passes through the app.
// 020 T-WEB-17, T-WEB-18, T-WEB-20, T-WEB-21 (specs/020 contracts/portal-ui.md "The wallet: two parts"): the account
// the agent pays from comes first and never waits for Coinbase; Coinbase is a view-only part beside it, connected in
// the same tab, shown from decimal strings and disconnected after a confirmation.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "../src/api.js";
import {
  AGENT_PAYS_TITLE,
  BALANCES_UNREADABLE_TEXT,
  COINBASE_CONNECTIONS_URL,
  COINBASE_PART_TITLE,
  COINBASE_READ_ONLY_TEXT,
  COINBASE_RECONNECT_TEXT,
  COINBASE_UNAVAILABLE_TEXT,
  DISCONNECTED_TEXT,
  DISCONNECT_TEXT,
  GOING_TO_COINBASE_TEXT,
  NOT_REVOKED_TEXT,
  NO_RATE_TEXT,
} from "../src/messages.js";
import { CARD_NOTICE } from "../src/screens/Wallet.js";
import type { BalancesAnswer, Connection, Wallet as WalletData } from "../src/types.js";
import {
  ADDRESS,
  AUTHORIZE_URL,
  PRIVACY_URL,
  SUPPORT_URL,
  account,
  card,
  coinbaseBalances,
  coinbaseRow,
  fakeApi,
  refuse,
  renderApp,
  stubLeaving,
  world,
  type World,
} from "./helpers.js";

/** The registered cards, one list item each; none when the list is not shown. */
const cardRows = () => {
  const list = screen.queryByRole("list", { name: "Your cards" });
  return list ? within(list).getAllByRole("listitem") : [];
};
/** The value shown for a figure, by its label. */
const figure = (label: string) => screen.getAllByText(label)[0]!.nextElementSibling!.textContent!;

describe("013 US2 web: the wallet step", () => {
  it("one button, then the address with a copy control, the network, the asset, the balance and how to fund it", async () => {
    const user = userEvent.setup();
    const view = renderApp("/", world("profile"));
    expect(await screen.findByRole("heading", { level: 1, name: "Create your wallet" })).toBeTruthy();
    const main = within(screen.getByRole("main"));
    expect(main.getAllByRole("button").map((b) => b.textContent)).toEqual(["Create my wallet"]);
    await user.click(main.getByRole("button", { name: "Create my wallet" }));
    expect(await main.findByRole("button", { name: "Copy address" })).toBeTruthy();
    expect(main.getAllByText(ADDRESS).length).toBe(2);
    expect(main.getAllByText("the local test network").length).toBeGreaterThan(0);
    expect(main.getByText("USDC (test)")).toBeTruthy();
    expect(figure("Balance")).toMatch(/^0\.00 USDC/);
    expect(main.getByText(/To fund it, send test USDC on the local test network to this address:/).textContent).toContain(ADDRESS);
    expect(view.api.createAccount).toHaveBeenCalledTimes(1);
    await user.click(main.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Write your first expense policy" })).toBeTruthy();
  });

  it("a retry after a failure shows the same address", async () => {
    const user = userEvent.setup();
    const w = world("profile");
    const api = fakeApi(w);
    api.createAccount.mockResolvedValueOnce(refuse(502, "control_unavailable"));
    renderApp("/", w, { api });
    const create = await screen.findByRole("button", { name: "Create my wallet" });
    await user.click(create);
    expect(await screen.findByText(/payment service can't be reached right now/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Create my wallet" }));
    await waitFor(() => expect(screen.getAllByText(ADDRESS).length).toBe(2));
    expect(api.createAccount).toHaveBeenCalledTimes(2);
  });

  it("on Base Sepolia the funding sentence names the faucet", async () => {
    const w = world("wallet", { wallet: { account: account({ network: "eip155:84532" }), cards: [], cardsAvailable: true, disabled: false } });
    renderApp("/wallet", w);
    expect((await screen.findByText(/To fund it, send test USDC on Base Sepolia \(testnet\)/)).textContent).toContain("faucet.circle.com");
  });
});

describe("013 US2 web: the wallet screen", () => {
  it("shows the balance with its time, what is committed, and spending next to the daily ceiling", async () => {
    const w = world("done", {
      wallet: { account: account({ balanceAtomic: "2500000", committedAtomic: "30000", spent24hAtomic: "10000" }), cards: [], cardsAvailable: true, disabled: false },
    });
    renderApp("/wallet", w);
    await screen.findByText("Copy address");
    expect(figure("Balance")).toBe("2.50 USDC as of 2026-11-10 12:00:00 UTC");
    expect(screen.queryByText(/couldn't refresh/)).toBeNull();
    expect(figure("Committed to payments that can still settle")).toBe("0.03 USDC");
    expect(figure("Spent in the last 24 hours")).toBe("0.01 of 0.50 USDC (your daily ceiling)");
    expect(screen.queryByText(/lower than what one of your policies allows/)).toBeNull();
  });

  it("says so when the balance is stale, missing or low", async () => {
    const w = world("done", { wallet: { account: account({ balanceStale: true, lowBalance: true }), cards: [], cardsAvailable: true, disabled: false } });
    const view = renderApp("/wallet", w);
    expect(await screen.findByText(/couldn't refresh/)).toBeTruthy();
    expect(screen.getByText(/lower than what one of your policies allows per payment/)).toBeTruthy();
    view.unmount();
    const { balanceAtomic: _b, balanceReadAt: _r, ...unread } = account();
    renderApp("/wallet", world("done", { wallet: { account: unread, cards: [], cardsAvailable: true, disabled: false } }));
    expect(await screen.findByText("Couldn't read the balance right now")).toBeTruthy();
  });

  it("has no control that moves funds out", async () => {
    renderApp("/wallet", world("done", { wallet: { account: account({ balanceAtomic: "2500000" }), cards: [card(1)], cardsAvailable: true, disabled: false } }));
    await waitFor(() => expect(cardRows().length).toBe(1));
    const controls = [...screen.getAllByRole("button"), ...screen.getAllByRole("link")].map((c) => c.textContent ?? "");
    for (const text of controls) expect(/\b(send|withdraw|transfer|pay out|move|cash out)\b/i.test(text), text).toBe(false);
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

describe("T-WEB-06: cards", () => {
  const withCards = (n: number, over: Partial<{ cardsAvailable: boolean; disabled: boolean }> = {}) =>
    world("done", { wallet: { account: account(), cards: Array.from({ length: n }, (_, i) => card(i + 1)), cardsAvailable: true, disabled: false, ...over } });

  it("the notice is there with and without cards", async () => {
    expect(CARD_NOTICE).toBe("Agents can't pay with cards yet. A card here is saved for later.");
    const view = renderApp("/wallet", withCards(0));
    expect(await screen.findByText(CARD_NOTICE)).toBeTruthy();
    expect(screen.getByText("No card is registered.")).toBeTruthy();
    view.unmount();
    renderApp("/wallet", withCards(2));
    expect(await screen.findByText(CARD_NOTICE)).toBeTruthy();
    await waitFor(() => expect(cardRows().length).toBe(2));
  });

  it("Add a card is disabled with its reason at 5 cards, when cards are unavailable and when the account is disabled", async () => {
    const reasonOf = async (text: string) => {
      const add = (await screen.findByRole("button", { name: "Add a card" })) as HTMLButtonElement;
      await waitFor(() => expect(add.disabled).toBe(true));
      expect(document.getElementById(add.getAttribute("aria-describedby")!)!.textContent).toBe(text);
    };
    let view = renderApp("/wallet", withCards(5));
    await reasonOf("You can register at most 5 cards.");
    view.unmount();
    view = renderApp("/wallet", withCards(1, { cardsAvailable: false }));
    await reasonOf("Cards are not available right now.");
    view.unmount();
    const w = withCards(1);
    w.me = { ...w.me, enabled: false };
    w.wallet = { ...w.wallet, disabled: true };
    view = renderApp("/wallet", w);
    await reasonOf("Your account is disabled.");
    view.unmount();
    renderApp("/wallet", withCards(4));
    const add = (await screen.findByRole("button", { name: "Add a card" })) as HTMLButtonElement;
    await waitFor(() => expect(cardRows().length).toBe(4));
    expect(add.disabled).toBe(false);
  });

  it("an expired card says Expired, in words", async () => {
    const w = withCards(1);
    w.wallet = { ...w.wallet, cards: [card(1, { expired: true, expYear: 2025 }), card(2)] };
    renderApp("/wallet", w);
    await waitFor(() => expect(cardRows().length).toBe(2));
    expect(within(cardRows()[0]!).getByText("Expired")).toBeTruthy();
    expect(within(cardRows()[1]!).queryByText("Expired")).toBeNull();
  });

  it("adds a card through the vault's own fields: only the setup reference and the nickname reach the portal", async () => {
    const user = userEvent.setup();
    const view = renderApp("/wallet", withCards(0));
    await user.click(await screen.findByRole("button", { name: "Add a card" }));
    expect(await screen.findByText("[the card vault's own fields]")).toBeTruthy();
    // The app's own form has one field, the nickname: no number, expiry or code field of its own.
    expect(screen.getAllByRole("textbox").map((t) => t.id)).toEqual(["card-nickname"]);
    await user.type(screen.getByLabelText("Nickname (optional)"), "Travel");
    await waitFor(() => expect((screen.getByRole("button", { name: "Save card" }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole("button", { name: "Save card" }));
    await waitFor(() => expect(cardRows().length).toBe(1));
    expect(cardRows()[0]!.textContent).toContain("Travel");
    expect(view.api.cardSetup).toHaveBeenCalledTimes(1);
    expect(view.api.confirmCard.mock.calls).toEqual([["seti_1", "Travel"]]);
  });

  it("a vault failure shows one sentence and the rest of the page still works", async () => {
    const user = userEvent.setup();
    const w = withCards(1);
    const api = fakeApi(w);
    api.cardSetup.mockResolvedValueOnce(refuse(503, "card_vault_unavailable"));
    renderApp("/wallet", w, { api });
    await user.click(await screen.findByRole("button", { name: "Add a card" }));
    expect(await screen.findByText("The card could not be added. Try again later.")).toBeTruthy();
    // Nothing else failed: the account, the notice and the registered card are all still there.
    expect(screen.getAllByText(ADDRESS).length).toBe(2);
    expect(screen.getByText(CARD_NOTICE)).toBeTruthy();
    expect(cardRows().length).toBe(1);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Add a card" })).toBeTruthy();
    expect(api.confirmCard).not.toHaveBeenCalled();
  });

  it("a card the vault did not accept is not registered", async () => {
    const user = userEvent.setup();
    const w = withCards(0);
    const api = fakeApi(w);
    api.confirmCard.mockResolvedValueOnce(refuse(409, "card_not_confirmed", { vaultCode: "card_declined" }));
    renderApp("/wallet", w, { api });
    await user.click(await screen.findByRole("button", { name: "Add a card" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Save card" }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole("button", { name: "Save card" }));
    expect(await screen.findByText("The card was not accepted. Check its details or try another card.")).toBeTruthy();
    expect(cardRows().length).toBe(0);
  });

  it("Remove asks to confirm, and only then the card leaves the list", async () => {
    const user = userEvent.setup();
    const view = renderApp("/wallet", withCards(2));
    const remove = await screen.findAllByRole("button", { name: /^Remove the card ending in/ });
    await user.click(remove[0]!);
    const dialog = screen.getByRole("dialog", { name: "Remove this card?" });
    expect(view.api.removeCard).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(cardRows().length).toBe(2);
    await user.click(screen.getAllByRole("button", { name: /^Remove the card ending in/ })[0]!);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove card" }));
    await waitFor(() => expect(cardRows().length).toBe(1));
    expect(view.api.removeCard.mock.calls).toEqual([["pm_1"]]);
  });

  it("in the policy editor a card is listed as not available yet and can't be chosen", async () => {
    renderApp("/policies/new", withCards(2));
    const cardChoice = (await screen.findByRole("radio", { name: "A card" })) as HTMLInputElement;
    expect(cardChoice.disabled).toBe(true);
    expect(cardChoice.checked).toBe(false);
    expect(document.getElementById(cardChoice.getAttribute("aria-describedby")!)!.textContent).toContain("not available yet");
    expect((screen.getByRole("radio", { name: "My crypto account" }) as HTMLInputElement).checked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 020 connected platforms: Coinbase, view only (specs/020 contracts/portal-ui.md)
// ---------------------------------------------------------------------------

/** A person who finished onboarding, with 2.50 USDC on their account and Coinbase as `row` says (none: off). */
const withCoinbase = (row: Connection | null, over: Partial<World> = {}, wallet: Partial<WalletData> = {}): World =>
  world("done", {
    wallet: { account: account({ balanceAtomic: "2500000" }), cards: [card(1)], cardsAvailable: true, disabled: false, connections: row === null ? [] : [row], ...wallet },
    ...over,
  });
const disabledWith = (row: Connection): World => {
  const w = withCoinbase(row, {}, { disabled: true });
  w.me = { ...w.me, enabled: false };
  return w;
};
const firstPart = () => screen.getByRole("region", { name: AGENT_PAYS_TITLE });
const coinbasePart = () => screen.getByRole("region", { name: COINBASE_PART_TITLE });
const findCoinbasePart = () => screen.findByRole("region", { name: COINBASE_PART_TITLE });
/** The Coinbase part's buttons, by their text. */
const coinbaseButtons = () => within(coinbasePart()).queryAllByRole("button").map((b) => b.textContent);
const BALANCES_TABLE = { name: "Your Coinbase balances" };
/** A promise the test resolves itself. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("T-WEB-17: the wallet's two parts, and connecting Coinbase (020 US1, FR-012, FR-030)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("T-WEB-17 the first part is headed 'Your agent pays from this' and holds the account and the cards; with connected platforms off there is no Coinbase part", async () => {
    expect(AGENT_PAYS_TITLE).toBe("Your agent pays from this");
    const view = renderApp("/wallet", withCoinbase(null));
    const first = await screen.findByRole("region", { name: AGENT_PAYS_TITLE });
    await within(first).findByText("Copy address");
    expect(within(first).getAllByText(ADDRESS).length).toBe(2);
    expect(within(first).getByText(CARD_NOTICE)).toBeTruthy();
    expect(within(first).getAllByRole("listitem").length).toBe(1);
    expect(screen.queryByRole("region", { name: COINBASE_PART_TITLE })).toBeNull();
    expect(screen.getByRole("main").textContent).not.toMatch(/Coinbase/);
    expect(view.api.coinbaseBalances).not.toHaveBeenCalled();
    view.unmount();
    // A portal older than this web app sends no `connections` at all: the same.
    renderApp("/wallet", world("done", { wallet: { account: account(), cards: [], cardsAvailable: true, disabled: false } }));
    await within(await screen.findByRole("region", { name: AGENT_PAYS_TITLE })).findByText("Copy address");
    expect(screen.queryByRole("region", { name: COINBASE_PART_TITLE })).toBeNull();
  });

  it("T-WEB-17 not connected: the read-only sentence, the privacy policy and support links, Connect Coinbase, and no Coinbase logo", async () => {
    expect(COINBASE_PART_TITLE).toBe("Coinbase · View only");
    expect(COINBASE_READ_ONLY_TEXT).toBe("See your Coinbase balances here. The portal will only read them: your agent can't spend Coinbase funds.");
    const view = renderApp("/wallet", withCoinbase(coinbaseRow("not_connected")));
    const part = await findCoinbasePart();
    expect(within(part).getByText(COINBASE_READ_ONLY_TEXT)).toBeTruthy();
    expect(within(part).getByRole("link", { name: "Privacy policy" }).getAttribute("href")).toBe(PRIVACY_URL);
    expect(within(part).getByRole("link", { name: "Support" }).getAttribute("href")).toBe(SUPPORT_URL);
    expect(coinbaseButtons()).toEqual(["Connect Coinbase"]);
    // "Coinbase" is plain text: no logo and no button artwork (research R8).
    expect(part.querySelector("img, svg, picture, object, canvas, [style]")).toBeNull();
    // The part comes after the account the agent pays from, never inside it.
    const position = firstPart().compareDocumentPosition(part);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(position & Node.DOCUMENT_POSITION_CONTAINED_BY).toBe(0);
    expect(view.api.coinbaseBalances).not.toHaveBeenCalled();
  });

  it("T-WEB-17 Connect Coinbase starts a connection and goes to Coinbase in the same tab, saying so first", async () => {
    const user = userEvent.setup();
    const leave = stubLeaving();
    const popUp = vi.spyOn(window, "open").mockImplementation(() => null);
    const w = withCoinbase(coinbaseRow("not_connected"));
    const api = fakeApi(w);
    const started = deferred<ApiResult<{ authorizeUrl: string }>>();
    api.startCoinbase.mockReturnValueOnce(started.promise);
    renderApp("/wallet", w, { api });
    await user.click(await within(await findCoinbasePart()).findByRole("button", { name: "Connect Coinbase" }));
    expect(api.startCoinbase).toHaveBeenCalledTimes(1);
    expect(api.startCoinbase).toHaveBeenCalledWith();
    // Before the address changes, the button says where the person is going.
    expect(GOING_TO_COINBASE_TEXT).toBe("Going to Coinbase…");
    expect(within(coinbasePart()).getByRole("button", { name: GOING_TO_COINBASE_TEXT })).toBeTruthy();
    expect(leave).not.toHaveBeenCalled();
    await act(async () => started.resolve({ ok: true, data: { authorizeUrl: AUTHORIZE_URL } }));
    expect(leave.mock.calls).toEqual([[AUTHORIZE_URL]]);
    // No pop-up, and nothing of the trip kept in the browser.
    expect(popUp).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("T-WEB-17 a start the portal refuses says why, stays on the wallet and offers Connect Coinbase again", async () => {
    const user = userEvent.setup();
    const leave = stubLeaving();
    const w = withCoinbase(coinbaseRow("not_connected"));
    const api = fakeApi(w);
    api.startCoinbase
      .mockResolvedValueOnce(refuse(503, "not_ready"))
      .mockResolvedValueOnce(refuse(409, "profile_required"))
      .mockResolvedValueOnce(refuse(429, "too many requests"))
      .mockResolvedValueOnce({ ok: true, data: { authorizeUrl: "javascript:alert(1)" } });
    renderApp("/wallet", w, { api });
    for (const text of [
      "Coinbase can't be connected on this deployment yet.",
      "Complete your profile first.",
      "Too many requests. Wait a moment and try again.",
      "Something went wrong. Nothing was connected.",
    ]) {
      await user.click(await within(await findCoinbasePart()).findByRole("button", { name: "Connect Coinbase" }));
      expect(await within(coinbasePart()).findByText(text)).toBeTruthy();
    }
    expect(leave).not.toHaveBeenCalled();
    expect(within(firstPart()).getAllByText(ADDRESS).length).toBe(2);
  });

  it("T-WEB-17 connected: 'Connected on <date>', the balances, Refresh and Disconnect", async () => {
    const view = renderApp("/wallet", withCoinbase(coinbaseRow("connected")));
    const part = await findCoinbasePart();
    expect(within(part).getByText("Connected on 20 Nov 2026")).toBeTruthy();
    expect(await within(part).findByRole("table", BALANCES_TABLE)).toBeTruthy();
    expect(coinbaseButtons()).toEqual(["Refresh", "Disconnect"]);
    expect(view.api.coinbaseBalances).toHaveBeenCalledTimes(1);
  });

  it("T-WEB-17 reconnect: the message, Reconnect and Disconnect, and no figures; Reconnect goes to Coinbase too", async () => {
    expect(COINBASE_RECONNECT_TEXT).toBe("Coinbase no longer accepts this connection. Reconnect to see your balances.");
    const user = userEvent.setup();
    const leave = stubLeaving();
    const view = renderApp("/wallet", withCoinbase(coinbaseRow("reconnect")));
    const part = await findCoinbasePart();
    expect(within(part).getByText(COINBASE_RECONNECT_TEXT)).toBeTruthy();
    expect(coinbaseButtons()).toEqual(["Reconnect", "Disconnect"]);
    expect(within(part).queryByRole("table")).toBeNull();
    expect(part.textContent).not.toMatch(/\$/);
    expect(view.api.coinbaseBalances).not.toHaveBeenCalled();
    await user.click(within(part).getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(leave.mock.calls).toEqual([[AUTHORIZE_URL]]));
  });

  it("T-WEB-17 unavailable on this deployment: the message and Disconnect only", async () => {
    expect(COINBASE_UNAVAILABLE_TEXT).toBe("Coinbase isn't available on this deployment.");
    const view = renderApp("/wallet", withCoinbase(coinbaseRow("unavailable")));
    const part = await findCoinbasePart();
    expect(within(part).getByText(COINBASE_UNAVAILABLE_TEXT)).toBeTruthy();
    expect(coinbaseButtons()).toEqual(["Disconnect"]);
    expect(view.api.coinbaseBalances).not.toHaveBeenCalled();
  });

  it("T-WEB-17 a disabled account: only Disconnect is offered, and nothing is read from Coinbase", async () => {
    for (const status of ["connected", "reconnect", "unavailable"] as const) {
      const view = renderApp("/wallet", disabledWith(coinbaseRow(status)));
      await findCoinbasePart();
      expect(coinbaseButtons(), status).toEqual(["Disconnect"]);
      expect(view.api.coinbaseBalances, status).not.toHaveBeenCalled();
      view.unmount();
    }
    // Not connected: nothing to disconnect, and nothing can be connected while the account is disabled.
    const view = renderApp("/wallet", disabledWith(coinbaseRow("not_connected")));
    const part = await findCoinbasePart();
    expect(coinbaseButtons()).toEqual([]);
    expect(within(part).getByText("Your account is disabled.")).toBeTruthy();
    expect(view.api.startCoinbase).not.toHaveBeenCalled();
  });
});

describe("T-WEB-18: the Coinbase balances, from decimal strings (020 US2, FR-013..FR-015)", () => {
  afterEach(() => vi.useRealTimers());
  const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
  const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
  /** Each balance row's cells, by their text. */
  const rows = () =>
    within(screen.getByRole("table", BALANCES_TABLE))
      .getAllByRole("row")
      .slice(1)
      .map((r) => within(r).getAllByRole("cell").map((c) => c.textContent));

  it("T-WEB-18 each asset's name, code, exact amount and US dollar value; no rate in words; the total at Coinbase's read time; what is left out; how many more", async () => {
    const MARKUP = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
    const figures = coinbaseBalances({ more: 3 });
    figures.assets[3] = { code: "XYZ", name: MARKUP, amount: "5" };
    const view = renderApp("/wallet", withCoinbase(coinbaseRow("connected"), { balances: figures }));
    await within(await findCoinbasePart()).findByRole("table", BALANCES_TABLE);
    // Exact: as a floating-point number the first amount would read 1234.1234567890124.
    expect(rows()).toEqual([
      ["Ethereum · ETH", "1,234.123456789012345678", "$4,321,987.65"],
      ["US Dollar · USD", "1,000.5", "$1,000.50"],
      ["Bitcoin · BTC", "0.00012345", "$12.34"],
      [`${MARKUP} · XYZ`, "5", NO_RATE_TEXT],
    ]);
    expect(NO_RATE_TEXT).toBe("no rate from Coinbase");
    const part = coinbasePart();
    expect(within(part).getByText("Total in US dollars (at Coinbase's rates, 14:02:11 UTC)").nextElementSibling!.textContent).toBe("$4,323,000.49");
    expect(within(part).getByText("Not counted: XYZ")).toBeTruthy();
    expect(within(part).getByText("and 3 more assets")).toBeTruthy();
    expect(within(part).getByText("Read at 2026-11-25 14:02:11 UTC")).toBeTruthy();
    // Text from Coinbase is text, never markup (FR-028, hard rule 11).
    expect(view.container.querySelector("img, script")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("T-WEB-18 the total is Coinbase's alone: never added to, or shown beside a sum with, the account the agent pays from", async () => {
    renderApp("/wallet", withCoinbase(coinbaseRow("connected")));
    await within(await findCoinbasePart()).findByRole("table", BALANCES_TABLE);
    // The account holds 2.50 USDC and the Coinbase total is $4,323,000.49: no figure anywhere is their sum.
    const text = screen.getByRole("main").textContent!;
    for (const sum of ["4,323,002.99", "4323002.99", "4,323,003", "4323003"]) expect(text.includes(sum), sum).toBe(false);
    expect(firstPart().textContent).not.toMatch(/\$|Coinbase/);
    expect(coinbasePart().textContent).not.toMatch(/USDC|2\.50/);
  });

  it("T-WEB-18 nothing holding funds: one sentence and the read time, and no table or total", async () => {
    renderApp("/wallet", withCoinbase(coinbaseRow("connected"), { balances: coinbaseBalances({ assets: [], total: undefined, leftOutOfTotal: [] }) }));
    const part = await findCoinbasePart();
    expect(await within(part).findByText("Your Coinbase account holds no funds.")).toBeTruthy();
    expect(within(part).getByText("Read at 2026-11-25 14:02:11 UTC")).toBeTruthy();
    expect(within(part).queryByRole("table")).toBeNull();
    expect(part.textContent).not.toMatch(/Total|\$/);
  });

  it("T-WEB-18 Refresh asks for a fresh read, and is paused for 10 s after each read", async () => {
    vi.useFakeTimers();
    const view = renderApp("/wallet", withCoinbase(coinbaseRow("connected")));
    for (let i = 0; i < 4; i++) await settle();
    const refresh = () => within(coinbasePart()).getByRole("button", { name: "Refresh" }) as HTMLButtonElement;
    expect(screen.getByRole("table", BALANCES_TABLE)).toBeTruthy();
    expect(view.api.coinbaseBalances.mock.calls).toEqual([[false]]);
    expect(refresh().disabled).toBe(true);
    await advance(9_999);
    expect(refresh().disabled).toBe(true);
    await advance(1);
    expect(refresh().disabled).toBe(false);
    fireEvent.click(refresh());
    await settle();
    expect(view.api.coinbaseBalances.mock.calls).toEqual([[false], [true]]);
    expect(refresh().disabled).toBe(true);
    fireEvent.click(refresh());
    await advance(9_999);
    expect(refresh().disabled).toBe(true);
    await advance(1);
    expect(refresh().disabled).toBe(false);
    expect(view.api.coinbaseBalances).toHaveBeenCalledTimes(2);
  });
});

describe("T-WEB-20: Coinbase never holds up the wallet (020 US2, FR-016, FR-017)", () => {
  it("T-WEB-20 the account the agent pays from is shown before the balances answer; the balances follow it", async () => {
    const w = withCoinbase(coinbaseRow("connected"));
    const api = fakeApi(w);
    const answer = deferred<ApiResult<BalancesAnswer>>();
    api.coinbaseBalances.mockReturnValueOnce(answer.promise);
    renderApp("/wallet", w, { api });
    const first = await screen.findByRole("region", { name: AGENT_PAYS_TITLE });
    await within(first).findByText("Copy address");
    expect(figure("Balance")).toMatch(/^2\.50 USDC/);
    await waitFor(() => expect(api.coinbaseBalances).toHaveBeenCalledTimes(1));
    expect(within(coinbasePart()).getByText("Reading your Coinbase balances…")).toBeTruthy();
    expect(within(coinbasePart()).queryByRole("table")).toBeNull();
    await act(async () => answer.resolve({ ok: true, data: coinbaseBalances() }));
    expect(await within(coinbasePart()).findByRole("table", BALANCES_TABLE)).toBeTruthy();
    // The balances are asked for only once the wallet has answered.
    expect(api.wallet.mock.invocationCallOrder[0]!).toBeLessThan(api.coinbaseBalances.mock.invocationCallOrder[0]!);
  });

  it("T-WEB-20 figures Coinbase couldn't refresh are still shown, as not current, with their time", async () => {
    renderApp("/wallet", withCoinbase(coinbaseRow("connected"), { balances: coinbaseBalances({ stale: true, readAt: "2026-11-25T13:58:00.000Z" }) }));
    const part = await findCoinbasePart();
    expect(await within(part).findByText("Couldn't reach Coinbase. These figures are from 2026-11-25 13:58:00 UTC.")).toBeTruthy();
    expect(within(part).getByRole("table", BALANCES_TABLE)).toBeTruthy();
  });

  it("T-WEB-20 balances never read: the message and no figures", async () => {
    expect(BALANCES_UNREADABLE_TEXT).toBe("Couldn't read your Coinbase balances. Try again in a moment.");
    renderApp("/wallet", withCoinbase(coinbaseRow("connected"), { balances: { status: "unreadable" } }));
    const part = await findCoinbasePart();
    expect(await within(part).findByText(BALANCES_UNREADABLE_TEXT)).toBeTruthy();
    expect(within(part).queryByRole("table")).toBeNull();
    expect(part.textContent).not.toMatch(/\$|Total/);
    expect(coinbaseButtons()).toEqual(["Refresh", "Disconnect"]);
    expect(within(firstPart()).getAllByText(ADDRESS).length).toBe(2);
  });

  it("T-WEB-20 Coinbase no longer accepts the grant: the part asks to reconnect, with no figures", async () => {
    renderApp("/wallet", withCoinbase(coinbaseRow("connected"), { balances: { status: "reconnect" } }));
    const part = await findCoinbasePart();
    expect(await within(part).findByText(COINBASE_RECONNECT_TEXT)).toBeTruthy();
    expect(coinbaseButtons()).toEqual(["Reconnect", "Disconnect"]);
    expect(within(part).queryByRole("table")).toBeNull();
    expect(part.textContent).not.toMatch(/\$/);
  });

  it("T-WEB-20 a balances call that fails at the portal leaves the rest of the wallet as it is", async () => {
    const w = withCoinbase(coinbaseRow("connected"));
    const api = fakeApi(w);
    api.coinbaseBalances.mockResolvedValueOnce(refuse(0, "network"));
    renderApp("/wallet", w, { api });
    expect(await within(await findCoinbasePart()).findByText(BALANCES_UNREADABLE_TEXT)).toBeTruthy();
    expect(within(firstPart()).getAllByText(ADDRESS).length).toBe(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("T-WEB-20 a connection the portal no longer has turns the part back to Connect Coinbase", async () => {
    const w = withCoinbase(coinbaseRow("connected"));
    const api = fakeApi(w);
    api.coinbaseBalances.mockResolvedValueOnce(refuse(404, "not_connected"));
    renderApp("/wallet", w, { api });
    await findCoinbasePart();
    await waitFor(() => expect(coinbaseButtons()).toEqual(["Connect Coinbase"]));
    expect(within(coinbasePart()).getByText(COINBASE_READ_ONLY_TEXT)).toBeTruthy();
  });
});

describe("T-WEB-21: disconnecting Coinbase (020 US4, FR-018)", () => {
  const disconnect = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await within(await findCoinbasePart()).findByRole("button", { name: "Disconnect" }));
    await user.click(within(screen.getByRole("dialog", { name: "Disconnect Coinbase?" })).getByRole("button", { name: "Disconnect Coinbase" }));
  };

  it("T-WEB-21 Disconnect asks first; only then the connection ends, and the wallet offers Connect Coinbase again", async () => {
    expect(DISCONNECT_TEXT).toBe("The portal will forget its access and stop showing these balances.");
    expect(DISCONNECTED_TEXT).toBe("Coinbase disconnected.");
    const user = userEvent.setup();
    const view = renderApp("/wallet", withCoinbase(coinbaseRow("connected")));
    await within(await findCoinbasePart()).findByRole("table", BALANCES_TABLE);
    await user.click(within(coinbasePart()).getByRole("button", { name: "Disconnect" }));
    const dialog = screen.getByRole("dialog", { name: "Disconnect Coinbase?" });
    expect(within(dialog).getByText(DISCONNECT_TEXT)).toBeTruthy();
    expect(view.api.deleteCoinbase).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(view.api.deleteCoinbase).not.toHaveBeenCalled();
    expect(within(coinbasePart()).getByRole("table", BALANCES_TABLE)).toBeTruthy();

    await disconnect(user);
    expect(await within(coinbasePart()).findByText(DISCONNECTED_TEXT)).toBeTruthy();
    expect(view.api.deleteCoinbase).toHaveBeenCalledTimes(1);
    expect(view.api.deleteCoinbase).toHaveBeenCalledWith();
    await waitFor(() => expect(coinbaseButtons()).toEqual(["Connect Coinbase"]));
    expect(within(coinbasePart()).queryByRole("table")).toBeNull();
    expect(within(coinbasePart()).queryByRole("link", { name: /accounts\.coinbase\.com/ })).toBeNull();
  });

  it("T-WEB-21 when Coinbase didn't confirm, the message links Coinbase's own connections page", async () => {
    expect(NOT_REVOKED_TEXT).toBe("Disconnected here. Coinbase didn't confirm, so also remove the access in Coinbase:");
    expect(COINBASE_CONNECTIONS_URL).toBe("https://accounts.coinbase.com/security/connections");
    const user = userEvent.setup();
    renderApp("/wallet", withCoinbase(coinbaseRow("connected"), { revokedAtPlatform: false }));
    await disconnect(user);
    const message = await within(coinbasePart()).findByText(NOT_REVOKED_TEXT, { exact: false });
    expect(within(message).getByRole("link").getAttribute("href")).toBe(COINBASE_CONNECTIONS_URL);
    expect(within(coinbasePart()).queryByText(DISCONNECTED_TEXT)).toBeNull();
    await waitFor(() => expect(coinbaseButtons()).toEqual(["Connect Coinbase"]));
  });

  it("T-WEB-21 a disabled account can still disconnect", async () => {
    const user = userEvent.setup();
    const view = renderApp("/wallet", disabledWith(coinbaseRow("connected")));
    await disconnect(user);
    expect(await within(coinbasePart()).findByText(DISCONNECTED_TEXT)).toBeTruthy();
    expect(view.api.deleteCoinbase).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(coinbaseButtons()).toEqual([]));
  });

  it("T-WEB-21 a disconnection the portal couldn't do says so, and the connection stays shown", async () => {
    const user = userEvent.setup();
    const w = withCoinbase(coinbaseRow("connected"));
    const api = fakeApi(w);
    api.deleteCoinbase.mockResolvedValueOnce(refuse(0, "network"));
    renderApp("/wallet", w, { api });
    await disconnect(user);
    expect(await within(coinbasePart()).findByText("The portal can't be reached. Check your connection and try again.")).toBeTruthy();
    expect(coinbaseButtons()).toEqual(["Refresh", "Disconnect"]);
    expect(within(coinbasePart()).queryByText(DISCONNECTED_TEXT)).toBeNull();
  });
});
