// 015 — backchannel approval by the person the run is for (SPEC L2-7 v1.16; specs/015 contracts/control-api.md
// "Tests"). In-process L2 with user accounts, two onboarded people and the stand-in approval service
// (test/helpers/backchannel-l2.ts): T-CIBA-15 (one request, to the owner, and their answer decides), T-CIBA-16
// (another person's genuine answer approves nothing), T-CIBA-17 (a subject that is not the user's asks nobody),
// T-CIBA-18 (a run with no person behind it asks nobody) and T-CIBA-20 (the subject is written nowhere).
// Every must-fail switch is a test-only dep of the backchannel, never an environment variable.
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VerificationCheck } from "../src/layer2-control/approval-evidence.js";
import type { LedgerEntry } from "../src/layer2-control/ledger.js";
import { userIdFor } from "../src/shared/user-id.js";
import { PLANTED_ERROR_TEXT } from "./helpers/ciba-stub.js";
import { ALICE_SUB, BOB_SUB, PAY_TO, SELLER, startBackchannelL2, type BackchannelL2, types } from "./helpers/backchannel-l2.js";

const opened: BackchannelL2[] = [];
async function start(o: Parameters<typeof startBackchannelL2>[0] = {}) {
  const l2 = await startBackchannelL2(o);
  opened.push(l2);
  return l2;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const l2 of opened.splice(0)) await l2.close({ closeStub: true }).catch(() => {});
});

const PREMIUM = "/api/premium-report";
const ofType = (l2: BackchannelL2, type: LedgerEntry["type"]) => l2.ledger.entries().filter((e) => e.type === type);
const requested = (n = 1) => (entries: readonly LedgerEntry[]) => entries.filter((e) => e.type === "APPROVAL_REQUESTED").length >= n;
const hintOf = (form: Record<string, string>) => JSON.parse(form.login_hint!) as Record<string, unknown>;
const rulesOf = (body: unknown) => ((body as { violations?: { rule: string }[] }).violations ?? []).map((v) => v.rule);

