# Contract: the administration area's screens and behavior

What an administrator sees and can do. The screens call only the portal API
([portal-api.md](portal-api.md)) and hold no credential except the person's own sign-in. They extend
[specs/013 contracts/portal-ui.md](../../013-l2-portal-onboarding/contracts/portal-ui.md), whose rules for text,
safety, accessibility and layout apply unchanged. Tests: T-WEB-09..12 (jsdom) and the manual pass in
[quickstart.md](../quickstart.md).

## Screens

| Path | Screen | Shown when | Requirements |
|---|---|---|---|
| `/admin` | Waiting for approval | `me.admin` | FR-007 to FR-010 |
| `/admin/escalations/:authorizationId` | One payment | `me.admin` | FR-011 to FR-017, FR-022, FR-024 |
| `/admin/activity` | Activity | `me.admin` | FR-020, FR-021 |
| `/admin/ledger` | Ledger check | `me.admin` | FR-025, FR-026 |

- **Navigation.** The main navigation gains one link, "Administration", only when `me.admin` is true. Inside the
  area, a second row links the three top-level screens.
- **A person who is not an administrator** never sees the link. A deep link to `/admin…` shows the existing "Not
  found" screen, and the web app makes no `/api/admin` request (FR-004).
- **An administrator** is a user like any other (SPEC v1.14: every signed-in person is one) and keeps the 013
  screens unchanged. The onboarding redirects of 013 never
  apply to `/admin…`: an administrator who has not onboarded can still decide.
- With `config.admin.available` false, none of this exists.

## Waiting for approval (`/admin`)

A table (a list on a phone-width screen), oldest first, refreshed every 3 s while the tab is visible:

| Column | Content |
|---|---|
| Reference | the reference code, in a monospace face |
| For | "Platform account", or the user's identifier shortened to its last 8 characters with the full value as the accessible name; plus a "Your payment" tag when `mine` |
| Seller | the host of the resource, and the resource path below it, as plain text |
| Amount | USDC, formatted from the atomic string by `money.ts` |
| Time left | "4 min 12 s", counting down every second; "under 1 min" is also said in words, never by color alone (NFR-008) |
| Phone | when backchannel approval is on: "Asked", "Not asked", "No answer" or "Failed" |
| | a "Review" link to the payment's screen |

- Under the heading: "Read at 10:42:07", from `readAt`. If a refresh fails, the last list stays, marked
  "Couldn't refresh. Last read at …", and the next refresh is tried as usual.
- Nothing pending: "No payment is waiting for approval."
- The countdown uses the difference between `readAt` and the browser's clock, so a wrong local clock doesn't
  shift it. At zero the row says "Expired" until the next refresh removes it.
- Refreshing never moves focus and never re-announces the whole table; a polite live region says only "1 new
  payment is waiting" when the count grows.

## One payment (`/admin/escalations/:authorizationId`)

Shown for an escalation in any state.

**What it is** (FR-013): the reference code, who it is for, the seller and resource, the payee address, the amount,
when it was asked, and either the time left or the outcome ("Approved in the portal by …4f2a at 10:43",
"Rejected from the command line", "Approved by phone", "Expired at 10:47"). The time left is counted from the
answer's `readAt`, the portal's clock, as on the waiting list: a wrong local clock doesn't shift it.

**The budget** (FR-022), a small table from `budget`:

| Row | Shown as |
|---|---|
| This agent run | spent, limit, left |
| Last 24 hours (this policy, or the platform account) | spent, limit, left |
| Last 24 hours, all of this user's policies | spent, limit, left; only for a user's payment |

- `fits` false: a warning above the buttons, "Approving this will not make it payable: it is more than what is
  left." (FR-024). The buttons stay, because the budget can change before the agent retries.
- `applies` false: "No rule set of this user allows this seller right now, so approving will not make it
  payable.", or "This user's account is disabled." / "… has not finished setting up."

**Deciding**, only while the state is pending and `mine` is false:

- **Approve.** A confirm dialog repeats the seller, the payee, the amount, who it is for, the reference code and
  the time left: "Approve this one payment? The agent can then make it once, if it still fits the rules."
  Confirming sends the request.
  - 403 `step_up_required`: the dialog says "Confirm it's you to approve", with a "Confirm it's you" button (a
    sign-in window only opens from a click). After it, the same request is sent once more.
  - If the escalation expired meanwhile: "This payment expired before it was approved."
