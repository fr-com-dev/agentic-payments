// @vitest-environment jsdom
// T-WEB-04, T-WEB-05 and the US8 flags (specs/013 FR-024..FR-027, FR-007, FR-034, FR-035, SC-013): the summary says
// in plain words what a policy allows; the editor offers only the operator's sellers, shows the platform's limits,
// maps the server's issues to their fields, confirms identity once, and never overwrites another window's change.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { STEP_UP_FAILED_TEXT, STEP_UP_TEXT } from "../src/components/StepUp.js";
import { describeChanges } from "../src/changes.js";
import { CONFLICT_TEXT, NO_SELLERS_TEXT } from "../src/screens/PolicyEditor.js";
import { summarizePolicy } from "../src/summary.js";
import { EXAMPLE_VALUES, SELLER, SELLER_2, fakeApi, platform, policy, refuse, renderApp, world } from "./helpers.js";

const LIMITS = platform().limits;
const SELLERS = platform().sellers;

async function fill(user: UserEvent, o: { name?: string; auto?: string; cap?: string; run?: string; day?: string } = {}) {
  await user.type(await screen.findByLabelText(/^Policy name/), o.name ?? "Daily data");
  await user.click(screen.getByRole("checkbox", { name: `${SELLER.name} (${SELLER.host})` }));
  await user.type(screen.getByLabelText(/^Without asking/), o.auto ?? "0.02");
  await user.type(screen.getByLabelText(/^Per payment/), o.cap ?? "0.10");
  await user.type(screen.getByLabelText(/^Per agent run/), o.run ?? "0.10");
  await user.type(screen.getByLabelText(/^Per day/), o.day ?? "0.50");
  fireEvent.change(screen.getByLabelText(/^End date/), { target: { value: "2027-12-31" } });
}

/** An onboarded person whose policies use no seller yet, so every seller can be chosen. */
const fresh = () => world("done", { policies: [] });

const EXAMPLE_INPUT = {
  name: "Daily data",
  sellers: [SELLER.host],
  autoApproveUsdc: "0.02",
  perPaymentUsdc: "0.10",
  perRunUsdc: "0.10",
  perDayUsdc: "0.50",
  paymentsPerMinute: 10,
  endsOn: "2027-12-31",
  paymentMethod: "crypto_account",
};

describe("T-WEB-04: summarizePolicy", () => {
  it("is the example of the contract, word for word", () => {
    expect(summarizePolicy(EXAMPLE_VALUES, SELLERS, LIMITS, 6).lines.join(" ")).toBe(
      "At Local demo seller (127.0.0.1:4021): your agent pays up to 0.02 USDC per payment without asking. " +
        "From 0.02 up to 0.10 USDC a person must approve first. Above 0.10 USDC it is refused. " +
        "At most 0.10 USDC per agent run and 0.50 USDC per day, at most 10 payments a minute, until 31 Dec 2027. " +
        "Across all your policies you can spend at most 0.50 USDC in any 24 hours.",
    );
  });

  it("with an auto-approve limit of 0 says every payment needs a person's approval", () => {
    const lines = summarizePolicy({ ...EXAMPLE_VALUES, autoApproveMaxAtomic: "0" }, SELLERS, LIMITS, 6).lines;
    expect(lines[0]).toBe("Every payment needs a person's approval.");
    expect(lines.join(" ")).not.toContain("without asking");
    expect(lines.join(" ")).toContain("Above 0.10 USDC it is refused.");
  });

  it("names every seller, and a host it does not know by its host", () => {
    const text = summarizePolicy({ ...EXAMPLE_VALUES, sellers: [SELLER.host, SELLER_2.host, "gone.example.test"] }, SELLERS, LIMITS, 6).lines[0]!;
    expect(text).toContain("At Local demo seller (127.0.0.1:4021), Example data (api.example.test) and gone.example.test:");
  });

  it("never rounds an amount", () => {
    const text = summarizePolicy({ ...EXAMPLE_VALUES, autoApproveMaxAtomic: "20001", hardCapPerPaymentAtomic: "99999" }, SELLERS, LIMITS, 6).lines.join(" ");
    expect(text).toContain("0.020001 USDC");
    expect(text).toContain("0.099999 USDC");
  });
});

