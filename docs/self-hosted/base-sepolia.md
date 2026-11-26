# Moving the dev VPS from the local chain to Base Sepolia

How to switch the VPS's stack from `NETWORK=local` (ganache and the local facilitator) to Base Sepolia, and how to
switch back. No code changes: only env files and the processes that run. Sections 1 and 2 happen before the
cutover and touch nothing live.

It assumes:

- the live checkout on the VPS, written `<live>` below;
- each service starts with `ENV_FILE=env/<role>.env`, the default;
- people sign in with the tenant (Auth0), not the dev issuer.

Run every command in bash, from `<live>` unless a step says otherwise. Every command below writes secrets straight
into files and prints only names, addresses and status codes. Never paste a value from these files into a chat, an
issue, a commit or a log.

## What changes

| | Today (local) | On Base Sepolia |
|---|---|---|
| Chain | ganache on :8545, a mock USDC | Base Sepolia (`eip155:84532`), Circle's test USDC |
| Facilitator | a local process on :4022 | Coinbase's CDP facilitator, with your CDP key in the seller's file only. It pays gas |
| Processes | chain, facilitator, seller, L2, L3, agent, portal | seller, L2, L3, agent, portal |
| L2's ledger | `.local/ledger-local.jsonl` | `.local/ledger-base-sepolia.jsonl`, new and empty |
| Funding | `npm run fund-user` | the faucet at faucet.circle.com, by hand: `fund-user` refuses off local |
| Payments | seen on the VPS only | public on Base Sepolia, for good: payer, wallets, pay-to, amount and time |

These stay as they are: sign-in (the tenant, its roles, the desktop client), the host names, Caddy and the code.

**Everyone's account starts over.** The new ledger has no users, wallets, policies, cards, budgets or pending
escalations. People keep signing in, but each run gets `409 account_not_onboarded` until they save their profile
at the portal again. They then get a new wallet address to fund, and set their policies again (section 5). The local
ledger stays as it is, for a rollback.

## 1. Prepare

### 1.1 Accounts and addresses

- **A CDP Secret API key** from cdp.coinbase.com. It must be a production key: a Sandbox key fails with 401
  `facilitator authentication`. Choose Ed25519, which fits on one line. Without a CDP account, the seller can use
  x402.org's public facilitator instead (`FACILITATOR=public`, no key): set that and skip the CDP lines below.
- **A pay-to address**, where the seller is paid: an address of a test wallet whose key you keep elsewhere, never
  the payer's. It needs no funds.
- **An RPC endpoint for Base Sepolia (optional).** The public `https://sepolia.base.org` is rate-limited, and a
  throttled read ends in `PENDING`. Since SPEC 1.29.3, L3 shows and reports an endpoint as its origin only, so a key
  in the URL's path or query stays out of L3's log and L2's ledger. A key in the host name itself is still shown, so
  don't use an endpoint like that. Before 1.29.3, L3 printed the whole URL at startup and copied it, inside RPC errors,
  into L2's append-only ledger: run 1.29.3 or later with a keyed endpoint.

### 1.2 The VPS

Bring the checkout to the current `main` and run `npm install`, as for any update. It must be SPEC 1.29.3 or later:
from 1.29.2, a payment refused because the wallet is empty says so, and from 1.29.3, an RPC key stays out of L3's log
and L2's ledger.

The clock must be synchronized, because CDP's tokens expire after 120 s:

```bash
timedatectl show -p NTPSynchronized --value
```

Expect `yes`.

Check that no Base Sepolia ledger is there yet:

```bash
ls .local/ledger-base-sepolia.jsonl .local/ledger-base-sepolia.head.json
```

Expect `No such file or directory` for both. If L2's file sets `LEDGER_HEAD_URL=file:///<dir>`, look for the head
in `<dir>` too. If either file exists, from an earlier demo in this checkout, stop: L2 would take it over, with any
users it holds. Move both together out of `.local` only if you know they hold nothing you need. Never move one
without the other.

