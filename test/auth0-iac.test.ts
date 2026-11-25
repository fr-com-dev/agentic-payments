// 012 T-IAC-02: auth0/, the Auth0 tenant as Terraform (specs/012 research R17), checked offline. The checks read the
// .tf sources as text, like T-E2E-AZ reads the workflows, and cross-check what L2 depends on against the source
// (DETAILS_TYPE) and the Bicep parameter file (the ciba keys). Each check has a must-fail mutant. With Terraform on
// PATH, `terraform fmt -check` runs too; `terraform validate` runs once `terraform init` has been run by hand.
// SPEC 1.26: its operator command, scripts/auth0-tenant.sh, and its offline check, .github/workflows/validate-auth0.yml,
// are checked here too (scriptProblems, workflowProblems). The tenant is planned and applied only on the operator's
// host: the pinned Terraform (installed in ~/.local/bin without sudo, checked against its SHA-256) and the locked
// provider (its lock file holds the Linux checksum too), the state a local file outside every checkout, the files
// readable by the operator alone, the Management API credential in Terraform's environment only, credential = "key"
// only, and an apply of exactly the plan saved. The workflow only validates, and reads no secret and no variable.
// 013 (specs/013 contracts/config-and-secrets.md "auth0/", research R19): people's sign-in. The API with RBAC, the
// portal's public client with its own grant (using the portal needs no permission and no role, research R21), the
// portal client's URLs, and the post-login Action, whose code is also run here against a stand-in for Auth0's `api`.
// 016 (specs/016 contracts/tenant-and-config.md "The tenant", research R9 and R10): the hosted agent's callers. The
// applications are exactly L2's, the portal's, the agent's and the machine callers'; the agent's client is public,
// authorization code only, and returns to the docs page only; a machine caller's client has client credentials
// only, a key and no secret, and one grant, for people's API with agent:run alone; people's API has exactly two
// permissions, portal:admin and agent:run, each held by exactly one role, and nobody is assigned one here.
// Phase 3 (SPEC 1.19): no approver is configured (SPEC v1.16), so no user is read either; the localhost origins only
// where var.local_origins is on (dev); the second post-login Action, mfa-time.js, bound after sign-in-time.js, writes
// the second factor's time, and sign-in-time.js asks an administrator for a second factor on every interactive
// sign-in (push or a one-time code, both on in Guardian, with the tenant's setting that lets an Action choose). Each
// Action's code is run here.
// 018 (specs/018 contracts/tenant-connections.md, rules 1-8): people's connections. Email and password, imported and
// never destroyed, whose own Disable Sign Ups follows var.allow_sign_ups; Google, read only with its secret kept out
// of the state; each enabled for the portal's and the agent's clients alone; the operator command refuses a secret in
// the tfvars file. Step B (rule 6): Phase 3's pre-user-registration Action, which refused the operator's own
// creations too, is gone, and no Action may come back on that trigger: the connection's setting is the one switch.
// 019 (specs/019 contracts/tenant-and-config.md): the desktop client, a fifth kind of application. Public and native,
// authorization code and refresh token only, returning to the two loopback addresses in every environment, with
// rotating refresh tokens (30 days, 7 days unused, leeway 0) and the marker sign-in-time.js recognizes it by; on
// people's connections beside the agent's docs page client; on both services' lists in the outputs; no default
// audience. sign-in-time.js, run here, refuses a desktop sign-in or renewal without x402-agent and one without S256,
// before any challenge, and asks the desktop client's people for a second factor as it asks an administrator.
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { DETAILS_TYPE } from "../src/layer2-control/payment-details.js";
import { AGENT_RUN_PERMISSION, DEFAULT_AUTH_TIME_CLAIM, DEFAULT_MFA_TIME_CLAIM } from "../src/shared/identity-token.js";

const DIR = "auth0";
/** SPEC 1.26: the offline check, the only workflow about the tenant. It changes nothing. */
const WORKFLOW = ".github/workflows/validate-auth0.yml";
/** SPEC 1.26: the operator command, the only thing that plans and applies auth0/. */
const SCRIPT = "scripts/auth0-tenant.sh";
/** The variables the operator's tfvars file sets (auth0/README.md); none is a secret. environment and credential are the script's. */
const VARIABLES = ["tenant_domain", "api_identifier", "client_public_key_pem", "manage_guardian", "guardian_policy", "portal_origin", "agent_origin", "machine_caller_keys", "local_origins", "allow_sign_ups", "google_client_id", "google_sign_in"];
/** What each origin variable must accept: one https host (the VPS's portal and agent, SPEC 1.26, and an Azure app's). */
const GOOD_ORIGINS = ["https://dev.fabriciorojas.com", "https://agent.fabriciorojas.com", "https://ca-portal-eastus2-dev.example.azurecontainerapps.io"];
/** And what it must refuse: another scheme, a path or a trailing slash, a port, a wildcard, a user, upper case, a space. */
const BAD_ORIGINS = ["http://dev.fabriciorojas.com", "https://dev.fabriciorojas.com/", "https://agent.fabriciorojas.com/docs", "https://dev.fabriciorojas.com:8443", "https://dev.fabriciorojas.com:", "https://*.fabriciorojas.com", "https://user@dev.fabriciorojas.com", "https://Dev.fabriciorojas.com", "https://agent.fabriciorojas.com "];
/** 013 research R21: using the portal needs no permission. 014: its administration area needs this one. */
const ADMIN_PERMISSION = "portal:admin";
const ADMIN_ROLE = "x402-admin";
/** 016 research R10: starting a run at the hosted agent needs AGENT_RUN_PERMISSION, which this role holds. */
const AGENT_ROLE = "x402-agent";
/** Each role: its resource's name, its name at the tenant, and the local that names the one permission it holds. */
const ROLES: [resource: string, role: string, permission: string][] = [
  ["admin", ADMIN_ROLE, "admin_permission"],
  ["agent", AGENT_ROLE, "agent_permission"],
];
const TWO_ROLES = `people's API must define exactly two permissions, ${ADMIN_PERMISSION} and ${AGENT_RUN_PERMISSION}, and the tenant exactly two roles, ${ADMIN_ROLE} and ${AGENT_ROLE}, each holding exactly its own one: using the portal needs none (research R21), its administration area the first (014), a run at the hosted agent the second (016)`;
const AGENT_PERMISSION = `local.agent_permission must equal AGENT_RUN_PERMISSION (${AGENT_RUN_PERMISSION}), the permission the agent and L2 look for`;
const NOBODY_ASSIGNED = "no role or permission is assigned to a person here";
const LOCAL_PORTAL = "http://localhost:4025";
/** The local agent's docs origins (its default port, under both names a browser may use), and where its sign-in returns. */
const LOCAL_AGENT = ["http://localhost:4024", "http://127.0.0.1:4024"];
const DOCS_REDIRECT = "/docs/oauth2-redirect.html";
/** The machine caller the deployment pipeline's checks run as (016 research R9): the one bicepparam_agent names. */
const PIPELINE_CALLER = "checks";
/** The access-token claim the first Action sets: the services' default AUTH_TIME_CLAIM (contracts/config-and-secrets.md). */
const AUTH_TIME_CLAIM = "https://x402.dev/auth_time";
/** Phase 3: the claim the second Action sets, the time of the latest second factor: the services' DEFAULT_MFA_TIME_CLAIM. */
const MFA_TIME_CLAIM = "https://x402.dev/mfa_time";
/** The first Action's code, a file of its own so that this suite can run it. */
const ACTION_FILE = "sign-in-time.js";
/** Phase 3: the second post-login Action's code. */
const MFA_ACTION_FILE = "mfa-time.js";
/** 018 step B: the file of Phase 3's pre-user-registration Action, which must not come back. */
const SIGN_UP_ACTION_FILE = "deny-sign-up.js";
/** The tenant's Actions: each one's resource (and its binding's), file, trigger, trigger version and handler. */
const ACTIONS: [resource: string, file: string, trigger: string, version: string, handler: string][] = [
  ["mfa_time", MFA_ACTION_FILE, "post-login", "v3", "onExecutePostLogin"],
  ["sign_in_time", ACTION_FILE, "post-login", "v3", "onExecutePostLogin"],
];
/** The interactive sign-ins in a browser, where Auth0 can show a challenge (event.transaction.protocol). */
const BROWSER_PROTOCOLS = ["oidc-basic-profile", "oidc-hybrid-profile", "oidc-implicit-profile"];
/** The second factors sign-in-time.js asks an administrator for, each on in auth0_guardian. */
const SECOND_FACTORS = [{ type: "push-notification" }, { type: "otp" }];
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** 016 research R10 (FR-026): the tenant's applications. A machine caller's is one resource, by for_each. 019: the desktop client. */
const APPLICATIONS = ["agent", "desktop", "l2", "machine", "portal"];
const FIVE_KINDS = "the applications must be exactly L2's, the portal's, the agent's, the desktop client and the machine callers' (auth0_client.l2, portal, agent, desktop and machine, one per name in var.machine_caller_keys), each with its own auth0_client_credentials: the tenant has no other";
/** 019 (specs/019 contracts/tenant-and-config.md): the desktop client's loopback returns, on the person's own computer. */
const DESKTOP_CALLBACKS = ["http://127.0.0.1:53682/callback", "http://localhost:53682/callback"];
/** 019: the public marker in the desktop client's client_metadata, by which sign-in-time.js recognizes it. */
const DESKTOP_MARKER = "agent-desktop";
const DESKTOP_URLS = `the desktop client's callbacks must be exactly local.desktop_callbacks, ${DESKTOP_CALLBACKS.join(" and ")}, in every environment (never under var.local_origins): no origin, no logout URL, no login URI and no other address`;
const DESKTOP_METADATA = `the desktop client's client_metadata must be exactly x402_client = "${DESKTOP_MARKER}", the marker sign-in-time.js looks for, and its tokens RS256`;
const DESKTOP_REFRESH = "the desktop client's refresh tokens must rotate with no reuse interval (leeway 0) and expire: 30 days after the sign-in (token_lifetime 2592000) and 7 days unused (idle_token_lifetime 604800, no more than token_lifetime), never infinite";
const DESKTOP_IN_ACTION = `sign-in-time.js must refuse for the desktop client by its marker, "${DESKTOP_MARKER}" (auth0_client.desktop's client_metadata), and for the holders of ${AGENT_ROLE}, auth0_role.agent's name, only`;
const AGENT_URLS = `the agent client's callbacks must be exactly <origin>${DOCS_REDIRECT}, and its allowed origins and web origins <origin>, for ${LOCAL_AGENT.join(", ")} and var.agent_origin when set: no logout URL and no other address`;
const AGENT_NO_REFRESH = "the agent's client must have no refresh tokens (no refresh_token block): a person signs in again when the token expires";
const MACHINE = `every machine caller's client must be non_interactive with the client_credentials grant only, authenticate by private_key_jwt with its one public key (RS256), and have exactly one grant, for people's API with exactly ${AGENT_RUN_PERMISSION}: no callback, no secret, no ${ADMIN_PERMISSION}`;
const CALLER_KEYS = "var.machine_caller_keys must be a map of public keys, never a private one, and empty by default: no machine caller";
const IDENTITY_OUTPUT = "output bicepparam_identity must be the tenant's issuer and people's API only, and name no client";
const AGENT_OUTPUT = `output bicepparam_agent must be the agent's client, the desktop client, and the machine caller ${PIPELINE_CALLER}'s client and key ID, each empty when ${PIPELINE_CALLER} is not declared`;
const ENV_OUTPUTS = "outputs l1_env and l2_env must give the same AUTH_ISSUER, AUTH_AUDIENCE and AGENT_CLIENT_IDS (the agent's client and the desktop client: never the portal's, never a machine caller's), and l1_env the agent's client as API_DOCS_CLIENT_ID and the desktop client as AGENT_DESKTOP_CLIENT_ID";
/** How the lock file gets the checksum of each platform that runs Terraform: the operator's host and the check's runner (Linux), and a Mac. */
const LOCK_COMMAND = "terraform -chdir=auth0 providers lock -platform=linux_amd64 -platform=darwin_arm64";
/** Phase 3 (finding #11): no localhost address in a deployed environment's clients. */
const LOCAL_ORIGINS = "the localhost origins of the portal's and the agent's clients must come only with var.local_origins, a bool that is false by default";
/** Phase 3 (finding #6): the tenant's MFA settings the administrators' challenge needs. */
const MFA_SETTINGS = "every factor sign-in-time.js challenges with must be on in auth0_guardian (push through Guardian, and otp), and auth0_tenant.mfa_actions must turn on customize_mfa_in_postlogin_action and nothing else, with Guardian (count = var.manage_guardian)";
/** Phase 3 (finding #6): the Action asks for the role the tenant defines. */
const ADMIN_ROLE_IN_ACTION = `sign-in-time.js must challenge the holders of ${ADMIN_ROLE}, auth0_role.admin's name, and nobody else`;
/** Phase 3 (finding #12); since 018, the connection's own setting is what it decides (DISABLE_SIGNUP). */
const SIGN_UPS = "var.allow_sign_ups must be a bool, true by default";
/** 018 rule 6 (step B): the connection's Disable Sign Ups is the one switch, so no Action refuses sign-ups. */
const NO_SIGN_UP_ACTION = `no Action may run on pre-user-registration and ${SIGN_UP_ACTION_FILE} must be gone: such an Action refused the operator's own creations too, and the email-and-password connection's Disable Sign Ups is the one switch (specs/018 FR-002, FR-004, research R1)`;
const ONE_ACTION = `the Actions must be exactly ${ACTIONS.map(([resource, file, trigger]) => `${resource} (${file}, ${trigger})`).join(", ")}, with no secret and no package, each appended to its flow (auth0_trigger_action), never replacing it`;
const ONE_CLAIM = `the sign-in time Action must write one namespaced claim, ${AUTH_TIME_CLAIM}, on the access token, refuse for the desktop client only (not_authorized_for_agent without ${AGENT_ROLE}, pkce_required without S256), and challenge ${ADMIN_ROLE}'s holders and the desktop client's people with ${SECOND_FACTORS.map((f) => f.type).join(" or ")}, and do nothing else`;
const ONE_MFA_CLAIM = `the second-factor time Action must write one namespaced claim, ${MFA_TIME_CLAIM}, on the access token, and do nothing else`;
const NO_USER_READ = "no user is read here: there is no configured approver (SPEC v1.16), each request goes to the person the payment is for";
const NO_APPROVER_OUTPUT = "no output may give CIBA_APPROVER: L2 refuses to start with it (SPEC v1.16)";
const ONE_ACTION_ORDER = "the second-factor time Action's binding must come after the sign-in time Action's (depends_on): Auth0 asks for the second factor the first one requests before the next Action runs";
const LOCKED_FOR_RUNNER = `auth0/.terraform.lock.hcl must hold the provider's h1 checksum for Linux (the operator's host, the check's runner) as well as a Mac's (${LOCK_COMMAND})`;
/** SPEC 1.26: the state. */
const LOCAL_STATE = 'the state must be a local file (one backend, "local"), on the operator\'s host: no remote backend';
const NO_STATE_PATH = "the backend block must name no path: the operator command passes it (-backend-config), outside every checkout";
const ORIGIN = (name: string) => `var.${name} must be empty or one https origin: a host, with no path, port, wildcard or trailing slash`;
/** 018 (specs/018 contracts/tenant-connections.md): what var.google_client_id must accept, a Google OAuth client ID. */
const GOOD_GOOGLE_CLIENT_IDS = ["123456789012-abc123def456ghi789jkl012mno345pq.apps.googleusercontent.com", "1-a.apps.googleusercontent.com"];
/** A Google client secret's shape, built here so that no secret scanner meets one in the source. */
const GOOGLE_SECRET_SHAPE = "GOCSPX" + "-" + "x".repeat(28);
/** And what it must refuse: the secret, a URL, upper case, a trailing dot, a project that isn't a number, any character for a dot, a space. */
const BAD_GOOGLE_CLIENT_IDS = [
  GOOGLE_SECRET_SHAPE,
  "https://accounts.google.com",
  "123456789012-ABC123.apps.googleusercontent.com",
  "123456789012-abc123.apps.googleusercontent.com.",
  "abc-abc123.apps.googleusercontent.com",
  "123456789012-abc123.apps.googleusercontentxcom",
  " 123456789012-abc123.apps.googleusercontent.com",
];
const GOOGLE_CLIENT_ID = "var.google_client_id must be a string, empty by default, that is empty or one Google OAuth client ID (<digits>-<lowercase letters and digits>.apps.googleusercontent.com): never its secret";
const GOOGLE_SIGN_IN = "var.google_sign_in must be a bool, true by default: false is the emergency stop for Google sign-in, which also stops every existing Google person";
const GOOGLE_READ_ONLY = 'Google\'s connection must be read, never managed: exactly one data "auth0_connection", google, with name = "google-oauth2", hide_client_secret = true and skip_enabled_clients = true, so that its secret never reaches the state';
const NO_CONNECTION_SECRET = "no connection or connection data source may set a client ID or a secret (client_id, client_secret, options_client_secret_wo): the Google application's are entered in the tenant only";
const DATABASE = 'the email-and-password connection must be auth0_connection.database, the one connection managed here: name = "Username-Password-Authentication", strategy = "auth0", never destroyed (prevent_destroy), with no configuration, custom_scripts or enabled_clients';
const DISABLE_SIGNUP = 'the email-and-password connection\'s own "Disable Sign Ups" must follow the one switch, disable_signup = !var.allow_sign_ups: it refuses self-service sign-up and hides the page\'s "Sign up" link (specs/018 FR-001, FR-002)';
/** Rule 4: the tenant's password policy is Auth0's flexible one, which the provider refuses beside the legacy fields. */
const LEGACY_PASSWORD_FIELDS = ["password_policy", "password_complexity_options", "password_history", "password_dictionary", "password_no_personal_info"];
const PASSWORD_OPTIONS = `the email-and-password connection must write out its password policy as password_options, with complexity, dictionary, history and profile_data, and none of the legacy fields (${LEGACY_PASSWORD_FIELDS.join(", ")}): the tenant uses the flexible policy, Auth0 replaces the whole options object on an update, and the provider refuses both kinds together (specs/018 research R2)`;
/** Rule 1: every connection object of the tenant's declaration, as `[data.]<type>.<name>`, sorted. */
const CONNECTION_OBJECTS = ["auth0_connection.database", "auth0_connection_clients.database", "auth0_connection_clients.google", "data.auth0_connection.google"];
const CONNECTIONS = `the people's connections must be exactly ${CONNECTION_OBJECTS.join(", ")}: no third connection, no auth0_connection_client, and no managed Google connection (it would put the secret in the state)`;
const CONNECTION_CLIENTS = "each people's connection must be enabled for exactly the portal's client, the agent's and the desktop client (auth0_connection_clients, authoritative): the database one always, Google's only while var.google_sign_in; never L2's approval client or a machine caller";
/** Rule 2: the clients that may sign a person in. 019: the desktop client beside the agent's docs page client. */
const PEOPLE_CLIENTS = "[auth0_client.portal.client_id, auth0_client.agent.client_id, auth0_client.desktop.client_id]";
/**
 * Rule 5: the plan stops unless the tenant's Google connection runs on the project's own application. The non-empty
 * test matters: on Auth0's developer keys the connection has no client ID, and "" == "" would let it through.
 */
const GOOGLE_PRECONDITION = '!var.google_sign_in || (var.google_client_id != "" && try(data.auth0_connection.google.options[0].client_id, "") == var.google_client_id)';
const GOOGLE_APP = `while var.google_sign_in, the plan must stop unless the tenant's Google connection uses the project's own application: one precondition on auth0_connection_clients.google, ${GOOGLE_PRECONDITION}, whose message names google_client_id`;

interface Sources {
  /** auth0/*.tf by file name. */
  tf: Record<string, string>;
  /** Every file under auth0/ except .terraform/, by name. */
  all: Record<string, string>;
  /** auth0/.terraform.lock.hcl: the provider's version and checksums, which the pipeline's init never changes. */
  lock: string;
  gitignore: string;
  dockerignore: string;
  bicepparam: string;
  /** .github/workflows/validate-auth0.yml. */
  workflow: string;
  /** scripts/auth0-tenant.sh, the operator command. */
  script: string;
  /** package.json: npm run auth0:tenant. */
  packageJson: string;
}

function load(): Sources {
  const names = readdirSync(DIR).filter((f) => !f.startsWith(".terraform"));
  const all = Object.fromEntries(names.map((f) => [f, readFileSync(join(DIR, f), "utf8")]));
  return {
    tf: Object.fromEntries(Object.entries(all).filter(([f]) => f.endsWith(".tf"))),
    all,
    lock: readFileSync(join(DIR, ".terraform.lock.hcl"), "utf8"),
    gitignore: readFileSync(".gitignore", "utf8"),
    dockerignore: readFileSync(".dockerignore", "utf8"),
    bicepparam: readFileSync("infra/main.dev.bicepparam", "utf8"),
    workflow: readFileSync(WORKFLOW, "utf8"),
    script: readFileSync(SCRIPT, "utf8"),
    packageJson: readFileSync("package.json", "utf8"),
  };
}

/** The body of the first block whose header matches, by brace counting (the sources' strings have balanced braces). */
function block(text: string, header: RegExp): string | undefined {
  const m = header.exec(text);
  if (!m) return undefined;
  let depth = 0;
  const start = text.indexOf("{", m.index);
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start + 1, i);
  }
  return undefined;
}

/** The body of every block whose header matches (a global pattern), in order. */
function blocks(text: string | undefined, header: RegExp): string[] {
  const out: string[] = [];
  for (const m of (text ?? "").matchAll(header)) {
    const body = block(text!.slice(m.index), new RegExp(header.source));
    if (body !== undefined) out.push(body);
  }
  return out;
}