describe("T-CIBA-15 one request, addressed to the owner, and their answer decides (US1, FR-006, FR-020)", () => {
  it("T-CIBA-15 an escalation of alice's sends exactly one request, to alice; bob's subject is in no request", async () => {
    const l2 = await start();
    l2.stub.setAnswers("pending");
    const { alice, bob } = l2.people;
    const res = await l2.authorize(l2.intentFor(PREMIUM, "50000"));
    expect(res.body.status).toBe("ESCALATE");
    const forms = l2.stub.startForms();
    expect(forms).toHaveLength(1);
    expect(hintOf(forms[0]!)).toEqual({ format: "iss_sub", iss: l2.stub.issuer, sub: ALICE_SUB });
    expect(JSON.stringify(l2.stub.requests)).not.toContain(BOB_SUB);
    const esc = ofType(l2, "ESCALATED")[0]!;
    expect(esc.data).toMatchObject({ approvalRequest: "requested", userId: alice.userId });
    const req = ofType(l2, "APPROVAL_REQUESTED");
    expect(req).toHaveLength(1);
    expect(req[0]!.data.approver).toBe(alice.userId);
    expect(alice.userId).not.toBe(bob.userId);
  });

  it("T-CIBA-15 alice approves within the wait: AUTHORIZED, and the approval names her by usr_… with evidence that holds no subject", async () => {
    const l2 = await start();
    l2.stub.setAnswers("pending", { approve: {} });
    const { alice } = l2.people;
    const intent = l2.intentFor(PREMIUM, "50000");
    const res = await l2.authorize(intent);
    expect(res.body.status).toBe("AUTHORIZED");
    expect((res.body as { payer: string }).payer.toLowerCase()).toBe(alice.address.toLowerCase());
    const approvals = ofType(l2, "HUMAN_APPROVAL");
    expect(approvals).toHaveLength(1);
    const approval = approvals[0]!;
    expect(approval.data).toMatchObject({ channel: "backchannel", approver: alice.userId, payTo: PAY_TO, amount: "50000" });
    const evidence = approval.data.evidence as Record<string, unknown>;
    expect(Object.keys(evidence).sort()).toEqual(["answerId", "detailsSource", "issuedAt", "issuer", "userId"]);
    expect(evidence).toMatchObject({ issuer: l2.stub.issuer, userId: alice.userId });
    const esc = ofType(l2, "ESCALATED")[0]!;
    const trail = l2.ledger.entries().filter((e) => e.intentId === intent.intentId || e.data.escalationId === esc.authorizationId);
    expect(types(trail)).toEqual(["INTENT", "ESCALATED", "APPROVAL_REQUESTED", "HUMAN_APPROVAL", "INTENT", "AUTHORIZED"]);
    expect(trail[5]!.data).toMatchObject({ approvalRef: approval.data.approvalId, userId: alice.userId });
    expect(l2.ledger.verifyChain().ok).toBe(true);
  });

  it("T-CIBA-15 alice refuses: one rejection naming her by usr_…; the session's next request is DENIED human_rejected; nothing is signed", async () => {
    const l2 = await start();
    l2.stub.setAnswers("pending", "deny");
    const { alice } = l2.people;
    const res = await l2.authorize(l2.intentFor(PREMIUM, "50000"));
    expect([res.body.status, rulesOf(res.body)]).toEqual(["DENIED", ["human_rejected"]]);
    const rejections = ofType(l2, "HUMAN_REJECTION");
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!.data).toMatchObject({ channel: "backchannel", approver: alice.userId, resourceKey: `${SELLER}${PREMIUM}`, amount: "50000" });
    const again = await l2.authorize(l2.intentFor(PREMIUM, "50000"));
    expect([again.body.status, rulesOf(again.body)]).toEqual(["DENIED", ["human_rejected"]]);
    expect(l2.stub.startForms()).toHaveLength(1);
    expect(ofType(l2, "AUTHORIZED")).toHaveLength(0);
  });

  it("T-CIBA-15 alice and bob each have a pending escalation and each answers: each answer decides only its own (US1 scenario 5)", async () => {
    const l2 = await start();
    const { alice, bob } = l2.people;
    l2.stub.setAnswersFor(0, "pending", "pending", "pending", { approve: {} }); // alice's request: she approves
    l2.stub.setAnswersFor(1, "pending", "pending", "pending", "deny"); // bob's request: he refuses
    const a = l2.authorize(l2.intentFor(PREMIUM, "50000", { sessionId: "sess_alice" }));
    await l2.until(requested(1));
    const b = l2.authorize(l2.intentFor(PREMIUM, "50000", { sessionId: "sess_bob", as: "bob" }));
    await l2.until(requested(2));
    // Both are pending at once, each with its own request, addressed to its own owner.
    expect((await l2.pending()).pending.map((p) => [p.userId, p.approvalRequest])).toEqual([
      [alice.userId, "requested"],
      [bob.userId, "requested"],
    ]);
    expect(l2.stub.startForms().map((f) => hintOf(f).sub)).toEqual([ALICE_SUB, BOB_SUB]);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.body.status).toBe("AUTHORIZED");
    expect((ra.body as { payer: string }).payer.toLowerCase()).toBe(alice.address.toLowerCase());
    expect([rb.body.status, rulesOf(rb.body)]).toEqual(["DENIED", ["human_rejected"]]);
    const escalations = ofType(l2, "ESCALATED");
    const [approval] = ofType(l2, "HUMAN_APPROVAL");
    const [rejection] = ofType(l2, "HUMAN_REJECTION");
    expect(ofType(l2, "HUMAN_APPROVAL")).toHaveLength(1);
    expect(ofType(l2, "HUMAN_REJECTION")).toHaveLength(1);
    expect(approval!.data).toMatchObject({ escalationId: escalations[0]!.authorizationId, approver: alice.userId });
    expect(rejection!.data).toMatchObject({ escalationId: escalations[1]!.authorizationId, approver: bob.userId });
    expect(ofType(l2, "AUTHORIZED").map((e) => e.data.userId)).toEqual([alice.userId]);
  });

  it("T-CIBA-15 INV-12: a DENY rule at the re-evaluation wins over alice's approval, and the approval stays open", async () => {
    const l2 = await start({ backchannel: { pollDelayMs: (s) => s * 50 } });
    l2.stub.setAnswers("pending", "pending", "pending", "pending", { approve: {} });
    const call = l2.authorize(l2.intentFor(PREMIUM, "50000"));
    await l2.until(requested());
    // Meanwhile her run spends 60000 of its 100000 budget: 50000 more no longer fits.
    for (const path of ["/api/a", "/api/b", "/api/c"]) expect((await l2.authorize(l2.intentFor(path, "20000"))).body.status).toBe("AUTHORIZED");
    const res = await call;
    expect(res.body.status).toBe("DENIED");
    expect(rulesOf(res.body)).toContain("session_budget_exceeded");
    expect(ofType(l2, "HUMAN_APPROVAL").map((e) => e.data.approver)).toEqual([l2.people.alice.userId]);
    expect(ofType(l2, "AUTHORIZED").map((e) => e.data.amount)).toEqual(["20000", "20000", "20000"]);
  });

  it("T-CIBA-15 alice's account is disabled while her request is open, then she approves: the answer is recorded, the re-evaluation is DENIED, nothing is signed", async () => {
    const l2 = await start({ backchannel: { pollDelayMs: (s) => s * 50 } });
    l2.stub.setAnswers("pending", "pending", "pending", "pending", { approve: {} });
    const { alice } = l2.people;
    const call = l2.authorize(l2.intentFor(PREMIUM, "50000"));
    await l2.until(requested());
    expect((await l2.portal("POST", `/v1/users/${alice.userId}/disable`)).status).toBe(200);
    const res = await call;
    expect([res.body.status, rulesOf(res.body)]).toEqual(["DENIED", ["user_disabled"]]);
    expect(ofType(l2, "HUMAN_APPROVAL").map((e) => [e.data.channel, e.data.approver])).toEqual([["backchannel", alice.userId]]);
    expect(ofType(l2, "AUTHORIZED")).toHaveLength(0);
  });

  it("T-CIBA-15 alice is an administrator too: the portal refuses her own payment (own_payment, SEC-29), and her phone answer approves it (FR-014)", async () => {
    const l2 = await start({ admin: true, backchannel: { pollDelayMs: (s) => s * 50 } });
    l2.stub.setAnswers("pending", "pending", "pending", "pending", { approve: {} });
    const { alice } = l2.people;
    const call = l2.authorize(l2.intentFor(PREMIUM, "50000"));
    await l2.until(requested());
    const id = ofType(l2, "ESCALATED")[0]!.authorizationId!;
    const portal = await l2.admin("POST", `/v1/admin/escalations/${id}/approve`, { decidedBy: alice.userId, identityConfirmedAtMs: l2.clock.now() });
    expect(portal).toMatchObject({ status: 403, body: { error: "own_payment" } });
    expect(ofType(l2, "HUMAN_APPROVAL")).toHaveLength(0);
    const res = await call;
    expect(res.body.status).toBe("AUTHORIZED");
    expect(ofType(l2, "HUMAN_APPROVAL").map((e) => [e.data.channel, e.data.approver])).toEqual([["backchannel", alice.userId]]);
  });
});

