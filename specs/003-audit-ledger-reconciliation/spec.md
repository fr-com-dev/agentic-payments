# Feature Specification: Audit Ledger, Committed Spend & Settlement Reconciliation

**Feature Branch**: `003-audit-ledger-reconciliation`

**Created**: 2026-10-16

**Status**: Draft (derived from SPEC.md v1.0, an implemented PoC)

**Input**: Derived from SPEC.md §8.2 (L2-4, L2-4.1, L2-5 reconcile and ledger verify), §4 (INV-7, INV-9, INV-11, INV-13), §11 (SEC-5, SEC-7, SEC-9) and §12 (T-LED-01..03, T-E2E-03, T-E2E-05)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Tamper-evident audit trail (Priority: P1)

An auditor needs every payment-related fact (intent, decision, human approval, settlement report) recorded in an append-only, hash-chained log. Any edit, deletion or reordering is detectable. The control service refuses to start on a ledger whose chain does not verify.

**Why this priority**: Every budget figure and every approval derives from this log. If the log can be silently altered, no other control can be trusted.

**Independent Test**: Write several entries, confirm the chain verifies, edit one stored entry, and confirm that reloading fails with an integrity error (T-LED-01).

**Acceptance Scenarios**:

1. **Given** an empty ledger, **When** the first entry is appended, **Then** its previous-hash is 64 zeros and its sequence number is the first in the chain.
2. **Given** a ledger with N entries, **When** the operator requests chain verification, **Then** the response reports `entries = N` and `ok = true`.
3. **Given** a stored ledger in which any field of any entry was modified, **When** the control service starts, **Then** startup fails with an `integrity` error (T-LED-01).
4. **Given** a broken chain, **When** verification runs, **Then** the response reports `ok = false` and the position of the first broken entry (`brokenAt`).

---

### User Story 2 - Budgets derived from the ledger, released only when safe (Priority: P1)

The payer (mandate owner) needs session and daily budgets that reflect every authorization that can still move money. These figures are computed from the ledger, never from a separately maintained counter. An authorization is released from committed spend only when it is proven unsettled **and** its signature has expired.

**Why this priority**: A stale signature that settles late would bypass the budget if it were released too early (SEC-9).

**Independent Test**: Record an authorization, report it NOT_SETTLED, and check committed spend before and after its `validBefore` time (T-LED-02).

**Acceptance Scenarios**:

1. **Given** an AUTHORIZED entry of 1000 atomic units with no settlement report, **When** committed spend is computed, **Then** it includes 1000.
2. **Given** that authorization has an effective report of NOT_SETTLED and the current time is before `validBefore`, **When** committed spend is computed, **Then** it still includes 1000 (T-LED-02).
3. **Given** the same authorization and the current time is after `validBefore`, **When** committed spend is computed, **Then** it excludes 1000 (T-LED-02).
4. **Given** an authorization whose effective report is PENDING or MISMATCH, **When** committed spend is computed, **Then** it is counted, at any time.

---

### User Story 3 - Settlement reconciliation with sticky confirmation (Priority: P1)

The settlement verifier (L3) reports each settlement outcome to the control layer. The control layer cross-checks the reported asset, payer, payee and amount against what it authorized. It flags contradictions as anomalies and never lets a later report undo a CONFIRMED settlement.

**Why this priority**: This defends against forged or contradictory settlement reports (SEC-5). It keeps the effective settlement status trustworthy for budgets and receipts.

**Independent Test**: After a CONFIRMED settlement, submit a forged report with a different amount. The ledger keeps CONFIRMED as the effective status and records an anomaly naming `amount` (T-E2E-03, T-LED-03).

**Acceptance Scenarios**:

1. **Given** an AUTHORIZED entry, **When** a report arrives whose verified asset, payer, payee and amount match (case-insensitive), **Then** a SETTLEMENT entry is stored with `anomaly: false` and the response is `{ ok: true, anomaly: false }`.
2. **Given** an AUTHORIZED entry, **When** a report's verified amount differs, **Then** a SETTLEMENT entry is stored with status forced to MISMATCH, `anomaly: true`, and a detail naming the mismatching field(s), e.g. `amount` (T-E2E-03).
3. **Given** a non-anomalous CONFIRMED report exists, **When** a later report is not CONFIRMED for the same transaction, **Then** it is stored with `anomaly: true` and the effective status stays CONFIRMED (T-LED-03).
4. **Given** an unknown authorization ID, **When** a report is submitted, **Then** the request is rejected as not found (404).

---

### User Story 4 - Role-separated access to reconciliation and verification (Priority: P2)

Only the settlement verifier may submit settlement reports, and only the human operator may request chain verification. The agent's credential can neither reconcile nor verify.

**Why this priority**: This prevents a compromised agent from fabricating confirmations that would distort budgets or receipts (INV-13).

**Independent Test**: Call reconcile with the agent's credential and expect 401 (T-E2E-05).

**Acceptance Scenarios**:

1. **Given** the agent's credential, **When** it submits a settlement report, **Then** the response is 401 and nothing is appended (T-E2E-05).
2. **Given** the settlement credential, **When** it submits a report, **Then** the report is processed.
3. **Given** any credential other than the operator's, **When** it requests ledger verification, **Then** the response is 401.

---

### Edge Cases

- **Multiple reports for one authorization**: the effective report is the latest non-anomalous SETTLEMENT entry. Anomalous entries never become effective (T-LED-03).
- **A CONFIRMED report repeated for the same transaction**: stored as non-anomalous; the status stays CONFIRMED.
- **A PENDING report later followed by CONFIRMED**: CONFIRMED becomes effective. This is allowed because PENDING is not final.
- **Mismatch on several fields**: the anomaly detail names every mismatching field.
- **Address casing**: asset, payer and payee are compared case-insensitively, so a casing difference alone is not a mismatch.
- **Resource URL with a query string**: the resource key excludes the query, so `/api/weather?city=Lima` and `/api/weather?city=Quito` share a resource key.
- **Truncated or partially written last line in the stored ledger**: the chain fails to verify and startup fails. Silent repair is forbidden.
- **The ledger file is absent at startup**: a new empty ledger starts at the genesis.

## Requirements *(mandatory)*

### Functional Requirements

**Ledger structure**

- **FR-001**: The system MUST record each ledger entry with:
  - a sequence number;
  - an ISO-8601 timestamp;
  - an entry type;
  - an optional session ID, intent ID and authorization ID;
  - a type-specific data object;
  - the previous entry's hash;
  - its own hash.

  *(SPEC: L2-4)*
- **FR-002**: Each entry's hash MUST be the SHA-256 of the canonical serialization of the entry without its own hash field. Canonical serialization sorts object keys recursively at every level and has no whitespace. *(SPEC: L2-4)*
- **FR-003**: The first entry's previous-hash MUST be 64 zero characters. Every later entry's previous-hash MUST equal the hash of the entry before it. *(SPEC: L2-4, INV-9)*
- **FR-004**: The ledger MUST be append-only. No operation may modify or delete an existing entry. New facts are recorded as new entries or new entry types. *(SPEC: INV-9; constitution III)*
- **FR-005**: The system MUST keep one ledger per network, stored as line-delimited JSON. *(SPEC: L2-4)*
- **FR-006**: Chain verification MUST recompute every entry hash and every previous-hash link. It reports the entry count, whether the chain is intact, and the position of the first broken entry if not. *(SPEC: L2-4 verifyChain, L2-5)*
- **FR-007**: The control service MUST refuse to start, with an `integrity` error, when the stored ledger fails chain verification. *(SPEC: L2-4, INV-9, SEC-7, T-LED-01)*

**Entry types**

- **FR-008**: The system MUST write an `INTENT` entry for every authorization request, before deciding. Its data is the resource URL, the agent's purpose text and the offered payment options. *(SPEC: L2-4 table, L2-5 step 1)*
- **FR-009**: The system MUST write an `AUTHORIZED` entry for every AUTHORIZED decision, with these fields:
  - amount, asset, network and payee;
  - payer and `validBefore`;
  - resource URL;
  - mandate ID;
  - approval reference: the consumed approval's approval ID (`apr_…`), or `null` when no approval was used.

  *(SPEC: L2-4 table)*
