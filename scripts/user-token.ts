// `npm run -s user-token` (specs/013 research R19; contracts/portal-api.md "Hosted agent delta"). A person's access
// token for the hosted agent service, from a terminal: the device authorization flow (RFC 8628) of the sign-in
// tenant's native client. It replaces `az account get-access-token` for people.
//
//   TOKEN=$(npm run -s user-token)
//
// The address to open and the code to confirm go to stderr; stdout carries the access token and a newline, nothing
// else. THE OUTPUT IS A CREDENTIAL: it starts runs that spend the person's funds until it expires. Don't put it in a
// file, a log or a chat.
//
// Settings: AUTH_ISSUER (https://<domain>/), AUTH_AUDIENCE (the API's identifier) and AGENT_CLI_CLIENT_ID (the
// tenant's native client; public, no secret), from the environment or from env/l1-hosted.env (ENV_FILE picks another
// file). Only these three names are read from the file. Exit codes: 0 printed; 1 not signed in (refused, expired, or
// the tenant can't be reached); 2 a setting is missing or wrong.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PERSON_ISSUER_RE } from "../src/shared/identity-token.js";
import { parseEnvFile, ROOT } from "./demo-lib.js";

export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_INTERVAL_SEC = 5;
const MAX_WAIT_SEC = 900;
const SETTINGS = ["AUTH_ISSUER", "AUTH_AUDIENCE", "AGENT_CLI_CLIENT_ID"] as const;

export interface DeviceFlowOptions {
  /** The tenant's issuer, `https://<domain>/`. */
  issuer: string;
  audience: string;
  clientId: string;
  /** Where the address and the code are shown. */
  say: (line: string) => void;
  /** Test deps: the tenant's base address instead of the issuer, the wait between polls, and the clock. */
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

export type DeviceFlowResult = { ok: true; accessToken: string } | { ok: false; reason: string };

/** A short code from the tenant's answer, never its free text (which can hold an address or an identifier). */
const codeOf = (body: unknown): string => {
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === "string" && /^[a-z0-9_]{1,60}$/i.test(error) ? error : "unexpected_answer";
};

async function post(fetchImpl: typeof fetch, url: string, form: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const body: unknown = await res.json().catch(() => null);
  return { status: res.status, body };
}

/**
 * Asks the tenant for a device code, shows the person where to confirm it, then polls until they did, refused, or
 * the code expired. No client secret is involved: the native client is public.
 */
export async function deviceFlow(o: DeviceFlowOptions): Promise<DeviceFlowResult> {
  const base = o.baseUrl ?? o.issuer;
  const fetchImpl = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let started: { status: number; body: unknown };
  try {
    started = await post(fetchImpl, new URL("oauth/device/code", base).href, { client_id: o.clientId, audience: o.audience });
  } catch {
    return { ok: false, reason: "the sign-in service can't be reached" };
  }
  const d = started.body as { device_code?: unknown; user_code?: unknown; verification_uri?: unknown; verification_uri_complete?: unknown; expires_in?: unknown; interval?: unknown } | null;
  if (started.status !== 200 || d === null || typeof d.device_code !== "string" || typeof d.user_code !== "string" || typeof d.verification_uri !== "string") {
    return { ok: false, reason: `the sign-in service refused to start (${codeOf(started.body)})` };
  }
  // The address comes from the tenant: it must be the tenant's own, over https, or it is not shown.
  const expected = new URL(o.issuer).origin;
  const link = typeof d.verification_uri_complete === "string" ? d.verification_uri_complete : d.verification_uri;
  if ([d.verification_uri, link].some((u) => !URL.canParse(u) || new URL(u).origin !== expected)) {
    return { ok: false, reason: "the sign-in service gave an address that is not its own" };
  }
  o.say(`Open ${link}`);
  o.say(`and confirm the code ${d.user_code}`);

  let intervalSec = typeof d.interval === "number" && d.interval > 0 ? d.interval : DEFAULT_INTERVAL_SEC;
  const lifetimeSec = Math.min(typeof d.expires_in === "number" && d.expires_in > 0 ? d.expires_in : MAX_WAIT_SEC, MAX_WAIT_SEC);
  for (let waitedSec = 0; waitedSec < lifetimeSec; ) {
    await sleep(intervalSec * 1000);
    waitedSec += intervalSec;
    let polled: { status: number; body: unknown };
    try {
      polled = await post(fetchImpl, new URL("oauth/token", base).href, { grant_type: DEVICE_GRANT, device_code: d.device_code, client_id: o.clientId });
    } catch {
      continue; // a dropped connection: the next poll tries again, until the code expires
    }
    const token = (polled.body as { access_token?: unknown } | null)?.access_token;
    if (polled.status === 200 && typeof token === "string" && token.length > 0) return { ok: true, accessToken: token };
    const code = codeOf(polled.body);
    if (code === "authorization_pending") continue;
    if (code === "slow_down") {
      intervalSec += 5;
      continue;
    }
    if (code === "access_denied") return { ok: false, reason: "the sign-in was refused (access_denied)" };
    if (code === "expired_token") return { ok: false, reason: "the code expired before it was confirmed (expired_token)" };
    return { ok: false, reason: `the sign-in did not complete (${code})` };
  }
  return { ok: false, reason: "the code expired before it was confirmed" };
}

/** The three settings: the environment first, then the env file. Nothing else is read from the file. */
export function settingsFrom(env: NodeJS.ProcessEnv, file: Record<string, string>): { issuer: string; audience: string; clientId: string } | { error: string } {
  const get = (name: (typeof SETTINGS)[number]) => env[name] || file[name] || "";
  const [issuer, audience, clientId] = SETTINGS.map(get) as [string, string, string];
  for (const [i, name] of SETTINGS.entries()) if ([issuer, audience, clientId][i] === "") return { error: `${name} is required (env/l1-hosted.env, or the environment)` };
  if (!PERSON_ISSUER_RE.test(issuer)) {
    return { error: "AUTH_ISSUER must be the sign-in tenant's issuer, https://<domain>/ (the local dev issuer has no device flow: use `npm run dev-token`)" };
  }
  if (!/^[A-Za-z0-9._~-]{1,128}$/.test(clientId)) return { error: "AGENT_CLI_CLIENT_ID must be the native client's ID" };
  return { issuer, audience, clientId };
}

async function main(): Promise<number> {
  const path = resolve(ROOT, process.env.ENV_FILE ?? "env/l1-hosted.env");
  const settings = settingsFrom(process.env, existsSync(path) ? parseEnvFile(path) : {});
  if ("error" in settings) {
    console.error(`user-token: ${settings.error}`);
    return 2;
  }
  const result = await deviceFlow({ ...settings, say: (line) => console.error(line) });
  if (!result.ok) {
    console.error(`user-token: ${result.reason}`);
    return 1;
  }
  process.stdout.write(result.accessToken + "\n");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    () => {
      console.error("user-token: failed");
      process.exit(1);
    },
  );
}
