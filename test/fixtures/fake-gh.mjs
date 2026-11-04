// A fake `gh` for test/github-setup.test.ts and test/cleanup.test.ts: records each call as one JSON line
// ({args, stdin}) in the file named by FAKE_GH_LOG, with the stdin of `secret set`. The repository holds the
// secrets in FAKE_GH_EXISTING (space-separated), its environments' secrets in FAKE_GH_ENV_SECRETS and the
// environments in FAKE_GH_ENVIRONMENTS, changed by the calls logged so far:
// - `secret list` prints the names it holds (with --env, the environment's), one per line, as `--jq '.[].name'` would;
// - `api repos/<repo>/environments/<name>` (a GET) exits 1 with HTTP 404 unless the environment exists;
// - `api --method PUT|DELETE`, `secret set` and `secret delete` change what it holds.
// Unknown commands exit 99.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const log = process.env.FAKE_GH_LOG;
const args = process.argv.slice(2);
const cmd = args.slice(0, 2).join(" ");
const record = (stdin) => appendFileSync(log, `${JSON.stringify({ args, stdin })}\n`);
const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const split = (v) => (v ?? "").split(" ").filter(Boolean);

/** The secret names and environment paths the repository holds after the calls so far. */
function holdings() {
  const secrets = new Set(split(process.env.FAKE_GH_EXISTING));
  const environments = new Set(split(process.env.FAKE_GH_ENVIRONMENTS));
  for (const c of calls()) {
    if (c.args[0] === "secret" && c.args[1] === "set") secrets.add(c.args[2]);
    if (c.args[0] === "secret" && c.args[1] === "delete") secrets.delete(c.args[2]);
    const method = c.args[0] === "api" ? c.args[c.args.indexOf("--method") + 1] : undefined;
    const path = c.args.find((a) => a.startsWith("repos/"));
    if (method === "PUT") environments.add(path.split("/").pop());
    if (method === "DELETE") environments.delete(path.split("/").pop());
  }
  return { secrets, environments };
}

if (args[0] === "api") {
  record(null);
  if (!args.includes("--method")) {
    const name = args.find((a) => a.startsWith("repos/")).split("/").pop();
    if (!holdings().environments.has(name)) {
      process.stderr.write("gh: Not Found (HTTP 404)\n");
      process.exit(1);
    }
  }
} else if (cmd === "secret set") record(readFileSync(0, "utf8"));
else if (cmd === "secret delete") {
  if (!holdings().secrets.has(args[2])) {
    process.stderr.write(`gh: no secret ${args[2]} (HTTP 404)\n`);
    process.exit(1);
  }
  record(null);
} else if (cmd === "secret list") {
  record(null);
  const names = args.includes("--env") ? split(process.env.FAKE_GH_ENV_SECRETS) : [...holdings().secrets];
  for (const name of names) process.stdout.write(`${name}\n`);
} else {
  process.stderr.write(`fake gh: unknown command ${args.join(" ")}\n`);
  process.exit(99);
}