- **FR-010**: The system MUST write a `DENIED` entry for every DENIED decision, with the violations and the resource key. *(SPEC: L2-4 table)*
- **FR-011**: The system MUST write an `ESCALATED` entry for every ESCALATE decision, with the violations, resource key, payee and amount. *(SPEC: L2-4 table)*
- **FR-012**: The system MUST write a `HUMAN_APPROVAL` entry when an operator approves, with these fields:
  - approval ID (`apr_<uuid>`), escalation ID and resource key;
  - payee and amount;
  - approver;
  - expiry time.

  Behavior is specified in feature 004. *(SPEC: L2-4 table)*
- **FR-013**: The system MUST write a `SETTLEMENT` entry for every reconciled report. It contains the full settlement report plus an `anomaly` flag; the status is forced to MISMATCH on a field mismatch. *(SPEC: L2-4 table)*
- **FR-014**: The resource key MUST be the resource URL's origin plus path, excluding the query string. *(SPEC: L2-4)*

**Committed spend**

- **FR-015**: Committed spend MUST be computed only from ledger entries, optionally filtered by session and by a "since" time. No separately stored mutable counter may exist. *(SPEC: L2-4.1, INV-7)*
- **FR-016**: An authorization's effective settlement report MUST be its latest SETTLEMENT entry with `anomaly` not true. *(SPEC: L2-4.1)*
- **FR-017**: Committed spend MUST be the sum of the amounts of all AUTHORIZED entries in the filter, except those meeting both conditions:
  - the effective report is NOT_SETTLED; and
  - the current time is later than `validBefore` (converted from seconds to milliseconds).

  *(SPEC: L2-4.1, SEC-9, T-LED-02)*
- **FR-018**: Authorizations whose effective report is PENDING or MISMATCH, or that have no report, MUST continue to count toward committed spend. *(SPEC: L2-4.1)*
- **FR-019**: Session budget checks MUST use committed spend for the session. Daily budget checks MUST use committed spend over the trailing 24 hours. The velocity check MUST count AUTHORIZED entries in the trailing 60 seconds. *(SPEC: L2-5 authorize step 3)*

**Reconciliation**

- **FR-020**: The system MUST accept settlement reports from the settlement verifier and look up the AUTHORIZED entry for the report's authorization ID. If none exists, it rejects the report with 404. A malformed report (missing authorization ID or any verified field) MUST be rejected with 400. Neither case appends anything. *(SPEC: L2-5; 400 via 008 T000)*
- **FR-021**: The system MUST compare the report's verified asset, payer, payee and amount with the authorization's data, case-insensitively. On any difference, it stores the entry with status MISMATCH, `anomaly: true`, and a detail naming every differing field. *(SPEC: L2-5 reconcile step 2, SEC-5, T-E2E-03)*
- **FR-022**: Suppose the fields match, a non-anomalous CONFIRMED entry already exists for the authorization, and the new report is not CONFIRMED for the same transaction. The system MUST then store the new report with `anomaly: true`. *(SPEC: L2-5 reconcile step 3, INV-11)*
- **FR-023**: Otherwise the system MUST store the report with `anomaly: false`. *(SPEC: L2-5 reconcile step 4)*
- **FR-024**: A successful reconcile MUST respond with `{ ok, anomaly }`, where `anomaly` reflects the stored flag. *(SPEC: L2-5)*
- **FR-025**: Once an authorization's effective status is CONFIRMED, no later report may change it. *(SPEC: INV-11, T-E2E-03, T-LED-03)*

**Ledger verification endpoint**

- **FR-026**: The system MUST expose a chain verification operation to the human operator. It returns `{ entries, ok, brokenAt? }`. *(SPEC: L2-5)*

### Non-Functional Requirements

