# Contract: portal → card vault (Stripe, test mode)

The outbound contract of `src/portal/card-vault.ts`, the only module that holds the card vault credential (rule
A10). Cards are registered and never charged (FR-021): this module calls no charge, payment-intent, refund or
payout endpoint, and the restricted key could not if it tried. Facts below were checked against Stripe's
documentation on 2026-11-10 ([research R7](../research.md#r7-the-card-vault)).

## Transport

| Item | Value |
|---|---|
| Base URL | `https://api.stripe.com` (fixed; a test-only dep replaces it with the stand-in, never env) |
| Auth | `Authorization: Bearer <CARD_VAULT_KEY>` |
| Version | `Stripe-Version: 2026-10-28.endive` on every call (a constant) |
| Body | `application/x-www-form-urlencoded` |
| Idempotency | `Idempotency-Key: <uuid>` on every POST; a retry reuses the key |
| Timeout | 10 s per call; one retry on a network error, 429 or 5xx with the same key, honouring `Stripe-Should-Retry` |
| Redirects | not followed |

No Stripe SDK on the server: six calls with global `fetch` ([R7](../research.md#r7-the-card-vault)).

## Startup checks (fail closed)

With `CARD_VAULT=stripe`, the portal refuses to start unless:
- `CARD_VAULT_KEY` starts with `rk_test_` or `sk_test_`, and
- `CARD_VAULT_PUBLISHABLE_KEY` starts with `pk_test_`.

A live key (`sk_live_`, `rk_live_`, `pk_live_`) is always a startup error, naming the variable and never the value.
Every response is also checked for `livemode === false`; a `true` is treated as a vault failure. With `CARD_VAULT`
unset, cards are off: the wallet says so and the card routes answer 503 `cards_unavailable`.

## Calls

| # | Purpose | Call | Sends | Reads |
|---|---|---|---|---|
| 1 | One customer per user, on the first setup | `POST /v1/customers` | `metadata[x402_user_id]=<userId>` | `id` |
| 2 | Start a card setup | `POST /v1/setup_intents` | `customer`, `allowed_payment_method_types[]=card`, `usage=off_session`, `metadata[x402_user_id]` | `id`, `client_secret`, `livemode` |
| 3 | Read the result | `GET /v1/setup_intents/{id}?expand[]=payment_method` | — | `status`, `customer`, `payment_method.{id, created, card.{brand, last4, exp_month, exp_year, fingerprint}}`, `last_setup_error.code` |
| 4 | List a user's cards | `GET /v1/customers/{id}/payment_methods?type=card&limit=100` | — | `data[].{id, created, metadata, card.*}` |
| 5 | Label a card | `POST /v1/payment_methods/{id}` | `metadata[x402_card_id]`, `metadata[nickname]` | `id` |
| 6 | Remove a card | `POST /v1/payment_methods/{id}/detach` | — | `id` |

Never sent: a name, an email, an amount, a policy, a seller, an address on the network, or anything about a
payment. `x402_user_id` is the opaque identifier.

`payment_method_types` is not sent: it was removed for writes in `2026-09-30.endive`, and
`allowed_payment_method_types` replaces it.

## Add a card

```text
browser                        portal                         card vault            L2
   │  POST /api/cards/setup      │                                │                  │
   │────────────────────────────▶│ user enabled? cards < 5?  ─────┼─────────────────▶│ GET /v1/users/:id
   │                             │ customer (1, once) ───────────▶│                  │
   │                             │ setup intent (2) ─────────────▶│                  │
   │◀──── { clientSecret, publishableKey } ──                     │                  │
   │  card fields in the vault's iframe; confirmSetup ───────────▶│                  │
   │  POST /api/cards { setupIntentId, nickname? }                │                  │
   │────────────────────────────▶│ retrieve (3) ─────────────────▶│                  │
   │                             │ checks below                   │                  │
   │                             │ label (5) ────────────────────▶│                  │
   │                             │ record ────────────────────────┼─────────────────▶│ PUT …/cards/:cardId
   │◀──── 201 Card ──────────────│                                │                  │
```

Checks on step 3, in order; any failure adds no card:

| Check | On failure |
|---|---|
| `status === "succeeded"` | 409 `card_not_confirmed` (the browser shows the vault's own message for `last_setup_error.code`) |
| `customer` equals this user's customer | 404 (another user's setup intent reveals nothing) |
| `payment_method.card` present | 422 `not_a_card`, then detach |
| expiry not in the past (month and year against the portal's clock) | 422 `card_expired`, then detach |
| `card.fingerprint` differs from every other card of this customer | 409 `card_already_registered`, then detach the new one |
| the user has fewer than 5 cards | 409 `card_limit`, then detach |

If recording in L2 fails after the label, the portal detaches the new card and answers 502: a card never stays in
the wallet without its `CARD_ADDED` entry. `client_secret` is returned to the browser once and never logged or
stored.

In the browser: Stripe.js from `https://js.stripe.com/endive/stripe.js` (it can't be bundled or self-hosted), the
Payment Element, and `stripe.confirmSetup({ elements, redirect: "if_required", confirmParams: { return_url } })`.
The card number and the security code go from the iframe to Stripe; the portal's pages and API never see them
(FR-018).

## List and remove

- **List** (call 4) projects each payment method to
  `{ cardId, brand, last4, expMonth, expYear, nickname?, addedAt, expired }`. `fingerprint`, the payment-method ID
  and the customer ID are never returned to the browser.
- **Reconcile on list**: a payment method without `x402_card_id` (an add that was interrupted) is detached; a
  `cardId` the ledger holds that the vault no longer lists is reported to L2 as removed.
- **Remove**: detach (call 6) first, then `DELETE …/cards/:cardId` at L2. If L2 can't be reached, the next list
  reconciles it. Detach is permanent at the vault.

## Failures

| Vault answer | Portal behavior |
|---|---|
| network error, timeout, 5xx, 429 after the retry | 503 `card_vault_unavailable`; no card added or removed; nothing else in the portal is affected (NFR-005) |
| 401, 403 (key wrong or missing a permission) | 503 `card_vault_unavailable`; logged as `card_vault_auth` with the status only |
| 404 `resource_missing` on a setup intent or a card | 404 |
| `livemode: true` | 503; logged as `card_vault_live_mode` |

Stripe's `message` text is never logged, stored or returned: only `code` values from a whitelist
(`card_declined`, `expired_card`, `incorrect_cvc`, `invalid_cvc`, `invalid_expiry_month`, `invalid_expiry_year`,
`incorrect_number`, `processing_error`, `setup_intent_authentication_failure`, anything else as `other`).

## The credential

A **restricted** key (`rk_test_…`) with Customers: write, Setup Intents: write, Payment Methods: write, and
everything else None. It can't create a charge, a payment intent, a refund or a payout. The publishable key is not
a secret; it is configuration.

## Test cards (for the quickstart)

`4242 4242 4242 4242` succeeds; `4000 0025 0000 3155` requires 3-D Secure at setup; `4000 0000 0000 9995` is
declined; `4000 0000 0000 0069` is an expired card. Any future expiry and any CVC.

## Tests

`test/helpers/card-vault-stub.ts` is a stand-in for the six calls, like `cdp-stub.ts` and `ciba-stub.ts`. It
records every request so tests can assert what was sent.

| ID | Covers |
|---|---|
| T-CARD-01 | config: test-key prefixes accepted; live prefixes and a missing key refuse startup, naming the variable only |
| T-CARD-02 | add: the happy path; each check in the table; `livemode: true` refused |
| T-CARD-03 | duplicate fingerprint and the 5-card limit detach the newcomer |
| T-CARD-04 | list projection and reconcile; remove; remove when L2 is down, reconciled on the next list |
| T-CARD-05 | vault down, slow, 401, 429: 503 for card routes only; profile, wallet and policy routes unaffected |
| T-CARD-06 | nothing but the listed fields is sent; a known-value scan finds no key, client secret, fingerprint or vault message in logs, responses or the ledger |
| T-ARCH-A10 | `CARD_VAULT_KEY` and `api.stripe.com` appear only in `src/portal/card-vault.ts` and `env/portal.env.example` |
