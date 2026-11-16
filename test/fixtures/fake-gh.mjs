// A fake `gh` for test/github-setup.test.ts and test/cleanup.test.ts: records each call as one JSON line
// ({args, stdin}) in the file named by FAKE_GH_LOG, with the stdin of `secret set`. The repository holds the
// secrets in FAKE_GH_EXISTING (space-separated), its environments' secrets in FAKE_GH_ENV_SECRETS and the
// environments in FAKE_GH_ENVIRONMENTS, changed by the calls logged so far:
// - `secret list` prints the names it holds (with --env, the environment's), one per line, as `--jq '.[].name'` would;
// - `api repos/<repo>/environments/<name>` (a GET) exits 1 with HTTP 404 unless the environment exists, and otherwise
//   prints it as GitHub does (unless --silent): FAKE_GH_ENVIRONMENT_SETTINGS (JSON, environment name -> its GET
//   answer, so it exists too) for one that existed, with the deployment branch policy of the last PUT's body
//   (--input -);
// - `api repos/<repo>/environments/<name>/deployment-branch-policies` (a GET) prints its policies as GitHub's pages
//   ({"total_count", "branch_policies": [{id, name, type}]}, two per page with --paginate, one JSON object after the
//   other as gh prints them): FAKE_GH_BRANCH_POLICIES (JSON, environment name -> [{name, type}]), plus each POST
//   (-f name=… -f type=…) logged so far;
// - `api repos/<repo>/actions/oidc/customization/sub` prints FAKE_GH_OIDC_SUB, the repository's OIDC subject
//   settings (GitHub's old default, `{"use_default":true}`, when unset);
// - `variable list` prints the environment variables it holds (FAKE_GH_ENV_VARIABLES, plus each `variable set`
//   logged so far), one per line;
// - `api --method PUT|POST|DELETE`, `secret set`, `secret delete` and `variable set` change what it holds; a PUT
//   with --input - is logged with its body as stdin.
// Unknown commands exit 99.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const log = process.env.FAKE_GH_LOG;
const args = process.argv.slice(2);
const cmd = args.slice(0, 2).join(" ");
const record = (stdin) => appendFileSync(log, `${JSON.stringify({ args, stdin })}\n`);
const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const split = (v) => (v ?? "").split(" ").filter(Boolean);

const json = (v, fallback) => (v ? JSON.parse(v) : fallback);
/** An environment path's name, and whether it is the environment's deployment branch policies. */
const target = (a) => {
  const m = /^repos\/[^/]+\/[^/]+\/environments\/([^/]+)(\/deployment-branch-policies)?$/.exec(a.find((x) => x.startsWith("repos/")) ?? "");
  return m ? { name: m[1], policies: m[2] !== undefined } : undefined;
};
const field = (a, key) => a.flatMap((x, i) => (a[i - 1] === "-f" && x.startsWith(`${key}=`) ? [x.slice(key.length + 1)] : []))[0];

/** The secret names, environments, each environment's last PUT body and its branch policies after the calls so far. */
function holdings() {
  const secrets = new Set(split(process.env.FAKE_GH_EXISTING));
  const environments = new Set([...split(process.env.FAKE_GH_ENVIRONMENTS), ...Object.keys(json(process.env.FAKE_GH_ENVIRONMENT_SETTINGS, {}))]);
  const bodies = {};
  const policies = json(process.env.FAKE_GH_BRANCH_POLICIES, {});
  for (const c of calls()) {
    if (c.args[0] === "secret" && c.args[1] === "set") secrets.add(c.args[2]);
    if (c.args[0] === "secret" && c.args[1] === "delete") secrets.delete(c.args[2]);
    const method = c.args[0] === "api" ? c.args[c.args.indexOf("--method") + 1] : undefined;
    const t = c.args[0] === "api" ? target(c.args) : undefined;
    if (!t) continue;
    if (method === "PUT" && !t.policies) {
      environments.add(t.name);
      if (c.stdin) bodies[t.name] = JSON.parse(c.stdin);
    }
    if (method === "DELETE" && !t.policies) environments.delete(t.name);
    if (method === "POST" && t.policies) (policies[t.name] ??= []).push({ name: field(c.args, "name"), type: field(c.args, "type") });
  }
  return { secrets, environments, bodies, policies };
}

if (args[0] === "api") {
  const putBody = args.includes("--input") ? readFileSync(0, "utf8") : null;
  record(putBody);
  const t = target(args);
  if (args.some((a) => a.endsWith("/actions/oidc/customization/sub"))) {
    process.stdout.write(process.env.FAKE_GH_OIDC_SUB || '{"use_default":true}');
  } else if (!args.includes("--method") && t) {
    const held = holdings();
    if (!held.environments.has(t.name)) {
      process.stderr.write("gh: Not Found (HTTP 404)\n");
      process.exit(1);
    }
    if (t.policies) {
      const all = (held.policies[t.name] ?? []).map((p, i) => ({ id: i + 1, name: p.name, type: p.type }));
      const size = args.includes("--paginate") ? 2 : 30;
      for (let i = 0; i === 0 || i < all.length; i += size) process.stdout.write(`${JSON.stringify({ total_count: all.length, branch_policies: all.slice(i, i + size) })}\n`);
    } else if (!args.includes("--silent")) {
      const known = json(process.env.FAKE_GH_ENVIRONMENT_SETTINGS, {})[t.name] ?? { name: t.name, protection_rules: [], deployment_branch_policy: null };
      const put = held.bodies[t.name];
      process.stdout.write(JSON.stringify(put ? { ...known, deployment_branch_policy: put.deployment_branch_policy } : known));
    }
  }
} else if (cmd === "secret set") record(readFileSync(0, "utf8"));
else if (cmd === "secret delete") {
  if (!holdings().secrets.has(args[2])) {
    process.stderr.write(`gh: no secret ${args[2]} (HTTP 404)\n`);
    process.exit(1);
  }
  record(null);
} else if (cmd === "variable set") record(null);
else if (cmd === "variable list") {
  record(null);
  const names = new Set(split(process.env.FAKE_GH_ENV_VARIABLES));
  for (const c of calls()) if (c.args[0] === "variable" && c.args[1] === "set") names.add(c.args[2]);
  for (const name of names) process.stdout.write(`${name}\n`);
} else if (cmd === "secret list") {
  record(null);
  const names = args.includes("--env") ? split(process.env.FAKE_GH_ENV_SECRETS) : [...holdings().secrets];
  for (const name of names) process.stdout.write(`${name}\n`);
} else {
  process.stderr.write(`fake gh: unknown command ${args.join(" ")}\n`);
  process.exit(99);
}
