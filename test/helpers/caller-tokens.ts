// 016: callers' tokens for tests. One in-memory issuer signs the two kinds of token the sign-in tenant issues, a
// person's and a machine caller's, in the shape `scripts/dev-issuer-lib.ts` gives them (the local dev issuer does
// the same from a key file). `deps` is what L2 takes as `caller` and what the hosted agent takes as its keys and
// settings, so both verify these tokens with the real check and no test-only shortcut. No file is written and no
// environment variable is read.
//
// People are known by their `sub`. A test that names a person by user identifier (`usr_…`) registers the `sub`
// first (`register`); the dev names the suites use (`alice`, `bob`, …) are registered up front for an issuer with
// the dev issuer's name.
import { createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { DEV_AGENT_CLIENT, DEV_AUDIENCE, DEV_DESKTOP_CLIENT, DEV_MACHINE_CLIENT, devSubject, signDevToken, type DevTokenOptions } from "../../scripts/dev-issuer-lib.js";
import { DEV_ISSUER, type TokenKeys } from "../../src/shared/identity-token.js";
import { userIdFor } from "../../src/shared/user-id.js";

/** The dev names the suites use; `devUserId(name)` is their user identifier under the dev issuer. */
const DEV_NAMES = ["alice", "bob", "carol", "dana", "dave", "erin", "eve", "frank", "nobody", "dev-user"] as const;

export type PersonTokenOptions = Omit<DevTokenOptions, "subject" | "service" | "sub" | "issuer" | "audience">;
export type MachineTokenOptions = Omit<DevTokenOptions, "subject" | "service" | "issuer" | "audience">;

export interface TestIssuer {
  issuer: string;
  audience: string;
  /** The settings and keys a service verifies these tokens with (L2's `caller`, the hosted agent's auth). */
  deps: { issuer: string; audience: string; clientIds: string[] } & TokenKeys;
  /** A person's token: `sub` as given (the whole subject), `agent:run`, from the agent's client, one hour. */
  person(sub: string, o?: PersonTokenOptions): Promise<string>;
  /** A machine caller's token: client credentials for `client`, `agent:run` in `scope`, one hour. */
  machine(o?: MachineTokenOptions & { client?: string }): Promise<string>;
  /** Makes `sub` known and returns the user identifier both layers compute for it. */
  register(sub: string): string;
  /** The `sub` of a registered user identifier, or undefined. */
  subjectOf(userId: string): string | undefined;
  /** A person's token for a registered user identifier. Throws for one that was never registered. */
  forUser(userId: string, o?: PersonTokenOptions): Promise<string>;
}

export async function createTestIssuer(o: { issuer?: string; audience?: string; clientIds?: string[] } = {}): Promise<TestIssuer> {
  const issuer = o.issuer ?? DEV_ISSUER;
  const audience = o.audience ?? DEV_AUDIENCE;
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  // The key ID and algorithm `signDevToken` writes in the header.
  const jwk = { ...(await exportJWK(publicKey)), kid: "x402-dev-1", alg: "ES256", use: "sig" };
  const keys: TokenKeys = { keys: createLocalJWKSet({ keys: [jwk] }), algorithms: ["ES256"] };
  const subjects = new Map<string, string>();
  const register = (sub: string): string => {
    const userId = userIdFor(issuer, sub);
    subjects.set(userId, sub);
    return userId;
  };
  if (issuer === DEV_ISSUER) for (const name of DEV_NAMES) register(devSubject(name));
  const person: TestIssuer["person"] = (sub, po = {}) => signDevToken({ privateKey }, { subject: sub, sub, issuer, audience, ...po });
  return {
    issuer,
    audience,
    // 019: a person signs in through the agent's docs page client or the desktop client; L2 accepts both.
    deps: { issuer, audience, clientIds: o.clientIds ?? [DEV_AGENT_CLIENT, DEV_DESKTOP_CLIENT], ...keys },
    person,
    machine: ({ client, ...mo } = {}) => signDevToken({ privateKey }, { subject: client ?? DEV_MACHINE_CLIENT, service: true, issuer, audience, ...mo }),
    register,
    subjectOf: (userId) => subjects.get(userId),
    forUser: (userId, po) => {
      const sub = subjects.get(userId);
      if (sub === undefined) throw new Error(`caller-tokens: ${userId} is not a registered person; call register(<sub>) first`);
      return person(sub, po);
    },
  };
}

/** The `X-Caller-Authorization` header for a token (the name is L1's and L2's; tests spell it out here once). */
export const callerHeader = (token: string): Record<string, string> => ({ "x-caller-authorization": `Bearer ${token}` });
