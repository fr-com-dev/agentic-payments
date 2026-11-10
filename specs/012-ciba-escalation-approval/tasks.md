---

description: "Task list for 012 backchannel approval of escalated payments (CIBA with Auth0)"
---

# Tasks: Backchannel Approval of Escalated Payments (CIBA with Auth0)

**Input**: Design documents from `specs/012-ciba-escalation-approval/`

**Prerequisites**:
- [plan.md](plan.md)
- [spec.md](spec.md)
- [research.md](research.md) (R1–R16)
- [data-model.md](data-model.md)
- [contracts/](contracts/): auth0-ciba, payment-details, control-api, ledger-backchannel and
  config-and-secrets
- [quickstart.md](quickstart.md)

**Tests**: included and required. Constitution Principle VIII requires a test for every rule,
endpoint and contract field, plus the must-fail proofs listed in plan.md "Proofs".
- **Test IDs.** Each test title carries its ID (T-CIBA-01..14, T-ARCH-A9, T-E2E-10, T-E2E-11, or
  `012 USn …`). T-ARCH-TRACE checks the IDs that the threat matrix names.
- **Order.** Write each story's tests first and confirm they fail before implementing.
- **Timing.** Every timing value in tests comes from test-only deps (`waitMs`, `pollDelayMs`,
  `retryDelaysMs`, `now`), never from env. The production constants are asserted once (T-CIBA-09).

**Organization**: tasks are grouped by user story (US1–US7 from spec.md), so each story can be built
and checked on its own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel: a different file, and no dependency on an incomplete task.
- **[Story]**: the user story the task belongs to (US1–US7).

## Path Conventions

- Single repository: `src/`, `scripts/`, `test/`, `docs/`, `infra/` and `specs/` at the root (plan.md
  "Project Structure").
- All backchannel runtime code stays in `src/layer2-control/` (rule A1). Only
  `src/layer2-control/ciba-client.ts` names `CIBA_CLIENT_KEY` / `CIBA_CLIENT_SECRET` (rule A9).
- `src/layer2-control/policy.ts` is **not touched** by any task (FR-032).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: register the new entry types, the contract field and the env template, and build the
stand-in Auth0, so later phases compile and have something to test against.

- [X] T001 [P] Extend `EntryType` in src/layer2-control/ledger.ts with `"APPROVAL_REQUESTED" | "APPROVAL_REQUEST_FAILED" | "APPROVAL_REQUEST_LAPSED" | "APPROVAL_VERIFICATION_FAILED"`, under a `// 012 backchannel approval (L2-7)` comment. Make no other change in this task.
- [X] T002 [P] Add `operatorApprovalOnly?: boolean;` to `PaymentIntent` in src/shared/contracts.ts, with the comment `// 012 FR-007: true removes the backchannel approval path, never adds one. Set only by the L1-4 scripted root; the hosted agent never sets it.`
- [X] T003 [P] Add the CIBA block to env/l2-control.env.example, every value empty, after `OPERATOR_TOKEN`:
  - the header comment `# optional, 012 backchannel approval (L2-7); off unless CIBA_APPROVAL=1. Values: specs/012 quickstart §2`;
  - the lines `# CIBA_APPROVAL=`, `# CIBA_ISSUER=`, `# CIBA_CLIENT_ID=`, `# CIBA_AUDIENCE=`, `# CIBA_APPROVER=`;
  - the comment `# exactly one of the next two; the key (RSA 2048-4096, PKCS#8 PEM) is preferred`;
  - the lines `# CIBA_CLIENT_KEY=`, `# CIBA_CLIENT_SECRET=` and `# CIBA_CLIENT_KEY_ID=`.

  Then add those eight names to the `"l2-control"` `optional` list of T-ARCH-ENV's allow-list in test/architecture.test.ts.
- [X] T004 [P] Create test/helpers/ciba-stub.ts: a stand-in Auth0 on `http` at 127.0.0.1 (research R15).
  - **Exports**:
    - `startCibaStub(opts: { approver: string; clientId: string; audience: string; clientPublicKeyPem?: string; clientSecret?: string })`, returning `CibaStub`;
    - `PLANTED_ERROR_TEXT` (a unique string the stub puts in every `error_description`);
    - `testRsaKeyPair()`, returning a PKCS#8 private PEM and an SPKI public PEM.
  - **`CibaStub`**: `{ issuer: "http://127.0.0.1:<port>/", requests: { path: string; form: Record<string,string> }[], authReqIds: string[], tokensIssued: string[], setStart(mode), setAnswers(...answers), close() }`.
  - **Routes**: `POST /bc-authorize`, `POST /oauth/token` and `GET /.well-known/jwks.json`. Any other path answers 404 and is recorded, so tests can assert that nothing else was called.
  - **Client authentication**: verifies `private_key_jwt` assertions (RS256 with `clientPublicKeyPem`; `iss` = `sub` = clientId; `aud` = issuer; `exp` − `iat` ≤ 300) or `client_secret_post`. A wrong credential gets 401 `invalid_client`.
  - **Start modes**: `"ok"` (`expires_in` 300, `interval` 1, unless overridden with `{ expiresIn, interval }`), `"503"`, `"429"`, `"hang"`, `"unreachable"` (the socket is destroyed) and `{ permanent: <oauth error> }`.
  - **Answers**, consumed one per poll, with the last repeating:
    - `"pending"`, `{ slow_down: interval? }`, `"deny"`, `"expired_token"`, `"503"`, `"invalid_grant"`;
    - `{ approve: { detailsIn?: "token" | "response" | "both" (default "both"); profile?: "auth0" | "rfc9068"; forge?: Forgery } }`.

    It issues an RS256 access token from its JWKS key, with `iss`, `sub` = approver, `aud` = `[audience, issuer + "userinfo"]`, `azp` (auth0) or `client_id` + `jti` (rfc9068), `iat`, `exp` = `iat` + 300, and `authorization_details` = the request's.
  - **`Forgery`** values: `"issuer"`, `"audience"`, `"client"`, `"signature"` (signed by a key not in the JWKS, with the same `kid`), `"expired"` (`exp` = now − 120), `"subject"`, `{ details: (d) => d }` (a mutator), `"request"` (`request_id` replaced) and `"replay"` (the token issued for the previous approval).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the pure payment details, the credential-holding client, the token verifier, the
ledger listener, the derived functions and the backchannel skeleton. Every story depends on them.

**⚠️ CRITICAL**: no user story work begins until this phase is complete.

- [X] T005 [P] Create src/layer2-control/payment-details.ts (pure: no I/O, no clock), per contracts/payment-details.md.
  - **Exports**: `MAX_REQUESTED_EXPIRY_S = 300`, `BINDING_MESSAGE_MAX = 64`, `REFERENCE_CODE_LENGTH = 8`, `DETAILS_TYPE = "urn:auth0:schemas:authorization-details:v1:x402-payment"`, and these functions:
  - **`referenceCode(escalationId)`**: the 8 hex characters after `auth_`.
  - **`requirementDigest(req)`**: lowercase hex SHA-256 of `canonicalJSON(req)`, with `canonicalJSON` imported from ./ledger.js.
  - **`paymentDetails({ escalationId, requestId, resourceKey, payTo, amount, asset, network, requirement, decimals })`**: returns the one-object array with the 10 properties, display flags, names and `display_order` 1–10 exactly as in the contract.
    - The `instruction` is `"Approve this payment only if you expect it"`.
    - Every value is a string; `amount_usdc` = `formatAtomic(amount, decimals)` from ../shared/config.js.
    - `resource` is cut to 252 characters plus `...` when it is over 255.
  - **`bindingMessage({ amount, decimals, payTo, resourceKey, escalationId })`**: `Pay_<usdc>_USDC_to_<first 6 of payTo>..<last 4>[_for_<segment>]_#<ref>`.
    - Characters outside `A-Za-z0-9+\-_.,:#` in the segment become `-`.
    - The segment is shortened to fit 64 characters; if it ends up empty, it and `_for_` are dropped.
    - The function throws if the result is still over 64 characters.
  - **`requestedExpirySeconds(escalationExpiresAtMs, nowMs)`**: `min(300, floor((escalationExpiresAtMs − nowMs)/1000))`.
  - **`detailsEqual(a, b)`**: `canonicalJSON(a) === canonicalJSON(b)`.

  No parameter named `purpose` exists anywhere in the file.
