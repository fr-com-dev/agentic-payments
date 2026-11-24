# Specs index: x402 three-layer agent payments

These spec-kit feature specs decompose `SPEC.md` (v1.0 for 001–008, amended through v1.17 by 009, 010,
011, 012, 013, 014, 015 (v1.16, in progress) and 016, through v1.27 by 017, in v1.28 by 018 and in v1.29 by 019 (v1.18–v1.26 have no
feature spec); v1.4 added the L2 API docs without a feature spec), which
remains normative. Project principles live in `.specify/memory/constitution.md` (v3.1.0).
It covers INV-1..13, the definition of done and the governance rules.

| # | Feature | Layer | Functional scope | Main non-functional scope |
|---|---|---|---|---|
| 001 | [agent-paid-fetch](001-agent-paid-fetch/spec.md) | L1 | L1-1..L1-5, §10 (L1 side), T-AGT-01 | INV-1/3, SEC-1/2, no key in agent |
| 002 | [spending-policy-authorization](002-spending-policy-authorization/spec.md) | L2 | L2-1, L2-2 R1–R14 + decide, L2-3, L2-5 authorize/budget, CFG-3, T-POL-*, T-E2E-04 | INV-5/6/8, SEC-3/6, serialized decisions |
| 003 | [audit-ledger-reconciliation](003-audit-ledger-reconciliation/spec.md) | L2 | L2-4, L2-4.1, L2-5 reconcile and ledger/verify, T-LED-*, T-E2E-03/05 | INV-7/9/11, SEC-5/7/9 |
| 004 | [human-approval-escalation](004-human-approval-escalation/spec.md) | L2 + operator | R14, L2-4.2, L2-5 approvals, approve CLI, T-POL-13, T-E2E-02 | INV-12/13, SEC-8 |
| 005 | [settlement-verification](005-settlement-verification/spec.md) | L3 | L3-1 (finality classes), L3-2 (reconcile push, PENDING re-checks) | INV-4/10, SEC-4, timeouts |
| 006 | [counterparty-seller-network](006-counterparty-seller-network/spec.md) | Counterparty | CP-1..CP-5, CFG-1, §10 wire formats | EIP-712 domain correctness |
| 007 | [process-isolation-security](007-process-isolation-security/spec.md) | Cross-cutting | §3.1, §3.3, CFG-2, T-ARCH-* | INV-1..4/13, SEC-1..9 consolidated, residual risks |
| 008 | [local-demo-regression](008-local-demo-regression/spec.md) | Cross-cutting | L1-4 baseline, T-E2E-01, demo, §13, §14 M0–M7 | Definition of done, clean shutdown, §16 gotchas |
| 009 | [cdp-facilitator-base-sepolia](009-cdp-facilitator-base-sepolia/spec.md) | Counterparty (+ L3-1 step 2) | CP-3, CFG-1/2 and §3.3 amended (CDP facilitator on Base Sepolia, CDP API key held only by the seller) | Fail-closed credentials, no silent facilitator fallback, offline baseline unchanged. In SPEC v1.2 |
| 010 | [operator-reject-flow](010-operator-reject-flow/spec.md) | L2 + operator | L2-2 R15, L2-4 entry types, L2-4.2 (one approval per escalation), new L2-4.3 escalation lifecycle, L2-5 rejections and escalation reads, §13 `reject` and `escalations` | Final states never reversed, 300 s expiry, operator notification without outbound calls, no operator text reaches the agent (SEC-12). In SPEC v1.3 |
| 011 | [l1-hosted-agent-azure](011-l1-hosted-agent-azure/spec.md) | L1 + cloud | L1-6 hosted agent service (Mastra on Azure), §3.1 cloud profile, §3.3 requester and cloud model credentials, CFG-2 agent-service rows | Same two tools and no new authority (SEC-1/2/8), requester authentication and session binding (SEC-14/15), L2/L3 private in Azure, telemetry without secrets (SEC-16). One ledger writer (L2-6). In SPEC v1.5 |
| 012 | [ciba-escalation-approval](012-ciba-escalation-approval/spec.md) | L2 (+ L1-4 flag) | L2-7 backchannel approval through OpenID CIBA with Auth0: one approval request per eligible escalation, verified answers recorded with a channel, a bounded 120 s wait in the authorize call; L2-4 entry types, L2-5 authorize algorithm and escalation reads, §7 `operatorApprovalOnly`, CFG-2 `CIBA_*`, §3.3 and rule A9; the Auth0 tenant as Terraform in `auth0/` | Fail closed on any approval-service failure; verification of issuer, signature, approver and exact payment (SEC-17); push fatigue capped (SEC-18); no credential, token or handle in the ledger, logs or responses. In SPEC v1.8 |
| 013 | [l2-portal-onboarding](013-l2-portal-onboarding/spec.md) | L2 + portal (+ L1-6) | L2-8 user accounts and the L2 web portal: self-service onboarding, a profile, one crypto account per user signed by L2 only, registered cards that never pay, and expense policies per seller bounded by platform limits; L2-1 effective mandate, L2-2 R16/R17 and the user daily ceiling, L2-3 keyring, L2-4 entry types and owner filters, L2-5 portal routes, CFG-4, L1-6 user on intents | Off by default; one user never reaches another's data or budget (SEC-19), token separation between the two public services (SEC-20), step-up for loosening (SEC-21), no card data and no key outside their one place (SEC-22, SEC-24), no personal data in the ledger. In SPEC v1.10 |
| 014 | [portal-l2-control-api](014-portal-l2-control-api/spec.md) | L2 + portal | L2-8 the portal's administration area: the rest of the control API that a person uses, for administrators with a separate permission: the pending escalations, approving and rejecting, the events in pages, the budget behind an escalation and the ledger check; L2-4 the `portal` channel on approvals and rejections, L2-4.3 three decision paths over one decision core, L2-5 six administration routes for a sixth role, CFG-2 `PORTAL_ADMIN` | Off by default; authorize and reconcile stay with the agent and L3; L2 checks who may decide (never one's own payment, a fresh identity confirmation for an approval) (SEC-25, SEC-28); a separate credential confined to one module (SEC-27, rule A13); reads write nothing; no typed text reaches L2. In SPEC v1.15 |
| 016 | [agent-auth0-streaming](016-agent-auth0-streaming/spec.md) | L1 + L2 (+ tenant, cloud) | L1-6 callers of the hosted agent from the sign-in tenant only (people with `agent:run`, and machine callers); L1-2 and L2-5 the caller's token forwarded to L2, which verifies it and takes the user from it; §7 `PaymentIntent` names no user; L1-6 the run stream and the docs page's sign-in; L1-5 the smoke client; CFG-2, §3.1 and §3.3 for the agent's client, the machine caller's key and the docs switch | INV-13 as amended (the caller's token is no role token), SEC-13, SEC-14, SEC-20 amended, SEC-32..34, A14, A15, Constitution 2.0.0 (Principle V) |
| 017 | [dast-findings-remediation](017-dast-findings-remediation/spec.md) | Portal + L1 edge | L2-8 limits and headers (HSTS by host name, Permissions-Policy, CORP, COOP, the failed-authentication limit, the bearer challenge), the portal's static files and real 404s, the public configuration and the deployment web build; L1-6 the dev sign-in kept on the machine, the failed-authentication limit and the challenge; the self-hosted front-proxy reference (`docs/self-hosted/`) | SEC-43..SEC-48, the v1.27 residual risks (PKCE `plain` among them), must-fail switches `skipLocalOnly`, `skipFailureLimit`, `skipNotFoundRules` |
| 018 | [tenant-signup-hardening](018-tenant-signup-hardening/spec.md) | Tenant (+ portal, L1-6 tests) | Pentest finding P1: the people's connections declared in `auth0/` (email and password, Google), email-and-password sign-up closed by the connection's own setting so the page stops offering it, Google sign-up public by design on the project's own Google application, connections enabled for the portal's and the agent's clients only; CFG-2 the tenant's variables `google_client_id` and `google_sign_in`; rollout in two steps | SEC-26 rewritten (a role-less Google person reaches only their own account; no Google secret in anything the project keeps; drift shows in the next plan), Constitution 3.0.1. In SPEC v1.28 |
| 019 | [loopback-pkce-sign-in](019-loopback-pkce-sign-in/spec.md) | L1 + L2 + tenant (+ cloud parameters) | A desktop client for the hosted agent: a person signs in from their own computer (browser, loopback return to `127.0.0.1:53682`, PKCE S256, rotating refresh tokens 30 d / 7 d / leeway 0); the tenant's first post-login rule refuses a desktop sign-in or renewal without `x402-agent` or S256; the agent and L2 accept the desktop client's tokens (`AGENT_CLIENT_IDS`); the account question before a person's run (409 `account_not_onboarded` / `account_disabled` / `accounts_off`, 503 `control_unavailable`; L2's `user_accounts_off` and `BudgetStatus.account`); the 401's `error_code`; `client` in the run log; `GET /.well-known/agent-auth` (`AGENT_DESKTOP_CLIENT_ID`) | SEC-49..52 (a captured loopback code, a stolen refresh token, a desktop sign-in without the role, a PKCE downgrade), SEC-45's one exception (the expiry), a refresh token never reaches a service, Constitution 3.1.0, NFR-005 (the question adds at most 1 s). In SPEC v1.29 |

