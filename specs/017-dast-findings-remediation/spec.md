# Feature Specification: Remediation of the Portal's DAST Findings

**Feature Branch**: `claude/spec-17-dast-findings-42d580`

**Created**: 2026-11-23

**Status**: Draft

**Input**: User description: "implement spec-17.md to resolve all findings in DAST report". The report is an
unauthenticated, non-destructive black-box scan of the dev host, dated 2026-11-24 (UTC), kept outside the
repository. It found nothing critical, high or medium: one low-severity gap (no HSTS), one low/informational
item (no throttling seen on failed authentication) and five informational items. Its seven findings, and what
it says about each, are carried into the sections below. The dev host's name is left out of this repository on
purpose.

## Clarifications

### Session 2026-11-23

- Q: Should the dev host stay reachable from the whole internet (it runs the local network profile, test money
  only, and the tenant's sign-ups are open by default)? → A: No. The reference proxy configuration admits only
  an allow-list of addresses or a private network (a VPN), and refuses everyone else at the proxy. Rejected:
  keeping it public and closing the tenant's sign-ups (it would also change the Azure dev portal, which shares
  the tenant), and keeping it public with the risk recorded.

## What the scan saw, and why

The dev host is the portal (SPEC L2-8) run with the local network profile and the Auth0 dev tenant, behind a
front proxy (Caddy) that this repository does not manage. Several findings follow from that combination rather
than from the deployed Azure portal, which already sends HSTS and counts each client by its own address.

| # | Finding (severity) | Cause today | Resolution in this feature |
|---|---|---|---|
| 1 | No Strict-Transport-Security header (Low) | The portal sends HSTS only off the local network profile, and the dev host runs the local profile | HSTS on every response to a non-loopback host name, whatever the profile; the reference proxy configuration sends it too (US1) |
| 2 | No throttling seen on repeated failed authentication (Low/Info) | A per-address limit of 300 a minute exists, so 40 requests stayed under it; behind an undeclared proxy every client also shares the proxy's one address | A separate, much lower limit on failed authentications per address, a log event when an address reaches it, and a warning when a proxy is in front but not declared (US3) |
| 3 | Any path answers 200 with the web app's page (Info) | The portal sends its page for every path it has no file for | The page with 200 only for the web app's own screens; 404 for anything else, and a bare 404 for missing built files and dot-paths (US5) |
| 4 | Dev environment public; public configuration and the client disclose the environment, a dev sign-in and the administration routes (Info) | The local dev sign-in is limited to the local network profile, not to the machine; the public configuration carries fields the web app doesn't need before sign-in; every build carries the pasted-token sign-in | The dev sign-in refuses anything that doesn't come from the machine itself (US2); the public configuration shrinks and deployment builds drop the dev sign-in (US7); the dev host is no longer public: the reference proxy configuration admits only an allow-list or a private network (US4) |
| 5 | No Permissions-Policy, Cross-Origin-Opener-Policy or Cross-Origin-Resource-Policy (Info) | Never set | All three, chosen so the sign-in pop-up and card registration keep working (US6) |
| 6 | Unauthenticated health route; the proxy names itself (Info) | The health routes are token-free by design (platform probes); the banner is the proxy's | Health routes kept and answering status only; the reference proxy configuration doesn't forward them from outside and drops its banner (US4) |
| 7 | 401 without WWW-Authenticate; the tenant advertises PKCE `plain` (Info) | Never set; `plain` is the tenant's default and the portal's sign-in library sends `S256` | The bearer challenge on every 401; `plain` recorded as an accepted residual with its reason (US8) |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A visitor's connection to the portal can't be downgraded to plain HTTP (Priority: P1)

A person opens the portal at a public address. After their first secure visit, their browser refuses to talk to
that address over plain HTTP for at least a year, so a network attacker can't strip the connection and capture
the sign-in or a bearer token on a later visit. This holds for the dev host as it does for Azure.

**Why this priority**: It is the report's only Low finding with a CVSS score, and the portal controls payment
policies. The fix is small and has no dependency on the other stories.