describe("T-WEB-05 create: the policy editor", () => {
  it("offers only the operator's sellers, and no field to type a host", async () => {
    renderApp("/policies/new", fresh());
    await screen.findByLabelText(/^Policy name/);
    const where = screen.getByRole("group", { name: "Where" });
    expect(within(where).getAllByRole("checkbox").map((c) => c.closest("div")!.textContent!.trim())).toEqual(["Local demo seller (127.0.0.1:4021)", "Example data (api.example.test)"]);
    expect(within(where).queryByRole("textbox")).toBeNull();
    // Every text field of the form, by its label: none is a seller or a host.
    expect(screen.getAllByRole("textbox").map((t) => t.id)).toEqual(["policy-name", "policy-autoApproveUsdc", "policy-perPaymentUsdc", "policy-perRunUsdc", "policy-perDayUsdc", "policy-paymentsPerMinute"]);
    for (const legend of ["Where", "How much", "How"]) expect(screen.getByRole("group", { name: legend })).toBeTruthy();
  });

  it("shows each platform limit as helper text beside its field", async () => {
    renderApp("/policies/new", world("done", { policies: [], platform: platform({ limits: { ...LIMITS, hardCapPerPaymentAtomic: "50000", sessionBudgetAtomic: "250000", userDailyCeilingAtomic: "750000", maxAuthorizationsPerMinute: 7, maxPolicyDays: 90 } }) }));
    const helpOf = (label: RegExp) => {
      const input = screen.getByLabelText(label);
      return input.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)!.textContent).join(" ");
    };
    await screen.findByLabelText(/^Policy name/);
    expect(helpOf(/^Per payment/)).toContain("up to 0.05 USDC");
    expect(helpOf(/^Per agent run/)).toContain("up to 0.25 USDC");
    expect(helpOf(/^Per day/)).toContain("up to 0.75 USDC");
    expect(helpOf(/^Payments per minute/)).toContain("up to 7");
    expect(helpOf(/^End date/)).toContain("at most 90 days from today");
    expect((screen.getByLabelText(/^Payments per minute/) as HTMLInputElement).value).toBe("7");
  });

  it("shows the summary as the person types, and saves exactly what was typed", async () => {
    const user = userEvent.setup();
    const view = renderApp("/policies/new", fresh());
    await screen.findByLabelText(/^Policy name/);
    const summary = screen.getByRole("region", { name: "What this policy allows" });
    expect(summary.textContent).toContain("Fill in the amounts");
    await fill(user);
    expect(summary.textContent).toContain("At Local demo seller (127.0.0.1:4021): your agent pays up to 0.02 USDC per payment without asking.");
    expect(summary.textContent).toContain("until 31 Dec 2027");
    await user.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(view.api.createPolicy).toHaveBeenCalledTimes(1));
    expect(view.api.createPolicy.mock.calls[0]).toEqual([EXAMPLE_INPUT]);
    expect(await screen.findByRole("heading", { level: 1, name: "Expense policies" })).toBeTruthy();
    expect(screen.getAllByText("Daily data").length).toBeGreaterThan(0);
  });

  it("accepts six decimals and refuses a seventh without sending or rounding it", async () => {
    const user = userEvent.setup();
    const view = renderApp("/policies/new", fresh());
    await fill(user, { auto: "0.020001" });
    expect(screen.queryByText(/USDC has at most 6 decimals/)).toBeNull();
    const auto = screen.getByLabelText(/^Without asking/) as HTMLInputElement;
    await user.clear(auto);
    await user.type(auto, "0.0200009");
    expect(auto.value).toBe("0.0200009");
    expect(screen.getByText("Without asking: USDC has at most 6 decimals. The amount is never rounded for you.")).toBeTruthy();
    expect(auto.getAttribute("aria-invalid")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Save policy" }));
    const alert = await screen.findByRole("alert");
    expect(document.activeElement).toBe(alert);
    expect(within(alert).getByRole("link", { name: /USDC has at most 6 decimals/ }).getAttribute("href")).toBe("#policy-autoApproveUsdc");
    expect(view.api.createPolicy).not.toHaveBeenCalled();
    expect(auto.value).toBe("0.0200009");
  });

  it("says what is missing instead of sending an empty form", async () => {
    const user = userEvent.setup();
    const view = renderApp("/policies/new", fresh());
    await user.click(await screen.findByRole("button", { name: "Save policy" }));
    const alert = await screen.findByRole("alert");
    const messages = within(alert).getAllByRole("listitem").map((li) => li.textContent);
    expect(messages).toContain("Sellers: choose at least one seller.");
    expect(messages).toContain("Per payment: enter an amount in USDC, like 0.02.");
    expect(messages.some((m) => m!.startsWith("Name:"))).toBe(true);
    expect(view.api.createPolicy).not.toHaveBeenCalled();
  });

  it("puts the server's issues on their fields and in the error summary, which takes focus", async () => {
    const user = userEvent.setup();
    const w = world("done", { policies: [policy("pol_other", { name: "Weekly reports", values: { ...EXAMPLE_VALUES, sellers: [SELLER_2.host] } })] });
    const api = fakeApi(w);
    api.createPolicy.mockResolvedValueOnce(
      refuse(422, "invalid_policy", {
        issues: [
          { field: "perPaymentUsdc", code: "above_platform_limit", limitAtomic: "50000" },
          { field: "sellers[0]", code: "seller_conflict", host: SELLER.host, policyId: "pol_other" },
          { field: "endsOn", code: "expires_too_late", limit: 30 },
        ],
      }),
    );
    renderApp("/policies/new", w, { api });
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Save policy" }));
    const alert = await screen.findByRole("alert");
    expect(document.activeElement).toBe(alert);
    expect(within(alert).getByRole("link", { name: "Per payment: the most allowed is 0.05 USDC." }).getAttribute("href")).toBe("#policy-perPaymentUsdc");
    expect(within(alert).getByRole("link", { name: 'Local demo seller is already in your policy "Weekly reports". A seller can be in one active policy.' }).getAttribute("href")).toBe("#policy-sellers");
    expect(within(alert).getByRole("link", { name: "End date: it can be at most 30 days from today." }).getAttribute("href")).toBe("#policy-endsOn");
    const cap = screen.getByLabelText(/^Per payment/);
    expect(cap.getAttribute("aria-invalid")).toBe("true");
    expect(cap.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)!.textContent)).toContain("Per payment: the most allowed is 0.05 USDC.");
    expect(document.getElementById("policy-sellers-error")!.textContent).toContain("Weekly reports");
    // Still on the editor, with the person's values intact.
    expect((cap as HTMLInputElement).value).toBe("0.10");
    for (const link of within(alert).getAllByRole("link")) expect(document.querySelector(link.getAttribute("href")!)).not.toBeNull();
  });

  it("with an empty seller list says so and shows no form", async () => {
    renderApp("/onboarding/policy", world("wallet", { platform: platform({ sellers: [] }) }));
    expect(await screen.findByText(new RegExp(NO_SELLERS_TEXT))).toBeTruthy();
    expect(NO_SELLERS_TEXT).toBe("No sellers are available yet");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save policy" })).toBeNull();
  });

  it("the first saved policy completes onboarding", async () => {
    const user = userEvent.setup();
    const view = renderApp("/", world("wallet"));
    expect(await screen.findByRole("heading", { level: 1, name: "Write your first expense policy" })).toBeTruthy();
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Save policy" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Hello, Alice" })).toBeTruthy();
    expect(view.api.createPolicy).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("navigation", { name: "Main" })).toBeTruthy();
  });

  it("a seller of another active policy is disabled with the policy's name; a paused policy's seller is free", async () => {
    const w = world("done", {
      policies: [
        policy("pol_a", { name: "Weekly reports", values: { ...EXAMPLE_VALUES, sellers: [SELLER.host] } }),
        policy("pol_b", { name: "Old one", state: "paused", displayState: "paused", values: { ...EXAMPLE_VALUES, sellers: [SELLER_2.host] } }),
      ],
    });
    renderApp("/policies/new", w);
    const taken = (await screen.findByRole("checkbox", { name: `${SELLER.name} (${SELLER.host})` })) as HTMLInputElement;
    expect(taken.disabled).toBe(true);
    expect(document.getElementById(taken.getAttribute("aria-describedby")!)!.textContent).toContain("Already in Weekly reports");
    expect((screen.getByRole("checkbox", { name: `${SELLER_2.name} (${SELLER_2.host})` }) as HTMLInputElement).disabled).toBe(false);
  });
});

