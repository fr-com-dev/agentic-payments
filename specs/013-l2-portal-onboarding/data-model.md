# Data Model: L2 Web Portal: Onboarding, Profile, Wallet and Expense Policies

Three places hold data, each with one owner:

| Store | Owner | Holds | Never holds |
|---|---|---|---|
| The hash-chained ledger (JSONL, existing) | L2 | users by identifier, wallets, policies and their versions, card events, account state, platform config, every decision | names, emails, policy names, card nicknames, card details, keys |
| The profile store (one JSON file per user, new) | portal | display name, contact email, policy names, the card vault customer reference | amounts, limits, keys, card details |
| The card vault (Stripe test mode, outside) | Stripe | card details, brand, last four, expiry, fingerprint, nickname | anything about payments or policies |

No user-typed text ever reaches L2 ([research R6](research.md#r6-no-user-typed-text-crosses-into-l2)).
L2's state is derived from the ledger only (INV-7, INV-9); it keeps no other file.

## Constants

| Name | Value | Where | Source |
|---|---|---|---|
| `MAX_ACTIVE_POLICIES` | 10 | L2 `users.ts` | FR-028 |
| `MAX_SELLERS_PER_POLICY` | 20 | L2 `users.ts` | FR-028 |
| `MAX_CARDS` | 5 | L2 `users.ts`, portal pre-check | FR-019 |
| `STEP_UP_MAX_AGE_MS` | 900 000 (15 min) | L2 `users.ts` | FR-007, FR-039 |
| `STEP_UP_TOLERANCE_MS` | 60 000 | L2 `users.ts` | as L1-6 and L2-7 clock tolerance |
| `BALANCE_MAX_AGE_MS` | 20 000 (cache), shown with `readAt` | portal `balance.ts` | FR-015 (at most 30 s old) |
| `DISPLAY_NAME_MAX` | 80 | portal `profile-store.ts` | FR-009 |
| `POLICY_NAME_MAX` | 60 | portal `profile-store.ts` | FR-024 |
| `CARD_NICKNAME_MAX` | 40 | portal `card-vault.ts` | FR-019 |
| `USDC_DECIMALS` | from the network profile (6) | shared | FR-025 |
| `TERMS_VERSION` | `test-funds-v1` | L2 `users.ts` | FR-009 |

## Identifiers

| Identifier | Format | Made by | Notes |
|---|---|---|---|
| `userId` | `usr_` + 32 lowercase hex | `userIdFor(issuer, subject)` in `src/shared/user-id.ts` | First 16 bytes of SHA-256 over `x402-user-v2`, the issuer's host and the token's `sub`, separated by newlines. Pure, so the hosted agent and the portal compute the same value without sharing a secret. An empty value, or one containing a newline, is refused. Reveals neither name nor email (FR-046). Since 2026-11-10 the issuer is the Auth0 tenant and the subject its `sub` (`auth0\|…`), which is why the format moved from `x402-user-v1\|<tid>\|<oid>`: `sub` contains the old separator. Every identifier made under v1 belongs to an earlier user that nobody signs in as. |
| `policyId` | `pol_<uuid>` | L2, on create | Unique across all users. |
| `policyVersion` | integer, 1, 2, 3… | L2 | One per recorded value change. State changes (pause, resume, remove) keep the version. |
| `mandateId` (existing field) | `<policyId>@<version>` for a user payment; the platform mandate's ID otherwise | L2 | Written on `AUTHORIZED` as today. |
| `walletIndex` | integer ≥ 0 | L2, on wallet create | The number of `WALLET_CREATED` entries before this one. The account is derived at `m/44'/60'/0'/0/<walletIndex>` ([R3](research.md#r3-per-user-accounts-inside-the-signer)). |
| `cardId` | `card_<uuid>` | portal, on add | Stored in the card vault's metadata; the ledger holds only this. |
| `platformDigest` | 64 hex | L2 | SHA-256 of the canonical JSON of the platform config in force. |

## Platform configuration (`config/platform.json`, CFG-4)

Read by L2 at startup, only when user accounts are on. Validated before the ledger lock; any error stops L2.

```json
{
  "platformId": "platform-poc-001",
  "limits": {
    "hardCapPerPaymentAtomic": "100000",
    "sessionBudgetAtomic": "100000",
    "userDailyCeilingAtomic": "500000",
    "maxAuthorizationsPerMinute": 10,
    "maxPolicyDays": 365
  },
  "sellers": [{ "host": "127.0.0.1:4021", "name": "Local demo seller", "payees": [] }]
}
```

| Field | Rule |
|---|---|
| `limits.*Atomic` | atomic-unit decimal strings; `hardCapPerPaymentAtomic ≤ sessionBudgetAtomic` |
| `limits.userDailyCeilingAtomic` | the user daily ceiling (FR-032), and the highest daily budget one policy may have (FR-041) |
| `limits.maxAuthorizationsPerMinute` | integer 1–600 |
| `limits.maxPolicyDays` | integer 1–3650; a policy's end date is at most this many days after it is saved |
| `sellers[].host` | `host[:port]` as R6 compares it; unique; at most 200 entries |
| `sellers[].name` | 1–60 characters, shown to users; operator text, trusted |
| `sellers[].payees` | lower-cased addresses; empty means any payee at that host, as `allowedPayees: []` does today |

`PLATFORM_SELLERS` (a JSON array in the environment) replaces `sellers` when set, as `ALLOWED_HOSTS` replaces the
mandate's hosts today; the Azure parameter file uses it. Schemes, networks, assets and `maxTimeoutSeconds` are not
here: they still come from the network profile and `config/mandate.json`, which stays the platform account's
mandate, unchanged.

The defaults equal today's mandate (0.10 USDC cap and session budget, 0.50 USDC daily, 10 per minute), so the seller
list starts as today's allowed host.

## Ledger entries

All new facts are new entry types or new fields on entries written from now on. Nothing existing is rewritten. Every
`data` object below also follows the L2-4 rules: amounts are strings, absent optional fields are omitted.

### New entry types

| Type | Written when | `data` |
|---|---|---|
| `PLATFORM_CONFIG` | at startup, when user accounts are on and the digest differs from the last recorded one | `platformId, digest, limits, sellers` |
| `USER_REGISTERED` | the user completes their profile for the first time (FR-009) | `userId, acknowledgedTestFunds: true, termsVersion` |
| `WALLET_CREATED` | the user creates their crypto account (FR-013) | `userId, walletIndex, address, network` |
| `CARD_ADDED` | the portal reports a registered card (FR-018) | `userId, cardId` |
| `CARD_REMOVED` | the portal reports a removed card (FR-020) | `userId, cardId` |
| `POLICY_CREATED` | a policy is saved for the first time (version 1) | `userId, policyId, version: 1, ...values, identityConfirmedAtMs` |
| `POLICY_CHANGED` | a policy's values change (version n+1) | `userId, policyId, version, ...values, loosened, identityConfirmedAtMs?` |
| `POLICY_PAUSED` | the user pauses a policy, or the account is enabled again (FR-039) | `userId, policyId, version, cause` (`user` or `account_enabled`) |
| `POLICY_RESUMED` | the user resumes a paused policy | `userId, policyId, version, identityConfirmedAtMs` |
| `POLICY_REMOVED` | the user removes a policy | `userId, policyId, version` |
| `USER_DISABLED` | the user disables their account (FR-037) | `userId` |
| `USER_ENABLED` | the user enables it again (FR-039), after the `POLICY_PAUSED` entries of the same serialized section | `userId, identityConfirmedAtMs` |

`...values` is exactly:

```text
sellers: string[]                 hosts, sorted, each on the seller list when saved
autoApproveMaxAtomic: string
hardCapPerPaymentAtomic: string
sessionBudgetAtomic: string
dailyBudgetAtomic: string
maxAuthorizationsPerMinute: number
expiresAt: string                 ISO
paymentMethod: "crypto_account"
```

No name, no free text. `sessionId`, `intentId` and `authorizationId` are absent on all of these.

### New fields on existing entries (user payments only)

| Entry | New `data` fields | Notes |
|---|---|---|
| `INTENT` | `userId` | Only when the intent carries a user and user accounts are on. |
| `AUTHORIZED` | `userId, policyId, policyVersion` | `mandateId` is `<policyId>@<version>`; `payer` is the user's account. |
| `DENIED` | `userId`, and `policyId, policyVersion` when a policy applied | Absent policy fields mean no policy applied (`user_not_onboarded`, `user_disabled`, or no active policy for the seller). |
| `ESCALATED`, `ESCALATION_REPEATED` | `userId, policyId, policyVersion` | Shown by the operator's reads (FR-045). |
| `HUMAN_APPROVAL`, `HUMAN_REJECTION`, `ESCALATION_EXPIRED`, `APPROVAL_LAPSED`, `APPROVAL_*` | unchanged | The user is read from the `ESCALATED` entry they refer to. |
| `SETTLEMENT` | unchanged | Joined to its `AUTHORIZED` by `authorizationId`, as today. |

An entry without `userId` belongs to the platform account, which is every entry written before this feature.

## Derived state (`src/layer2-control/users.ts`, pure functions over ledger entries)

Like `escalations.ts`: no cache is authoritative, and nothing is stored outside the ledger.

### User

```text
UserState {
  userId
  registered: boolean            a USER_REGISTERED exists
  enabled: boolean               true unless the last of USER_DISABLED / USER_ENABLED is USER_DISABLED
  wallet?: { walletIndex, address, network }
  cards: cardId[]                CARD_ADDED minus CARD_REMOVED, in order added
  policies: PolicyState[]
  onboarded: boolean             registered && wallet && at least one POLICY_CREATED ever (FR-011)
}
```

| Transition | Entry | Allowed when | Otherwise |
|---|---|---|---|
| unknown → registered | `USER_REGISTERED` | not registered | already registered: no entry, 200 |
| registered → has wallet | `WALLET_CREATED` | registered, enabled, no wallet | has wallet: no entry, same address; not registered: 409 `not_registered` |
| enabled → disabled | `USER_DISABLED` | registered and enabled | already disabled: no entry, 200 |
| disabled → enabled | `POLICY_PAUSED`×n, then `USER_ENABLED` | disabled and step-up fresh | already enabled: no entry, 200; stale step-up: 403 |

A user is never deleted. Onboarding status is derived (profile from `registered`, wallet, first policy), not stored.

### Policy

```text
PolicyState {
  policyId, userId
  version: number                latest POLICY_CREATED / POLICY_CHANGED
  values                         of that version
  state: "active" | "paused" | "removed"
  expired: boolean               nowMs > expiresAt (derived at read time)
  limitedByPlatform: string[]    fields where the platform limit is stricter than the saved value (FR-043)
  unlistedSellers: string[]      sellers no longer on the seller list (FR-042)
  history: PolicyVersion[]       every POLICY_* entry: seq, ts, kind, version, values?, cause?
}
```

```text
            create                    pause                    remove
(none) ───────────────▶ active ◀──────────────▶ paused ───────────────▶ removed
                          │        resume          ▲                       ▲
                          │                        │ account enabled       │
                          └────────────────────────┴──── remove ───────────┘
```

- **Change** keeps the state and adds a version. A removed policy can't be changed, paused or resumed (409).
- **Idempotency.** A change whose values equal the current version records nothing and returns the current policy.
  Pausing a paused policy, or removing a removed one, records nothing.
- **Optimistic concurrency.** A change carries `expectedVersion`; a mismatch is 409 `version_conflict` with the
  current policy, so two tabs can't overwrite each other silently.
- **While the account is disabled** every policy reads as `disabled` in the portal, but its recorded state is kept.
  On enable, each policy that is `active` gets `POLICY_PAUSED` with cause `account_enabled`.

### Validation of a policy save (FR-026)

Run inside the serialized section, against the platform config in force. Each failure is one issue
`{ field, code, ... }`; all issues are returned together (422).

| Code | Field | Condition |
|---|---|---|
| `not_atomic` | any amount | not `^\d+$` |
| `order_auto_below_cap` | `autoApproveMaxAtomic` | not `autoApprove < hardCap` |
| `order_cap_within_session` | `hardCapPerPaymentAtomic` | not `hardCap ≤ sessionBudget` |
| `above_platform_limit` | the amount or rate field, with `limitAtomic` or `limit` | value above the platform limit (`dailyBudgetAtomic` against `userDailyCeilingAtomic`) |
| `rate_invalid` | `maxAuthorizationsPerMinute` | not an integer ≥ 1 |
| `no_sellers` / `too_many_sellers` | `sellers` | empty, or more than 20 |
| `seller_not_listed` | `sellers[i]`, with `host` | not on the seller list |
| `seller_conflict` | `sellers[i]`, with `host`, `policyId` | another active policy of this user lists it (FR-028) |
| `expires_in_past` / `expires_too_late` | `expiresAt` | not after now, or more than `maxPolicyDays` ahead |
| `payment_method_unsupported` | `paymentMethod` | anything but `crypto_account` (FR-021) |
| `policy_limit` | — | the user already has 10 active policies (create and resume) |

`autoApproveMaxAtomic` may be `"0"`: every payment under that policy then needs a human.

### Loosening (FR-007)

A save is **loosening** when, compared with the current version, it raises any of the four amounts or the rate, adds
a seller, or moves `expiresAt` later. Creating a policy, resuming one and enabling an account are always loosening.
A loosening operation needs `identityConfirmedAtMs` with
`-STEP_UP_TOLERANCE_MS ≤ now − identityConfirmedAtMs ≤ STEP_UP_MAX_AGE_MS`; otherwise 403 `step_up_required` and
nothing is recorded. L2 makes the comparison; the portal supplies the time from the person's verified sign-in
([R5](research.md#r5-confirming-identity-again-step-up)).

## The decision for a user payment

Inputs, all from the ledger and the platform config, inside the serialized section:

1. **Gate.** `userGate(state)`: `not_onboarded` when `!onboarded`; else `disabled` when `!enabled`; else none.
2. **Policy selection.** `selectPolicy(state, host)`: the one policy that is `active` and lists `host(resourceUrl)`,
   if that host is still on the seller list. FR-028 guarantees at most one.
3. **Effective mandate.** `effectiveMandate(policy, platform, platformMandate, net)`:

   | Mandate field | Value |
   |---|---|
   | `mandateId` | `<policyId>@<version>` |
   | `expiresAt` | the policy's |
   | `allowedHosts` | `[host]`; `[]` when no policy applies, so R6 denies with `host_not_allowed` (FR-029) |
   | `allowedPayees` | the seller's `payees` from the seller list |
   | `autoApproveMaxAtomic` | the policy's |
   | `hardCapPerPaymentAtomic` | min(policy, platform) |
   | `sessionBudgetAtomic` | min(policy, platform) |
   | `dailyBudgetAtomic` | min(policy, `userDailyCeilingAtomic`) |
   | `maxAuthorizationsPerMinute` | min(policy, platform) |
   | `allowedSchemes`, `maxTimeoutSeconds` | the platform mandate's |
   | `allowedNetworks`, `allowedAssets` | the network profile's |

   If the platform cap falls to or below the policy's auto-approve limit, the mandate no longer satisfies CFG-3's
   order. It is still evaluated: R10 denies anything above the cap, so nothing above the platform cap is paid.
4. **Context.** The existing fields, counted for this user and this policy only, plus the user-wide figure:

   | Context field | Counts `AUTHORIZED` entries with |
   |---|---|
   | `sessionCommittedAtomic` | this `sessionId`, `userId`, `policyId` |
   | `dailyCommittedAtomic` | this `userId`, `policyId`, last 24 h |
   | `authorizationsLastMinute` | this `userId`, `policyId`, last 60 s |
   | `user.dailyCommittedAtomic` (new) | this `userId`, any policy, last 24 h |
   | `user.dailyCeilingAtomic` (new) | `limits.userDailyCeilingAtomic` |
   | `user.gate` (new) | from step 1 |
   | `humanApprovedFor`, `humanRejected` | as today, and only entries of the same `userId` |

   `committedAtomic` gains a `userId` filter (`string` for a user, `null` for the platform account) and a `policyId`
   filter. The platform account's budgets count only entries without `userId`, so users never use them up, and the
   reverse.
5. **Rules** (`policy.ts`, still pure):

   | # | Rule ID | Condition | Effect |
   |---|---|---|---|
   | R16 | `user_not_onboarded` | `ctx.user.gate === "not_onboarded"`. Detail: `the user's setup is incomplete`, nothing else (FR-012) | DENY, **return immediately**, evaluated first |
   | R17 | `user_disabled` | `ctx.user.gate === "disabled"`. Detail: `the user's account can't pay` (FR-038) | DENY, **return immediately**, evaluated first |
   | R12 (extended) | `daily_budget_exceeded` | as today; and, when `ctx.user` is present and the policy's own budget passes, `user.dailyCommitted + amount > user.dailyCeiling` (FR-032) | DENY |

   R1–R15 are otherwise unchanged, in the same order. Without `ctx.user` (the platform account) the engine behaves
   exactly as in v1.8.
6. **Signing.** With the user's account: `keyring.signerFor(wallet.walletIndex, effective hard cap)`. The derived
   address must equal `wallet.address`; if not, `DENIED` with `signer_rejected`.

## Views

### `UserView` (L2 → portal; whitelist projection)

```text
{ userId, registered, enabled, onboarding: { profile, wallet, policy },
  wallet?: { address, network, asset, decimals, committedAtomic, spent24hAtomic,
             dailyCeilingAtomic, dailyRemainingAtomic },
  cards: cardId[], policies: PolicyView[] }
```

- `committedAtomic`: `AUTHORIZED` amounts of this user that can still settle (no effective report, or `PENDING`).
- `spent24hAtomic`: `committedAtomic({ userId, sinceMs: now − 24 h })`, the figure R12 uses.
- An unknown `userId` returns `registered: false` with everything empty, never 404: it is the caller's own user.

### `PolicyView`

`PolicyState` without `userId`, plus `displayState`: `active`, `paused`, `removed`, `expired` or `disabled`.
The portal adds `name` from the profile store.

### Operator reads (L2-5, additive)

`GET /v1/escalations` items and `escalated` events gain `userId` when the escalation has one. Nothing else changes.

### `BudgetStatus` for a user (L1 `check_budget`)

Same shape as today, plus `scope`:

| Field | Platform account (today) | User |
|---|---|---|
| `scope` (new, optional) | `session` | `user_daily` |
| `sessionCapAtomic` | the mandate's session budget | the user daily ceiling |
| `spentOrReservedAtomic` | session committed | the user's committed spend, last 24 h |
| `remainingAtomic` | cap − committed | ceiling − committed |
| `perPaymentCapAtomic` | auto-approve limit | the highest auto-approve limit among the user's active policies, bounded by the platform cap; `0` if none |

A user who is not onboarded or is disabled gets zeros. Per-seller limits can be lower and are enforced at authorize.

## Profile store (portal)

One file per user, `<PROFILE_DIR>/<userId>.json`, written with a temporary file and a rename, mode 0600.

```json
{
  "userId": "usr_…",
  "displayName": "Ana Pérez",
  "contactEmail": "ana@example.com",
  "policyNames": { "pol_…": "Research APIs" },
  "cardVaultCustomer": "cus_…",
  "updatedAt": "2026-11-10T12:00:00.000Z"
}
```

| Field | Rule |
|---|---|
| `displayName` | 1–80 characters after trimming; no control characters |
| `contactEmail` | one `@`, a dot in the domain, at most 254 characters; not verified by mail |
| `policyNames[policyId]` | 1–60 characters; removed policies keep their name for the history |
| `cardVaultCustomer` | set on the first card setup; never shown |

The file is the only place a name or an email is kept. It is read only for its own user (FR-004).

## Registered card (card vault)

Not stored by this system. The portal projects each of the customer's card payment methods to:

```text
{ cardId, brand, last4, expMonth, expYear, nickname?, addedAt, expired }
```

`cardId` and `nickname` live in the payment method's metadata; `fingerprint` is used only to refuse a duplicate and
is never returned. A card exists for the wallet when the vault lists it; the ledger's `CARD_ADDED` / `CARD_REMOVED`
are the audit trail, and the portal reconciles the two on every list
([R8](research.md#r8-keeping-the-card-vault-and-the-ledger-in-step)).

## Wallet view (portal → browser)

```text
{ account?: { address, network, asset, decimals,
              balanceAtomic, balanceReadAt, balanceStale: boolean,
              committedAtomic, spent24hAtomic, dailyCeilingAtomic, dailyRemainingAtomic,
              lowBalance: boolean },
  cards: Card[], cardsAvailable: boolean, disabled: boolean }
```

- `balanceAtomic` comes from a read-only `balanceOf` on the network, cached at most 20 s. If the read fails, the
  last value is returned with `balanceStale: true`; the rest of the view still comes from L2.
- `lowBalance`: `balanceAtomic` is below the effective per-payment cap of some active policy.