**Independent Test**: Start the portal with the local network profile, send a request addressed to a public host
name and one addressed to `localhost`; the first answer carries HSTS with a year and `includeSubDomains`, the
second carries none.

**Acceptance Scenarios**:

1. **Given** a portal on any network profile, **When** a request addressed to a non-loopback host name gets any
   answer (page, built file, API, health, error), **Then** that answer carries
   `Strict-Transport-Security: max-age=31536000; includeSubDomains`.
2. **Given** a portal on the local machine, **When** a request is addressed to `localhost`, `127.0.0.1` or
   `[::1]`, **Then** the answer carries no HSTS, so a developer's other local servers are never pinned to HTTPS.
3. **Given** the reference proxy configuration, **When** the proxy answers a plain-HTTP request, **Then** it
   redirects to HTTPS permanently, and every HTTPS answer it gives, its own included, carries the same HSTS.

---

### User Story 2 - The local dev sign-in is never reachable from outside the machine (Priority: P1)

The local dev sign-in, where a pasted token from the local dev issuer is accepted, exists for a developer on
their own machine. If a portal or hosted agent in that mode is ever bound to a public interface, put behind a
proxy or reached through a public host name, it refuses, so a configuration mistake can't turn development
tokens into access from the internet.

**Why this priority**: The report calls configuration drift into dev sign-in "the real risk" of finding 4. The
dev host already runs the local network profile, the one place where the dev sign-in is allowed, so one changed
setting would expose it.

**Independent Test**: Start the portal with the dev sign-in in each refused configuration and see it stop; start
it on loopback and send requests with a public host name, with forwarding headers and with a loopback host name;
only the last is served.

**Acceptance Scenarios**:

1. **Given** the dev sign-in, **When** the portal or the hosted agent is configured to bind a non-loopback
   address, or to trust a proxy in front of it, **Then** it refuses to start, naming the setting and never its
   value.
