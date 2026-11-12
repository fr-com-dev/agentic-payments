// 014 polling for the administration area (specs/014 research R10). One function: run `fn` now and then every
// `everyMs`, but only while the tab is visible; catch up at once when it becomes visible again; never run two at the
// same time; stop when asked. No timer runs in a hidden tab, so an administrator's forgotten tab asks nothing.
export interface PollDocument {
  visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export function startPolling(fn: () => void | Promise<void>, everyMs: number, doc: PollDocument = document): () => void {
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const visible = () => doc.visibilityState === "visible";
  const schedule = () => {
    if (stopped || !visible()) return;
    timer = setTimeout(() => void tick(), everyMs);
  };
  const tick = async (): Promise<void> => {
    if (stopped || running || !visible()) return;
    running = true;
    try {
      await fn();
    } catch {
      // The caller shows its own failures; a failed run must not end the polling.
    } finally {
      running = false;
      schedule();
    }
  };
  const onVisibility = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (visible()) void tick();
  };

  doc.addEventListener("visibilitychange", onVisibility);
  void tick();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    doc.removeEventListener("visibilitychange", onVisibility);
  };
}
