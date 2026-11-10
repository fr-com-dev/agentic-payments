// 013 stand-in card vault (specs/013 contracts/card-vault.md, research R15): the six calls the portal makes, with
// Stripe-shaped answers, like cdp-stub.ts and ciba-stub.ts. It records every request so tests can assert exactly what
// was sent. Its error messages carry a marker text that must never show up in a log, a response or the ledger.
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export const VAULT_MESSAGE = "VAULT-FREE-TEXT-must-never-be-relayed";

export interface VaultRequest {
  method: string;
  path: string;
  query: Record<string, string[]>;
  headers: Record<string, string>;
  form: Record<string, string>;
}

export interface StubCard {
  brand?: string;
  last4?: string;
  expMonth?: number;
  expYear?: number;
  fingerprint?: string;
}

interface Pm {
  id: string;
  customer: string | null;
  created: number;
  metadata: Record<string, string>;
  card?: { brand: string; last4: string; exp_month: number; exp_year: number; fingerprint: string };
}

type Mode = { kind: "ok" } | { kind: "down" } | { kind: "slow"; ms: number } | { kind: "status"; status: number; times: number } | { kind: "live" };

export interface CardVaultStub {
  baseUrl: string;
  requests: VaultRequest[];
  /** The browser's part: the person confirmed the setup with this card. Returns the saved card's vault ID. */
  confirm(setupIntentId: string, card?: StubCard): string;
  /** The setup succeeded with something that is not a card. */
  confirmNonCard(setupIntentId: string): string;
  /** The vault refused the card during setup. */
  fail(setupIntentId: string, code: string): void;
  /** The setup intent the portal created most recently (from its client secret). */
  lastSetupIntentId(): string;
  setMode(mode: Mode): void;
  /** Cards still attached to a customer, by vault ID. */
  attached(): string[];
  /** A card the vault holds for the user's customer that the portal never labeled (an interrupted add). */
  addUnlabeled(customer: string, card?: StubCard): string;
  customers(): string[];
  /** Detaches directly at the vault, as if removed outside the portal. */
  detachOutside(paymentMethodId: string): void;
  close(): Promise<void>;
}

const NOW_SEC = () => Math.floor(Date.now() / 1000);

