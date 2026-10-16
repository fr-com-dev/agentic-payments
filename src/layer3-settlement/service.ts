// L3 Settlement HTTP service (SPEC.md §8.3 L3-2). Owner: feature 005.
// POST /v1/settlements (VERIFIER_TOKEN only) verifies a claim against the chain, pushes every report to
// L2 /v1/reconcile (SETTLEMENT_TOKEN, 5 s timeout, best effort) and re-checks PENDING reports in the
// background. INV-4: the only chain access is a read-only public client.
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import express, { type ErrorRequestHandler, type Express } from "express";
import { createPublicClient, http } from "viem";
import { requireRole } from "../shared/auth.js";
import {
  loadEnv,
  networkProfile,
  serviceUrls,
  SETTLEMENT_BIND_HOST,
  settlementPort,
  tokenFor,
  type NetworkProfile,
} from "../shared/config.js";
import type {
  ReconciliationPort,
  SettlementClaim,
  SettlementReport,
  SettlementVerifierPort,
} from "../shared/contracts.js";
import { ChainSettlementVerifier, type ReadOnlyChainClient } from "./verifier.js";

export const DEFAULT_RECHECK_ATTEMPTS = 5;
export const DEFAULT_RECHECK_INTERVAL_MS = 30_000;
export const RECONCILE_TIMEOUT_MS = 5_000;

/** Read-only chain client (research R1). No account, no key, no write actions. */
export function createReadOnlyClient(net: Pick<NetworkProfile, "rpcUrl">): ReadOnlyChainClient {
  return createPublicClient({ transport: http(net.rpcUrl) }) as unknown as ReadOnlyChainClient;
}

/** HTTP ReconciliationPort: POST {CONTROL_URL}/v1/reconcile with the L3 → L2 token only (INV-13). */
export class HttpReconciler implements ReconciliationPort {
  constructor(
    private readonly controlUrl: string,
    private readonly settlementToken: string,
    private readonly timeoutMs: number = RECONCILE_TIMEOUT_MS,
    private readonly log: (msg: string) => void = console.log,
  ) {}

  async reconcile(report: SettlementReport): Promise<void> {
    const res = await fetch(`${this.controlUrl}/v1/reconcile`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.settlementToken}` },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`reconcile ${report.authorizationId}: HTTP ${res.status}`);
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; anomaly?: boolean };
    this.log(`reconciled ${report.authorizationId} ${report.status} anomaly=${body.anomaly === true}`);
  }
}

export interface SettlementServiceDeps {
  verifier: SettlementVerifierPort;
  reconciler: ReconciliationPort;
  recheckAttempts?: number;
  recheckIntervalMs?: number;
  /** Upper bound on the awaited reconcile push, whatever the reconciler does (default 5 s). */
  reconcileTimeoutMs?: number;
  /** Test hook: the expected VERIFIER_TOKEN instead of resolving it from the environment. */
  token?: string;
  log?: (msg: string) => void;
}

export interface SettlementService {
  app: Express;
  /** authorizationIds with a live re-check schedule. */
  scheduled(): string[];
  /** Cancels every pending re-check. */
  stop(): void;
}

interface Schedule {
  timer: NodeJS.Timeout;
}

function validClaim(body: unknown): body is SettlementClaim {
  if (body === null || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return typeof b.authorizationId === "string" && b.authorizationId.length > 0 && b.requirement !== null && typeof b.requirement === "object";
}

/** Builds the L3 app. It does not listen; `main()` binds it to loopback. */
export function createSettlementService(deps: SettlementServiceDeps): SettlementService {
  const attempts = deps.recheckAttempts ?? DEFAULT_RECHECK_ATTEMPTS;
  const intervalMs = deps.recheckIntervalMs ?? DEFAULT_RECHECK_INTERVAL_MS;
  const reconcileTimeoutMs = deps.reconcileTimeoutMs ?? RECONCILE_TIMEOUT_MS;
  const log = deps.log ?? console.log;
  const schedules = new Map<string, Schedule>();

  /** Best-effort push to L2: awaited, bounded, never fails the caller (SC-005). */
  async function pushReconcile(report: SettlementReport): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${reconcileTimeoutMs} ms`)), reconcileTimeoutMs);
      timer.unref();
    });
    try {
      await Promise.race([deps.reconciler.reconcile(report), timeout]);
    } catch (err) {
      log(`reconcile failed for ${report.authorizationId}: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  function cancel(authorizationId: string): void {
    const s = schedules.get(authorizationId);
    if (s) clearTimeout(s.timer);
    schedules.delete(authorizationId);
  }

  /** Re-checks a PENDING claim up to `attempts` times; a new schedule replaces an old one. */
  function schedule(claim: SettlementClaim, attemptsLeft: number): void {
    cancel(claim.authorizationId);
    if (attemptsLeft <= 0) return;
    const timer = setTimeout(async () => {
      schedules.delete(claim.authorizationId);
      let report: SettlementReport;
      try {
        report = await deps.verifier.verify(claim);
      } catch (err) {
        log(`re-check failed for ${claim.authorizationId}: ${(err as Error).message}`);
        schedule(claim, attemptsLeft - 1);
        return;
      }
      await pushReconcile(report);
      // A newer claim may have replaced this schedule while the re-check ran; it wins.
      if (report.status === "PENDING" && !schedules.has(claim.authorizationId)) schedule(claim, attemptsLeft - 1);
    }, intervalMs);
    timer.unref();
    schedules.set(claim.authorizationId, { timer });
  }

  const app = express();
  app.post(
    "/v1/settlements",
    // 401 precedes 400: the guard runs before the body is parsed or validated.
    requireRole("agent-verifier", deps.token !== undefined ? { token: deps.token } : {}),
    express.json({ limit: "64kb" }),
    async (req, res) => {
      if (!validClaim(req.body)) {
        res.status(400).json({ error: "authorizationId must be a string and requirement an object" });
        return;
      }
      const claim = req.body;
      const report = await deps.verifier.verify(claim);
      await pushReconcile(report);
      if (report.status === "PENDING") schedule(claim, attempts);
      else cancel(claim.authorizationId);
      res.status(200).json(report);
    },
  );
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const status = typeof err?.status === "number" && err.status >= 400 && err.status < 500 ? err.status : 500;
    res.status(status).json({ error: status === 500 ? "internal error" : "malformed request body" });
  };
  app.use(onError);

  return {
    app,
    scheduled: () => [...schedules.keys()],
    stop: () => {
      for (const id of [...schedules.keys()]) cancel(id);
    },
  };
}

/** Binds L3 to loopback only (SPEC §3.1, NFR-001). Overriding the port never changes the host. */
export function listenSettlement(app: Express, port: number = settlementPort(), onListen?: () => void): Server {
  return app.listen(port, SETTLEMENT_BIND_HOST, onListen);
}

/** Entry point (`npm run l3:verifier`). */
export function main(): void {
  loadEnv("l3-verifier");
  const net = networkProfile();
  const verifier = new ChainSettlementVerifier({ publicClient: createReadOnlyClient(net), net });
  const reconciler = new HttpReconciler(serviceUrls().control, tokenFor("verifier-control"));
  const { app } = createSettlementService({ verifier, reconciler, token: tokenFor("agent-verifier") });
  const port = settlementPort();
  const server = listenSettlement(app, port, () => {
    console.log(`l3-verifier listening on http://${SETTLEMENT_BIND_HOST}:${port} (network ${net.name}, rpc ${net.rpcUrl})`);
  });
  server.on("error", (err) => {
    console.error(`l3-verifier: ${err.message}`);
    process.exit(1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(`l3-verifier: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
