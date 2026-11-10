// The step-up prompt (specs/013 FR-007). A sign-in window can only open from a click, so a refused save is parked
// behind a "Confirm it's you" button; one click confirms and sends the same request again, exactly once.
import { useCallback, useState, type ReactNode } from "react";
import type { ApiResult } from "../api.js";
import { needsStepUp, replayAfterStepUp } from "../auth/stepUp.js";
import { useApp } from "../context.js";
import { Banner } from "./ui.js";

export const STEP_UP_TEXT = "Confirm it's you to make this change.";
export const STEP_UP_FAILED_TEXT = "Your identity was not confirmed. Nothing was changed.";

export interface StepUp {
  /** Sends `call`. If it is refused for an old sign-in, parks it; otherwise hands the answer to `done`. */
  run<T>(call: () => Promise<ApiResult<T>>, done: (result: ApiResult<T>) => void): Promise<void>;
  /** The prompt to render near the control, or null. */
  prompt: ReactNode;
}

export function useStepUp(): StepUp {
  const { confirmIdentity } = useApp();
  const [parked, setParked] = useState<{ replay(): Promise<void> } | null>(null);
  const [failed, setFailed] = useState(false);
  const run = useCallback(
    async <T,>(call: () => Promise<ApiResult<T>>, done: (result: ApiResult<T>) => void): Promise<void> => {
      setFailed(false);
      setParked(null);
      const first = await call();
      if (!needsStepUp(first)) {
        done(first);
        return;
      }
      setParked({
        replay: async () => {
          setParked(null);
          const again = await replayAfterStepUp(confirmIdentity, call);
          // Refused a second time, or not confirmed: say so. Never a second automatic retry.
          if (again === null || needsStepUp(again)) setFailed(true);
          else done(again);
        },
      });
    },
    [confirmIdentity],
  );
  const prompt = parked ? (
    <Banner kind="warning">
      {STEP_UP_TEXT}{" "}
      <button type="button" onClick={() => void parked.replay()}>
        Confirm it's you
      </button>
    </Banner>
  ) : failed ? (
    <Banner kind="error">{STEP_UP_FAILED_TEXT}</Banner>
  ) : null;
  return { run, prompt };
}
