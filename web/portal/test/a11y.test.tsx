// @vitest-environment jsdom
// T-WEB-08 (specs/013 NFR-009): an automated accessibility pass on every screen in its main states, the colors of
// the stylesheet checked for contrast, and onboarding completed with the keyboard alone.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { EXAMPLE_VALUES, SELLER, SELLER_2, account, card, fakeApi, fakeAuth, platform, policy, refuse, renderApp, world, type World } from "./helpers.js";

/** Runs axe on the whole document. Contrast is checked separately below: jsdom lays nothing out, so axe can't. */
async function violations(): Promise<string[]> {
  document.documentElement.lang = "en";
  document.title = "x402 portal";
  const result = await axe.run(document, { rules: { "color-contrast": { enabled: false } } });
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 120)).join(" | ")}`);
}

const disabled = (): World => {
  const w = world("done", { wallet: { account: account(), cards: [card(1)], cardsAvailable: true, disabled: true } });
  w.me = { ...w.me, enabled: false };
  w.policies = [policy("pol_1", { name: "Daily data", displayState: "disabled" })];
  return w;
};
const rich = (): World =>
  world("done", {
    wallet: { account: account({ balanceStale: true, lowBalance: true }), cards: [card(1, { nickname: "Travel" }), card(2, { expired: true })], cardsAvailable: true, disabled: false },
    policies: [
      policy("pol_1", { name: "Daily data", limitedByPlatform: ["hardCapPerPaymentAtomic"], unlistedSellers: ["gone.example.test"], values: { ...EXAMPLE_VALUES, sellers: [SELLER.host, "gone.example.test"] } }),
      policy("pol_2", { name: "On hold", state: "paused", displayState: "paused", values: { ...EXAMPLE_VALUES, sellers: [SELLER_2.host] } }),
      policy("pol_3", { name: "Gone", state: "removed", displayState: "removed", values: { ...EXAMPLE_VALUES, sellers: [SELLER_2.host] } }),
    ],
  });

describe("T-WEB-08: an automated accessibility pass", () => {
  const screens: Array<[string, string, () => World, string | RegExp]> = [
    ["the profile step", "/", () => world("new"), "Create your profile"],
    ["the wallet step", "/", () => world("profile"), "Create your wallet"],
    ["the first policy", "/", () => world("wallet"), "Write your first expense policy"],
    ["the first policy without sellers", "/", () => world("wallet", { platform: platform({ sellers: [] }) }), "Write your first expense policy"],
    ["home", "/", rich, /^Hello/],
    ["the wallet", "/wallet", rich, "Wallet"],
    ["the policies", "/policies", rich, "Expense policies"],
    ["a new policy", "/policies/new", rich, "New policy"],
    ["a policy being edited", "/policies/pol_1", rich, "Edit policy"],
    ["a removed policy", "/policies/pol_3", rich, "Edit policy"],
    ["a policy's history", "/policies/pol_1/history", rich, "Policy history"],
    ["the profile", "/profile", rich, "Profile"],
    ["the account", "/account", rich, "Account"],
    ["not found", "/nowhere", rich, "Not found"],
    ["the policies while disabled", "/policies", disabled, "Expense policies"],
    ["the wallet while disabled", "/wallet", disabled, "Wallet"],
    ["the account while disabled", "/account", disabled, "Account"],
  ];
  for (const [name, path, make, heading] of screens) {
    it(`${name} has no violation`, async () => {
      renderApp(path, make());
      await screen.findByRole("heading", { level: 1, name: heading });
      await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
      expect(await violations()).toEqual([]);
    });
  }

  it("the pass is real: a field without a label is reported", async () => {
    renderApp("/profile", rich());
    await screen.findByRole("heading", { level: 1, name: "Profile" });
    const unlabeled = document.createElement("input");
    screen.getByRole("main").appendChild(unlabeled);
    expect((await violations()).some((v) => v.startsWith("label:"))).toBe(true);
    unlabeled.remove();
    expect(await violations()).toEqual([]);
  });

  it("signed out and refused have no violation", async () => {
    const view = renderApp("/", world("done"), { auth: fakeAuth({ signedIn: false }) });
    await screen.findByRole("button", { name: "Sign in" });
    expect(await violations()).toEqual([]);
    view.unmount();
    const dev = renderApp("/", world("done"), { auth: fakeAuth({ signedIn: false, mode: "dev" }) });
    await screen.findByLabelText(/Development sign-in/);
    expect(await violations()).toEqual([]);
    dev.unmount();
    const w = world("new");
    const api = fakeApi(w);
    api.me.mockResolvedValue(refuse(403, "forbidden"));
    renderApp("/", w, { api });
    await screen.findByRole("alert");
    expect(await violations()).toEqual([]);
  });

  it("the editor with errors, the step-up prompt and a version conflict have no violation", async () => {
    const user = userEvent.setup();
    const w = rich();
    const api = fakeApi(w);
    renderApp("/policies/new", w, { api });
    await user.click(await screen.findByRole("button", { name: "Save policy" }));
    await screen.findByRole("alert");
    expect(await violations()).toEqual([]);
  });

  it("a version conflict and the step-up prompt have no violation", async () => {
    const user = userEvent.setup();
    const w = world("done");
    const api = fakeApi(w);
    api.changePolicy
      .mockResolvedValueOnce(refuse(403, "step_up_required", { maxAgeSec: 900 }))
      .mockResolvedValueOnce(refuse(409, "version_conflict", { current: policy("pol_1", { version: 2, values: { ...EXAMPLE_VALUES, hardCapPerPaymentAtomic: "50000" } }) }));
    renderApp("/policies/pol_1", w, { api });
    await user.click(await screen.findByRole("button", { name: "Save changes" }));
    const confirm = await screen.findByRole("button", { name: "Confirm it's you" });
    expect(await violations()).toEqual([]);
    await user.click(confirm);
    await screen.findByRole("table");
    expect(await violations()).toEqual([]);
  });

  it("the dialogs and the card form have no violation", async () => {
    const user = userEvent.setup();
    renderApp("/wallet", rich());
    await user.click((await screen.findAllByRole("button", { name: /^Remove the card/ }))[0]!);
    screen.getByRole("dialog");
    expect(await violations()).toEqual([]);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Add a card" }));
    await screen.findByLabelText("Nickname (optional)");
    expect(await violations()).toEqual([]);
  });

  it("the account dialog has no violation", async () => {
    const user = userEvent.setup();
    renderApp("/account", world("done"));
    await user.click(await screen.findByRole("button", { name: "Disable my account" }));
    screen.getByRole("dialog");
    expect(await violations()).toEqual([]);
  });
});

describe("T-WEB-08: contrast of the stylesheet's colors", () => {
  const css = readFileSync(resolve(import.meta.dirname, "../src/styles.css"), "utf8");
  const colors = Object.fromEntries([...css.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6});/g)].map((m) => [m[1]!, m[2]!]));
  const luminance = (hex: string) => {
    const channel = (i: number) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [luminance(colors[a]!), luminance(colors[b]!)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };

  it("every text color on every background it is used on is at least 4.5:1", () => {
    const pairs: Array<[string, string]> = [
      ["ink", "paper"],
      ["ink", "wash"],
      ["ink", "info-wash"],
      ["ink", "warning-wash"],
      ["ink", "error-wash"],
      ["muted", "paper"],
      ["muted", "wash"],
      ["muted", "info-wash"],
      ["accent", "paper"],
      ["accent", "wash"],
      ["accent", "info-wash"],
      ["accent", "warning-wash"],
      ["accent-ink", "accent"],
      ["error", "paper"],
      ["error", "error-wash"],
      ["warning", "paper"],
      ["warning", "warning-wash"],
      ["warning", "info-wash"],
      ["ok", "paper"],
    ];
    for (const [text, background] of pairs) {
      expect(colors[text], text).toBeDefined();
      expect(colors[background], background).toBeDefined();
      expect(ratio(text, background), `${text} on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("the focus ring is visible against the page (at least 3:1) and never removed", () => {
    expect(ratio("focus", "paper")).toBeGreaterThanOrEqual(3);
    expect(ratio("focus", "wash")).toBeGreaterThanOrEqual(3);
    expect(css).toContain(":focus-visible");
    // The only outline that is removed is the screen heading's, which is focused by the app, not by the person.
    expect([...css.matchAll(/outline:\s*none/g)].length).toBe(1);
  });
});