// ---------------------------------------------------------------------------
// US2: only the owner's verified answer counts
// ---------------------------------------------------------------------------

describe("T-CIBA-16 another person's genuine answer approves nothing (US2, FR-013, SEC-30)", () => {
  /** Alice's escalation; the approval service returns bob's signed answer for it, same request, same payment details. */
  async function bobAnswersForAlice(skipChecks?: VerificationCheck[]) {
    const l2 = await start(skipChecks ? { backchannel: { skipChecks: new Set(skipChecks) } } : {});
    l2.stub.setAnswers("pending", { approve: { as: BOB_SUB } });
    const res = await l2.authorize(l2.intentFor(PREMIUM, "50000"));
    return { l2, res };
  }

  it("T-CIBA-16 bob's signed answer for alice's escalation: one APPROVAL_VERIFICATION_FAILED{owner}, no approval, nothing signed, still pending; an operator approval pays", async () => {
    const { l2, res } = await bobAnswersForAlice();
    expect(res.body.status).toBe("ESCALATE");
    expect(l2.stub.tokensIssued.length).toBeGreaterThan(0); // bob's answer was genuine: signed by the service, for this request
    expect(ofType(l2, "HUMAN_APPROVAL")).toHaveLength(0);
    expect(ofType(l2, "APPROVAL_VERIFICATION_FAILED").map((e) => e.data.check)).toEqual(["owner"]);
    expect(ofType(l2, "AUTHORIZED")).toHaveLength(0);
    const id = res.body.authorizationId;
    expect((await l2.pending()).pending.map((p) => [p.authorizationId, p.approvalRequest])).toEqual([[id, "verification_failed"]]);
    // The failure names nobody: neither bob nor his subject is in the ledger for this escalation.
    const trail = JSON.stringify(l2.trail({ escalationId: id }));
    expect(trail).not.toContain(BOB_SUB);
    expect(trail).not.toContain(l2.people.bob.userId);
    expect((await l2.approve(id)).status).toBe(200);
    const paid = await l2.authorize(l2.intentFor(PREMIUM, "50000"));
    expect(paid.body.status).toBe("AUTHORIZED");
    expect((paid.body as { payer: string }).payer.toLowerCase()).toBe(l2.people.alice.address.toLowerCase());
  });

  it("T-CIBA-16 must fail without the owner check: bob's answer approves alice's payment, and it is paid from her account", async () => {
    const { l2, res } = await bobAnswersForAlice(["owner"]);
    expect(res.body.status).toBe("AUTHORIZED");
    expect((res.body as { payer: string }).payer.toLowerCase()).toBe(l2.people.alice.address.toLowerCase());
    expect(ofType(l2, "APPROVAL_VERIFICATION_FAILED")).toHaveLength(0);
    expect(ofType(l2, "HUMAN_APPROVAL")).toHaveLength(1);
  });
});

