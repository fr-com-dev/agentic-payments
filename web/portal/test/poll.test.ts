// @vitest-environment jsdom
// 014 poll: the visibility-aware interval behind the administration area's lists (specs/014 research R10).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPolling, type PollDocument } from "../src/poll.js";

function fakeDocument(state = "visible") {
  const listeners = new Set<() => void>();
  const doc: PollDocument & { set(next: string): void; listeners: Set<() => void> } = {
    visibilityState: state,
    addEventListener: (_type, l) => void listeners.add(l),
    removeEventListener: (_type, l) => void listeners.delete(l),
    set(next) {
      doc.visibilityState = next;
      for (const l of listeners) l();
    },
    listeners,
  };
  return doc;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("014 poll", () => {
  it("014 poll runs at once, then every interval, counted from the end of each run", async () => {
    const doc = fakeDocument();
    const fn = vi.fn(async () => undefined);
    const stop = startPolling(fn, 3000, doc);
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(9000);
    expect(fn).toHaveBeenCalledTimes(5);
    stop();
  });

  it("014 poll asks nothing while the tab is hidden, and catches up as soon as it is visible again", async () => {
    const doc = fakeDocument();
    const fn = vi.fn(async () => undefined);
    const stop = startPolling(fn, 3000, doc);
    await vi.advanceTimersByTimeAsync(0);
    doc.set("hidden");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fn).toHaveBeenCalledTimes(1);
    doc.set("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fn).toHaveBeenCalledTimes(3);
    stop();
  });

  it("014 poll never starts hidden, and never overlaps two runs", async () => {
    const hidden = fakeDocument("hidden");
    const idle = vi.fn(async () => undefined);
    const stopIdle = startPolling(idle, 1000, hidden);
    await vi.advanceTimersByTimeAsync(5000);
    expect(idle).not.toHaveBeenCalled();
    stopIdle();

    const doc = fakeDocument();
    let release: () => void = () => undefined;
    const slow = vi.fn(() => new Promise<void>((r) => (release = r)));
    const stop = startPolling(slow, 1000, doc);
    await vi.advanceTimersByTimeAsync(10_000);
    doc.set("visible"); // a visibility event while one run is in flight starts no second one
    await vi.advanceTimersByTimeAsync(0);
    expect(slow).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(slow).toHaveBeenCalledTimes(2);
    stop();
  });

  it("014 poll keeps going after a failed run, and stops for good when asked", async () => {
    const doc = fakeDocument();
    const fn = vi.fn(async () => {
      throw new Error("the portal could not be reached");
    });
    const stop = startPolling(fn, 1000, doc);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fn).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    doc.set("visible");
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(doc.listeners.size).toBe(0);
  });
});
