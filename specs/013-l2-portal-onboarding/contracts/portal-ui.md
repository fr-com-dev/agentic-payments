# Contract: the portal's screens and behavior

What a person sees and can do. The screens call only the portal API ([portal-api.md](portal-api.md)); they hold no
credential except the person's own sign-in. Tests: T-WEB-01..08 (component tests in jsdom) and the manual pass in
[quickstart.md](../quickstart.md).

## Screens

| Path | Screen | Shown when | Requirements |
|---|---|---|---|
| `/` | Home | signed in | Onboarding steps with done/next (FR-008); once onboarded: balance, last-24-hours spending against the user daily ceiling, active policies, any flags. Opens on the first step not done. |
| `/onboarding/profile` | Profile step | profile not done | FR-009 |
| `/onboarding/wallet` | Wallet step | profile done, no account | FR-013, FR-016 |
| `/onboarding/policy` | First policy | account exists, no policy ever saved | FR-024..FR-027; if the seller list is empty: "No sellers are available yet" and no form |
| `/profile` | Profile | onboarded | FR-010 |
| `/wallet` | Wallet | profile done | FR-015, FR-016, FR-019..FR-022 |
| `/policies` | Policy list | account exists | state, sellers, limits, flags (expired, limited by the platform, seller no longer listed) |
| `/policies/new`, `/policies/:id` | Policy editor | account exists | FR-024..FR-027, FR-035 |
| `/policies/:id/history` | Policy history | policy exists | FR-047 |
| `/account` | Account | profile done | disable and enable (FR-037..FR-039) |
| any | Signed-out / refused | no sign-in, or 403 | "Sign in"; for 403 (a sign-in that is not the portal's own; since 2026-11-12 never a missing permission, research R21): "This sign-in can't be used for the portal. Sign in again from this page." No profile is created (FR-003). |

Deep links to a step that is not available redirect to the first step not done. A screen never shows another
person's data: every identifier in a URL is resolved by the portal API for the signed-in user only, and a 404 shows
"Not found" (FR-004).

## Onboarding

1. **Profile.** Name and email are prefilled from the sign-in (the ID token's `name` and `email`) and
   editable. A required checkbox: "I understand this wallet holds test funds only (test USDC on <network>)". Save is
   disabled until the checkbox is ticked and both fields are valid.
2. **Wallet.** One button, "Create my wallet". After it: the address (with a copy button), the network, the asset
   and the balance 0, and "To fund it, send test USDC on <network> to this address", with the faucet link on
   Base Sepolia. A second click, a retry or a second tab shows the same address (FR-013).
3. **First policy.** The policy editor below. Saving it completes onboarding (FR-011).

Leaving at any point and returning reopens the first step not done (FR-008).

## Policy editor

Three groups, in this order, each a `fieldset` with a legend:

| Group | Control | Rules shown inline |
|---|---|---|
| Where | A checklist of the sellers on the seller list, each as name and host. No free-text host. | at least 1, at most 20; a seller used by another active policy is disabled with "Already in <policy name>" |
| How much | Four USDC amount fields: without asking (auto-approve), per payment, per agent run, per day | at most 6 decimals, never rounded (FR-025); the order rule; each platform limit as helper text ("up to 0.10 USDC") |
| How | Payment method (a single read-only choice, "My crypto account"; cards are listed as "not available yet"), payments per minute, end date | end date after today and within the platform's maximum |

Plus a name field (1–60 characters).

**Summary before saving (FR-027, SC-013).** A panel that updates as the user types, built by the pure function
`summarizePolicy(values, sellers, limits)`:

> At **Local demo seller** (127.0.0.1:4021): your agent pays up to **0.02 USDC** per payment without asking. From
> 0.02 up to **0.10 USDC** a person must approve first. Above 0.10 USDC it is refused. At most **0.10 USDC** per
> agent run and **0.50 USDC** per day, at most **10** payments a minute, until **31 Dec 2027**.
> Across all your policies you can spend at most **0.50 USDC** in any 24 hours.

With an auto-approve limit of 0: "Every payment needs a person's approval." The summary is the same text the list
and the history show for a saved version.

**Saving.**
- Server issues (422) are mapped to their fields and listed in an error summary at the top that takes focus.
- 403 `step_up_required`: the portal says "Confirm it's you to make this change", runs the sign-in again (a
  pop-up with `prompt=login` and `max_age=0`, started from the person's click) and
  resubmits the same values once (FR-007).
- 409 `version_conflict`: "This policy was changed in another window", with the current values and the user's
  values side by side; nothing is overwritten.

## Wallet

- **Crypto account**: address, network, asset; balance with "as of <time>" and a "couldn't refresh" note when stale;
  committed; spent in the last 24 hours next to the user daily ceiling; a low-balance notice (FR-015).
- **Cards**: brand, last four, expiry, nickname, "expired" flag (FR-022). Above the list, always:
  "Agents can't pay with cards yet. A card here is saved for later." (FR-021).
- **Add a card**: the card vault's own fields in an iframe (the portal never has the number or the code, FR-018);
  an optional nickname. Disabled with a reason when the user has 5 cards, when cards are not configured, or when
  the account is disabled. A vault failure shows "The card could not be added. Try again later."; nothing else on
  the page fails.
- **Remove**: a confirm dialog; then the card leaves the list (FR-020).
- No control moves funds out (FR-016).

## Account

- **Disable**: a confirm dialog that says what happens ("Your agent will not be able to pay. Nothing is deleted.").
  Afterwards every screen shows a "Your account is disabled" banner, policies and wallet read as disabled, and
  every create or change control is disabled (FR-038). Name and email stay editable.
- **Enable**: asks to confirm identity when the sign-in is older than 15 minutes; then says "Your policies are
  paused. Resume the ones you want." (FR-039).

## Text and safety

- Every value typed by a person (names, nicknames) is rendered as text, never as HTML (NFR-006). No
  `dangerouslySetInnerHTML` anywhere in `web/portal/` (T-WEB-07 scans for it).
- Amounts are shown from atomic strings with `formatAtomic`; inputs are parsed with `parseUsdc`. No floating-point
  arithmetic on amounts (Constitution VI; T-WEB-03).
- If another person signs in in the confirmation pop-up, the adapter signs out and reports `account_changed`:
  one person's confirmation never finishes another's change.
- The access token is kept in memory and `sessionStorage` by the sign-in library (through its cache hook); it is never put in a URL, a log or
  an error report.

## Accessibility and layout (NFR-009)

- WCAG 2.1 AA: text contrast at least 4.5:1; every input has a visible label; errors are announced
  (`aria-describedby`, an error summary with `role="alert"`); focus is visible and moves to the error summary or
  the new screen's heading; dialogs trap focus and close on Escape.
- Everything works with a keyboard alone, in a logical tab order.
- Usable from 360 px wide to desktop; no horizontal page scroll; tables become stacked rows on narrow screens.
- Status is never color alone (text labels for active, paused, removed, expired, disabled).
- English only in this feature.

## Tests

| ID | Covers |
|---|---|
| T-WEB-01 | routing by onboarding status; deep links redirect to the first step not done |
| T-WEB-02 | profile step: prefill, validation, the acknowledgement is required |
| T-WEB-03 | amount fields: 6 decimals accepted, 7 refused, no rounding; parse and format round-trip |
| T-WEB-04 | `summarizePolicy`: the example above, the zero auto-approve case, several sellers |
| T-WEB-05 | editor errors: 422 issues map to fields; step-up retries once; version conflict keeps both |
| T-WEB-06 | wallet: card notice always present; add disabled at 5 cards, when unavailable, when disabled |
| T-WEB-07 | no `dangerouslySetInnerHTML`; a name containing markup renders as text |
| T-WEB-08 | accessibility: an automated axe pass on each screen has no violations; keyboard-only path through onboarding |
