// @vitest-environment jsdom
// T-WEB-07 (specs/013 NFR-006, FR-016, FR-018): everything a person typed is rendered as text, never as markup; the
// web app has no way to inject HTML, holds no credential of the platform, and never puts a token in a URL or in
// storage of its own.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createApi } from "../src/api.js";
import { createDevAuth } from "../src/auth/dev.js";
import { EXAMPLE_VALUES, account, card, policy, renderApp, world } from "./helpers.js";

const SRC = resolve(import.meta.dirname, "../src");
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
const sources = () => files(SRC).map((file) => ({ file, code: readFileSync(file, "utf8") }));
/** The code without its comments, so a rule about code is not tripped by a sentence that names what is forbidden. */
const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const MARKUP = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';

describe("T-WEB-07: nothing typed is ever markup", () => {
  it("no source file can inject HTML or run text as code", () => {
    for (const { file, code } of sources()) {
      const body = stripComments(code);
      for (const banned of ["dangerouslySetInnerHTML", ".innerHTML", ".outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function("]) {
        expect(body.includes(banned), `${file}: ${banned}`).toBe(false);
      }
    }
  });

  it("a display name with markup renders as text", async () => {
    const w = world("done");
    w.me = { ...w.me, profile: { displayName: MARKUP, contactEmail: "alice@example.test" } };
    const view = renderApp("/", w);
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe(`Hello, ${MARKUP}`);
    expect(view.container.querySelector("img, script")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("a policy name with markup renders as text in the list, the editor, the history and the dialogs", async () => {
    const policies = [policy("pol_1", { name: MARKUP }), policy("pol_2", { name: "Other", values: { ...EXAMPLE_VALUES, sellers: ["api.example.test"] } })];
    for (const path of ["/", "/policies", "/policies/pol_1/history", "/policies/pol_2"]) {
      const view = renderApp(path, world("done", { policies }));
      await waitFor(() => expect(view.container.textContent, path).toContain("<img src=x"));
      expect(view.container.querySelector("img, script"), path).toBeNull();
      view.unmount();
    }
    // In the editor of another policy the name appears as the reason a seller is taken.
    const other = renderApp("/policies/pol_2", world("done", { policies }));
    expect(await screen.findByText(new RegExp("Already in <img src=x"))).toBeTruthy();
    other.unmount();
    // In its own editor the name is the value of a text field, exactly as typed.
    const own = renderApp("/policies/pol_1", world("done", { policies }));
    expect(((await screen.findByLabelText(/^Policy name/)) as HTMLInputElement).value).toBe(MARKUP);
    expect(own.container.querySelector("img, script")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("a card nickname with markup renders as text", async () => {
    const view = renderApp("/wallet", world("done", { wallet: { account: account(), cards: [card(1, { nickname: MARKUP })], cardsAvailable: true, disabled: false } }));
    await waitFor(() => expect(view.container.textContent).toContain("<img src=x"));
    expect(view.container.querySelector("img, script")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});

describe("T-WEB-07: the browser holds only the person's own sign-in", () => {
  it("no source file names a secret of the platform or keeps a token itself", () => {
    for (const { file, code } of sources()) {
      const body = stripComments(code);
      for (const banned of ["PORTAL_TOKEN", "PAYER_PRIVATE_KEY", "USER_WALLET_MNEMONIC", "CARD_VAULT_KEY", "sk_test_", "sk_live_", "rk_test_", "rk_live_", "localStorage", "document.cookie"]) {
        expect(body.includes(banned), `${file}: ${banned}`).toBe(false);
      }
      // Session storage belongs to the sign-in library alone: the app names it only to configure that library.
      if (body.includes("sessionStorage")) expect(file.endsWith("auth/entra.ts"), file).toBe(true);
    }
  });

  it("the token travels in the Authorization header only, and no call carries a user identifier", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const api = createApi(async () => "the.access.token", fetchImpl);
    await api.me();
    await api.saveProfile({ displayName: "Alice", contactEmail: "alice@example.test" });
    await api.wallet();
    await api.createAccount();
    await api.cardSetup();
    await api.confirmCard("seti_1", "Travel");
    await api.removeCard("pm_1");
    await api.policies();
    await api.policy("pol_1");
    await api.pausePolicy("pol_1");
    await api.disableAccount();
    await api.enableAccount();
    await api.config();
    expect(calls.length).toBe(13);
    for (const { url, init } of calls) {
      expect(url.includes("the.access.token"), url).toBe(false);
      expect(/usr_|userId|[?&]/.test(url), url).toBe(false);
      expect(String(init.body ?? "").includes("the.access.token")).toBe(false);
      expect(/userId|usr_/.test(String(init.body ?? ""))).toBe(false);
    }
    // 014 (FR-023): the six administration calls. A payment is named by its own ID and by nothing else: no user, no
    // session, no decider and no text. The only body field ever sent is a rejection's reason code.
    const ID = "auth_00000000-0000-4000-8000-000000000000";
    const before = calls.length;
    await api.adminEscalations();
    await api.adminEscalation(ID);
    await api.approveEscalation(ID);
    await api.rejectEscalation(ID, "wrong_seller");
    await api.adminEvents();
    await api.adminEvents({ after: 41, limit: 200 });
    await api.adminEvents({ before: 12 });
    await api.adminLedgerCheck();
    const admin = calls.slice(before);
    expect(admin.map((c) => [c.init.method, c.url, c.init.body ?? null])).toEqual([
      ["GET", "/api/admin/escalations", null],
      ["GET", `/api/admin/escalations/${ID}`, null],
      ["POST", `/api/admin/escalations/${ID}/approve`, "{}"],
      ["POST", `/api/admin/escalations/${ID}/reject`, JSON.stringify({ reasonCode: "wrong_seller" })],
      ["GET", "/api/admin/escalations/events", null],
      ["GET", "/api/admin/escalations/events?after=41&limit=200", null],
      ["GET", "/api/admin/escalations/events?before=12", null],
      ["GET", "/api/admin/ledger/verify", null],
    ]);
    for (const { url, init } of admin) {
      expect(/usr_|userId|sessionId|sess_|decidedBy|the\.access\.token/.test(url), url).toBe(false);
      expect(/usr_|userId|sessionId|decidedBy|identityConfirmedAtMs|the\.access\.token/.test(String(init.body ?? "")), url).toBe(false);
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer the.access.token");
    }
    // An ID that is not a payment's can't put anything else into the path.
    await api.adminEscalation("../../me?userId=usr_00000000000000000000000000000000");
    expect(calls.at(-1)!.url.startsWith("/api/admin/escalations/")).toBe(true);
    expect(/[?&]|\.\.\//.test(calls.at(-1)!.url), calls.at(-1)!.url).toBe(false);
    calls.length = 13;
    const headers = calls.map((c) => (c.init.headers as Record<string, string>).authorization);
    // Every call but the public settings carries the bearer token.
    expect(headers.slice(0, 12).every((h) => h === "Bearer the.access.token")).toBe(true);
    expect(headers[12]).toBeUndefined();
    expect(calls[12]!.url).toBe("/api/config");
  });

  it("a failed call comes back as a value, with the server's code and nothing invented", async () => {
    const answers: Response[] = [
      new Response(JSON.stringify({ error: "step_up_required", maxAgeSec: 900 }), { status: 403 }),
      new Response("not json", { status: 502 }),
    ];
    const api = createApi(async () => "t", (async () => answers.shift()!) as unknown as typeof fetch);
    expect(await api.enableAccount()).toEqual({ ok: false, status: 403, error: "step_up_required", maxAgeSec: 900 });
    expect(await api.me()).toEqual({ ok: false, status: 502, error: "error" });
    const down = createApi(async () => "t", (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);
    expect(await down.me()).toEqual({ ok: false, status: 0, error: "network" });
  });

  it("the dev sign-in keeps the pasted token in memory only", async () => {
    const auth = createDevAuth();
    expect(auth.signedIn()).toBe(false);
    expect(await auth.signIn("not a token")).toBe(false);
    const token = `${btoa("{}")}.${btoa(JSON.stringify({ oid: "alice" }))}.sig`;
    expect(await auth.signIn(token)).toBe(true);
    expect(await auth.token()).toBe(token);
    expect(auth.account()).toEqual({ name: "alice" });
    expect(window.sessionStorage.length).toBe(0);
    expect(window.localStorage.length).toBe(0);
    await auth.signOut();
    expect(await auth.token()).toBeNull();
  });
});