From a computer outside the VPS, check the ports:

```bash
nmap -Pn -p 4020-4025,8545 <the VPS's address>
```

Every port must be closed or filtered. The seller listens on every interface (`0.0.0.0:4021`). On Base Sepolia,
every priced request that reaches it can reach CDP with your key. If 4021 is open, close it in the VPS's firewall
first.

### 1.3 Write the Base Sepolia env files

Write a second set of files, `env/<role>.sepolia.env`, beside the live ones. Git ignores them (`env/*.env`). Each
starts as a copy of today's file, so the sign-in settings carry over unchanged: `AUTH_*`, `AGENT_CLIENT_IDS`,
`PORTAL_CLIENT_ID`, `SESSION_REF_SECRET`, `CIBA_*`, `LEDGER_HEAD_URL` and the rest.

Two helpers for this shell session:

```bash
umask 077
put() {  # put <role> <NAME> <value>: set one line of env/<role>.sepolia.env; prints nothing
  local f="env/$1.sepolia.env" t; t=$(mktemp)
  grep -v "^$2=" "$f" > "$t" || true
  printf '%s=%s\n' "$2" "$3" >> "$t" && mv "$t" "$f" && chmod 600 "$f"
}
drop() {  # drop <role> <NAME>: remove that line
  local f="env/$1.sepolia.env" t; t=$(mktemp)
  grep -v "^$2=" "$f" > "$t" || true
  mv "$t" "$f" && chmod 600 "$f"
}
```

Make the copies. A role with no live file starts from its template:

```bash
for r in seller l2-control l3-verifier l1-hosted portal operator; do
  if [ -f "env/$r.env" ]; then install -m 600 "env/$r.env" "env/$r.sepolia.env"; else install -m 600 "env/$r.env.example" "env/$r.sepolia.env"; fi
done
```

Set the network and remove the dev issuer:

```bash
for r in seller l2-control l3-verifier l1-hosted portal; do put "$r" NETWORK base-sepolia; drop "$r" AUTH_JWKS_FILE; done
```

**Role tokens.** Off local, a missing token stops the service: the `dev-…` defaults exist on local only. Each role
gets one new random value, written into both files that use it:

```bash
v=$(openssl rand -hex 32); put l2-control CONTROL_TOKEN "$v"; put l1-hosted CONTROL_TOKEN "$v"
v=$(openssl rand -hex 32); put l1-hosted VERIFIER_TOKEN "$v"; put l3-verifier VERIFIER_TOKEN "$v"
v=$(openssl rand -hex 32); put l2-control SETTLEMENT_TOKEN "$v"; put l3-verifier SETTLEMENT_TOKEN "$v"
v=$(openssl rand -hex 32); put l2-control OPERATOR_TOKEN "$v"; put operator OPERATOR_TOKEN "$v"
v=$(openssl rand -hex 32); put l2-control PORTAL_TOKEN "$v"; put portal PORTAL_TOKEN "$v"
v=$(openssl rand -hex 32); put l2-control PORTAL_ADMIN_TOKEN "$v"; put portal PORTAL_ADMIN_TOKEN "$v"; unset v
```

**The seller.** Set the pay-to address once; L2's lines use it too:

```bash
PAY_TO=<the pay-to address>
```

Leaving `FACILITATOR` unset means CDP on Base Sepolia. The seller refuses `FACILITATOR_URL` together with CDP, so
both lines go:

```bash
put seller SELLER_PAY_TO "$PAY_TO"; drop seller FACILITATOR; drop seller FACILITATOR_URL
```

```bash
read -rp 'CDP key ID: ' v; put seller CDP_API_KEY_ID "$v"; read -rsp 'CDP key secret: ' v; echo; put seller CDP_API_KEY_SECRET "$v"; unset v
```

**L2.** Off local, L2 refuses the published development key and mnemonic. It needs a payer key of its own, a
mnemonic of its own for people's wallets, and a MAC key for the new ledger:

```bash
put l2-control PAYER_PRIVATE_KEY "0x$(openssl rand -hex 32)"
```

To keep a Base Sepolia payer that already holds test USDC, enter its key instead:
`read -rsp 'payer key: ' v; echo; put l2-control PAYER_PRIVATE_KEY "$v"; unset v`.

```bash
put l2-control USER_WALLET_MNEMONIC "'$(npm run -s wallet-mnemonic)'"
```

```bash
put l2-control LEDGER_MAC_KEY "$(openssl rand -hex 32)"
```

The plain `<secret>` form keys the new ledger from its first entry. Don't use the `<entries>:<secret>` form here:
L2 refuses to start on a ledger with fewer entries than that count.

Off local, every payment must be bound to known payees. The seller in `config/platform.json` has none, so L2
would refuse to start. The seller's host must be the one in the agent's `SELLER_URL`:

```bash
grep '^SELLER_URL=' env/l1-hosted.sepolia.env
```

Expect `SELLER_URL=http://127.0.0.1:4021`. If it shows another host, use that host in the next two commands.

```bash
put l2-control ALLOWED_PAYEES "$PAY_TO"; put l2-control ALLOWED_HOSTS 127.0.0.1:4021
```

```bash
put l2-control PLATFORM_SELLERS "'[{\"host\":\"127.0.0.1:4021\",\"name\":\"Demo seller (Base Sepolia)\",\"payees\":[\"$PAY_TO\"]}]'"
```

Turn on user accounts and the administration area in the file. Off local, `stack:local`'s flags don't set them:

```bash
put l2-control USER_ACCOUNTS 1; put l2-control PORTAL_ADMIN 1
```

**L3 and the portal**, only with an RPC endpoint of your own (1.1):

```bash
read -rsp 'RPC URL: ' v; echo; put l3-verifier BASE_SEPOLIA_RPC_URL "$v"; put portal BASE_SEPOLIA_RPC_URL "$v"; unset v
```

**Check the files.** These commands print names only:

```bash
need() { local r=$1; shift; for k; do grep -q "^$k=." "env/$r.sepolia.env" || echo "env/$r.sepolia.env: $k missing"; done; }
need seller NETWORK SELLER_PAY_TO CDP_API_KEY_ID CDP_API_KEY_SECRET
need l2-control NETWORK PAYER_PRIVATE_KEY USER_WALLET_MNEMONIC LEDGER_MAC_KEY ALLOWED_PAYEES ALLOWED_HOSTS PLATFORM_SELLERS USER_ACCOUNTS PORTAL_CLIENT_ID AUTH_ISSUER AUTH_AUDIENCE AGENT_CLIENT_IDS CONTROL_TOKEN SETTLEMENT_TOKEN OPERATOR_TOKEN PORTAL_TOKEN PORTAL_ADMIN_TOKEN
need l3-verifier NETWORK CONTROL_URL VERIFIER_TOKEN SETTLEMENT_TOKEN
need l1-hosted NETWORK SELLER_URL CONTROL_URL SETTLEMENT_URL CONTROL_TOKEN VERIFIER_TOKEN AUTH_ISSUER AUTH_AUDIENCE AGENT_CLIENT_IDS SESSION_REF_SECRET
need portal NETWORK CONTROL_URL PORTAL_TOKEN PORTAL_ADMIN_TOKEN AUTH_ISSUER AUTH_AUDIENCE PORTAL_CLIENT_ID
need operator CONTROL_URL OPERATOR_TOKEN
grep -lE '=dev-|^AUTH_JWKS_FILE=|dev-issuer|x402-[a-z-]+-dev' env/*.sepolia.env || echo "no development values"
```

Expect no `missing` line, and `no development values`. With `FACILITATOR=public`, the two CDP lines are not needed.
A file named by the last command still holds a development value (a `dev-…` token, the dev issuer or a dev client
ID), usually because it started from its template: set the tenant's values there.

