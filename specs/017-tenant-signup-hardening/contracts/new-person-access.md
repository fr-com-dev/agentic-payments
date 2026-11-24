# Contract: what a brand-new person reaches (FR-011 to FR-016)

A "brand-new person" is someone whose tenant account a first Google sign-in made a moment earlier. Their subject has
Google's shape (`google-oauth2|<Google's sub>`, digits only), their token carries no permission, and they have no
portal user yet. Nothing in this contract changes a route. It pins the behavior that already holds (SEC-19,
SEC-20, SEC-26, R21) so that a public way in cannot weaken it unnoticed. The new tests T-PRT-16 and T-AGT-15 check
each row with that person, next to a second person with an `auth0|…` subject.

## The portal (`docs/portal.openapi.yaml`, unchanged)

| Request by the new person | Answer | Note |
|---|---|---|
| `GET /api/config` | 200, public values only | No token needed, as today |
| `GET /api/me` | 200, no profile yet | No role is needed (R21) |
| `PUT /api/profile` (first profile) | 200 | Creates their portal user; L2 derives it from issuer and subject (`x402-user-v2`) |
| `GET /api/wallet`, `/api/wallet/account` | 200, their own account | An account of their own, derived for their user, never the platform account |
| `POST /api/policies`, then `GET /api/policies` | 201, then their own policies only | Bounded by the platform limits (CFG-4) |
| `POST /api/cards/setup` | 200 | A card setup of their own (stand-in card vault in tests) |
| `GET /api/policies/{id}` for another person's policy | 404, the body of an unknown policy | Never 403: their existence isn't revealed (SEC-19) |
| `GET /api/admin/escalations` (administration on) | 403 `forbidden`, control service not called | Needs `portal:admin` |
| A request with their **agent** token | 403 `forbidden` | Each service refuses the other's client (SEC-20) |

## The hosted agent and L2 (`docs/l1-hosted.openapi.yaml`, `docs/l2-control.openapi.yaml`, unchanged)

| Request | Answer | Note |
|---|---|---|
| `POST /v1/runs` with the new person's agent token (no `agent:run`) | 403 `forbidden` | No model call, nothing authorized, no ledger entry |
| The same token forwarded to L2's authorize in `X-Caller-Authorization` (a compromised L1) | 403, nothing appended | L2 checks the permission itself (016). T-CTK-01 row 5 checks it with this person |
| After a tenant administrator assigns `x402-agent` and the person signs in again | 200, the run pays from that person's own account | Never the platform account |

## Identity

- The portal user is `userIdFor(issuer, sub)`. `google-oauth2|N` and `auth0|N` are two users, even with the same
  digits or the same email address (FR-016). Nothing in this system reads a token's email to find a user.
- No Action, rule or extension of the tenant links accounts. T-IAC-02 already allows only the declared Actions,
  and none of them calls a linking API.
