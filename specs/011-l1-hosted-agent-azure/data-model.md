# Data Model: Cloud-Hosted Purchasing Agent (L1)

The shared cross-layer contracts (`src/shared/contracts.ts`) do not change. Everything below is
local to the agent layer, except the ledger lock (L2) and the deployment matrix (infrastructure).
Field names are the ones the code and the API use.

## Requester (agent layer, from the access token)

| Field | Source | Rule |
|---|---|---|
| `tenantId` | `tid` claim | must equal `AUTH_TENANT_ID` |
| `objectId` | `oid` claim | required; with `tenantId` it forms the requester key `tid:oid` |
| `kind` | `idtyp` claim | `app` → `service`, otherwise `user` |
| `roles` | `roles` claim | must contain `Agent.Run`, otherwise 403 |

Not stored. It lives for one request. The requester key appears in logs; the token never does.

## RunRequest (`POST /v1/runs` body)

| Field | Type | Rule |
|---|---|---|
| `goal` | string | required, 1–4,000 characters after trimming, otherwise 400 |
| `sessionRef` | string | optional. Must match `sr1.<sessionId>.<mac>`; a raw `sess_…` value or a malformed one → 400; valid format but not the caller's → 404 |

Unknown fields → 400. The body limit is 16 KB.

## Run (agent layer, in memory for its duration)

| Field | Type | Notes |
|---|---|---|
| `runId` | string | `run_` + UUID |
| `requesterKey` | string | `tid:oid` |
| `sessionId` | string | `sess_` + 16 hex characters, new or from a verified `sessionRef` |
| `status` | enum | `completed`, `stopped` or `failed` |
| `stopReason` | enum or null | `deadline` (200 s), `step_limit` (10), `client_disconnected`; null when completed |
| `error` | string or null | `failed` only: a short message, never a credential or header |
| `steps` | RunStep[] | in call order |
| `finalText` | string | the model's last text (may be empty when stopped or failed) |
| `startedAt`, `finishedAt` | ISO time | |

State transitions: `running → completed | stopped | failed`. A run is never resumed. Continuing a
session starts a new run.

## RunStep

| Field | Type | Notes |
|---|---|---|
| `index` | integer | 1-based, in call order across model steps |
| `tool` | `fetch_resource` or `check_budget` | |
| `url`, `purpose` | string | `fetch_resource` only, as the model sent them |
| `result` | ToolResultJson, BudgetStatus or `{ error }` | `ToolResultJson` is today's L1-3 tool result (`outcome`, `httpStatus`, `body`, `payment {authorizationId, amountUsd, settlement {status, tx, finality}}`, `violations`, `authorizationId`, `error`) |

The response carries the steps. The logs carry only the IDs and outcomes (research R13).

## SessionReference

`sr1.<sessionId>.<mac>`, where
`mac = base64url(HMAC-SHA256(SESSION_REF_SECRET, "sr1|" + tid + "|" + oid + "|" + sessionId))`.

- It is issued in every run response.
- It is verified in constant time against the caller's `tid`/`oid`.
- It never expires by itself. Rotating `SESSION_REF_SECRET` invalidates every reference.
- A session's budget and approvals remain L2's (L2-4.2); the reference only controls who may use
  the session.

## RunLimiter state (agent layer, in memory, one replica)

| Field | Per requester key |
|---|---|
| `active` | runs in progress; a start is refused with 429 when it would exceed 2 |
| `starts` | start timestamps in the last 3,600 s; a start is refused with 429 when there are already 20 |

`Retry-After` is the seconds until a slot frees: the oldest start ages out, or 5 when the refusal
is for concurrency. The state is lost on restart, which is acceptable (research R8).

## LedgerLock (L2, new SPEC L2-6)

The file `<ledger path>.lock`, created with `O_CREAT|O_EXCL`:

| Field | Type | Notes |
|---|---|---|
| `holder` | string | `l2_` + UUID, new per process |
| `pid`, `host` | number, string | diagnostics only |
| `acquiredAt` | ISO time | |
| `heartbeatAt` | ISO time | refreshed every 5 s with an atomic write then rename |

States, as seen by a starting L2:

```text
start ─► try create ─ ok ─────────────────────────────► HOLDER ─ load + verify ledger ─► serve
             │                                              │
             └ exists ─► heartbeat < 30 s old ─► STANDBY ───┘ (poll 1 s; log once)
                         heartbeat ≥ 30 s old ─► take over (rename stale away, create) ─► HOLDER
HOLDER ─ SIGTERM/SIGINT ─► delete lock ─► exit
```

The lock is not a ledger entry and never touches the hash chain.

## Runtime units (infrastructure, see contracts/cloud-topology.md)

| Unit | Environment | Ingress | Replicas | Identity (lifecycle) | Secrets from its own vault |
|---|---|---|---|---|---|
| `ca-l1-agent` | main | external :4024 | 0–1, multiple revisions | `id-l1` (Main) | `CONTROL_TOKEN`, `VERIFIER_TOKEN`, `SESSION_REF_SECRET`, `ANTHROPIC_API_KEY` (only with `MODEL_PROVIDER=anthropic`) |
| `ca-l2-control` | main | internal :8080 → 127.0.0.1:4020 | exactly 1 | `id-l2` (None) | `PAYER_PRIVATE_KEY`, `CONTROL_TOKEN`, `SETTLEMENT_TOKEN`, `OPERATOR_TOKEN` (main container only) |
| `ca-l3-verifier` | main | internal :8080 → 127.0.0.1:4023 | exactly 1 | `id-l3` (None) | `VERIFIER_TOKEN`, `SETTLEMENT_TOKEN`, `BASE_SEPOLIA_RPC_URL` (optional) |
| `job-regression` | main | none | per run | `id-l1` (None) | `CONTROL_TOKEN`, `VERIFIER_TOKEN`; `OPERATOR_TOKEN` is not given (the chain check runs through `job-operator`) |
| `job-operator` | main | none | per run | `id-op` (None) | `OPERATOR_TOKEN` |
| `ca-seller`, `ca-seller-alias` | counterparty | external | 0–1 | `id-seller` (None) | `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` |

## Deployment

| Field | Notes |
|---|---|
| `unit` | `infra` (the platform and the sellers), `l1-agent`, `l2-control` or `l3-verifier`: one pipeline each (contracts/deploy-pipeline.md) |
| `commit` | the Git SHA. The unit's image tag equals it (FR-023). Other units may run other commits |
| `revisions` | the new revision name per app; the agent's carries a label until promoted |
| `regression` | job exit code, the six outcomes, CONFIRMED count, chain check, secret scan result |
| `result` | `promoted` (the image tagged `last-good`), `failed`, or `unverified` for an L2 or L3 first deployment made before L1 exists. When failed, the agent stays on its previous revision, and the unit is redeployed at its `last-good` |
