// 1.19 the person's token for the length of one portal request (SPEC.md §8.2 L2-8, §11 SEC-35; Phase 3 finding #5).
// L2 no longer takes the person on the portal's word: the portal forwards the person's own access token, unchanged,
// beside its role token, and L2 verifies it itself. The access check (access.ts) verifies the token, takes it off
// the request, and runs the rest of the request inside this context; the two clients of L2 read it from here and
// put it in one header. Nothing else reads it: no route, no log line, no response, no store. Rule A17 keeps the
// header's name in this file and in src/layer2-control/person.ts.
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<string>();

/** Runs `fn`, and everything it starts, with the person's token at hand for the clients of L2. */
export function withPersonToken<T>(token: string, fn: () => T): T {
  return store.run(token, fn);
}

/** The header L2 reads the person's token from, for the current request; empty outside one. */
export function personHeader(): Record<string, string> {
  const token = store.getStore();
  return token === undefined ? {} : { "x-person-authorization": `Bearer ${token}` };
}
