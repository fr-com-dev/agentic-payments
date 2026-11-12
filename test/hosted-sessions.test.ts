// 011 hosted agent service: session references (SPEC.md L1-6, §11 SEC-15; specs/011 contracts/access-and-sessions.md).
// T-AGT-04: the service assigns sessions; a reference works only for the requester it was issued to.
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { issueSessionRef, verifySessionRef } from "../src/layer1-intent/hosted/session-ref.js";
import { fakePorts, mockModel, startHostedApp, text, toolCall, type HostedTestApp } from "./helpers/hosted.js";

let apps: HostedTestApp[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

/** An app whose model checks the budget once per run, so each run's sessionId reaches the fake gate. */
async function start(extra: Parameters<typeof startHostedApp>[0] = {}) {
  const ports = fakePorts();
  const model = mockModel(async (opts) => {
    // One budget check, then answer: the second call of each run sees the tool result in the prompt.
    const turns = opts.prompt.filter((m) => m.role === "tool").length;
    return turns === 0 ? toolCall("check_budget", {}) : text("done");
  });
  const a = await startHostedApp({ model, gate: ports.gate, settlement: ports.settlement, ...extra });
  apps.push(a);
  const sessionsSeen = () => ports.gateCalls.filter((c) => c.op === "budget").map((c) => c.sessionId);
  return { a, sessionsSeen };
}

describe("T-AGT-04 session references", () => {
  it("a run issues a reference; the same requester continues that session with it", async () => {
    const { a, sessionsSeen } = await start();
    const first = await a.run("alice", { goal: "one" });
    expect(first.status).toBe(200);
    const ref = String(first.body.sessionRef);
    const second = await a.run("alice", { goal: "two", sessionRef: ref });
    expect(second.status).toBe(200);
    expect(second.body.sessionRef).toBe(ref);
    const [s1, s2] = sessionsSeen();
    expect(s1).toMatch(/^sess_[0-9a-f]{16}$/);
    expect(s2).toBe(s1);
    expect(ref.split(".")[1]).toBe(s1);
  });

  it("another requester presenting the reference gets 404 without learning whether it exists", async () => {
    const { a, sessionsSeen } = await start();
    const ref = String((await a.run("alice", { goal: "one" })).body.sessionRef);
    const bob = await a.run("bob", { goal: "steal", sessionRef: ref });
    expect(bob).toMatchObject({ status: 404, body: { error: "unknown session" } });
    const never = await a.run("bob", { goal: "guess", sessionRef: `sr1.sess_ffffffffffffffff.${"A".repeat(43)}` });
    expect(never).toMatchObject({ status: 404, body: { error: "unknown session" } });
    expect(sessionsSeen()).toHaveLength(1);
  });

  it("a raw session ID or a malformed reference is refused with 400; a tampered MAC with 404", async () => {
    const { a } = await start();
    const ref = String((await a.run("alice", { goal: "one" })).body.sessionRef);
    expect((await a.run("alice", { goal: "x", sessionRef: "sess_0123456789abcdef" })).status).toBe(400);
    expect((await a.run("alice", { goal: "x", sessionRef: "sr1.x.y" })).status).toBe(400);
    const at = ref.length - 20; // a character inside the MAC that carries no padding bits
    const tampered = ref.slice(0, at) + (ref[at] === "A" ? "B" : "A") + ref.slice(at + 1);
    expect((await a.run("alice", { goal: "x", sessionRef: tampered })).status).toBe(404);
    // A non-canonical spelling of the right MAC (only the last character's padding bits differ) is refused too.
    const last = ref.at(-1)!;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const sibling = alphabet[alphabet.indexOf(last) ^ 1]!;
    expect((await a.run("alice", { goal: "x", sessionRef: ref.slice(0, -1) + sibling })).status).toBe(404);
  });

  it("a reference is bound to the kind of requester, who vouches for it and its subject (013 research R19)", async () => {
    const secret = Buffer.alloc(32, 9);
    const sid = "sess_0123456789abcdef";
    const person = { kind: "user", authority: "https://tenant.example/", subject: "auth0|abc" } as const;
    const ref = issueSessionRef(secret, person, sid);
    expect(verifySessionRef(secret, person, ref)).toEqual({ ok: true, sessionId: sid });
    const others = [
      { ...person, subject: "auth0|abd" },
      { ...person, authority: "https://other.example/" },
      // The same text as a system identity's tenant and object ID is another requester.
      { ...person, kind: "service" as const },
      // No way to move a character from one field to the next: `sub` may hold the old separator.
      { ...person, authority: "https://tenant.example/\nauth0", subject: "abc" },
      { ...person, authority: "https://tenant.example/|auth0", subject: "abc" },
    ];
    for (const other of others) expect(verifySessionRef(secret, other, ref), JSON.stringify(other)).toEqual({ ok: false, status: 404 });
    // The earlier format (`sr1|<tid>|<oid>|<session>`) no longer verifies: people sign in elsewhere now.
    const old = createHmac("sha256", secret).update(`sr1|dev|alice|${sid}`).digest("base64url");
    expect(verifySessionRef(secret, { kind: "user", authority: "dev", subject: "alice" }, `sr1.${sid}.${old}`)).toEqual({ ok: false, status: 404 });
  });

  it("a system identity can't continue a person's session, nor a person a system identity's, under the same name", async () => {
    const { a, sessionsSeen } = await start();
    // The person's `sub` is dev|alice; a system identity whose object ID is that exact text is someone else.
    const ref = String((await a.run("alice", { goal: "one" })).body.sessionRef);
    expect((await a.run("dev|alice", { goal: "steal", sessionRef: ref }, { service: true })).status).toBe(404);
    const svcRef = String((await a.run("alice", { goal: "one" }, { service: true })).body.sessionRef);
    expect((await a.run("alice", { goal: "steal", sessionRef: svcRef })).status).toBe(404);
    expect((await a.run("alice", { goal: "two", sessionRef: svcRef }, { service: true })).status).toBe(200);
    expect(sessionsSeen()).toHaveLength(3);
  });

  it("must-fail: with the test-only skipSessionMac hook, requester B's run uses requester A's session", async () => {
    const { a, sessionsSeen } = await start({ skipSessionMac: true });
    const ref = String((await a.run("alice", { goal: "one" })).body.sessionRef);
    expect((await a.run("bob", { goal: "steal", sessionRef: ref })).status).toBe(200);
    const [s1, s2] = sessionsSeen();
    expect(s2).toBe(s1);
  });
});