2. **Given** a portal or hosted agent running with the dev sign-in on loopback, **When** a request names a host
   other than `localhost`, `127.0.0.1` or `[::1]` (any port), names none, or carries any forwarding header
   (`Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `Via`), **Then** it is refused before
   any token is read, with 421 and a body that doesn't mention the sign-in mode.
3. **Given** the same service, **When** a developer's browser, a test or the local stack calls it on a loopback
   name without forwarding headers, **Then** it works exactly as before.
4. **Given** the Auth0 sign-in (not the dev sign-in), **When** the portal runs behind a proxy, **Then** none of
   these checks apply.

---

### User Story 3 - Repeated failed authentications from one address are slowed down and noticed (Priority: P2)

Someone sends a stream of requests with forged, expired or missing tokens to the portal or the hosted agent. After
a small number of failures in a minute, that address is refused before any token is checked until the minute
ends, and the operator sees one log line saying an address crossed the limit. People with valid tokens elsewhere
see no change.

**Why this priority**: Signed tokens can't be brute-forced, so the direct risk is small (the report scores it
0.0–3.1), but cheap floods of signature checks and the absence of any signal on a burst of 401s are worth
closing.

**Independent Test**: From one address send failed authentications until refused; the next request is 429 with
Retry-After even with a valid token; a request from another address with a valid token is served; the log has
one burst line and no token, address or path value.

**Acceptance Scenarios**:

1. **Given** an address that has had 20 requests refused as unauthenticated (401) by a service in the current
   minute, **When** it sends any further request to that service's API, **Then** the service answers 429 with
   Retry-After until the minute ends, without verifying a token.
2. **Given** a request that authenticates, **When** it is counted, **Then** it never counts as a failure, and the
   existing per-address (300 a minute) and per-person limits stay as they are.
3. **Given** an address that crosses the failure limit, **When** it does, **Then** the service writes one log line
   for that address in that window, naming the event and the count, and never the token, the address or any path
   or body value.
4. **Given** a service with no proxy declared, **When** a request arrives carrying a forwarding header, **Then** the
   service writes one warning per service instance that a proxy seems to be in front of it undeclared (so every client
   shares one count), and serves the request as before.
5. **Given** the portal's public configuration and its health routes, **When** they are called, **Then** they never
   count toward either limit's failures.

---

### User Story 4 - Only the owner's allow-list reaches the dev host, through a proxy set up from a reference (Priority: P2)

The owner runs the dev host's front proxy themselves. The repository gives them a reference proxy configuration
and a short procedure that make a self-hosted portal match what this feature promises: only addresses on the
owner's allow-list, or a private network, get through; HTTPS only with HSTS; no proxy banner; health and docs
routes not reachable from outside; the client's address passed the way the portal expects. The procedure ends
with a re-test from a direct connection, because the scan's own network intercepted TLS.

**Why this priority**: The report's second action is "decide whether the dev host must be public"; the owner
decided it must not be (Clarifications). Findings 1, 4 and 6 are only fully closed at the proxy, which no code in
this repository runs.

**Independent Test**: Run the reference configuration in front of a local portal and check the answers' headers,
the refusals of the health and docs routes from outside, the redirect from HTTP, and that a client whose address
is not on the allow-list is refused while one on it is served.

**Acceptance Scenarios**:

1. **Given** the reference configuration, **When** a client outside calls `/healthz`, `/readyz` or `/docs`,
   **Then** the proxy answers 404 without forwarding it, while the portal's own probes still reach them directly.
2. **Given** the reference configuration, **When** it answers anything, **Then** the answer carries no `Server` and
   no `Via` header naming the proxy.
3. **Given** the reference configuration, **When** it forwards a request, **Then** it passes the client's address so
   the portal, declared behind exactly one proxy, counts each client by its own address.
4. **Given** the reference configuration, **When** a client whose address is neither on the owner's allow-list nor
   on the private network connects, **Then** the proxy refuses it with 403, over HTTPS and plain HTTP alike,
   without forwarding anything to the portal; a client on the list is served. An empty list refuses everyone.
5. **Given** the procedure, **When** the owner follows it after deploying, **Then** they have checked from a direct
   connection the HSTS header, the certificate and TLS versions, and that only the proxy's web ports answer (not
   the proxy's admin port or the portal's own port).

---

### User Story 5 - A path that isn't part of the portal answers "not found" (Priority: P3)

A scanner, a crawler or a person with a mistyped link asks for a path that is neither an API route, a built file
nor a screen of the web app. The portal answers 404. A person in a browser still sees the web app's own "Not
found" screen; a missing built file or a dot-path gets a bare 404.

**Why this priority**: Not a vulnerability: it removes scanner false positives, keeps real 404s visible to
monitoring and stops crawlers indexing junk.

**Independent Test**: Request each path of a fixed probe list (56 sensitive paths and 8 traversal payloads that
cover the report's named examples and the families it probed): all 404. Request
every screen address of the web app: all 200 with the page.

**Acceptance Scenarios**:

1. **Given** a screen of the web app (fixed, like `/policies`, or with a value, like `/policies/<id>/history`,
   with or without a trailing slash), **When** it is requested with GET or HEAD, **Then** the portal answers 200
   with the web app's page.
2. **Given** any other path outside the API, **When** it is requested, **Then** the portal answers 404; a browser
   navigation gets the web app's page with that 404 status, so the app shows its "Not found" screen.
3. **Given** a path under the built files' folder that names no file, or any path with a segment starting with a
   dot, or an encoded traversal, **When** it is requested, **Then** the portal answers a bare 404 with no page and
   serves no file.
4. **Given** the web app's screen list and the portal's, **When** a screen is added to one and not the other,
   **Then** a test fails.

---

### User Story 6 - Browsers are told which features and cross-origin uses the portal allows (Priority: P3)

The portal's answers tell the browser that the page uses no camera, microphone or location, may use payment
features only for itself and the card provider, can't be read as a resource by other origins, and keeps its
window apart from other origins except the sign-in pop-up it opens itself.

**Why this priority**: Defense in depth on top of an already strict content policy; nothing is exploitable today.

**Independent Test**: Check the three headers on a page, a built file, an API answer and an error; then sign in
through the pop-up and register a test card in a real browser.

**Acceptance Scenarios**:

1. **Given** any portal answer, **When** it is sent, **Then** it carries a Permissions-Policy that disables at least
   camera, microphone, geolocation, screen capture and device access (USB, serial, HID), and allows payment only
   for the portal itself and the card provider's script origin.
2. **Given** any portal answer, **When** it is sent, **Then** it carries `Cross-Origin-Resource-Policy: same-origin`
   and `Cross-Origin-Opener-Policy: same-origin-allow-popups`.
3. **Given** the deployed portal with these headers, **When** a person signs in through the pop-up, signs out,
   confirms their identity, and registers a test card, **Then** each works as before.
4. **Given** the existing content policy and headers, **When** this feature lands, **Then** they are unchanged.

---

### User Story 7 - A stranger learns from the portal only what sign-in needs (Priority: P3)

Before anyone signs in, the portal's public configuration says only what the web app needs to start a sign-in:
the sign-in mode, the tenant's domain, the client ID, the audience, and whether cards are on. It no longer names
the network profile or says whether the administration area is on; a signed-in administrator learns that from
their own access, as today. A web app built for a deployment carries no pasted-token sign-in.

**Why this priority**: Reconnaissance value only, as the report says; the server rejects every forged token.

**Independent Test**: Call the public configuration and compare its fields; search a deployment build for the
dev sign-in's text; sign in as an administrator and as an ordinary user and see the administration area appear
only for the first.

**Acceptance Scenarios**:

1. **Given** any portal, **When** the public configuration is requested, **Then** it carries the sign-in mode,
   domain, client ID, audience and card availability (with the card provider's publishable key when cards are
   on), and nothing else.
2. **Given** an administrator who signs in where the administration area is on, **When** the web app starts,
   **Then** it shows the administration area; for anyone else, or where the area is off, it doesn't.
3. **Given** a web app build made for a deployment (every image's), **When** its files are searched, **Then** they
   contain no pasted-token sign-in; a local build keeps it, and works only where User Story 2 allows it.

---

### User Story 8 - A refused caller is told how to authenticate, and the tenant's PKCE residual is recorded (Priority: P3)

A client refused for a missing or invalid token is told, in the standard way, that the API wants a bearer token.
The tenant's advertising of PKCE `plain` is written down as an accepted residual, with why it is acceptable and
what would change it.

**Why this priority**: Protocol hygiene; no exploit path.

**Independent Test**: Send no token and a bad token to the portal and the hosted agent; each 401 carries the
challenge, with `invalid_token` only for the second.

**Acceptance Scenarios**:

1. **Given** a request to the portal's or the hosted agent's API without a token, **When** it is refused with
   401, **Then** the answer carries `WWW-Authenticate: Bearer` with the service's realm.
2. **Given** a request with a token that is refused with 401, **When** it is answered, **Then** the challenge adds
   `error="invalid_token"` and nothing that says which check failed.
3. **Given** a 403, a 429 or any other refusal, **When** it is answered, **Then** it carries no challenge.
4. **Given** the tenant's metadata, **When** it lists `plain` among the PKCE methods, **Then** the security
   section records it as a residual: the portal's sign-in sends `S256`, the tenant offers no setting to stop
   advertising `plain`, and the tenant's managed configuration turns it off if one appears.

---

### Edge Cases

- Several people behind one carrier or office address: the failure limit refuses all of them for the rest of
  the minute once 20 failures came from that address, valid tokens included, because the point is to refuse
  before checking a token. Normal use makes far fewer: the web app renews tokens before they expire.
- A request with no `Authorization` header to an API route counts as a failure (the scan's probes did this);
  the public configuration and the health routes never do.
- A proxy that rewrites the host name to `localhost` in front of a dev sign-in still adds a forwarding header,
  so it is refused; one configured to drop every forwarding header as well defeats the request check, which is
  why the start-up check refuses a declared proxy and a non-loopback bind too. The residual is recorded.
- A host name of `localhost` with a port, upper case, or a trailing dot counts as loopback; `127.0.0.2`,
  `0.0.0.0` and a public name that resolves to loopback do not.
- A container that binds all interfaces with the dev sign-in is refused at start-up; the local stack never runs
  the portal or the agent that way today.
- A deep link to a screen with a value that doesn't exist (`/policies/unknown`) answers 200: the portal can't
  know which values exist, and the web app shows its own "Not found".
- `/index.html` is a built file and answers 200; `/assets/` with a missing name, `/.env`, `/.git/HEAD`,
  `/x/.hidden` and `/assets/..%2f..%2fetc/passwd` answer a bare 404.
- A browser on which `same-origin-allow-popups` stops the sign-in pop-up from answering: the deployed check in
  User Story 6 fails, and the plan must choose another value before the feature is done.
- The deployed Azure portal already sends HSTS and trusts one proxy: nothing changes there but the new headers,
  the failure limit, the challenge, the smaller public configuration and the 404s.
- In Azure the ingress can't filter paths, so the health routes stay reachable from the internet there; they
  say only `ok`, `ready` or `starting`, and that is recorded.
- The owner on a phone's mobile network has no fixed address: they reach the dev host through the private
  network. Approvals by Guardian push don't need the portal and keep working from anywhere.
- The sign-in pop-up talks to the tenant directly from the browser, so the allow-list doesn't affect it; only
  the portal's own address is restricted.
- The allow-list holds client addresses, which are personal data: it lives in the owner's proxy setup, never in
  the repository, a log line or a test.

## Requirements *(mandatory)*

### Functional Requirements

**Transport (finding 1)**

- **FR-001**: The portal MUST send `Strict-Transport-Security: max-age=31536000; includeSubDomains` on every answer
  to a request addressed to a host name other than `localhost`, `127.0.0.1` or `[::1]`, on every network profile
  and whether or not a proxy is declared.
- **FR-002**: The portal MUST NOT send HSTS on an answer to a request addressed to a loopback name.
- **FR-003**: The reference proxy configuration MUST redirect plain HTTP to HTTPS permanently and send the same
  HSTS value on every HTTPS answer. Preload is not requested (it is a decision for the whole domain).

**The dev sign-in stays on the machine (finding 4)**

- **FR-004**: With the local dev sign-in, the portal and the hosted agent MUST refuse to start when configured to
  bind an address other than a loopback one, or to trust any proxy in front of them. The refusal names the
  setting and never its value.
- **FR-005**: With the local dev sign-in, the portal and the hosted agent MUST refuse, before any token is read and
  with 421, every request whose host name is not a loopback name, that has no host name, or that carries any of
  `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto` or `Via`. The body MUST NOT mention the
  sign-in mode.
- **FR-006**: With the Auth0 sign-in, FR-004 and FR-005 MUST NOT apply.

**Failed authentication (finding 2)**

- **FR-007**: The portal and the hosted agent MUST each count, per client address, the requests their API refuses
  with 401. Once an address has 20 in the current minute, every further API request from it MUST be answered 429
  with Retry-After until the minute ends, before any token is verified.
- **FR-008**: Requests that authenticate MUST NOT count as failures. The existing limit of 300 requests a minute
  per address and the per-person limits MUST stay as they are. The public configuration and the health and docs
  routes MUST NOT count.
- **FR-009**: When an address reaches the failure limit, the service MUST write one log line for that address in
  that window, with the event's name and the count, and MUST NOT write the token, the address, or any path, query
  or body value.
- **FR-010**: When no proxy is declared and a request carries a forwarding header, the service MUST write one
  warning per service instance saying a proxy seems undeclared, and MUST otherwise serve the request as it does today
  (except under FR-005).

**Not found (finding 3)**

- **FR-011**: The portal MUST answer GET and HEAD for each screen address of the web app (fixed and with a value,
  with or without a trailing slash) with 200 and the web app's page.
- **FR-012**: The portal MUST answer 404 for every other path outside its API and its built files. A request that
  accepts HTML (a browser navigation) MUST get the web app's page with that 404 status; any other gets a bare 404.
- **FR-013**: The portal MUST answer a bare 404, with no page and no file, for a path under the built files'
  folder that names no file, for any path with a segment that starts with a dot, and for an encoded traversal.
- **FR-014**: A test MUST fail when the web app's screen list and the portal's list of screen addresses differ.

**Browser policies (finding 5)**

- **FR-015**: Every portal answer MUST carry a Permissions-Policy that disables at least camera, microphone,
  geolocation, screen capture and device access (USB, serial, HID), and allows payment only for the portal itself
  and the card provider's script origin.
- **FR-016**: Every portal answer MUST carry `Cross-Origin-Resource-Policy: same-origin` and
  `Cross-Origin-Opener-Policy: same-origin-allow-popups`.
- **FR-017**: The content policy, `X-Content-Type-Options`, `Referrer-Policy` and the API's `Cache-Control` MUST stay
  as they are.

**What a stranger learns (finding 4)**

- **FR-018**: The portal's public configuration MUST carry only the sign-in mode, the tenant's domain, the client
  ID, the audience and the card availability (with the publishable key when cards are on). It MUST NOT carry the
  network profile or whether the administration area is on.
- **FR-019**: The web app MUST show the administration area only from the signed-in person's own access answer,
  which already says whether they are an administrator where the area is on.
- **FR-020**: Every web app build that a deployment serves (every image's build, and the self-hosted procedure's)
  MUST NOT contain the pasted-token sign-in. A local build, and a check build that is never served (the pipelines'
  step 1), MAY keep it.

**The front proxy and the health routes (findings 4 and 6)**

- **FR-021**: The repository MUST provide a reference front-proxy configuration for a self-hosted public portal
  that: meets FR-003; answers 404 from outside for `/healthz`, `/readyz` and `/docs` without
  forwarding them; sends no `Server` or `Via` header naming itself; passes the client's address as the one proxy
  the portal is declared to trust; and admits only an allow-list of addresses or a private network, refusing
  everyone else with 403 before forwarding anything. The list is the owner's and lives outside the repository;
  the reference ships it empty, which refuses everyone.
- **FR-022**: The repository MUST provide a procedure that sets up a self-hosted public portal with that
  configuration (the portal declared behind exactly one proxy, bound to loopback, Auth0 sign-in) and ends with a
  re-test from a direct connection: HSTS present, certificate and TLS versions, and only the proxy's web ports
  reachable.
- **FR-023**: The portal's and the hosted agent's health routes MUST stay token-free and say only their status.

**Authentication challenge and PKCE (finding 7)**

- **FR-024**: Every 401 from the portal's and the hosted agent's API MUST carry `WWW-Authenticate: Bearer` with the
  service's realm, adding `error="invalid_token"` when a token was presented, and nothing that says which check
  failed. Other statuses MUST NOT carry it.
- **FR-025**: The security section MUST record PKCE `plain` on the tenant as an accepted residual, with the reason
  and the change that would remove it.

**Contracts, records and proof**

- **FR-026**: SPEC.md (a new version with its "Changes" section, the portal's and the agent's sections, the
  security section's new rows and residuals), the portal's and the agent's API documents and contracts, and the
  specs index MUST describe the new headers, the 421, the 429 for failures, the challenge, the 404s and the smaller
  public configuration. The API document tests MUST pass against the services.
- **FR-027**: Each of the seven findings MUST have a recorded disposition (fixed, with the test or check that
  shows it; or accepted, with the reason), kept with this feature.
- **FR-028**: Each new safety check (the dev sign-in guards, the failure limit, the 404 rules) MUST have a test
  that fails when the check is switched off through a test-only dependency, never an environment setting. The
  headers and the challenge MUST be checked on every kind of answer (page, built file, API, health, error), and
  the deployment build against a default build that does contain the dev sign-in. (Amended by the plan,
  2026-11-23: a switch that only removes a header proves nothing the assertion doesn't.)

### Non-Functional Requirements

- **NFR-001**: Local work MUST be unchanged: `demo:local`'s summary, the local stack, the VS Code runner, and dev
  tokens pasted into a portal or agent reached on `localhost`.
- **NFR-002**: The deployed portal's sign-in pop-up, sign-out, identity confirmation, card registration and
  administrator decisions MUST keep working with the new headers.
- **NFR-003**: No new secret and no new required setting. Nothing new in a log names a person, a token or a
  client address.
- **NFR-004**: Every new check MUST fail closed: when the service can't tell whether a request is local, it
  refuses under FR-005.

### Key Entities

- **Finding disposition**: one per DAST finding: its number and severity, fixed or accepted, the requirement that
  resolves it, and the test or manual check that shows it.
- **Failure count**: per client address and per one-minute window, the number of 401s a service gave; it decides
  the 429 and the one burst log line.
- **Screen address list**: the web app's screens, fixed and with a value, which decide where the portal answers 200
  with its page.
- **Reference proxy configuration**: the self-hosted front proxy's settings and the procedure around them; the
  owner adapts them to their host.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A repeat of the report's unauthenticated checks, from an address on the allow-list, against a portal
  set up by the procedure gives no finding of Low severity or above, and all seven findings have a recorded
  disposition (7 of 7).
- **SC-002**: From an address off the allow-list, 100% of requests to the dev host are refused at the proxy and
  none reaches the portal.
- **SC-003**: 100% of answers to a non-loopback host name carry HSTS with at least a year; 0% of answers to a
  loopback name do.
- **SC-004**: From one address, the 21st failed authentication in a minute is refused without a token check, as
  is every later request from it in that minute; a valid caller at another address is served every time, and
  exactly one burst line is logged.
- **SC-005**: A fixed probe list of 56 sensitive paths and 8 traversal payloads, covering the report's named
  examples and the families it probed, answers 404 throughout; every screen of the web
  app still opens on a direct visit.
- **SC-006**: With the dev sign-in, 100% of refused configurations stop the service at start-up, and 0 requests
  through a public host name or a proxy are served.
- **SC-007**: 100% of 401 answers from the two public services carry the bearer challenge.
- **SC-008**: On the deployed portal, a person signs in, confirms their identity, registers a test card and signs
  out with the new headers in place, in one attempt each.
- **SC-009**: The project's definition-of-done check stays green and the local demo's summary is unchanged.

## Assumptions

- The dev host is a portal on the local network profile with the Auth0 dev tenant, behind a front proxy the owner
  runs; its exact proxy configuration is theirs, and the reference configuration is a starting point for it.
  Applying it to the dev host, the allow-list included, is the owner's step, done by hand after this feature
  lands.
- The tenant's sign-ups stay as they are (open by default): with the dev host off the public internet, a stranger
  who signs up has no portal to use there. The Azure dev portal, which shares the tenant, is unchanged; the
  tenant review in the follow-ups below covers sign-ups for it.
- The hosted agent is included for the dev sign-in guards (FR-004/005), the failure limit (FR-007..010) and the
  challenge (FR-024), because it shares those checks with the portal and faces the internet too. L2, L3, the
  seller and the operator are out of scope: they are not public, or have their own limits, and the scan didn't
  reach them.
- 20 failed authentications per address per minute is far above what a person's browser makes (it renews tokens
  before they expire) and far below the existing limit of 300; it needs no setting.
- As far as is known, the tenant offers no setting to stop advertising PKCE `plain`, and the portal's sign-in
  library always sends `S256`; planning confirms both, and if a setting exists it is turned off instead of
  recorded.
- The scan's network terminated TLS, so its view of headers and TLS is checked again from a direct connection
  (FR-022).
- The administration routes' names in the client are not hidden: every one is authorized by the portal and again
  by L2 (`specs/014`), and hiding names is not a control. This is part of finding 4's disposition.
- Out of scope, as the report's own limitations, each a follow-up: an authenticated test with one normal and one
  administrator account (the report's largest gap: object-level access, the administrator's permission, mass
  assignment, policy limits, the identity confirmation); TLS and exposed ports from an unproxied network beyond
  FR-022's checks; a review of the tenant (sign-ups, brute-force protection, second factor, callback addresses);
  the card provider's webhook, which doesn't exist; DNS (CAA, DNSSEC, other subdomains).
