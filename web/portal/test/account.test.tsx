// @vitest-environment jsdom
// 013 US7 web (specs/013 FR-037..FR-039): a person disables their account in one deliberate step; afterwards every
// screen says so and nothing can be created or changed except the name and email; enabling leaves the policies
// paused for the person to resume.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DISABLED_TEXT } from "../src/app.js";
import { DISABLE_TEXT, ENABLED_TEXT } from "../src/screens/Account.js";
import { account, card, fakeApi, policy, refuse, renderApp, world, type World } from "./helpers.js";

function disabledWorld(): World {
  const w = world("done", { wallet: { account: account(), cards: [card(1)], cardsAvailable: true, disabled: true } });
  w.me = { ...w.me, enabled: false };
  w.policies = [policy("pol_1", { name: "Daily data", displayState: "disabled" }), policy("pol_2", { name: "On hold", state: "paused", displayState: "disabled" })];
  return w;
}

describe("013 US7 web: disabling the account", () => {
  it("asks first, saying what happens, and only then disables", async () => {
    const user = userEvent.setup();
    const view = renderApp("/account");
    await user.click(await screen.findByRole("button", { name: "Disable my account" }));
    const dialog = screen.getByRole("dialog", { name: "Disable your account?" });
    expect(within(dialog).getByText(DISABLE_TEXT)).toBeTruthy();
    expect(DISABLE_TEXT).toBe("Your agent will not be able to pay. Nothing is deleted.");
    expect(view.api.disableAccount).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(view.api.disableAccount).not.toHaveBeenCalled();
    expect(screen.queryByText(new RegExp(DISABLED_TEXT))).toBeNull();

    await user.click(screen.getByRole("button", { name: "Disable my account" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Disable account" }));
    expect(await screen.findByText(new RegExp(`^${DISABLED_TEXT}`))).toBeTruthy();
    expect(view.api.disableAccount).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Enable my account" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Disable my account" })).toBeNull();
  });

  it("a failure changes nothing and says so", async () => {
    const user = userEvent.setup();
    const w = world("done");
    const api = fakeApi(w);
    api.disableAccount.mockResolvedValueOnce(refuse(502, "control_unavailable"));
    renderApp("/account", w, { api });
    await user.click(await screen.findByRole("button", { name: "Disable my account" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Disable account" }));
    expect(await screen.findByText(/payment service can't be reached right now. Nothing was changed/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disable my account" })).toBeTruthy();
  });
});

describe("013 US7 web: while disabled", () => {
  it("the banner is on every screen", async () => {
    expect(DISABLED_TEXT).toBe("Your account is disabled");
    for (const path of ["/", "/wallet", "/policies", "/policies/new", "/policies/pol_1", "/policies/pol_1/history", "/profile", "/account"]) {
      const view = renderApp(path, disabledWorld());
      // The banner itself, not a control's reason that uses the same words.
      expect(await screen.findByText(new RegExp(`^${DISABLED_TEXT}\\. Your agent can't pay`)), path).toBeTruthy();
      view.unmount();
    }
  });

  it("policies read as disabled and every policy control is disabled", async () => {
    renderApp("/policies", disabledWorld());
    await screen.findByRole("link", { name: "Daily data" });
    expect(screen.getAllByText("Disabled").length).toBe(2);
    const buttons = within(screen.getByRole("main")).getAllByRole("button") as HTMLButtonElement[];
    expect(buttons.map((b) => b.textContent!.trim().split(" ")[0])).toEqual(["New", "Pause", "Remove", "Resume", "Remove"]);
    for (const b of buttons) expect(b.disabled, b.textContent!).toBe(true);
    // "New policy" is a disabled button with its reason, not a link that leads to a form.
    expect(screen.queryByRole("link", { name: "New policy" })).toBeNull();
    expect(document.getElementById(buttons[0]!.getAttribute("aria-describedby")!)!.textContent).toContain("Your account is disabled.");
  });

  it("the editor can be read but not saved", async () => {
    const view = renderApp("/policies/pol_1", disabledWorld());
    const save = (await screen.findByRole("button", { name: "Save changes" })) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    for (const box of screen.getAllByRole("textbox") as HTMLInputElement[]) expect(box.disabled, box.id).toBe(true);
    for (const box of screen.getAllByRole("checkbox") as HTMLInputElement[]) expect(box.disabled, box.id).toBe(true);
    expect(view.api.changePolicy).not.toHaveBeenCalled();
  });

  it("no card can be added, and the wallet still shows", async () => {
    renderApp("/wallet", disabledWorld());
    const add = (await screen.findByRole("button", { name: "Add a card" })) as HTMLButtonElement;
    await waitFor(() => expect(add.disabled).toBe(true));
    expect(screen.getByText("Copy address")).toBeTruthy();
  });

  it("the name and email stay editable", async () => {
    const user = userEvent.setup();
    const view = renderApp("/profile", disabledWorld());
    const name = (await screen.findByLabelText(/^Name/)) as HTMLInputElement;
    expect(name.disabled).toBe(false);
    await user.clear(name);
    await user.type(name, "Alice B");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(view.api.saveProfile).toHaveBeenCalledWith({ displayName: "Alice B", contactEmail: "alice@example.test" });
  });
});

describe("013 US7 web: enabling the account", () => {
  it("enables, then says the policies are paused", async () => {
    const user = userEvent.setup();
    const view = renderApp("/account", disabledWorld());
    await user.click(await screen.findByRole("button", { name: "Enable my account" }));
    expect(await screen.findByText(new RegExp(ENABLED_TEXT))).toBeTruthy();
    expect(ENABLED_TEXT).toBe("Your policies are paused. Resume the ones you want.");
    expect(view.api.enableAccount).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(new RegExp(`^${DISABLED_TEXT}\\.`))).toBeNull();
    await user.click(screen.getByRole("link", { name: "Go to your policies" }));
    await screen.findByRole("link", { name: "Daily data" });
    expect(screen.getAllByText("Paused").length).toBe(2);
    expect((screen.getByRole("button", { name: "Resume Daily data" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("asks to confirm identity when the sign-in is old, and enables once", async () => {
    const user = userEvent.setup();
    const w = disabledWorld();
    const api = fakeApi(w);
    api.enableAccount.mockResolvedValueOnce(refuse(403, "step_up_required", { maxAgeSec: 900 }));
    const view = renderApp("/account", w, { api });
    await user.click(await screen.findByRole("button", { name: "Enable my account" }));
    await user.click(await screen.findByRole("button", { name: "Confirm it's you" }));
    expect(await screen.findByText(new RegExp(ENABLED_TEXT))).toBeTruthy();
    expect(view.auth.confirmIdentity).toHaveBeenCalledTimes(1);
    expect(api.enableAccount).toHaveBeenCalledTimes(2);
  });

  it("in dev mode confirming identity asks for a fresh token", async () => {
    const user = userEvent.setup();
    const w = disabledWorld();
    const api = fakeApi(w);
    api.enableAccount.mockResolvedValueOnce(refuse(403, "step_up_required", { maxAgeSec: 900 }));
    const { fakeAuth } = await import("./helpers.js");
    const auth = fakeAuth({ mode: "dev" });
    renderApp("/account", w, { api, auth });
    await user.click(await screen.findByRole("button", { name: "Enable my account" }));
    await user.click(await screen.findByRole("button", { name: "Confirm it's you" }));
    const dialog = screen.getByRole("dialog", { name: "Confirm it's you" });
    await user.type(within(dialog).getByRole("textbox"), "fresh.dev.token");
    await user.click(within(dialog).getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText(new RegExp(ENABLED_TEXT))).toBeTruthy();
    expect(auth.confirmIdentity.mock.calls).toEqual([["fresh.dev.token"]]);
  });

  it("signing out returns to Sign in", async () => {
    const user = userEvent.setup();
    const view = renderApp("/account");
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(view.auth.signOut).toHaveBeenCalledTimes(1);
  });
});
