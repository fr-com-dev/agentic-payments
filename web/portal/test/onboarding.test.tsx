// @vitest-environment jsdom
// T-WEB-01, T-WEB-02 (specs/013 US1, FR-003, FR-008, FR-009): a person lands on the first onboarding step not done,
// the profile is prefilled from the sign-in, and a person who is refused sees the refusal and no form.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { firstStepNotDone, matchRoute, resolveRoute } from "../src/routes.js";
import { REFUSED_TEXT } from "../src/screens/SignedOut.js";
import { fakeApi, fakeAuth, refuse, renderApp, world } from "./helpers.js";

const none = { profile: false, wallet: false, policy: false };
const profile = { profile: true, wallet: false, policy: false };
const wallet = { profile: true, wallet: true, policy: false };
const all = { profile: true, wallet: true, policy: true };

describe("T-WEB-01: routing by onboarding status", () => {
  it("names the first step not done", () => {
    expect(firstStepNotDone(none)).toBe("/onboarding/profile");
    expect(firstStepNotDone(profile)).toBe("/onboarding/wallet");
    expect(firstStepNotDone(wallet)).toBe("/onboarding/policy");
    expect(firstStepNotDone(all)).toBeNull();
  });

  it("sends a deep link to a step that is not available to the first step not done", () => {
    for (const path of ["/", "/policies", "/policies/new", "/policies/pol_1", "/policies/pol_1/history", "/wallet", "/profile", "/account", "/onboarding/wallet", "/onboarding/policy"]) {
      expect(resolveRoute(path, none), path).toBe("/onboarding/profile");
    }
    for (const path of ["/", "/policies", "/policies/new", "/profile", "/onboarding/profile", "/onboarding/policy"]) {
      expect(resolveRoute(path, profile), path).toBe("/onboarding/wallet");
    }
    for (const path of ["/", "/profile", "/onboarding/profile", "/onboarding/wallet"]) {
      expect(resolveRoute(path, wallet), path).toBe("/onboarding/policy");
    }
    // What is already available stays reachable before onboarding ends.
    expect(resolveRoute("/wallet", profile)).toBe("/wallet");
    expect(resolveRoute("/account", profile)).toBe("/account");
    expect(resolveRoute("/policies", wallet)).toBe("/policies");
  });

  it("leaves an onboarded person where they asked to go, and sends finished steps home", () => {
    for (const path of ["/", "/wallet", "/policies", "/policies/new", "/policies/pol_1", "/policies/pol_1/history", "/profile", "/account"]) {
      expect(resolveRoute(path, all), path).toBe(path);
    }
    for (const path of ["/onboarding/profile", "/onboarding/wallet", "/onboarding/policy"]) expect(resolveRoute(path, all), path).toBe("/");
  });

  it("reads identifiers from the path and nothing else", () => {
    expect(matchRoute("/policies/pol_abc")).toEqual({ name: "policy-edit", policyId: "pol_abc" });
    expect(matchRoute("/policies/pol_abc/history")).toEqual({ name: "policy-history", policyId: "pol_abc" });
    expect(matchRoute("/policies/")).toEqual({ name: "policies" });
    expect(matchRoute("/nowhere")).toEqual({ name: "not-found" });
  });

  it("a new person lands on the profile step with three steps and none done", async () => {
    renderApp("/", world("new"));
    expect(await screen.findByRole("heading", { level: 1, name: "Create your profile" })).toBeTruthy();
    const steps = within(screen.getByRole("list", { name: "Setup steps" })).getAllByRole("listitem");
    expect(steps.map((s) => s.textContent)).toEqual(["Next Create your profile", "Later Create your wallet", "Later Write your first expense policy"]);
    expect(steps[0]!.getAttribute("aria-current")).toBe("step");
    expect(window.location.pathname).toBe("/onboarding/profile");
  });

  it("a person with a profile lands on the wallet step", async () => {
    renderApp("/", world("profile"));
    expect(await screen.findByRole("heading", { level: 1, name: "Create your wallet" })).toBeTruthy();
    const steps = within(screen.getByRole("list", { name: "Setup steps" })).getAllByRole("listitem");
    expect(steps.map((s) => s.textContent)).toEqual(["Done Create your profile", "Next Create your wallet", "Later Write your first expense policy"]);
  });

  it("a deep link to the policies redirects to the first step not done, in the address bar too", async () => {
    renderApp("/policies", world("new"));
    expect(await screen.findByRole("heading", { level: 1, name: "Create your profile" })).toBeTruthy();
    await waitFor(() => expect(window.location.pathname).toBe("/onboarding/profile"));
  });

  it("an onboarded person sees home with the navigation", async () => {
    renderApp("/", world("done"));
    expect(await screen.findByRole("heading", { level: 1, name: "Hello, Alice" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual(["Home", "Wallet", "Policies", "Profile", "Account"]);
  });

  it("an unknown path says Not found", async () => {
    renderApp("/nowhere", world("done"));
    expect(await screen.findByRole("heading", { level: 1, name: "Not found" })).toBeTruthy();
  });
});

describe("T-WEB-02: the profile step", () => {
  it("prefills the name and email from the sign-in", async () => {
    renderApp("/", world("new"));
    expect(((await screen.findByLabelText(/^Name/)) as HTMLInputElement).value).toBe("Alice Example");
    expect((screen.getByLabelText(/^Contact email/) as HTMLInputElement).value).toBe("alice@example.test");
  });

  it("keeps Save disabled until both fields are valid and the test-funds box is ticked", async () => {
    const user = userEvent.setup();
    const view = renderApp("/", world("new"));
    const save = await screen.findByRole("button", { name: "Save and continue" });
    const box = screen.getByRole("checkbox", { name: /I understand this wallet holds test funds only/ });
    const name = screen.getByLabelText(/^Name/);
    const email = screen.getByLabelText(/^Contact email/);
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await user.click(box);
    expect((save as HTMLButtonElement).disabled).toBe(false);
    await user.clear(name);
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await user.type(name, "Alice");
    await user.clear(email);
    await user.type(email, "not-an-email");
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Enter an email address like name@example.com.")).toBeTruthy();
    await user.clear(email);
    await user.type(email, "alice@example.test");
    await user.click(box);
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await user.click(box);
    await user.click(save);
    expect(view.api.saveProfile).toHaveBeenCalledWith({ displayName: "Alice", contactEmail: "alice@example.test", acknowledgedTestFunds: true });
    // The saved profile moves the person to the next step.
    expect(await screen.findByRole("heading", { level: 1, name: "Create your wallet" })).toBeTruthy();
  });

  it("shows the server's issues by field, in a summary that takes focus", async () => {
    const user = userEvent.setup();
    const w = world("new");
    const api = fakeApi(w);
    api.saveProfile.mockResolvedValueOnce(refuse(422, "invalid_profile", { issues: [{ field: "contactEmail", code: "invalid_email" }] }));
    renderApp("/", w, { api });
    await user.click(await screen.findByRole("checkbox", { name: /test funds only/ }));
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    const summary = await screen.findByRole("alert");
    expect(document.activeElement).toBe(summary);
    expect(within(summary).getByRole("link", { name: /Contact email/ }).getAttribute("href")).toBe("#profile-contactEmail");
    expect(screen.getByRole("heading", { level: 1, name: "Create your profile" })).toBeTruthy();
  });

  it("the profile screen of an onboarded person asks for no acknowledgement and saves in place", async () => {
    const user = userEvent.setup();
    const view = renderApp("/profile", world("done"));
    const name = (await screen.findByLabelText(/^Name/)) as HTMLInputElement;
    expect(name.value).toBe("Alice");
    expect(screen.queryByRole("checkbox")).toBeNull();
    await user.clear(name);
    await user.type(name, "Alice B");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(view.api.saveProfile).toHaveBeenCalledWith({ displayName: "Alice B", contactEmail: "alice@example.test" });
    expect(await screen.findByText("Saved.")).toBeTruthy();
  });
});

describe("T-WEB-01: signed out and refused", () => {
  it("a 403 shows the refusal and no form, and nothing else is asked of the portal", async () => {
    const w = world("new");
    const api = fakeApi(w);
    api.me.mockResolvedValue(refuse(403, "forbidden"));
    renderApp("/", w, { api });
    expect(await screen.findByText(REFUSED_TEXT)).toBeTruthy();
    expect(REFUSED_TEXT).toBe("This sign-in can't be used for the portal. Sign in again from this page.");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(api.saveProfile).not.toHaveBeenCalled();
    expect(api.wallet).not.toHaveBeenCalled();
    expect(api.policies).not.toHaveBeenCalled();
  });

  it("a signed-out person sees Sign in, and signing in loads their state", async () => {
    const user = userEvent.setup();
    const auth = fakeAuth({ signedIn: false });
    const view = renderApp("/", world("done"), { auth });
    expect(view.api.me).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(auth.signIn).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("heading", { level: 1, name: "Hello, Alice" })).toBeTruthy();
  });

  it("a failed sign-in says why: the code, and what to do about it", async () => {
    const user = userEvent.setup();
    const cases: Array<[string | undefined, RegExp]> = [
      ["popup_open", /\(popup_open\)\. Your browser blocked the sign-in window\. Allow pop-ups/],
      ["cancelled", /The sign-in window was closed before it finished/],
      ["timeout", /The sign-in window was open too long without an answer/],
      ["access_denied", /\(access_denied\)\. The sign-in service refused this account/],
      ["unauthorized_client", /does not accept this portal's address or its sign-in settings\. An administrator must check/],
      ["invalid_grant", /Your session ended\. Sign in again\./],
      ["account_changed", /Another person signed in in the sign-in window, so you were signed out/],
      ["server_error", /\(server_error\)\. Try again, or give this code to your administrator/],
      [undefined, /^The sign-in did not complete\. Try again\.$/],
    ];
    for (const [code, text] of cases) {
      const auth = fakeAuth({ signedIn: false, ...(code !== undefined && { lastError: code }) });
      auth.signIn.mockResolvedValue(false);
      const view = renderApp("/", world("done"), { auth });
      await user.click(screen.getByRole("button", { name: "Sign in" }));
      expect((await screen.findByRole("alert")).textContent, String(code)).toMatch(text);
      expect(view.api.me).not.toHaveBeenCalled();
      view.unmount();
    }
  });

  it("one sign-in at a time: the button waits while the sign-in window is open", async () => {
    const user = userEvent.setup();
    const auth = fakeAuth({ signedIn: false });
    let finish: (ok: boolean) => void = () => undefined;
    auth.signIn.mockImplementation(() => new Promise<boolean>((resolve) => (finish = resolve)));
    renderApp("/", world("done"), { auth });
    const button = screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement;
    await user.click(button);
    expect(button.disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("A sign-in window is open. Finish there, or close it to try again.");
    await user.click(button);
    expect(auth.signIn).toHaveBeenCalledTimes(1);
    // The window was closed without signing in: the button is back, with the reason.
    finish(false);
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(screen.getByRole("alert").textContent).toMatch(/The sign-in did not complete/);
    await user.click(button);
    expect(auth.signIn).toHaveBeenCalledTimes(2);
  });

  it("an ended sign-in (401) goes back to Sign in", async () => {
    const w = world("done");
    const api = fakeApi(w);
    api.me.mockResolvedValue(refuse(401, "unauthorized"));
    renderApp("/", w, { api });
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByText(REFUSED_TEXT)).toBeNull();
  });

  it("when the payment service is down the person can try again", async () => {
    const user = userEvent.setup();
    const w = world("done");
    const api = fakeApi(w);
    api.me.mockResolvedValueOnce(refuse(502, "control_unavailable"));
    renderApp("/", w, { api });
    expect(await screen.findByText(/payment service can't be reached/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Hello, Alice" })).toBeTruthy();
  });
});