describe("T-WEB-05: changing a policy", () => {
  const editing = () => world("done", { policies: [policy("pol_1", { name: "Daily data", version: 3 })] });

  it("loads the saved values and sends the version it was loaded at", async () => {
    const user = userEvent.setup();
    const view = renderApp("/policies/pol_1", editing());
    const cap = (await screen.findByLabelText(/^Per payment/)) as HTMLInputElement;
    expect(cap.value).toBe("0.1");
    expect((screen.getByLabelText(/^Policy name/) as HTMLInputElement).value).toBe("Daily data");
    expect((screen.getByLabelText(/^End date/) as HTMLInputElement).value).toBe("2027-12-31");
    expect((screen.getByRole("checkbox", { name: `${SELLER.name} (${SELLER.host})` }) as HTMLInputElement).checked).toBe(true);
    await user.clear(cap);
    await user.type(cap, "0.05");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(view.api.changePolicy).toHaveBeenCalledTimes(1));
    expect(view.api.changePolicy.mock.calls[0]).toEqual(["pol_1", { ...EXAMPLE_INPUT, perPaymentUsdc: "0.05", perRunUsdc: "0.1", perDayUsdc: "0.5" }, 3]);
    expect(await screen.findByRole("heading", { level: 1, name: "Expense policies" })).toBeTruthy();
  });

  it("step_up_required asks to confirm identity and sends the same values again, exactly once", async () => {
    const user = userEvent.setup();
    const w = editing();
    const api = fakeApi(w);
    api.changePolicy.mockResolvedValueOnce(refuse(403, "step_up_required", { maxAgeSec: 900 }));
    const view = renderApp("/policies/pol_1", w, { api });
    const cap = (await screen.findByLabelText(/^Per day/)) as HTMLInputElement;
    await user.clear(cap);
    await user.type(cap, "0.4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(new RegExp(STEP_UP_TEXT))).toBeTruthy();
    expect(STEP_UP_TEXT).toBe("Confirm it's you to make this change.");
    // Nothing is sent again until the person confirms.
    expect(api.changePolicy).toHaveBeenCalledTimes(1);
    expect(view.auth.confirmIdentity).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm it's you" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Expense policies" })).toBeTruthy();
    expect(view.auth.confirmIdentity).toHaveBeenCalledTimes(1);
    expect(api.changePolicy).toHaveBeenCalledTimes(2);
    expect(api.changePolicy.mock.calls[1]).toEqual(api.changePolicy.mock.calls[0]);
  });

  it("a second refusal is shown and never retried again; a person who does not confirm changes nothing", async () => {
    const user = userEvent.setup();
    const w = editing();
    const api = fakeApi(w);
    api.changePolicy.mockResolvedValue(refuse(403, "step_up_required", { maxAgeSec: 900 }));
    const view = renderApp("/policies/pol_1", w, { api });
    await screen.findByLabelText(/^Per day/);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await user.click(await screen.findByRole("button", { name: "Confirm it's you" }));
    expect(await screen.findByText(STEP_UP_FAILED_TEXT)).toBeTruthy();
    expect(api.changePolicy).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Confirm it's you" })).toBeNull();

    view.auth.confirmIdentity.mockResolvedValueOnce(false);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await user.click(await screen.findByRole("button", { name: "Confirm it's you" }));
    expect(await screen.findByText(STEP_UP_FAILED_TEXT)).toBeTruthy();
    // The third call is the new save; declining to confirm sent nothing after it.
    expect(api.changePolicy).toHaveBeenCalledTimes(3);
  });

  it("a version conflict shows both sets of values and overwrites nothing", async () => {
    const user = userEvent.setup();
    const w = editing();
    const api = fakeApi(w);
    const current = policy("pol_1", { name: "Daily data", version: 4, values: { ...EXAMPLE_VALUES, hardCapPerPaymentAtomic: "50000" } });
    api.changePolicy.mockResolvedValueOnce(refuse(409, "version_conflict", { current }));
    renderApp("/policies/pol_1", w, { api });
    const cap = (await screen.findByLabelText(/^Per payment/)) as HTMLInputElement;
    await user.clear(cap);
    await user.type(cap, "0.03");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    const conflict = (await screen.findByRole("heading", { name: CONFLICT_TEXT })).closest("div")!;
    expect(CONFLICT_TEXT).toBe("This policy was changed in another window");
    const row = within(conflict).getByRole("row", { name: /Per payment/ });
    expect(within(row).getAllByRole("cell").map((c) => c.textContent)).toEqual(["0.05 USDC", "0.03 USDC (different)"]);
    const same = within(conflict).getByRole("row", { name: /Per day/ });
    expect(within(same).getAllByRole("cell").map((c) => c.textContent)).toEqual(["0.5 USDC", "0.5 USDC"]);
    // Nothing was sent again, and the person's values are still in the form.
    expect(api.changePolicy).toHaveBeenCalledTimes(1);
    expect(cap.value).toBe("0.03");

    // Keeping their values is a deliberate second save, against the version they have now seen.
    await user.click(within(conflict).getByRole("button", { name: "Keep editing my values" }));
    expect(screen.queryByText(CONFLICT_TEXT)).toBeNull();
    expect(cap.value).toBe("0.03");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.changePolicy).toHaveBeenCalledTimes(2));
    expect(api.changePolicy.mock.calls[1]![2]).toBe(4);
  });

  it("choosing the current values loads them and sends nothing", async () => {
    const user = userEvent.setup();
    const w = editing();
    const api = fakeApi(w);
    api.changePolicy.mockResolvedValueOnce(refuse(409, "version_conflict", { current: policy("pol_1", { name: "Renamed", version: 4, values: { ...EXAMPLE_VALUES, hardCapPerPaymentAtomic: "50000" } }) }));
    renderApp("/policies/pol_1", w, { api });
    const cap = (await screen.findByLabelText(/^Per payment/)) as HTMLInputElement;
    await user.clear(cap);
    await user.type(cap, "0.03");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await user.click(await screen.findByRole("button", { name: "Use the current values" }));
    expect(cap.value).toBe("0.05");
    expect((screen.getByLabelText(/^Policy name/) as HTMLInputElement).value).toBe("Renamed");
    expect(api.changePolicy).toHaveBeenCalledTimes(1);
  });

  it("another person's policy, or an unknown one, is Not found", async () => {
    renderApp("/policies/pol_someone_else", editing());
    expect(await screen.findByText("Not found")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("a removed policy can be read but not changed", async () => {
    renderApp("/policies/pol_1", world("done", { policies: [policy("pol_1", { name: "Gone", state: "removed", displayState: "removed" })] }));
    expect(await screen.findByText("This policy was removed and can't be changed.")).toBeTruthy();
    expect(screen.getByText("Removed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

describe("T-WEB-05: the policy list and history", () => {
  const several = () =>
    world("done", {
      policies: [
        policy("pol_a", { name: "Daily data" }),
        policy("pol_b", { name: "On hold", state: "paused", displayState: "paused", values: { ...EXAMPLE_VALUES, sellers: [SELLER_2.host] } }),
        policy("pol_c", { name: "Last year", displayState: "expired", expired: true, values: { ...EXAMPLE_VALUES, sellers: [SELLER_2.host], expiresAt: "2025-12-31T23:59:59.999Z" } }),
        policy("pol_d", { name: "Gone", state: "removed", displayState: "removed", values: { ...EXAMPLE_VALUES, sellers: [SELLER_2.host] } }),
      ],
    });
  const item = (name: string) => screen.getByRole("link", { name }).closest("li")!;

  it("shows each state as a word, the expired flag, and what each policy allows", async () => {
    renderApp("/policies", several());
    await screen.findByRole("link", { name: "Daily data" });
    expect(within(item("Daily data")).getByText("Active")).toBeTruthy();
    expect(within(item("On hold")).getByText("Paused")).toBeTruthy();
    expect(within(item("Last year")).getByText("Expired")).toBeTruthy();
    expect(within(item("Gone")).getByText("Removed")).toBeTruthy();
    expect(item("Daily data").textContent).toContain("At Local demo seller (127.0.0.1:4021): your agent pays up to 0.02 USDC per payment without asking.");
    expect(item("Last year").textContent).toContain("until 31 Dec 2025");
  });

  it("offers pause for an active policy, resume for a paused one and nothing to change for a removed one", async () => {
    const user = userEvent.setup();
    const view = renderApp("/policies", several());
    await screen.findByRole("link", { name: "Daily data" });
    expect(within(item("Daily data")).getByRole("button", { name: "Pause Daily data" })).toBeTruthy();
    expect(within(item("On hold")).getByRole("button", { name: "Resume On hold" })).toBeTruthy();
    expect(within(item("Gone")).queryByRole("button")).toBeNull();
    await user.click(within(item("Daily data")).getByRole("button", { name: "Pause Daily data" }));
    await waitFor(() => expect(within(item("Daily data")).getByText("Paused")).toBeTruthy());
    expect(view.api.pausePolicy.mock.calls).toEqual([["pol_a"]]);
    expect(view.auth.confirmIdentity).not.toHaveBeenCalled();
  });

  it("resume may ask to confirm identity, once", async () => {
    const user = userEvent.setup();
    const w = several();
    const api = fakeApi(w);
    api.resumePolicy.mockResolvedValueOnce(refuse(403, "step_up_required", { maxAgeSec: 900 }));
    const view = renderApp("/policies", w, { api });
    await screen.findByRole("link", { name: "On hold" });
    await user.click(within(item("On hold")).getByRole("button", { name: "Resume On hold" }));
    await user.click(await screen.findByRole("button", { name: "Confirm it's you" }));
    await waitFor(() => expect(within(item("On hold")).getByText("Active")).toBeTruthy());
    expect(view.auth.confirmIdentity).toHaveBeenCalledTimes(1);
    expect(api.resumePolicy.mock.calls).toEqual([["pol_b"], ["pol_b"]]);
  });

  it("a resume that is refused says why", async () => {
    const user = userEvent.setup();
    const w = several();
    const api = fakeApi(w);
    api.resumePolicy.mockResolvedValueOnce(refuse(422, "invalid_policy", { issues: [{ field: "sellers[0]", code: "seller_conflict", host: SELLER_2.host, policyId: "pol_a" }] }));
    renderApp("/policies", w, { api });
    await screen.findByRole("link", { name: "On hold" });
    await user.click(within(item("On hold")).getByRole("button", { name: "Resume On hold" }));
    expect((await screen.findByRole("alert")).textContent).toContain('Example data is already in your policy "Daily data".');
    expect(within(item("On hold")).getByText("Paused")).toBeTruthy();
  });

  it("remove asks to confirm first", async () => {
    const user = userEvent.setup();
    const view = renderApp("/policies", several());
    await screen.findByRole("link", { name: "Daily data" });
    await user.click(within(item("Daily data")).getByRole("button", { name: "Remove Daily data" }));
    const dialog = screen.getByRole("dialog", { name: "Remove this policy?" });
    expect(view.api.removePolicy).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Remove policy" }));
    await waitFor(() => expect(within(item("Daily data")).getByText("Removed")).toBeTruthy());
    expect(view.api.removePolicy.mock.calls).toEqual([["pol_a"]]);
  });

  it("the history lists every version with what it allowed", async () => {
    const w = world("done", {
      policies: [
        policy("pol_1", {
          name: "Daily data",
          version: 2,
          state: "paused",
          displayState: "paused",
          history: [
            { seq: 4, ts: "2026-11-01T10:00:00.000Z", kind: "created", version: 1, values: { ...EXAMPLE_VALUES, hardCapPerPaymentAtomic: "50000" } },
            { seq: 9, ts: "2026-11-02T10:00:00.000Z", kind: "changed", version: 2, values: EXAMPLE_VALUES },
            { seq: 12, ts: "2026-11-03T10:00:00.000Z", kind: "paused", version: 2, cause: "account_enabled" },
          ],
        }),
      ],
    });
    renderApp("/policies/pol_1/history", w);
    expect(await screen.findByRole("heading", { level: 1, name: "Policy history" })).toBeTruthy();
    await screen.findByRole("heading", { name: "Created · version 1" });
    const entries = Array.from(document.querySelectorAll<HTMLElement>(".history > li"));
    expect(entries.map((e) => within(e).getByRole("heading").textContent)).toEqual(["Created · version 1", "Changed · version 2", "Paused when the account was enabled again · version 2"]);
    // FR-047: a changed version says what changed, against the version before it; the others have nothing to compare.
    expect(within(within(entries[1]!).getByRole("list", { name: "What changed in version 2" })).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Per payment: was 0.05 USDC, now 0.10 USDC."]);
    expect(within(entries[0]!).queryByRole("list")).toBeNull();
    expect(within(entries[2]!).queryByRole("list")).toBeNull();
    expect(entries[0]!.textContent).toContain("2026-11-01 10:00:00 UTC");
    expect(entries[0]!.textContent).toContain("Above 0.05 USDC it is refused.");
    expect(entries[1]!.textContent).toContain("Above 0.10 USDC it is refused.");
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

describe("013 FR-047: what changed between two versions", () => {
  it("names each value that differs, sellers added and removed, in the editor's order", () => {
    const after = { ...EXAMPLE_VALUES, sellers: [SELLER_2.host, "new.example.test"], autoApproveMaxAtomic: "0", dailyBudgetAtomic: "400001", maxAuthorizationsPerMinute: 5, expiresAt: "2028-01-31T23:59:59.999Z" };
    expect(describeChanges(EXAMPLE_VALUES, after, SELLERS, 6)).toEqual([
      "Seller added: Example data (api.example.test).",
      "Seller added: new.example.test.",
      "Seller removed: Local demo seller (127.0.0.1:4021).",
      "Without asking: was 0.02 USDC, now 0.00 USDC.",
      "Per day: was 0.50 USDC, now 0.400001 USDC.",
      "Payments per minute: was 10, now 5.",
      "End date: was 31 Dec 2027, now 31 Jan 2028.",
    ]);
  });

  it("says nothing when the values are the same", () => {
    expect(describeChanges(EXAMPLE_VALUES, { ...EXAMPLE_VALUES, sellers: [...EXAMPLE_VALUES.sellers] }, SELLERS, 6)).toEqual([]);
  });
});

describe("013 US5 scenario 7: an expired policy can be extended", () => {
  const expired = () =>
    world("done", {
      policies: [
        policy("pol_x", { name: "Last year", displayState: "expired", expired: true, values: { ...EXAMPLE_VALUES, expiresAt: "2025-12-31T23:59:59.999Z" } }),
        policy("pol_r", { name: "Gone", state: "removed", displayState: "removed", expired: true, values: { ...EXAMPLE_VALUES, sellers: [SELLER_2.host], expiresAt: "2025-12-31T23:59:59.999Z" } }),
        policy("pol_a", { name: "Current", values: { ...EXAMPLE_VALUES, sellers: [SELLER_2.host] } }),
      ],
    });

  it("the list offers Extend for an expired policy only, and it opens the editor on that policy", async () => {
    const user = userEvent.setup();
    renderApp("/policies", expired());
    const extend = await screen.findByRole("link", { name: "Extend Last year" });
    expect(screen.queryByRole("link", { name: "Extend Gone" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Extend Current" })).toBeNull();
    await user.click(extend);
    expect(await screen.findByText(/This policy ended on 31 Dec 2025, so your agent can't pay under it\. To extend it, choose a later/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "end date" }).getAttribute("href")).toBe("#policy-endsOn");
    expect(document.getElementById("policy-endsOn")).not.toBeNull();
  });

  it("extending is a save with a later end date", async () => {
    const user = userEvent.setup();
    const view = renderApp("/policies/pol_x", expired());
    fireEvent.change(await screen.findByLabelText(/^End date/), { target: { value: "2027-06-30" } });
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(view.api.changePolicy).toHaveBeenCalledTimes(1));
    expect(view.api.changePolicy.mock.calls[0]![1].endsOn).toBe("2027-06-30");
  });

  it("a policy that has not expired shows no such notice, and a disabled account is offered no Extend", async () => {
    const first = renderApp("/policies/pol_a", expired());
    await screen.findByLabelText(/^End date/);
    expect(screen.queryByText(/This policy ended on/)).toBeNull();
    first.unmount();
    const w = expired();
    w.me = { ...w.me, enabled: false };
    renderApp("/policies", w);
    await screen.findByRole("link", { name: "Last year" });
    expect(screen.queryByRole("link", { name: /^Extend/ })).toBeNull();
  });
});

describe("013 US8 web: flags", () => {
  const limited = () =>
    world("done", {
      platform: platform({ limits: { ...LIMITS, hardCapPerPaymentAtomic: "50000" } }),
      policies: [policy("pol_1", { name: "Daily data", limitedByPlatform: ["hardCapPerPaymentAtomic"], unlistedSellers: ["gone.example.test"], values: { ...EXAMPLE_VALUES, sellers: [SELLER.host, "gone.example.test"] } })],
    });

  it("the list says what the platform limits and which seller is gone", async () => {
    renderApp("/policies", limited());
    expect(await screen.findByText("Limited by the platform: per payment up to 0.05 USDC")).toBeTruthy();
    expect(screen.getByText("Seller no longer available: gone.example.test")).toBeTruthy();
  });

  it("the editor shows the same flags and lets the person drop the seller", async () => {
    const user = userEvent.setup();
    const view = renderApp("/policies/pol_1", limited());
    expect(await screen.findByText("Limited by the platform: per payment up to 0.05 USDC")).toBeTruthy();
    const gone = screen.getByRole("checkbox", { name: "gone.example.test" }) as HTMLInputElement;
    expect(gone.checked).toBe(true);
    expect(document.getElementById(gone.getAttribute("aria-describedby")!)!.textContent).toContain("Seller no longer available");
    await user.click(gone);
    const cap = screen.getByLabelText(/^Per payment/);
    await user.clear(cap);
    await user.type(cap, "0.05");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(view.api.changePolicy).toHaveBeenCalledTimes(1));
    expect(view.api.changePolicy.mock.calls[0]![1].sellers).toEqual([SELLER.host]);
  });

  it("home flags an active policy that is limited or has a seller that is gone", async () => {
    renderApp("/", limited());
    expect(await screen.findByText(/Limited by the platform/)).toBeTruthy();
    expect(screen.getByText(/A seller is no longer available/)).toBeTruthy();
  });
});