- [X] T006 [P] Create test/payment-details.test.ts, `describe("T-CIBA-02 payment details")`, with these cases:
  - the contract's example values round-trip exactly (10 properties; `display` true for the first 5);
  - `amount_usdc` for 1, 1000, 50000 and 100000 atomic units with 6 decimals (`0.000001`, `0.001`, `0.05`, `0.1`);
  - every binding message over a grid of amounts × payees × paths (including `/a b%c~d`, a 300-character path and `/`) matches `^[A-Za-z0-9+\-_.,:#]{1,64}$`;
  - the contract's example message equals `Pay_0.05_USDC_to_0x95Ac..f057_for_premium-report_#3f9c2a1b`;
  - `referenceCode("auth_3f9c2a1b-7d4e-…")` is `3f9c2a1b`;
  - the digest is stable across key order;
  - a 300-character resource is cut with `...`;
  - `requestedExpirySeconds` caps at 300 and floors;
  - `detailsEqual` is false when any single value changes.
- [X] T007 Create src/layer2-control/ciba-client.ts, part 1: configuration, per contracts/config-and-secrets.md. This is the **only** file in `src/` that names `CIBA_CLIENT_KEY` or `CIBA_CLIENT_SECRET` (A9).
  - **Header comment**: `012 (SPEC L2-7, §3.3, rule A9): the only reader of L2's Auth0 client credential.`
  - **`cibaConfigFromEnv(env)`** returns `{ enabled: false, ignored: string[] }` or `{ enabled: true, issuer, clientId, audience, approver, credential: { kind: "key"; keyPem; keyId? } | { kind: "secret"; secret } }`. Each problem throws `ConfigError` (from ../shared/config.js) with a message that names the variable and never the value. It validates, in order:
    1. `CIBA_APPROVAL`: "`1` = on; unset, empty or `0` = off; anything else is a startup error";
    2. `CIBA_ISSUER`: "an absolute `https://` URL with no query or fragment; a trailing `/` is added if missing";
    3. `CIBA_CLIENT_ID`: "1–64 characters, no whitespace";
    4. `CIBA_AUDIENCE`: "1–255 characters, no whitespace";
    5. `CIBA_APPROVER`: "1–255 characters, no whitespace";
    6. exactly one of `CIBA_CLIENT_KEY` ("PKCS#8 PEM RSA private key of 2048–4096 bits (`\n` escapes accepted)", checked with `createPrivateKey` and `asymmetricKeyDetails.modulusLength`) and `CIBA_CLIENT_SECRET` ("16 or more characters");
    7. `CIBA_CLIENT_KEY_ID`: "1–255 characters; only with `CIBA_CLIENT_KEY`".
  - **Off**: `ignored` lists the `CIBA_*` names present.