describe("T-WEB-08: onboarding with the keyboard alone", () => {
  /** Presses Tab until `target` has focus; fails if it can't be reached. */
  async function tabTo(user: UserEvent, target: HTMLElement): Promise<void> {
    for (let i = 0; i < 60 && document.activeElement !== target; i += 1) await user.tab();
    expect(document.activeElement).toBe(target);
  }

  it("profile, wallet and first policy, never touching the mouse", async () => {
    const user = userEvent.setup();
    const view = renderApp("/", world("new"));

    // Profile: the heading has focus, so the first Tab enters the form.
    const profile = await screen.findByRole("heading", { level: 1, name: "Create your profile" });
    await waitFor(() => expect(document.activeElement).toBe(profile));
    await tabTo(user, screen.getByRole("checkbox", { name: /test funds only/ }));
    await user.keyboard(" ");
    await tabTo(user, screen.getByRole("button", { name: "Save and continue" }));
    await user.keyboard("{Enter}");

    // Wallet: focus moved to the new screen's heading.
    const wallet = await screen.findByRole("heading", { level: 1, name: "Create your wallet" });
    await waitFor(() => expect(document.activeElement).toBe(wallet));
    await tabTo(user, screen.getByRole("button", { name: "Create my wallet" }));
    await user.keyboard("{Enter}");
    await tabTo(user, await screen.findByRole("button", { name: "Continue" }));
    await user.keyboard("{Enter}");

    // First policy.
    const first = await screen.findByRole("heading", { level: 1, name: "Write your first expense policy" });
    await waitFor(() => expect(document.activeElement).toBe(first));
    await tabTo(user, await screen.findByLabelText(/^Policy name/));
    await user.keyboard("Daily data");
    await tabTo(user, screen.getByRole("checkbox", { name: `${SELLER.name} (${SELLER.host})` }));
    await user.keyboard(" ");
    for (const [label, value] of [
      [/^Without asking/, "0.02"],
      [/^Per payment/, "0.10"],
      [/^Per agent run/, "0.10"],
      [/^Per day/, "0.50"],
    ] as const) {
      await tabTo(user, screen.getByLabelText(label));
      await user.keyboard(value);
    }
    const ends = screen.getByLabelText(/^End date/);
    await tabTo(user, ends);
    // A date field is typed in the browser's own way; the value is set directly here.
    fireEvent.change(ends, { target: { value: "2027-12-31" } });
    await tabTo(user, screen.getByRole("button", { name: "Save policy" }));
    await user.keyboard("{Enter}");

    const home = await screen.findByRole("heading", { level: 1, name: "Hello, Alice Example" });
    await waitFor(() => expect(document.activeElement).toBe(home));
    expect(view.api.saveProfile).toHaveBeenCalledTimes(1);
    expect(view.api.createAccount).toHaveBeenCalledTimes(1);
    expect(view.api.createPolicy).toHaveBeenCalledTimes(1);
    expect(within(screen.getByRole("navigation", { name: "Main" })).getAllByRole("link").length).toBe(5);
  });

  it("an error summary can be followed to its field with the keyboard", async () => {
    const user = userEvent.setup();
    renderApp("/policies/new", world("done", { policies: [] }));
    await user.click(await screen.findByRole("button", { name: "Save policy" }));
    const alert = await screen.findByRole("alert");
    expect(document.activeElement).toBe(alert);
    await user.tab();
    const link = document.activeElement as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(document.querySelector(link.getAttribute("href")!)).not.toBeNull();
  });
});
