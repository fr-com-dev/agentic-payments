// "Confirm it's you" (specs/013 FR-007; contracts/portal-ui.md "Saving"). When a save is refused with
// `step_up_required`, the person confirms their identity and the same request is sent again, once. If it is refused
// again, that answer is shown: there is never a second automatic retry.
import type { ApiResult } from "../api.js";

export const needsStepUp = <T>(r: ApiResult<T>): boolean => !r.ok && r.status === 403 && r.error === "step_up_required";

/** Confirms the person's identity, then replays `call` exactly once. Returns null when they did not confirm. */
export async function replayAfterStepUp<T>(confirm: () => Promise<boolean>, call: () => Promise<ApiResult<T>>): Promise<ApiResult<T> | null> {
  if (!(await confirm())) return null;
  return call();
}