- **Reject.** A dialog with five radio buttons and no text field: "I didn't expect this payment", "The amount is
  too high", "It is the wrong seller", "It is a duplicate", "Another reason". One must be picked. No identity
  confirmation.
- After either: the outcome replaces the buttons, and a link goes back to the list.
- 409 `not_pending`: "This payment was already approved / rejected / has expired", with the path it was decided
  on; the screen reloads its state. Nothing is recorded.
- 403 `own_payment` (should not happen, since the buttons are hidden): "You can't decide your own payment."
- 502: "The control service can't be reached. Nothing was decided. Try again."; trying again is safe.

**When `mine` is true**: no buttons, and "This is a payment of your own agent run. Another administrator, the
operator or the phone approver can decide it." (FR-015).

## Activity (`/admin/activity`)

The trail, newest at the top, 50 events at a time (FR-020, FR-021).

- Each row: the time, the reference code, who it is for, the amount and what happened: "Asked for approval",
  "Phone request sent", "Phone request failed", "Approved", "Rejected", "Expired", "Approval not used in time".
  A decision adds the path ("in the portal", "from the command line", "by phone") and who decided; a portal
  rejection adds its reason's label.
- While the screen is open it asks for later events every 5 s and adds them at the top, marked "New". Nothing
  is kept in the browser between visits (T-WEB-07): a new visit shows the trail with no marks.
- "Show earlier" loads the 50 before the oldest shown. It is offered while `more` is true.
- A row links to the payment's screen.
- An operator's label and reason are text someone typed on a command line: shown as plain text, never as markup
  (FR-010).

## Ledger check (`/admin/ledger`)

One button, "Check the ledger". Then:

- verified: "The ledger verifies. 1,284 entries. Checked at 10:42:07."
- broken: an error banner, "The ledger does not verify from entry 311. The operator must act. Nothing can be
  repaired here.", with the entry count and the time (FR-025, FR-026).
- The check doesn't run by itself and offers nothing else.

## Text and safety

- Every string that comes from outside (a resource address, an operator's label or reason) is rendered as text.
  No administration screen uses `dangerouslySetInnerHTML` or builds a link from such a string.
- A user is shown by identifier only. No screen asks the portal for another person's name or email (FR-009).
- No screen has a free-text input, so nothing typed can reach the control layer (FR-016).
- Messages for the new error codes go in `messages.ts` with the existing ones.

## Accessibility and layout (NFR-008)

As in 013: phone and desktop widths, full keyboard use, visible focus, WCAG 2.1 AA contrast, each screen's
heading focused on arrival, dialogs that trap and restore focus. Added here:

- the countdown is text and is not announced every second; the live region speaks only when the count of
  waiting payments changes;
- the table has column headers and a caption; on a narrow screen each row becomes a labeled list;
- status is never conveyed by color alone: every tag has a word.

## Tests

| ID | Covers |
|---|---|
| T-WEB-09 | navigation by role: the link only for `admin`; an administrator who has not onboarded reaches the area while their own screens stay behind onboarding; a non-administrator's deep link shows "Not found" and makes no `/api/admin` request; onboarding redirects don't apply to `/admin…`; nothing with `config.admin.available` false |
| T-WEB-10 | the list: columns, the "Your payment" tag, the empty state, the countdown from `readAt` with a skewed local clock, a failed refresh keeps the last list, polling stops when the tab is hidden, the live region speaks only on a new payment, a refresh never moves focus |
| T-WEB-11 | deciding: the confirm dialog's content; the time left on the portal's clock with a skewed local clock; approve with the step-up replay from a click (the prompt reads "Confirm it's you to approve."); reject needs a reason and no confirmation of identity; no buttons when `mine` or not pending; the messages for `not_pending`, `own_payment`, expired and 502; the `fits` and `applies` warnings |
| T-WEB-12 | activity and ledger: paging by `before`, new events by `after`, the "New" mark on what arrives while the screen is open, nothing stored in the browser, an operator's reason containing markup shown as text; the ledger check's two results; `axe-core` finds no violation on the four screens |
