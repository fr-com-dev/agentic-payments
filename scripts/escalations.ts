// Operator watch CLI (SPEC.md §13, L2-5, L2-4.3): `npm run escalations [-- --watch]`. Owner: feature 010.
// Reads only CONTROL_URL and OPERATOR_TOKEN (env/operator.env). List mode prints the pending escalations
// and exits 0 (1 on an HTTP or network error). Watch mode prints the list, then polls the events feed
// every second from a ledger cursor, so it resumes exactly after an L2 restart; SIGINT/SIGTERM exit 0.
// 012 (L2-7): also prints the reference code, the approval request's state and events, and who decided, by which
// channel. Every field comes from L2's whitelisted views; none can hold a token, a handle or Auth0 text.
import { pathToFileURL } from "node:url";
import { loadEnv, serviceUrls, tokenFor } from "../src/shared/config.js";

const POLL_MS = 1000;

interface View {
  authorizationId: string;
  sessionId: string;
  resourceKey: string;
  payTo: string;
  amount: string;
  expiresAt: string;
  referenceCode?: string;
  approvalRequest?: string;
}

interface Event {
  kind: string;
  authorizationId: string;
  sessionId: string;
  resourceKey: string;
  amount: string;
  expiresAt?: string;
  approvalId?: string;
  approver?: string;
  approvalExpiresAt?: string;
  rejectionId?: string;
  operator?: string;
  reason?: string;
  referenceCode?: string;
  approvalRequest?: string;
  channel?: string;
  decidedBy?: string;
  requestId?: string;
  requestExpiresAt?: string;
  failure?: string;
  error?: string;
  cause?: string;
  check?: string;
}

/** `key=value` for each present field, in order. */
const fields = (o: object, keys: readonly string[]) =>
  keys.flatMap((k) => {
    const v = (o as Record<string, unknown>)[k];
    return v === undefined ? [] : [`${k}=${String(v)}`];
  });

export function formatPending(v: View): string {
  const head = `PENDING ${v.authorizationId} session=${v.sessionId} resource=${v.resourceKey} payTo=${v.payTo} amount=${v.amount} expiresAt=${v.expiresAt}`;
  return [head, ...fields(v, ["referenceCode", "approvalRequest"])].join(" ");
}

export function formatEvent(e: Event): string {
  const extra: string[] = [];
  if (e.kind === "escalated" || e.kind === "expired") extra.push(`expiresAt=${e.expiresAt}`);
  if (e.kind === "escalated") extra.push(...fields(e, ["referenceCode", "approvalRequest"]));
  if (e.kind === "approved") extra.push(`approvalId=${e.approvalId}`, `approver=${e.approver}`, `approvalExpiresAt=${e.approvalExpiresAt}`);
  if (e.kind === "denied") {
    extra.push(`rejectionId=${e.rejectionId}`);
    if (e.operator !== undefined) extra.push(`operator=${e.operator}`);
    if (e.reason !== undefined) extra.push(`reason=${JSON.stringify(e.reason)}`);
  }
  if (e.kind === "approved" || e.kind === "denied") extra.push(...fields(e, ["channel", "decidedBy"]));
  if (e.kind === "approval_lapsed") extra.push(`approvalId=${e.approvalId}`);
  if (e.kind === "approval_requested") extra.push(...fields(e, ["requestId", "referenceCode", "requestExpiresAt"]));
  if (e.kind === "approval_request_failed") extra.push(...fields(e, ["requestId", "failure", "error"]));
  if (e.kind === "approval_request_lapsed") extra.push(...fields(e, ["requestId", "cause"]));
  if (e.kind === "approval_verification_failed") extra.push(...fields(e, ["requestId", "check"]));
  return [`${e.kind.toUpperCase()} ${e.authorizationId} session=${e.sessionId} resource=${e.resourceKey} amount=${e.amount}`, ...extra].join(" ");
}

async function getJson<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`HTTP ${res.status} ${text}`);
  return JSON.parse(text) as T;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function escalations(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const watch = argv.includes("--watch");
  const control = serviceUrls(env).control;
  const token = tokenFor("operator", env);

  let cursor: number;
  try {
    const { pending, cursor: c } = await getJson<{ pending: View[]; cursor: number }>(`${control}/v1/escalations`, token);
    console.log(pending.length === 0 ? "no pending escalations" : pending.map(formatPending).join("\n"));
    cursor = c;
  } catch (err) {
    console.error(`escalations: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (!watch) return 0;

  let failing = false;
  for (;;) {
    await sleep(POLL_MS);
    try {
      const { events, cursor: c } = await getJson<{ events: Event[]; cursor: number }>(
        `${control}/v1/escalations/events?after=${cursor}`,
        token,
      );
      for (const e of events) console.log(formatEvent(e));
      cursor = c;
      failing = false;
    } catch (err) {
      if (!failing) console.error(`escalations: ${err instanceof Error ? err.message : String(err)} (retrying)`);
      failing = true;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(0));
  try {
    loadEnv("operator");
    process.exitCode = await escalations(process.argv.slice(2));
  } catch (err) {
    console.error(`escalations: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
