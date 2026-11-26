// @vitest-environment jsdom
// T-WEB-19 (specs/020 FR-009; contracts/portal-ui.md "Connecting", contracts/portal-api.md "The return screen"):
// Coinbase sends the browser back to /wallet/coinbase. The screen reads `code`, `state` and `error` once, takes them
// out of the address and the history before anything else, and only then hands them to the portal with the person's
// own token. Each answer has its sentence; nothing of the trip is kept in the browser's storage.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi, type ApiError } from "../src/api.js";
import {
  COINBASE_CONNECTED_TEXT,
  COINBASE_PART_TITLE,
  COINBASE_UNREACHABLE_TEXT,
  GOING_TO_COINBASE_TEXT,
  INVALID_STATE_TEXT,
  NOTHING_CONNECTED_TEXT,
  SCOPE_TOO_NARROW_TEXT,
  SCOPE_TOO_WIDE_TEXT,
} from "../src/messages.js";
import { AUTHORIZE_URL, account, coinbaseRow, fakeApi, refuse, renderApp, stubLeaving, world, type World } from "./helpers.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const RETURN = "/wallet/coinbase";
const notConnected = (): World => world("done", { wallet: { account: account(), cards: [], cardsAvailable: true, disabled: false, connections: [coinbaseRow("not_connected")] } });
const main = () => within(screen.getByRole("main"));
/** The return screen's buttons, by their text. */
const buttons = () => main().queryAllByRole("button").map((b) => b.textContent);