describe("T-CIBA-17 a subject that is not the user's asks nobody (US2, FR-009, FR-011, SEC-30)", () => {
  /** An intent that names `userId` and carries `subject` (or none), as a caller holding CONTROL_TOKEN could send it. */
  const intentAs = (l2: BackchannelL2, userId: string, subject: string | undefined, sessionId: string) => ({
    ...l2.intentFor(PREMIUM, "50000", { as: "platform", sessionId }),
    userId,
    ...(subject !== undefined && { approvalSubject: subject }),
  });
  /** No request, the mark on the entry, an answer at once, and the operator path pays. */
  async function asksNobody(l2: BackchannelL2, intent: ReturnType<typeof intentAs>, mark: string, payer: string) {
    const starts = l2.stub.startForms().length;
    const t0 = Date.now();
    const res = await l2.authorize(intent);
    expect(Date.now() - t0).toBeLessThan(500); // no wait: the helper's wait is 1500 ms
    expect([res.body.status, rulesOf(res.body)]).toEqual(["ESCALATE", ["human_approval_required"]]);
    const esc = l2.ledger.entries().find((e) => e.type === "ESCALATED" && e.authorizationId === res.body.authorizationId)!;
    expect(esc.data).toMatchObject({ approvalRequest: mark, userId: intent.userId });
    await new Promise((r) => setTimeout(r, 60));
    expect(l2.stub.startForms()).toHaveLength(starts);
    expect(l2.trail({ escalationId: res.body.authorizationId }).map((e) => e.type)).toEqual(["ESCALATED"]);
    expect((await l2.approve(res.body.authorizationId)).status).toBe(200);
    const paid = await l2.authorize({ ...intent, intentId: `${intent.intentId}_retry` });
    expect(paid.body.status).toBe("AUTHORIZED");
    expect((paid.body as { payer: string }).payer.toLowerCase()).toBe(payer.toLowerCase());
  }

  it("T-CIBA-17 alice's userId with bob's subject: identity_mismatch, no request, ESCALATE at once; an operator approval pays", async () => {
    const l2 = await start();
    const { alice } = l2.people;
    await asksNobody(l2, intentAs(l2, alice.userId, BOB_SUB, "sess_mismatch"), "identity_mismatch", alice.address);
    expect(l2.stub.requests).toHaveLength(0);
  });

  it("T-CIBA-17 a subject that is the user's only under another issuer: identity_mismatch (FR-011, same tenant or nobody is asked)", async () => {
    const l2 = await start();
    // Dana signed in with the local dev issuer. Her subject there is spelled like alice's at the approval service.
    const dana = userIdFor("urn:x402:dev-issuer", ALICE_SUB);
    expect(dana).not.toBe(l2.people.alice.userId);
    const address = await l2.onboardUser(dana);
    await asksNobody(l2, intentAs(l2, dana, ALICE_SUB, "sess_other_issuer"), "identity_mismatch", address);
    expect(l2.stub.requests).toHaveLength(0);
  });

  it("T-CIBA-17 alice's userId and no subject: no_identity, no request", async () => {
    const l2 = await start();
    const { alice } = l2.people;
    await asksNobody(l2, intentAs(l2, alice.userId, undefined, "sess_no_identity"), "no_identity", alice.address);
    expect(l2.stub.requests).toHaveLength(0);
  });

  it("T-CIBA-17 the payment itself is decided as without the field: the same decisions and violations, whatever the subject", async () => {
    const l2 = await start({ backchannel: { waitMs: 50 } });
    l2.stub.setAnswers("pending");
    const { alice } = l2.people;
    const decide = async (path: string, amount: string, subject: string | undefined, sessionId: string) => {
      const res = await l2.authorize({ ...intentAs(l2, alice.userId, subject, sessionId), resourceUrl: `${SELLER}${path}`, ...paymentFor(l2, path, amount) });
      return [res.body.status, rulesOf(res.body)];
    };
    // Auto-approved, escalated, and denied above the hard cap: with alice's own subject, with bob's, and with none.
    for (const [path, amount] of [["/api/weather", "1000"], ["/api/premium-report", "50000"], ["/api/too-much", "200000"]] as const) {
      const own = await decide(path, amount, ALICE_SUB, `sess_own_${amount}`);
      expect(await decide(path, amount, BOB_SUB, `sess_bobs_${amount}`)).toEqual(own);
      expect(await decide(path, amount, undefined, `sess_none_${amount}`)).toEqual(own);
    }
    expect(ofType(l2, "ESCALATED").map((e) => e.data.approvalRequest)).toEqual(["requested", "identity_mismatch", "no_identity"]);
  });

  it("T-CIBA-17 must fail without the identity check: the request is sent with the mismatched subject in its login_hint", async () => {
    const l2 = await start({ backchannel: { skipIdentityCheck: true, waitMs: 200 } });
    l2.stub.setAnswers("pending");
    const res = await l2.authorize(intentAs(l2, l2.people.alice.userId, BOB_SUB, "sess_mismatch"));
    expect(res.body.status).toBe("ESCALATE");
    expect(ofType(l2, "ESCALATED")[0]!.data.approvalRequest).toBe("requested");
    // Alice's payment, on bob's phone.
    expect(l2.stub.startForms().map((f) => hintOf(f).sub)).toEqual([BOB_SUB]);
  });
});