A variable that a service's own environment sets wins over its file: the services load the file without overriding
anything. So the supervisor must not set any of these names, `NETWORK` above all. With systemd, check with
`systemctl show <unit> -p Environment`.

### 1.4 Back up the new secrets

Four values have no other copy:

- `PAYER_PRIVATE_KEY`, `USER_WALLET_MNEMONIC` and `LEDGER_MAC_KEY`, in L2's file
- the CDP key, in the seller's file

Open the files in an editor on the VPS and copy these values to where you keep the payer key's backup, such as a
password manager. If you lose the mnemonic, you lose every person's wallet. If you lose the MAC key, L2 can't start
on this ledger. Once L2 has run with either, never change it in place.

## 2. Rehearse in a second checkout

`npm run demo:base-sepolia` runs the scripted plan on Base Sepolia. It checks the CDP key, the payer's funds, the
RPC and finality before anything live changes, and spends 0.006 test USDC. Run it in a second checkout: L2's
ledger path is relative to the checkout, and an append-only ledger can't lose the demo's entries afterwards. Give it
other ports, because the live stack still holds 4020 to 4023.

```bash
git clone --quiet <live> ~/x402-rehearsal && npm --prefix ~/x402-rehearsal install
```

The demo reads four files of its own (`specs/009` quickstart). This block writes them from the files in 1.3, with
the same payer, pay-to address and CDP key, new tokens and ports 5020 to 5023:

```bash
L=<live>; R=~/x402-rehearsal; umask 077
val() { grep "^$2=" "$L/env/$1.sepolia.env" | cut -d= -f2-; }
T1=$(openssl rand -hex 32) T2=$(openssl rand -hex 32) T3=$(openssl rand -hex 32) T4=$(openssl rand -hex 32)
{ grep -v '^SELLER_PORT=' "$L/env/seller.sepolia.env"; echo SELLER_PORT=5021; } > "$R/env/seller.base-sepolia.env"
printf '%s\n' NETWORK=base-sepolia "PAYER_PRIVATE_KEY=$(val l2-control PAYER_PRIVATE_KEY)" "ALLOWED_PAYEES=$(val l2-control ALLOWED_PAYEES)" \
  ALLOWED_HOSTS=127.0.0.1:5021 CONTROL_PORT=5020 "CONTROL_TOKEN=$T1" "SETTLEMENT_TOKEN=$T2" "OPERATOR_TOKEN=$T3" > "$R/env/l2-control.base-sepolia.env"
printf '%s\n' NETWORK=base-sepolia CONTROL_URL=http://127.0.0.1:5020 SETTLEMENT_PORT=5023 "VERIFIER_TOKEN=$T4" "SETTLEMENT_TOKEN=$T2" > "$R/env/l3-verifier.base-sepolia.env"
grep '^BASE_SEPOLIA_RPC_URL=' "$L/env/l3-verifier.sepolia.env" >> "$R/env/l3-verifier.base-sepolia.env"
printf '%s\n' NETWORK=base-sepolia SELLER_URL=http://127.0.0.1:5021 CONTROL_URL=http://127.0.0.1:5020 SETTLEMENT_URL=http://127.0.0.1:5023 \
  "CONTROL_TOKEN=$T1" "VERIFIER_TOKEN=$T4" > "$R/env/l1-agent.base-sepolia.env"
unset T1 T2 T3 T4
```

To find the payer's address, start the rehearsal's L2 alone. It prints the address in its first line:

```bash
cd ~/x402-rehearsal && ENV_FILE=env/l2-control.base-sepolia.env npm run -s l2:control
```

Expect `l2-control listening on http://127.0.0.1:5020 (network base-sepolia, payer 0x…)`. Note the address and stop
L2 with Ctrl-C.

Fund the payer at faucet.circle.com (Base Sepolia, that address). It needs no ETH. Then check its balance:

```bash
npm run -s payer-balance -- <the payer's address>
```

