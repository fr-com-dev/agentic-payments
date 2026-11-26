# Contract: the wallet screen's connected platforms

What a person sees and can do. The screens call only the portal API ([portal-api.md](portal-api.md)) and hold nothing
but the person's own sign-in. Tests: T-WEB-17..21 (component tests in jsdom, each file with
`// @vitest-environment jsdom` and its own `cleanup`) and the manual pass in [quickstart.md](../quickstart.md).

## Screens

| Path | Screen | Shown when | Requirements |
|---|---|---|---|
| `/wallet` | Wallet (013), two parts | profile done | FR-012..FR-017 |
| `/wallet/coinbase` | Coinbase return (new) | the browser comes back from Coinbase | FR-009; [portal-api.md "The return screen"](portal-api.md#the-return-screen-walletcoinbase) |

`/wallet/coinbase` is a new row in `src/shared/portal-screens.ts` (name `coinbase-return`, example
`/wallet/coinbase`) and in `web/portal/src/routes.ts`; T-WEB-14 keeps them equal. Its "back" screen is `wallet`.

## The wallet: two parts

1. **"Your agent pays from this"**: the L2 account as in 013 (address, network, USDC balance and read time,
   committed, spent in the last 24 hours against the ceiling), then the cards. Unchanged but for the heading.
2. **"Coinbase · View only"**, shown when `connections` has a `coinbase` row:

| `status` | Shows |
|---|---|
| `not_connected` | "See your Coinbase balances here. The portal will only read them: your agent can't spend Coinbase funds." Links to the **Privacy policy** and **Support** (`privacyPolicyUrl`, `supportUrl`, FR-030), and a **Connect Coinbase** button. "Coinbase" is plain text: no Coinbase logo or button artwork (research R8) |
| `connected` | "Connected on <date>", the balances (below), **Refresh** and **Disconnect** |
| `reconnect` | "Coinbase no longer accepts this connection. Reconnect to see your balances." **Reconnect** and **Disconnect**. No figures |
| `unavailable` | "Coinbase isn't available on this deployment." **Disconnect** only |

With the account disabled, only **Disconnect** is offered.

## The balances

Loaded after the wallet, from `GET /api/connections/coinbase/balances`, so the first part never waits for them.

- One row per asset: the name, the code, the amount in its own units, and its value in US dollars, e.g.
  `Bitcoin · BTC   0.00012345   $12.34`. An asset without a value shows "no rate from Coinbase".
- Below the rows: **"Total in US dollars (at Coinbase's rates, 14:02:11)"** and the total; when `leftOutOfTotal` isn't empty,
  "Not counted: <codes>". When `more` is above 0: "and <more> more assets".
- The read time, always. With `stale: true`: "Couldn't reach Coinbase. These figures are from <time>." With
  `status: "unreadable"`: "Couldn't read your Coinbase balances. Try again in a moment."
- The total is never added to, or shown next to a sum with, the L2 account (FR-013).
- **Refresh** calls with `fresh=1` and is disabled for 10 s after each read.

Every amount is shown from its decimal string. The web app formats it by inserting group separators and a currency
sign into the string (`web/portal/src/money.ts` gains `formatDecimal`), never through `Number(` (T-WEB-03) or
`parseFloat`. Every name and code from Coinbase is rendered as React text, never as markup (hard rule 11).

## Connecting

**Connect Coinbase** (and **Reconnect**) calls `start` and sets `window.location` to `authorizeUrl` in the same tab.
Before it does, the button's text says "Going to Coinbase…". There is no pop-up: the sign-in survives the round trip in
session storage, and the opener of a pop-up would be cut by Coinbase's own isolation headers (research R2).

On the return screen:

| Answer from `complete` | Shows |
|---|---|
| 200 | the wallet, with "Coinbase connected." |
| query `error` (no call) | "Nothing was connected." and **Back to your wallet** |
| 400 `invalid_state` | "This connection wasn't started here, or took too long. Nothing was connected." **Try again** |
| 400 `scope_refused` `too_narrow` | "Coinbase didn't give permission to read your balances. Nothing was connected." **Try again** |
| 400 `scope_refused` `too_wide` | "Coinbase gave more access than reading. We refused it and nothing was connected." |
| 409 `profile_required`, `account_disabled` | as for the wallet in 013 |
| 502, 503 | "Coinbase couldn't be reached. Nothing was connected. Try again later." |

## Disconnecting

**Disconnect** asks "Disconnect Coinbase? The portal will forget its access and stop showing these balances." On yes,
`DELETE`; with `revokedAtPlatform: false`: "Disconnected here. Coinbase didn't confirm, so also remove the access in
Coinbase:" and a link to `https://accounts.coinbase.com/security/connections` (research R8; a constant in
`messages.ts`).

## Storage

Nothing of a connection is kept by the web app outside React state: no grant (it never has one), no code, no state
value, no balance in `localStorage` or `sessionStorage` (T-WEB-07 covers every source file; only
`web/portal/src/auth/auth0.ts` names session storage).