describe("T-WEB-19: the Coinbase return screen", () => {
  it("T-WEB-19 reads the code and state once, takes them out of the address before calling complete, and shows the wallet with 'Coinbase connected.'", async () => {
    expect(COINBASE_CONNECTED_TEXT).toBe("Coinbase connected.");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const w = notConnected();
    const api = fakeApi(w);
    const complete = api.completeCoinbase.getMockImplementation()!;
    const addressAtCall: string[] = [];
    api.completeCoinbase.mockImplementation(async (code, state) => {
      addressAtCall.push(window.location.href);
      return complete(code, state);
    });
    // Rendered as main.tsx renders it, in StrictMode, where every effect runs twice on mount.
    renderApp(`${RETURN}?code=c0de-from-coinbase&state=st4te-from-portal&scope=wallet%3Aaccounts%3Aread`, w, { api, strict: true });
    expect(await screen.findByText(COINBASE_CONNECTED_TEXT)).toBeTruthy();
    expect(await screen.findByRole("heading", { level: 1, name: "Wallet" })).toBeTruthy();
    const part = within(screen.getByRole("region", { name: COINBASE_PART_TITLE }));
    expect(await part.findByText("Connected on 25 Nov 2026")).toBeTruthy();
    // Once: a single-use state handed over twice would be refused the second time.
    expect(api.completeCoinbase.mock.calls).toEqual([["c0de-from-coinbase", "st4te-from-portal"]]);
    expect(addressAtCall).toEqual([`${window.location.origin}${RETURN}`]);
    expect(replaceState.mock.calls.some((c) => c[2] === RETURN)).toBe(true);
    expect(window.location.pathname).toBe(RETURN);
    expect(window.location.search).toBe("");
    // Nothing of the trip in the browser's storage.
    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("T-WEB-19 a refusal at Coinbase: 'Nothing was connected.', a way back, and no call", async () => {
    expect(NOTHING_CONNECTED_TEXT).toBe("Nothing was connected.");
    const user = userEvent.setup();
    const view = renderApp(`${RETURN}?error=access_denied&error_description=The+user+denied&state=st4te`, notConnected());
    expect(await screen.findByText(NOTHING_CONNECTED_TEXT)).toBeTruthy();
    // Coinbase's own words are not shown.
    expect(screen.queryByText(/denied/)).toBeNull();
    expect(window.location.search).toBe("");
    expect(view.api.completeCoinbase).not.toHaveBeenCalled();
    expect(view.api.startCoinbase).not.toHaveBeenCalled();
    const back = main().getByRole("link", { name: "Back to your wallet" });
    expect(back.getAttribute("href")).toBe("/wallet");
    await user.click(back);
    expect(await screen.findByRole("button", { name: "Connect Coinbase" })).toBeTruthy();
    expect(window.location.pathname).toBe("/wallet");
  });

  it("T-WEB-19 a return with no code or state calls nothing; the screen opened again (a reload) is just the wallet", async () => {
    let view = renderApp(`${RETURN}?code=c0de`, notConnected());
    expect(await screen.findByText(NOTHING_CONNECTED_TEXT)).toBeTruthy();
    expect(view.api.completeCoinbase).not.toHaveBeenCalled();
    view.unmount();
    view = renderApp(RETURN, notConnected());
    expect(await screen.findByRole("heading", { level: 1, name: "Wallet" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Connect Coinbase" })).toBeTruthy();
    expect(screen.queryByText(NOTHING_CONNECTED_TEXT)).toBeNull();
    expect(view.api.completeCoinbase).not.toHaveBeenCalled();
  });

  it("T-WEB-19 each refusal of complete has its sentence, says nothing was connected, and offers a way back", async () => {
    expect(INVALID_STATE_TEXT).toBe("This connection wasn't started here, or took too long. Nothing was connected.");
    expect(SCOPE_TOO_NARROW_TEXT).toBe("Coinbase didn't give permission to read your balances. Nothing was connected.");
    expect(SCOPE_TOO_WIDE_TEXT).toBe("Coinbase gave more access than reading. We refused it and nothing was connected.");
    expect(COINBASE_UNREACHABLE_TEXT).toBe("Coinbase couldn't be reached. Nothing was connected. Try again later.");
    const cases: Array<[ApiError, string, string[]]> = [
      [refuse(400, "invalid_state"), INVALID_STATE_TEXT, ["Try again"]],
      [refuse(400, "invalid_request"), INVALID_STATE_TEXT, ["Try again"]],
      [refuse(400, "scope_refused", { reason: "too_narrow" }), SCOPE_TOO_NARROW_TEXT, ["Try again"]],
      [refuse(400, "scope_refused", { reason: "too_wide" }), SCOPE_TOO_WIDE_TEXT, []],
      [refuse(409, "profile_required"), "Complete your profile first.", []],
      [refuse(409, "account_disabled"), "Your account is disabled. Enable it to make changes.", []],
      [refuse(502, "platform_unavailable"), COINBASE_UNREACHABLE_TEXT, []],
      [refuse(502, "control_unavailable"), COINBASE_UNREACHABLE_TEXT, []],
      [refuse(503, "unavailable"), COINBASE_UNREACHABLE_TEXT, []],
    ];
    for (const [answer, text, offered] of cases) {
      const label = `${String(answer.status)} ${answer.error} ${answer.reason ?? ""}`;
      const w = notConnected();
      const api = fakeApi(w);
      api.completeCoinbase.mockResolvedValueOnce(answer);
      const view = renderApp(`${RETURN}?code=c0de&state=st4te`, w, { api });
      expect(await screen.findByText(text), label).toBeTruthy();
      expect(buttons(), label).toEqual(offered);
      expect(main().getByRole("link", { name: "Back to your wallet" }).getAttribute("href"), label).toBe("/wallet");
      expect(screen.queryByText(COINBASE_CONNECTED_TEXT), label).toBeNull();
      expect(api.completeCoinbase.mock.calls, label).toEqual([["c0de", "st4te"]]);
      expect(window.location.search, label).toBe("");
      view.unmount();
    }
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("T-WEB-19 Try again starts a new connection, in the same tab", async () => {
    const user = userEvent.setup();
    const leave = stubLeaving();
    const w = notConnected();
    const api = fakeApi(w);
    api.completeCoinbase.mockResolvedValueOnce(refuse(400, "invalid_state"));
    renderApp(`${RETURN}?code=c0de&state=st4te`, w, { api });
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(leave.mock.calls).toEqual([[AUTHORIZE_URL]]));
    expect(api.startCoinbase).toHaveBeenCalledTimes(1);
    expect(main().getByRole("button", { name: GOING_TO_COINBASE_TEXT })).toBeTruthy();
    expect(api.completeCoinbase).toHaveBeenCalledTimes(1);
  });

  it("T-WEB-19 the four calls send no user, connection or grant: complete carries the code and the state and nothing else", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const answers = [
      { authorizeUrl: AUTHORIZE_URL },
      { platform: "coinbase", status: "connected", connectedAt: "2026-11-25T14:02:11.000Z" },
      { status: "unreadable" },
      { status: "unreadable" },
      { revokedAtPlatform: false },
    ];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(answers.shift()), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const api = createApi(async () => "the.access.token", fetchImpl);
    expect(await api.startCoinbase()).toEqual({ ok: true, data: { authorizeUrl: AUTHORIZE_URL } });
    await api.completeCoinbase("c0de", "st4te");
    await api.coinbaseBalances();
    await api.coinbaseBalances(true);
    expect(await api.deleteCoinbase()).toEqual({ ok: true, data: { revokedAtPlatform: false } });
    expect(calls.map((c) => [c.init.method, c.url, c.init.body ?? null])).toEqual([
      ["POST", "/api/connections/coinbase/start", null],
      ["POST", "/api/connections/coinbase/complete", JSON.stringify({ code: "c0de", state: "st4te" })],
      ["GET", "/api/connections/coinbase/balances", null],
      ["GET", "/api/connections/coinbase/balances?fresh=1", null],
      ["DELETE", "/api/connections/coinbase", null],
    ]);
    for (const { init } of calls) expect((init.headers as Record<string, string>).authorization).toBe("Bearer the.access.token");
    // A refused scope keeps its reason, and nothing else the server might add.
    const refused = createApi(async () => "t", (async () =>
      new Response(JSON.stringify({ error: "scope_refused", reason: "too_wide", scopes: ["wallet:transactions:send"] }), { status: 400 })) as unknown as typeof fetch);
    expect(await refused.completeCoinbase("c", "s")).toEqual({ ok: false, status: 400, error: "scope_refused", reason: "too_wide" });
  });
});
