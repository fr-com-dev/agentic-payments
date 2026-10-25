// T-LED-05 child process: holds the ledger lock for argv[2] until SIGTERM, then releases it and exits 0.
import { acquireLedgerLock } from "../../src/layer2-control/ledger-lock.js";

const lock = await acquireLedgerLock(process.argv[2]!);
process.on("SIGTERM", () => {
  lock.release();
  process.exit(0);
});
process.stdout.write("held\n");
setInterval(() => undefined, 60_000);