Expect `balance=…` and exit 0. The minimum is 50000 atomic units (0.05 USDC). With an RPC endpoint of your own,
set `BASE_SEPOLIA_RPC_URL` in this command's environment: it reads no env file.

```bash
npm run demo:base-sepolia
```

Expect:

- `spent on-chain: 0.006 USDC` and `hash chain ok=true`
- `settlements: 2 CONFIRMED`
- `payer gas spent: 0 wei`
- `secret scan: clean`
- exit 0

Then delete `~/x402-rehearsal`: it holds copies of the payer key and the CDP key.

## 3. Cut over

Tell people beforehand: runs fail during the window, and their account starts over (section 5).

### 3.1 Stop the local stack

Stop the agent and the portal first, so no new run starts. Then stop L3, L2, the seller, the local facilitator and
the chain, the way they are supervised today. Ganache must really exit: stop it by process group, or it keeps port
8545 open. Then check:

```bash
ss -ltn | grep -E ':(4020|4021|4022|4023|4024|4025|8545)\b' || echo "all stopped"
```

### 3.2 Swap the files

```bash
for r in seller l2-control l3-verifier l1-hosted portal operator; do
  if [ -f "env/$r.env" ]; then mv "env/$r.env" "env/$r.local.env"; fi; mv "env/$r.sepolia.env" "env/$r.env"
done
```

The local files stay, as `env/<role>.local.env`, for a rollback. Leave `env/facilitator.env` as it is: nothing
starts it now.

### 3.3 Start in order

Start each process as its own long-running service, under whatever supervises them (systemd, for example). Don't use
`npm run stack:local`: it always starts the chain and the local facilitator, and its `--users`, `--admin` and
`--sign-in` flags only apply on local. Wait for each first line before starting the next process:

| # | Command | Its first lines say |
|---|---|---|
| 1 | `ENV_FILE=env/seller.env npm run seller` | `seller listening on 0.0.0.0:4021 (eip155:84532, facilitator=cdp host=api.cdp.coinbase.com…)` |
| 2 | `ENV_FILE=env/l2-control.env npm run l2:control` | `user accounts on (platform platform-poc-001, 1 sellers)`, `callers' tokens verified (issuer https://…/)`, `ledger keyed (from entry 0)`, `portal administration on`, then `l2-control listening on http://127.0.0.1:4020 (network base-sepolia, payer 0x…)` with the payer you funded |
| 3 | `ENV_FILE=env/l3-verifier.env npm run l3:verifier` | `l3-verifier listening on http://127.0.0.1:4023 (network base-sepolia, rpc https://sepolia.base.org)`, or your endpoint's origin followed by `/…` |
| 4 | `ENV_FILE=env/l1-hosted.env npm run agent:hosted` | `l1-hosted listening on http://127.0.0.1:4024 (provider …, model …)` |
| 5 | `ENV_FILE=env/portal.env npm run portal` | `portal listening on http://127.0.0.1:4025 (network base-sepolia, sign-in …, cards …, administration on)` |

If a process refuses to start, its message names the setting: see section 7.

## 4. Check

| # | Check | Expect |
|---|---|---|
| 1 | `ENV_FILE=env/operator.env npm run -s ledger-verify` | `entries=… ok=true` |
| 2 | `npm run -s payer-balance -- <the payer's address>` | `balance=…`, exit 0 |
| 3 | `curl -sS http://127.0.0.1:4024/readyz` | `{"status":"ready"}` |
| 4 | `curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4021/api/weather` | `402`: the seller asks for payment |
| 5 | A machine caller's run, only if the `checks` caller's key is on the VPS. Put `NETWORK=base-sepolia`, `MACHINE_CLIENT_ID`, `MACHINE_CLIENT_KEY_ID`, `MACHINE_CLIENT_KEY`, `AUTH_ISSUER` and `AUTH_AUDIENCE` in `env/l1-agent.env`, with no `CALLER_TOKEN`, then run `ENV_FILE=env/l1-agent.env AGENT_URL=https://agent.fabriciorojas.com npx tsx src/smoke-main.ts` | exit 0: two purchases, paid by the platform account and confirmed |
| 6 | A person's run, after section 5: a goal from the desktop client | `PAID` with a transaction hash. At `https://sepolia.basescan.org/tx/<hash>`, a USDC transfer from the person's wallet to the pay-to address |
| 7 | `ENV_FILE=env/operator.env npm run -s ledger-verify` again | more entries, `ok=true` |
| 8 | Each service's log since the cutover, piped into `npm run -s scan-logs`. With journald: `journalctl -u <unit> --since '<cutover time>' -o cat \| npm run -s scan-logs` | `scan-logs: clean (… lines)` for each service |

