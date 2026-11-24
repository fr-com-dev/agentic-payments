// 019 — T-AGT-16 a 401 a client can read (SPEC L1-6; specs/019 contracts/hosted-agent-api.md "401: the code beside the
// challenge", FR-020..022). Every 401 keeps the DAST remediation's bearer challenge and gains `error_code`:
// `missing_token`, `token_expired` (the validity period is the token's only fault) or `invalid_token`. The invalid
// ones are byte-identical whichever check failed. `revealCheck` is the test-only must-fail switch.
import { afterEach, describe, expect, it } from "vitest";
import { createTestIssuer } from "./helpers/caller-tokens.js";
import { fakePorts, mockModel, modelCalls, startHostedApp, type HostedTestApp } from "./helpers/hosted.js";
import { devSubject } from "../scripts/dev-issuer-lib.js";

let apps: HostedTestApp[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

const nowSec = () => Math.floor(Date.now() / 1000);
const CHALLENGE = 'Bearer realm="x402-agent"';
const INVALID_CHALLENGE = 'Bearer realm="x402-agent", error="invalid_token"';

async function start(extra: Parameters<typeof startHostedApp>[0] = {}) {
  const ports = fakePorts();
  const model = mockModel();
  // Object.assign, not a spread: the model's type is too large a union to spread (TS2590, @mastra/core 1.83).
  const a = await startHostedApp(Object.assign({ model, gate: ports.gate, settlement: ports.settlement }, extra));
  apps.push(a);
  return { a, ports, model };
}

async function send(a: HostedTestApp, token: string | null, stream = false) {
  const res = await fetch(`${a.base}/v1/runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token !== null && { authorization: `Bearer ${token}` }),
      ...(stream && { accept: "text/event-stream" }),
    },
    body: JSON.stringify({ goal: "hi" }),
  });
  return { status: res.status, challenge: res.headers.get("www-authenticate"), type: res.headers.get("content-type")?.split(";")[0], raw: await res.text() };
}

/** Every token the agent must refuse with 401 but one: the expired token whose other checks pass. */
async function invalidTokens(a: HostedTestApp): Promise<Array<[string, string]>> {
  // A key the agent doesn't know, under the dev issuer's own name and audience: only the signature is wrong.
  const stranger = await createTestIssuer();
  return [
    ["a bad signature", await stranger.person(devSubject("alice"))],
    ["another issuer", await a.token("alice", { issuer: "https://other.eu.auth0.com/" })],
    ["another audience", await a.token("alice", { audience: "api://someone-else" })],
    ["an empty subject", await a.token("alice", { sub: "" })],
    ["a machine token whose subject is another client's", await a.token("svc", { service: true, sub: "other-client@clients" })],
    ["expired and for another audience", await a.token("alice", { exp: nowSec() - 120, audience: "api://someone-else" })],
    ["not yet valid", await a.token("alice", { nbf: nowSec() + 300 })],
    ["a malformed token", "not-a-token"],
  ];
}

describe("T-AGT-16 the agent's 401 says missing, expired or invalid, and nothing more (019 FR-020..022)", () => {
  it("T-AGT-16 no token: missing_token, with the challenge that names no error", async () => {
    const { a } = await start();
    const r = await send(a, null);
    expect([r.status, r.challenge, JSON.parse(r.raw)]).toEqual([401, CHALLENGE, { error: "unauthorized", error_code: "missing_token" }]);
  });

  it("T-AGT-16 an expired token whose other checks pass: token_expired, so the client renews", async () => {
    const { a } = await start();
    for (const service of [false, true]) {
      const r = await send(a, await a.token(service ? "x402-checks-dev" : "alice", { exp: nowSec() - 120, ...(service && { service: true }) }));
      expect([r.status, r.challenge, JSON.parse(r.raw)], String(service)).toEqual([401, INVALID_CHALLENGE, { error: "unauthorized", error_code: "token_expired" }]);
    }
  });

  it("T-AGT-16 every other failure: invalid_token, byte-identical whichever check failed, with the error challenge; none reaches the model or L2", async () => {
    const { a, ports, model } = await start();
    const answers = new Set<string>();
    for (const [name, token] of await invalidTokens(a)) {
      const r = await send(a, token);
      expect([r.status, r.challenge, JSON.parse(r.raw)], name).toEqual([401, INVALID_CHALLENGE, { error: "unauthorized", error_code: "invalid_token" }]);
      answers.add(r.raw);
    }
    expect([...answers]).toEqual(['{"error":"unauthorized","error_code":"invalid_token"}']);
    expect(modelCalls(model)).toHaveLength(0);
    expect(ports.gateCalls).toEqual([]);
  });

  it("T-AGT-16 a run that asked for a stream gets the same status, challenge and JSON body: every refusal comes before the stream", async () => {
    const { a } = await start();
    const cases: Array<[string, string | null]> = [["no token", null], ["expired", await a.token("alice", { exp: nowSec() - 120 })], ...(await invalidTokens(a))];
    for (const [name, token] of cases) {
      const json = await send(a, token);
      const stream = await send(a, token, true);
      expect([stream.status, stream.challenge, stream.type, stream.raw], name).toEqual([json.status, json.challenge, "application/json", json.raw]);
    }
  });

  it("T-AGT-16 the 403 is unchanged: { error: forbidden }, no challenge, no code", async () => {
    const { a } = await start();
    const r = await send(a, await a.token("alice", { permissions: [] }));
    expect([r.status, r.challenge, JSON.parse(r.raw)]).toEqual([403, null, { error: "forbidden" }]);
  });

  it("T-AGT-16 must fail when a 401 describes the failure (revealCheck): two invalid tokens get different answers", async () => {
    const { a } = await start({ revealCheck: true });
    const answers = new Set<string>();
    for (const [, token] of await invalidTokens(a)) answers.add((await send(a, token)).raw);
    expect(answers.size).toBeGreaterThan(1);
  });
});
