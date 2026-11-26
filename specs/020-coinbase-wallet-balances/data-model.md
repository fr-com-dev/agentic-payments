# Data model: connected platforms (Coinbase balances)

Three places hold something about a connection, and each holds the least it can:

| Place | Holds | Never holds |
|---|---|---|
| L2's ledger (hash-chained, append-only) | that a connection was made or ended: user, `connectionId`, platform, time, `cause` | a grant, a Coinbase identifier, a balance, a name, an email |
| The portal's grant store (one file per user, on the profiles' share) | the encrypted grant and the connection's status | a balance, an access token, any Coinbase text |
| The portal's memory | the access token (until it expires), pending connection starts (10 min), the last balances (20 s), Coinbase's public USD rates (60 s, shared) | anything past a restart |

The browser holds nothing of this between screens: no grant, no token, no balance in any storage (T-WEB-07).

## Ledger entries

See [contracts/control-api.md](contracts/control-api.md#ledger-entries-l2-4): `CONNECTION_OPENED` and
`CONNECTION_CLOSED`. `userState` (`src/layer2-control/users.ts`) derives:

```ts
interface UserState {
  // … 013 fields unchanged …
  /** Active connections, in the order they were made. At most one per platform. */
  connections: UserConnectionView[];
}
// As built: reuse is checked by `connectionSeen(entries, connectionId)` in users.ts, over every user's entries, so an
// identifier once opened by anyone is never opened again (409 connection_reused).
```

The user view (`UserView`, SPEC §7) carries `connections` as they are. It is the feature's only contract change, in
`src/shared/contracts.ts`; `PaymentIntent`, `AuthorizationDecision` and `BudgetStatus` don't change:

```ts
type ConnectedPlatform = "coinbase";
interface UserConnectionView {
  connectionId: string;
  platform: ConnectedPlatform;
  connectedAt: string;     // ISO time: the `ts` of the connection's CONNECTION_OPENED entry
}
// UserView gains: connections: UserConnectionView[];
```

No policy, budget or decision function reads either field (FR-020); the architecture test keeps `policy.ts`,
`signer.ts` and `ledger-key.ts` from naming them (T-ARCH-A18, rule part 3).

## Grant store (portal)

One JSON file per user, `<CONNECTION_DIR>/<userId>.json` (default `.local/portal/connections`; in Azure and on the VPS,
a folder beside the profiles on the portal's own share). Mode 0600, written to a temporary file and renamed, as the
profile store does. Read and written only by `src/portal/coinbase/grants.ts` (rule A18).

```ts
interface GrantFile {
  userId: string;                       // ^usr_[0-9a-f]{32}$; must equal the file's name
  connections: StoredConnection[];      // at most one per platform
}

interface StoredConnection {
  connectionId: string;                 // ^conn_[0-9a-f-]{36}$, made by the portal
  platform: "coinbase";
  status: "connected" | "reconnect";    // "reconnect": Coinbase refused the grant (FR-017); kept until the user acts
  connectedAt: string;                  // ISO time
  grant?: SealedGrant;                  // absent once status is "reconnect" (the dead grant is forgotten)
}

interface SealedGrant {
  v: 1;
  /** AES-256-GCM under COINBASE_GRANT_KEY. Additional data: "x402-grant-v1\n" + userId + "\n" + connectionId + "\n"
   *  + platform, so a grant moved to another user's file, or to another connection, fails to open. */
  iv: string;                           // base64, 12 bytes, random per seal
  ct: string;                           // base64: the sealed GrantSecret
  tag: string;                          // base64, 16 bytes
}

/** What is sealed. Never leaves grants.ts unsealed except to client.ts, in memory. */
interface GrantSecret {
  refreshToken: string;
  scopes: string[];                     // as granted, already checked against the allow-list
  refreshedAt: string;
}
```

A disconnected connection is removed from the file (the ledger keeps the history). Disabling the account removes it
too (FR-019).

### State transitions

```text
(none) --start--> pending (memory, 10 min, single use)
pending --complete: code exchanged, scopes allowed, L2 PUT ok--> connected
pending --cancel / refused at Coinbase / scope refused / expired / wrong person or sign-in--> (none)   [grant revoked if one was issued]
connected --refresh refused by Coinbase (revoked, expired)--> reconnect
connected | reconnect --disconnect (user) | account disabled--> (none)                      [revoke at Coinbase, L2 DELETE]
connected --connect again--> (none) for the old one, connected for the new one             [L2 PUT replaces; old revoked]
```

## Pending start (portal memory)

```ts
interface PendingStart {
  state: string;          // 32 random bytes, base64url; the map key
  userId: string;         // the person whose token started it
  signedInAtMs: number;   // that token's sign-in time claim (the portal's identityConfirmedAtMs): complete must
                          // come from the same sign-in, so a return after a sign-out and back is refused (FR-009)
  codeVerifier: string;   // PKCE S256, 32 random bytes, base64url (research R3)
  createdAtMs: number;    // expires 10 minutes after (FR-009)
}
```

Deleted on first use, success or not. At most 3 pending per user; a fourth start drops the oldest. Lost on restart:
the person starts again.

## Balances (portal memory, 20 s)

What `GET /api/connections/coinbase/balances` returns (see [contracts/portal-api.md](contracts/portal-api.md)):

```ts
interface PlatformBalances {
  readAt: string;                        // ISO time of the read the figures come from
  stale: boolean;                        // true: the last read failed and these are older figures
  assets: PlatformAsset[];               // funded assets only, at most 200, largest value first, then by code
  more: number;                          // how many funded assets were not listed (0 normally)
  moreIsAtLeast?: true;                  // Coinbase had more than the 10 pages read: `more` is a lower bound
  total?: Money;                         // exact sum of every listed asset's value; absent when none has one
  leftOutOfTotal: string[];              // codes of listed assets with no value from Coinbase
}

interface PlatformAsset {
  code: string;                          // the currency code Coinbase reports, e.g. "BTC" (shown as text)
  name: string;                          // Coinbase's name for it, cut to 60 characters (shown as text)
  amount: string;                        // exact decimal string as Coinbase reports it, e.g. "0.00012345"
  value?: Money;                         // amount ÷ Coinbase's USD rate for `code`, half-to-even to the cent (research R7)
}

interface Money {
  amount: string;                        // decimal string with exactly 2 places, e.g. "1234.56"
  currency: "USD";
}

/** Coinbase's public rates, from one call `GET /v2/exchange-rates?currency=USD`; shared by every user for 60 s. */
interface UsdRates {
  readAt: string;
  rates: Map<string, string>;            // code → how many units of it one US dollar buys, a decimal string
}
```

Validation of what Coinbase sends, before anything is kept or shown:
- `balance.amount` and every rate match `^-?[0-9]{1,30}(\.[0-9]{1,30})?$`; anything else drops that asset (or that
  rate) and logs `coinbase_bad_amount` (no value in the log);
- `balance.currency` must equal `currency.code`, or the asset is dropped the same way;
- `type` must be `wallet`, `fiat` or `vault`; `dex_wallet` and any type Coinbase adds later are dropped;
- an asset whose amount is zero is dropped (FR-013); a negative amount is shown as reported;
- `code` matches `^[A-Za-z0-9._-]{1,16}$`; `name` loses control characters and is cut to 60 characters;
- the value: for `USD` the amount itself (rounded to the cent); otherwise `divideRounded(amount, rate, 2)`; a
  missing, zero or negative rate means no value, and the code goes in `leftOutOfTotal`;
- the total is `addDecimal` over the values shown, in `src/shared/decimal.ts` (strings to scaled `BigInt` and back;
  no `Number`), pure and tested on its own (Constitution VI);
- `assets` are the funded ones in value order (an asset with no value last, then by code), at most 200.

## Portal log events (whitelist additions)

Each connection event is a log line of its own, naming only the event and the user (spec FR-029):

```json
{ "time": "…", "route": "connections", "status": 0, "ms": 0, "userId": "usr_…", "event": "coinbase_connected" }
```

`event` is one of the fixed labels `coinbase_connected`, `coinbase_disconnected`, `coinbase_replaced`,
`coinbase_reconnect_needed`, `coinbase_scope_refused`, `coinbase_state_refused`, `coinbase_unavailable`,
`coinbase_revoke_failed`, `coinbase_rate_limited`, `coinbase_bad_amount`, `coinbase_reconciled`,
`coinbase_scope_unverified`, `coinbase_grant_write_failed`, `coinbase_client_refused` (Coinbase refused the portal's
own client: no grant is touched), `coinbase_store_unreadable` (a grant file exists but can't be read: 503 `unavailable`,
and nothing is reconciled). `LOG_KEYS` doesn't change. Never a `connectionId`, a
token, a code, a `state` value or Coinbase's text.
