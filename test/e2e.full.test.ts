// T-E2E-17 — the whole system, end to end (SPEC v1.17; specs/016 quickstart §3). One stack, all real but the model
// and the phone: the local chain with MockUSDC, the facilitator and the seller; L2 with user accounts, the
// administration routes, sign-in and backchannel approval; L3 verifying each settlement on-chain; the portal's HTTP
// API; and a stand-in for the approval service (CIBA) that plays a person's phone.
//
// One tenant for everything: the stand-in's issuer signs the portal's tokens and the agent's (in-memory keys), so a
// person is the same user at the portal, at the agent, at L2 and on their phone.
//
// Two entry points to L1:
// - the hosted agent service (`POST /v1/runs`, JSON and event stream), for a person, with a scripted model;
// - the local agent: the command-line entry point (`src/main.ts --scripted`, a real process) and the Claude
//   tool-use loop with a scripted Messages client, both as a machine caller, so the platform account pays.
//
// The tests are one journey and run in order: two people onboard in the portal (a profile, a wallet of their own, an
// expense policy), their agents buy, a purchase waits for a phone, an administrator decides in the portal, the local
// agent runs the regression plan, an account is disabled, and at the end the ledger, the chain and the balances agree.
import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import { approve } from "../scripts/approve.js";
import { runClaudeAgent, type MessagesClient } from "../src/layer1-intent/agent.js";
import { PaidResourceOrchestrator, type PaidFetchResult } from "../src/layer1-intent/orchestrator.js";
import { HttpSettlementVerifier } from "../src/layer1-intent/ports-http.js";
import { issuerKeys } from "../src/layer2-control/approval-evidence.js";
import { CibaClient, type CibaSettings } from "../src/layer2-control/ciba-client.js";
import { RegressionBaseline } from "./helpers/baseline.js";
import { type CibaStub, startCibaStub, testRsaKeyPair } from "./helpers/ciba-stub.js";
import { type Harness, startHarness } from "./helpers/harness.js";
import { mockModel, startHostedApp, text, toolCall, type HostedTestApp, type ModelScript } from "./helpers/hosted.js";
import { type PortalTestApp, startPortal } from "./helpers/portal.js";

const CLIENT_ID = "l2-ciba-client-e2e-full";
const AUDIENCE = "https://x402-approvals.example/e2e-full";
const CLIENT_KEY = testRsaKeyPair();

/** The people of this suite, by their subject at the tenant. */
const ANA_SUB = "auth0|ana-e2e-full";
const BEN_SUB = "auth0|ben-e2e-full";
const CARLA_SUB = "auth0|carla-admin-e2e-full";

/** What a person types at the portal. None of it may reach L2 or the ledger (hard rule 11). */
const PROFILES = {
  ana: { displayName: "Ana Pérez Typed", contactEmail: "ana.typed@example.test", acknowledgedTestFunds: true },
  ben: { displayName: "Ben Okafor Typed", contactEmail: "ben.typed@example.test", acknowledgedTestFunds: true },
} as const;

const PRICE = { weather: 1_000n, brief: 5_000n, premium: 50_000n } as const;
const FUNDS = 1_000_000n;

type Step = { index: number; tool: string; url?: string; result: { outcome: string; authorizationId?: string | null; violations?: { rule: string }[] | null; payment?: { settlement?: { status: string; tx?: string } } | null } };
type Run = { runId: string; sessionRef: string; status: string; stopReason: string | null; error: string | null; finalText: string; steps: Step[] };

