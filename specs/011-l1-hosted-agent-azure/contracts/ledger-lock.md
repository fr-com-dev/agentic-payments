# Contract: one ledger writer (proposed SPEC L2-6)

**Owner**: `src/layer2-control/ledger-lock.ts`, called from `main()` in
`src/layer2-control/service.ts`. `createControlService` never takes the lock, so tests and the
in-process harness are unchanged.

## Startup order (amends the `main()` order in L2-5)

env → **acquire the ledger lock** → ledger load and integrity check → profile → mandate → signer →
listen.

## Algorithm

1. **Try to create.** `lockPath = ledgerPath + ".lock"`. Create it with `O_CREAT|O_EXCL` (`flag:
   "wx"`) holding `{ holder, pid, host, acquiredAt, heartbeatAt }`. On success go to step 4.
2. **Lock exists.** Read it.
   - If `now − heartbeatAt < 30 s`, log once:
     `l2-control: ledger locked by <holder> (pid <pid> on <host>); waiting`. Then poll every 1 s
     and repeat step 1.
   - An unreadable or half-written lock counts as fresh for one more poll, then as stale.
3. **Stale lock (≥ 30 s without a heartbeat).** Rename it to `<lockPath>.stale.<holder>.<ms>`.
   Log `l2-control: took over a stale ledger lock from <holder>`, then go to step 1.
4. **Holder.**
   - Every 5 s, write the lock with a new `heartbeatAt` to `<lockPath>.tmp` and rename it over
     `lockPath`. The timer is unreferenced.
   - If a heartbeat finds the lock missing or owned by another holder, exit 1 with
     `l2-control: lost the ledger lock`. Never continue as a second writer.
5. **Shutdown.** On SIGTERM or SIGINT, stop listening, delete `lockPath` if it is still this
   holder's, and exit 0.

Constants: heartbeat 5 s, stale after 30 s, poll 1 s. They are not configurable.

## Guarantees and limits

- **Guarantee**: with one contender at a time, at most one L2 process holds the lock and appends
  to the ledger.
- **Handover**: a replacement reads the ledger only after it holds the lock, so it sees every
  entry the old writer appended.
- **Limit**: two contenders taking over the same stale lock at the same moment could both succeed.
  Single-replica deployment (`maxReplicas: 1`) and a stop or crash of the old holder make that
  impossible in Azure, and a second local start on the same ledger already fails on the port. It
  is written into L2-6 as accepted.
- **Storage**: in Azure, the NFS share is mounted at `/app/.local`, L2's working-directory
  `.local/`. The ledger path (`ledgerPathFor`) and the lock path therefore need no code change.
  Exclusive create and rename are POSIX operations on NFS 4.1.
- **Probes**: L2's container-app probes are TCP on the sidecar port, so a standby replica is
  "ready", and the platform can retire the old revision, which releases the lock.

## Tests (T-LED-05)

- A second `main()` on the same ledger path waits while the first holds a fresh lock, and starts
  within 2 s after the first exits on SIGTERM.
- A lock whose heartbeat is 31 s old is taken over, with the log line.
- A holder whose lock file is replaced by another holder exits 1.
- **Must fail**: two `AuditLedger` writers opened on the same file without the lock each append
  an entry. Reloading the file then throws `integrity` (a forked chain). With the lock, the second
  writer never gets to open the file, because its `acquireLedgerLock` is still waiting.
