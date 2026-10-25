// A fake `gh` for test/github-setup.test.ts: records each call as one JSON line ({args, stdin}) in the file named
// by FAKE_GH_LOG, with the stdin of `secret set`. `secret list` prints the names set so far and those in
// FAKE_GH_EXISTING (space-separated), one per line, as `--jq '.[].name'` would. Unknown commands exit 99.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const log = process.env.FAKE_GH_LOG;
const args = process.argv.slice(2);
const cmd = args.slice(0, 2).join(" ");
const record = (stdin) => appendFileSync(log, `${JSON.stringify({ args, stdin })}\n`);

if (args[0] === "api") record(null);
else if (cmd === "secret set") record(readFileSync(0, "utf8"));
else if (cmd === "secret list") {
  record(null);
  const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const set = calls.filter((c) => c.args[0] === "secret" && c.args[1] === "set").map((c) => c.args[2]);
  const existing = (process.env.FAKE_GH_EXISTING ?? "").split(" ").filter(Boolean);
  for (const name of [...new Set([...existing, ...set])]) process.stdout.write(`${name}\n`);
} else {
  process.stderr.write(`fake gh: unknown command ${args.join(" ")}\n`);
  process.exit(99);
}
