// 013 `npm run user-token` (specs/013 research R19): the device authorization flow against a stand-in tenant. The
// flow shows the address and the code, polls at the tenant's pace, and gives back the access token and nothing else.
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DEVICE_GRANT, deviceFlow, settingsFrom } from "../scripts/user-token.js";

const ISSUER = "https://x402-test.eu.auth0.com/";
const AUDIENCE = "https://x402.example/api";
const CLIENT = "AgentCliClient0123456789abcdefgh";
const TOKEN = "header.payload.signature";

type Answer = "pending" | "slow_down" | "denied" | "expired" | "token" | "garbage" | "server_error" | "drop";

interface Stub {
  base: string;
  requests: Array<{ path: string; form: Record<string, string> }>;
  close(): Promise<void>;
}

let stubs: Stub[] = [];
afterEach(async () => {
  await Promise.all(stubs.map((s) => s.close()));
  stubs = [];
});

/** A tenant that starts a device flow and answers each poll from `answers`, in order (the last one repeats). */
async function tenant(answers: Answer[], start: Record<string, unknown> | { status: number; body: unknown } = {}): Promise<Stub> {
  const requests: Stub["requests"] = [];
  const queue = [...answers];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += String(c)));
    req.on("end", () => {
      const form = Object.fromEntries(new URLSearchParams(raw));
      requests.push({ path: req.url ?? "", form });
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      };
      if (req.url === "/oauth/device/code") {
        if ("status" in start && typeof start.status === "number") return json(start.status, (start as { body: unknown }).body);
        return json(200, {
          device_code: "device-code-1",
          user_code: "WDJB-MJHT",
          verification_uri: `${ISSUER}activate`,
          verification_uri_complete: `${ISSUER}activate?user_code=WDJB-MJHT`,
          expires_in: 900,
          interval: 5,
          ...start,
        });
      }
      if (req.url === "/oauth/token") {
        const answer = queue.length > 1 ? queue.shift()! : (queue[0] ?? "pending");
        if (answer === "drop") return void req.socket.destroy();
        if (answer === "token") return json(200, { access_token: TOKEN, token_type: "Bearer", expires_in: 86400 });
        if (answer === "pending") return json(403, { error: "authorization_pending", error_description: "User has yet to authorize device code." });
        if (answer === "slow_down") return json(429, { error: "slow_down", error_description: "You are polling faster than the specified interval." });
        if (answer === "denied") return json(403, { error: "access_denied", error_description: "planted description with user@example.test" });
        if (answer === "expired") return json(403, { error: "expired_token", error_description: "Token expired" });
        if (answer === "server_error") return json(500, { error: "server error with spaces <and markup>" });
        return void res.writeHead(200, { "content-type": "text/html" }).end("<html>not json</html>");
      }
      json(404, { error: "not_found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const stub: Stub = {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
  stubs.push(stub);
  return stub;
}

async function run(t: Stub) {
  const said: string[] = [];
  const waits: number[] = [];
  const result = await deviceFlow({
    issuer: ISSUER,
    audience: AUDIENCE,
    clientId: CLIENT,
    baseUrl: t.base,
    say: (line) => said.push(line),
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  return { result, said, waits };
}

describe("013 user-token: the device flow", () => {
  it("shows the address and the code, waits while pending, and gives the access token", async () => {
    const t = await tenant(["pending", "pending", "token"]);
    const { result, said, waits } = await run(t);
    expect(result).toEqual({ ok: true, accessToken: TOKEN });
    expect(said).toEqual([`Open ${ISSUER}activate?user_code=WDJB-MJHT`, "and confirm the code WDJB-MJHT"]);
    expect(waits).toEqual([5000, 5000, 5000]);
    // What the tenant was sent: the public client, the API, the device code. No secret, no scope for a refresh token.
    expect(t.requests[0]).toEqual({ path: "/oauth/device/code", form: { client_id: CLIENT, audience: AUDIENCE } });
    expect(t.requests.slice(1).map((r) => r.form)).toEqual(Array(3).fill({ grant_type: DEVICE_GRANT, device_code: "device-code-1", client_id: CLIENT }));
    expect(JSON.stringify(t.requests)).not.toMatch(/client_secret|offline_access/);
    // The token is never among the lines for the person.
    expect(said.join("\n")).not.toContain(TOKEN);
  });

  it("slow_down adds 5 s to every later wait", async () => {
    const t = await tenant(["slow_down", "pending", "slow_down", "token"], { interval: 2 });
    const { result, waits } = await run(t);
    expect(result.ok).toBe(true);
    expect(waits).toEqual([2000, 7000, 7000, 12000]);
  });

  it("a refusal ends the flow with the code only, never the tenant's text", async () => {
    const { result } = await run(await tenant(["pending", "denied"]));
    expect(result).toEqual({ ok: false, reason: "the sign-in was refused (access_denied)" });
    expect(JSON.stringify(result)).not.toMatch(/planted|example\.test/);
  });

  it("an expired code ends the flow, whether the tenant says so or the time runs out", async () => {
    expect((await run(await tenant(["pending", "expired"]))).result).toEqual({ ok: false, reason: "the code expired before it was confirmed (expired_token)" });
    const t = await tenant(["pending"], { expires_in: 12, interval: 5 });
    const { result, waits } = await run(t);
    expect(result).toEqual({ ok: false, reason: "the code expired before it was confirmed" });
    expect(waits).toEqual([5000, 5000, 5000]);
  });

  it("an answer it does not know ends the flow; a dropped connection is tried again", async () => {
    expect((await run(await tenant(["garbage"]))).result).toEqual({ ok: false, reason: "the sign-in did not complete (unexpected_answer)" });
    expect((await run(await tenant(["server_error"]))).result).toEqual({ ok: false, reason: "the sign-in did not complete (unexpected_answer)" });
    expect((await run(await tenant(["drop", "token"]))).result).toEqual({ ok: true, accessToken: TOKEN });
  });

  it("a tenant that refuses to start, or can't be reached, is said plainly", async () => {
    const refused = await run(await tenant([], { status: 403, body: { error: "unauthorized_client", error_description: "planted" } }));
    expect(refused.result).toEqual({ ok: false, reason: "the sign-in service refused to start (unauthorized_client)" });
    expect(refused.said).toEqual([]);
    const incomplete = await run(await tenant([], { user_code: undefined }));
    expect(incomplete.result).toEqual({ ok: false, reason: "the sign-in service refused to start (unexpected_answer)" });
    const down = await deviceFlow({ issuer: ISSUER, audience: AUDIENCE, clientId: CLIENT, baseUrl: "http://127.0.0.1:9/", say: () => undefined, sleep: async () => undefined });
    expect(down).toEqual({ ok: false, reason: "the sign-in service can't be reached" });
  });

  it("an address that is not the tenant's own is never shown", async () => {
    for (const start of [
      { verification_uri: "https://evil.example/activate", verification_uri_complete: "https://evil.example/activate?user_code=X" },
      { verification_uri_complete: "https://evil.example/activate?user_code=X" },
      { verification_uri: "http://x402-test.eu.auth0.com/activate", verification_uri_complete: undefined },
      { verification_uri: "not an address", verification_uri_complete: undefined },
    ]) {
      const t = await tenant(["token"], start);
      const { result, said } = await run(t);
      expect(result, JSON.stringify(start)).toEqual({ ok: false, reason: "the sign-in service gave an address that is not its own" });
      expect(said).toEqual([]);
      expect(t.requests.filter((r) => r.path === "/oauth/token")).toEqual([]);
    }
  });
});

describe("013 user-token: settings and the command", () => {
  const file = { AUTH_ISSUER: ISSUER, AUTH_AUDIENCE: AUDIENCE, AGENT_CLI_CLIENT_ID: CLIENT, SESSION_REF_SECRET: "never-read", CONTROL_TOKEN: "never-read" };

  it("reads its three settings, the environment before the file, and nothing else", () => {
    expect(settingsFrom({}, file)).toEqual({ issuer: ISSUER, audience: AUDIENCE, clientId: CLIENT });
    expect(settingsFrom({ AUTH_AUDIENCE: "https://other/api", AGENT_CLI_CLIENT_ID: "other-client" }, file)).toEqual({ issuer: ISSUER, audience: "https://other/api", clientId: "other-client" });
    expect(JSON.stringify(settingsFrom({}, file))).not.toContain("never-read");
  });

  it("names the missing or wrong setting, never its value", () => {
    expect(settingsFrom({}, {})).toEqual({ error: "AUTH_ISSUER is required (env/l1-hosted.env, or the environment)" });
    expect(settingsFrom({}, { ...file, AGENT_CLI_CLIENT_ID: "" })).toEqual({ error: "AGENT_CLI_CLIENT_ID is required (env/l1-hosted.env, or the environment)" });
    expect(settingsFrom({}, { ...file, AUTH_AUDIENCE: "" })).toEqual({ error: "AUTH_AUDIENCE is required (env/l1-hosted.env, or the environment)" });
    for (const issuer of ["urn:x402:dev-issuer", "http://tenant.example/", "https://tenant.example", "https://tenant.example/path/"]) {
      const r = settingsFrom({}, { ...file, AUTH_ISSUER: issuer });
      expect("error" in r && r.error, issuer).toMatch(/^AUTH_ISSUER must be the sign-in tenant's issuer/);
      expect(JSON.stringify(r)).not.toContain(issuer);
    }
    expect(settingsFrom({}, { ...file, AGENT_CLI_CLIENT_ID: "two words" })).toEqual({ error: "AGENT_CLI_CLIENT_ID must be the native client's ID" });
  });

  it("the command exits 2 with the local dev settings, printing nothing on stdout", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/user-token.ts"], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ENV_FILE: "env/l1-hosted.env.example" },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    const code = await new Promise<number | null>((r) => child.on("exit", r));
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toMatch(/^user-token: AGENT_CLI_CLIENT_ID is required/);
  }, 30_000);
});