## 5. What each person does

1. Sign in at the portal, as before.
2. Save their profile again and confirm that the funds are test funds. L2 then makes them a new account and a new
   wallet. Their name and email are still on the portal's disk. Their old policy names don't come back.
3. Fund the wallet address the portal shows, at faucet.circle.com, on Base Sepolia. A run from an empty wallet ends
   in `PAYMENT_FAILED` with `invalid_exact_evm_insufficient_balance`. The faucet limits each address, but one
   request covers many runs: a payment is at most 0.1 USDC, and a day at most 0.5.
4. Set their expense policies, and add their cards, again.

Their Auth0 roles and their sign-ins in the desktop client stay valid. Escalations still pending in the local ledger
stay there and don't appear at the portal.

## 6. What behaves differently

- A payment takes a few seconds: CDP verifies and settles it. Up to 0.01 USDC counts once it's in a block. Up to
  1 USDC waits for 2 confirmations, one more block. The 0.1 USDC cap per payment keeps every payment in those two
  classes.
- L3 waits up to 45 s for a receipt, then reports `PENDING`. A throttled RPC also ends in `PENDING`. Either way the
  amount stays counted against the budget until L3 checks again.
- When a payment never settles, its amount stops counting only after the authorization's `validBefore`, at most
  300 s, plus 60 s.
- If CDP is down, the seller answers 502 and the step ends in `PAYMENT_FAILED`; nothing moved.
- `npm run fund-user`, `npm run dev-token` and `CALLER_TOKEN` refuse to work off local.

## 7. If a process refuses to start, or a check fails

| Message or symptom | Fix |
|---|---|
| `missing CONTROL_TOKEN` (or another token) | Off local a token has no default: the token lines in 1.3 |
| `PAYER_PRIVATE_KEY is a published development key` | A payer key of its own (1.3) |
| `USER_WALLET_MNEMONIC is a published development mnemonic` | A mnemonic of its own (1.3) |
| `PAYER_PRIVATE_KEY is missing or malformed` | `0x` and 64 hex characters |
| `ALLOWED_PAYEES … must name the seller's payees outside NETWORK=local`, or `the platform seller list's entry 0 has no payees` | The payee lines in 1.3 |
| L2 says its ledger doesn't verify on the first start | `LEDGER_MAC_KEY` in its `<entries>:<secret>` form, or a head left by an earlier run (1.2) |
| `FACILITATOR=cdp cannot be combined with FACILITATOR_URL` | `drop seller FACILITATOR_URL` |
| `facilitator authentication` (401) | A Sandbox CDP key, or the VPS's clock: a production key, and `timedatectl` |
| `invalid_exact_evm_insufficient_balance` | The payer or the person's wallet has no test USDC: the faucet |
| Runs end in `PENDING` | The RPC throttles or lags: an RPC endpoint of your own (1.1) |
| `409 account_not_onboarded` | The person hasn't saved their profile since the cutover (section 5) |
| The agent or the portal refuses to start, naming `AUTH_JWKS_FILE` | The dev issuer exists on local only: `drop <role> AUTH_JWKS_FILE` |

## 8. Roll back

Stop the five services, then swap the files back:

