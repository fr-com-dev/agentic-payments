// @vitest-environment jsdom
// 013 US2 web and T-WEB-06 (specs/013 FR-013, FR-015, FR-016, FR-018..FR-022): the wallet step and screen show the
// account's public address and figures and no way to move funds out; cards are saved for later, never to pay, and
// the card's number never passes through the app.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CARD_NOTICE } from "../src/screens/Wallet.js";
import { ADDRESS, account, card, fakeApi, refuse, renderApp, world } from "./helpers.js";

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
