// 012 US5 — an unavailable or misconfigured approval service fails closed (specs/012 tasks T036–T038):
// T-CIBA-05 (start failures and retries), T-CIBA-13 (availability) and T-CIBA-01 (startup).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PLANTED_ERROR_TEXT, type StartMode } from "./helpers/ciba-stub.js";
import { CLIENT_KEY, startBackchannelL2, type BackchannelL2 } from "./helpers/backchannel-l2.js";

const opened: BackchannelL2[] = [];
async function start(o: Parameters<typeof startBackchannelL2>[0] = {}) {
  const l2 = await startBackchannelL2(o);
  opened.push(l2);
  return l2;
}
afterEach(async () => {
  for (const l2 of opened.splice(0)) await l2.close({ closeStub: true }).catch(() => {});
});

const PREMIUM = "/api/premium-report";
const starts = (l2: BackchannelL2) => l2.stub.requests.filter((r) => r.path === "/bc-authorize").length;
const failures = (l2: BackchannelL2) => l2.ledger.entries().filter((e) => e.type === "APPROVAL_REQUEST_FAILED");

describe("T-CIBA-05 start failures", () => {
  async function failsClosed(l2: BackchannelL2, expected: Record<string, unknown>, attempts: number) {
    const t0 = Date.now();
    const res = await l2.authorize(l2.intentFor(PREMIUM, "50000"));
    expect(res.body.status).toBe("ESCALATE");
    expect(Date.now() - t0).toBeLessThan(1400); // returned on the failure, before the 1500 ms wait (FR-018)
    expect(starts(l2)).toBe(attempts);
    expect(failures(l2)).toHaveLength(1);
    expect(failures(l2)[0]!.data).toMatchObject({ channel: "backchannel", ...expected });
    expect(failures(l2)[0]!.data.requestId).toBeUndefined();
    expect(JSON.stringify(l2.ledger.entries())).not.toContain(PLANTED_ERROR_TEXT);
    expect((await l2.pending()).pending.map((p) => p.authorizationId)).toEqual([res.body.authorizationId]);
    expect((await l2.approve(res.body.authorizationId)).status).toBe(200);
    expect((await l2.authorize(l2.intentFor(PREMIUM, "50000"))).body.status).toBe("AUTHORIZED");
  }

  it.each<[string, StartMode, Record<string, unknown>, number]>([
    ["503 three times", "503", { phase: "start", failure: "transient", httpStatus: 503, attempts: 3 }, 3],
    ["429 three times", "429", { phase: "start", failure: "transient", httpStatus: 429, attempts: 3 }, 3],
    ["a dropped connection", "unreachable", { phase: "start", failure: "unreachable", attempts: 3 }, 3],
    ["a permanent refusal (unknown_user_id)", { permanent: "unknown_user_id" }, { phase: "start", failure: "permanent", httpStatus: 400, error: "unknown_user_id", attempts: 1 }, 1],
    ["a permanent refusal (unauthorized_client)", { permanent: "unauthorized_client" }, { phase: "start", failure: "permanent", httpStatus: 403, error: "unauthorized_client", attempts: 1 }, 1],
  ])("%s: APPROVAL_REQUEST_FAILED, the escalation pending, an operator approval pays", async (_l, mode, expected, attempts) => {
    const l2 = await start({ backchannel: { retryDelaysMs: [10, 20] } });
    l2.stub.setStart(mode);
    await failsClosed(l2, expected, attempts);
  });

  it("503 then ok: APPROVAL_REQUESTED after 2 attempts", async () => {
    const l2 = await start({ backchannel: { retryDelaysMs: [10, 20] } });
    l2.stub.setStart("503", "ok");
    l2.stub.setAnswers({ approve: {} });
    expect((await l2.authorize(l2.intentFor(PREMIUM, "50000"))).body.status).toBe("AUTHORIZED");
    expect(l2.ledger.entries().find((e) => e.type === "APPROVAL_REQUESTED")!.data.attempts).toBe(2);
  });

  it("a poll answering invalid_grant: APPROVAL_REQUEST_FAILED{phase: poll, permanent}", async () => {
    const l2 = await start();
    l2.stub.setAnswers("pending", "invalid_grant");
    const res = await l2.authorize(l2.intentFor(PREMIUM, "50000"));
    expect(res.body.status).toBe("ESCALATE");
    expect(failures(l2)[0]!.data).toMatchObject({ phase: "poll", failure: "permanent", error: "invalid_grant", requestId: expect.stringMatching(/^apq_/) });
  });

  it("transient poll errors back off and keep polling until an answer", async () => {
    const l2 = await start();
    l2.stub.setAnswers("503", "503", { approve: {} });
    expect((await l2.authorize(l2.intentFor(PREMIUM, "50000"))).body.status).toBe("AUTHORIZED");
    expect(failures(l2)).toHaveLength(0);
  });

  it("with the production timeouts and a hanging service, the call returns ESCALATE within 6 s (FR-018)", async () => {
    const l2 = await start({ backchannel: { retryDelaysMs: undefined, waitMs: 20_000 }, clientOptions: { startTimeoutMs: undefined } });
    l2.stub.setStart("hang");
    const t0 = Date.now();
    const res = await l2.authorize(l2.intentFor(PREMIUM, "50000"));
    const took = Date.now() - t0;
    expect(res.body.status).toBe("ESCALATE");
    expect(took).toBeLessThan(6000);
    expect(took).toBeGreaterThan(4500); // 3 × 1500 ms timeouts + 250 + 1000 ms
    expect(starts(l2)).toBe(3);
    expect(failures(l2)[0]!.data).toMatchObject({ failure: "transient", attempts: 3 });
  }, 15_000);
});

