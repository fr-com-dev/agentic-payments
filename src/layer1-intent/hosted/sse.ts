// L1-6 the run stream (SPEC.md §8.1 L1-6; specs/016 contracts/hosted-agent-api.md "The stream"). Server-sent events
// over the response of POST /v1/runs, for a caller that asks for them with `Accept: text/event-stream`: the run's
// identifier first, the agent's text as it is written, one event per finished tool step, and a last event with the
// same result object a JSON answer carries. The stream is one-way and keeps no state: it carries nothing the JSON
// answer does not (no token, no model reasoning, no tool input beyond a step's url and purpose).
import type { Request, Response } from "express";

/** Silence longer than this gets a comment line, so no intermediary closes an idle connection (the ingress's limit is 240 s). */
export const KEEP_ALIVE_MS = 15_000;

/** The four events, in the order a stream sends them: `run` once, `text` and `step` as they happen, `result` last. */
export type RunEvent = "run" | "text" | "step" | "result";

/** Whether the request asks for the event-stream form. Anything else gets the JSON answer. */
export function wantsStream(req: Pick<Request, "headers">): boolean {
  const accept = req.headers.accept;
  if (typeof accept !== "string") return false;
  return accept.split(",").some((part) => part.split(";")[0]!.trim().toLowerCase() === "text/event-stream");
}

export interface EventStream {
  /** One event: its name and one line of JSON. A stream that has ended, or whose caller has gone, drops it. */
  send(event: RunEvent, data: unknown): void;
  /** Ends the response. Nothing follows the last event. */
  end(): void;
}

/** Starts the stream: the headers go out at once, so the caller knows the run was accepted. */
export function openEventStream(res: Response, o: { keepAliveMs?: number } = {}): EventStream {
  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    // No intermediary may cache, compress or buffer the events.
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  const open = () => !res.writableEnded && !res.destroyed;
  let lastWriteMs = Date.now();
  const write = (chunk: string) => {
    if (!open()) return;
    res.write(chunk);
    lastWriteMs = Date.now();
  };
  const every = o.keepAliveMs ?? KEEP_ALIVE_MS;
  const timer = setInterval(
    () => {
      if (Date.now() - lastWriteMs >= every) write(": keep-alive\n\n");
    },
    Math.max(10, Math.floor(every / 3)),
  );
  timer.unref();
  res.on("close", () => clearInterval(timer));
  return {
    // JSON.stringify never emits a raw line break, so the data is always one line.
    send: (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    end: () => {
      clearInterval(timer);
      if (open()) res.end();
    },
  };
}
