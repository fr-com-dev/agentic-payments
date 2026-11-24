# Finding Dispositions: the Portal's DAST Findings

One row per finding of the unauthenticated scan of the self-hosted dev portal (spec FR-027; fields from
[data-model.md](data-model.md) "Finding disposition"). The report itself and the host's name stay outside the
repository. SPEC v1.27 records the controls (§11 SEC-43..SEC-48) and the residual risks ("Residual risks added in
v1.27").

| # | Finding | Severity | Outcome | Requirements | Proof | Reason for anything accepted |
|---|---|---|---|---|---|---|
| 1 | No HSTS | Low | fixed | FR-001, FR-002, FR-003 | T-PRT-16, T-PRT-07 (amended), T-PROXY-01; quickstart §2 ("No HSTS on loopback"), §4 step 1, §5 | — |
| 2 | No throttling on failed API authentication | Low/Info | fixed | FR-007, FR-008, FR-009, FR-010 | T-EDGE-04, T-EDGE-05, T-PRT-08 (amended); quickstart §2 ("Failure limit") | People behind one address share its count (residual): 20 failures there refuse the rest of that minute for all of them |
| 3 | A catch-all answers 200 for any path (soft 404) | Info | fixed | FR-011, FR-012, FR-013, FR-014 | T-PRT-17, T-WEB-14; quickstart §2 ("Soft 404 gone") | — |
| 4 | The dev environment is public; the configuration and the bundle disclose the environment, the administration API and a dev sign-in | Info | fixed in part, accepted in part | FR-004, FR-005, FR-006, FR-018, FR-019, FR-020, FR-021, FR-022 | T-EDGE-01..03, T-PRT-18, T-PRT-01 (amended), T-WEB-15, T-WEB-16, T-IMG-03 (amended), T-PROXY-01; quickstart §2, §3, §4 (the allow-list, applied by the owner on the dev host) | The administration routes' names stay in the client: each is authorized by the portal and by L2, and hiding names is not a control. The dev host's exposure depends on the owner's allow-list, which no test sees |
| 5 | No Permissions-Policy, COOP or CORP | Info | fixed | FR-015, FR-016, FR-017 | T-PRT-16; quickstart §4 "In a browser" steps 1–3 (on the dev host: the sign-in, identity confirmation, card and administration still work) | COEP is not sent: the card vault's frame is not cross-origin isolated (research R9) |
| 6 | Unauthenticated `/healthz`; a `Server`/`Via` proxy banner | Info | fixed in part, accepted in part | FR-021, FR-023 | T-PROXY-01, T-PRT-16 (the health route's headers and body); quickstart §4 (health and docs 404 from outside, no `server` or `via`, the on-host health check) | Only if the Azure profile in `infra/` is deployed again (SPEC 1.26 deleted its environment): its ingress can't filter paths, so `/healthz` and `/readyz` would stay reachable there; they need no token and say only `ok`, `ready` or `starting`, and its probes and the smoke client need them (research R13) |
| 7 | A 401 without `WWW-Authenticate`; the sign-in tenant advertises PKCE `plain` | Info | fixed in part, accepted in part | FR-024, FR-025 | T-EDGE-06; quickstart §2 ("Challenge"), §4 "In a browser" steps 2 and 4 | PKCE `plain` stays: our clients send `S256`, a third party can't make a browser's request use `plain`, no tenant setting to drop it was found, and an Action would also run on refresh-token exchanges (research R14). Changes if Auth0 adds a setting: `auth0/` turns it on |

Must-fail proofs (FR-028): `skipLocalOnly` (T-EDGE-03), `skipFailureLimit` (T-EDGE-04), `skipNotFoundRules`
(T-PRT-17). The checks with no switch (the headers, the challenge, the start-up refusals) were shown by their tests'
first, failing runs, recorded in the pull request.

SC-001 (the report's checks repeated from an allowed address), SC-002 (`403` from an address off the list) and
SC-008 (the portal's flows in a browser) are confirmed only after task T058, by the owner on the dev host, the only
deployment since SPEC 1.26 deleted the Azure environment. Until then this record shows each finding's outcome in the
repository, not on that host.