export async function startCardVaultStub(): Promise<CardVaultStub> {
  let seq = 0;
  let mode: Mode = { kind: "ok" };
  const requests: VaultRequest[] = [];
  const customers = new Map<string, { metadata: Record<string, string> }>();
  const setups = new Map<string, { customer: string; status: string; payment_method: string | null; error?: string }>();
  const pms = new Map<string, Pm>();
  const live = () => mode.kind === "live";

  const newPm = (customer: string, card: StubCard | null): string => {
    const id = `pm_stub_${++seq}`;
    pms.set(id, {
      id,
      customer,
      created: NOW_SEC(),
      metadata: {},
      ...(card !== null && {
        card: {
          brand: card.brand ?? "visa",
          last4: card.last4 ?? "4242",
          exp_month: card.expMonth ?? 12,
          exp_year: card.expYear ?? 2030,
          fingerprint: card.fingerprint ?? `fp_${card.last4 ?? "4242"}`,
        },
      }),
    });
    return id;
  };
  const pmJson = (pm: Pm) => ({
    id: pm.id,
    object: "payment_method",
    created: pm.created,
    customer: pm.customer,
    livemode: live(),
    metadata: pm.metadata,
    type: pm.card ? "card" : "us_bank_account",
    ...(pm.card && { card: pm.card }),
  });
  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const missing = (res: ServerResponse) => send(res, 404, { error: { code: "resource_missing", message: VAULT_MESSAGE, type: "invalid_request_error" } });

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://stub");
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const form = Object.fromEntries(new URLSearchParams(raw));
    const query: Record<string, string[]> = {};
    for (const [k, v] of url.searchParams) (query[k] ??= []).push(v);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
    requests.push({ method: req.method ?? "", path: url.pathname, query, headers, form });

    if (mode.kind === "down") {
      req.socket.destroy();
      return;
    }
    if (mode.kind === "slow") await new Promise((r) => setTimeout(r, (mode as { ms: number }).ms));
    if (mode.kind === "status") {
      const status = mode.status;
      mode.times -= 1;
      if (mode.times <= 0) mode = { kind: "ok" };
      send(res, status, { error: { code: status === 429 ? "rate_limit" : "api_error", message: VAULT_MESSAGE } });
      return;
    }
    if (headers.authorization === undefined || !/^Bearer (rk|sk)_test_/.test(headers.authorization)) {
      send(res, 401, { error: { code: "api_key_invalid", message: VAULT_MESSAGE } });
      return;
    }
    const metadata = (): Record<string, string> =>
      Object.fromEntries(Object.entries(form).flatMap(([k, v]) => (k.startsWith("metadata[") ? [[k.slice(9, -1), v]] : [])));
    const m = (re: RegExp) => re.exec(url.pathname);
    let hit: RegExpExecArray | null;

    if (req.method === "POST" && url.pathname === "/v1/customers") {
      const id = `cus_stub_${++seq}`;
      customers.set(id, { metadata: metadata() });
      send(res, 200, { id, object: "customer", livemode: live(), metadata: customers.get(id)!.metadata });
    } else if (req.method === "POST" && url.pathname === "/v1/setup_intents") {
      if (!customers.has(form.customer ?? "")) return missing(res);
      const id = `seti_stub_${++seq}`;
      setups.set(id, { customer: form.customer!, status: "requires_payment_method", payment_method: null });
      send(res, 200, { id, object: "setup_intent", client_secret: `${id}_secret_CLIENTSECRET${seq}`, status: "requires_payment_method", customer: form.customer, livemode: live(), payment_method: null });
    } else if (req.method === "GET" && (hit = m(/^\/v1\/setup_intents\/([^/]+)$/))) {
      const s = setups.get(hit[1]!);
      if (!s) return missing(res);
      const pm = s.payment_method === null ? null : pms.get(s.payment_method)!;
      send(res, 200, {
        id: hit[1],
        object: "setup_intent",
        status: s.status,
        customer: s.customer,
        livemode: live(),
        payment_method: pm === null ? null : query["expand[]"]?.includes("payment_method") ? pmJson(pm) : pm.id,
        last_setup_error: s.error === undefined ? null : { code: s.error, decline_code: "generic_decline", message: VAULT_MESSAGE, type: "card_error" },
      });
    } else if (req.method === "GET" && (hit = m(/^\/v1\/customers\/([^/]+)\/payment_methods$/))) {
      if (!customers.has(hit[1]!)) return missing(res);
      const data = [...pms.values()].filter((p) => p.customer === hit![1] && p.card !== undefined).map(pmJson);
      send(res, 200, { object: "list", data, has_more: false, livemode: live() });
    } else if (req.method === "POST" && (hit = m(/^\/v1\/payment_methods\/([^/]+)\/detach$/))) {
      const pm = pms.get(hit[1]!);
      if (!pm) return missing(res);
      pm.customer = null;
      send(res, 200, pmJson(pm));
    } else if (req.method === "POST" && (hit = m(/^\/v1\/payment_methods\/([^/]+)$/))) {
      const pm = pms.get(hit[1]!);
      if (!pm || pm.customer === null) return missing(res);
      Object.assign(pm.metadata, metadata());
      send(res, 200, pmJson(pm));
    } else {
      // Anything else is a call the portal must never make (a charge, a payment intent, a refund...).
      send(res, 400, { error: { code: "unexpected_call", message: VAULT_MESSAGE } });
    }
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => res.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const confirmWith = (setupIntentId: string, card: StubCard | null) => {
    const s = setups.get(setupIntentId);
    if (!s) throw new Error(`stub: unknown setup intent ${setupIntentId}`);
    s.payment_method = newPm(s.customer, card);
    s.status = "succeeded";
    return s.payment_method;
  };

  return {
    baseUrl,
    requests,
    confirm: (id, card = {}) => confirmWith(id, card),
    confirmNonCard: (id) => confirmWith(id, null),
    fail: (id, code) => {
      const s = setups.get(id);
      if (!s) throw new Error(`stub: unknown setup intent ${id}`);
      s.error = code;
      s.status = "requires_payment_method";
    },
    lastSetupIntentId: () => [...setups.keys()].at(-1) ?? "",
    setMode: (next) => {
      mode = next;
    },
    attached: () => [...pms.values()].filter((p) => p.customer !== null).map((p) => p.id),
    addUnlabeled: (customer, card = {}) => newPm(customer, card),
    customers: () => [...customers.keys()],
    detachOutside: (id) => {
      const pm = pms.get(id);
      if (pm) pm.customer = null;
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}