/** The challenge for `path` at `amount`, from the helper's own intent builder. */
function paymentFor(l2: BackchannelL2, path: string, amount: string) {
  return { paymentRequired: l2.intentFor(path, amount, { as: "platform" }).paymentRequired };
}

describe("T-CIBA-20 the subject is written nowhere (US2, FR-020, NFR-004, SC-009)", () => {
  // Some sign-in methods build the subject from an address, so the planted one is email-shaped.
  const ADDRESS = "planted.person-7f3a91@example.test";
  const PLANTED = `email|${ADDRESS}`;

  it("T-CIBA-20 after an approval, a refusal, a mismatch and a failed start, neither the planted subject nor its address is in the ledger, a log line, a response or an event", async () => {
    const consoleLines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void consoleLines.push(a.map(String).join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void consoleLines.push(a.map(String).join(" ")));
    const l2 = await start({ admin: true, backchannel: { log: undefined } });
    const pat = userIdFor(l2.stub.issuer, PLANTED);
    await l2.onboardUser(pat);
    const bodies: unknown[] = [];
    const keep = async <T extends { body: unknown }>(p: Promise<T>) => {
      const r = await p;
      bodies.push(r.body);
      return r;
    };
    const patsIntent = (path: string, sessionId: string) => ({ ...l2.intentFor(path, "50000", { as: "platform", sessionId }), userId: pat, approvalSubject: PLANTED });

    // An approval and a refusal, from the planted person's own phone.
    l2.stub.setAnswersFor(0, "pending", { approve: {} });
    l2.stub.setAnswersFor(1, "deny");
    const approved = await keep(l2.authorize(patsIntent("/api/p1", "p1")));
    expect(approved.body.status).toBe("AUTHORIZED");
    const refused = await keep(l2.authorize(patsIntent("/api/p2", "p2")));
    expect(refused.body.status).toBe("DENIED");
    // A mismatch: alice's payment carrying the planted subject.
    const mismatch = await keep(l2.authorize({ ...l2.intentFor("/api/p3", "50000", { as: "platform", sessionId: "p3" }), userId: l2.people.alice.userId, approvalSubject: PLANTED }));
    expect(mismatch.body.status).toBe("ESCALATE");
    // A failed start: the service refuses the request for good.
    l2.stub.setStart({ permanent: "invalid_request" });
    const failed = await keep(l2.authorize(patsIntent("/api/p4", "p4")));
    expect(failed.body.status).toBe("ESCALATE");
    // A malformed value (a space) is refused without being repeated.
    const malformed = await keep(l2.authorize({ ...patsIntent("/api/p5", "p5"), approvalSubject: `${PLANTED} x` }));
    expect(malformed.status).toBe(400);
    expect(ofType(l2, "ESCALATED").map((e) => e.data.approvalRequest)).toEqual(["requested", "requested", "identity_mismatch", "requested"]);
    expect(l2.stub.startForms().map((f) => hintOf(f).sub)).toEqual([PLANTED, PLANTED, PLANTED]); // the subject did travel

    // Every read a person or a process can make of it: the operator's, the administration's and the user-account routes.
    const escalationId = failed.body.authorizationId;
    await keep(l2.approve(escalationId));
    bodies.push(await l2.pending(), await l2.events());
    const details = ofType(l2, "ESCALATED").map((e) => `/v1/admin/escalations/${e.authorizationId!}`); // approved, denied, pending, approved
    for (const path of ["/v1/admin/escalations", "/v1/admin/escalations/events", ...details]) {
      const r = await keep(l2.admin("GET", path));
      expect(r.status, path).toBe(200);
    }
    for (const path of [`/v1/users/${pat}`, "/v1/platform"]) {
      const r = await keep(l2.portal("GET", path));
      expect(r.status, path).toBe(200);
    }
    await keep(l2.budget("p1"));

    const haystack = [readFileSync(l2.ledgerFile, "utf8"), ...consoleLines, ...l2.logs, JSON.stringify(bodies)].join("\n");
    for (const needle of [PLANTED, ADDRESS, encodeURIComponent(PLANTED), encodeURIComponent(ADDRESS), PLANTED_ERROR_TEXT]) {
      expect(haystack.includes(needle), needle).toBe(false);
    }
    // The scan saw something: lifecycle lines were logged, and the ledger names the person by usr_… only.
    expect(consoleLines.some((l) => l.includes("approval request sent"))).toBe(true);
    expect(haystack).toContain(pat);
    expect(haystack).not.toContain("approvalSubject");
    expect(l2.ledger.verifyChain().ok).toBe(true);
  });

  it("T-CIBA-20 a body that is not JSON is answered without quoting it, and L2 logs nothing of it (with Express as main() runs it)", async () => {
    // What the console would print: an object is inspected, with its properties, as console.error does.
    const consoleLines: string[] = [];
    const printed = (...a: unknown[]) => void consoleLines.push(a.map((x) => (typeof x === "string" ? x : inspect(x))).join(" "));
    vi.spyOn(console, "log").mockImplementation(printed);
    vi.spyOn(console, "error").mockImplementation(printed);
    const l2 = await start();
    // Outside tests Express's environment is not "test", and its default handler then prints an unhandled error. A
    // body-parser error carries the raw request body as a property, so the body would be in L2's log.
    l2.service.app.set("env", "development");
    const before = l2.ledger.entries().length;
    const send = (body: string) =>
      fetch(`${l2.url}/v1/authorize`, { method: "POST", headers: { authorization: "Bearer b-control", "content-type": "application/json" }, body });
    const answers: [number, string][] = [];
    for (const broken of [`{"approvalSubject":"${PLANTED}",}`, `{"intentId":"int_x","sessionId":"s","approvalSubject":"${PLANTED}" oops`, `"${PLANTED}`]) {
      const res = await send(broken);
      answers.push([res.status, await res.text()]);
    }
    // A body over the size limit is refused the same way, unread.
    const big = await send(JSON.stringify({ approvalSubject: PLANTED, pad: "x".repeat(300_000) }));
    answers.push([big.status, await big.text()]);
    await new Promise((r) => setTimeout(r, 50)); // Express's default handler logs after it answers
    const haystack = [...answers.map((a) => a[1]), ...consoleLines, ...l2.logs].join("\n");
    for (const needle of [PLANTED, ADDRESS, "planted.person"]) expect(haystack.includes(needle), needle).toBe(false);
    expect(consoleLines).toEqual([]);
    expect(answers.map((a) => a[0])).toEqual([400, 400, 400, 413]);
    for (const [status, text] of answers) expect(JSON.parse(text)).toEqual({ error: status === 400 ? "malformed PaymentIntent" : "PaymentIntent body refused" });
    expect(l2.ledger.entries().length).toBe(before);
    // Without a token the body is never read: 401 precedes everything.
    expect((await fetch(`${l2.url}/v1/authorize`, { method: "POST", headers: { "content-type": "application/json" }, body: `{"approvalSubject":"${PLANTED}",}` })).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// US3: a run with no person behind it never reaches anyone's phone
// ---------------------------------------------------------------------------

describe("T-CIBA-18 no user, no request (US3, FR-007, FR-008)", () => {
  it("T-CIBA-18 a platform intent, a scripted (operator-only) platform intent and an operator-only intent of a person's: nobody is asked, each returns at once, and an operator approval pays each", async () => {
    const l2 = await start();
    const { alice } = l2.people;
    const cases = [
      // What a system identity's run and the command-line agent send: no user, no subject.
      { intent: l2.intentFor(PREMIUM, "50000", { as: "platform", sessionId: "sess_system" }), mark: "no_owner", payer: "0x00000000000000000000000000000000000000f1" },
      // What the scripted regression sends.
      { intent: l2.intentFor(PREMIUM, "50000", { as: "platform", sessionId: "sess_scripted", operatorApprovalOnly: true }), mark: "operator_only", payer: "0x00000000000000000000000000000000000000f1" },
      { intent: l2.intentFor(PREMIUM, "50000", { sessionId: "sess_person_operator_only", operatorApprovalOnly: true }), mark: "operator_only", payer: alice.address },
    ];
    const ids: string[] = [];
    for (const c of cases) {
      const t0 = Date.now();
      const res = await l2.authorize(c.intent);
      expect(Date.now() - t0).toBeLessThan(500); // no wait: the helper's wait is 1500 ms
      expect(res.body.status).toBe("ESCALATE");
      ids.push(res.body.authorizationId);
    }
    const escalations = ofType(l2, "ESCALATED");
    expect(escalations.map((e) => e.data.approvalRequest)).toEqual(cases.map((c) => c.mark));
    expect(escalations.map((e) => e.data.userId)).toEqual([undefined, undefined, alice.userId]);
    await new Promise((r) => setTimeout(r, 80));
    expect(l2.stub.requests).toHaveLength(0);
    expect((await l2.pending()).pending.map((p) => [p.authorizationId, p.approvalRequest])).toEqual(ids.map((id, i) => [id, cases[i]!.mark]));
    for (const [i, c] of cases.entries()) {
      expect((await l2.approve(ids[i]!)).status).toBe(200);
      const paid = await l2.authorize({ ...c.intent, intentId: `${c.intent.intentId}_retry` });
      expect(paid.body.status).toBe("AUTHORIZED");
      expect((paid.body as { payer: string }).payer.toLowerCase()).toBe(c.payer.toLowerCase());
    }
    expect(l2.stub.requests).toHaveLength(0);
    expect(ofType(l2, "HUMAN_APPROVAL").map((e) => e.data.channel)).toEqual(["operator", "operator", "operator"]);
  });

  it("T-CIBA-18 must fail with a fallback subject: with ownerlessSubject, the platform account's escalation sends a request to bob's phone", async () => {
    const l2 = await start({ backchannel: { ownerlessSubject: BOB_SUB, waitMs: 200 } });
    l2.stub.setAnswers("pending");
    const res = await l2.authorize(l2.intentFor(PREMIUM, "50000", { as: "platform", sessionId: "sess_system" }));
    expect(res.body.status).toBe("ESCALATE");
    expect(ofType(l2, "ESCALATED")[0]!.data).toMatchObject({ approvalRequest: "requested" });
    expect(ofType(l2, "ESCALATED")[0]!.data.userId).toBeUndefined();
    // Nobody started this run, and bob's phone rings for it.
    expect(l2.stub.startForms().map((f) => hintOf(f).sub)).toEqual([BOB_SUB]);
  });
});