```bash
for r in seller l2-control l3-verifier l1-hosted portal operator; do
  mv "env/$r.env" "env/$r.sepolia.env"; if [ -f "env/$r.local.env" ]; then mv "env/$r.local.env" "env/$r.env"; fi
done
```

Start the local stack the way it ran before. L2 opens `.local/ledger-local.jsonl` again, untouched, with its users
and the old mnemonic. The Base Sepolia ledger stays, and people's Base Sepolia wallets keep their funds on-chain. To
go back to Base Sepolia, swap the files again, with the same mnemonic and MAC key.

## Reference: the files once written

Only the names this move sets or must keep; every other line of today's files stays. `<…>` is a value of yours.

`env/seller.env`:

```ini
NETWORK=base-sepolia
SELLER_PAY_TO=<the pay-to address>
CDP_API_KEY_ID=<CDP key ID>
CDP_API_KEY_SECRET=<CDP key secret, Ed25519, one line>
# no FACILITATOR (CDP is the default on base-sepolia) and no FACILITATOR_URL
```

`env/l2-control.env`:

```ini
NETWORK=base-sepolia
PAYER_PRIVATE_KEY=<0x and 64 hex: never a published development key>
USER_WALLET_MNEMONIC='<24 words from npm run -s wallet-mnemonic>'
LEDGER_MAC_KEY=<64 hex: the plain form, for the new ledger>
ALLOWED_PAYEES=<the pay-to address>
ALLOWED_HOSTS=127.0.0.1:4021
PLATFORM_SELLERS='[{"host":"127.0.0.1:4021","name":"Demo seller (Base Sepolia)","payees":["<the pay-to address>"]}]'
USER_ACCOUNTS=1
PORTAL_ADMIN=1
CONTROL_TOKEN=<random, shared with l1-hosted>
SETTLEMENT_TOKEN=<random, shared with l3-verifier>
OPERATOR_TOKEN=<random, shared with operator>
PORTAL_TOKEN=<random, shared with portal>
PORTAL_ADMIN_TOKEN=<random, shared with portal>
# kept from today: AUTH_ISSUER, AUTH_AUDIENCE, AGENT_CLIENT_IDS, PORTAL_CLIENT_ID, and CIBA_* and LEDGER_HEAD_URL if set
```

`env/l3-verifier.env`:

```ini
NETWORK=base-sepolia
CONTROL_URL=http://127.0.0.1:4020
VERIFIER_TOKEN=<random, shared with l1-hosted>
SETTLEMENT_TOKEN=<random, shared with l2-control>
# optional: BASE_SEPOLIA_RPC_URL=<your endpoint; a key in its path or query is fine since 1.29.3, never in its host>
```

`env/l1-hosted.env`:

```ini
NETWORK=base-sepolia
SELLER_URL=http://127.0.0.1:4021
CONTROL_TOKEN=<random, shared with l2-control>
VERIFIER_TOKEN=<random, shared with l3-verifier>
# no AUTH_JWKS_FILE; kept from today: AUTH_ISSUER, AUTH_AUDIENCE, AGENT_CLIENT_IDS, AGENT_DESKTOP_CLIENT_ID,
# SESSION_REF_SECRET, the model's settings, TRUSTED_PROXY_HOPS
```

`env/portal.env`:

```ini
NETWORK=base-sepolia
PORTAL_TOKEN=<random, shared with l2-control>
PORTAL_ADMIN_TOKEN=<random, shared with l2-control>
# optional: BASE_SEPOLIA_RPC_URL=<the same endpoint as L3's>
# no AUTH_JWKS_FILE; kept from today: AUTH_ISSUER, AUTH_AUDIENCE, PORTAL_CLIENT_ID, PORTAL_ADMIN, TRUSTED_PROXY_HOPS
```

`env/operator.env`:

```ini
CONTROL_URL=http://127.0.0.1:4020
OPERATOR_TOKEN=<random, shared with l2-control>
```

`env/facilitator.env` and the chain are no longer used.
