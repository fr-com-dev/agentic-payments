// 016 hosted agent service: the run stream (SPEC.md L1-6 v1.17; specs/016 contracts/hosted-agent-api.md "The stream").
// T-AGT-11: with `Accept: text/event-stream` the answer is server-sent events (`run`, `text`…, `step`…, `result`),
// the last of which is the JSON answer's object; refusals stay JSON; quiet periods get a keep-alive.
// T-AGT-12: the stream ends the way a JSON answer would in every case (disconnect, deadline, failure), a paid fetch
// in progress completes, and nothing the JSON answer does not carry is in it.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakePorts, mockModel, modelCalls, startHostedApp, text, toolCall, type HostedTestApp } from "./helpers/hosted.js";

let cleanups: (() => Promise<void>)[] = [];
/** How many requests the test seller's slow route has received. */
let slowHits = 0;
afterEach(async () => {
  await Promise.all(cleanups.map((c) => c()));
  cleanups = [];
  slowHits = 0;
});

async function hosted(...args: Parameters<typeof startHostedApp>): Promise<HostedTestApp> {
  const a = await startHostedApp(...args);
  cleanups.push(() => a.close());
  return a;
}

/** A free seller: /api/catalog at once, /api/slow after `slowMs`. */
async function seller(slowMs = 400): Promise<string> {
  const app = express();
  app.get("/api/catalog", (_req, res) => res.json({ items: ["weather"] }));
  app.get("/api/slow", (_req, res) => {
    slowHits++;
    setTimeout(() => res.json({ slow: true }), slowMs);
  });
  const server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

interface Sse {
  event: string;
  data: Record<string, unknown>;
}

/** The events of a stream body, in order, and its comment lines. Fails on anything that is neither. */
function parse(body: string): { events: Sse[]; comments: string[] } {
  const events: Sse[] = [];
  const comments: string[] = [];
  for (const block of body.split("\n\n")) {
    if (block === "") continue;
    if (block.startsWith(":")) {
      comments.push(block);
      continue;
    }
    const lines = block.split("\n");
    expect(lines, block).toHaveLength(2);
    expect(lines[0]).toMatch(/^event: (run|text|step|result)$/);
    expect(lines[1]).toMatch(/^data: \{/);
    events.push({ event: lines[0]!.slice("event: ".length), data: JSON.parse(lines[1]!.slice("data: ".length)) as Record<string, unknown> });
  }
  return { events, comments };
}

async function post(a: HostedTestApp, token: string | null, body: unknown, accept?: string, signal?: AbortSignal) {
  return fetch(`${a.base}/v1/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token !== null && { authorization: `Bearer ${token}` }), ...(accept !== undefined && { accept }) },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...(signal && { signal }),
  });
}

const STREAM = "text/event-stream";
const kinds = (events: Sse[]) => events.map((e) => e.event);
/** One scripted run: the catalog, the budget, then an answer of several words. */
const script = (sellerUrl: string) => () => mockModel([toolCall("fetch_resource", { url: `${sellerUrl}/api/catalog`, purpose: "read the catalog" }), toolCall("check_budget", {}), text("The catalog lists weather only.")]);

describe("T-AGT-11 the run stream (016 FR-034..FR-039)", () => {
  it("T-AGT-11 with Accept: text/event-stream the answer is run, then text and steps as they happen, then result, and nothing after", async () => {
    const s = await seller();
    const a = await hosted({ model: script(s)(), env: { SELLER_URL: s } });
    const res = await post(a, await a.token("alice"), { goal: "what is in the catalog?" }, STREAM);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const body = await res.text();
    const { events } = parse(body);
    expect(body.endsWith("\n\n")).toBe(true);

    // The run's identifier first, the result last.
    expect(events[0]).toEqual({ event: "run", data: { runId: expect.stringMatching(/^run_/), startedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) } });
    expect(events.at(-1)!.event).toBe("result");
    expect(kinds(events).filter((k) => k === "run" || k === "result")).toEqual(["run", "result"]);
    const result = events.at(-1)!.data;
    expect(result).toMatchObject({ runId: events[0]!.data.runId, startedAt: events[0]!.data.startedAt, status: "completed", stopReason: null, error: null });

    // One event per finished tool step, in completion order, each exactly as the result lists it.
    const steps = events.filter((e) => e.event === "step").map((e) => e.data);
    expect(steps).toEqual(result.steps);
    expect(steps.map((x) => [x.index, x.tool])).toEqual([
      [1, "fetch_resource"],
      [2, "check_budget"],
    ]);
    // The text arrives in pieces, after the steps it follows, and adds up to the final answer.
    const texts = events.filter((e) => e.event === "text");
    expect(texts.length).toBeGreaterThan(1);
    for (const t of texts) expect(Object.keys(t.data)).toEqual(["delta"]);
    expect(texts.map((t) => t.data.delta).join("")).toBe("The catalog lists weather only.");
    expect(result.finalText).toBe("The catalog lists weather only.");
    expect(kinds(events)).toEqual(["run", "step", "step", ...texts.map(() => "text"), "result"]);
  });

  it("T-AGT-11 the stream's result equals the JSON answer of the same run in every field but the run's identifier, its session and its times", async () => {
    const s = await seller();
    const a = await hosted({ model: script(s)(), env: { SELLER_URL: s } });
    const b = await hosted({ model: script(s)(), env: { SELLER_URL: s } });
    const streamed = parse(await (await post(a, await a.token("alice"), { goal: "what is in the catalog?" }, STREAM)).text()).events.at(-1)!.data;
    const json = (await (await post(b, await b.token("alice"), { goal: "what is in the catalog?" })).json()) as Record<string, unknown>;
    expect(Object.keys(streamed).sort()).toEqual(Object.keys(json).sort());
    const same = ({ runId: _r, sessionRef: _s, startedAt: _a, finishedAt: _f, ...rest }: Record<string, unknown>) => {
      // A budget step names its session; everything else in a step is the same.
      return JSON.parse(JSON.stringify(rest).replace(/sess_[0-9a-f]+/g, "sess_x")) as unknown;
    };
    expect(same(streamed)).toEqual(same(json));
    expect(String(streamed.sessionRef)).toMatch(/^sr1\./);
  });

  it("T-AGT-11 the form follows the Accept header: the event stream only when it is asked for, JSON otherwise", async () => {
    const a = await hosted({ model: mockModel(async () => text("ok")) });
    const jwt = await a.token("alice");
    const typeOf = async (accept?: string) => {
      const res = await post(a, jwt, { goal: "hi" }, accept);
      await res.text(); // the run ends before the next one starts
      return res.headers.get("content-type")!.split(";")[0];
    };
    for (const accept of [STREAM, "text/event-stream, application/json", "application/json, Text/Event-Stream;q=0.5"]) expect(await typeOf(accept), accept).toBe("text/event-stream");
    for (const accept of [undefined, "application/json", "*/*", "text/*", "text/event-streams", "application/json;profile=text/event-stream"]) {
      expect(await typeOf(accept), String(accept)).toBe("application/json");
    }
    const json = (await (await post(a, jwt, { goal: "hi" })).json()) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(["error", "finalText", "finishedAt", "runId", "sessionRef", "startedAt", "status", "steps", "stopReason"]);
  });

  it("T-AGT-11 a request refused before the run starts gets the same status and JSON error as without a stream", async () => {
    const model = mockModel();
    const ports = fakePorts();
    const a = await hosted({ model, ...ports });
    const jwt = await a.token("alice");
    const other = String(((await (await post(a, await a.token("bob"), { goal: "hi" })).json()) as { sessionRef: string }).sessionRef);
    const before = modelCalls(model).length;
    const cases: Array<[string, string | null, unknown, number]> = [
      ["no token", null, { goal: "hi" }, 401],
      ["no role", await a.token("alice", { permissions: [] }), { goal: "hi" }, 403],
      ["an empty goal", jwt, { goal: "" }, 400],
      ["an unknown field", jwt, { goal: "hi", stream: true }, 400],
      ["a body that is not JSON", jwt, "{ not json", 400],
      ["a body over 16 KB", jwt, { goal: "x".repeat(17 * 1024) }, 413],
      ["a malformed session reference", jwt, { goal: "hi", sessionRef: "sess_0123456789abcdef" }, 400],
      ["another requester's session", jwt, { goal: "hi", sessionRef: other }, 404],
    ];
    for (const [name, token, body, status] of cases) {
      const streamed = await post(a, token, body, STREAM);
      const plain = await post(a, token, body);
      expect([streamed.status, plain.status], name).toEqual([status, status]);
      expect(streamed.headers.get("content-type"), name).toMatch(/^application\/json/);
      expect(await streamed.json(), name).toEqual(await plain.json());
    }
    expect(modelCalls(model).length).toBe(before);
  });

  it("T-AGT-11 the limits apply to a stream: a third concurrent run is 429 in JSON, with Retry-After", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const a = await hosted({
      model: mockModel(async () => {
        await gate;
        return text("ok");
      }),
    });
    const jwt = await a.token("alice");
    const running = [post(a, jwt, { goal: "one" }, STREAM), post(a, jwt, { goal: "two" }, STREAM)];
    // Both streams have started: their `run` events are out before the model answers.
    const first = await running[0]!;
    expect(first.headers.get("content-type")).toMatch(/^text\/event-stream/);
    await running[1]!;
    const third = await post(a, jwt, { goal: "three" }, STREAM);
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("5");
    expect(await third.json()).toEqual({ error: "too many runs" });
    release();
    expect(parse(await first.text()).events.at(-1)!.data.status).toBe("completed");
  });

  it("T-AGT-11 a quiet period gets keep-alive comment lines, and they are not events", async () => {
    const a = await hosted({
      keepAliveMs: 30,
      model: mockModel(async () => {
        await new Promise((r) => setTimeout(r, 200));
        return text("ok");
      }),
    });
    const body = await (await post(a, await a.token("alice"), { goal: "wait" }, STREAM)).text();
    const { events, comments } = parse(body);
    expect(comments.length).toBeGreaterThanOrEqual(2);
    expect(new Set(comments)).toEqual(new Set([": keep-alive"]));
    expect(kinds(events)).toEqual(["run", "text", "result"]);
    // By default the period is 15 s: a short run gets none.
    const quick = await hosted({ model: mockModel(async () => text("ok")) });
    expect(parse(await (await post(quick, await quick.token("alice"), { goal: "hi" }, STREAM)).text()).comments).toEqual([]);
  });
});

describe("T-AGT-12 a stream ends the way a JSON answer would (016 FR-036..FR-038)", () => {
  it("T-AGT-12 the deadline: the last event is a result with stopped and deadline, and a fetch in progress completes and is listed", async () => {
    const s = await seller(400);
    const model = mockModel([toolCall("fetch_resource", { url: `${s}/api/slow`, purpose: "slow" }), text("never reached")]);
    const a = await hosted({ model, deadlineMs: 150, env: { SELLER_URL: s } });
    const { events } = parse(await (await post(a, await a.token("alice"), { goal: "slow" }, STREAM)).text());
    expect(kinds(events)).toEqual(["run", "step", "result"]);
    expect(events.at(-1)!.data).toMatchObject({ status: "stopped", stopReason: "deadline", error: null });
    expect(events[1]!.data).toMatchObject({ index: 1, tool: "fetch_resource", result: { outcome: "FREE", body: { slow: true } } });
    expect(modelCalls(model)).toHaveLength(1);
  });

  it("T-AGT-12 a model failure: the last event is a result with failed and the error, after the steps finished before it", async () => {
    const s = await seller();
    let n = 0;
    const model = mockModel(async () => {
      if (n++ === 0) return toolCall("fetch_resource", { url: `${s}/api/catalog`, purpose: "read the catalog" });
      throw new Error("model unavailable");
    });
    const a = await hosted({ model, env: { SELLER_URL: s } });
    const res = await post(a, await a.token("alice"), { goal: "read the catalog" }, STREAM);
    expect(res.status).toBe(200); // the stream had started; the failure is in the result
    const { events } = parse(await res.text());
    expect(kinds(events)).toEqual(["run", "step", "result"]);
    const result = events.at(-1)!.data;
    expect(result).toMatchObject({ status: "failed", stopReason: null, finalText: "" });
    expect(String(result.error)).toContain("model unavailable");
    expect(result.steps).toHaveLength(1);
  });

  it("T-AGT-12 the step limit: ten step events, then a result with stopped and step_limit", async () => {
    const a = await hosted({ model: mockModel(async () => toolCall("check_budget", {})) });
    const { events } = parse(await (await post(a, await a.token("alice"), { goal: "loop" }, STREAM)).text());
    expect(kinds(events)).toEqual(["run", ...Array.from({ length: 10 }, () => "step"), "result"]);
    expect(events.at(-1)!.data).toMatchObject({ status: "stopped", stopReason: "step_limit" });
  });

  it("T-AGT-12 a caller that disconnects: the run stops before its next step, the fetch in progress completes, and the run log says client_disconnected", async () => {
    const s = await seller(300);
    const logs: string[] = [];
    const model = mockModel([toolCall("fetch_resource", { url: `${s}/api/slow`, purpose: "slow" }), text("never reached")]);
    const a = await hosted({ model, env: { SELLER_URL: s }, log: (line) => logs.push(line) });
    const gone = new AbortController();
    const res = await post(a, await a.token("alice"), { goal: "slow" }, STREAM, gone.signal);
    // The `run` event arrived; the caller leaves while the fetch is in progress.
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toMatch(/^event: run\n/);
    await vi.waitFor(() => expect(slowHits).toBe(1));
    gone.abort();
    await reader.cancel().catch(() => {});
    await vi.waitFor(() => expect(logs.some((l) => l.includes('"stopReason":"client_disconnected"'))).toBe(true), { timeout: 3_000 });
    const run = logs.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.stopReason === "client_disconnected")!;
    expect(run).toMatchObject({ status: "stopped", steps: 1 });
    expect(logs.some((l) => l.includes('"tool":"fetch_resource"'))).toBe(true);
    expect(modelCalls(model)).toHaveLength(1);
  });

  it("T-AGT-12 the stream carries nothing a JSON answer does not: no token, no tool input beyond url and purpose, no other event", async () => {
    const s = await seller();
    const ports = fakePorts();
    const a = await hosted({ model: script(s)(), ...ports, env: { SELLER_URL: s } });
    const jwt = await a.token("alice");
    const body = await (await post(a, jwt, { goal: "what is in the catalog?" }, STREAM)).text();
    expect(body).not.toContain(jwt);
    for (const part of jwt.split(".")) expect(body.includes(part)).toBe(false);
    expect(body).not.toMatch(/x-caller-authorization|"authorization"|bearer|reasoning|toolCallId|call_\d/i);
    const { events } = parse(body);
    for (const e of events.filter((x) => x.event === "step")) {
      expect(Object.keys(e.data).filter((k) => !["index", "tool", "url", "purpose", "result"].includes(k))).toEqual([]);
    }
    // The token did go where it must: to L2, on the budget call of that run.
    expect(ports.gateCalls.map((c) => c.callerToken)).toEqual([jwt]);
  });
});