- **NFR-001 (Security, role separation)**: Reconcile MUST accept only the settlement credential. Ledger verification MUST accept only the operator credential. Any other credential, including the agent's, receives 401 and nothing is appended. *(SPEC: INV-13, SEC-5, T-E2E-05)*
- **NFR-002 (Security, network exposure)**: The control service MUST listen only on the loopback interface. *(SPEC: L2-5)*
- **NFR-003 (Integrity)**: Altering any single byte of any stored entry's content MUST be detected by chain verification and at startup. *(SPEC: SEC-7, T-LED-01)*
- **NFR-004 (Concurrency)**: Entries written during an authorization MUST be appended inside the serialized authorize section. Sequence numbers and hash links therefore stay strictly ordered under concurrent requests. *(SPEC: INV-8, L2-5)*
- **NFR-005 (Reliability, conservatism)**: When the settlement status is uncertain (missing, PENDING, MISMATCH), the system MUST err toward counting spend, never toward releasing it. *(SPEC: L2-4.1, SEC-9)*
- **NFR-006 (Money precision)**: Every amount in entries and committed-spend sums MUST be an atomic-unit decimal string, summed with exact integer arithmetic. *(SPEC: §7, constitution VI)*
- **NFR-007 (Determinism)**: The committed-spend computation MUST take the current time as an input. The same ledger and time always produce the same figure. *(SPEC: L2-4.1)*
- **NFR-008 (Auditability)**: Every authorization request MUST leave at least two entries: INTENT plus exactly one of AUTHORIZED, DENIED or ESCALATED. Every reconcile MUST leave one SETTLEMENT entry. *(SPEC: L2-4 table, L2-5)*

### Key Entities

- **Ledger Entry**: an immutable, hash-linked record. It has a sequence number, timestamp, type (INTENT, AUTHORIZED, DENIED, ESCALATED, HUMAN_APPROVAL, SETTLEMENT), correlation IDs (session, intent, authorization), a data payload, a previous-hash and a hash.
- **Resource Key**: origin plus path of a resource URL. It groups escalations and approvals for one resource independently of query parameters.
- **Effective Settlement Report**: the latest non-anomalous SETTLEMENT entry for an authorization. It drives committed spend and the receipt status.
- **Committed Spend**: a derived figure, the amount still able to move money. It is filtered by session and/or time window.
- **Chain Verification Result**: the entry count, whether the chain is intact, and the first broken position.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of single-entry edits to a stored ledger are detected at startup (T-LED-01).
- **SC-002**: After the scripted regression run, committed session spend equals exactly 6000 atomic units ($0.006). The ledger holds exactly 2 non-anomalous CONFIRMED settlements, and chain verification reports `ok = true` (T-E2E-01).
- **SC-003**: A NOT_SETTLED authorization is released from committed spend only after its `validBefore`, never before (T-LED-02).
- **SC-004**: A forged settlement report after confirmation leaves the effective status CONFIRMED in 100% of cases, and the anomaly names the mismatching field (T-E2E-03, T-LED-03).
- **SC-005**: 100% of reconcile attempts with the agent's credential are rejected with 401 (T-E2E-05).
- **SC-006**: Every authorization request in a run is traceable from INTENT to its decision, and every AUTHORIZED decision to its effective settlement, through shared IDs.

## Assumptions

- The ledger is a single-node, file-based log; a durable database is out of scope (EXT-6). Concurrent writers from multiple processes are not supported.
- `validBefore` is expressed in seconds and the current time in milliseconds. The release comparison converts between them.
- `brokenAt` is the 0-based line index of the first line that fails to parse, recompute its hash, or link to the previous hash. On an untampered prefix it equals that entry's sequence number.
- The authorization and policy flow that writes INTENT/AUTHORIZED/DENIED/ESCALATED is specified in feature 002. Approvals are in feature 004. The settlement verifier that produces reports is in feature 005. Credential separation as a whole is in feature 007.
- Refunds and disputes (EXT-9) are out of scope. No entry type for them exists in v1.
- HOW (hashing details, file location, algorithm steps) is normative in SPEC.md §8.2 L2-4 and L2-5.
