// What every screen needs: the API, the sign-in, navigation and the signed-in person. Passed through React context so
// tests can supply fakes.
import { createContext, useContext } from "react";
import type { Api } from "./api.js";
import type { Auth } from "./auth/types.js";
import type { Config, Me } from "./types.js";

export interface AppContext {
  api: Api;
  auth: Auth;
  config: Config;
  me: Me;
  /** Replaces the signed-in person's state after a change (a saved profile, a disabled account...). */
  setMe(me: Me): void;
  navigate(path: string): void;
  /** Asks the person to confirm their identity. In dev mode it prompts for a fresh token. */
  confirmIdentity(): Promise<boolean>;
}

const Ctx = createContext<AppContext | null>(null);
export const AppProvider = Ctx.Provider;

export function useApp(): AppContext {
  const c = useContext(Ctx);
  if (c === null) throw new Error("useApp outside AppProvider");
  return c;
}

/** Whether the person may create or change anything. Every create and change control reads this one value (FR-038). */
export function useAccount(): { enabled: boolean; locked: boolean } {
  const { me } = useApp();
  return { enabled: me.enabled, locked: !me.enabled };
}
