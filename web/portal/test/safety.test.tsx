// @vitest-environment jsdom
// T-WEB-07 (specs/013 NFR-006, FR-016, FR-018): everything a person typed is rendered as text, never as markup; the
// web app has no way to inject HTML, holds no credential of the platform, and never puts a token in a URL or in
// storage of its own.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../src/api.js";
import { clientOptions, createAuth0Auth, describeFailure, sessionCache, type SignInClient } from "../src/auth/auth0.js";
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
      if (body.includes("sessionStorage")) expect(file.endsWith("auth/auth0.ts"), file).toBe(true);
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
    const token = `${btoa("{}")}.${btoa(JSON.stringify({ sub: "dev|alice" }))}.sig`;
    expect(await auth.signIn(token)).toBe(true);
    expect(await auth.token()).toBe(token);
    expect(auth.account()).toEqual({ name: "alice" });
    expect(window.sessionStorage.length).toBe(0);
    expect(window.localStorage.length).toBe(0);
    await auth.signOut();
    expect(await auth.token()).toBeNull();
  });
});

describe("T-WEB-07: the Auth0 sign-in (013 research R19)", () => {
  afterEach(() => window.sessionStorage.clear());

  /** A stand-in for the sign-in library: who the tenant says signed in, and what each call was given. */
  function library(o: { user?: Record<string, unknown> | null; token?: string | Error; popup?: Array<Record<string, unknown> | Error> } = {}) {
    let user = o.user === undefined ? null : o.user;
    const next = [...(o.popup ?? [])];
    const client = {
      loginWithPopup: vi.fn(async (_o?: { authorizationParams?: Record<string, unknown> }) => {
        const result = next.shift() ?? { sub: "auth0|alice", name: "Alice Example", email: "alice@example.test" };
        if (result instanceof Error) throw result;
        user = result;
      }),
      getTokenSilently: vi.fn(async () => {
        if (o.token instanceof Error) throw o.token;
        return o.token ?? "the.access.token";
      }),
      getUser: vi.fn(async () => user ?? undefined),
      logout: vi.fn(async (_o?: { openUrl?: false | ((url: string) => void) }) => {
        user = null;
      }),
    };
    return client satisfies SignInClient;
  }
  const settings = { domain: "tenant.example", clientId: "portal-client", audience: "https://x402.example/api" };
  const failure = (error: string) => Object.assign(new Error("a description with https://addresses and ids"), { error, error_description: "secret detail" });

  it("is set up as a public client for the portal's API, with rotating refresh tokens and no hidden frame", () => {
    const cache = sessionCache();
    const options = clientOptions(settings, "https://portal.example", cache);
    expect(options).toEqual({
      domain: "tenant.example",
      clientId: "portal-client",
      authorizationParams: { audience: "https://x402.example/api", redirect_uri: "https://portal.example" },
      cache,
      useRefreshTokens: true,
      useRefreshTokensFallback: false,
    });
    // No secret, and the library's own storage choices are not used: only the cache above.
    expect(JSON.stringify(options)).not.toMatch(/secret|localstorage/i);
  });

  it("the cache keeps the library's entries in session storage, and only lists its own keys", async () => {
    const cache = sessionCache();
    window.sessionStorage.setItem("something-else", "1");
    await cache.set("@@auth0spajs@@::portal-client::aud::scope", { body: { access_token: "t" }, expiresAt: 1 });
    expect(await cache.get("@@auth0spajs@@::portal-client::aud::scope")).toEqual({ body: { access_token: "t" }, expiresAt: 1 });
    expect(await cache.allKeys!()).toEqual(["@@auth0spajs@@::portal-client::aud::scope"]);
    expect(await cache.get("missing")).toBeUndefined();
    window.sessionStorage.setItem("@@auth0spajs@@broken", "{not json");
    expect(await cache.get("@@auth0spajs@@broken")).toBeUndefined();
    await cache.remove("@@auth0spajs@@::portal-client::aud::scope");
    expect(window.sessionStorage.getItem("@@auth0spajs@@::portal-client::aud::scope")).toBeNull();
    expect(window.localStorage.length).toBe(0);
  });

  it("signs in with a pop-up, then gives the account and the token", async () => {
    const client = library();
    const auth = await createAuth0Auth(settings, { client });
    expect(auth.mode).toBe("auth0");
    expect(auth.signedIn()).toBe(false);
    expect(await auth.token()).toBeNull();
    expect(client.getTokenSilently).not.toHaveBeenCalled();
    expect(await auth.signIn()).toBe(true);
    expect(client.loginWithPopup).toHaveBeenCalledWith(undefined);
    expect(auth.signedIn()).toBe(true);
    expect(auth.account()).toEqual({ name: "Alice Example", email: "alice@example.test" });
    expect(await auth.token()).toBe("the.access.token");
    expect(auth.lastError()).toBeNull();
  });

  it("a reload keeps the person signed in, from the library's cache", async () => {
    const auth = await createAuth0Auth(settings, { client: library({ user: { sub: "auth0|alice", name: "alice@example.test", email: "alice@example.test" } }) });
    expect(auth.signedIn()).toBe(true);
    // The tenant gave the email as the name: that is not offered as a display name.
    expect(auth.account()).toEqual({ email: "alice@example.test" });
  });

  it("a failed sign-in keeps only the error code", async () => {
    const client = library({ popup: [failure("popup_open"), failure("access_denied"), new Error("no code"), failure("has spaces and <markup>")] });
    const auth = await createAuth0Auth(settings, { client });
    for (const code of ["popup_open", "access_denied", "unknown_error", "unknown_error"]) {
      expect(await auth.signIn()).toBe(false);
      expect(auth.lastError()).toBe(code);
      expect(auth.signedIn()).toBe(false);
    }
    expect(describeFailure(failure("cancelled"))).toBe("cancelled");
    expect(describeFailure(null)).toBe("unknown_error");
  });

  it("an ended session gives no token, and the person is asked to sign in again", async () => {
    const auth = await createAuth0Auth(settings, { client: library({ user: { sub: "auth0|alice" }, token: failure("invalid_grant") }) });
    expect(auth.signedIn()).toBe(true);
    expect(await auth.token()).toBeNull();
  });

  it("confirming identity forces a new sign-in, now", async () => {
    const client = library({ user: { sub: "auth0|alice", email: "alice@example.test" } });
    const auth = await createAuth0Auth(settings, { client });
    expect(await auth.confirmIdentity()).toBe(true);
    expect(client.loginWithPopup).toHaveBeenCalledWith({ authorizationParams: { prompt: "login", max_age: 0 } });
    expect(auth.signedIn()).toBe(true);
  });

  it("another person in the confirmation window does not finish this person's change: both are signed out", async () => {
    const client = library({ user: { sub: "auth0|alice" }, popup: [{ sub: "auth0|mallory", email: "mallory@example.test" }] });
    const auth = await createAuth0Auth(settings, { client });
    expect(await auth.confirmIdentity()).toBe(false);
    expect(auth.lastError()).toBe("account_changed");
    expect(auth.signedIn()).toBe(false);
    expect(await auth.token()).toBeNull();
    expect(client.logout).toHaveBeenCalledWith({ openUrl: false });
  });

  it("a closed confirmation window leaves the person signed in, unconfirmed", async () => {
    const client = library({ user: { sub: "auth0|alice" }, popup: [failure("cancelled")] });
    const auth = await createAuth0Auth(settings, { client });
    expect(await auth.confirmIdentity()).toBe(false);
    expect(auth.lastError()).toBe("cancelled");
    expect(auth.signedIn()).toBe(true);
  });

  it("signing out clears the library's cache without leaving the portal", async () => {
    const client = library({ user: { sub: "auth0|alice" } });
    const auth = await createAuth0Auth(settings, { client });
    await auth.signOut();
    expect(client.logout).toHaveBeenCalledWith({ openUrl: false });
    expect(auth.signedIn()).toBe(false);
    expect(await auth.token()).toBeNull();
  });
});