describe("T-E2E-17 the whole system end to end: portal onboarding, both agents, L2, L3 and a phone approval", () => {
  let h: Harness;
  let stub: CibaStub;
  let portal: PortalTestApp;
  const hosted: HostedTestApp[] = [];
  /** Every access token this suite presented anywhere, for the final scan. */
  const tokens: string[] = [];
  /** Every authorization a step reported as paid, for the final check against L3's reports. */
  const paidIds: string[] = [];
  const people: Record<"ana" | "ben", { sub: string; userId: string; address: `0x${string}`; policyId: string; spent: bigint }> = {
    ana: { sub: ANA_SUB, userId: "", address: "0x", policyId: "", spent: 0n },
    ben: { sub: BEN_SUB, userId: "", address: "0x", policyId: "", spent: 0n },
  };
  let platformSpent = 0n;
  let platform0 = 0n;
  let seller0 = 0n;
  /**
   * The portal shows a balance that is at most 20 s old. Its clock is this suite's, so the one test that reads a
   * balance after a payment moves it past that age (once: sign-in times are judged with 60 s of tolerance).
   */
  let portalClockAheadMs = 0;
  const freshBalances = () => {
    portalClockAheadMs += 21_000;
  };

  beforeAll(async () => {
    stub = await startCibaStub({ clientId: CLIENT_ID, audience: AUDIENCE, clientPublicKeyPem: CLIENT_KEY.publicPem });
    const settings: CibaSettings = { issuer: stub.issuer, clientId: CLIENT_ID, audience: AUDIENCE, credential: { kind: "key", keyPem: CLIENT_KEY.privatePem } };
    h = await startHarness({
      users: {},
      admin: true,
      // One tenant: people sign in at the issuer that also asks their phone.
      callers: { issuer: stub.issuer },
      controlBackchannel: {
        port: new CibaClient(settings, { allowInsecureLoopback: true }),
        issuer: stub.issuer,
        clientId: CLIENT_ID,
        audience: AUDIENCE,
        keys: issuerKeys(stub.issuer, { allowInsecureLoopback: true }),
        decimals: 6,
        // A phone that does not answer holds a payment request this long, then the run is told ESCALATED.
        waitMs: 1_500,
        pollDelayMs: (s) => s * 40,
        log: () => {},
      },
    });
    // The real portal app over this L2, with the same tenant's tokens and the chain's balances.
    const l2 = { url: h.urls.control, clock: { now: () => Date.now() + portalClockAheadMs }, ledger: {}, requestCount: () => 0, close: async () => {} };
    portal = await startPortal({
      l2: l2 as never,
      admin: true,
      callers: h.callers!,
      balance: { balanceOf: async (_asset, address) => h.balanceOf(address as `0x${string}`) },
      env: { PORTAL_TOKEN: h.tokens.portal, PORTAL_ADMIN_TOKEN: h.tokens.portalAdmin },
    });
    platform0 = await h.balanceOf(h.addresses.payer);
    seller0 = await h.balanceOf(h.addresses.payTo);
  }, 120_000);

  afterAll(async () => {
    await Promise.all(hosted.map((a) => a.close()));
    await portal?.close();
    await h?.close();
    await stub?.close();
  });

  // --- small helpers over the real interfaces -------------------------------------------------------------------

  const seller = (path: string) => `${h.urls.seller}${path}`;
  const buy = (path: string, purpose: string) => toolCall("fetch_resource", { url: seller(path), purpose });
  /** A hosted agent service on this stack, with a model that plays `script`. */
  async function hostedWith(script: ModelScript): Promise<HostedTestApp> {
    const a = await startHostedApp({ harness: h, model: mockModel(script) });
    hosted.push(a);
    return a;
  }
  /** A goal sent to the hosted agent as a signed-in person. */
  async function runAs(a: HostedTestApp, who: keyof typeof people, goal: string, extra: Record<string, unknown> = {}): Promise<{ status: number; run: Run }> {
    const jwt = await a.token(who, { sub: people[who].sub });
    tokens.push(jwt);
    const res = await fetch(`${a.base}/v1/runs`, { method: "POST", headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" }, body: JSON.stringify({ goal, ...extra }) });
    return { status: res.status, run: (await res.json()) as Run };
  }
  const outcomes = (run: Run) => run.steps.map((s) => s.result.outcome);
  const notePaid = (steps: Step[]) => {
    for (const s of steps) if (s.result.outcome === "PAID") paidIds.push(String(s.result.authorizationId));
  };
  const entries = (type: string) => h.ledgerEntries().filter((e) => e.type === type);
  /** A portal session of `who`, with a fresh sign-in each call. */
  const at = (who: keyof typeof people) => {
    const call = portal.as(who, { sub: people[who].sub });
    return async <T = Record<string, unknown>>(method: string, path: string, body?: unknown) => {
      const r = await call<T>(method, path, body);
      return r;
    };
  };
  const policyFor = () => ({
    name: "Research APIs typed",
    sellers: [new URL(h.urls.seller).host],
    autoApproveUsdc: "0.02",
    perPaymentUsdc: "0.10",
    perRunUsdc: "0.10",
    perDayUsdc: "0.50",
    paymentsPerMinute: 10,
    endsOn: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
    paymentMethod: "crypto_account",
  });

  // --- 1. onboarding, through the portal ------------------------------------------------------------------------

  it("T-E2E-17 two new people onboard in the portal: a profile, a wallet of their own that only L2 signs with, and an expense policy", async () => {
    for (const who of ["ana", "ben"] as const) {
      const me = at(who);
      const fresh = await me<{ userId: string; onboarding: Record<string, boolean>; admin: boolean }>("GET", "/api/me");
      expect(fresh.status).toBe(200);
      expect(fresh.body).toMatchObject({ enabled: true, onboarding: { profile: false, wallet: false, policy: false }, admin: false });
      people[who].userId = fresh.body.userId;
      // The same user everywhere: the portal's identifier is the one L2 will compute from the agent's token.
      expect(fresh.body.userId).toBe(h.callers!.register(people[who].sub));

      expect((await me("PUT", "/api/profile", PROFILES[who])).status).toBe(200);
      const wallet = await me<{ account: { address: `0x${string}` } }>("PUT", "/api/wallet/account");
      expect(wallet.status).toBe(200);
      people[who].address = wallet.body.account.address;
      // Local test money for the new account, as `npm run fund-user` gives it.
      await h.fund(people[who].address, FUNDS);
      const policy = await me<{ policyId: string }>("POST", "/api/policies", policyFor());
      expect(policy.status, JSON.stringify(policy.body)).toBe(201);
      people[who].policyId = policy.body.policyId;

      const done = await me<{ onboarding: Record<string, boolean>; profile: { displayName: string } }>("GET", "/api/me");
      expect(done.body).toMatchObject({ onboarding: { profile: true, wallet: true, policy: true }, profile: { displayName: PROFILES[who].displayName } });
      expect((await me<{ account: { address: string } }>("GET", "/api/wallet")).body.account.address).toBe(people[who].address);
      expect(await h.balanceOf(people[who].address)).toBe(FUNDS);
    }
    // Two people, two accounts, neither the platform's.
    expect(new Set([people.ana.address.toLowerCase(), people.ben.address.toLowerCase(), h.addresses.payer.toLowerCase()]).size).toBe(3);
    expect(people.ana.userId).not.toBe(people.ben.userId);
    // L2 recorded each step for each person, by identifier only.
    for (const who of ["ana", "ben"] as const) {
      for (const type of ["USER_REGISTERED", "WALLET_CREATED", "POLICY_CREATED"]) {
        expect(entries(type).filter((e) => e.data.userId === people[who].userId), `${who} ${type}`).toHaveLength(1);
      }
    }
  }, 60_000);

  // --- 2. the hosted agent, for a person ------------------------------------------------------------------------

  it("T-E2E-17 hosted agent, JSON answer: ana's run pays from her own wallet, L3 confirms each payment on-chain, and the platform account is untouched", async () => {
    const a = await hostedWith([buy("/api/catalog", "browse"), buy("/api/weather?city=Lima", "weather"), buy("/api/market-brief", "brief"), text("Lima: fine. Markets: steady.")]);
    const { status, run } = await runAs(a, "ana", "Get the weather for Lima and a market brief.");
    expect(status).toBe(200);
    expect([run.status, run.finalText]).toEqual(["completed", "Lima: fine. Markets: steady."]);
    expect(outcomes(run)).toEqual(["FREE", "PAID", "PAID"]);
    for (const s of run.steps.slice(1)) expect(s.result.payment?.settlement?.status).toBe("CONFIRMED");
    notePaid(run.steps);
    people.ana.spent += PRICE.weather + PRICE.brief;
    expect(await h.balanceOf(people.ana.address)).toBe(FUNDS - people.ana.spent);
    expect(await h.balanceOf(h.addresses.payer)).toBe(platform0);
    // L2 decided each payment for ana, under her policy, and her account signed it.
    for (const s of run.steps.slice(1)) {
      const entry = entries("AUTHORIZED").find((e) => e.authorizationId === s.result.authorizationId)!;
      expect([entry.data.userId, entry.data.policyId, String(entry.data.payer).toLowerCase()]).toEqual([people.ana.userId, people.ana.policyId, people.ana.address.toLowerCase()]);
    }
    // The portal shows her what is left.
    freshBalances();
    expect((await at("ana")<{ account: { balanceAtomic: string } }>("GET", "/api/wallet")).body.account.balanceAtomic).toBe((FUNDS - people.ana.spent).toString());
  }, 60_000);

  it("T-E2E-17 hosted agent, event stream: ben's run arrives as it happens, and its result is the same kind of answer", async () => {
    const a = await hostedWith([buy("/api/weather?city=Quito", "weather"), text("Quito is mild today.")]);
    const jwt = await a.token("ben", { sub: BEN_SUB });
    tokens.push(jwt);
    const res = await fetch(`${a.base}/v1/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ goal: "Get the weather for Quito." }),
    });
    expect([res.status, res.headers.get("content-type")]).toEqual([200, "text/event-stream; charset=utf-8"]);
    const blocks = (await res.text()).split("\n\n").filter((b) => b.startsWith("event: "));
    const events = blocks.map((b) => ({ event: b.split("\n")[0]!.slice(7), data: JSON.parse(b.split("\n")[1]!.slice(6)) as Record<string, unknown> }));
    expect([events[0]!.event, events.at(-1)!.event]).toEqual(["run", "result"]);
    expect(events.filter((e) => e.event === "text").map((e) => e.data.delta).join("")).toBe("Quito is mild today.");
    const step = events.find((e) => e.event === "step")!.data as unknown as Step;
    expect(step.result.outcome).toBe("PAID");
    const run = events.at(-1)!.data as unknown as Run;
    expect([run.status, run.finalText, outcomes(run)]).toEqual(["completed", "Quito is mild today.", ["PAID"]]);
    notePaid(run.steps);
    people.ben.spent += PRICE.weather;
    expect(await h.balanceOf(people.ben.address)).toBe(FUNDS - people.ben.spent);
    // Ana's wallet did not move for ben's run.
    expect(await h.balanceOf(people.ana.address)).toBe(FUNDS - people.ana.spent);
  }, 60_000);

  // --- 3. a purchase that needs a person: the phone (simulated CIBA) -------------------------------------------

  it("T-E2E-17 an escalated purchase asks ana's own phone, from the token L2 verified: she approves, and the same run pays from her wallet", async () => {
    const a = await hostedWith([buy("/api/premium-report", "premium report"), text("Here is the premium report.")]);
    const before = stub.authReqIds.length;
    stub.setAnswersFor(before, "pending", { approve: {} });
    const { run } = await runAs(a, "ana", "Buy the premium report.");
    expect(outcomes(run), JSON.stringify(run.steps[0]?.result)).toEqual(["PAID"]);
    notePaid(run.steps);
    people.ana.spent += PRICE.premium;
    // One request, to ana, about this payment; ben's phone was never involved.
    expect(stub.authReqIds.length - before).toBe(1);
    expect(JSON.parse(stub.startForms().at(-1)!.login_hint!)).toEqual({ format: "iss_sub", iss: stub.issuer, sub: ANA_SUB });
    const escalated = entries("ESCALATED").at(-1)!;
    expect(escalated.data).toMatchObject({ approvalRequest: "requested", userId: people.ana.userId, amount: PRICE.premium.toString() });
    const approval = entries("HUMAN_APPROVAL").at(-1)!;
    expect(approval.data).toMatchObject({ channel: "backchannel", approver: people.ana.userId });
    expect(await h.balanceOf(people.ana.address)).toBe(FUNDS - people.ana.spent);
  }, 60_000);

  it("T-E2E-17 ben refuses on his phone: the purchase is denied, nothing leaves his wallet, and the next try in that session is denied too", async () => {
    const a = await hostedWith([buy("/api/premium-report", "premium report"), text("It was refused."), buy("/api/premium-report", "again"), text("Still refused.")]);
    const before = stub.authReqIds.length;
    stub.setAnswersFor(before, "deny");
    const first = await runAs(a, "ben", "Buy the premium report.");
    expect(outcomes(first.run)).toEqual(["DENIED"]);
    expect((first.run.steps[0]!.result.violations ?? []).map((v) => v.rule)).toEqual(["human_rejected"]);
    expect(JSON.parse(stub.startForms().at(-1)!.login_hint!).sub).toBe(BEN_SUB);
    const rejection = entries("HUMAN_REJECTION").at(-1)!;
    expect(rejection.data).toMatchObject({ channel: "backchannel", approver: people.ben.userId });
    // The same session: denied at once, and the phone is not asked again.
    const again = await runAs(a, "ben", "Try the premium report again.", { sessionRef: first.run.sessionRef });
    expect(outcomes(again.run)).toEqual(["DENIED"]);
    expect(stub.authReqIds.length - before).toBe(1);
    expect(await h.balanceOf(people.ben.address)).toBe(FUNDS - people.ben.spent);
  }, 60_000);

  // --- 4. a purchase that needs a person: an administrator, in the portal --------------------------------------

  it("T-E2E-17 a phone that does not answer leaves the purchase waiting; an administrator approves it in the portal, and ben's next try pays from his wallet", async () => {
    const a = await hostedWith([buy("/api/premium-report", "premium report"), text("It is waiting for approval."), buy("/api/premium-report", "premium report, approved"), text("Here it is.")]);
    const before = stub.authReqIds.length;
    stub.setAnswersFor(before, "pending");
    const waiting = await runAs(a, "ben", "Buy the premium report for the quarterly review.");
    expect(outcomes(waiting.run)).toEqual(["ESCALATED"]);
    const id = String(waiting.run.steps[0]!.result.authorizationId);

    // Carla is an administrator: she holds portal:admin, and the payment is not her own.
    const carla = portal.adminAs("carla", { sub: CARLA_SUB });
    const listed = await carla<{ pending: Array<Record<string, unknown>> }>("GET", "/api/admin/escalations");
    expect(listed.status).toBe(200);
    expect(listed.body.pending.map((e) => [e.authorizationId, e.owner, e.mine, e.amountAtomic])).toEqual([[id, { userId: people.ben.userId, platformAccount: false }, false, PRICE.premium.toString()]]);
    const approved = await carla("POST", `/api/admin/escalations/${id}/approve`, {});
    expect(approved.body).toMatchObject({ ok: true, state: "approved", channel: "portal" });
    // Neither ben nor ana may decide it: the administration area is the administrator's.
    expect((await at("ben")("GET", "/api/admin/escalations")).status).toBe(403);

    const paid = await runAs(a, "ben", "Buy the premium report, it was approved.", { sessionRef: waiting.run.sessionRef });
    expect(outcomes(paid.run), JSON.stringify(paid.run.steps[0]?.result)).toEqual(["PAID"]);
    notePaid(paid.run.steps);
    people.ben.spent += PRICE.premium;
    expect(await h.balanceOf(people.ben.address)).toBe(FUNDS - people.ben.spent);
    const approval = entries("HUMAN_APPROVAL").find((e) => e.data.escalationId === id)!;
    expect(approval.data).toMatchObject({ channel: "portal", amount: PRICE.premium.toString() });
  }, 60_000);

  // --- 5. each service accepts only its own tokens --------------------------------------------------------------

  it("T-E2E-17 a portal session starts no run, an agent token opens no portal, and one person's session is nobody else's", async () => {
    const a = await hostedWith(async () => text("ok"));
    const portalToken = await portal.token("ana", { sub: ANA_SUB });
    const agentToken = await a.token("ana", { sub: ANA_SUB });
    tokens.push(portalToken, agentToken);
    const post = (jwt: string, body: unknown) => fetch(`${a.base}/v1/runs`, { method: "POST", headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post(portalToken, { goal: "hi" })).status).toBe(403);
    expect((await portal.call("GET", "/api/me", { token: agentToken })).status).toBe(403);
    // And L2 itself refuses a portal token forwarded as a caller's.
    const direct = await fetch(`${h.urls.control}/v1/budget/sess_x`, { headers: { authorization: `Bearer ${h.tokens.control}`, "x-caller-authorization": `Bearer ${portalToken}` } });
    expect([direct.status, await direct.json()]).toEqual([403, { error: "caller_forbidden" }]);
    const mine = (await (await post(agentToken, { goal: "hi" })).json()) as Run;
    const bens = await a.token("ben", { sub: BEN_SUB });
    tokens.push(bens);
    expect((await post(bens, { goal: "hi", sessionRef: mine.sessionRef })).status).toBe(404);
  }, 60_000);

  // --- 6. the local agent: the command-line entry point and the tool-use loop ----------------------------------

  it("T-E2E-17 local agent, command line: the scripted plan runs as a machine caller, matches the baseline, pays from the platform account, and asks nobody's phone", async () => {
    const caller = await h.callers!.machine();
    tokens.push(caller);
    const phoneRequests = stub.authReqIds.length;
    const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts", "--scripted", "--check-baseline"], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ENV_FILE: "/dev/null",
        NETWORK: "local",
        SELLER_URL: h.urls.seller,
        CONTROL_URL: h.urls.control,
        SETTLEMENT_URL: h.urls.settlement,
        CONTROL_TOKEN: h.tokens.control,
        VERIFIER_TOKEN: h.tokens.verifier,
        SESSION_ID: "sess_full_cli",
        CALLER_TOKEN: caller,
      },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));
    const code = await new Promise<number | null>((r) => child.on("close", r));
    expect(out).toContain("baseline: ok");
    expect(code).toBe(0);
    expect(out).not.toContain(caller);
    platformSpent += PRICE.weather + PRICE.brief;
    expect(platform0 - (await h.balanceOf(h.addresses.payer))).toBe(platformSpent);
    // The plan's six decisions are in the ledger for that session, with no user on any of them.
    const mine = h.ledgerEntries().filter((e) => e.sessionId === "sess_full_cli");
    const decided = mine.filter((e) => ["AUTHORIZED", "ESCALATED", "DENIED"].includes(e.type)).map((e) => e.type);
    expect(decided).toEqual(["AUTHORIZED", "AUTHORIZED", "ESCALATED", "DENIED", "DENIED"]);
    expect(RegressionBaseline.outcomes).toEqual(["FREE", "PAID", "PAID", "ESCALATED", "DENIED", "DENIED"]);
    for (const e of mine) expect("userId" in e.data, e.type).toBe(false);
    for (const e of mine.filter((x) => x.type === "AUTHORIZED")) paidIds.push(String(e.authorizationId));
    // The plan is operator-only, and its payments have no owner: no phone was asked.
    expect(mine.find((e) => e.type === "ESCALATED")!.data.approvalRequest).toBe("operator_only");
    expect(stub.authReqIds.length).toBe(phoneRequests);
  }, 120_000);

  it("T-E2E-17 local agent: the operator approves the plan's escalation from the command line, and the agent's retry pays from the platform account", async () => {
    const id = String(h.ledgerEntries().find((e) => e.sessionId === "sess_full_cli" && e.type === "ESCALATED")!.authorizationId);
    // `npm run approve -- <id>`, in process: the operator's own token and nothing else.
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: unknown) => void lines.push(String(line));
    let code: number;
    try {
      code = await approve([id, "ops-e2e"], { NETWORK: "local", CONTROL_URL: h.urls.control, OPERATOR_TOKEN: h.tokens.operator });
    } finally {
      console.log = log;
    }
    expect(code).toBe(0);
    const orchestrator = new PaidResourceOrchestrator({
      gate: h.gateFor(),
      settlement: new HttpSettlementVerifier(h.urls.settlement, h.tokens.verifier),
      sessionId: "sess_full_cli",
      operatorApprovalOnly: true,
    });
    const paid: PaidFetchResult = await orchestrator.fetchPaid(seller("/api/premium-report"), "premium report, approved by the operator");
    expect(paid.outcome, JSON.stringify(paid.violations ?? paid.error)).toBe("PAID");
    expect(paid.payment?.settlement?.status).toBe("CONFIRMED");
    expect(paid.payment!.settlement!.verified.payer.toLowerCase()).toBe(h.addresses.payer.toLowerCase());
    paidIds.push(String(paid.authorizationId));
    platformSpent += PRICE.premium;
    expect(platform0 - (await h.balanceOf(h.addresses.payer))).toBe(platformSpent);
  }, 60_000);

  it("T-E2E-17 local agent, tool-use loop: a Claude run with a scripted model buys through the same L2 and L3, as a machine caller", async () => {
    type Block = Message["content"][number];
    const msg = (content: Block[], stop: Message["stop_reason"]): Message =>
      ({ id: "msg", type: "message", role: "assistant", model: "scripted", content, stop_reason: stop, stop_sequence: null, usage: {} }) as unknown as Message;
    const requests: MessageCreateParamsNonStreaming[] = [];
    const client: MessagesClient = {
      messages: {
        async create(params) {
          requests.push(structuredClone(params));
          if (requests.length === 1) return msg([{ type: "tool_use", id: "tu_1", name: "fetch_resource", input: { url: seller("/api/market-brief"), purpose: "brief" } } as unknown as Block], "tool_use");
          if (requests.length === 2) return msg([{ type: "tool_use", id: "tu_2", name: "check_budget", input: {} } as unknown as Block], "tool_use");
          return msg([{ type: "text", text: "Bought the market brief.", citations: null } as unknown as Block], "end_turn");
        },
      },
    };
    const gate = h.gateFor();
    const orchestrator = new PaidResourceOrchestrator({ gate, settlement: new HttpSettlementVerifier(h.urls.settlement, h.tokens.verifier), sessionId: "sess_full_claude" });
    const result = await runClaudeAgent({ goal: "Buy today's market brief.", orchestrator, gate, sessionId: "sess_full_claude", sellerUrl: h.urls.seller, client });
    expect(result.finalText).toBe("Bought the market brief.");
    const authorized = h.ledgerEntries().filter((e) => e.sessionId === "sess_full_claude" && e.type === "AUTHORIZED");
    expect(authorized).toHaveLength(1);
    expect(String(authorized[0]!.data.payer).toLowerCase()).toBe(h.addresses.payer.toLowerCase());
    paidIds.push(String(authorized[0]!.authorizationId));
    platformSpent += PRICE.brief;
    expect(platform0 - (await h.balanceOf(h.addresses.payer))).toBe(platformSpent);
    // The model saw the budget of its own session, and never a token.
    const sent = JSON.stringify(requests);
    expect(sent).toContain('\\"spentOrReservedAtomic\\":\\"5000\\"');
    for (const t of tokens) expect(sent.includes(t)).toBe(false);
  }, 60_000);

  // --- 7. an account its owner switched off ---------------------------------------------------------------------

  it("T-E2E-17 ana disables her account in the portal: her agent's next purchase is denied, and her wallet keeps what it has", async () => {
    const off = await at("ana")<{ enabled: boolean }>("POST", "/api/account/disable", { confirm: true });
    expect(off.body.enabled).toBe(false);
    const a = await hostedWith([buy("/api/weather?city=Lima", "weather"), text("It was denied.")]);
    const { run } = await runAs(a, "ana", "Get the weather for Lima.");
    expect(outcomes(run)).toEqual(["DENIED"]);
    expect((run.steps[0]!.result.violations ?? []).map((v) => v.rule)).toEqual(["user_disabled"]);
    expect(await h.balanceOf(people.ana.address)).toBe(FUNDS - people.ana.spent);
    // Never the platform account instead.
    expect(platform0 - (await h.balanceOf(h.addresses.payer))).toBe(platformSpent);
    // Ben is unaffected.
    const b = await hostedWith([buy("/api/weather?city=Lima", "weather"), text("Fine.")]);
    const bens = await runAs(b, "ben", "Get the weather for Lima.");
    expect(outcomes(bens.run)).toEqual(["PAID"]);
    notePaid(bens.run.steps);
    people.ben.spent += PRICE.weather;
  }, 60_000);

  // --- 8. the books -----------------------------------------------------------------------------------------------

  it("T-E2E-17 at the end the books agree: the hash chain verifies, L3 confirmed every payment on-chain, the money adds up, and no token or typed text is in the ledger", async () => {
    // The ledger's hash chain, as the operator's check and the administrator's see it.
    const verify = await fetch(`${h.urls.control}/v1/ledger/verify`, { headers: { authorization: `Bearer ${h.tokens.operator}` } });
    expect(await verify.json()).toMatchObject({ ok: true });
    const carla = portal.adminAs("carla", { sub: CARLA_SUB });
    expect((await carla<{ ok: boolean }>("GET", "/api/admin/ledger/verify")).body.ok).toBe(true);

    // Every payment a run reported is an AUTHORIZED entry with exactly one effective settlement: CONFIRMED, by L3.
    expect(new Set(paidIds).size).toBe(paidIds.length);
    // Ana: weather, brief, premium. Ben: weather, premium, weather. The platform: weather, brief, premium, brief.
    expect(paidIds).toHaveLength(10);
    const settlements = entries("SETTLEMENT").filter((e) => e.data.anomaly !== true);
    for (const id of paidIds) {
      expect(entries("AUTHORIZED").filter((e) => e.authorizationId === id), id).toHaveLength(1);
      expect(settlements.filter((e) => e.authorizationId === id).map((e) => e.data.status), id).toEqual(["CONFIRMED"]);
    }
    // And nothing was authorized that no run reported.
    expect(entries("AUTHORIZED").map((e) => String(e.authorizationId)).sort()).toEqual([...paidIds].sort());

    // The money: each account paid exactly its own purchases, and the seller received their sum.
    expect(people.ana.spent).toBe(PRICE.weather + PRICE.brief + PRICE.premium);
    expect(people.ben.spent).toBe(PRICE.weather + PRICE.premium + PRICE.weather);
    expect(platformSpent).toBe(PRICE.weather + PRICE.brief + PRICE.premium + PRICE.brief);
    expect(await h.balanceOf(people.ana.address)).toBe(FUNDS - people.ana.spent);
    expect(await h.balanceOf(people.ben.address)).toBe(FUNDS - people.ben.spent);
    expect(platform0 - (await h.balanceOf(h.addresses.payer))).toBe(platformSpent);
    expect((await h.balanceOf(h.addresses.payTo)) - seller0).toBe(people.ana.spent + people.ben.spent + platformSpent);
    // The ledger attributes each payment to its payer: a person's to that person, the platform's to nobody.
    const byOwner = (userId: string | undefined) =>
      entries("AUTHORIZED")
        .filter((e) => e.data.userId === userId)
        .reduce((sum, e) => sum + BigInt(String((e.data as { amount?: string; requirement?: { amount: string } }).amount ?? (e.data as { requirement: { amount: string } }).requirement.amount)), 0n);
    expect(byOwner(people.ana.userId)).toBe(people.ana.spent);
    expect(byOwner(people.ben.userId)).toBe(people.ben.spent);
    expect(byOwner(undefined)).toBe(platformSpent);

    // What must never be written: a token anyone presented, a subject, or anything a person typed.
    const ledger = JSON.stringify(h.ledgerEntries());
    expect(tokens.length).toBeGreaterThan(8);
    for (const t of [...tokens, ...portal.issued]) expect(ledger.includes(t), "a token").toBe(false);
    for (const hidden of [ANA_SUB, BEN_SUB, CARLA_SUB, "Typed", "example.test", "Research APIs typed"]) expect(ledger.includes(hidden), hidden).toBe(false);
    expect(ledger).toContain(people.ana.userId);
  }, 60_000);
});