describe("T-CIBA-13 availability", () => {
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  async function timeAutoApproved(l2: BackchannelL2, tag: string) {
    const out: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const r = await l2.authorize(l2.intentFor(`/api/${tag}-${i}`, "1000", { sessionId: i % 2 ? "sess_bc" : `sess_${tag}` }));
      out.push(performance.now() - t0);
      expect(r.body.status).toBe("AUTHORIZED");
    }
    return out;
  }

  it("with the approval service hanging mid-start, auto-approved purchases are decided as fast as with the feature off", async () => {
    const off = await start({ off: true });
    const baseline = await timeAutoApproved(off, "base");
    const l2 = await start({ backchannel: { retryDelaysMs: [2000, 2000], waitMs: 10_000 }, clientOptions: { startTimeoutMs: 3000 } });
    l2.stub.setStart("hang");
    const waiting = l2.authorize(l2.intentFor(PREMIUM, "50000"));
    await new Promise((r) => setTimeout(r, 50));
    const during = await timeAutoApproved(l2, "during");
    expect(median(during)).toBeLessThan(median(baseline) + 50);
    // Their entries are those of the off path: no approvalRequest anywhere but on the escalation.
    expect(l2.ledger.entries().filter((e) => e.data.approvalRequest !== undefined).map((e) => e.type)).toEqual(["ESCALATED"]);
    l2.service.backchannel!.stop();
    void waiting.catch(() => undefined);
  }, 15_000);
});

describe("T-CIBA-01 startup", () => {
  it("CIBA_APPROVAL=1 without CIBA_ISSUER: exit 1 naming the variable, before the lock, never listening, no key text", () => {
    const repo = resolve(import.meta.dirname, "..");
    const dir = mkdtempSync(join(tmpdir(), "x402-ciba-start-"));
    try {
      const envFile = join(dir, "l2.env");
      writeFileSync(envFile, `NETWORK=local\nCIBA_APPROVAL=1\nCIBA_CLIENT_ID=c\nCIBA_AUDIENCE=a\nCIBA_APPROVER=u\nCIBA_CLIENT_KEY="${CLIENT_KEY.privatePem.replace(/\n/g, "\\n")}"\n`);
      const port = 47321;
      const r = spawnSync(join(repo, "node_modules", ".bin", "tsx"), [join(repo, "src", "layer2-control", "service.ts")], {
        cwd: dir,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, ENV_FILE: envFile, CONTROL_PORT: String(port) },
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("CIBA_ISSUER");
      const body = CLIENT_KEY.privatePem.split("\n").filter((l) => l && !l.startsWith("-----"));
      for (const line of body) expect(r.stderr + r.stdout).not.toContain(line);
      expect(existsSync(join(dir, ".local", "ledger-local.jsonl.lock"))).toBe(false);
      return new Promise<void>((done) => {
        const c = createConnection({ host: "127.0.0.1", port }, () => {
          c.end();
          throw new Error("L2 is listening");
        });
        c.on("error", () => done());
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
