# Contract: the portal and its web app (delta to SPEC L2-8)

**Feature**: [../spec.md](../spec.md) | **Builds on**: `specs/013` contracts/portal-api.md and portal-ui.md

Two things for a person: see why a payment of theirs is waiting, and set up a phone for approvals. The portal
still holds no key and decides nothing. `docs/portal.openapi.yaml` and `web/portal/src/api.ts` change with the
routes, and T-API-12..15 fail until they match.

## Routes (browser → portal)

### `GET /api/payments/waiting`, new

- A signed-in person's own pending escalations. The user comes from the verified token; the route takes no
  identifier, no query and no body.
- The portal calls L2's `GET /v1/users/:userId/escalations` with `PORTAL_TOKEN`.
- 200 with `{ payments: [...] }`. Each item is L2's `WaitingPayment` with `amount` renamed `amountAtomic` and
  `resourceKey` kept; nothing is added.
- 401 without a valid token; 502 when L2 can't be reached, as for the other routes.
- Covered by the existing per-person and per-address limits on `/api`.

### `GET /api/platform`

Gains `phoneApproval: boolean`, passed on from L2.

Nothing else changes: no route takes a user identifier, and no route starts, answers or cancels an approval
request.

## Screens

### Home: "Waiting for approval"

Shown when `phoneApproval` is true and the list is not empty. Polled every 5 s with the existing `poll.ts`
(only while the tab is visible).

| `waitingFor` | `reason` | The person reads |
|---|---|---|
| `phone` | | "Check your phone. Approve or refuse reference `<code>`." |
| `operator` | `limit_reached` | "Too many requests in the last hour. An operator will decide this one." |
| `operator` | `sign_in_not_supported` | "Phone approval is not available for the way you signed in. An operator will decide this one." |
| `operator` | `phone_unreachable` | "We could not send a request to your phone. If you have not set up a phone for approvals, you can do it under Account. An operator will decide this one." |
| `operator` | `service_unavailable` | "The approval service could not be reached. An operator will decide this one." |
| `operator` | `request_expired` | "The request on your phone was not answered in time. An operator will decide this one." |
| `operator` | `answer_not_accepted` | "The answer from your phone could not be accepted. An operator will decide this one." |
| `operator` | none | "Waiting for an operator." |

Each row shows the amount (formatted with `money.ts`), the seller's host, the reference code and the time left.
Every value is rendered as text. The card has no button: a person approves on their phone, never here (approving
one's own payment in the portal stays out of scope).

### Account: "Phone approvals"

Shown when `phoneApproval` is true and the person signed in with the tenant (not in the local dev sign-in).

- One paragraph: what the phone is asked, and that setting it up is optional.
- A button, "Set up your phone". It opens the sign-in pop-up of step-up (`prompt=login`, `max_age=0`) with
  `acr_values` set to `urn:x402:acr:enroll-phone`
  ([research R13](../research.md#r13-enrollment-the-tenants-own-asked-for-by-the-portals-sign-in)). The
  tenant shows its own enrollment pages inside that pop-up.
- A closed or failed pop-up leaves the current session as it is and shows "Nothing was changed."
- The portal does not know whether a phone is already set up, and says so: "If your phone is already set up,
  you only confirm your sign-in."

`web/portal/src/auth/auth0.ts` stays the one file that names session storage; the new call goes through it.
Nothing is stored in the browser by the app (T-WEB-07).

## What the portal's log may hold

The route template and a fixed label, as for every other route. Never a reference code with a person's name,
never a reason from L2 other than the code.

## Tests

| ID | What it proves |
|---|---|
| T-PRT-15 | `/api/payments/waiting`: the user from the token only; another person's payments never appear; 401 and 502; `phoneApproval` passed on |
| T-WEB-13 | the card: each reason's text, values as text, hidden when the feature is off or the list is empty, polling stops in a hidden tab |
| T-WEB-14 | "Set up your phone": behind a click, the pop-up's parameters, a failed pop-up changes nothing, hidden in the dev sign-in |
| T-API-12..15 | the OpenAPI document matches the portal |