/** HCL without comments, so a comment never satisfies or trips a check. A URL's `://` starts no comment. */
const code = (text: string) => text.replace(/#.*$/gm, "").replace(/(?<!:)\/\/.*$/gm, "");
const has = (body: string | undefined, re: RegExp) => body !== undefined && re.test(body);
/** Every argument of a client that holds an address, as `name = value`, sorted. */
const urlArguments = (client: string) =>
  [...client.matchAll(/^\s*(callbacks|web_origins|allowed_logout_urls|allowed_origins|initiate_login_uri|cross_origin_loc|oidc_backchannel_logout_urls)\s*=\s*(.+)$/gm)].map((m) => `${m[1]} = ${m[2]!.trim()}`).sort();
/** A client's grant types, in order. */
const grantTypes = (client: string | undefined) => (/grant_types\s*=\s*\[([^\]]*)\]/.exec(client ?? "")?.[1] ?? "").split(",").map((g) => g.trim().replace(/^"|"$/g, "")).filter(Boolean);
/** The quoted strings of one line of HCL. */
const quoted = (line: string) => [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
/** An HCL string holding a whole-value pattern (^…$), as a RegExp: undefined when it isn't one. */
const anchored = (pattern: string | undefined): RegExp | undefined => {
  if (pattern === undefined || !pattern.startsWith("^") || !pattern.endsWith("$")) return undefined;
  try {
    return new RegExp(pattern.replace(/\\\\/g, "\\"));
  } catch {
    return undefined;
  }
};

/** One message per problem. Empty for the real sources. */
export function auth0Problems(s: Sources): string[] {
  const p: string[] = [];
  const tf = code(Object.values(s.tf).join("\n"));

  // Provider: the official one, pinned within 1.x, credentials from the environment only.
  const req = block(tf, /required_providers\s*\{/) ?? "";
  if (!/source\s*=\s*"auth0\/auth0"/.test(req) || !/version\s*=\s*">= 1\.60\.0, < 2\.0\.0"/.test(req)) p.push("the provider must be auth0/auth0 pinned to >= 1.60.0, < 2.0.0");
  if (!/required_version\s*=\s*">= 1\.11\.0"/.test(tf)) p.push("Terraform must be >= 1.11.0 (write-only arguments keep the client secret out of state)");
  // The lock file: one h1 checksum per platform that runs Terraform. `init -lockfile=readonly` adds none, and
  // `validate` refuses a provider whose unpacked package matches no h1 here (a lock written on a Mac has only its own).
  const locked = block(s.lock, /provider\s+"registry\.terraform\.io\/auth0\/auth0"\s*\{/) ?? "";
  if ((locked.match(/"h1:[A-Za-z0-9+/]+=*"/g) ?? []).length < 2) p.push(LOCKED_FOR_RUNNER);
  const provider = block(tf, /provider\s+"auth0"\s*\{/) ?? "";
  if (/client_id|client_secret|api_token|client_assertion/.test(provider)) p.push("the provider block must take credentials from the environment only, never from a file");

  // The payment-details type: the one L2 sends.
  const type = /details_type\s*=\s*"([^"]+)"/.exec(tf)?.[1];
  if (type !== DETAILS_TYPE) p.push(`local.details_type must equal DETAILS_TYPE (${DETAILS_TYPE}), the type L2 sends`);

  // The API.
  const api = block(tf, /resource\s+"auth0_resource_server"\s+"payments"\s*\{/);
  if (!api) p.push("the approval API (auth0_resource_server.payments) is missing");
  else {
    if (!has(api, /signing_alg\s*=\s*"RS256"/)) p.push("the API must sign with RS256 (L2 accepts RS256 only)");
    if (!has(api, /token_dialect\s*=\s*"rfc9068_profile(_authz)?"/)) p.push("the API must use the RFC 9068 token profile (tokens carry jti)");
    if (!has(api, /allow_offline_access\s*=\s*false/)) p.push("the API must not allow offline access (no refresh tokens)");
    if (!has(api, /consent_policy\s*=\s*"null"/)) p.push('the API must use standard consent (consent_policy = "null"); CIBA is not supported with transactional-authorization-with-mfa');
    if (!has(block(api, /authorization_details\s*\{/), /type\s*=\s*local\.details_type/)) p.push("the API must register local.details_type as an authorization_details type");
    const sta = block(api, /subject_type_authorization\s*\{/);
    if (!has(block(sta ?? "", /user\s*\{/), /policy\s*=\s*"require_client_grant"/)) p.push("users may request the type only through a client grant (user policy require_client_grant)");
    if (!has(block(sta ?? "", /client\s*\{/), /policy\s*=\s*"deny_all"/)) p.push("no machine-to-machine token for the API (client policy deny_all)");
  }

  // L2's client.
  const client = block(tf, /resource\s+"auth0_client"\s+"l2"\s*\{/);
  if (!client) p.push("L2's client (auth0_client.l2) is missing");
  else {
    if (!has(client, /grant_types\s*=\s*\["urn:openid:params:grant-type:ciba"\]/)) p.push("L2's client must have the CIBA grant and no other");
    if (!has(client, /async_approval_notification_channels\s*=\s*\["guardian-push"\]/)) p.push("L2's client must notify through guardian-push only");
    if (!has(client, /is_first_party\s*=\s*true/) || !has(client, /oidc_conformant\s*=\s*true/) || !has(client, /app_type\s*=\s*"regular_web"/)) {
      p.push("L2's client must be a first-party, OIDC-conformant regular_web (confidential) client");
    }
  }

  // The grant.
  const grant = block(tf, /resource\s+"auth0_client_grant"\s+"l2_ciba"\s*\{/);
  if (!has(grant, /client_id\s*=\s*auth0_client\.l2\.client_id/) || !has(grant, /subject_type\s*=\s*"user"/) || !has(grant, /authorization_details_types\s*=\s*\[local\.details_type\]/)) {
    p.push("a user-delegated client grant must let L2's client, and only it, request local.details_type");
  }

  // The credential: the public key, RS256, or a write-only secret.
  const cred = block(tf, /resource\s+"auth0_client_credentials"\s+"l2"\s*\{/) ?? "";
  if (!/credential_type\s*=\s*"public_key"/.test(cred) || !/pem\s*=\s*var\.client_public_key_pem\b/.test(cred)) p.push("the private_key_jwt credential must be the public key read from client_public_key_file");
  const algs = [...cred.matchAll(/algorithm\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  if (algs.length === 0 || algs.some((a) => a !== "RS256")) p.push("the credential's algorithm must be RS256 (what L2 signs; Auth0 never takes ES256)");
  if (/\bclient_secret\s*=/.test(cred)) p.push("the client secret must be write-only (client_secret_wo), never stored in state");
  const secretVar = block(tf, /variable\s+"client_secret"\s*\{/) ?? "";
  if (!/sensitive\s*=\s*true/.test(secretVar) || !/ephemeral\s*=\s*true/.test(secretVar)) p.push("var.client_secret must be sensitive and ephemeral");

  // Guardian push, never destroyed.
  const guardian = block(tf, /resource\s+"auth0_guardian"\s+"this"\s*\{/) ?? "";
  if (!/enabled\s*=\s*true/.test(block(guardian, /push\s*\{/) ?? "") || !/provider\s*=\s*"guardian"/.test(guardian)) p.push("Guardian push through the Guardian app must be on");
  if (!/prevent_destroy\s*=\s*true/.test(guardian)) p.push("auth0_guardian must never be destroyed (it would turn off every MFA factor of the tenant)");

  // ---- 013: people's sign-in (specs/013 research R19) ----------------------------------------------------------
  const count = (type: string) => [...tf.matchAll(new RegExp(`resource\\s+"${type}"\\s`, "g"))].length;
  // People's API: RS256, RBAC enforced with the permissions in the access token, refresh tokens allowed, and an
  // identifier of its own, never the approval API's.
  const people = block(tf, /resource\s+"auth0_resource_server"\s+"identity"\s*\{/);
  if (!people) p.push("people's API (auth0_resource_server.identity) is missing");
  else {
    if (!has(people, /signing_alg\s*=\s*"RS256"/)) p.push("people's API must sign with RS256 (the services accept RS256 only)");
    if (!has(people, /enforce_policies\s*=\s*true/)) p.push("people's API must enforce RBAC (enforce_policies = true)");
    if (!has(people, /token_dialect\s*=\s*"access_token_authz"/)) p.push('people\'s API must put the permissions in the access token (token_dialect = "access_token_authz")');
    if (!has(people, /allow_offline_access\s*=\s*true/)) p.push("people's API must allow offline access (the web app's refresh-token rotation)");
    if (!has(people, /identifier\s*=\s*local\.identity_audience/) || !has(people, /condition\s*=\s*var\.api_identifier != local\.identity_audience/)) {
      p.push("people's API must have an identifier of its own (local.identity_audience), never the approval API's");
    }
  }
  if (count("auth0_resource_server") !== 2) p.push("the APIs must be exactly the approval API and people's API");

  // Using the portal needs no permission and no role (research R21). 014 adds the administrator's permission and
  // 016 the one that starts a run at the hosted agent (research R10): exactly those two, each held by exactly one
  // role, and no role holds two.
  const names = (type: string) => [...tf.matchAll(new RegExp(`resource\\s+"${type}"\\s+"(\\w+)"`, "g"))].map((m) => m[1]!).sort();
  const adminPermission = /^\s*admin_permission\s*=\s*"([^"]+)"/m.exec(tf)?.[1];
  const agentPermission = /^\s*agent_permission\s*=\s*"([^"]+)"/m.exec(tf)?.[1];
  if (agentPermission !== AGENT_RUN_PERMISSION) p.push(AGENT_PERMISSION);
  const scopes = block(tf, /resource\s+"auth0_resource_server_scopes"\s+"identity"\s*\{/);
  const defined = blocks(scopes, /\bscopes\s*\{/g).map((b) => /name\s*=\s*(\S+)/.exec(b)?.[1]);
  const holdsItsOwn = ([resource, role, permission]: (typeof ROLES)[number]) => {
    const rolePermissions = block(tf, new RegExp(`resource\\s+"auth0_role_permissions"\\s+"${resource}"\\s*\\{`));
    const held = blocks(rolePermissions, /\bpermissions\s*\{/g);
    return (
      has(block(tf, new RegExp(`resource\\s+"auth0_role"\\s+"${resource}"\\s*\\{`)), new RegExp(`name\\s*=\\s*"${role}"`)) &&
      has(rolePermissions, new RegExp(`role_id\\s*=\\s*auth0_role\\.${resource}\\.id\\b`)) &&
      held.length === 1 &&
      new RegExp(`name\\s*=\\s*local\\.${permission}\\b`).test(held[0]!) &&
      /resource_server_identifier\s*=\s*auth0_resource_server\.identity\.identifier/.test(held[0]!)
    );
  };
  if (
    /^\s*permission\s*=/m.test(tf) ||
    adminPermission !== ADMIN_PERMISSION ||
    !has(scopes, /resource_server_identifier\s*=\s*auth0_resource_server\.identity\.identifier/) ||
    JSON.stringify(defined) !== JSON.stringify(ROLES.map(([, , permission]) => `local.${permission}`)) ||
    !ROLES.every(holdsItsOwn) ||
    count("auth0_resource_server_scopes") !== 1 ||
    JSON.stringify(names("auth0_role")) !== JSON.stringify(ROLES.map(([resource]) => resource)) ||
    JSON.stringify(names("auth0_role_permissions")) !== JSON.stringify(ROLES.map(([resource]) => resource)) ||
    ["auth0_resource_server_scope", "auth0_role_permission"].some((type) => count(type) !== 0)
  ) {
    p.push(TWO_ROLES);
  }

  // A public client (the portal's, the agent's): no secret, no key, and only its own grant.
  const publicClient = (name: string, label: string, appType: string, grants: string[]): string | undefined => {
    const c = block(tf, new RegExp(`resource\\s+"auth0_client"\\s+"${name}"\\s*\\{`));
    const cred = block(tf, new RegExp(`resource\\s+"auth0_client_credentials"\\s+"${name}"\\s*\\{`));
    if (!c) {
      p.push(`${label} (auth0_client.${name}) is missing`);
      return undefined;
    }
    if (
      !has(c, new RegExp(`app_type\\s*=\\s*"${appType}"`)) ||
      !has(cred, new RegExp(`client_id\\s*=\\s*auth0_client\\.${name}\\.client_id`)) ||
      !has(cred, /authentication_method\s*=\s*"none"/) ||
      has(cred, /client_secret|private_key_jwt|tls_client_auth/)
    ) {
      p.push(`${label} must be a public ${appType} client: authentication_method none, no secret and no key`);
    }
    if (JSON.stringify(grantTypes(c)) !== JSON.stringify(grants)) p.push(`${label} must have only its own grant (${grants.join(", ")})`);
    if (!has(c, /is_first_party\s*=\s*true/) || !has(c, /oidc_conformant\s*=\s*true/)) p.push(`${label} must be first-party and OIDC-conformant`);
    return c;
  };
  // Refresh-token rotation needs the refresh_token grant beside the authorization code (with PKCE: a public client).
  const portalClient = publicClient("portal", "the portal's client", "spa", ["authorization_code", "refresh_token"]);
  const origins = /^\s*portal_origins\s*=\s*(.+)$/m.exec(tf)?.[1] ?? "";
  if (portalClient) {
    if (
      JSON.stringify(urlArguments(portalClient)) !== JSON.stringify(["allowed_logout_urls = local.portal_origins", "callbacks = local.portal_origins", "web_origins = local.portal_origins"]) ||
      JSON.stringify(quoted(origins)) !== JSON.stringify([LOCAL_PORTAL, ""]) ||
      !origins.includes('var.portal_origin == "" ? [] : [var.portal_origin]') ||
      portalClient.includes("://")
    ) {
      p.push(`the portal client's callbacks, web origins and logout URLs must be exactly ${LOCAL_PORTAL} and var.portal_origin when set`);
    }
    const refresh = block(portalClient, /refresh_token\s*\{/);
    if (!has(refresh, /rotation_type\s*=\s*"rotating"/) || !has(refresh, /expiration_type\s*=\s*"expiring"/) || has(refresh, /infinite_(idle_)?token_lifetime\s*=\s*true/)) {
      p.push("the portal client's refresh tokens must rotate and expire");
    }
  }

  // 016: the agent's public client, for its docs page. Authorization code (with PKCE: a public client) and nothing
  // else, so no refresh token exists. The sign-in returns to the docs page's redirect address under each docs
  // origin, and only those origins may call the tenant from a browser. It has no logout URL.
  const agentClient = publicClient("agent", "the agent's client", "spa", ["authorization_code"]);
  const agentOrigins = /^\s*agent_origins\s*=\s*(.+)$/m.exec(tf)?.[1] ?? "";
  const agentCallbacks = /^\s*agent_callbacks\s*=\s*(.+)$/m.exec(tf)?.[1]?.trim();
  if (agentClient) {
    if (
      JSON.stringify(urlArguments(agentClient)) !== JSON.stringify(["allowed_origins = local.agent_origins", "callbacks = local.agent_callbacks", "web_origins = local.agent_origins"]) ||
      JSON.stringify(quoted(agentOrigins)) !== JSON.stringify([...LOCAL_AGENT, ""]) ||
      !agentOrigins.includes('var.agent_origin == "" ? [] : [var.agent_origin]') ||
      agentCallbacks !== `[for origin in local.agent_origins : "\${origin}${DOCS_REDIRECT}"]` ||
      agentClient.includes("://")
    ) {
      p.push(AGENT_URLS);
    }
    if (has(agentClient, /\brefresh_token\s*\{/)) p.push(AGENT_NO_REFRESH);
  }

  // 019: the desktop client, a public native client: authorization code (with PKCE) and rotating refresh tokens. It
  // returns to the person's own computer only, at the same two loopback addresses in every environment, and carries
  // the marker the post-login rule recognizes it by.
  const desktopClient = publicClient("desktop", "the desktop client", "native", ["authorization_code", "refresh_token"]);
  const desktopCallbacks = /^\s*desktop_callbacks\s*=\s*(.+)$/m.exec(tf)?.[1] ?? "";
  if (desktopClient) {
    if (
      JSON.stringify(urlArguments(desktopClient)) !== JSON.stringify(["callbacks = local.desktop_callbacks"]) ||
      JSON.stringify(quoted(desktopCallbacks)) !== JSON.stringify(DESKTOP_CALLBACKS) ||
      /var\.|\*/.test(desktopCallbacks) ||
      desktopClient.includes("://")
    ) {
      p.push(DESKTOP_URLS);
    }
    const metadata = block(desktopClient, /client_metadata\s*=\s*\{/) ?? "";
    if (
      JSON.stringify([...metadata.matchAll(/^\s*(\w+)\s*=\s*(.+)$/gm)].map((m) => `${m[1]} = ${m[2]!.trim()}`)) !== JSON.stringify([`x402_client = "${DESKTOP_MARKER}"`]) ||
      !has(block(desktopClient, /jwt_configuration\s*\{/), /alg\s*=\s*"RS256"/)
    ) {
      p.push(DESKTOP_METADATA);
    }
    const refresh = block(desktopClient, /refresh_token\s*\{/) ?? "";
    const refreshArgs = Object.fromEntries([...refresh.matchAll(/^\s*(\w+)\s*=\s*(.+)$/gm)].map((m) => [m[1]!, m[2]!.trim()]));
    const want = { rotation_type: '"rotating"', expiration_type: '"expiring"', token_lifetime: "2592000", idle_token_lifetime: "604800", infinite_token_lifetime: "false", infinite_idle_token_lifetime: "false", leeway: "0" };
    if (JSON.stringify(Object.entries(refreshArgs).sort()) !== JSON.stringify(Object.entries(want).sort()) || !(Number(refreshArgs.idle_token_lifetime) <= Number(refreshArgs.token_lifetime))) {
      p.push(DESKTOP_REFRESH);
    }
  }
  // Phase 3 (finding #11): the localhost origins only where var.local_origins is on, and it is off by default.
  const localOrigins = block(tf, /variable\s+"local_origins"\s*\{/) ?? "";
  if (
    !origins.includes(`concat(var.local_origins ? ["${LOCAL_PORTAL}"] : [], `) ||
    !agentOrigins.includes(`concat(var.local_origins ? [${LOCAL_AGENT.map((o) => `"${o}"`).join(", ")}] : [], `) ||
    !/type\s*=\s*bool\b/.test(localOrigins) ||
    !/default\s*=\s*false\b/.test(localOrigins)
  ) {
    p.push(LOCAL_ORIGINS);
  }
  // The validation's pattern, run here (SPEC 1.26): it takes one https host and refuses everything else an origin
  // could carry. Auth0 compares a callback or an origin literally.
  for (const name of ["portal_origin", "agent_origin"]) {
    const condition = /^\s*condition\s*=\s*(.+)$/m.exec(block(tf, new RegExp(`variable\\s+"${name}"\\s*\\{`)) ?? "")?.[1]?.trim() ?? "";
    const accepts = anchored(new RegExp(`^var\\.${name} == "" \\|\\| can\\(regex\\("(.+)", var\\.${name}\\)\\)$`).exec(condition)?.[1]);
    if (!accepts || !GOOD_ORIGINS.every((o) => accepts.test(o)) || BAD_ORIGINS.some((o) => accepts.test(o))) p.push(ORIGIN(name));
  }

  // 016: a machine caller's client (research R9, FR-021), one per name in var.machine_caller_keys. It can't sign a
  // person in (client credentials only, no address), it holds a public key and no secret, and its one grant is for
  // people's API with agent:run alone: never the administrator's permission, never the approval API.
  const forEach = /for_each\s*=\s*var\.machine_caller_keys\b/;
  const ofEach = /client_id\s*=\s*auth0_client\.machine\[each\.key\]\.client_id\b/;
  const machine = block(tf, /resource\s+"auth0_client"\s+"machine"\s*\{/);
  const machineCredentials = block(tf, /resource\s+"auth0_client_credentials"\s+"machine"\s*\{/);
  const machineGrant = block(tf, /resource\s+"auth0_client_grant"\s+"machine"\s*\{/);
  const machineKeys = blocks(block(machineCredentials ?? "", /private_key_jwt\s*\{/), /\bcredentials\s*\{/g);
  if (
    !has(machine, forEach) ||
    !has(machine, /app_type\s*=\s*"non_interactive"/) ||
    JSON.stringify(grantTypes(machine)) !== '["client_credentials"]' ||
    !has(machine, /is_first_party\s*=\s*true/) ||
    !has(machine, /oidc_conformant\s*=\s*true/) ||
    urlArguments(machine ?? "").length !== 0 ||
    has(machine, /:\/\/|\brefresh_token\s*\{/) ||
    !has(machineCredentials, forEach) ||
    !has(machineCredentials, ofEach) ||
    !has(machineCredentials, /authentication_method\s*=\s*"private_key_jwt"/) ||
    has(machineCredentials, /client_secret|tls_client_auth/) ||
    machineKeys.length !== 1 ||
    !/credential_type\s*=\s*"public_key"/.test(machineKeys[0]!) ||
    !/pem\s*=\s*each\.value\b/.test(machineKeys[0]!) ||
    !/algorithm\s*=\s*"RS256"/.test(machineKeys[0]!) ||
    !has(machineGrant, forEach) ||
    !has(machineGrant, ofEach) ||
    !has(machineGrant, /audience\s*=\s*auth0_resource_server\.identity\.identifier\b/) ||
    !has(machineGrant, /scopes\s*=\s*\[local\.agent_permission\]/) ||
    has(machineGrant, /authorization_details_types|subject_type\s*=\s*"user"/) ||
    JSON.stringify(names("auth0_client_grant")) !== '["l2_ciba","machine"]'
  ) {
    p.push(MACHINE);
  }
  const callerKeys = block(tf, /variable\s+"machine_caller_keys"\s*\{/) ?? "";
  if (!/type\s*=\s*map\(string\)/.test(callerKeys) || !/default\s*=\s*\{\}/.test(callerKeys) || !callerKeys.includes('!strcontains(pem, "PRIVATE KEY")')) p.push(CALLER_KEYS);

  // The applications: exactly these four kinds, each with its own credentials resource (FR-026).
  if (JSON.stringify(names("auth0_client")) !== JSON.stringify(APPLICATIONS) || JSON.stringify(names("auth0_client_credentials")) !== JSON.stringify(APPLICATIONS)) p.push(FIVE_KINDS);

  // The Actions: each one's code is the file this suite runs (actionProblems and the like), it holds no secret and no
  // package, and it is appended to its flow, never replacing it. Phase 3: two post-login Actions, the second-factor
  // time one bound after the sign-in time one.
  const actionOk = ([resource, file, trigger, version]: (typeof ACTIONS)[number]) => {
    const action = block(tf, new RegExp(`resource\\s+"auth0_action"\\s+"${resource}"\\s*\\{`));
    const binding = block(tf, new RegExp(`resource\\s+"auth0_trigger_action"\\s+"${resource}"\\s*\\{`));
    const triggers = blocks(action, /\bsupported_triggers\s*\{/g);
    return (
      has(action, new RegExp(`code\\s*=\\s*file\\("\\$\\{path\\.module\\}/${file.replace(".", "\\.")}"\\)`)) &&
      triggers.length === 1 &&
      new RegExp(`id\\s*=\\s*"${trigger}"`).test(triggers[0]!) &&
      new RegExp(`version\\s*=\\s*"${version}"`).test(triggers[0]!) &&
      !has(action, /\b(secrets|secrets_wo|dependencies|modules)\s*\{/) &&
      has(binding, new RegExp(`trigger\\s*=\\s*"${trigger}"`)) &&
      has(binding, new RegExp(`action_id\\s*=\\s*auth0_action\\.${resource}\\.id\\b`))
    );
  };
  const resources = JSON.stringify(ACTIONS.map(([resource]) => resource));
  if (!ACTIONS.every(actionOk) || JSON.stringify(names("auth0_action")) !== resources || JSON.stringify(names("auth0_trigger_action")) !== resources || count("auth0_trigger_actions") !== 0) {
    p.push(ONE_ACTION);
  }
  if (!has(block(tf, /resource\s+"auth0_trigger_action"\s+"mfa_time"\s*\{/), /depends_on\s*=\s*\[auth0_trigger_action\.sign_in_time\]/)) p.push(ONE_ACTION_ORDER);
  const signUps = block(tf, /variable\s+"allow_sign_ups"\s*\{/) ?? "";
  if (!/type\s*=\s*bool\b/.test(signUps) || !/default\s*=\s*true\b/.test(signUps)) p.push(SIGN_UPS);
  // 018 rule 6 (step B): no Action on pre-user-registration in the code (comments aside) of any .tf or .js file of the
  // folder, and no deny file.
  const sources = Object.entries(s.all).filter(([f]) => /\.(tf|js)$/.test(f));
  if (SIGN_UP_ACTION_FILE in s.all || sources.some(([, text]) => /pre-user-registration/.test(code(text)))) p.push(NO_SIGN_UP_ACTION);
  const claim = /^\s*auth_time_claim\s*=\s*"([^"]+)"/m.exec(tf)?.[1];
  if (claim !== AUTH_TIME_CLAIM || claim !== DEFAULT_AUTH_TIME_CLAIM) p.push(`local.auth_time_claim must be ${AUTH_TIME_CLAIM}, the services' default AUTH_TIME_CLAIM`);
  const mfaClaim = /^\s*mfa_time_claim\s*=\s*"([^"]+)"/m.exec(tf)?.[1];
  if (mfaClaim !== MFA_TIME_CLAIM || mfaClaim !== DEFAULT_MFA_TIME_CLAIM || !has(block(tf, /resource\s+"auth0_action"\s+"mfa_time"\s*\{/), /local\.mfa_time_claim/)) {
    p.push(`local.mfa_time_claim must be ${MFA_TIME_CLAIM}, the services' DEFAULT_MFA_TIME_CLAIM, and mfa-time.js must write it`);
  }
  // Each Action's code calls exactly these methods of Auth0's api and holds exactly these strings, and loads nothing.
  const jsOf = (file: string) => (s.all[file] ?? "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
  const apiUses = (js: string) => JSON.stringify([...js.matchAll(/\bapi\s*\.\s*([\w.]+)/g)].map((m) => m[1]));
  const strings = (js: string) => JSON.stringify([...js.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3]));
  const loads = (js: string) => /\bapi\s*\[|\brequire\s*\(|\bimport\b|\bfetch\s*\(|\bevent\.secrets\b/.test(js);
  const signInJs = jsOf(ACTION_FILE);
  // 019: the desktop client's two refusals (in source order), then the challenge.
  const signInStrings = [AUTH_TIME_CLAIM, ADMIN_ROLE, AGENT_ROLE, DESKTOP_MARKER, "oauth2-refresh-token", ...BROWSER_PROTOCOLS, ...SECOND_FACTORS.map((f) => f.type), "mfa", "not_authorized_for_agent", "S256", "pkce_required"];
  if (apiUses(signInJs) !== '["accessToken.setCustomClaim","access.deny","access.deny","authentication.challengeWithAny"]' || strings(signInJs) !== JSON.stringify(signInStrings) || loads(signInJs)) p.push(ONE_CLAIM);
  if (/^const ADMIN_ROLE = "([^"]+)";$/m.exec(signInJs)?.[1] !== ADMIN_ROLE || !has(block(tf, /resource\s+"auth0_role"\s+"admin"\s*\{/), new RegExp(`name\\s*=\\s*"${ADMIN_ROLE}"`))) p.push(ADMIN_ROLE_IN_ACTION);
  if (
    /^const AGENT_ROLE = "([^"]+)";$/m.exec(signInJs)?.[1] !== AGENT_ROLE ||
    !has(block(tf, /resource\s+"auth0_role"\s+"agent"\s*\{/), new RegExp(`name\\s*=\\s*"${AGENT_ROLE}"`)) ||
    /^const DESKTOP_CLIENT = "([^"]+)";$/m.exec(signInJs)?.[1] !== DESKTOP_MARKER ||
    !has(block(block(tf, /resource\s+"auth0_client"\s+"desktop"\s*\{/) ?? "", /client_metadata\s*=\s*\{/), new RegExp(`x402_client\\s*=\\s*"${DESKTOP_MARKER}"`))
  ) {
    p.push(DESKTOP_IN_ACTION);
  }
  const mfaJs = jsOf(MFA_ACTION_FILE);
  if (apiUses(mfaJs) !== '["accessToken.setCustomClaim"]' || strings(mfaJs) !== JSON.stringify([MFA_TIME_CLAIM, "mfa"]) || loads(mfaJs)) p.push(ONE_MFA_CLAIM);
  // Phase 3 (finding #6): the second factors the first Action asks for are on, and so is the tenant's setting that
  // lets an Action choose them, with Guardian; the tenant resource sets nothing else.
  const tenant = block(tf, /resource\s+"auth0_tenant"\s+"mfa_actions"\s*\{/) ?? "";
  if (
    !/^\s*otp\s*=\s*true$/m.test(guardian) ||
    !/enabled\s*=\s*true/.test(block(guardian, /push\s*\{/) ?? "") ||
    JSON.stringify([...tenant.matchAll(/^\s*(\w+)\s*=\s*(.+)$/gm)].map((m) => `${m[1]} = ${m[2]!.trim()}`)) !== JSON.stringify(["count = var.manage_guardian ? 1 : 0", "customize_mfa_in_postlogin_action = true"]) ||
    count("auth0_tenant") !== 1
  ) {
    p.push(MFA_SETTINGS);
  }

  // ---- 018: people's connections (specs/018 contracts/tenant-connections.md) --------------------------------------
  // Rule 8 and rule 5's variables: the project's own Google application, by its client ID (never its secret), and
  // the emergency stop. The validation's pattern is run against good and bad client IDs.
  const googleClientId = block(tf, /variable\s+"google_client_id"\s*\{/) ?? "";
  const googleCondition = /^\s*condition\s*=\s*(.+)$/m.exec(googleClientId)?.[1]?.trim() ?? "";
  const googleIds = anchored(/^var\.google_client_id == "" \|\| can\(regex\("(.+)", var\.google_client_id\)\)$/.exec(googleCondition)?.[1]);
  if (
    !/type\s*=\s*string\b/.test(googleClientId) ||
    !/default\s*=\s*""/.test(googleClientId) ||
    !googleIds ||
    !GOOD_GOOGLE_CLIENT_IDS.every((id) => googleIds.test(id)) ||
    BAD_GOOGLE_CLIENT_IDS.some((id) => googleIds.test(id))
  ) {
    p.push(GOOGLE_CLIENT_ID);
  }
  const googleSignIn = block(tf, /variable\s+"google_sign_in"\s*\{/) ?? "";
  if (!/type\s*=\s*bool\b/.test(googleSignIn) || !/default\s*=\s*true\b/.test(googleSignIn)) p.push(GOOGLE_SIGN_IN);
  // Rule 5: Google is read, never written, and its secret never reaches the state. No connection sets a credential.
  const googleReads = [...tf.matchAll(/data\s+"auth0_connection"\s+"(\w+)"\s*\{/g)].map((m) => m[1]);
  const googleRead = block(tf, /data\s+"auth0_connection"\s+"google"\s*\{/);
  if (
    JSON.stringify(googleReads) !== '["google"]' ||
    !has(googleRead, /^\s*name\s*=\s*"google-oauth2"\s*$/m) ||
    !has(googleRead, /^\s*hide_client_secret\s*=\s*true\s*$/m) ||
    !has(googleRead, /^\s*skip_enabled_clients\s*=\s*true\s*$/m)
  ) {
    p.push(GOOGLE_READ_ONLY);
  }
  const connectionBlocks = blocks(tf, /(?:resource|data)\s+"auth0_connection\w*"\s+"\w+"\s*\{/g);
  if (connectionBlocks.some((b) => /^\s*(client_id|client_secret|client_secret_wo|options_client_secret_wo(_version)?)\s*=/m.test(b))) p.push(NO_CONNECTION_SECRET);
  // Rules 3 and 4: the email-and-password connection, imported, never destroyed, holding no credential, and its own
  // "Disable Sign Ups" bound to the one switch: it decides the page's offer and every self-service entry point.
  const database = block(tf, /resource\s+"auth0_connection"\s+"database"\s*\{/);
  if (
    JSON.stringify(names("auth0_connection")) !== '["database"]' ||
    !has(database, /^\s*name\s*=\s*"Username-Password-Authentication"\s*$/m) ||
    !has(database, /^\s*strategy\s*=\s*"auth0"\s*$/m) ||
    !has(block(database ?? "", /\blifecycle\s*\{/), /^\s*prevent_destroy\s*=\s*true\s*$/m) ||
    has(database, /^\s*(configuration|custom_scripts|enabled_clients)\s*=/m)
  ) {
    p.push(DATABASE);
  }
  if (!has(block(database ?? "", /\boptions\s*\{/), /^\s*disable_signup\s*=\s*!var\.allow_sign_ups\s*$/m)) p.push(DISABLE_SIGNUP);
  const passwordOptions = block(block(database ?? "", /\boptions\s*\{/) ?? "", /\bpassword_options\s*\{/);
  if (
    !passwordOptions ||
    ["complexity", "dictionary", "history", "profile_data"].some((b) => !block(passwordOptions, new RegExp(`\\b${b}\\s*\\{`))) ||
    has(database, new RegExp(`^\\s*(${LEGACY_PASSWORD_FIELDS.join("|")})\\s*(=|\\{)`, "m"))
  ) {
    p.push(PASSWORD_OPTIONS);
  }
  // Rules 1 and 2: exactly two people's connections, each enabled (authoritatively) for the portal and the agent only.
  const connectionObjects = [...tf.matchAll(/\b(resource|data)\s+"(auth0_connection\w*)"\s+"(\w+)"/g)].map((m) => `${m[1] === "data" ? "data." : ""}${m[2]}.${m[3]}`).sort();
  if (JSON.stringify(connectionObjects) !== JSON.stringify(CONNECTION_OBJECTS)) p.push(CONNECTIONS);
  const argument = (body: string | undefined, name: string) => new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`, "m").exec(body ?? "")?.[1]?.trim();
  const databaseClients = block(tf, /resource\s+"auth0_connection_clients"\s+"database"\s*\{/);
  const googleClients = block(tf, /resource\s+"auth0_connection_clients"\s+"google"\s*\{/);
  if (
    argument(databaseClients, "connection_id") !== "auth0_connection.database.id" ||
    argument(databaseClients, "enabled_clients") !== PEOPLE_CLIENTS ||
    argument(googleClients, "connection_id") !== "data.auth0_connection.google.id" ||
    argument(googleClients, "enabled_clients") !== `var.google_sign_in ? ${PEOPLE_CLIENTS} : []` ||
    [databaseClients, googleClients].some((b) => has(b, /auth0_client\.(l2|machine)\b/))
  ) {
    p.push(CONNECTION_CLIENTS);
  }
  const preconditions = blocks(block(googleClients ?? "", /\blifecycle\s*\{/), /\bprecondition\s*\{/g);
  if (preconditions.length !== 1 || argument(preconditions[0], "condition") !== GOOGLE_PRECONDITION || !/error_message\s*=\s*"[^"]*google_client_id/.test(preconditions[0]!)) p.push(GOOGLE_APP);

  // Nothing here manages users, assigns a role or holds secrets.
  if (/resource\s+"auth0_user"/.test(tf) || /\bpassword\s*=/.test(tf)) p.push("users and passwords are never managed here");
  // SPEC v1.16: no approver is configured, so no user is read either, and no output gives L2 one (it refuses it).
  if (/data\s+"auth0_user"/.test(tf)) p.push(NO_USER_READ);
  if (/CIBA_APPROVER=/.test(tf)) p.push(NO_APPROVER_OUTPUT);
  if (/resource\s+"auth0_(user_roles?|user_permissions?|role_users?|role_members?|organization_member\w*)"/.test(tf)) p.push(NOBODY_ASSIGNED);
  for (const [f, text] of Object.entries(s.all)) {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) p.push(`${f} holds a private key`);
    if (/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/.test(text)) p.push(`${f} holds a JWT`);
    if (f.endsWith(".tfvars") || f.endsWith(".tfstate") || f.endsWith(".tfplan")) p.push(`${f} must not be committed`);
  }

  // The output L2's parameter file takes: exactly the keys main.bicep reads.
  const want = Object.keys(bicepObject(s.bicepparam, "ciba")).sort();
  const out = block(block(tf, /output\s+"bicepparam_ciba"\s*\{/) ?? "", /value\s*=\s*\{/) ?? "";
  const got = [...out.matchAll(/^\s*(\w+)\s*=/gm)].map((m) => m[1]!).sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) p.push(`output bicepparam_ciba must have exactly the ciba keys of the parameter file (${want.join(", ")}), got ${got.join(", ")}`);
  // 013: the outputs for people's sign-in. The identity object has exactly the keys main.bicep reads, and names no
  // client: the portal's goes in userAccounts.portalClientId, and the agent's in the agent object (016, below).
  const wantIdentity = Object.keys(bicepObject(s.bicepparam, "identity")).sort();
  const identityOut = block(block(tf, /output\s+"bicepparam_identity"\s*\{/) ?? "", /value\s*=\s*\{/) ?? "";
  const gotIdentity = [...identityOut.matchAll(/^\s*(\w+)\s*=/gm)].map((m) => m[1]!).sort();
  if (wantIdentity.length === 0 || JSON.stringify(gotIdentity) !== JSON.stringify(wantIdentity)) {
    p.push(`output bicepparam_identity must have exactly the identity keys of the parameter file (${wantIdentity.join(", ")}), got ${gotIdentity.join(", ")}`);
  }
  if (!/issuer\s*=\s*local\.issuer\b/.test(identityOut) || !/audience\s*=\s*auth0_resource_server\.identity\.identifier\b/.test(identityOut) || /auth0_client\./.test(identityOut)) {
    p.push(IDENTITY_OUTPUT);
  }
  if (!has(block(tf, /output\s+"bicepparam_portal_client_id"\s*\{/), /value\s*=\s*auth0_client\.portal\.client_id\b/)) p.push("output bicepparam_portal_client_id must be the portal client's ID (userAccounts.portalClientId)");
  // 016: the agent object, with exactly the keys main.bicep reads but apiDocs, which is the parameter file's own
  // choice: the agent's client, and the pipeline's machine caller with its key's ID, empty until it is declared.
  const wantAgent = Object.keys(bicepObject(s.bicepparam, "agent")).filter((key) => key !== "apiDocs").sort();
  const agentOut = block(block(tf, /output\s+"bicepparam_agent"\s*\{/) ?? "", /value\s*=\s*\{/) ?? "";
  const gotAgent = [...agentOut.matchAll(/^\s*(\w+)\s*=/gm)].map((m) => m[1]!).sort();
  if (wantAgent.length === 0 || JSON.stringify(gotAgent) !== JSON.stringify(wantAgent)) {
    p.push(`output bicepparam_agent must have exactly the agent keys of the parameter file but apiDocs (${wantAgent.join(", ")}), got ${gotAgent.join(", ")}`);
  }
  if (
    !/^\s*clientId\s*=\s*auth0_client\.agent\.client_id$/m.test(agentOut) ||
    !/^\s*desktopClientId\s*=\s*auth0_client\.desktop\.client_id$/m.test(agentOut) ||
    !agentOut.includes(`try(auth0_client.machine["${PIPELINE_CALLER}"].client_id, "")`) ||
    !agentOut.includes(`try(one(auth0_client_credentials.machine["${PIPELINE_CALLER}"].private_key_jwt[0].credentials).key_id, "")`) ||
    !/machineClientId\s*=\s*try\(auth0_client\.machine\b/.test(agentOut) ||
    !/machineKeyId\s*=\s*try\(one\(auth0_client_credentials\.machine\b/.test(agentOut)
  ) {
    p.push(AGENT_OUTPUT);
  }
  // The lines for local env files: the agent and L2 get the same sign-in settings, and the list of clients a
  // person's token may come from is the agent's client alone.
  const envLines = (name: string) => [...(block(tf, new RegExp(`output\\s+"${name}"\\s*\\{`)) ?? "").matchAll(/^\s*"([A-Z_]+=[^"]*)",?$/gm)].map((m) => m[1]!);
  const signIn = ["AUTH_ISSUER=${local.issuer}", "AUTH_AUDIENCE=${auth0_resource_server.identity.identifier}", "AGENT_CLIENT_IDS=${auth0_client.agent.client_id},${auth0_client.desktop.client_id}"];
  if (
    JSON.stringify(envLines("l1_env")) !== JSON.stringify([...signIn, "API_DOCS_CLIENT_ID=${auth0_client.agent.client_id}", "AGENT_DESKTOP_CLIENT_ID=${auth0_client.desktop.client_id}"]) ||
    JSON.stringify(envLines("l2_env").filter((line) => !line.startsWith("CIBA_"))) !== JSON.stringify(signIn)
  ) {
    p.push(ENV_OUTPUTS);
  }

  // SPEC 1.26: the state is a local file on the operator's host, outside every checkout; the operator command passes
  // its path, so nothing of it is written in the folder.
  const backends = [...tf.matchAll(/\bbackend\s+"(\w+)"\s*\{/g)];
  if (backends.length !== 1 || backends[0]![1] !== "local") p.push(LOCAL_STATE);
  if ((block(tf, /\bbackend\s+"local"\s*\{/) ?? "").trim() !== "") p.push(NO_STATE_PATH);

  // Every variable the tfvars file sets exists, and the three without a default are the ones Terraform then requires.
  const declared = [...tf.matchAll(/variable\s+"(\w+)"\s*\{/g)].map((m) => m[1]!);
  for (const name of [...VARIABLES, "credential"]) if (!declared.includes(name)) p.push(`the operator's tfvars file or command sets var.${name}, which auth0/ doesn't declare`);
  const noDefault = declared.filter((name) => !/^\s*default\s*=/m.test(block(tf, new RegExp(`variable\\s+"${name}"\\s*\\{`)) ?? "")).sort();
  if (JSON.stringify(noDefault) !== JSON.stringify(["api_identifier", "environment", "tenant_domain"])) p.push(`only environment, tenant_domain and api_identifier may have no default (the operator command and its tfvars file set them), got ${noDefault.join(", ")}`);

  // Local state, plans and tfvars never reach git or an image.
  for (const pattern of ["auth0/.terraform/", "auth0/*.tfstate", "auth0/*.tfstate.*", "auth0/*.tfplan", "auth0/*.tfvars"]) {
    if (!s.gitignore.split("\n").includes(pattern)) p.push(`.gitignore must have ${pattern}`);
  }
  if (!s.dockerignore.split("\n").includes("auth0")) p.push(".dockerignore must exclude auth0");
  return p;
}

type Step = { id?: string; name?: string; if?: string; run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Workflow = {
  on?: Record<string, { branches?: string[]; paths?: string[] } | null>;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  jobs?: Record<string, { environment?: string; permissions?: unknown; secrets?: unknown; uses?: string; steps?: Step[] }>;
};

/** What .github/workflows/validate-auth0.yml must touch: the folder, the operator command, itself. */
const WATCHED = ["auth0/**", "scripts/auth0-tenant.sh", ".github/workflows/validate-auth0.yml"];
const WORKFLOW_TRIGGERS = `the check must run on a pull request to main or a push to main that touches ${WATCHED.join(", ")}, and by hand: never pull_request_target, never a schedule`;
const WORKFLOW_HOLDS_NOTHING = "the check must hold nothing: contents: read only, no GitHub environment, no secret or variable, no OIDC token, no called workflow";
const WORKFLOW_CHECKOUT = "the check must start with a checkout that keeps no credential (persist-credentials: false), and pin every action by its full commit SHA";
const WORKFLOW_ONLY_VALIDATES = `the check's one command must be the operator command's validate (bash ${SCRIPT} validate): it never plans, applies, imports or reads a state`;

/** One message per problem of the offline check (SPEC 1.26). Empty for the real workflow. */
export function workflowProblems(s: Sources): string[] {
  const p: string[] = [];
  const w = parse(s.workflow) as Workflow;
  const jobs = Object.values(w.jobs ?? {});
  const steps = jobs[0]?.steps ?? [];
  const on = w.on ?? {};
  const watches = (trigger: string) => JSON.stringify(on[trigger]?.branches) === '["main"]' && JSON.stringify(on[trigger]?.paths) === JSON.stringify(WATCHED);
  if (JSON.stringify(Object.keys(on).sort()) !== '["pull_request","push","workflow_dispatch"]' || !watches("pull_request") || !watches("push")) p.push(WORKFLOW_TRIGGERS);
  if (
    JSON.stringify(w.permissions) !== JSON.stringify({ contents: "read" }) ||
    jobs.length !== 1 ||
    jobs.some((j) => j.environment !== undefined || j.permissions !== undefined || j.secrets !== undefined || j.uses !== undefined) ||
    /\$\{\{\s*(secrets|vars)\.|id-token|ARM_|AUTH0_CLIENT/.test(s.workflow)
  ) {
    p.push(WORKFLOW_HOLDS_NOTHING);
  }
  if (!steps[0]?.uses?.startsWith("actions/checkout@") || steps[0].with?.["persist-credentials"] !== false || steps.some((x) => x.uses !== undefined && !/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/.test(x.uses.split(" ")[0]!))) {
    p.push(WORKFLOW_CHECKOUT);
  }
  const commands = steps.filter((x) => x.run !== undefined).map((x) => x.run!.trim());
  if (JSON.stringify(commands) !== JSON.stringify([`bash ${SCRIPT} validate`]) || steps.some((x) => x.if !== undefined || x.env !== undefined)) p.push(WORKFLOW_ONLY_VALIDATES);
  return p;
}

const SCRIPT_PINNED = "the operator command must pin Terraform by version and SHA-256, check the download before installing it, and install it in ~/.local/bin without sudo";
const SCRIPT_OWN_TERRAFORM = "every Terraform the operator command runs must be the pinned one in ~/.local/bin, in auth0/: never a terraform found on PATH";
const SCRIPT_STATE = "the state must be auth0.<environment>.tfstate in ~/x402-tfstate (X402_TFSTATE_DIR), outside every checkout, written readable by the operator only (umask 077) and given to the local backend; the tfvars file and the plan sit beside it";
const SCRIPT_PRIVATE = "the operator command must refuse a state directory, tfvars file, state, credential file or plan that another user may read (mode 0700 and 0600, the operator's own)";
const SCRIPT_LOCKED = "every init must use the provider exactly as .terraform.lock.hcl pins it (-lockfile=readonly)";
const SCRIPT_CREDENTIAL = "the Management API credential must come from its own file (~/x402-secrets/auth0-management.<environment>.env), read as two lines and never sourced, and reach Terraform's environment only: never exported or printed";
const SCRIPT_KEY_ONLY = 'the operator command must provision credential = "key" only, refuse a tfvars file that sets environment, credential or a client secret, and never take L2\'s client secret (Constitution V)';
/** 018 research R9: the one place on the operator's host where someone would be tempted to put the Google secret. */
const SCRIPT_NO_SECRET = "the operator command must refuse a tfvars file that sets any variable whose name holds secret, or that holds a Google client secret (GOCSPX-): the Google application's secret is entered in the tenant's Dashboard only (specs/018 research R9)";
const SCRIPT_ONLY_APPLY = "the only change to the tenant must be `apply`, applying exactly the plan `plan` saved, after validate: no other apply, no destroy, no -auto-approve, -target or -replace, and the passthrough refuses apply and destroy";
const SCRIPT_NPM = `npm run auth0:tenant must run the operator command (bash ${SCRIPT})`;
/** The only lines that read the secret: the check that the file had it, and Terraform's environment. */
const SECRET_USES = ['[[ -n "$CLIENT_ID" && -n "$CLIENT_SECRET" ]] || fail "$CREDENTIAL_FILE needs AUTH0_CLIENT_ID= and AUTH0_CLIENT_SECRET="', 'AUTH0_CLIENT_ID="$CLIENT_ID" AUTH0_CLIENT_SECRET="$CLIENT_SECRET" TF_INPUT=0 \\'];

/** One message per problem of the operator command (SPEC 1.26). Empty for the real script. */
export function scriptProblems(s: Sources): string[] {
  const p: string[] = [];
  // The script without its comments, so a comment never satisfies or trips a check.
  const sh = s.script.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  const lines = sh.split("\n").map((line) => line.trim());
  const caseBody = (name: string) => new RegExp(`^ {2}${name}\\)\\n([\\s\\S]*?)\\n {4};;$`, "m").exec(sh)?.[1] ?? "";
  const fn = (name: string) => block(sh, new RegExp(`^${name}\\(\\)\\s*\\{`, "m")) ?? "";

  // The pinned Terraform, checked before it is installed, in ~/.local/bin, without sudo.
  const install = fn("install_terraform");
  const checked = install.indexOf('echo "$TERRAFORM_SHA256  $tmp/terraform.zip" | sha256sum -c --quiet -');
  if (
    !/^TERRAFORM_VERSION=\d+\.\d+\.\d+$/m.test(sh) ||
    !/^TERRAFORM_SHA256=[0-9a-f]{64}$/m.test(sh) ||
    !install.includes('"https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip"') ||
    checked < 0 ||
    install.indexOf('install -m 0755 "$tmp/terraform" "$TF"') < checked ||
    !/^TF="\$HOME\/\.local\/bin\/terraform"$/m.test(sh) ||
    /\bsudo\b/.test(sh)
  ) {
    p.push(SCRIPT_PINNED);
  }
  // Terraform only through tf(), which runs the pinned binary in auth0/.
  const runs = lines.filter((line) => ((/"\$TF"\s/.test(line) && !/"\$TF" version -json/.test(line)) || /(^|[;(|&]\s*)terraform\s/.test(line)) && !/^(echo|fail) /.test(line));
  if (JSON.stringify(runs) !== JSON.stringify(['TF_VAR_environment="$ENVIRONMENT" TF_VAR_credential=key "$TF" -chdir="$DIR" "$@"']) || !/^DIR="\$ROOT\/auth0"$/m.test(sh)) p.push(SCRIPT_OWN_TERRAFORM);
  // The state, outside every checkout, and the files beside it.
  if (
    !/^umask 077$/m.test(sh) ||
    !/^STATE_DIR=\$\{X402_TFSTATE_DIR:-\$HOME\/x402-tfstate\}$/m.test(sh) ||
    !/^STATE="\$STATE_DIR\/auth0\.\$ENVIRONMENT\.tfstate"$/m.test(sh) ||
    !/^TFVARS="\$STATE_DIR\/auth0\.\$ENVIRONMENT\.tfvars"$/m.test(sh) ||
    !/^PLAN="\$STATE_DIR\/auth0\.\$ENVIRONMENT\.tfplan"$/m.test(sh) ||
    !fn("init_state").includes('-backend-config="path=$STATE"')
  ) {
    p.push(SCRIPT_STATE);
  }
  const privateFn = fn("private");
  const ownerMode = fn("owner_mode");
  const tfvars = fn("check_tfvars");
  const credential = fn("read_credential");
  if (
    !privateFn.includes(`[[ "$(owner_mode "$path")" == "$(id -u) $mode" ]]`) ||
    // GNU stat (the operator's Linux host) first, then BSD stat (macOS) cut to the same bits, special bits included.
    !ownerMode.includes(`if found=$(stat -c '%u %a' "$1" 2> /dev/null); then\n    echo "$found"\n  elif found=$(stat -f '%u %Op' "$1" 2> /dev/null)`) ||
    !ownerMode.includes("$((8#${BASH_REMATCH[2]} & 8#7777))") ||
    !privateFn.includes('! -L "$path"') ||
    !tfvars.includes('private "$STATE_DIR" 700') ||
    !tfvars.includes('private "$TFVARS" 600') ||
    !tfvars.includes('[[ ! -e "$STATE" ]] || private "$STATE" 600') ||
    !credential.includes('private "$(dirname "$CREDENTIAL_FILE")" 700') ||
    !credential.includes('private "$CREDENTIAL_FILE" 600') ||
    !caseBody("apply").includes('private "$PLAN" 600')
  ) {
    p.push(SCRIPT_PRIVATE);
  }
  const inits = lines.filter((line) => /^tf init\b/.test(line));
  if (inits.length !== 2 || inits.some((line) => !line.includes("-lockfile=readonly"))) p.push(SCRIPT_LOCKED);
  // The credential: two lines of its own file, into Terraform's environment only.
  if (
    !/^CREDENTIAL_FILE=\$\{AUTH0_CREDENTIAL_FILE:-\$HOME\/x402-secrets\/auth0-management\.\$ENVIRONMENT\.env\}$/m.test(sh) ||
    !credential.includes("AUTH0_CLIENT_ID=*) CLIENT_ID=${line#AUTH0_CLIENT_ID=} ;;") ||
    !credential.includes("AUTH0_CLIENT_SECRET=*) CLIENT_SECRET=${line#AUTH0_CLIENT_SECRET=} ;;") ||
    !credential.includes('done < "$CREDENTIAL_FILE"') ||
    !fn("tf").includes('AUTH0_CLIENT_ID="$CLIENT_ID" AUTH0_CLIENT_SECRET="$CLIENT_SECRET" TF_INPUT=0') ||
    JSON.stringify(lines.filter((line) => /\$\{?CLIENT_SECRET\b/.test(line))) !== JSON.stringify(SECRET_USES) ||
    /^\s*(source|\.)\s|\bexport\b|\beval\b|set -[a-z]*x/m.test(sh)
  ) {
    p.push(SCRIPT_CREDENTIAL);
  }
  // Constitution V: L2's credential is held by L2 only. The script provisions the key path alone.
  if (
    !fn("tf").includes("TF_VAR_credential=key") ||
    !tfvars.includes("(environment|credential|") ||
    /TF_VAR_client_secret|-var[ =]/.test(sh)
  ) {
    p.push(SCRIPT_KEY_ONLY);
  }
  // 018: no secret of any kind in the tfvars file, and never the Google application's.
  if (!tfvars.includes("(environment|credential|[[:alnum:]_]*secret[[:alnum:]_]*)") || !tfvars.includes(`if grep -q 'GOCSPX-' "$TFVARS"; then fail`)) p.push(SCRIPT_NO_SECRET);
  // An apply of exactly the saved plan, made after validate, and nothing else that changes the tenant.
  const plan = caseBody("plan");
  const applies = lines.filter((line) => /^tf (apply|destroy)\b|\bapply\b.*-auto-approve|\bdestroy\b/.test(line) && !/^(apply \| destroy\)|fail )/.test(line));
  if (
    JSON.stringify(applies) !== JSON.stringify(['tf apply -no-color -lock-timeout=120s "$PLAN"']) ||
    !caseBody("apply").includes('tf apply -no-color -lock-timeout=120s "$PLAN"') ||
    !/^\s*validate$/m.test(plan.split("tf plan")[0] ?? "") ||
    !plan.includes('tf plan -no-color -lock-timeout=120s -var-file="$TFVARS" -out="$PLAN"') ||
    !caseBody("terraform").includes('apply | destroy) fail "terraform $1 is not run here') ||
    /-auto-approve|-target|-replace|-destroy/.test(sh)
  ) {
    p.push(SCRIPT_ONLY_APPLY);
  }
  // The offline checks the workflow runs.
  const validate = fn("validate");
  if (!validate.includes("tf init -backend=false -lockfile=readonly") || !validate.includes("tf fmt -check -diff") || !validate.includes("tf validate -no-color")) {
    p.push("validate must init with no backend and the locked provider, then run fmt -check and validate");
  }
  // 013, 016: the outputs every value of the parameter files and the local env files comes from, none of them secret.
  const outputs = fn("outputs");
  for (const output of ["l2_env", "portal_env", "l1_env", "bicepparam_ciba", "bicepparam_identity", "bicepparam_portal_client_id", "bicepparam_agent"]) {
    if (!new RegExp(`\\b${output}\\b`).test(outputs)) p.push(`the operator command must print the output ${output} after an apply`);
  }
  if (!/tf output -no-color -raw "\$name"/.test(outputs) || !/tf output -no-color -json "\$name"/.test(outputs)) p.push("the operator command must print the outputs as Terraform gives them (-raw for the env lines, -json for the objects)");
  if ((JSON.parse(s.packageJson) as { scripts?: Record<string, string> }).scripts?.["auth0:tenant"] !== `bash ${SCRIPT}`) p.push(SCRIPT_NPM);
  return p;
}

/** An object parameter (ciba, identity, agent) in a parameter file, parsed from its text (keys and literal values). */
function bicepObject(bicepparam: string, name: string): Record<string, string> {
  const body = block(bicepparam, new RegExp(`param ${name} = \\{`)) ?? "";
  return Object.fromEntries([...body.matchAll(/^\s*(\w+):\s*(.+)$/gm)].map((m) => [m[1]!, m[2]!.trim()]));
}

/** One call the Action made on Auth0's `api`: its dotted path and its arguments. */
type ApiCall = [path: string, args: unknown[]];

/**
 * Runs an Action's code as Auth0 does (CommonJS, `exports.<handler>(event, api)`; onExecutePostLogin by default), in a
 * context of its own, with a stand-in `api` that records every call on it, whatever its path. Throws when the Action
 * does.
 */
export async function runAction(source: string, event: unknown, handler = "onExecutePostLogin"): Promise<ApiCall[]> {
  const calls: ApiCall[] = [];
  const recorder = (path: string): unknown =>
    new Proxy(function () {}, {
      get: (_target, key) => (typeof key === "symbol" || key === "then" ? undefined : recorder(path ? `${path}.${key}` : key)),
      apply: (_target, _self, args: unknown[]) => {
        calls.push([path, args]);
        return undefined;
      },
    });
  const exports: Record<string, unknown> = {};
  runInNewContext(source, { exports, module: { exports } });
  if (JSON.stringify(Object.keys(exports)) !== JSON.stringify([handler]) || typeof exports[handler] !== "function") throw new Error(`the Action must export ${handler} only`);
  await (exports[handler] as (event: unknown, api: unknown) => unknown)(event, recorder(""));
  return calls;
}

/** A sign-in with a password at `first` and a second factor at `last` (ISO times), as the post-login event has it. */
const signIn = (first: string, last: string) => ({ authentication: { methods: [{ name: "pwd", timestamp: first }, { name: "mfa", timestamp: last }] }, user: { user_id: "auth0|1" } });
const FIRST = "2026-11-10T10:00:00.000Z";
const LAST = "2026-11-10T10:05:30.900Z";

/** A method of the post-login event, and the time in whole seconds a claim carries. */
const method = (name: string, timestamp: unknown) => ({ name, timestamp });
const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);
/** An administrator's post-login event: the methods so far, and the protocol of the request (null: no transaction). */
const admin = (methods: unknown[], protocol: string | null = "oidc-basic-profile") => ({
  authentication: { methods },
  authorization: { roles: ["x402-agent", ADMIN_ROLE] },
  ...(protocol === null ? {} : { transaction: { protocol } }),
  user: { user_id: "auth0|1" },
});
const authTime = (iso: string): ApiCall => ["accessToken.setCustomClaim", [AUTH_TIME_CLAIM, seconds(iso)]];
const mfaTime = (iso: string): ApiCall => ["accessToken.setCustomClaim", [MFA_TIME_CLAIM, seconds(iso)]];
const CHALLENGE: ApiCall = ["authentication.challengeWithAny", [SECOND_FACTORS]];
type Case = [label: string, event: unknown, want: ApiCall[]];

/** 019: an /authorize request's PKCE parameters, as the post-login event has them (event.request.query). */
const S256_QUERY = { code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256" };
const RENEWAL = "oauth2-refresh-token";
/**
 * 019: a sign-in (or a renewal) through a client: its metadata (the desktop client's marker, none, or no metadata at
 * all), the person's roles, the protocol, the /authorize query (null: no request) and the methods so far (a
 * password only, by default: a second factor is due).
 */
const through = (metadata: Record<string, string> | undefined, roles: string[], protocol: string, query: Record<string, string> | null = S256_QUERY, methods: unknown[] = [method("pwd", FIRST)]) => ({
  authentication: { methods },
  authorization: { roles },
  client: { client_id: "c-1", ...(metadata !== undefined && { metadata }) },
  transaction: { protocol },
  ...(query !== null && { request: { query } }),
  user: { user_id: "auth0|1" },
});
const DESKTOP_METADATA_OF = { x402_client: DESKTOP_MARKER };
const NOT_FOR_AGENT: ApiCall = ["access.deny", ["not_authorized_for_agent"]];
const PKCE_REQUIRED: ApiCall = ["access.deny", ["pkce_required"]];

/**
 * 019 (spec NFR-004): the 12 combinations of the three clients a person signs in through (the desktop client, the
 * agent's docs page client and the portal's, the last two without the marker, the portal's with no metadata at all),
 * with and without x402-agent, on a sign-in and on a renewal. Only the desktop client is ever refused, and its
 * refusals come before the challenge; every other client gets exactly today's calls.
 */
function desktopCombinations(): Case[] {
  const clients: [string, Record<string, string> | undefined][] = [["the desktop client", DESKTOP_METADATA_OF], ["the docs page's client", {}], ["the portal's client", undefined]];
  const cases: Case[] = [];
  for (const [client, metadata] of clients) {
    for (const holds of [true, false]) {
      for (const protocol of ["oidc-basic-profile", RENEWAL]) {
        const desktop = metadata === DESKTOP_METADATA_OF;
        const renewal = protocol === RENEWAL;
        const want: ApiCall[] = !desktop ? [authTime(FIRST)] : !holds ? [authTime(FIRST), NOT_FOR_AGENT] : renewal ? [authTime(FIRST)] : [authTime(FIRST), CHALLENGE];
        const label = `${client} ${holds ? "with" : "without"} ${AGENT_ROLE} on ${protocol}`;
        cases.push([label, through(metadata, holds ? [AGENT_ROLE] : [], protocol, renewal ? null : S256_QUERY), want]);
      }
    }
  }
  return cases;
}

/** Runs each case; one message per case whose calls differ, or that throws (a failing Action stops sign-ins). */
async function caseProblems(source: string, cases: Case[], handler = "onExecutePostLogin"): Promise<string[]> {
  const p: string[] = [];
  for (const [label, event, want] of cases) {
    try {
      const got = await runAction(source, event, handler);
      if (JSON.stringify(got) !== JSON.stringify(want)) p.push(`the Action, for ${label}, must call ${JSON.stringify(want)}, not ${JSON.stringify(got)}`);
    } catch (e) {
      p.push(`the Action, for ${label}, must not throw (a failing Action stops every sign-in of the tenant): ${(e as Error).message}`);
    }
  }
  return p;
}

/**
 * What sign-in-time.js does, by running it: the claim is the time of the most recent authentication, in whole
 * seconds; an event without a usable time sets none (never the current time, which would make a token renewal look
 * like a new sign-in). Phase 3: an administrator's interactive sign-in in a browser without a second factor at least
 * as recent as the rest of it is challenged with push or a one-time code; a refresh-token exchange or another
 * protocol never is, and nobody else ever is. Nothing else is set. One message per problem.
 */
export async function actionProblems(source: string): Promise<string[]> {
  return caseProblems(source, [
    ["a sign-in with two methods", signIn(FIRST, LAST), [authTime(LAST)]],
    ["the same methods in the other order", { authentication: { methods: [...signIn(FIRST, LAST).authentication.methods].reverse() } }, [authTime(LAST)]],
    ["an event without authentication details", { user: { user_id: "auth0|1" } }, []],
    ["an event without methods", { authentication: { methods: [] } }, []],
    ["a method without a readable time", { authentication: { methods: [{ name: "pwd", timestamp: "yesterday" }, { name: "mfa" }, null] } }, []],
    ["an administrator's sign-in without a second factor", admin([method("pwd", FIRST)]), [authTime(FIRST), CHALLENGE]],
    ["an administrator's sign-in with a second factor after the password", admin([method("pwd", FIRST), method("mfa", LAST)]), [authTime(LAST)]],
    ["an administrator's sign-in with a second factor at the password's time", admin([method("pwd", FIRST), method("mfa", FIRST)]), [authTime(FIRST)]],
    ["an administrator's new password after an older second factor", admin([method("mfa", FIRST), method("pwd", LAST)]), [authTime(LAST), CHALLENGE]],
    ["an administrator's sign-in with no readable time", admin([method("pwd", "yesterday")]), [CHALLENGE]],
    ...BROWSER_PROTOCOLS.slice(1).map((protocol): Case => [`an administrator's sign-in by ${protocol}`, admin([method("pwd", FIRST)], protocol), [authTime(FIRST), CHALLENGE]]),
    ...["oauth2-refresh-token", "oauth2-resource-owner", "oauth2-token-exchange", "oidc-ciba", "samlp"].map((protocol): Case => [`an administrator's token by ${protocol}`, admin([method("pwd", FIRST)], protocol), [authTime(FIRST)]]),
    ["an administrator's event without a transaction", admin([method("pwd", FIRST)], null), [authTime(FIRST)]],
    ["a person without the administrator's role", { ...admin([method("pwd", FIRST)]), authorization: { roles: ["x402-agent"] } }, [authTime(FIRST)]],
    ["a role named like the administrator's", { ...admin([method("pwd", FIRST)]), authorization: { roles: [`${ADMIN_ROLE}istrator`] } }, [authTime(FIRST)]],
    // 019: the desktop client.
    ...desktopCombinations(),
    ["the desktop client with no code_challenge", through(DESKTOP_METADATA_OF, [AGENT_ROLE], "oidc-basic-profile", {}), [authTime(FIRST), PKCE_REQUIRED]],
    ["the desktop client with code_challenge_method plain", through(DESKTOP_METADATA_OF, [AGENT_ROLE], "oidc-basic-profile", { ...S256_QUERY, code_challenge_method: "plain" }), [authTime(FIRST), PKCE_REQUIRED]],
    ["the desktop client with no code_challenge_method", through(DESKTOP_METADATA_OF, [AGENT_ROLE], "oidc-basic-profile", { code_challenge: S256_QUERY.code_challenge }), [authTime(FIRST), PKCE_REQUIRED]],
    ["the desktop client with the method in lower case", through(DESKTOP_METADATA_OF, [AGENT_ROLE], "oidc-basic-profile", { ...S256_QUERY, code_challenge_method: "s256" }), [authTime(FIRST), PKCE_REQUIRED]],
    ["the desktop client with no request", through(DESKTOP_METADATA_OF, [AGENT_ROLE], "oidc-basic-profile", null), [authTime(FIRST), PKCE_REQUIRED]],
    ["the desktop client without the role and without a code_challenge", through(DESKTOP_METADATA_OF, [], "oidc-basic-profile", {}), [authTime(FIRST), NOT_FOR_AGENT]],
    ["the desktop client with a fresh second factor", through(DESKTOP_METADATA_OF, [AGENT_ROLE], "oidc-basic-profile", S256_QUERY, [method("pwd", FIRST), method("mfa", LAST)]), [authTime(LAST)]],
    ["the desktop client by oidc-hybrid-profile", through(DESKTOP_METADATA_OF, [AGENT_ROLE], "oidc-hybrid-profile"), [authTime(FIRST), CHALLENGE]],
    ["an administrator without x402-agent through the desktop client", through(DESKTOP_METADATA_OF, [ADMIN_ROLE], "oidc-basic-profile"), [authTime(FIRST), NOT_FOR_AGENT]],
    ["a role named like x402-agent through the desktop client", through(DESKTOP_METADATA_OF, [`${AGENT_ROLE}s`], RENEWAL, null), [authTime(FIRST), NOT_FOR_AGENT]],
  ]);
}

/**
 * What mfa-time.js does, by running it: the claim is the time of the most recent second factor (a method named mfa),
 * in whole seconds, whatever the other methods' times; without one it sets nothing, never the current time.
 */
export async function mfaActionProblems(source: string): Promise<string[]> {
  return caseProblems(source, [
    ["a sign-in with a second factor", signIn(FIRST, LAST), [mfaTime(LAST)]],
    ["a second factor older than the password", { authentication: { methods: [method("mfa", FIRST), method("pwd", LAST)] } }, [mfaTime(FIRST)]],
    ["two second factors", { authentication: { methods: [method("mfa", FIRST), method("mfa", LAST), method("pwd", FIRST)] } }, [mfaTime(LAST)]],
    ["a password only", { authentication: { methods: [method("pwd", LAST)] } }, []],
    ["an event without authentication details", { user: { user_id: "auth0|1" } }, []],
    ["a second factor without a readable time", { authentication: { methods: [method("mfa", "yesterday"), { name: "mfa" }, null] } }, []],
    ["an administrator after a challenge", admin([method("pwd", FIRST), method("mfa", LAST)]), [mfaTime(LAST)]],
  ]);
}

const mutate = (s: Sources, file: string, from: string | RegExp, to: string): Sources => {
  const text = (file in s.tf ? s.tf[file] : s.all[file])!;
  expect(typeof from === "string" ? text.includes(from) : from.test(text), `${file} contains the mutation anchor`).toBe(true);
  const next = text.replace(from, to);
  return { ...s, tf: file in s.tf ? { ...s.tf, [file]: next } : s.tf, all: { ...s.all, [file]: next } };
};

const terraform = spawnSync("terraform", ["version"], { encoding: "utf8" }).status === 0;

/** Terraform calls a plan makes: init with no backend, fmt, validate, init with the state, plan. */
const TF_CALLS_PER_PLAN = 5;

/**
 * A HOME for the operator command: its state directory with a tfvars file, its credential file, and a stand-in for
 * the pinned Terraform in ~/.local/bin that answers `version -json` with the pinned version (so nothing is
 * downloaded) and records every other call with what it got from the environment.
 */
function operatorHome(): string {
  const home = mkdtempSync(join(tmpdir(), "auth0-tenant-"));
  const version = /^TERRAFORM_VERSION=(.+)$/m.exec(readFileSync(SCRIPT, "utf8"))?.[1];
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(
    join(home, ".local", "bin", "terraform"),
    [
      "#!/usr/bin/env bash",
      `if [[ "$1" == version ]]; then echo '{"terraform_version": "${version}"}'; exit 0; fi`,
      `echo "$* | id=\${AUTH0_CLIENT_ID-} secret=\${AUTH0_CLIENT_SECRET-} credential=\${TF_VAR_credential-} environment=\${TF_VAR_environment-}" >> "${home}/terraform-calls"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  mkdirSync(join(home, "x402-tfstate"), { mode: 0o700 });
  writeFileSync(join(home, "x402-tfstate", "auth0.dev.tfvars"), 'tenant_domain = "x402-dev.us.auth0.com"\n', { mode: 0o600 });
  mkdirSync(join(home, "x402-secrets"), { mode: 0o700 });
  writeFileSync(join(home, "x402-secrets", "auth0-management.dev.env"), "AUTH0_CLIENT_ID=client-1\nAUTH0_CLIENT_SECRET=secret-1\n", { mode: 0o600 });
  return home;
}

/** Runs the operator command with that HOME, a clean environment and no credential of the caller's. */
function runScript(home: string, args: string[]) {
  const r = spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("T-IAC-02 Auth0 tenant as code (auth0/)", () => {
  it("the real configuration has no problem", () => {
    expect(auth0Problems(load())).toEqual([]);
  });

  it("the parameter file's ciba object is the one main.bicep reads, and starts off", () => {
    expect(bicepObject(load().bicepparam, "ciba")).toMatchObject({ enabled: "false", credential: "'key'" });
  });

  it("013: the parameter file's identity object has the two keys main.bicep reads", () => {
    expect(Object.keys(bicepObject(load().bicepparam, "identity")).sort()).toEqual(["audience", "issuer"]);
  });

  it("016, 019: the parameter file's agent object has the five keys main.bicep reads: Terraform's four and its own apiDocs", () => {
    expect(Object.keys(bicepObject(load().bicepparam, "agent")).sort()).toEqual(["apiDocs", "clientId", "desktopClientId", "machineClientId", "machineKeyId"]);
  });

  it.each<[string, string, string | RegExp, string, string]>([
    ["an ES256 credential", "main.tf", 'algorithm       = "RS256"', 'algorithm       = "ES256"', "the credential's algorithm must be RS256 (what L2 signs; Auth0 never takes ES256)"],
    ["a second grant type", "main.tf", '["urn:openid:params:grant-type:ciba"]', '["urn:openid:params:grant-type:ciba", "client_credentials"]', "L2's client must have the CIBA grant and no other"],
    ["e-mail notifications", "main.tf", '["guardian-push"]', '["guardian-push", "email"]', "L2's client must notify through guardian-push only"],
    ["transactional consent", "main.tf", 'consent_policy = "null"', 'consent_policy = "transactional-authorization-with-mfa"', 'the API must use standard consent (consent_policy = "null"); CIBA is not supported with transactional-authorization-with-mfa'],
    ["another details type", "main.tf", 'authorization-details:v1:x402-payment"', 'authorization-details:v1:x402-pay"', `local.details_type must equal DETAILS_TYPE (${DETAILS_TYPE}), the type L2 sends`],
    ["machine tokens allowed", "main.tf", /client \{\n\s+policy = "deny_all"/, 'client {\n      policy = "require_client_grant"', "no machine-to-machine token for the API (client policy deny_all)"],
    ["users without a grant", "main.tf", 'policy = "require_client_grant"', 'policy = "allow_all"', "users may request the type only through a client grant (user policy require_client_grant)"],
    ["HS256 tokens", "main.tf", 'signing_alg          = "RS256"', 'signing_alg          = "HS256"', "the API must sign with RS256 (L2 accepts RS256 only)"],
    ["no prevent_destroy on Guardian", "main.tf", "prevent_destroy = true", "prevent_destroy = false", "auth0_guardian must never be destroyed (it would turn off every MFA factor of the tenant)"],
    ["a stored client secret", "main.tf", "client_secret_wo         = ", "client_secret            = ", "the client secret must be write-only (client_secret_wo), never stored in state"],
    ["a non-ephemeral secret variable", "variables.tf", "  ephemeral   = true\n", "", "var.client_secret must be sensitive and ephemeral"],
    ["provider credentials in a file", "versions.tf", "domain = var.tenant_domain", 'domain = var.tenant_domain\n  client_id = "abc"', "the provider block must take credentials from the environment only, never from a file"],
    ["an unpinned provider", "versions.tf", '">= 1.60.0, < 2.0.0"', '">= 1.0.0"', "the provider must be auth0/auth0 pinned to >= 1.60.0, < 2.0.0"],
    ["a managed user", "main.tf", 'resource "auth0_client" "portal" {', 'resource "auth0_user" "approver" {\n  password = "x"\n}\n\nresource "auth0_client" "portal" {', "users and passwords are never managed here"],
    ["Phase 3: the approver read again", "main.tf", 'resource "auth0_client" "portal" {', 'data "auth0_user" "approver" {\n  user_id = "auth0|someone"\n}\n\nresource "auth0_client" "portal" {', NO_USER_READ],
    ["Phase 3: the approver back in L2's env lines", "outputs.tf", '    "CIBA_AUDIENCE=${auth0_resource_server.payments.identifier}",\n', '    "CIBA_AUDIENCE=${auth0_resource_server.payments.identifier}",\n    "CIBA_APPROVER=auth0|someone",\n', NO_APPROVER_OUTPUT],
    ["SPEC 1.26: a remote state", "versions.tf", '  backend "local" {}', '  backend "azurerm" {\n    use_azuread_auth = true\n  }', LOCAL_STATE],
    ["SPEC 1.26: no backend, so a state in the checkout", "versions.tf", '  backend "local" {}\n', "", LOCAL_STATE],
    ["SPEC 1.26: a state path written in the folder", "versions.tf", '  backend "local" {}', '  backend "local" {\n    path = "terraform.tfstate"\n  }', NO_STATE_PATH],
    ["an output missing clientKeyId", "outputs.tf", '    clientKeyId = ""\n', "", "output bicepparam_ciba must have exactly the ciba keys of the parameter file (audience, clientId, clientKeyId, credential, enabled, issuer), got audience, clientId, credential, enabled, issuer"],
  ])("must fail: %s is reported", (_label, file, from, to, message) => {
    expect(auth0Problems(mutate(load(), file, from, to))).toContain(message);
  });

  it("must fail: a lock file written on one platform only is reported", () => {
    const s = load();
    const hashes = s.lock.match(/^\s*"h1:.*\n/gm) ?? [];
    expect(hashes.length, "the lock file has an h1 checksum to take out").toBeGreaterThanOrEqual(2);
    expect(auth0Problems({ ...s, lock: s.lock.replace(hashes[1]!, "") })).toContain(LOCKED_FOR_RUNNER);
  });

  // 013: people's sign-in. One mutant, at least, for each rule of contracts/config-and-secrets.md "auth0/".
  const PORTAL_PUBLIC = "the portal's client must be a public spa client: authentication_method none, no secret and no key";
  const PORTAL_GRANT = "the portal's client must have only its own grant (authorization_code, refresh_token)";
  const PORTAL_URLS = `the portal client's callbacks, web origins and logout URLs must be exactly ${LOCAL_PORTAL} and var.portal_origin when set`;
  it.each<[string, string, string | RegExp, string, string]>([
    ["an API without RBAC", "main.tf", /enforce_policies(\s*)= true/, "enforce_policies$1= false", "people's API must enforce RBAC (enforce_policies = true)"],
    ["permissions left out of the token", "main.tf", '"access_token_authz"', '"access_token"', 'people\'s API must put the permissions in the access token (token_dialect = "access_token_authz")'],
    ["an API without refresh tokens", "main.tf", /(resource "auth0_resource_server" "identity" \{[\s\S]*?allow_offline_access\s*=\s*)true/, "$1false", "people's API must allow offline access (the web app's refresh-token rotation)"],
    ["HS256 tokens for people", "main.tf", /(resource "auth0_resource_server" "identity" \{[\s\S]*?signing_alg\s*=\s*)"RS256"/, '$1"HS256"', "people's API must sign with RS256 (the services accept RS256 only)"],
    ["the approval API reused for people", "main.tf", /identifier(\s*)= local\.identity_audience/, "identifier$1= var.api_identifier", "people's API must have an identifier of its own (local.identity_audience), never the approval API's"],
    ["a second list of permissions on people's API", "main.tf", 'resource "auth0_client" "portal" {', 'resource "auth0_resource_server_scopes" "more" {\n  resource_server_identifier = auth0_resource_server.identity.identifier\n\n  scopes {\n    name = "portal:use"\n  }\n}\n\nresource "auth0_client" "portal" {', TWO_ROLES],
    ["a third role", "main.tf", 'resource "auth0_client" "portal" {', 'resource "auth0_role" "user" {\n  name = "x402-user"\n}\n\nresource "auth0_client" "portal" {', TWO_ROLES],
    ["a third role that holds a permission", "main.tf", 'resource "auth0_client" "portal" {', 'resource "auth0_role_permissions" "user" {\n  role_id = "rol_x"\n\n  permissions {\n    name                       = "read:users"\n    resource_server_identifier = "https://x402-dev.us.auth0.com/api/v2/"\n  }\n}\n\nresource "auth0_client" "portal" {', TWO_ROLES],
    ["a portal client with a secret", "main.tf", /(resource "auth0_client_credentials" "portal" \{[\s\S]*?authentication_method\s*=\s*)"none"/, '$1"client_secret_post"', PORTAL_PUBLIC],
    ["a confidential portal client", "main.tf", 'app_type        = "spa"', 'app_type        = "regular_web"', PORTAL_PUBLIC],
    ["a portal client with the implicit grant", "main.tf", '["authorization_code", "refresh_token"]', '["authorization_code", "refresh_token", "implicit"]', PORTAL_GRANT],
    ["a portal client with the device grant", "main.tf", '["authorization_code", "refresh_token"]', `["authorization_code", "refresh_token", "${DEVICE_GRANT}"]`, PORTAL_GRANT],
    ["a second callback URL", "main.tf", `var.local_origins ? ["${LOCAL_PORTAL}"] : []`, `var.local_origins ? ["${LOCAL_PORTAL}", "https://portal.example"] : []`, PORTAL_URLS],
    ["another local origin", "main.tf", `"${LOCAL_PORTAL}"`, '"http://localhost:3000"', PORTAL_URLS],
    ["a callback written in the client", "main.tf", /callbacks(\s*)= local\.portal_origins/, 'callbacks$1= ["https://portal.example/callback"]', PORTAL_URLS],
    ["a cross-origin URL of its own", "main.tf", /(\n  web_origins\s*= local\.portal_origins)/, "$1\n  allowed_origins     = local.portal_origins", PORTAL_URLS],
    ["a wildcard portal origin", "variables.tf", 'can(regex("^https://[a-z0-9][a-z0-9.-]*$", var.portal_origin))', 'startswith(var.portal_origin, "https://")', ORIGIN("portal_origin")],
    ["SPEC 1.26: a portal origin with a path", "variables.tf", '"^https://[a-z0-9][a-z0-9.-]*$", var.portal_origin', '"^https://[a-z0-9][a-z0-9./-]*$", var.portal_origin', ORIGIN("portal_origin")],
    ["SPEC 1.26: a portal origin that may be http", "variables.tf", '"^https://[a-z0-9][a-z0-9.-]*$", var.portal_origin', '"^https?://[a-z0-9][a-z0-9.-]*$", var.portal_origin', ORIGIN("portal_origin")],
    ["refresh tokens that don't rotate", "main.tf", 'rotation_type                = "rotating"', 'rotation_type                = "non-rotating"', "the portal client's refresh tokens must rotate and expire"],
    ["refresh tokens that never expire", "main.tf", "infinite_token_lifetime      = false", "infinite_token_lifetime      = true", "the portal client's refresh tokens must rotate and expire"],
    ["an Action that replaces the tenant's flow", "main.tf", /resource "auth0_trigger_action" "sign_in_time" \{\n\s+trigger\s*= "post-login"\n\s+action_id\s*= auth0_action\.sign_in_time\.id\n\}/, 'resource "auth0_trigger_actions" "sign_in_time" {\n  trigger = "post-login"\n  actions {\n    id           = auth0_action.sign_in_time.id\n    display_name = "x"\n  }\n}', ONE_ACTION],
    ["an Action with a secret", "main.tf", /(\n  supported_triggers \{)/, '\n  secrets {\n    name  = "KEY"\n    value = "abc"\n  }\n$1', ONE_ACTION],
    ["an Action on another trigger", "main.tf", /(supported_triggers \{\n\s+id\s*= )"post-login"/, '$1"credentials-exchange"', ONE_ACTION],
    ["Action code written elsewhere", "main.tf", 'code    = file("${path.module}/sign-in-time.js")', 'code    = "exports.onExecutePostLogin = async () => {};"', ONE_ACTION],
    ["a second Action", "main.tf", 'resource "auth0_action" "sign_in_time" {', 'resource "auth0_action" "other" {\n  name = "other"\n  code = "x"\n}\n\nresource "auth0_action" "sign_in_time" {', ONE_ACTION],
    ["another claim name in Terraform", "main.tf", `auth_time_claim  = "${AUTH_TIME_CLAIM}"`, 'auth_time_claim  = "https://example.com/auth_time"', `local.auth_time_claim must be ${AUTH_TIME_CLAIM}, the services' default AUTH_TIME_CLAIM`],
    ["an Action that also writes the ID token", ACTION_FILE, /(\n\s+api\.accessToken\.setCustomClaim\(CLAIM, [^\n]+)/, "$1\n    api.idToken.setCustomClaim(CLAIM, 1);", ONE_CLAIM],
    ["an Action that writes a second claim", ACTION_FILE, /(\n\s+api\.accessToken\.setCustomClaim\(CLAIM, [^\n]+)/, '$1\n    api.accessToken.setCustomClaim("https://x402.dev/roles", []);', ONE_CLAIM],
    ["an Action that writes a claim without a namespace", ACTION_FILE, `"${AUTH_TIME_CLAIM}"`, '"auth_time"', ONE_CLAIM],
    ["an Action that refuses sign-ins", ACTION_FILE, /(\n\s+api\.accessToken\.setCustomClaim\(CLAIM, [^\n]+)/, '$1\n    api.access.deny("no");', ONE_CLAIM],
    // 014: the administrator's permission and role, and nothing beside them.
    ["014: another name for the administrator's permission", "main.tf", `admin_permission  = "${ADMIN_PERMISSION}"`, 'admin_permission  = "portal:owner"', TWO_ROLES],
    ["014: a permission to use the portal, back again", "main.tf", `  admin_permission  = "${ADMIN_PERMISSION}"\n`, `  admin_permission  = "${ADMIN_PERMISSION}"\n  permission        = "portal:use"\n`, TWO_ROLES],
    ["014: no administrator's permission on the API", "main.tf", /resource "auth0_resource_server_scopes" "identity" \{[\s\S]*?\n\}\n\n/, "", TWO_ROLES],
    ["014: the administrator's role under another name", "main.tf", `"${ADMIN_ROLE}"`, '"x402-user"', TWO_ROLES],
    ["014: no administrator's role", "main.tf", /resource "auth0_role" "admin" \{[\s\S]*?\n\}\n\n/, "", TWO_ROLES],
    ["014: an administrator's role with a second permission", "main.tf", /(resource "auth0_role_permissions" "admin" \{[\s\S]*?\n  permissions \{\n[^}]*\})/, '$1\n\n  permissions {\n    name                       = "read:users"\n    resource_server_identifier = "https://x402-dev.us.auth0.com/api/v2/"\n  }', TWO_ROLES],
    ["014: an administrator's role holding a permission of the approval API", "main.tf", /(resource "auth0_role_permissions" "admin" \{[\s\S]*?resource_server_identifier\s*= )auth0_resource_server\.identity\.identifier/, "$1auth0_resource_server.payments.identifier", TWO_ROLES],
    ["014: the administrator's role assigned to a person", "main.tf", 'resource "auth0_role_permissions" "admin" {', 'resource "auth0_user_roles" "someone" {\n  user_id = "auth0|someone"\n  roles   = [auth0_role.admin.id]\n}\n\nresource "auth0_role_permissions" "admin" {', NOBODY_ASSIGNED],
    ["a role assigned to a person", "main.tf", 'resource "auth0_client" "portal" {', 'resource "auth0_user_roles" "someone" {\n  user_id = "auth0|someone"\n  roles   = ["rol_x"]\n}\n\nresource "auth0_client" "portal" {', NOBODY_ASSIGNED],
    ["a connection with a password in code", "main.tf", 'resource "auth0_client" "portal" {', 'resource "auth0_connection" "db" {\n  name     = "db"\n  strategy = "auth0"\n  options {\n    password = "x"\n  }\n}\n\nresource "auth0_client" "portal" {', "users and passwords are never managed here"],
    ["a client in the identity object", "outputs.tf", /(output "bicepparam_identity" \{[\s\S]*?audience\s*= auth0_resource_server\.identity\.identifier)/, "$1\n    agentClientIds = [auth0_client.portal.client_id]", IDENTITY_OUTPUT],
    ["an identity output for the approval API", "outputs.tf", /(output "bicepparam_identity" \{[\s\S]*?audience\s*= )auth0_resource_server\.identity\.identifier/, "$1auth0_resource_server.payments.identifier", IDENTITY_OUTPUT],
    ["an identity output missing the audience", "outputs.tf", /(output "bicepparam_identity" \{[\s\S]*?)\n\s+audience\s*= auth0_resource_server\.identity\.identifier/, "$1", "output bicepparam_identity must have exactly the identity keys of the parameter file (audience, issuer), got issuer"],
    ["L2's client as the portal's client ID", "outputs.tf", /(output "bicepparam_portal_client_id" \{[\s\S]*?value\s*= )auth0_client\.portal\.client_id/, "$1auth0_client.l2.client_id", "output bicepparam_portal_client_id must be the portal client's ID (userAccounts.portalClientId)"],
  ])("013 must fail: %s is reported", (_label, file, from, to, message) => {
    expect(auth0Problems(mutate(load(), file, from, to))).toContain(message);
  });

  // 016: the hosted agent's callers. One mutant, at least, for each rule of contracts/tenant-and-config.md "The tenant".
  const AGENT_PUBLIC = "the agent's client must be a public spa client: authentication_method none, no secret and no key";
  const AGENT_GRANT = "the agent's client must have only its own grant (authorization_code)";
  const AGENT_KEYS = "output bicepparam_agent must have exactly the agent keys of the parameter file but apiDocs (clientId, desktopClientId, machineClientId, machineKeyId), got clientId, desktopClientId, machineClientId";
  const GRANT_FOR_PAYMENTS = 'resource "auth0_client_grant" "machine_payments" {\n  for_each = var.machine_caller_keys\n\n  client_id = auth0_client.machine[each.key].client_id\n  audience  = auth0_resource_server.payments.identifier\n  scopes    = []\n}\n\n';
  it.each<[string, string, string | RegExp, string, string]>([
    // The applications (FR-026).
    ["another kind of application", "main.tf", 'resource "auth0_client" "portal" {', 'resource "auth0_client" "cli" {\n  name     = "agent-cli"\n  app_type = "native"\n}\n\nresource "auth0_client" "portal" {', FIVE_KINDS],
    ["credentials for an application that isn't one of the five", "main.tf", 'resource "auth0_client_credentials" "portal" {', 'resource "auth0_client_credentials" "cli" {\n  client_id             = "abc"\n  authentication_method = "none"\n}\n\nresource "auth0_client_credentials" "portal" {', FIVE_KINDS],
    ["no client for the agent's callers", "main.tf", /resource "auth0_client" "agent" \{[\s\S]*?\n\}\n\n/, "", FIVE_KINDS],
    ["no client for the machine callers", "main.tf", /resource "auth0_client" "machine" \{[\s\S]*?\n\}\n\n/, "", FIVE_KINDS],
    // The permissions and the roles (FR-025).
    ["a third permission on the API", "main.tf", /(\n  scopes \{\n[^}]*local\.agent_permission[^}]*\})/, '$1\n\n  scopes {\n    name = "portal:owner"\n  }', TWO_ROLES],
    ["no permission to start a run", "main.tf", /\n  scopes \{\n[^}]*local\.agent_permission[^}]*\}\n/, "", TWO_ROLES],
    ["another name for the permission to start a run", "main.tf", `agent_permission = "${AGENT_RUN_PERMISSION}"`, 'agent_permission = "agent:use"', AGENT_PERMISSION],
    ["the agent role under another name", "main.tf", `"${AGENT_ROLE}"`, '"x402-user"', TWO_ROLES],
    ["no agent role", "main.tf", /resource "auth0_role" "agent" \{[\s\S]*?\n\}\n\n/, "", TWO_ROLES],
    ["an agent role that holds the administrator's permission", "main.tf", /(resource "auth0_role_permissions" "agent" \{[\s\S]*?name\s*= )local\.agent_permission/, "$1local.admin_permission", TWO_ROLES],
    ["an agent role with a second permission", "main.tf", /(resource "auth0_role_permissions" "agent" \{[\s\S]*?\n  permissions \{\n[^}]*\})/, "$1\n\n  permissions {\n    name                       = local.admin_permission\n    resource_server_identifier = auth0_resource_server.identity.identifier\n  }", TWO_ROLES],
    ["an administrator's role that also starts runs", "main.tf", /(resource "auth0_role_permissions" "admin" \{[\s\S]*?\n  permissions \{\n[^}]*\})/, "$1\n\n  permissions {\n    name                       = local.agent_permission\n    resource_server_identifier = auth0_resource_server.identity.identifier\n  }", TWO_ROLES],
    ["the agent role assigned to a person", "main.tf", 'resource "auth0_role_permissions" "agent" {', 'resource "auth0_user_roles" "someone" {\n  user_id = "auth0|someone"\n  roles   = [auth0_role.agent.id]\n}\n\nresource "auth0_role_permissions" "agent" {', NOBODY_ASSIGNED],
    ["the agent role assigned to a person, one role at a time", "main.tf", 'resource "auth0_role_permissions" "agent" {', 'resource "auth0_user_role" "someone" {\n  user_id = "auth0|someone"\n  role_id = auth0_role.agent.id\n}\n\nresource "auth0_role_permissions" "agent" {', NOBODY_ASSIGNED],
    ["a role's people listed in code", "main.tf", 'resource "auth0_role_permissions" "agent" {', 'resource "auth0_role_users" "agent" {\n  role_id = auth0_role.agent.id\n  users   = ["auth0|someone"]\n}\n\nresource "auth0_role_permissions" "agent" {', NOBODY_ASSIGNED],
    ["a permission given to a person directly", "main.tf", 'resource "auth0_role_permissions" "agent" {', 'resource "auth0_user_permission" "someone" {\n  user_id                    = "auth0|someone"\n  permission                 = "agent:run"\n  resource_server_identifier = auth0_resource_server.identity.identifier\n}\n\nresource "auth0_role_permissions" "agent" {', NOBODY_ASSIGNED],
    // The agent's client (FR-024).
    ["an agent client with a secret", "main.tf", /(resource "auth0_client_credentials" "agent" \{[\s\S]*?authentication_method\s*=\s*)"none"/, '$1"client_secret_post"', AGENT_PUBLIC],
    ["an agent client with a key", "main.tf", /(resource "auth0_client_credentials" "agent" \{[\s\S]*?authentication_method\s*=\s*)"none"/, '$1"private_key_jwt"', AGENT_PUBLIC],
    ["a confidential agent client", "main.tf", /(resource "auth0_client" "agent" \{[\s\S]*?app_type\s*=\s*)"spa"/, '$1"regular_web"', AGENT_PUBLIC],
    ["an agent client with the refresh-token grant", "main.tf", '["authorization_code"]', '["authorization_code", "refresh_token"]', AGENT_GRANT],
    ["an agent client with the implicit grant", "main.tf", '["authorization_code"]', '["authorization_code", "implicit"]', AGENT_GRANT],
    ["an agent client with the device grant", "main.tf", '["authorization_code"]', `["authorization_code", "${DEVICE_GRANT}"]`, AGENT_GRANT],
    ["an agent client with refresh tokens set up", "main.tf", /(resource "auth0_client" "agent" \{[\s\S]*?)(\n  jwt_configuration \{)/, '$1\n  refresh_token {\n    rotation_type   = "rotating"\n    expiration_type = "expiring"\n  }\n$2', AGENT_NO_REFRESH],
    ["a callback outside the docs page", "main.tf", `"\${origin}${DOCS_REDIRECT}"`, '"${origin}/callback"', AGENT_URLS],
    ["a callback to the whole origin", "main.tf", /callbacks(\s*)= local\.agent_callbacks/, "callbacks$1= local.agent_origins", AGENT_URLS],
    ["a callback written in the agent's client", "main.tf", /callbacks(\s*)= local\.agent_callbacks/, `callbacks$1= ["https://agent.example${DOCS_REDIRECT}"]`, AGENT_URLS],
    ["a second callback under each origin", "main.tf", `[for origin in local.agent_origins : "\${origin}${DOCS_REDIRECT}"]`, `flatten([for origin in local.agent_origins : ["\${origin}${DOCS_REDIRECT}", "\${origin}/callback"]])`, AGENT_URLS],
    ["another local origin for the docs page", "main.tf", `"${LOCAL_AGENT[1]}"`, '"http://localhost:3000"', AGENT_URLS],
    ["a third origin written for the docs page", "main.tf", `"${LOCAL_AGENT[1]}"]`, `"${LOCAL_AGENT[1]}", "https://agent.example"]`, AGENT_URLS],
    ["the portal's origins on the agent's client", "main.tf", /(\n  web_origins\s*= )local\.agent_origins/, "$1local.portal_origins", AGENT_URLS],
    ["a logout URL on the agent's client", "main.tf", /(\n  web_origins\s*= local\.agent_origins)/, "$1\n  allowed_logout_urls = local.agent_origins", AGENT_URLS],
    ["a wildcard agent origin", "variables.tf", 'can(regex("^https://[a-z0-9][a-z0-9.-]*$", var.agent_origin))', 'startswith(var.agent_origin, "https://")', ORIGIN("agent_origin")],
    ["SPEC 1.26: an agent origin with a port", "variables.tf", '"^https://[a-z0-9][a-z0-9.-]*$", var.agent_origin', '"^https://[a-z0-9][a-z0-9.-]*(:[0-9]+)?$", var.agent_origin', ORIGIN("agent_origin")],
    ["SPEC 1.26: an agent origin with a trailing slash", "variables.tf", '"^https://[a-z0-9][a-z0-9.-]*$", var.agent_origin', '"^https://[a-z0-9][a-z0-9.-]*/?$", var.agent_origin', ORIGIN("agent_origin")],
    ["SPEC 1.26: an agent origin that may be any text", "variables.tf", '"^https://[a-z0-9][a-z0-9.-]*$", var.agent_origin', '"^https://.+$", var.agent_origin', ORIGIN("agent_origin")],
    // A machine caller's client (FR-021, FR-022).
    ["a machine client that can sign a person in", "main.tf", '["client_credentials"]', '["client_credentials", "authorization_code"]', MACHINE],
    ["a machine client with refresh tokens", "main.tf", '["client_credentials"]', '["client_credentials", "refresh_token"]', MACHINE],
    ["a machine client that isn't a machine's", "main.tf", '"non_interactive"', '"regular_web"', MACHINE],
    ["a machine client with a callback", "main.tf", /(resource "auth0_client" "machine" \{[\s\S]*?)(\n  jwt_configuration \{)/, '$1\n  callbacks = ["https://example.com/callback"]\n$2', MACHINE],
    ["a machine client outside the declared callers", "main.tf", /(resource "auth0_client" "machine" \{\n) {2}for_each = var\.machine_caller_keys\n/, "$1", MACHINE],
    ["a machine client with a secret", "main.tf", /(resource "auth0_client_credentials" "machine" \{[\s\S]*?authentication_method\s*=\s*)"private_key_jwt"/, '$1"client_secret_post"', MACHINE],
    ["a machine client with a secret beside its key", "main.tf", /(resource "auth0_client_credentials" "machine" \{[\s\S]*?authentication_method\s*=\s*"private_key_jwt"\n)/, '$1  client_secret_wo      = "abc"\n', MACHINE],
    ["a machine client with an ES256 key", "main.tf", /(resource "auth0_client_credentials" "machine" \{[\s\S]*?algorithm\s*=\s*)"RS256"/, '$1"ES256"', MACHINE],
    ["a machine client with a second key", "main.tf", /(resource "auth0_client_credentials" "machine" \{[\s\S]*?\n    credentials \{\n[^}]*\})/, '$1\n\n    credentials {\n      credential_type = "public_key"\n      pem             = var.client_public_key_pem\n      algorithm       = "RS256"\n    }', MACHINE],
    ["a machine client with L2's key", "main.tf", /(resource "auth0_client_credentials" "machine" \{[\s\S]*?pem\s*=\s*)each\.value/, "$1var.client_public_key_pem", MACHINE],
    ["a machine client with the administrator's permission", "main.tf", "[local.agent_permission]", "[local.agent_permission, local.admin_permission]", MACHINE],
    ["a machine client with the administrator's permission only", "main.tf", "[local.agent_permission]", "[local.admin_permission]", MACHINE],
    ["a machine client with no permission", "main.tf", "[local.agent_permission]", "[]", MACHINE],
    ["a machine client with a second grant", "main.tf", 'resource "auth0_client_grant" "machine" {', `${GRANT_FOR_PAYMENTS}resource "auth0_client_grant" "machine" {`, MACHINE],
    ["a machine client granted the approval API", "main.tf", /(resource "auth0_client_grant" "machine" \{[\s\S]*?audience\s*= )auth0_resource_server\.identity\.identifier/, "$1auth0_resource_server.payments.identifier", MACHINE],
    ["a machine client that may request payment details", "main.tf", /(resource "auth0_client_grant" "machine" \{[\s\S]*?\n  scopes\s*= [^\n]+)/, "$1\n  authorization_details_types = [local.details_type]", MACHINE],
    ["a machine client without a grant", "main.tf", /resource "auth0_client_grant" "machine" \{[\s\S]*?\n\}\n/, "", MACHINE],
    ["a machine caller's key that may be a private one", "variables.tf", ' && !strcontains(pem, "PRIVATE KEY")])', "])", CALLER_KEYS],
    ["a machine caller declared by default", "variables.tf", /(variable "machine_caller_keys" \{[\s\S]*?default\s*= )\{\}/, '$1{ checks = "x" }', CALLER_KEYS],
    // The outputs.
    ["an agent output missing the key's ID", "outputs.tf", /\n\s+machineKeyId\s*= [^\n]+/, "", AGENT_KEYS],
    ["the portal's client as the agent's", "outputs.tf", /(\n\s+clientId\s*= )auth0_client\.agent\.client_id/, "$1auth0_client.portal.client_id", AGENT_OUTPUT],
    ["another machine caller as the pipeline's", "outputs.tf", `auth0_client.machine["${PIPELINE_CALLER}"].client_id`, 'auth0_client.machine["other"].client_id', AGENT_OUTPUT],
    ["the agent's client as the machine caller", "outputs.tf", /(machineClientId\s*= )try\(auth0_client\.machine\["checks"\]\.client_id, ""\)/, "$1auth0_client.agent.client_id", AGENT_OUTPUT],
    ["L2's key ID as the machine caller's", "outputs.tf", /(machineKeyId\s*= try\(one\()auth0_client_credentials\.machine\["checks"\]/, "$1auth0_client_credentials.l2", AGENT_OUTPUT],
    ["the portal's client on the agent's list", "outputs.tf", /(output "l1_env" \{[\s\S]*?AGENT_CLIENT_IDS=\$\{auth0_client\.agent\.client_id\})/, "$1,${auth0_client.portal.client_id}", ENV_OUTPUTS],
    ["a machine caller's client on the agent's list", "outputs.tf", /(output "l1_env" \{[\s\S]*?AGENT_CLIENT_IDS=\$\{auth0_client\.agent\.client_id\})/, '$1,${auth0_client.machine["checks"].client_id}', ENV_OUTPUTS],
    ["a docs page that signs in through the portal's client", "outputs.tf", "API_DOCS_CLIENT_ID=${auth0_client.agent.client_id}", "API_DOCS_CLIENT_ID=${auth0_client.portal.client_id}", ENV_OUTPUTS],
    ["L2 given another client list than the agent", "outputs.tf", /(output "l2_env" \{[\s\S]*?AGENT_CLIENT_IDS=\$\{)auth0_client\.agent\.client_id/, "$1auth0_client.portal.client_id", ENV_OUTPUTS],
    ["L2 given the approval API as the callers' audience", "outputs.tf", /(output "l2_env" \{[\s\S]*?AUTH_AUDIENCE=\$\{)auth0_resource_server\.identity\.identifier/, "$1auth0_resource_server.payments.identifier", ENV_OUTPUTS],
    ["L2 without the callers' sign-in", "outputs.tf", /(output "l2_env" \{[\s\S]*?)\n\s+"AGENT_CLIENT_IDS=[^\n]+/, "$1", ENV_OUTPUTS],
  ])("016 must fail: %s is reported", (_label, file, from, to, message) => {
    expect(auth0Problems(mutate(load(), file, from, to))).toContain(message);
  });

  // Phase 3 (SPEC 1.19): the localhost origins (finding #11), the administrators' second factor (#6) and closed
  // sign-ups (#12). One mutant, at least, for each check.
  it.each<[string, string, string | RegExp, string, string]>([
    ["the local portal in every environment", "main.tf", `concat(var.local_origins ? ["${LOCAL_PORTAL}"] : [], `, `concat(["${LOCAL_PORTAL}"], `, LOCAL_ORIGINS],
    ["the local agent in every environment", "main.tf", `concat(var.local_origins ? ["${LOCAL_AGENT[0]}", "${LOCAL_AGENT[1]}"] : [], `, `concat(["${LOCAL_AGENT[0]}", "${LOCAL_AGENT[1]}"], `, LOCAL_ORIGINS],
    ["the local origins on by default", "variables.tf", /(variable "local_origins" \{[\s\S]*?default\s*= )false/, "$1true", LOCAL_ORIGINS],
    ["one-time codes off in Guardian", "main.tf", "  otp    = true\n", "", MFA_SETTINGS],
    ["push off in Guardian", "main.tf", /(push \{\n\s+enabled\s*= )true/, "$1false", MFA_SETTINGS],
    ["no tenant setting for an Action's choice of factor", "main.tf", /resource "auth0_tenant" "mfa_actions" \{[\s\S]*?\n\}\n/, "", MFA_SETTINGS],
    ["the tenant setting off", "main.tf", "customize_mfa_in_postlogin_action = true", "customize_mfa_in_postlogin_action = false", MFA_SETTINGS],
    ["the tenant setting managed beside another configuration's Guardian", "main.tf", /(resource "auth0_tenant" "mfa_actions" \{\n\s+count\s*= )var\.manage_guardian \? 1 : 0/, "$11", MFA_SETTINGS],
    ["another tenant setting changed with it", "main.tf", /(\n\s+customize_mfa_in_postlogin_action = true)/, '$1\n  session_lifetime                  = 720', MFA_SETTINGS],
    ["the second-factor time bound in any order", "main.tf", "\n\n  depends_on = [auth0_trigger_action.sign_in_time]", "", ONE_ACTION_ORDER],
    ["no second-factor time Action", "main.tf", /resource "auth0_action" "mfa_time" \{[\s\S]*?\n\}\n/, "", ONE_ACTION],
    ["the second-factor time Action's code written elsewhere", "main.tf", 'code    = file("${path.module}/mfa-time.js")', 'code    = "exports.onExecutePostLogin = async () => {};"', ONE_ACTION],
    ["the second-factor time Action never bound", "main.tf", /resource "auth0_trigger_action" "mfa_time" \{[\s\S]*?\n\}\n/, "", ONE_ACTION],
    ["another claim name for the second factor", "main.tf", `mfa_time_claim = "${MFA_TIME_CLAIM}"`, 'mfa_time_claim = "https://x402.dev/amr_time"', `local.mfa_time_claim must be ${MFA_TIME_CLAIM}, the services' DEFAULT_MFA_TIME_CLAIM, and mfa-time.js must write it`],
    ["sign-ups closed by default", "variables.tf", /(variable "allow_sign_ups" \{[\s\S]*?default\s*= )true/, "$1false", SIGN_UPS],
    ["sign-ups an option, not a bool", "variables.tf", /(variable "allow_sign_ups" \{[\s\S]*?type\s*= )bool/, "$1string", SIGN_UPS],
    ["a challenge of another role", ACTION_FILE, `const ADMIN_ROLE = "${ADMIN_ROLE}";`, 'const ADMIN_ROLE = "x402-agent";', ADMIN_ROLE_IN_ACTION],
    ["a challenge that also denies", ACTION_FILE, "    api.authentication.challengeWithAny(SECOND_FACTORS);", '    api.authentication.challengeWithAny(SECOND_FACTORS);\n    api.access.deny("mfa");', ONE_CLAIM],
    ["a challenge by text message", ACTION_FILE, '{ type: "otp" }', '{ type: "phone" }', ONE_CLAIM],
    ["the second-factor time on the ID token too", MFA_ACTION_FILE, /(\n\s+api\.accessToken\.setCustomClaim\(CLAIM, [^\n]+)/, "$1\n    api.idToken.setCustomClaim(CLAIM, 1);", ONE_MFA_CLAIM],
    ["the second-factor time under another name", MFA_ACTION_FILE, `"${MFA_TIME_CLAIM}"`, '"mfa_time"', ONE_MFA_CLAIM],
  ])("Phase 3 must fail: %s is reported", (_label, file, from, to, message) => {
    expect(auth0Problems(mutate(load(), file, from, to))).toContain(message);
  });

  // 018: people's connections. One mutant, at least, for each rule of contracts/tenant-connections.md.
  it.each<[string, string, string | RegExp, string, string]>([
    // Rule 8 and rule 5's variables.
    ["a Google client ID that may be any text", "variables.tf", /can\(regex\("\^\[0-9\]\+-[^"]+", var\.google_client_id\)\)/, "length(var.google_client_id) > 0", GOOGLE_CLIENT_ID],
    ["a Google client ID pattern with any character for its last dot", "variables.tf", /googleusercontent\\\\\.com/, "googleusercontent.com", GOOGLE_CLIENT_ID],
    ["a Google client ID set by default", "variables.tf", /(variable "google_client_id" \{[\s\S]*?default\s*= )""/, '$1"1-a.apps.googleusercontent.com"', GOOGLE_CLIENT_ID],
    ["a Google client ID that may be a number", "variables.tf", /(variable "google_client_id" \{[\s\S]*?type\s*= )string/, "$1number", GOOGLE_CLIENT_ID],
    ["Google sign-in off by default", "variables.tf", /(variable "google_sign_in" \{[\s\S]*?default\s*= )true/, "$1false", GOOGLE_SIGN_IN],
    ["Google sign-in as text", "variables.tf", /(variable "google_sign_in" \{[\s\S]*?type\s*= )bool/, "$1string", GOOGLE_SIGN_IN],
    // Rule 5: Google, read only.
    ["the Google secret kept in the state", "main.tf", /(hide_client_secret\s*= )true/, "$1false", GOOGLE_READ_ONLY],
    ["no word on the Google secret", "main.tf", /\n\s*hide_client_secret\s*= true/, "", GOOGLE_READ_ONLY],
    ["Google's clients read as well", "main.tf", /\n\s*skip_enabled_clients\s*= true/, "", GOOGLE_READ_ONLY],
    ["another connection read for Google", "main.tf", /(data "auth0_connection" "google" \{\n\s*name\s*= )"google-oauth2"/, '$1"github"', GOOGLE_READ_ONLY],
    ["a second connection read", "main.tf", 'data "auth0_connection" "google" {', 'data "auth0_connection" "github" {\n  name = "github"\n}\n\ndata "auth0_connection" "google" {', GOOGLE_READ_ONLY],
    ["a client secret on the Google read", "main.tf", /(data "auth0_connection" "google" \{\n)/, '$1  client_secret = "x"\n', NO_CONNECTION_SECRET],
    // Rules 3 and 4: the email-and-password connection and its switch.
    ["sign-up closed whatever the switch", "main.tf", /disable_signup(\s*)= !var\.allow_sign_ups/, "disable_signup$1= true", DISABLE_SIGNUP],
    ["sign-up open while the switch is closed", "main.tf", /disable_signup(\s*)= !var\.allow_sign_ups/, "disable_signup$1= var.allow_sign_ups", DISABLE_SIGNUP],
    ["no word on sign-up, so the tenant's setting stays as it is", "main.tf", /\n\s*disable_signup\s*= !var\.allow_sign_ups/, "", DISABLE_SIGNUP],
    ["a database connection that can be destroyed", "main.tf", /(resource "auth0_connection" "database" \{[\s\S]*?prevent_destroy\s*= )true/, "$1false", DATABASE],
    ["a database connection with login scripts", "main.tf", /(resource "auth0_connection" "database" \{[\s\S]*?\n {2}options \{\n)/, '$1    custom_scripts = { login = "function login(email, password, callback) { callback(null) }" }\n', DATABASE],
    ["a database connection with settings for its scripts", "main.tf", /(resource "auth0_connection" "database" \{[\s\S]*?\n {2}options \{\n)/, '$1    configuration = { DB_URL = "x" }\n', DATABASE],
    ["a passwordless connection in its place", "main.tf", /(resource "auth0_connection" "database" \{[\s\S]*?strategy\s*= )"auth0"/, '$1"email"', DATABASE],
    ["another database connection", "main.tf", /(resource "auth0_connection" "database" \{\n\s*name\s*= )"Username-Password-Authentication"/, '$1"x402-people"', DATABASE],
    ["the legacy password strength beside the flexible policy", "main.tf", /(\n\s*)password_options \{/, '$1password_policy = "good"$1password_options {', PASSWORD_OPTIONS],
    ["a legacy minimum length beside the flexible policy", "main.tf", /(\n\s*)password_options \{/, "$1password_complexity_options {$1  min_length = 8$1}$1password_options {", PASSWORD_OPTIONS],
    ["a legacy password history beside the flexible policy", "main.tf", /(\n\s*)password_options \{/, "$1password_history {$1  enable = false$1  size   = 5$1}$1password_options {", PASSWORD_OPTIONS],
    ["a legacy dictionary beside the flexible policy", "main.tf", /(\n\s*)password_options \{/, "$1password_dictionary {$1  enable = false$1}$1password_options {", PASSWORD_OPTIONS],
    ["a legacy personal-data check beside the flexible policy", "main.tf", /(\n\s*)password_options \{/, "$1password_no_personal_info {$1  enable = false$1}$1password_options {", PASSWORD_OPTIONS],
    ["no word on the password policy, so an update could reset it", "main.tf", /\bpassword_options \{/, "unused_password_options {", PASSWORD_OPTIONS],
    ["a password policy without its complexity rules", "main.tf", /(password_options \{\s*)complexity \{/, "$1unused_complexity {", PASSWORD_OPTIONS],
    ["a password policy without its history rules", "main.tf", /(password_options \{[\s\S]*?)\bhistory \{/, "$1unused_history {", PASSWORD_OPTIONS],
    // Rules 1 and 2: which connections, and which clients may use them.
    ["a passwordless connection beside the two", "main.tf", 'data "auth0_connection" "google" {', 'resource "auth0_connection" "email" {\n  name     = "email"\n  strategy = "email"\n}\n\ndata "auth0_connection" "google" {', CONNECTIONS],
    ["one client enabled on its own, beside the authoritative list", "main.tf", 'data "auth0_connection" "google" {', 'resource "auth0_connection_client" "l2" {\n  connection_id = auth0_connection.database.id\n  client_id     = auth0_client.l2.client_id\n}\n\ndata "auth0_connection" "google" {', CONNECTIONS],
    ["Google's connection managed, with its secret in the state", "main.tf", 'data "auth0_connection" "google" {', 'resource "auth0_connection" "google" {', CONNECTIONS],
    ["no list for Google, so clients enabled by hand stay", "main.tf", /resource "auth0_connection_clients" "google" \{[\s\S]*?\n\}\n/, "", CONNECTIONS],
    ["L2's approval client on the database connection", "main.tf", /(resource "auth0_connection_clients" "database" \{[\s\S]*?enabled_clients\s*= )\[auth0_client\.portal\.client_id, auth0_client\.agent\.client_id, auth0_client\.desktop\.client_id\]/, "$1[auth0_client.portal.client_id, auth0_client.agent.client_id, auth0_client.desktop.client_id, auth0_client.l2.client_id]", CONNECTION_CLIENTS],
    ["the machine callers on Google", "main.tf", /(resource "auth0_connection_clients" "google" \{[\s\S]*?enabled_clients\s*= var\.google_sign_in \? )\[auth0_client\.portal\.client_id, auth0_client\.agent\.client_id, auth0_client\.desktop\.client_id\]/, "$1concat([auth0_client.portal.client_id, auth0_client.agent.client_id, auth0_client.desktop.client_id], values(auth0_client.machine)[*].client_id)", CONNECTION_CLIENTS],
    ["Google on whatever the emergency stop", "main.tf", /(enabled_clients\s*= )var\.google_sign_in \? (\[[^\]]+\]) : \[\]/, "$1$2", CONNECTION_CLIENTS],
    ["the agent left off the database connection", "main.tf", /(resource "auth0_connection_clients" "database" \{[\s\S]*?enabled_clients\s*= )\[auth0_client\.portal\.client_id, auth0_client\.agent\.client_id, auth0_client\.desktop\.client_id\]/, "$1[auth0_client.portal.client_id, auth0_client.desktop.client_id]", CONNECTION_CLIENTS],
    ["the database list on another connection", "main.tf", /(resource "auth0_connection_clients" "database" \{[\s\S]*?connection_id\s*= )auth0_connection\.database\.id/, "$1data.auth0_connection.google.id", CONNECTION_CLIENTS],
    // Rule 5: the project's own Google application, or the plan stops.
    ["no check of Google's application", "main.tf", /(resource "auth0_connection_clients" "google" \{[\s\S]*?: \[\]\n)\n {2}lifecycle \{\n {4}precondition \{[\s\S]*?\n {4}\}\n {2}\}\n/, "$1", GOOGLE_APP],
    ["a check that always passes", "main.tf", 'try(data.auth0_connection.google.options[0].client_id, "") == var.google_client_id)', 'try(data.auth0_connection.google.options[0].client_id, "") == var.google_client_id) || true', GOOGLE_APP],
    ["Auth0's developer keys let through", "main.tf", 'var.google_client_id != "" && ', "", GOOGLE_APP],
    ["any Google application but the declared one", "main.tf", 'try(data.auth0_connection.google.options[0].client_id, "") == var.google_client_id', 'try(data.auth0_connection.google.options[0].client_id, "") != ""', GOOGLE_APP],
    ["a check only while Google is off", "main.tf", /(condition\s*= )!var\.google_sign_in \|\|/, "$1var.google_sign_in ||", GOOGLE_APP],
    ["a message that names nothing to fix", "main.tf", /(resource "auth0_connection_clients" "google" \{[\s\S]*?error_message\s*= ")[^"]*"/, '$1The Google connection is not ready."', GOOGLE_APP],
    // Rule 6 (step B): no sign-up Action comes back, bound or replacing the flow, and the switch stays the connection's.
    ["the deny Action and its binding put back", "main.tf", /$/, `\nresource "auth0_action" "deny_sign_up" {\n  count = var.allow_sign_ups ? 0 : 1\n\n  name    = "x402-deny-sign-up-dev"\n  runtime = "node22"\n  deploy  = true\n  code    = "exports.onExecutePreUserRegistration = async (event, api) => { api.access.deny('sign_up_closed', 'x'); };"\n\n  supported_triggers {\n    id      = "pre-user-registration"\n    version = "v2"\n  }\n}\n\nresource "auth0_trigger_action" "deny_sign_up" {\n  count = var.allow_sign_ups ? 0 : 1\n\n  trigger   = "pre-user-registration"\n  action_id = auth0_action.deny_sign_up[0].id\n}\n`, NO_SIGN_UP_ACTION],
    ["a sign-up Action that replaces the flow", "main.tf", /$/, `\nresource "auth0_trigger_actions" "sign_up" {\n  trigger = "pre-user-registration"\n  actions {\n    id           = auth0_action.sign_in_time.id\n    display_name = "x"\n  }\n}\n`, NO_SIGN_UP_ACTION],
    ["the post-login Action moved to pre-user-registration", "main.tf", /(resource "auth0_trigger_action" "sign_in_time" \{[\s\S]*?trigger\s*= )"post-login"/, '$1"pre-user-registration"', NO_SIGN_UP_ACTION],
  ])("018 must fail: %s is reported", (_label, file, from, to, message) => {
    expect(auth0Problems(mutate(load(), file, from, to))).toContain(message);
  });

  // 019: the desktop client. One mutant, at least, for each rule of specs/019 contracts/tenant-and-config.md.
  const DESKTOP_PUBLIC = "the desktop client must be a public native client: authentication_method none, no secret and no key";
  const DESKTOP_GRANT = "the desktop client must have only its own grant (authorization_code, refresh_token)";
  it.each<[string, string, string | RegExp, string, string]>([
    // The applications and the client's kind.
    ["no desktop client", "main.tf", /resource "auth0_client" "desktop" \{[\s\S]*?\n\}\n\n/, "", FIVE_KINDS],
    ["the desktop client without its own credentials", "main.tf", /resource "auth0_client_credentials" "desktop" \{[\s\S]*?\n\}\n/, "", FIVE_KINDS],
    ["a desktop client with a secret", "main.tf", /(resource "auth0_client_credentials" "desktop" \{[\s\S]*?authentication_method\s*=\s*)"none"/, '$1"client_secret_post"', DESKTOP_PUBLIC],
    ["a desktop client with a key", "main.tf", /(resource "auth0_client_credentials" "desktop" \{[\s\S]*?authentication_method\s*=\s*)"none"/, '$1"private_key_jwt"', DESKTOP_PUBLIC],
    ["a desktop client that is a web page's", "main.tf", /(resource "auth0_client" "desktop" \{[\s\S]*?app_type\s*=\s*)"native"/, '$1"spa"', DESKTOP_PUBLIC],
    // The grants.
    ["a third grant on the desktop client", "main.tf", /(resource "auth0_client" "desktop" \{[\s\S]*?grant_types\s*= )\["authorization_code", "refresh_token"\]/, '$1["authorization_code", "refresh_token", "implicit"]', DESKTOP_GRANT],
    ["the desktop client with client credentials", "main.tf", /(resource "auth0_client" "desktop" \{[\s\S]*?grant_types\s*= )\["authorization_code", "refresh_token"\]/, '$1["authorization_code", "refresh_token", "client_credentials"]', DESKTOP_GRANT],
    ["the desktop client with the device grant", "main.tf", /(resource "auth0_client" "desktop" \{[\s\S]*?grant_types\s*= )\["authorization_code", "refresh_token"\]/, `$1["authorization_code", "refresh_token", "${DEVICE_GRANT}"]`, DESKTOP_GRANT],
    // The loopback returns.
    ["a wildcard port", "main.tf", '"http://127.0.0.1:53682/callback"', '"http://127.0.0.1:*/callback"', DESKTOP_URLS],
    ["a third loopback callback", "main.tf", '"http://localhost:53682/callback"]', '"http://localhost:53682/callback", "http://127.0.0.1:53683/callback"]', DESKTOP_URLS],
    ["another path", "main.tf", '"http://127.0.0.1:53682/callback"', '"http://127.0.0.1:53682/other"', DESKTOP_URLS],
    ["the callbacks only where var.local_origins is on", "main.tf", /desktop_callbacks = (\[[^\]]+\])/, "desktop_callbacks = var.local_origins ? $1 : []", DESKTOP_URLS],
    ["a callback written in the desktop client", "main.tf", /callbacks(\s*)= local\.desktop_callbacks/, 'callbacks$1= ["http://127.0.0.1:53682/callback"]', DESKTOP_URLS],
    ["a web origin on the desktop client", "main.tf", /(\n  callbacks = local\.desktop_callbacks)/, "$1\n  web_origins = local.desktop_callbacks", DESKTOP_URLS],
    ["a logout URL on the desktop client", "main.tf", /(\n  callbacks = local\.desktop_callbacks)/, '$1\n  allowed_logout_urls = ["http://127.0.0.1:53682/"]', DESKTOP_URLS],
    ["a login URI on the desktop client", "main.tf", /(\n  callbacks = local\.desktop_callbacks)/, '$1\n  initiate_login_uri = "https://desktop.example/login"', DESKTOP_URLS],
    // The marker and the signature.
    ["no marker", "main.tf", /\n  client_metadata = \{\n    x402_client = "agent-desktop"\n  \}\n/, "\n", DESKTOP_METADATA],
    ["another marker", "main.tf", /(client_metadata = \{\n    x402_client = )"agent-desktop"/, '$1"agent-cli"', DESKTOP_METADATA],
    ["a second metadata key", "main.tf", '    x402_client = "agent-desktop"\n', '    x402_client = "agent-desktop"\n    team        = "x"\n', DESKTOP_METADATA],
    ["HS256 desktop tokens", "main.tf", /(resource "auth0_client" "desktop" \{[\s\S]*?alg = )"RS256"/, '$1"HS256"', DESKTOP_METADATA],
    // The refresh tokens.
    ["a reuse interval", "main.tf", /(resource "auth0_client" "desktop" \{[\s\S]*?leeway\s*= )0/, "$130", DESKTOP_REFRESH],
    ["desktop refresh tokens that never expire", "main.tf", /(resource "auth0_client" "desktop" \{[\s\S]*?\n    infinite_token_lifetime\s*= )false/, "$1true", DESKTOP_REFRESH],
    ["desktop refresh tokens that are never idle", "main.tf", /(resource "auth0_client" "desktop" \{[\s\S]*?infinite_idle_token_lifetime = )false/, "$1true", DESKTOP_REFRESH],
    ["desktop refresh tokens that don't rotate", "main.tf", /(resource "auth0_client" "desktop" \{[\s\S]*?rotation_type\s*= )"rotating"/, '$1"non-rotating"', DESKTOP_REFRESH],
    ["an idle lifetime longer than the whole", "main.tf", /(resource "auth0_client" "desktop" \{[\s\S]*?idle_token_lifetime\s*= )604800/, "$12592001", DESKTOP_REFRESH],
    ["a 90-day sign-in", "main.tf", /(resource "auth0_client" "desktop" \{[\s\S]*?\n    token_lifetime\s*= )2592000/, "$17776000", DESKTOP_REFRESH],
    // No default audience: the tenant setting sets nothing but its MFA setting (spec FR-004).
    ["a default audience for the tenant", "main.tf", /(\n\s+customize_mfa_in_postlogin_action = true)/, "$1\n  default_audience                  = local.identity_audience", MFA_SETTINGS],
    // The connections.
    ["the desktop client on a third connection", "main.tf", 'data "auth0_connection" "google" {', 'resource "auth0_connection_client" "desktop_email" {\n  connection_id = "con_email"\n  client_id     = auth0_client.desktop.client_id\n}\n\ndata "auth0_connection" "google" {', CONNECTIONS],
    ["the desktop client left off the database connection", "main.tf", /(resource "auth0_connection_clients" "database" \{[\s\S]*?enabled_clients\s*= )\[auth0_client\.portal\.client_id, auth0_client\.agent\.client_id, auth0_client\.desktop\.client_id\]/, "$1[auth0_client.portal.client_id, auth0_client.agent.client_id]", CONNECTION_CLIENTS],
    ["the desktop client left off Google", "main.tf", /(resource "auth0_connection_clients" "google" \{[\s\S]*?enabled_clients\s*= var\.google_sign_in \? )\[auth0_client\.portal\.client_id, auth0_client\.agent\.client_id, auth0_client\.desktop\.client_id\]/, "$1[auth0_client.portal.client_id, auth0_client.agent.client_id]", CONNECTION_CLIENTS],
    // The outputs: both services' lists, and the advertised client.
    ["L2's list without the desktop client", "outputs.tf", /(output "l2_env" \{[\s\S]*?AGENT_CLIENT_IDS=\$\{auth0_client\.agent\.client_id\}),\$\{auth0_client\.desktop\.client_id\}/, "$1", ENV_OUTPUTS],
    ["the agent's list without the desktop client", "outputs.tf", /(output "l1_env" \{[\s\S]*?AGENT_CLIENT_IDS=\$\{auth0_client\.agent\.client_id\}),\$\{auth0_client\.desktop\.client_id\}/, "$1", ENV_OUTPUTS],
    ["no advertised desktop client", "outputs.tf", /\n\s+"AGENT_DESKTOP_CLIENT_ID=[^\n]+/, "", ENV_OUTPUTS],
    ["the agent's own client advertised as the desktop client", "outputs.tf", "AGENT_DESKTOP_CLIENT_ID=${auth0_client.desktop.client_id}", "AGENT_DESKTOP_CLIENT_ID=${auth0_client.agent.client_id}", ENV_OUTPUTS],
    ["the portal's client as the desktop client in the agent object", "outputs.tf", "desktopClientId = auth0_client.desktop.client_id", "desktopClientId = auth0_client.portal.client_id", AGENT_OUTPUT],
    // The rule and the tenant agree on the role and the marker.
    ["a refusal by another role", ACTION_FILE, `const AGENT_ROLE = "${AGENT_ROLE}";`, `const AGENT_ROLE = "${ADMIN_ROLE}";`, DESKTOP_IN_ACTION],
    ["a refusal for another client's marker", ACTION_FILE, `const DESKTOP_CLIENT = "${DESKTOP_MARKER}";`, 'const DESKTOP_CLIENT = "agent-cli";', DESKTOP_IN_ACTION],
    ["a third refusal", ACTION_FILE, '      api.access.deny("pkce_required");\n', '      api.access.deny("pkce_required");\n      api.access.deny("again");\n', ONE_CLAIM],
  ])("019 must fail: %s is reported", (_label, file, from, to, message) => {
    expect(auth0Problems(mutate(load(), file, from, to))).toContain(message);
  });

  it("018 must fail: deny-sign-up.js put back in the folder is reported, and a comment naming the trigger is not", () => {
    const s = load();
    expect(auth0Problems(s)).not.toContain(NO_SIGN_UP_ACTION);
    const restored = { ...s, all: { ...s.all, [SIGN_UP_ACTION_FILE]: 'exports.onExecutePreUserRegistration = async (event, api) => {\n  api.access.deny("sign_up_closed", "Sign-ups are closed");\n};\n' } };
    expect(auth0Problems(restored)).toContain(NO_SIGN_UP_ACTION);
    const commented = mutate(s, "main.tf", /$/, "\n# Step B removed the pre-user-registration Action (specs/018).\n");
    expect(auth0Problems(commented)).not.toContain(NO_SIGN_UP_ACTION);
  });

  it("013: the Action, run against a stand-in for Auth0's api, sets the one claim to the most recent sign-in time and nothing else", async () => {
    const source = load().all[ACTION_FILE]!;
    expect(await actionProblems(source)).toEqual([]);
    expect(await runAction(source, signIn(FIRST, LAST))).toEqual([["accessToken.setCustomClaim", [AUTH_TIME_CLAIM, 1794305130]]]);
  });

  it("Phase 3: the Actions, run: an administrator's interactive sign-in without a fresh second factor is challenged, nobody else and nothing else is; the second factor's time is its own claim", async () => {
    const s = load();
    expect(await actionProblems(s.all[ACTION_FILE]!)).toEqual([]);
    expect(await runAction(s.all[ACTION_FILE]!, admin([method("pwd", FIRST)]))).toEqual([
      ["accessToken.setCustomClaim", [AUTH_TIME_CLAIM, 1794304800]],
      ["authentication.challengeWithAny", [[{ type: "push-notification" }, { type: "otp" }]]],
    ]);
    expect(await runAction(s.all[ACTION_FILE]!, admin([method("pwd", FIRST)], "oauth2-refresh-token"))).toEqual([["accessToken.setCustomClaim", [AUTH_TIME_CLAIM, 1794304800]]]);
    expect(await mfaActionProblems(s.all[MFA_ACTION_FILE]!)).toEqual([]);
    expect(await runAction(s.all[MFA_ACTION_FILE]!, signIn(FIRST, LAST))).toEqual([["accessToken.setCustomClaim", [MFA_TIME_CLAIM, 1794305130]]]);
  });

  it.each<[string, string | RegExp, string, RegExp]>([
    ["the current time when the sign-in time is unknown", /if \(latest > 0\) \{\n(\s+)api\.accessToken\.setCustomClaim\(CLAIM, [^\n]+/, "{\n$1api.accessToken.setCustomClaim(CLAIM, Math.floor((latest || Date.now()) / 1000));", /for an event without authentication details, must call \[\], not/],
    ["the first method's time, not the most recent", "at > latest", "latest === 0", /for a sign-in with two methods, must call/],
    ["milliseconds", "Math.floor(latest / 1000)", "latest", /for a sign-in with two methods, must call/],
    ["a second claim", /(\n\s+api\.accessToken\.setCustomClaim\(CLAIM, [^\n]+)/, '$1\n    api.idToken.setCustomClaim(CLAIM, 1);', /for a sign-in with two methods, must call/],
    ["an error when the event has no authentication details", "(event.authentication && event.authentication.methods) || []", "event.authentication.methods", /for an event without authentication details, must not throw/],
    ["a second handler", /$/, "\nexports.onContinuePostLogin = async () => {};\n", /must not throw[^:]*: the Action must export onExecutePostLogin only/],
  ])("013 must fail (the Action, run): %s is reported", async (_label, from, to, message) => {
    const source = load().all[ACTION_FILE]!;
    expect(typeof from === "string" ? source.includes(from) : from.test(source), "the Action contains the mutation anchor").toBe(true);
    const problems = await actionProblems(source.replace(from, to));
    expect(problems.some((m) => message.test(m)), problems.join("\n")).toBe(true);
  });

  const RUNS: Record<string, (source: string) => Promise<string[]>> = { [ACTION_FILE]: actionProblems, [MFA_ACTION_FILE]: mfaActionProblems };
  it.each<[string, string, string | RegExp, string, RegExp]>([
    ["a challenge on a refresh-token exchange", ACTION_FILE, "BROWSER_PROTOCOLS.includes(event.transaction && event.transaction.protocol)", "true", /for an administrator's token by oauth2-refresh-token, must call/],
    ["a challenge of everyone", ACTION_FILE, "Array.isArray(roles) && roles.includes(ADMIN_ROLE)", "true", /for a person without the administrator's role, must call/],
    ["a role matched by its start", ACTION_FILE, "roles.includes(ADMIN_ROLE)", "roles.some((r) => r.startsWith(ADMIN_ROLE))", /for a role named like the administrator's, must call/],
    ["no challenge", ACTION_FILE, "    api.authentication.challengeWithAny(SECOND_FACTORS);\n", "", /for an administrator's sign-in without a second factor, must call/],
    ["a challenge despite a fresh second factor", ACTION_FILE, "latestMfa > 0 && latestMfa >= latestOther", "false", /for an administrator's sign-in with a second factor after the password, must call/],
    ["an older second factor taken as fresh", ACTION_FILE, "latestMfa > 0 && latestMfa >= latestOther", "latestMfa > 0", /for an administrator's new password after an older second factor, must call/],
    ["a password taken as a second factor", ACTION_FILE, 'method.name === "mfa"', "method.name !== undefined", /for an administrator's sign-in without a second factor, must call/],
    ["a challenge with push only", ACTION_FILE, '[{ type: "push-notification" }, { type: "otp" }]', '[{ type: "push-notification" }]', /for an administrator's sign-in without a second factor, must call/],
    ["an error without authorization details", ACTION_FILE, "(event.authorization && event.authorization.roles) || []", "event.authorization.roles", /for a sign-in with two methods, must not throw/],
    ["an error without a transaction", ACTION_FILE, "const browser = BROWSER_PROTOCOLS.includes(event.transaction && event.transaction.protocol);", "const browser = BROWSER_PROTOCOLS.includes(event.transaction.protocol);", /for an administrator's event without a transaction, must not throw/],
    // 019: the desktop client's refusals.
    ["019: the role checked on a sign-in only, never on a renewal", ACTION_FILE, "if (!(Array.isArray(roles) && roles.includes(AGENT_ROLE))) {", "if ((event.transaction && event.transaction.protocol) !== RENEWAL && !(Array.isArray(roles) && roles.includes(AGENT_ROLE))) {", /for the desktop client without x402-agent on oauth2-refresh-token, must call/],
    ["019: plain accepted", ACTION_FILE, 'query.code_challenge_method !== "S256"', '!["S256", "plain"].includes(query.code_challenge_method)', /for the desktop client with code_challenge_method plain, must call/],
    ["019: a challenge before the refusals", ACTION_FILE, "  if (desktop) {\n", "  if (desktop) {\n    if (browser && !freshSecondFactor) api.authentication.challengeWithAny(SECOND_FACTORS);\n", /for the desktop client without x402-agent on oidc-basic-profile, must call/],
    ["019: no PKCE check", ACTION_FILE, '      api.access.deny("pkce_required");\n      return;\n', "", /for the desktop client with no code_challenge, must call/],
    ["019: the desktop rule for every client", ACTION_FILE, "metadata.x402_client === DESKTOP_CLIENT", "true", /for the docs page's client without x402-agent on oidc-basic-profile, must call/],
    ["019: no second factor for the desktop client", ACTION_FILE, "(admin || desktop) && browser", "admin && browser", /for the desktop client with x402-agent on oidc-basic-profile, must call/],
    ["019: an error without a client", ACTION_FILE, "(event.client && event.client.metadata) || {}", "event.client.metadata", /for a sign-in with two methods, must not throw/],
    ["019: an error without a request", ACTION_FILE, "(event.request && event.request.query) || {}", "event.request.query", /for the desktop client with no request, must not throw/],
    ["any method's time as the second factor's", MFA_ACTION_FILE, 'method && method.name === "mfa" && ', "method && ", /for a second factor older than the password, must call/],
    ["the first second factor, not the latest", MFA_ACTION_FILE, "at > latest", "latest === 0", /for two second factors, must call/],
    ["milliseconds", MFA_ACTION_FILE, "Math.floor(latest / 1000)", "latest", /for a sign-in with a second factor, must call/],
    ["the current time without a second factor", MFA_ACTION_FILE, /if \(latest > 0\) \{\n(\s+)api\.accessToken\.setCustomClaim\(CLAIM, [^\n]+/, "{\n$1api.accessToken.setCustomClaim(CLAIM, Math.floor((latest || Date.now()) / 1000));", /for a password only, must call \[\], not/],
    ["an error without authentication details", MFA_ACTION_FILE, "(event.authentication && event.authentication.methods) || []", "event.authentication.methods", /for an event without authentication details, must not throw/],
  ])("Phase 3 must fail (an Action, run): %s is reported", async (_label, file, from, to, message) => {
    const source = load().all[file]!;
    expect(typeof from === "string" ? source.includes(from) : from.test(source), `${file} contains the mutation anchor`).toBe(true);
    const problems = await RUNS[file]!(source.replace(from, to));
    expect(problems.some((m) => message.test(m)), problems.join("\n")).toBe(true);
  });

  it("must fail: a private key in the folder, committed state, and missing ignores are reported", () => {
    const s = load();
    const withKey = { ...s, all: { ...s.all, "key.pem": "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n", "terraform.tfstate": "{}" } };
    expect(auth0Problems(withKey)).toEqual(expect.arrayContaining(["key.pem holds a private key", "terraform.tfstate must not be committed"]));
    expect(auth0Problems({ ...s, all: { ...s.all, "dev.tfvars": 'environment = "dev"\n' } })).toContain("dev.tfvars must not be committed");
    expect(auth0Problems({ ...s, gitignore: s.gitignore.replace("auth0/*.tfvars\n", "") })).toContain(".gitignore must have auth0/*.tfvars");
    const ignores = { ...s, gitignore: s.gitignore.replace("auth0/*.tfstate\n", ""), dockerignore: s.dockerignore.replace("auth0\n", "") };
    expect(auth0Problems(ignores)).toEqual(expect.arrayContaining([".gitignore must have auth0/*.tfstate", ".dockerignore must exclude auth0"]));
  });

  it("SPEC 1.26: the operator command (scripts/auth0-tenant.sh) and the offline check (validate-auth0.yml) have no problem", () => {
    expect(scriptProblems(load())).toEqual([]);
    expect(workflowProblems(load())).toEqual([]);
  });

  it.each<[string, string | RegExp, string, string]>([
    ["a run on every pull request", '    paths: ["auth0/**", "scripts/auth0-tenant.sh", ".github/workflows/validate-auth0.yml"]\n  push:', "  push:", WORKFLOW_TRIGGERS],
    ["a run with the pull request's target's rights", "on:\n  pull_request:", "on:\n  pull_request_target:", WORKFLOW_TRIGGERS],
    ["a scheduled run", "  workflow_dispatch:\n", "  workflow_dispatch:\n  schedule:\n    - cron: '0 3 * * *'\n", WORKFLOW_TRIGGERS],
    ["a check that skips the operator command", '"auth0/**", "scripts/auth0-tenant.sh", ', '"auth0/**", ', WORKFLOW_TRIGGERS],
    ["an OIDC token", "permissions:\n  contents: read\n", "permissions:\n  id-token: write\n  contents: read\n", WORKFLOW_HOLDS_NOTHING],
    ["write permission on the repository", "  contents: read\n", "  contents: write\n", WORKFLOW_HOLDS_NOTHING],
    ["a GitHub environment", "    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    environment: auth0-dev\n", WORKFLOW_HOLDS_NOTHING],
    ["the Management API credential", "        run: bash scripts/auth0-tenant.sh validate", "        run: bash scripts/auth0-tenant.sh validate\n        env:\n          AUTH0_CLIENT_SECRET: ${{ secrets.AUTH0_CLIENT_SECRET }}", WORKFLOW_HOLDS_NOTHING],
    ["a Terraform variable from GitHub", "        run: bash scripts/auth0-tenant.sh validate", "        run: bash scripts/auth0-tenant.sh validate\n        env:\n          TF_VAR_tenant_domain: ${{ vars.AUTH0_TENANT_DOMAIN }}", WORKFLOW_HOLDS_NOTHING],
    ["a checkout that keeps the token", "          persist-credentials: false\n", "          persist-credentials: true\n", WORKFLOW_CHECKOUT],
    ["an action pinned by tag", "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", "actions/checkout@v7", WORKFLOW_CHECKOUT],
    ["a plan in the check", "        run: bash scripts/auth0-tenant.sh validate", "        run: bash scripts/auth0-tenant.sh plan", WORKFLOW_ONLY_VALIDATES],
    ["a second command", "        run: bash scripts/auth0-tenant.sh validate", "        run: bash scripts/auth0-tenant.sh validate\n\n      - run: terraform -chdir=auth0 apply -auto-approve", WORKFLOW_ONLY_VALIDATES],
    ["a check that may be skipped", "      - name: the pinned Terraform, the locked provider, fmt and validate\n", "      - name: the pinned Terraform, the locked provider, fmt and validate\n        if: false\n", WORKFLOW_ONLY_VALIDATES],
  ])("SPEC 1.26 must fail (the check): %s is reported", (_label, from, to, message) => {
    const s = load();
    expect(typeof from === "string" ? s.workflow.includes(from) : from.test(s.workflow), "the workflow contains the mutation anchor").toBe(true);
    expect(workflowProblems({ ...s, workflow: s.workflow.replace(from, () => to) })).toContain(message);
  });

  it.each<[string, string | RegExp, string, string]>([
    // The pinned Terraform.
    ["an unpinned version", /^TERRAFORM_VERSION=.*$/m, "TERRAFORM_VERSION=latest", SCRIPT_PINNED],
    ["no checksum", /^TERRAFORM_SHA256=.*$/m, "TERRAFORM_SHA256=", SCRIPT_PINNED],
    ["an unchecked download", /\n\s+if ! echo "\$TERRAFORM_SHA256 {2}\$tmp\/terraform\.zip" \| sha256sum -c --quiet -; then\n[^\n]+\n[^\n]+\n\s+fi/, "", SCRIPT_PINNED],
    ["Terraform installed with sudo", 'install -m 0755 "$tmp/terraform" "$TF"', 'sudo install -m 0755 "$tmp/terraform" "$TF"', SCRIPT_PINNED],
    ["Terraform installed in the system", 'TF="$HOME/.local/bin/terraform"', 'TF="/usr/local/bin/terraform"', SCRIPT_PINNED],
    ["a terraform from PATH", '"$TF" -chdir="$DIR" "$@"', 'terraform -chdir="$DIR" "$@"', SCRIPT_OWN_TERRAFORM],
    ["a second way to run Terraform", '    validate\n    ;;\n  plan)', '    validate\n    "$TF" -chdir="$DIR" state list\n    ;;\n  plan)', SCRIPT_OWN_TERRAFORM],
    ["Terraform in another folder", 'DIR="$ROOT/auth0"', 'DIR="$ROOT"', SCRIPT_OWN_TERRAFORM],
    // The state and the files beside it.
    ["the state in the checkout", 'STATE_DIR=${X402_TFSTATE_DIR:-$HOME/x402-tfstate}', 'STATE_DIR=${X402_TFSTATE_DIR:-$ROOT/auth0}', SCRIPT_STATE],
    ["one state for every environment", 'STATE="$STATE_DIR/auth0.$ENVIRONMENT.tfstate"', 'STATE="$STATE_DIR/auth0.tfstate"', SCRIPT_STATE],
    ["a state others can read", "umask 077\n", "", SCRIPT_STATE],
    ["a state the backend never gets", ' -backend-config="path=$STATE"', "", SCRIPT_STATE],
    ["a tfvars file in the checkout", 'TFVARS="$STATE_DIR/auth0.$ENVIRONMENT.tfvars"', 'TFVARS="$DIR/$ENVIRONMENT.tfvars"', SCRIPT_STATE],
    ["a credential file others can read", 'private "$CREDENTIAL_FILE" 600', 'private "$CREDENTIAL_FILE" 644', SCRIPT_PRIVATE],
    ["a state directory others can list", 'private "$STATE_DIR" 700', 'private "$STATE_DIR" 755', SCRIPT_PRIVATE],
    ["an unchecked state", '  [[ ! -e "$STATE" ]] || private "$STATE" 600\n', "", SCRIPT_PRIVATE],
    ["an unchecked plan", '    private "$PLAN" 600\n', "", SCRIPT_PRIVATE],
    ["a file someone else owns", `[[ "$(owner_mode "$path")" == "$(id -u) $mode" ]]`, `[[ "$(owner_mode "$path")" == *" $mode" ]]`, SCRIPT_PRIVATE],
    ["a file someone else owns, on GNU stat", `stat -c '%u %a' "$1"`, `stat -c '%a' "$1"`, SCRIPT_PRIVATE],
    ["a file someone else owns, on BSD stat", `stat -f '%u %Op' "$1"`, `stat -f '%Op' "$1"`, SCRIPT_PRIVATE],
    ["the special bits dropped on BSD stat", "& 8#7777))", "& 8#777))", SCRIPT_PRIVATE],
    ["a link followed", ' && ! -L "$path"', "", SCRIPT_PRIVATE],
    ["a provider the lock file doesn't pin", "tf init -reconfigure -lockfile=readonly", "tf init -reconfigure -upgrade", SCRIPT_LOCKED],
    // The credential.
    ["the credential file sourced", '  done < "$CREDENTIAL_FILE"\n', '  done < "$CREDENTIAL_FILE"\n  source "$CREDENTIAL_FILE"\n', SCRIPT_CREDENTIAL],
    ["the credential exported", 'CLIENT_SECRET=""\n', 'CLIENT_SECRET=""\nexport AUTH0_CLIENT_SECRET\n', SCRIPT_CREDENTIAL],
    ["the credential printed", '  [[ -n "$CLIENT_ID" && -n "$CLIENT_SECRET" ]]', '  echo "$CLIENT_SECRET" >&2\n  [[ -n "$CLIENT_ID" && -n "$CLIENT_SECRET" ]]', SCRIPT_CREDENTIAL],
    ["a trace of every command", "set -euo pipefail\n", "set -euxo pipefail\n", SCRIPT_CREDENTIAL],
    ["the credential from the checkout", "CREDENTIAL_FILE=${AUTH0_CREDENTIAL_FILE:-$HOME/x402-secrets/auth0-management.$ENVIRONMENT.env}", "CREDENTIAL_FILE=${AUTH0_CREDENTIAL_FILE:-$ROOT/env/auth0.env}", SCRIPT_CREDENTIAL],
    ["a credential Terraform never gets", 'AUTH0_CLIENT_SECRET="$CLIENT_SECRET" TF_INPUT=0', "TF_INPUT=0", SCRIPT_CREDENTIAL],
    // Constitution V.
    ["a credential kind from the tfvars file", " TF_VAR_credential=key", "", SCRIPT_KEY_ONLY],
    ["a client secret let through the tfvars file", "(environment|credential|[[:alnum:]_]*secret[[:alnum:]_]*)", "(environment|credential)", SCRIPT_KEY_ONLY],
    // 018 research R9.
    ["only L2's secret refused by name", "[[:alnum:]_]*secret[[:alnum:]_]*", "client_secret|client_secret_version", SCRIPT_NO_SECRET],
    ["a Google client secret's value let through", /\n\s*if grep -q 'GOCSPX-'[^\n]*/, "", SCRIPT_NO_SECRET],
    ["L2's client secret from the environment", 'TF_VAR_credential=key "$TF"', 'TF_VAR_credential=key TF_VAR_client_secret="${L2_CLIENT_SECRET:-}" "$TF"', SCRIPT_KEY_ONLY],
    ["a variable on the command line", '-var-file="$TFVARS" -out="$PLAN"', '-var-file="$TFVARS" -var credential=secret -out="$PLAN"', SCRIPT_KEY_ONLY],
    // An apply of exactly the saved plan.
    ["an apply of a new plan", 'tf apply -no-color -lock-timeout=120s "$PLAN"', "tf apply -no-color -lock-timeout=120s -auto-approve", SCRIPT_ONLY_APPLY],
    ["a plan without validate", /(\n {4}read_credential\n) {4}validate\n( {4}init_state\n {4}tf plan)/, "$1$2", SCRIPT_ONLY_APPLY],
    ["a plan that isn't saved", ' -out="$PLAN"\n', "\n", SCRIPT_ONLY_APPLY],
    ["an apply through the passthrough", '      apply | destroy) fail "terraform $1 is not run here', '      destroy) fail "terraform $1 is not run here', SCRIPT_ONLY_APPLY],
    ["a destroy", '    rm -f "$PLAN"\n', '    rm -f "$PLAN"\n    tf destroy -auto-approve\n', SCRIPT_ONLY_APPLY],
    ["a targeted plan", '-var-file="$TFVARS" -out="$PLAN"', '-var-file="$TFVARS" -target=auth0_client.agent -out="$PLAN"', SCRIPT_ONLY_APPLY],
    // What it shows and how it is run.
    ["validate without fmt", "  tf fmt -check -diff\n", "", "validate must init with no backend and the locked provider, then run fmt -check and validate"],
    ["no agent values after an apply", " bicepparam_portal_client_id bicepparam_agent; do", " bicepparam_portal_client_id; do", "the operator command must print the output bicepparam_agent after an apply"],
    ["no agent env lines after an apply", "for name in l2_env portal_env l1_env; do", "for name in l2_env portal_env; do", "the operator command must print the output l1_env after an apply"],
  ])("SPEC 1.26 must fail (the operator command): %s is reported", (_label, from, to, message) => {
    const s = load();
    expect(typeof from === "string" ? s.script.includes(from) : from.test(s.script), "the script contains the mutation anchor").toBe(true);
    expect(scriptProblems({ ...s, script: s.script.replace(from, () => to) })).toContain(message);
  });

  it("SPEC 1.26 must fail: npm run auth0:tenant that runs something else is reported", () => {
    const s = load();
    expect(scriptProblems({ ...s, packageJson: s.packageJson.replace('"bash scripts/auth0-tenant.sh"', '"terraform -chdir=auth0 apply"') })).toContain(SCRIPT_NPM);
  });

  // The operator command's own refusals, run: with a fake HOME and a stand-in Terraform, so nothing is downloaded and
  // no tenant is reached. Each case is one file in a state it must refuse, and the script stops before Terraform.
  it.each<[string, (home: string) => void, RegExp]>([
    ["a tfvars file others can read", (home) => chmodSync(join(home, "x402-tfstate", "auth0.dev.tfvars"), 0o644), /auth0\.dev\.tfvars must be yours, with mode 600/],
    ["a credential file others can read", (home) => chmodSync(join(home, "x402-secrets", "auth0-management.dev.env"), 0o640), /auth0-management\.dev\.env must be yours, with mode 600/],
    ["a tfvars file that picks the credential", (home) => writeFileSync(join(home, "x402-tfstate", "auth0.dev.tfvars"), 'credential = "secret"\n', { mode: 0o600 }), /must not set environment, credential or any variable whose name holds secret/],
    // 018 research R9: the Google application's secret, by its variable's name or by its value.
    ["a tfvars file with a variable for the Google secret", (home) => writeFileSync(join(home, "x402-tfstate", "auth0.dev.tfvars"), 'google_client_secret = "x"\n', { mode: 0o600 }), /must not set environment, credential or any variable whose name holds secret/],
    ["a tfvars file holding a Google client secret", (home) => writeFileSync(join(home, "x402-tfstate", "auth0.dev.tfvars"), `google_client_id = "${GOOGLE_SECRET_SHAPE}"\n`, { mode: 0o600 }), /holds a Google client secret/],
    ["a tfvars file with a private key", (home) => writeFileSync(join(home, "x402-tfstate", "auth0.dev.tfvars"), 'client_public_key_pem = "-----BEGIN PRIVATE KEY-----"\n', { mode: 0o600 }), /holds a private key/],
    ["a credential file with a third line", (home) => appendFileSync(join(home, "x402-secrets", "auth0-management.dev.env"), "rm -rf ~\n"), /may hold only AUTH0_CLIENT_ID= and AUTH0_CLIENT_SECRET= lines/],
    ["a credential file without the secret", (home) => writeFileSync(join(home, "x402-secrets", "auth0-management.dev.env"), "AUTH0_CLIENT_ID=abc\n", { mode: 0o600 }), /needs AUTH0_CLIENT_ID= and AUTH0_CLIENT_SECRET=/],
  ])("SPEC 1.26: the operator command refuses %s, before Terraform", (_label, spoil, refusal) => {
    const home = operatorHome();
    try {
      expect(runScript(home, ["plan"]), "the stand-in setup passes the checks").toMatchObject({ status: 0 });
      spoil(home);
      const r = runScript(home, ["plan"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(refusal);
      expect(readFileSync(join(home, "terraform-calls"), "utf8").split("\n").filter(Boolean)).toHaveLength(TF_CALLS_PER_PLAN);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("SPEC 1.26: the operator command gives the credential to Terraform alone, and refuses an apply or destroy through its passthrough", () => {
    const home = operatorHome();
    try {
      const plan = runScript(home, ["plan"]);
      expect(plan.status, plan.stderr).toBe(0);
      const calls = readFileSync(join(home, "terraform-calls"), "utf8").split("\n").filter(Boolean);
      expect(calls).toEqual([
        "-chdir=AUTH0 init -backend=false -lockfile=readonly -no-color | id=client-1 secret=secret-1 credential=key environment=dev",
        "-chdir=AUTH0 fmt -check -diff | id=client-1 secret=secret-1 credential=key environment=dev",
        "-chdir=AUTH0 validate -no-color | id=client-1 secret=secret-1 credential=key environment=dev",
        `-chdir=AUTH0 init -reconfigure -lockfile=readonly -no-color -backend-config=path=${home}/x402-tfstate/auth0.dev.tfstate | id=client-1 secret=secret-1 credential=key environment=dev`,
        `-chdir=AUTH0 plan -no-color -lock-timeout=120s -var-file=${home}/x402-tfstate/auth0.dev.tfvars -out=${home}/x402-tfstate/auth0.dev.tfplan | id=client-1 secret=secret-1 credential=key environment=dev`,
      ].map((call) => call.replace("AUTH0", join(process.cwd(), DIR))));
      expect(plan.stdout + plan.stderr).not.toContain("secret-1");
      for (const sub of ["apply", "destroy"]) {
        const r = runScript(home, ["terraform", sub, "-auto-approve"]);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain(`terraform ${sub} is not run here: plan, then apply exactly the saved plan`);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(!terraform)("terraform fmt -check passes", () => {
    const r = spawnSync("terraform", [`-chdir=${DIR}`, "fmt", "-check", "-diff"], { encoding: "utf8" });
    expect(r.stdout + r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it.skipIf(!terraform || !existsSync(join(DIR, ".terraform")))("terraform validate passes (after terraform init)", () => {
    const r = spawnSync("terraform", [`-chdir=${DIR}`, "validate", "-no-color"], { encoding: "utf8" });
    expect(r.stdout + r.stderr).toContain("The configuration is valid");
    expect(r.status).toBe(0);
  });
});