- [X] T008 Add part 2 to src/layer2-control/ciba-client.ts: the HTTP client, per contracts/auth0-ciba.md.
  - **Export `interface CibaPort`**:
    - `start(p: { bindingMessage; requestedExpiry; authorizationDetails }): Promise<StartResult>`, where `StartResult` is `{ kind: "ok"; authReqId; expiresIn; interval }`, `{ kind: "transient"; failure: "unreachable" | "transient"; httpStatus? }` or `{ kind: "permanent"; httpStatus; error }`;
    - `poll(authReqId): Promise<PollResult>`, where `PollResult` is `{ kind: "token"; accessToken; responseDetails?: unknown }`, `{ kind: "pending" }`, `{ kind: "slow_down"; interval?: number }`, `{ kind: "denied" }`, `{ kind: "expired" }`, `{ kind: "transient"; httpStatus? }` or `{ kind: "permanent"; httpStatus; error }`;
    - `seal(authReqId, aad): string` and `open(sealed, aad): string | null`.
  - **Export `class CibaClient implements CibaPort`**, constructed from the enabled config plus `{ fetchImpl?, startTimeoutMs? = 1500, pollTimeoutMs? = 5000, allowInsecureLoopback? = false }`. Export `START_ATTEMPT_TIMEOUT_MS = 1500` and `POLL_TIMEOUT_MS = 5000`.
    - `allowInsecureLoopback` is the only way to accept an `http://127.0.0.1` issuer, and it is test-only.
    - It POSTs form-encoded to `${issuer}bc-authorize` and `${issuer}oauth/token` only. Each call gets fresh client authentication: an RS256 `SignJWT` assertion from jose with `iss` = `sub` = clientId, `aud` = issuer, a random 32-byte `jti`, `iat` and `exp` = `iat` + 60, plus `kid` when set; or `client_secret_post`.
    - The start form fields are exactly the contract's table, including `login_hint` = `JSON.stringify({ format: "iss_sub", iss: issuer, sub: approver })`, `scope=openid` and `audience`.
    - Responses are read as JSON, at most 64 KiB. Only `error`, `auth_req_id`, `expires_in`, `interval`, `access_token` and `authorization_details` are ever read.
    - `error` is kept only if it is in `CIBA_ERROR_CODES` (the contract's list, exported); otherwise it becomes `"other"`. `error_description` is never read.
  - **Sealing**: HKDF-SHA256 over the credential bytes (PKCS#8 DER or the secret), with salt `x402/ciba/handle/v1` and info `${issuer}|${clientId}`, then AES-256-GCM with a 12-byte IV. The output is `v1.<iv>.<ct>.<tag>` (base64url). `open` returns null on any failure.
  - **`publicSettings(settings)`** returns the non-secret settings (issuer, client, audience, approver) for the rest of L2. `main()` builds the client from `cibaConfigFromEnv` + `new CibaClient(...)` (T023), so no combined helper is needed.
- [X] T009 Create test/ciba-client.test.ts, run against the stub from T004.
  - **`describe("T-CIBA-01 configuration")`**:
    - off for unset, empty and `0`, with `ignored` listing the stray names;
    - each required variable missing or invalid (`http://` issuer, a 1024-bit key, an EC key, both credentials, neither, a key ID with a secret, `CIBA_APPROVAL=yes`) throws a message naming the variable;
    - a planted key PEM and secret never appear in any error message;
    - the trailing `/` is added.
  - **`describe("T-CIBA-02 request shape")`**:
    - the bc-authorize form has exactly the contract's fields;
    - the assertion verifies with the registered public key and has the contract's claims (`exp − iat === 60`, a unique `jti` per call);
    - the `client_secret_post` variant sends `client_id` and `client_secret` and no assertion;
    - `login_hint` parses to `{format:"iss_sub", iss, sub}`;
    - `authorization_details` parses back to the input;
    - the stub's recorded paths are only the two POST paths, with no other path or host.
  - **`describe("012 sealed handle")`**:
    - `open(seal(x, aad), aad) === x`;
    - a wrong `aad`, a different key, and a tampered ciphertext return null;
    - the sealed string doesn't contain `x`.
  - **`describe("012 error classification")`**:
    - 503, 429, a non-JSON body, a timeout (stub `"hang"` with `startTimeoutMs: 100`) and `"unreachable"` are transient;
    - `{permanent: "unknown_user_id"}` is permanent with that error;
    - an unknown error code becomes `"other"`;
    - `PLANTED_ERROR_TEXT` appears in no result object (`JSON.stringify` the results).
- [X] T010 [P] Create src/layer2-control/approval-evidence.ts, per contracts/auth0-ciba.md "The access token L2 accepts".
  - **Exports**: `CLOCK_TOLERANCE_S = 60`; `type VerificationCheck = "malformed" | "signature" | "issuer" | "audience" | "client" | "expired" | "approver" | "request" | "details" | "replay"`; `issuerKeys(issuer, { allowInsecureLoopback? })`, which returns jose `createRemoteJWKSet(new URL(".well-known/jwks.json", issuer))`; and `verifyApprovalToken(token, expected, opts)`.
  - **`verifyApprovalToken` inputs**: `expected = { issuer, audience, clientId, approver, requestId, sentDetails }`; `opts = { keys, nowMs, responseDetails?, answerIdUsed: (id) => boolean, skipChecks?: ReadonlySet<VerificationCheck> }`. `skipChecks` is test-only, for the must-fail proofs.
  - **Result**: `{ ok: true; evidence: { issuer, subject, answerId, issuedAt, detailsSource } }` or `{ ok: false; check }`.
  - **Order of checks**, one separate step each so each can be switched off (contract "The access token L2 accepts"):
    1. `malformed`: `decodeProtectedHeader` and `decodeJwt` succeed; `iss`, `sub`, `exp` and `iat` have the right types; `aud` is a string or a string array;
    2. `signature`: `compactVerify(token, keys, { algorithms: ["RS256"] })`; any error maps here;
    3. `issuer` (exact);
    4. `audience` (a string or an array that contains it);
    5. `client` (`azp ?? client_id`);
    6. `expired`: `exp > now − 60`, `nbf ≤ now + 60` when present, and `iat ≤ now + 60`;
    7. `approver` (`sub`);
    8. `request` (exactly one object, whose `properties.request_id.value === requestId`);
    9. `details` (`detailsEqual`);
    10. `replay`.

    `skipChecks` turns off any of checks 2–10.
  - **Sources**:
    - The details come from the token claim when present, else from `responseDetails`; `detailsSource` records which.
    - `answerId` = `jti`, or `"sha256:" +` the hex SHA-256 of the token.
    - `issuedAt` = the ISO form of `iat`.
  - Never log, and never return the token or jose's message.
- [X] T011 [P] Create test/approval-evidence.test.ts, `describe("T-CIBA-08 verification (unit)")`, with tokens signed by a local RSA key served through a jose `createLocalJWKSet`:
  - a valid token passes, with the right evidence for each profile (`azp` with no `jti` gives a `sha256:` answer ID; `client_id` with `jti` uses the `jti`);
  - each of the 10 checks fails on its own forgery, with exactly that `check`;
  - `exp` 59 s ago passes and 61 s ago fails;
  - `aud` as an array passes;
  - details only in the response give `detailsSource: "response"`;
  - **must fail** (Constitution VIII), for each of the 9 checks from `signature` to `replay`: with only that check in `skipChecks`, its forgery returns `ok: true`. With nothing skipped, the same forgery returns that `check`. Use `it.each` over the 9 cases.
- [X] T012 [P] Add rule A9 to test/architecture.test.ts, mirroring A8 (lines 242–262):
  - add `"A9"` to the `Rule` union;
  - `A9_ALLOWED = new Set(["src/layer2-control/ciba-client.ts", "env/l2-control.env.example"])`;
  - `A9_NAME = /\bCIBA_CLIENT_(?:KEY|SECRET)\b/`;
  - scope: `src/**`, `scripts/**` and `env/*.env.example`, with `test/**` exempt;
  - TS comments are ignored, as for A8.

  Create test/fixtures/arch/a9-violation.ts with `export const k = process.env.CIBA_CLIENT_KEY;`. Add these tests:
  - `T-ARCH-A9 fixture trips A9, and no other rule catches it (must fail without the rule)`;
  - `T-ARCH-A9 repository is clean`;
  - `T-ARCH-A9 CIBA_CLIENT_KEY_ID never trips it; a comment never does; any other template naming CIBA_CLIENT_SECRET does`.
- [X] T013 Add `subscribe(listener: (e: LedgerEntry) => void): () => void` to `AuditLedger` in src/layer2-control/ledger.ts.
  - `append` calls each listener with the stored entry, after the line is written and pushed.
  - A throwing listener is caught and ignored, so it can never fail an append.
  - The return value unsubscribes.
  - The listener is in memory only, so the chain is unchanged (research R6).

  Test it in test/ledger.test.ts, `012 append listener`: the listener sees every entry in order, unsubscribe stops it, and a throwing listener leaves `verifyChain().ok === true`.
- [X] T014 Add the derived functions from data-model.md "Derived functions" to src/layer2-control/escalations.ts. All are pure and take `nowMs`:
  - `referenceCode`, re-exported from ./payment-details.js;
  - `channelOf(entry)`, which returns `entry.data.channel ?? "operator"`;
  - `approvalRequestCount(entries, nowMs)`, which counts `ESCALATED` entries with `data.approvalRequest === "requested"` and `Date.parse(ts) > nowMs − 3_600_000`;
  - `approvalRequestState(entries, escalationId)`, giving `"requested" | "capped" | "operator_only" | "reevaluation" | "failed" | "verification_failed" | "lapsed" | "answered" | "abandoned" | undefined`:
    - `answered` means a final-state entry with `channel: "backchannel"`;
    - `abandoned` means any other final state while the request is open;
  - `openApprovalRequest(entries, escalationId, nowMs)`;
  - `requestsToResume(entries, nowMs)`, which returns `{ open: LedgerEntry[]; interrupted: LedgerEntry[] }`;
  - `answerIdUsed(entries, answerId)`.

  Add `describe("012 approval request derivations")` to test/escalations.test.ts, covering every state above, the cap window boundary at exactly 3 600 000 ms, and both resume lists.
- [X] T015 Create src/layer2-control/backchannel.ts, the skeleton.
  - **Constants**, verbatim from data-model.md: `BACKCHANNEL_WAIT_MS = 120_000`, `APPROVAL_REQUEST_CAP = 10`, `APPROVAL_REQUEST_CAP_WINDOW_MS = 3_600_000`, `START_RETRY_DELAYS_MS = [250, 1000]`, `REFUSAL_MARGIN_MS = 5_000`, `DEFAULT_POLL_INTERVAL_S = 5`, `SLOW_DOWN_STEP_S = 5`, `MAX_TRANSIENT_POLL_DELAY_S = 30`.
  - **`interface BackchannelDeps`**: `{ port: CibaPort; issuer; clientId; audience; approver; keys: JWTVerifyGetKey; decimals: number }`, plus test-only fields: `waitMs?`, `pollDelayMs?: (intervalS) => number`, `retryDelaysMs?`, `approvalRequestCap?`, `skipChecks?` and `serializeOutcomes? = true`.
  - **`class Backchannel`**, constructed with `(deps & { ledger, serialize, now })`:
    - `eligibility(opts: { operatorOnly: boolean; reevaluation: boolean; nowMs }): "requested" | "capped" | "operator_only" | "reevaluation"`. It is pure over `ledger.entries()` and is called inside the section. This task returns only `"reevaluation"` or `"requested"`; US6 adds the rest;
    - `waitForFinal(escalationId, ms, signal): Promise<"approved" | "denied" | "expired" | "ended" | "timeout" | "aborted">`. It subscribes first, then checks the current state synchronously, and resolves on:
      - a final-state entry for the escalation;
      - an `APPROVAL_REQUEST_FAILED`, `APPROVAL_REQUEST_LAPSED` or `APPROVAL_VERIFICATION_FAILED` for it (`ended`);
      - the timer;
      - the signal.

      It always unsubscribes and clears its timer;
    - `stop()`, which ends every poll loop and timer.

**Checkpoint**: payment details, client, verifier, listener, derivations and skeleton all exist,
each with passing unit tests. No behavior of L2 has changed yet (`npm test` is green).

---

## Phase 3: User Story 1 - The approver approves from their phone (Priority: P1) 🎯 MVP

**Goal**: an eligible escalation sends one approval request, a verified approval is recorded with
the backchannel channel, and the waiting call (or the next one) pays exactly once.

**Independent test**: stub approves → one bc-authorize carrying the payment's details; the ledger
records `HUMAN_APPROVAL{channel: backchannel, evidence}`; the same authorize call returns AUTHORIZED;
exactly one AUTHORIZED. Then the same with the approval after the wait: ESCALATE, then the next
request is AUTHORIZED once.

### Tests for User Story 1 (write first; they must fail)

- [X] T016 [P] [US1] Create test/helpers/backchannel-l2.ts (shared by every story's test file), exporting `startBackchannelL2(opts)`, and create test/backchannel-approve.test.ts.
  - **The helper**: a temp-file `AuditLedger`, `createControlService` with the default mandate, a fake signer like policy.test.ts's, tokens, `now` and the `backchannel` deps.
  - **Backchannel deps**: a `CibaClient` against `startCibaStub` with `allowInsecureLoopback: true`, `keys: issuerKeys(stub.issuer, { allowInsecureLoopback: true })`, `waitMs` 1500 and `pollDelayMs: (s) => s * 20`.
  - **The intent helper**: `intentFor(path, amount, opts)`.
  - **It also returns** `{ url, ledger, stub, service, authorize(intent, { signal? }), approve(id), reject(id), events(after), pending(), close() }`.

  In test/backchannel-approve.test.ts, add `describe("T-CIBA-02 one request per eligible escalation")`:
  - a 50000 request gives exactly one bc-authorize within 2 s;
  - the form's `authorization_details` equals `APPROVAL_REQUESTED.data.details`, whose values equal the `ESCALATED` entry's `resourceKey`, `payTo` and `amount`, plus the chosen requirement's `asset`, `network` and digest;
  - a planted `purpose` text appears in no stub request;
  - `requested_expiry ≤ 300`.

  Add `describe("T-CIBA-06 polling")`:
  - `pending ×3` then approve gives 4 polls, each at least `pollDelayMs(interval)` apart (use an injected clock or sleep spy);
  - `slow_down` with `interval` 3 raises the interval to max(3, 1 + 5) = 6;
  - polling stops once the escalation is decided by the operator.
- [X] T017 [US1] In test/backchannel-approve.test.ts, add `describe("T-CIBA-09 wait in the call (approval)")`:
  - **approve within the wait**: the same call returns AUTHORIZED with a new `authorizationId`. The ledger trail for the intent is exactly `INTENT`, `ESCALATED{approvalRequest:"requested"}`, `APPROVAL_REQUESTED`, `HUMAN_APPROVAL{channel:"backchannel", approver: <approver>, evidence.issuer: stub.issuer}`, `INTENT{reevaluationOf}` and `AUTHORIZED{approvalRef}`. Both `INTENT`s have the same `intentId`;
  - **approve after the wait** (`pending` until after `waitMs`): the call returns ESCALATE with the escalation ID; the next request returns AUTHORIZED and a third returns ESCALATE again (pays once, SC-005);
  - **US1 scenario 5**: an approval while the session budget no longer fits gives DENIED `session_budget_exceeded`, and the approval stays open;
  - **FR-019**: when the caller aborts the fetch during the wait, no second `INTENT` is written, `HUMAN_APPROVAL` is still recorded, and the next request pays;
  - **FR-016, no lock**: while a call waits, a reconcile (`POST /v1/reconcile` for an earlier AUTHORIZED), a budget read and an auto-approved authorize each complete before the wait ends;
  - **Production constants**: `BACKCHANNEL_WAIT_MS === 120_000` and the other constants equal data-model.md.
- [X] T018 [P] [US1] Add `controlBackchannel?: BackchannelDeps` to `HarnessOptions` in test/helpers/harness.ts and pass it through to `createControlService`. The test builds the stub and the deps. When it is absent, nothing changes. Then add `T-E2E-10 backchannel approval within the wait pays in the same fetch` to test/e2e.local.test.ts:
  - a stub that answers `pending` twice, then approves;
  - the real `PaidResourceOrchestrator.fetchPaid` for `/api/premium-report` returns PAID with CONFIRMED;
  - the on-chain delta is exactly 50000;
  - `stub.authReqIds.length === 1`;
  - **NFR-003**: `JSON.stringify` of the `PaidFetchResult` holds no `stub.tokensIssued` or `stub.authReqIds` value.

### Implementation for User Story 1

- [X] T019 [US1] In src/layer2-control/backchannel.ts, implement `start(plan)`, where `plan` is `{ escalationId, sessionId, resourceKey, payTo, amount, requirement, escalationExpiresAtMs }`. It is fire-and-forget, catches every error, and makes one attempt in this task (US5 adds retries):
  - build `requestId = "apq_" + randomUUID()`, the details, the binding message and `requested_expiry` with payment-details.ts;
  - call `port.start`;
  - on `ok`, run `serialize(() => …)`: if `escalationState` is still `pending`, append `APPROVAL_REQUESTED` with the data-model.md fields:
    - `escalationId`, `resourceKey`, `payTo` and `amount`, copied from `ESCALATED`;
    - `channel: "backchannel"`, `requestId`, `issuer`, `approver` and `referenceCode`;
    - `bindingMessage`, `details`, `requestedExpirySec` and `intervalSec`;
    - `requestExpiresAtMs` = min(t + expiresIn × 1000, `escalationExpiresAtMs`);
    - `handleSealed` = `port.seal(authReqId, escalationId + "|" + requestId)`;
    - `attempts`.
  - then begin the poll loop with the plaintext handle, held in memory only.
- [X] T020 [US1] In src/layer2-control/backchannel.ts, implement the poll loop and the token branch (research R11):
  - sleep `pollDelayMs(interval)`;
  - stop if the escalation is not pending;
  - `pending`: loop;
  - `slow_down`: interval = max(the returned interval, interval + `SLOW_DOWN_STEP_S`);
  - `transient`: wait min(interval × 2, 30) s and continue until `requestExpiresAtMs`;
  - `token`: run `verifyApprovalToken` outside the lock. Then, inside `serialize`, if the escalation is pending and `openApprovalRequest` is this request:
    - **on success**, append `HUMAN_APPROVAL` with `approvalId: "apr_" + uuid`; `escalationId`, `resourceKey`, `payTo` and `amount` from `ESCALATED`; `approver: evidence.subject`; `expiresAtMs: t + DEFAULT_APPROVAL_TTL_SECONDS * 1000`; `channel: "backchannel"`; `requestId`; and `evidence`;
    - **on a failure**, append `APPROVAL_VERIFICATION_FAILED { …copied fields, channel, requestId, check }`;
    - **otherwise**, append nothing (abandoned).

  Never more than one poll in flight per request.
- [X] T021 [US1] Restructure `authorize` in src/layer2-control/service.ts into `decideOnce(intent, opts: { reevaluationOf?: string })`, which returns `{ decision, start?: StartPlan }`. Today's steps 1–6 are unchanged, plus:
  - the `INTENT` data gains `reevaluationOf` when it is set;
  - a new `ESCALATED` gets `approvalRequest: backchannel.eligibility({ operatorOnly: intent.operatorApprovalOnly === true, reevaluation: !!opts.reevaluationOf, nowMs: t })` only when `deps.backchannel` is set;
  - `start` is returned only for `"requested"`.

  `createControlService` gains `backchannel?: BackchannelDeps`. It constructs the `Backchannel` with `{ ledger, serialize, now }` and returns it as `ControlService.backchannel`. The `/v1/authorize` handler follows plan.md "Authorize path" and contracts/control-api.md:
  1. `const ac = new AbortController()`, with `res.on("close", () => { if (!res.writableFinished) ac.abort(); })`;
  2. run the first section;
  3. if it returned `start`: `backchannel.start(start)`, then `await waitForFinal(id, deps.backchannel.waitMs ?? BACKCHANNEL_WAIT_MS, ac.signal)`;
  4. for `approved` or `denied`, run the second section `serialize(() => ac.signal.aborted ? null : decideOnce(intent, { reevaluationOf: id }))` and respond with its decision;
  5. otherwise respond with the first decision, unless aborted.

  The `ESCALATION_REPEATED` branch never starts or waits. Update the file's header comment.
- [X] T022 [US1] In src/layer2-control/approval-routes.ts, add `channel: "operator"` to the `HUMAN_APPROVAL` and `HUMAN_REJECTION` data the routes append (data-model.md "Changed"). Update every existing test that deep-equals those entries: grep test/ for `HUMAN_APPROVAL` and `HUMAN_REJECTION` `data` objects.
- [X] T023 [US1] Wire `main()` in src/layer2-control/service.ts:
  - right after `loadEnv("l2-control")` and **before** `acquireLedgerLock`, call `cibaConfigFromEnv(process.env)` (contracts/config-and-secrets.md "Order"). A `ConfigError` exits 1 through the existing catch, so a misconfigured revision never takes the ledger lock. Build the `CibaClient` from that config after the network profile is known;
  - when off with `ignored.length > 0`, log `l2-control: backchannel approval is off; ignoring <names>`;
  - when on, pass `backchannel: { port, issuer, clientId, audience, approver, keys: issuerKeys(issuer), decimals: net.decimals }`;
  - log `l2-control: backchannel approval on (issuer <issuer>, approver <approver>)`;
  - `stop()` calls `backchannel.stop()`.

  No network call at startup (research R16).

**Checkpoint**: T016–T018 pass. `npm test` is green, and `demo:local` is unchanged with the feature
off.

---

## Phase 4: User Story 2 - The approver refuses (Priority: P1)

**Goal**: a refusal ends the escalation as denied with the backchannel channel, and R15 applies
exactly as for an operator rejection.

**Independent test**: stub refuses → the repeat in the same session is DENIED `human_rejected`;
nothing signed; trail `ESCALATED`, `APPROVAL_REQUESTED`, `HUMAN_REJECTION{backchannel}`.

### Tests for User Story 2

- [X] T024 [P] [US2] Create test/backchannel-refuse.test.ts (using test/helpers/backchannel-l2.ts) and add `describe("T-CIBA-07 outcomes (refusal)")`:
  - `deny` well before the request's expiry appends one `HUMAN_REJECTION` with `channel: "backchannel"`, `approver` = `CIBA_APPROVER`, `issuer`, `requestId`, and the session, resource key, payee and amount copied from `ESCALATED`, and no `operator` and no `reason`;
  - the waiting call returns DENIED `human_rejected` with detail exactly `rejected by the operator (<rejectionId>)`, carrying neither the approver's identity nor `PLANTED_ERROR_TEXT` (US2 scenario 2);
  - a later request in the same session, at another amount, is also DENIED `human_rejected`;
  - nothing is signed.
- [X] T025 [P] [US2] Add `T-E2E-11 backchannel refusal through the orchestrator` to test/e2e.local.test.ts:
  - the stub refuses;
  - `fetchPaid` returns DENIED with `rules=human_rejected`;
  - the on-chain delta is 0;
  - the ledger trail for the escalation is `ESCALATED`, `APPROVAL_REQUESTED`, `HUMAN_REJECTION`, `INTENT`, `DENIED`;
  - **NFR-003**: the `PaidFetchResult` JSON holds no token, handle or `PLANTED_ERROR_TEXT`.

### Implementation for User Story 2

- [X] T026 [US2] In src/layer2-control/backchannel.ts, implement the refusal branch (research R7). On `denied` with `now() ≤ requestExpiresAtMs − REFUSAL_MARGIN_MS`, inside `serialize`, if the escalation is pending and this request is open, append `HUMAN_REJECTION` with:
  - `rejectionId: "rej_" + uuid`;
  - `escalationId`, `resourceKey`, `payTo` and `amount`, copied from `ESCALATED`;
  - `channel: "backchannel"`, `approver`, `issuer` and `requestId`.

  The later-refusal case is US3's. `findRejection`, R15 and the re-evaluation need no change.

**Checkpoint**: US1 and US2 pass together.

---

## Phase 5: User Story 3 - No answer: expiry, operator fallback, restarts (Priority: P1)

**Goal**: every escalation still ends exactly once within 300 s. The operator path works at any
time, and L2 resumes waiting after a restart without asking twice.

**Independent test**: stub never answers → lapse, then `ESCALATION_EXPIRED` at 300 s, and a late
approval changes nothing. Operator approve or reject during the wait → L2 stops polling and the
waiting call returns that decision.

### Tests for User Story 3

- [X] T027 [P] [US3] Create test/backchannel-lapse.test.ts (using test/helpers/backchannel-l2.ts) and add `describe("T-CIBA-07 outcomes (lapse and expiry)")`:
  - `expired_token` appends `APPROVAL_REQUEST_LAPSED{cause:"expired"}`;
  - `deny` within 5 s of the request's expiry appends `APPROVAL_REQUEST_LAPSED{cause:"late_refusal"}` and no `HUMAN_REJECTION`;
  - `pending` until `requestExpiresAtMs` (stub `{expiresIn: 1}`) appends `APPROVAL_REQUEST_LAPSED{cause:"expired"}` and polling stops;
  - in each case the escalation stays pending, the waiting call returns ESCALATE, and after `sweep` at +300 s there is one `ESCALATION_EXPIRED`;
  - an approval the stub returns after the expiry appends nothing (US3 scenario 1);
  - **Edge case "an escalation after an expiry"**: the next request for the same purchase escalates under a new ID, sends a second bc-authorize (`stub.authReqIds.length === 2`), and `approvalRequestCount` counts both.
- [X] T028 [US3] In test/backchannel-lapse.test.ts, add `describe("012 US3 operator path during a request")`:
  - an operator approve during the wait makes the waiting call return AUTHORIZED, and the stub sees no poll after it;
  - an operator reject during the wait makes it return DENIED `human_rejected`;
  - after a backchannel approval, an operator reject is 409 `{state:"approved", approvalId}`;
  - after a backchannel refusal, an operator approve is 409 `{state:"denied", rejectionId}`.
- [X] T029 [US3] In test/backchannel-lapse.test.ts, add `describe("T-CIBA-10 serialized outcome recording")`. The stub's JWKS response is delayed 200 ms by a `setAnswers` hook on the JWKS route. An operator rejection lands during that delay:
  - with the design, exactly one final-state entry (`HUMAN_REJECTION{channel:"operator"}`) and no `HUMAN_APPROVAL`;
  - **must fail**: with `serializeOutcomes: false`, both `HUMAN_REJECTION` and `HUMAN_APPROVAL` exist for the escalation.
- [X] T030 [US3] In test/backchannel-lapse.test.ts, add `describe("T-CIBA-11 restart")`:
  - stop the first service while it waits, then build a second `createControlService` over the same ledger file and call `backchannel.resume()`. The stub sees polls with the **same** `auth_req_id`, no new bc-authorize, and the approval is recorded;
  - with the window already past at resume (`now` + 301 s), `sweep` expires the escalation and there are no polls;
  - an escalation marked `requested` with no request entry gets `APPROVAL_REQUEST_FAILED{phase:"resume", failure:"interrupted"}` and no bc-authorize;
  - a second service with a different client key appends `APPROVAL_REQUEST_FAILED{failure:"unrecoverable"}`.

### Implementation for User Story 3

- [X] T031 [US3] In src/layer2-control/backchannel.ts, implement the lapse branches (research R7):
  - `denied` later than `requestExpiresAtMs − REFUSAL_MARGIN_MS` appends `APPROVAL_REQUEST_LAPSED{cause:"late_refusal"}`;
  - `expired` appends it with `cause:"expired"`;
  - the loop reaching `requestExpiresAtMs` with no answer appends it with `cause:"expired"`.

  Each appends inside `serialize`, and only while the escalation is pending and the request is open. Stop polling once the escalation is final, whatever the cause.
- [X] T032 [US3] In src/layer2-control/backchannel.ts, add the `serializeOutcomes` test switch (default true). When false, the token branch reads the state, awaits verification, then appends without `serialize`. It exists only for T029's must-fail proof.
- [X] T033 [US3] In src/layer2-control/backchannel.ts, implement `resume()`, per research R8 and `requestsToResume`:
  - **open**: `port.open(handleSealed, escalationId|requestId)`, then go back to the poll loop at `intervalSec`;
  - **`null`**: inside `serialize`, append `APPROVAL_REQUEST_FAILED{phase:"resume", failure:"unrecoverable"}`;
  - **interrupted**: append `APPROVAL_REQUEST_FAILED{phase:"resume", failure:"interrupted"}`, without a `requestId`;
  - call it from `main()` right after `createControlService`, and from the test helper.

**Checkpoint**: US1–US3 pass. Every escalation ends exactly once (SC-004).

---

## Phase 6: User Story 4 - L2 trusts only a verified approval of this exact payment (Priority: P1)

**Goal**: no forged, replayed or swapped answer approves anything. Each one records a
verification failure and leaves the escalation pending.

**Independent test**: each forgery from the stub → `APPROVAL_VERIFICATION_FAILED{check}`, the
escalation stays pending, nothing is signed. Must-fail: without the details check, the
different-amount answer approves and pays.

### Tests for User Story 4

- [X] T034 [P] [US4] Create test/backchannel-verify.test.ts (using test/helpers/backchannel-l2.ts) and add `describe("T-CIBA-08 verification through L2")`. For each forgery (`issuer`, `audience`, `client`, `signature`, `expired`, `subject`, details with another amount, details with another `pay_to`, details with another `escalation_id`, `request`, `replay`):
  - exactly one `APPROVAL_VERIFICATION_FAILED` with the expected `check`;
  - no `HUMAN_APPROVAL`;
  - the waiting call returns ESCALATE;
  - no AUTHORIZED;
  - the escalation is pending, and an operator approval still pays.

  **Must fail**:
  - with `skipChecks: new Set(["details"])`, the different-amount answer appends `HUMAN_APPROVAL` and the call returns AUTHORIZED;
  - with `["approver"]`, another user's approval pays;
  - with `["issuer"]`, the other-issuer token approves;
  - a token replayed from another escalation fails `request` with every check on. With `["request", "details"]` off it fails `replay`, and with `["request", "details", "replay"]` off it approves a second escalation.

  **US4 scenario 4**: two pending escalations for different purchases; approving the second leaves the first pending.

### Implementation for User Story 4

- [X] T035 [US4] Pass `skipChecks` from `BackchannelDeps` into `verifyApprovalToken`, and make sure `waitForFinal` resolves `ended` on `APPROVAL_VERIFICATION_FAILED`, both in src/layer2-control/backchannel.ts. Verify that the `request` check uses `openApprovalRequest(entries, escalationId, now)` read inside the serialized section, and that `replay` uses `answerIdUsed` on the current entries.

**Checkpoint**: SC-003 holds. Zero payments from a forged answer.

---

## Phase 7: User Story 5 - An unavailable or misconfigured approval service fails closed (Priority: P2)

**Goal**: a bad configuration stops L2 at startup. An Auth0 failure leaves the escalation pending
and the operator path working. Payments that need no human are unaffected.

**Independent test**: unreachable, 503 and a permanent refusal each → `APPROVAL_REQUEST_FAILED`,
escalation pending, visible to the operator, an operator approval pays, and an auto-approved
purchase decided as fast as without the feature.

### Tests for User Story 5

- [X] T036 [P] [US5] Create test/backchannel-failures.test.ts (using test/helpers/backchannel-l2.ts) and add `describe("T-CIBA-05 start failures")`, with `retryDelaysMs: [10, 20]`:
  - `"503"` three times gives 3 bc-authorize calls and one `APPROVAL_REQUEST_FAILED{phase:"start", failure:"transient", httpStatus:503, attempts:3}`, with no `requestId`;
  - 503 then ok gives `APPROVAL_REQUESTED{attempts:2}`;
  - `"unreachable"` gives `failure:"unreachable"`;
  - `{permanent:"unknown_user_id"}` gives 1 call and `failure:"permanent", error:"unknown_user_id"`;
  - a poll answering `invalid_grant` gives `APPROVAL_REQUEST_FAILED{phase:"poll", failure:"permanent"}`;
  - in each case the waiting call returns ESCALATE as soon as the failure is recorded (FR-018), the escalation is pending, and `POST /v1/approvals/:id` followed by the next request pays;
  - with the production defaults (no `retryDelaysMs`) and stub `"hang"`, the call returns ESCALATE within 6 s (`START_ATTEMPT_TIMEOUT_MS` 1500 × 3, plus 250 and 1000);
  - `PLANTED_ERROR_TEXT` appears in no entry.
- [X] T037 [US5] In test/backchannel-failures.test.ts, add `describe("T-CIBA-13 availability")`:
  - with the stub on `"hang"` and the start in progress, a 1000-atomic auto-approved request in the same and in another session completes within 50 ms of the baseline. Compare the median of 5 runs against the median of 5 runs on a service without backchannel, so one slow run on CI can't fail it;
  - its ledger entries are unchanged from the off path (no `approvalRequest`).
- [X] T038 [US5] In test/backchannel-failures.test.ts, add `describe("T-CIBA-01 startup")`. Spawn `npx tsx src/layer2-control/service.ts` with an `ENV_FILE` in a temp dir: `NETWORK=local`, `CIBA_APPROVAL=1`, and a valid `CIBA_CLIENT_KEY` but no `CIBA_ISSUER`. Validation runs before the lock and the profile (T023), so no deployment file or payer key is needed. Assert:
  - exit code 1;
  - stderr names `CIBA_ISSUER`;
  - stderr doesn't contain the key PEM's body;
  - nothing listens on the port;
  - no `<ledger>.lock` file was created.

  Use the 010 spawned-CLI pattern in test/policy.test.ts for the timeouts.

### Implementation for User Story 5

- [X] T039 [US5] In src/layer2-control/backchannel.ts, implement start retries and failure recording (research R10):
  - the first attempt goes at once. After a transient failure, wait `(retryDelaysMs ?? START_RETRY_DELAYS_MS)[i]`, with the default `[250, 1000]`, and try again while the escalation is pending, for at most 3 attempts. Each attempt uses `START_ATTEMPT_TIMEOUT_MS = 1500` (`CibaClient` `startTimeoutMs`); polls use `POLL_TIMEOUT_MS = 5000`;
  - `transient` retries;
  - `permanent` stops at once;
  - after the last attempt, or on `permanent`, append inside `serialize` `APPROVAL_REQUEST_FAILED` with the copied fields plus `channel`, `phase:"start"`, `failure`, `httpStatus?`, `error?` and `attempts`;
  - in the poll loop, `permanent` appends `APPROVAL_REQUEST_FAILED{phase:"poll", requestId, failure:"permanent", httpStatus, error}`;
  - `waitForFinal` resolves `ended` on these entries.

**Checkpoint**: SC-007 holds, and NFR-002 and NFR-005 are proven.

---

## Phase 8: User Story 6 - The approver is not flooded with requests (Priority: P2)

**Goal**: repeats reuse the pending escalation with no new request, there are at most 10 requests
per rolling hour, and automated checks never notify the approver.

**Independent test**: the same purchase 5 times gives 1 request. 11 purchases in an hour give 10
requests, and the 11th is `capped`. The scripted plan with backchannel on gives 0 requests and the
baseline outcomes.

### Tests for User Story 6

- [X] T040 [P] [US6] Create test/backchannel-fatigue.test.ts (using test/helpers/backchannel-l2.ts) and add `describe("T-CIBA-03 repeats and operator-only")`:
  - the same purchase 5 times gives `stub.authReqIds.length === 1`, and the repeats return ESCALATE with the same ID **at once** (each well under `waitMs`);
  - `operatorApprovalOnly: true` gives `ESCALATED{approvalRequest:"operator_only"}`, no bc-authorize, and an immediate ESCALATE;
  - `operatorApprovalOnly: "yes"` gives 400 `malformed PaymentIntent` and the ledger is unchanged;
  - `operatorApprovalOnly: false` behaves like an absent field.
- [X] T041 [US6] In test/backchannel-fatigue.test.ts, add `describe("T-CIBA-04 cap")`, using the `now` hook:
  - 11 different purchases within an hour (distinct sessions) give 10 bc-authorize, and the 11th is `ESCALATED{approvalRequest:"capped"}` and returns at once;
  - at `now` + 3 600 001 ms after the first, a new purchase is `requested` again;
  - **must fail**: with `approvalRequestCap: Infinity`, 11 requests are sent.
- [X] T042 [P] [US6] In test/agent.test.ts and test/hosted-agent.test.ts, add `012 FR-007 operator-only intents`:
  - every intent the scripted agent's orchestrator (built as `src/main.ts` builds it for `--scripted`) sends has `operatorApprovalOnly: true`;
  - the Claude agent's and the hosted agent's intents never carry the field;
  - neither tool's JSON schema has a property named `operatorApprovalOnly` (T-AGT-02 tool lists unchanged).
- [X] T043 [P] [US6] In test/e2e.local.test.ts, add `T-E2E-10 the scripted plan never asks the approver`: a harness with `controlBackchannel`, then `runScriptedAgent` with the orchestrator flag. The outcomes equal `BASELINE_OUTCOMES`, `stub.authReqIds.length === 0`, and step 4's `ESCALATED` has `approvalRequest: "operator_only"`.
- [X] T044 [P] [US6] In test/deploy-workflow.test.ts, add to the T-E2E-AZ static checks: step 8 (hosted smoke) in .github/workflows/deploy.yml has a `jq -e` asserting that no step's `.result.outcome` is `"ESCALATED"`.

### Implementation for User Story 6

- [X] T045 [US6] Complete `eligibility()` in src/layer2-control/backchannel.ts, in this order:
  1. `reevaluation` → `"reevaluation"`;
  2. `operatorOnly` → `"operator_only"`;
  3. `approvalRequestCount(entries, nowMs) >= (approvalRequestCap ?? APPROVAL_REQUEST_CAP)` → `"capped"`;
  4. else `"requested"`.
- [X] T046 [US6] In `validIntent` in src/layer2-control/service.ts, reject an `operatorApprovalOnly` that is present but not a boolean (400 `malformed PaymentIntent`).
- [X] T047 [US6] Add `operatorApprovalOnly?: boolean` to `OrchestratorDeps` in src/layer1-intent/orchestrator.ts. Copy it into each `PaymentIntent` only when it is `true`, so the intents of other callers are byte-for-byte unchanged. In src/main.ts, pass `operatorApprovalOnly: true` to the orchestrator only when `--scripted` is given. Leave src/hosted-main.ts and src/layer1-intent/hosted/** unchanged.
- [X] T048 [US6] Add the `operatorApprovalOnly` property (boolean, optional, with the FR-007 description) to the `PaymentIntent` schema in docs/l2-control.openapi.yaml, and run test/openapi.test.ts.
- [X] T049 [US6] In .github/workflows/deploy.yml step 8, after the PAID checks, add `jq -e '[.steps[] | select(.result.outcome == "ESCALATED")] | length == 0' "$RUNNER_TEMP/smoke.json" > /dev/null`, with a comment citing specs/012 research R14.

**Checkpoint**: SC-006 holds, and the baseline is unchanged with the feature on.

---

## Phase 9: User Story 7 - The operator and the auditor see who decided, and how (Priority: P3)

**Goal**: views, events and the ledger show the request's state, the channel and the deciding
identity, and never a token, a handle or Auth0 text.

**Independent test**: drive each outcome, then read `GET /v1/escalations`, the events and the
ledger. Each shows the channel, the request state and the decider; a known-value scan finds no
secret.

### Tests for User Story 7

- [X] T050 [P] [US7] Create test/backchannel-views.test.ts (using test/helpers/backchannel-l2.ts) and add `describe("T-CIBA-14 operator views and audit trail")`:
  - pending items carry `referenceCode` (8 hex) and `approvalRequest` for each of `requested`, `capped`, `operator_only`, `failed`, `verification_failed` and `lapsed`;
  - events include `escalated{referenceCode, approvalRequest}`, `approval_requested{requestId, referenceCode, requestExpiresAt}`, `approval_request_failed{failure, error?}`, `approval_request_lapsed{cause}`, `approval_verification_failed{check}`, `approved{channel:"backchannel", decidedBy: approver}` and `denied{channel:"backchannel", decidedBy: approver}` with no `operator`;
  - operator decisions show `channel:"operator"` and `decidedBy` = the label;
  - **SC-010**: for each scenario, a function written in the test from the ledger file alone reconstructs `{ asked, requestOutcome, decidedBy, channel, paidAuthorizationId? }` and matches.
- [X] T051 [US7] In test/backchannel-views.test.ts, add `describe("T-CIBA-12 known-value scan")`. Run approve, refuse, lapse, verification failure and start failure with console output captured. Then search the ledger file text, the captured console, every HTTP response body and every event for:
  - the client key PEM body and the client secret;
  - every `stub.tokensIssued` value;
  - every `stub.authReqIds` value;
  - `PLANTED_ERROR_TEXT`.

  Expect 0 hits. Also assert `handleSealed` is present and opens only with the right key.
- [X] T052 [P] [US7] Extend T-LED-04's forbidden-key check in test/escalations.test.ts to the new kinds: no event or view has the keys `handleSealed`, `details`, `bindingMessage`, `evidence`, `issuer`, `accepts`, `purpose`, `access_token` or `auth_req_id`.

### Implementation for User Story 7

- [X] T053 [US7] In src/layer2-control/escalations.ts:
  - **`EscalationView`**: add `referenceCode` (always) and `approvalRequest?`, which is `approvalRequestState` when `ESCALATED.data.approvalRequest` is present.
  - **`EscalationEventKind`**: add `approval_requested`, `approval_request_failed`, `approval_request_lapsed` and `approval_verification_failed`. Map them in `KIND`.
  - **The event projection**: extend it field by field, per data-model.md "Operator views":
    - `escalated` gets `referenceCode` and `approvalRequest?`;
    - `approved` gets `channel` (`channelOf`) and `decidedBy`;
    - `denied` gets `channel` and `decidedBy`, with `operator` and `reason` only on the operator channel;
    - the new kinds get only their listed fields.

    Never spread `data`.
- [X] T054 [US7] Update `formatEvent` and `formatPending` in scripts/escalations.ts:
  - append `referenceCode=`, `approvalRequest=`, `channel=` and `decidedBy=` when present;
  - print the four new kinds upper-cased, like the others, with `requestId=`, `failure=`, `error=`, `cause=` or `check=`.

  Keep every existing line format unchanged for operator-channel events, so the 010 CLI tests in test/policy.test.ts still pass apart from the additive `channel=operator decidedBy=…`. Update those expectations.
- [X] T055 [US7] Update docs/l2-control.openapi.yaml:
  - the escalation view schema gains `referenceCode` (required) and `approvalRequest` (optional enum);
  - the event schema gains the optional `referenceCode`, `approvalRequest`, `channel`, `decidedBy`, `requestId`, `requestExpiresAt`, `failure`, `error`, `cause` and `check`;
  - the `kind` enum gains the four kinds;
  - `operator` becomes optional on `denied`.

  Run test/openapi.test.ts (T-API-01..03).

**Checkpoint**: every user story passes.

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: Azure delivery (FR-003), SPEC and governance in the same change, docs and the full gate.

- [X] T056 [P] Add the Azure delivery, per contracts/config-and-secrets.md "Azure" (always present, decided 2026-11-08).
  - **infra/main.bicep**: `param ciba object`, a plain object (a user-defined type would switch to `languageVersion` 2.0); a `cibaChecked` variable that refuses (`fail()`) a `credential` other than `key` or `secret`, and an enabled `ciba` without an `https://` `issuer`, a `clientId`, an `audience` and an `approver`; pass `ciba` to the l2 module.
  - **infra/modules/l2-apps.bicep**, always:
    - the secret `ciba-client-credential` from `${vaultL2}secrets/ciba-client-credential`;
    - the `l2` container's env `CIBA_APPROVAL` (`1` or `0`), `CIBA_ISSUER`, `CIBA_CLIENT_ID`, `CIBA_AUDIENCE`, `CIBA_APPROVER` and `CIBA_CLIENT_KEY_ID` from the object;
    - `CIBA_CLIENT_SECRET` or `CIBA_CLIENT_KEY` (per `credential`) as `secretRef: 'ciba-client-credential'`.
  - **infra/main.dev.bicepparam**: `param ciba = { enabled: false, issuer: '', clientId: '', audience: '', approver: '', credential: 'key', clientKeyId: '' }`.
  - **src/layer2-control/ciba-client.ts**: `CIBA_CREDENTIAL_PLACEHOLDER = "off"`. While off, a credential equal to it is not reported as a stray variable; while on, it is refused, naming the variable.
- [X] T057 [P] Add T-IAC-01 rule 19 to test/infra.test.ts and the specs/011 contracts/cloud-topology.md rule list. Rule 19: the credential only on `ca-l2-eastus2-dev/l2`, from the l2 vault, under the name `ciba.credential` chooses; every other `CIBA_*` from `parameters('ciba')`; `ciba` passed whole; `cibaChecked` holding the `fail()` and each check. Add must-fail mutants: the credential on the agent, a literal credential secret, one fixed credential name, a `CIBA_ISSUER` written in the template, and `main.bicep` without its issuer check. It needs `BICEP_PATH`, like the rest of T-IAC-01.
- [X] T058 Update SPEC.md to v1.8, per plan.md "SPEC and governance changes" and contracts/ledger-backchannel.md:
  - the version row, and a "Changes in 1.8" table;
  - §3.3 (the new credential row), §4.1 (A9) and §7 (`operatorApprovalOnly?`);
  - §5 (`jose` is also used by L2, for the approval token and the client assertion) and §6 (the repository layout gains `ciba-client.ts`, `approval-evidence.ts`, `payment-details.ts`, `backchannel.ts`, `test/helpers/ciba-stub.ts` and `test/helpers/backchannel-l2.ts`);
  - L1-4 (scripted intents are operator-only);
  - L2-4 (table rows), L2-4.3 (the notifications bullet) and L2-5 (the authorize algorithm, the 400 rule and the escalation-read fields);
  - the new L2-7;
  - CFG-2 (the `l2-control.env` row);
  - §11: SEC-17, a forged, replayed or swapped approval (control R5 verification; tests T-CIBA-08, T-CIBA-10), and SEC-18, push fatigue (control: dedupe, the cap, operator-only automation; tests T-CIBA-03, T-CIBA-04, T-E2E-10). Add the v1.8 residual risks: Auth0 trusted to authenticate the approver; the approver's phone; details from the response body when the token lacks them; a stray hosted run notifying once;
  - §12: T-CIBA-01..14, T-ARCH-A9, T-E2E-10, T-E2E-11 and the T-IAC-01 addition.
- [X] T059 [P] Bump .specify/memory/constitution.md from 1.2.0 to 1.3.0 (MINOR), with a Sync Impact Report:
  - Principle V gains a bullet for the approval-service client credential: held by L2 only, confined to one module by rule A9, authentication only, and never payment authority;
  - Technology constraints: `jose` is no longer L1-only (L2 uses it for the approval token and the client assertion), and Auth0 is the approval service, over HTTPS from L2 only;
  - residual risks for 1.3.0: Auth0 trusted to authenticate the approver; the approver's phone as a new place where approvals happen.
- [X] T060 [P] Add "Amended by 012" notes to specs/010-operator-reject-flow/spec.md (NFR-005 and the notification assumption: L2's only outbound connection is to the approval service; operator notification stays pull-based). Add SEC-17 and SEC-18 rows to specs/007-process-isolation-security/contracts/threat-matrix.md. Add the 012 row and its traceability rows (L2-7, SEC-17, SEC-18, T-CIBA-*, T-ARCH-A9, T-E2E-10/11) to specs/README.md.
- [X] T061 [P] Update README.md's human-approval section with the backchannel path (approver's phone, the 2-minute wait, operator fallback, and the reference code), linking specs/012 quickstart.
- [X] T062 [P] Update CLAUDE.md:
  - under "Environment": the `CIBA_*` variables go only in `env/l2-control.env`, and the credential is confined to `ciba-client.ts` (A9);
  - under "Hard rules" item 2: the approval-service credential, next to the CDP one;
  - under "Gotchas": Guardian push needs `requested_expiry` ≤ 300 s; Auth0 `private_key_jwt` is Enterprise-only and RS256, never ES256; the binding message allows no spaces.
- [X] T063 Run test/architecture.test.ts (T-ARCH-TRACE: every test ID named in the threat matrix appears in a test title) and test/images.test.ts (T-IMG-01: the L2 image now imports `jose`). Update `IMAGES` in scripts/image-closure.ts only if T-IMG-01 asks for it.
- [X] T064 Run `npm run check` (typecheck, the full suite, `demo:local`). The demo summary must still print `spent on-chain: 0.006 USDC` and `hash chain ok=true`. With `BICEP_PATH` set, run the full suite again for T-IAC-01. Then run quickstart.md §1.
- [ ] T065 Manual, needs an Auth0 tenant: do quickstart.md §2–§5 against a real tenant and record the five live-check answers in the PR description. If check 3 shows normalization, update contracts/payment-details.md and `detailsEqual` together.

---

## Phase 11: The Auth0 tenant as code (added 2026-11-08, research R17)

**Purpose**: replace the hand-made tenant setup with Terraform under `auth0/`, applied by a tenant administrator.

- [X] T066 [P] Create auth0/versions.tf, variables.tf, main.tf and outputs.tf, per research R17:
  - **Versions**: Terraform `>= 1.11.0`; `auth0/auth0` `>= 1.60.0, < 2.0.0`; the provider takes `domain` from a variable and its credentials from the environment only.
  - **The API**: RS256, `rfc9068_profile`, 300 s tokens, no offline access, `consent_policy = "null"`, `authorization_details { type = local.details_type }`, and `subject_type_authorization` with the user policy `require_client_grant` and the client policy `deny_all`.
  - **L2's client**: `regular_web`, first-party, OIDC-conformant, with `grant_types = ["urn:openid:params:grant-type:ciba"]` and `async_approval_notification_channels = ["guardian-push"]`.
  - **The grant**: a user-delegated `auth0_client_grant` for the type.
  - **The credential**: `auth0_client_credentials` with `private_key_jwt` (RS256 public key from `client_public_key_file`) or `client_secret_post`, the secret write-only from an ephemeral variable.
  - **Guardian**: `auth0_guardian` push, `prevent_destroy`, `manage_guardian` and `guardian_policy = "never"`.
  - **The approver**: `data.auth0_user`.
  - **Outputs**: `bicepparam_ciba`, `l2_env` and `credential_key_id`.
- [X] T067 [P] Create auth0/dev.tfvars.example (no secret) and auth0/README.md: what it makes, what stays by hand, the Management API scopes, and how to run, hand over and rotate.
- [X] T068 [P] Ignore `auth0/.terraform/`, `auth0/*.tfstate`, `auth0/*.tfstate.*`, `auth0/*.tfplan` and `auth0/*.tfvars` (keeping `!auth0/*.tfvars.example`) in .gitignore; exclude `auth0` in .dockerignore.
- [X] T069 Create test/auth0-iac.test.ts, T-IAC-02. `auth0Problems()` checks the sources offline:
  - the provider pin, and credentials taken only from the environment;
  - `local.details_type === DETAILS_TYPE`, the API settings, the CIBA-only client, the grant, the RS256 public-key credential, the write-only ephemeral secret, and Guardian push with `prevent_destroy`;
  - no managed users or passwords, and no private key or JWT anywhere in `auth0/`;
  - `bicepparam_ciba` keys equal to `ciba` in `infra/main.dev.bicepparam`, and the ignores.

  Add 16 must-fail mutants, `terraform fmt -check` when Terraform is installed, and `terraform validate` once `auth0/.terraform` exists.
- [X] T070 Update spec.md (the 2026-11-08 clarifications and the tenant assumption), research R17, plan.md, quickstart §2, SPEC.md v1.8 (§5, §6, §12, §13), the constitution 1.3.0 report, CLAUDE.md, README.md and specs/README.md.
- [ ] T071 Manual, needs the tenant: `plan` and `apply` (since 2026-11-10 through `provision-auth0.yml`, SPEC v1.9; see `auth0/README.md`). Already done on 2026-11-08: `init` (provider 1.60.0, `.terraform.lock.hcl` written; commit it) and `validate` ("The configuration is valid"; T-IAC-02 runs it whenever `.terraform` exists). Fold the results into T065's live check: whether `subject_type = "user"` passes the access policy, `"null"` is standard consent, and push works with `guardian_policy = "never"`.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: no dependencies. T001–T004 run in parallel.
- **Foundational (Phase 2)**:
  - depends on Phase 1;
  - T005, T010 and T012 run in parallel;
  - T007 → T008 → T009 (same file, then its tests);
  - T006 after T005; T011 after T010;
  - T013 → T014 → T015.

  It blocks every story.
- **US1 (Phase 3)**: after Phase 2. It is the MVP.
- **US2 (Phase 4)**: after US1, which provides the start, the poll loop and the wait.
- **US3 (Phase 5)**: after US1. It is independent of US2, except that T028's refusal 409 case needs
  T026.
- **US4 (Phase 6)**: after US1 (T020 already records verification failures; US4 proves them).
- **US5 (Phase 7)**: after US1.
- **US6 (Phase 8)**: after US1. T047, T048 and T049 are independent of the L2 tasks.
- **US7 (Phase 9)**: after US1. Its views cover the entries US2–US6 add, so run it last among the
  stories, or extend its tests as they land.
- **Polish (Phase 10)**: T056–T062 can start after Phase 2. T063 and T064 come after every story.
  T065 comes last and is manual.

### Within each story

The tests are written first and fail. Then the backchannel.ts tasks run in order, since they share
one file, then service.ts, then the docs. Re-run the story's tests at its checkpoint.

### Parallel opportunities

- Phase 1: T001, T002, T003 and T004.
- Phase 2: T005, T010 and T012 together; T006 and T011 once their modules exist.
- Each story has its own test file (`test/backchannel-<story>.test.ts`), sharing
  test/helpers/backchannel-l2.ts. A story's first test task is [P]; later tasks in the same file
  are not.
- US6: T047 (L1), T048 (docs) and T049 (workflow) in parallel with T045 and T046.
- Polish: T056, T057, T059, T060, T061 and T062 in parallel.

## Parallel example: User Story 6

```text
Task: "T047 [US6] operatorApprovalOnly in OrchestratorDeps and src/main.ts --scripted"
Task: "T048 [US6] PaymentIntent.operatorApprovalOnly in docs/l2-control.openapi.yaml"
Task: "T049 [US6] deploy.yml step 8 fails on any ESCALATED step"
Task: "T045 [US6] eligibility() operator_only and capped in backchannel.ts"
```

## Implementation Strategy

### MVP first (User Story 1 only)

1. Phase 1 and Phase 2.
2. Phase 3 (US1): an approval from the phone pays within the same call.
3. **Stop and validate**: T016–T018 pass, `npm run check` is green, and the demo is unchanged.

US1 alone is not shippable to Azure. It fails closed only partly until US5's failure recording,
and it doesn't cap notifications until US6. Ship after US1–US6, with US7 for the operator
experience.

### Incremental delivery

1. Setup and Foundational, then US1 (MVP, local).
2. US2 (refusal), then US3 (expiry, fallback, restart), then US4 (verification proofs). This
   completes P1.
3. US5 (fail closed), then US6 (anti-fatigue and regression). This completes P2 and makes the
   feature safe to turn on.
4. US7 (views and audit), then Polish (Azure, SPEC v1.8, constitution 1.3.0, docs), then the live
   check.

## Notes

- **Requirement IDs.** Each test title carries its ID. Commit messages cite the requirement IDs
  they implement (Constitution, quality gate 5).
- **Must-fail switches.** `skipChecks`, `serializeOutcomes: false` and `approvalRequestCap:
  Infinity` are test-only deps, never env, like 010's `dedupePendingEscalations`.
- **Scope.** Never touch `src/layer2-control/policy.ts`. Never add a tool, route or field to L1
  that reads or decides approvals.
- **Secrets.** Never log a token, a handle, `error_description` or the credential. Add only
  whitelisted fields to entries and events.