## Traceability (SPEC.md ID → feature)

| SPEC ID | Feature(s) |
|---|---|
| INV-1, INV-2, INV-3 | 007 (owner), 001 (INV-2 covers the wallet mnemonic since 013) |
| INV-4 | 007, 005 |
| INV-5, INV-6, INV-8 | 002 |
| INV-7, INV-9, INV-11 | 003 |
| INV-10 | 005 |
| INV-12 | 004, 002 |
| INV-13 | 007 (owner), 003, 004, 005, 013 (the fifth role, `portal-control`), 014 (the sixth, `portal-admin`), 016 (the caller's token is forwarded to L2 beside a role token and opens nothing by itself) |
| L1-1..L1-3, L1-5 | 001 (L1-5 extended by 011: a second entry point) |
| L1-4 | 001, 008 (seller alias and `--check-baseline` by 011) |
| L1-6 | 011 (the client allow-list by 013; since v1.17 by 016: one issuer for people and machine callers, the caller's token forwarded to L2, the run stream, the docs page's sign-in; since v1.27 by 017: the dev sign-in on the machine only, the failed-authentication limit, the bearer challenge) |
| L2-1, L2-2, L2-3 | 002 (R14 also in 004; R15 in 010; the effective mandate, R16, R17, the user daily ceiling and the keyring in 013) |
| L2-4, L2-4.1 | 003 (entry types added by 010, 012 and 013; owner filters by 013; the `portal` channel by 014) |
| L2-4.2 | 004 (amended by 010) |
| L2-4.3 | 010 (three decision paths over one decision core by 014) |
| L2-6 | 011 |
| L2-7 | 012 (amends 010 NFR-005 and L2-4.3 notifications), 015 (the person the run is for is asked), 016 (owner and subject come from the caller's token) |
| L2-8 | 013 (the administration area by 014; the user of a run from the caller's token, and sign-in required with user accounts, by 016; the portal's edge, its 404s, its public configuration and the deployment build by 017) |
| L2-5 | 002 (authorize, budget), 003 (reconcile, ledger/verify), 004 (approvals), 010 (rejections, escalation reads; approve made state-aware), 013 (`userId` on authorize and budget, the portal routes), 014 (the administration routes), 016 (the caller's token on authorize and budget; no user in a request) |
| L3-1, L3-2 | 005 (L3-1 step 2 amended by 009) |
| CP-1..CP-5 | 006 (CP-3/CP-5 also in 008; CP-1 failure categories and CP-3 amended by 009) |
| CFG-1 | 006, 009 (facilitator selection) |
| CFG-2 | 007 (`USER_ACCOUNTS`, the user-account variables and `portal.env` by 013; `PORTAL_ADMIN` and `PORTAL_ADMIN_TOKEN`, for L2 and for the portal, by 014); the sign-in settings of L2 and of the agent, the machine caller's settings and `API_DOCS_CLIENT_ID` by 016) |
| CFG-3 | 002 |
| CFG-4 | 013 |
| SEC-1..SEC-9 | 007 (consolidated), with detail in 001 (1, 2), 002 (3, 6), 003 (5, 7, 9), 004 (8), 005 (4) |
| SEC-10, SEC-11 | 009 (with 007 for A8 and the threat matrix, 005 for L3-1 step 2) |
| SEC-12 | 010 (with 007 for the threat matrix, 002 for the rule) |
| SEC-14, SEC-15, SEC-16 | 011 (with 007 for the threat matrix) |
| SEC-17, SEC-18 | 012 (with 007 for the threat matrix) |
| SEC-19..SEC-24 | 013 (with 007 for the threat matrix and rules A10–A12, 011 for SEC-20 and SEC-23 on the agent) |
| SEC-27..SEC-29, SEC-8 as amended | 014 (with 007 for the threat matrix and rule A13) |
| T-ADM-01..10, T-LED-07, T-PRT-10..14, T-WEB-09..12, T-ARCH-A13, T-E2E-14, T-IAC-01 rule 22 | 014 |
| SEC-32..SEC-34, SEC-13, SEC-14 and SEC-20 as amended | 016 (with 007 for the threat matrix and rules A14, A15) |
| T-CTK-01..08, T-AGT-08..14, T-API-16..17, T-E2E-15..17, T-ARCH-A14..A15, T-IAC-01 rule 23, T-IAC-02 as amended | 016 |
| SEC-43..SEC-48 | 017 (with 007 for the threat matrix) |
| T-EDGE-01..06, T-PRT-16..18, T-WEB-14..16, T-PROXY-01; T-PRT-01, T-PRT-07, T-PRT-08, T-IMG-03, T-API-05..08 and T-API-12..15 as amended | 017 |
| SEC-26 as rewritten in v1.28, CFG-2 the tenant's `google_client_id` and `google_sign_in` | 018 (with 007 for the threat matrix, 013 for SEC-26's first version) |
| T-PRT-19, T-AGT-15, T-CTK-01 row 5 (a Google person), T-IAC-02 rules 1-8 of `specs/018` contracts/tenant-connections.md | 018 |
| §3.3 the desktop client and refresh tokens, L1-6 the account question, the 401 codes, the client in the run log and the sign-in settings route, L2-5 row 6 `user_accounts_off` and the budget user view's `account`, §7 `BudgetStatus.account`, CFG-2 `AGENT_DESKTOP_CLIENT_ID` and the two-client `AGENT_CLIENT_IDS`, SEC-49..SEC-52, SEC-45's exception | 019 |
| T-AGT-16..20, T-CTK-10..11, T-API-18; T-IAC-01 rule 23, T-IAC-02, T-E2E-16 and T-E2E-17 as amended | 019 |
| §3.1 Azure profile, §3.3 requester and Foundry rows, CFG-2 `l1-hosted.env` | 011 |
| CFG-2 seller.env, §3.3 CDP row, §4.1 A8 | 009, 007 |
| T-CDP-01..09, T-E2E-06 | 009 |
| T-POL-15, T-LED-04, T-E2E-07, T-E2E-08 | 010 |
| T-AGT-02..05, T-AGT-KEY (hosted), T-LED-05, T-E2E-09, T-IAC-01, T-E2E-AZ | 011 |
| T-CIBA-01..14, T-ARCH-A9, T-E2E-10, T-E2E-11, T-IAC-02 (`auth0/`) | 012 |
| T-USR-01..12, T-POL-16..19, T-LED-06, T-PRT-01..09, T-CARD-01..06, T-WEB-01..08, T-API-12..15, T-AGT-06, T-AGT-07, T-ARCH-A10..A12, T-E2E-12, T-E2E-13, T-IAC-01 rule 21 | 013 |
| §3.1 the portal process and Azure unit, §3.3 Portal column, CFG-2 `portal.env` and the user-account variables | 013 |
| T-POL-01..14 | 002 (T-POL-13 also in 004) |
| T-LED-01..03 | 003 |
| T-ARCH-* | 007 (T-ARCH-A8 by 009) |
| T-AGT-01 | 001 |
| T-E2E-01 | 008 (owner), 001, 002, 003, 005, 006 |
| T-E2E-02 | 004 |
| T-E2E-03 | 003 (L2 side), 005 (L3 side) |
| T-E2E-04 | 002, 008 |
| T-E2E-05 | 003, 007 |
| §0, §13, §14, §16 | 008 (§16 EIP-712 name also in 006) |
| §5 stack, §10 wire formats | constitution, 006, 007 |
| EXT-1..EXT-9 | Not specified. Future features, one spec per extension (`/speckit-specify`) |

Each spec tags every FR/NFR with its SPEC source, e.g. `*(SPEC: L2-2 R6, SEC-3)*`.
Each `checklists/requirements.md` records the quality validation.
