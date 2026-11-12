// 012 T-IAC-02: auth0/, the Auth0 tenant as Terraform (specs/012 research R17), checked offline. The checks read the
// .tf sources as text, like T-E2E-AZ reads the workflows, and cross-check what L2 depends on against the source
// (DETAILS_TYPE) and the Bicep parameter file (the ciba keys). Each check has a must-fail mutant. With Terraform on
// PATH, `terraform fmt -check` runs too; `terraform validate` runs once `terraform init` has been run by hand.
// Its pipeline, .github/workflows/provision-auth0.yml, is checked here too (pipelineProblems): by hand only, in its
// own GitHub environment, the only workflow that reads secrets (only in its plan and apply steps) and variables
// (Terraform's, only in its plan step: no tfvars file exists), the pinned
// Terraform and the locked provider (its lock file holds the Linux runner's checksum too), the state in Azure with
// OIDC and no key, and an apply of exactly the plan shown.
// 013 (specs/013 contracts/config-and-secrets.md "auth0/", research R19): people's sign-in. The API with RBAC and its
// one permission, the role that holds exactly it, the two public clients with one grant each, the portal client's
// URLs, and the post-login Action, whose code is also run here against a stand-in for Auth0's `api`.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { DETAILS_TYPE } from "../src/layer2-control/payment-details.js";

const DIR = "auth0";
const WORKFLOW = ".github/workflows/provision-auth0.yml";
/** The only GitHub secrets any workflow reads: the Management API credential. Never a credential of L2's (Constitution V). */
const SECRETS = ["AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET"];
/** The variables the plan refuses to run without: the three with no default, and the public key that credential = "key" needs. */
const REQUIRED = ["tenant_domain", "api_identifier", "approver_user_id", "client_public_key_pem"];
/** The GitHub environment variable behind each Terraform variable the pipeline sets; none is a secret. */
const VARIABLES: Record<string, string> = {
  tenant_domain: "AUTH0_TENANT_DOMAIN",
  api_identifier: "AUTH0_API_IDENTIFIER",
  approver_user_id: "AUTH0_APPROVER_USER_ID",
  client_public_key_pem: "AUTH0_CLIENT_PUBLIC_KEY",
  manage_guardian: "AUTH0_MANAGE_GUARDIAN",
  guardian_policy: "AUTH0_GUARDIAN_POLICY",
  portal_origin: "AUTH0_PORTAL_ORIGIN",
};
/**
 * The variables infra/github-setup.sh doesn't create: they have no value until later (the portal's origin exists
 * once the portal is deployed), and a GitHub variable can't be empty. Unset, Terraform's default holds.
 */
const SET_LATER = ["AUTH0_PORTAL_ORIGIN"];
/** 013: the one permission of people's API, the role that holds it, and the portal's local origin (its default port). */
const PERMISSION = "agent:run";
const ROLE = "x402-user";
const LOCAL_PORTAL = "http://localhost:4025";
/** The access-token claim the Action sets: the services' default AUTH_TIME_CLAIM (contracts/config-and-secrets.md). */
const AUTH_TIME_CLAIM = "https://x402.dev/auth_time";
/** The Action's code, a file of its own so that this suite can run it. */
const ACTION_FILE = "sign-in-time.js";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** How the lock file gets the checksum of each platform that runs Terraform: the pipeline's runner and a Mac. */
const LOCK_COMMAND = "terraform -chdir=auth0 providers lock -platform=linux_amd64 -platform=darwin_arm64";
const LOCKED_FOR_RUNNER = `auth0/.terraform.lock.hcl must hold the provider's h1 checksum for the pipeline's Linux runner as well as a Mac's (${LOCK_COMMAND})`;

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
  /** .github/workflows/provision-auth0.yml. */
  workflow: string;
  /** infra/modules/state-storage.bicep: the state's container. */
  stateStorage: string;
  /** infra/github-setup.sh: it creates the pipeline's variables, with placeholders. */
  setup: string;
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
    stateStorage: readFileSync("infra/modules/state-storage.bicep", "utf8"),
    setup: readFileSync("infra/github-setup.sh", "utf8"),
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

  // Its one permission, and the one role, which holds exactly that permission.
  const permission = /^\s*permission\s*=\s*"([^"]+)"/m.exec(tf)?.[1];
  const scopes = block(tf, /resource\s+"auth0_resource_server_scopes"\s+"identity"\s*\{/);
  const scopeBlocks = blocks(scopes, /\bscopes\s*\{/g);
  if (
    permission !== PERMISSION ||
    !has(scopes, /resource_server_identifier\s*=\s*auth0_resource_server\.identity\.identifier/) ||
    scopeBlocks.length !== 1 ||
    !/name\s*=\s*local\.permission\b/.test(scopeBlocks[0]!) ||
    count("auth0_resource_server_scopes") !== 1 ||
    count("auth0_resource_server_scope") !== 0
  ) {
    p.push(`people's API must have exactly one permission, ${PERMISSION}`);
  }
  const role = block(tf, /resource\s+"auth0_role"\s+"user"\s*\{/);
  if (!has(role, new RegExp(`name\\s*=\\s*"${ROLE}"`)) || count("auth0_role") !== 1) p.push(`the one role must be ${ROLE}`);
  const rolePermissions = block(tf, /resource\s+"auth0_role_permissions"\s+"user"\s*\{/);
  const held = blocks(rolePermissions, /\bpermissions\s*\{/g);
  if (
    !has(rolePermissions, /role_id\s*=\s*auth0_role\.user\.id/) ||
    held.length !== 1 ||
    !/name\s*=\s*local\.permission\b/.test(held[0]!) ||
    !/resource_server_identifier\s*=\s*auth0_resource_server\.identity\.identifier/.test(held[0]!) ||
    count("auth0_role_permissions") !== 1 ||
    count("auth0_role_permission") !== 0
  ) {
    p.push(`the role ${ROLE} must hold exactly the permission ${PERMISSION} on people's API`);
  }

  // The two public clients: no secret, no key, and each with only its own grant.
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
    const got = (/grant_types\s*=\s*\[([^\]]*)\]/.exec(c)?.[1] ?? "").split(",").map((g) => g.trim().replace(/^"|"$/g, "")).filter(Boolean);
    if (JSON.stringify(got) !== JSON.stringify(grants)) p.push(`${label} must have only its own grant (${grants.join(", ")})`);
    if (!has(c, /is_first_party\s*=\s*true/) || !has(c, /oidc_conformant\s*=\s*true/)) p.push(`${label} must be first-party and OIDC-conformant`);
    return c;
  };
  // Refresh-token rotation needs the refresh_token grant beside the authorization code (with PKCE: a public client).
  const portalClient = publicClient("portal", "the portal's client", "spa", ["authorization_code", "refresh_token"]);
  const cliClient = publicClient("agent_cli", "the agent CLI's client", "native", [DEVICE_GRANT]);
  const origins = /^\s*portal_origins\s*=\s*(.+)$/m.exec(tf)?.[1] ?? "";
  if (portalClient) {
    const urls = [...portalClient.matchAll(/^\s*(callbacks|web_origins|allowed_logout_urls|allowed_origins|initiate_login_uri|cross_origin_loc|oidc_backchannel_logout_urls)\s*=\s*(.+)$/gm)].map((m) => `${m[1]} = ${m[2]!.trim()}`).sort();
    if (
      JSON.stringify(urls) !== JSON.stringify(["allowed_logout_urls = local.portal_origins", "callbacks = local.portal_origins", "web_origins = local.portal_origins"]) ||
      JSON.stringify([...origins.matchAll(/"([^"]*)"/g)].map((m) => m[1])) !== JSON.stringify([LOCAL_PORTAL, ""]) ||
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
  if (!/condition\s*=\s*var\.portal_origin == "" \|\| can\(regex\("\^https:\/\/\[a-z0-9\]\[a-z0-9\.-\]\*\$", var\.portal_origin\)\)/.test(block(tf, /variable\s+"portal_origin"\s*\{/) ?? "")) {
    p.push("var.portal_origin must be empty or one https origin: a host, with no path, port, wildcard or trailing slash");
  }
  if (cliClient && /^\s*(callbacks|web_origins|allowed_logout_urls|allowed_origins)\s*=/m.test(cliClient)) p.push("the agent CLI's client must have no callback, origin or logout URL: the device flow needs none");
  const clients = [...tf.matchAll(/resource\s+"auth0_client"\s+"(\w+)"/g)].map((m) => m[1]).sort();
  if (JSON.stringify(clients) !== JSON.stringify(["agent_cli", "l2", "portal"])) p.push("the clients must be exactly L2's, the portal's and the agent CLI's");

  // The post-login Action: its code is the file this suite runs (actionProblems), it holds no secret and no package,
  // and it is appended to the tenant's flow, never replacing it. It writes one namespaced claim on the access token.
  const action = block(tf, /resource\s+"auth0_action"\s+"sign_in_time"\s*\{/);
  const binding = block(tf, /resource\s+"auth0_trigger_action"\s+"sign_in_time"\s*\{/);
  const triggers = blocks(action, /\bsupported_triggers\s*\{/g);
  if (
    !has(action, new RegExp(`code\\s*=\\s*file\\("\\$\\{path\\.module\\}/${ACTION_FILE.replace(".", "\\.")}"\\)`)) ||
    triggers.length !== 1 ||
    !/id\s*=\s*"post-login"/.test(triggers[0]!) ||
    has(action, /\b(secrets|secrets_wo|dependencies|modules)\s*\{/) ||
    !has(binding, /trigger\s*=\s*"post-login"/) ||
    !has(binding, /action_id\s*=\s*auth0_action\.sign_in_time\.id/) ||
    count("auth0_action") !== 1 ||
    count("auth0_trigger_action") !== 1 ||
    count("auth0_trigger_actions") !== 0
  ) {
    p.push(`the one Action must be the post-login sign-in time Action (${ACTION_FILE}, no secret, no package), appended to the flow (auth0_trigger_action), never replacing it`);
  }
  const claim = /^\s*auth_time_claim\s*=\s*"([^"]+)"/m.exec(tf)?.[1];
  if (claim !== AUTH_TIME_CLAIM) p.push(`local.auth_time_claim must be ${AUTH_TIME_CLAIM}, the services' default AUTH_TIME_CLAIM`);
  const js = (s.all[ACTION_FILE] ?? "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
  const apiUses = [...js.matchAll(/\bapi\s*\.\s*([\w.]+)/g)].map((m) => m[1]);
  const strings = [...js.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  if (JSON.stringify(apiUses) !== '["accessToken.setCustomClaim"]' || JSON.stringify(strings) !== JSON.stringify([AUTH_TIME_CLAIM]) || /\bapi\s*\[|\brequire\s*\(|\bimport\b|\bfetch\s*\(|\bevent\.secrets\b/.test(js)) {
    p.push(`the Action must write one namespaced claim, ${AUTH_TIME_CLAIM}, on the access token, and do nothing else`);
  }

  // Nothing here manages users, assigns a role or holds secrets.
  if (/resource\s+"auth0_user"/.test(tf) || /\bpassword\s*=/.test(tf)) p.push("users and passwords are never managed here");
  if (/resource\s+"auth0_(user_roles?|user_permissions?|organization_member\w*)"/.test(tf)) p.push(`no role or permission is assigned to a person here: an administrator assigns ${ROLE} in Auth0`);
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
  // 013: the outputs for people's sign-in. The identity object has exactly the keys main.bicep reads, and the agent
  // service's allow-list is the agent CLI's client only, never the portal's.
  const wantIdentity = Object.keys(bicepObject(s.bicepparam, "identity")).sort();
  const identityOut = block(block(tf, /output\s+"bicepparam_identity"\s*\{/) ?? "", /value\s*=\s*\{/) ?? "";
  const gotIdentity = [...identityOut.matchAll(/^\s*(\w+)\s*=/gm)].map((m) => m[1]!).sort();
  if (wantIdentity.length === 0 || JSON.stringify(gotIdentity) !== JSON.stringify(wantIdentity)) {
    p.push(`output bicepparam_identity must have exactly the identity keys of the parameter file (${wantIdentity.join(", ")}), got ${gotIdentity.join(", ")}`);
  }
  if (!/issuer\s*=\s*local\.issuer\b/.test(identityOut) || !/audience\s*=\s*auth0_resource_server\.identity\.identifier\b/.test(identityOut) || !/agentClientIds\s*=\s*\[auth0_client\.agent_cli\.client_id\]/.test(identityOut)) {
    p.push("output bicepparam_identity must be the tenant's issuer, people's API and the agent CLI's client only, never the portal's");
  }
  if (!has(block(tf, /output\s+"bicepparam_portal_client_id"\s*\{/), /value\s*=\s*auth0_client\.portal\.client_id\b/)) p.push("output bicepparam_portal_client_id must be the portal client's ID (userAccounts.portalClientId)");

  // The state: a blob in Azure, read and written with an Entra sign-in; nothing of it is written in the folder.
  const backend = block(tf, /backend\s+"azurerm"\s*\{/);
  if (!has(backend, /use_azuread_auth\s*=\s*true/)) p.push('the state must be in Azure with an Entra sign-in (backend "azurerm", use_azuread_auth = true)');
  if (has(backend, /access_key|sas_token|client_secret|storage_account_name|container_name|\bkey\s*=/)) p.push("the backend block must hold no key and no name: the pipeline passes the account, container and key from the parameter file");

  // Every variable the pipeline sets exists, and the three without a default are the ones it requires.
  const declared = [...tf.matchAll(/variable\s+"(\w+)"\s*\{/g)].map((m) => m[1]!);
  for (const name of Object.keys(VARIABLES)) if (!declared.includes(name)) p.push(`the pipeline sets var.${name}, which auth0/ doesn't declare`);
  const noDefault = declared.filter((name) => !/^\s*default\s*=/m.test(block(tf, new RegExp(`variable\\s+"${name}"\\s*\\{`)) ?? "")).sort();
  if (JSON.stringify(noDefault) !== JSON.stringify(["api_identifier", "approver_user_id", "environment", "tenant_domain"])) p.push(`only environment, tenant_domain, api_identifier and approver_user_id may have no default (the pipeline requires them), got ${noDefault.join(", ")}`);

  // Local state, plans and tfvars never reach git or an image.
  for (const pattern of ["auth0/.terraform/", "auth0/*.tfstate", "auth0/*.tfstate.*", "auth0/*.tfplan", "auth0/*.tfvars"]) {
    if (!s.gitignore.split("\n").includes(pattern)) p.push(`.gitignore must have ${pattern}`);
  }
  if (!s.dockerignore.split("\n").includes("auth0")) p.push(".dockerignore must exclude auth0");
  return p;
}

type Step = { id?: string; if?: string; run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Pipeline = {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  env?: Record<string, string>;
  jobs?: Record<string, { environment?: string; env?: unknown; steps?: Step[] }>;
};

/** One message per problem of the pipeline that applies auth0/. Empty for the real workflow. */
export function pipelineProblems(s: Sources): string[] {
  const p: string[] = [];
  const w = parse(s.workflow) as Pipeline;
  const jobs = Object.values(w.jobs ?? {});
  const job = jobs[0];
  const steps = job?.steps ?? [];
  const step = (id: string) => steps.find((x) => x.id === id);
  const run = (id: string) => step(id)?.run ?? "";
  const scripts = steps.map((x) => x.run ?? "").join("\n");

  if (JSON.stringify(Object.keys(w.on ?? {})) !== '["workflow_dispatch"]') p.push("the pipeline must run by hand only (workflow_dispatch): never on a push, a pull request or a schedule");
  if (JSON.stringify(w.permissions) !== JSON.stringify({ "id-token": "write", contents: "read" })) p.push("the pipeline's permissions must be id-token: write and contents: read only");
  if (w.concurrency?.group !== "provision-auth0" || w.concurrency["cancel-in-progress"] !== false) p.push("the pipeline must hold the concurrency group provision-auth0 without cancelling: one run at a time for the tenant");
  if (jobs.length !== 1 || job?.environment !== "auth0-${{ inputs.environment }}") p.push("the pipeline's one job must run in the GitHub environment auth0-<environment>, which holds the Auth0 credential, never the deploy environment");

  // Secrets: the three of the Auth0 environment, only as the plan and apply steps' environment.
  const read = [...s.workflow.matchAll(/\$\{\{\s*(secrets|vars)\.([A-Za-z0-9_]+)/g)].map((m) => `${m[1]}.${m[2]}`);
  const readable = [...SECRETS.map((x) => `secrets.${x}`), ...Object.values(VARIABLES).map((x) => `vars.${x}`)];
  for (const name of read) if (!readable.includes(name)) p.push(`the pipeline reads ${name}: only its two secrets and its Terraform variables may be read`);
  // Terraform's variables: each one from its GitHub environment variable, in the plan step only, never a tfvars file.
  const planEnv = step("plan")?.env ?? {};
  const wired = Object.entries(VARIABLES).every(([name, source]) => planEnv[`VAR_${name}`] === `\${{ vars.${source} }}`);
  const exported = /for name in ([a-z_ ]+); do\n\s+source="VAR_\$name"\n\s+if \[\[ -n "\$\{!source\}" \]\]; then export "TF_VAR_\$name=\$\{!source\}"; fi/.exec(run("plan"))?.[1];
  const required = /for required in ([A-Za-z0-9_: ]+); do\n\s+source="VAR_\$\{required%%:\*\}"\n\s+if \[\[ -z "\$\{!source\}" \]\]; then\n[^\n]+\n\s+exit 1/.exec(run("plan"))?.[1];
  if (!wired || Object.keys(planEnv).filter((k) => k.startsWith("VAR_")).length !== Object.keys(VARIABLES).length || exported !== Object.keys(VARIABLES).join(" ") || required !== REQUIRED.map((name) => `${name}:${VARIABLES[name]}`).join(" ")) {
    p.push("Terraform's variables must come from the GitHub environment's variables, as TF_VAR_* in the plan step: all seven wired, the four without a usable default required");
  }
  // Constitution V: L2's credential is held by L2 only. The pipeline provisions the key path alone, where GitHub
  // holds the public half; it never takes L2's client secret, from a secret, a variable or a file.
  if (!run("plan").includes('export TF_VAR_environment="$ENVIRONMENT" TF_VAR_credential=key') || /TF_VAR_client_secret|L2_CLIENT_SECRET|\bVAR_credential\b|credential=secret/.test(s.workflow)) {
    p.push('the pipeline must provision credential = "key" only, and never hold L2\'s client secret (Constitution V)');
  }
  // infra/github-setup.sh creates exactly these variables, but the ones that have no value yet (a GitHub variable
  // can't be empty), and the plan refuses the placeholder it gives them.
  const created = [...s.setup.matchAll(/^ {2}"(AUTH0_[A-Z_]+)=/gm)].map((m) => m[1]!).sort();
  const placeholder = /^PLACEHOLDER="([A-Z_]+)"$/m.exec(s.setup)?.[1];
  if (JSON.stringify(created) !== JSON.stringify(Object.values(VARIABLES).filter((x) => !SET_LATER.includes(x)).sort())) p.push("infra/github-setup.sh must create exactly the variables the pipeline reads, but the ones set later (the portal's origin)");
  if (!placeholder || !new RegExp(`for source in "\\$\\{!VAR_@\\}"; do\\n\\s+if \\[\\[ "\\$\\{!source\\}" == ${placeholder} \\]\\]; then\\n[^\\n]+\\n\\s+exit 1`).test(run("plan").split("terraform -chdir=auth0 plan")[0]!)) {
    p.push("the plan step must refuse a variable that still holds infra/github-setup.sh's placeholder, before it plans");
  }
  if (elsewhereVars(w, steps).includes("vars.") || /tfvars|-var-file|-var[ =]/.test(scripts)) p.push("the variables must reach only the plan step, and no tfvars file or -var argument may be used");
  const elsewhere = JSON.stringify({ ...w, jobs: { job: { ...job, steps: steps.map((x) => (x.id === "plan" || x.id === "apply" ? { ...x, env: undefined } : x)) } } });
  if (elsewhere.includes("secrets.")) p.push("the secrets must reach only the plan and apply steps, as their environment: never the job, another step or a script");
  if (/\$\{\{\s*inputs\./.test(scripts)) p.push("an input is never pasted into a script");
  if (/ARM_CLIENT_SECRET|ARM_ACCESS_KEY|ARM_SAS_TOKEN|AUTH0_API_TOKEN/.test(s.workflow)) p.push("the pipeline must hold no Azure credential and no Auth0 token: OIDC for the state, the Management API application for Auth0");
  if (w.env?.ARM_USE_OIDC !== "true" || w.env.ARM_USE_AZUREAD !== "true" || !/"ARM_CLIENT_ID=\\\(v\(\["deployClientId"\]\)\)"/.test(run("target"))) {
    p.push("the state's sign-in must be OIDC as the deploy app of the parameter file, with Entra authorization (ARM_USE_OIDC, ARM_USE_AZUREAD)");
  }

  // The tools: Terraform pinned by version and SHA-256, the provider exactly as the lock file has it.
  if (!/^\d+\.\d+\.\d+$/.test(w.env?.TERRAFORM_VERSION ?? "") || !/^[0-9a-f]{64}$/.test(w.env?.TERRAFORM_SHA256 ?? "") || !/echo "\$TERRAFORM_SHA256 {2}\$RUNNER_TEMP\/terraform\.zip" \| sha256sum -c -/.test(run("target"))) {
    p.push("Terraform must be pinned by version and checked against its SHA-256 before it runs");
  }
  if (!/terraform -chdir=auth0 init -lockfile=readonly/.test(run("init"))) p.push("init must use the provider exactly as .terraform.lock.hcl pins it (-lockfile=readonly)");
  const container = /resource container [^\n]+\{\s*parent: blobs\s*name: '([a-z0-9-]+)'/.exec(s.stateStorage)?.[1];
  if (
    !run("init").includes('-backend-config="storage_account_name=$STATE_STORAGE"') ||
    !run("init").includes(`-backend-config="container_name=${container}"`) ||
    !run("init").includes('-backend-config="key=auth0.$ENVIRONMENT.tfstate"') ||
    !/"STATE_STORAGE=\\\(v\(\["names", "stateStorage"\]\)\)"/.test(run("target"))
  ) {
    p.push("the state must be the blob auth0.<environment>.tfstate in the container and account of infra/pre-deploy.<environment>.bicepparam (names.stateStorage)");
  }

  // The order, and an apply of exactly the plan shown, only when asked.
  const order = ["target", "tests", "init", "plan", "apply"].map((id) => steps.findIndex((x) => x.id === id));
  if (order.some((i, n) => i < 0 || (n > 0 && i <= order[n - 1]!))) p.push("the steps must be, in order: the tools and values, the offline checks, init, plan, apply");
  if (!run("tests").includes("vitest run test/auth0-iac.test.ts")) p.push("the offline checks (T-IAC-02) must run before init");
  if (!run("plan").includes('-out="$RUNNER_TEMP/auth0.tfplan"') || !run("plan").includes("GITHUB_STEP_SUMMARY")) {
    p.push("the plan must be saved, and be shown in the run's summary");
  }
  const applies = scripts.split("\n").filter((l) => /\bterraform\b.*\b(apply|destroy|import|state|taint|untaint)\b/.test(l));
  if (
    step("apply")?.if !== "${{ inputs.apply }}" ||
    applies.length !== 1 ||
    !/^\s*terraform -chdir=auth0 apply -no-color -lock-timeout=120s "\$RUNNER_TEMP\/auth0\.tfplan"$/.test(applies[0]!) ||
    !run("apply").includes(applies[0]!) ||
    /-auto-approve|-target|-replace/.test(scripts)
  ) {
    p.push("the only change to the tenant must be the apply step, when the apply input is checked, applying exactly the saved plan");
  }
  // 013: the apply step's summary gives every value the parameter file takes, none of them secret.
  for (const output of ["bicepparam_ciba", "bicepparam_identity", "bicepparam_portal_client_id"]) {
    if (!run("apply").includes(`terraform -chdir=auth0 output -json ${output}\n`)) p.push(`the apply step must show the output ${output} in the run's summary, for infra/main.<environment>.bicepparam`);
  }
  return p;
}

/** The workflow without the plan step's environment, as text: where no variable may appear. */
function elsewhereVars(w: Pipeline, steps: Step[]): string {
  return JSON.stringify({ ...w, jobs: { job: { steps: steps.map((x) => (x.id === "plan" ? { ...x, env: undefined } : x)) } } });
}

/** An object parameter (ciba, identity) in a parameter file, parsed from its text (keys and literal values). */
function bicepObject(bicepparam: string, name: string): Record<string, string> {
  const body = block(bicepparam, new RegExp(`param ${name} = \\{`)) ?? "";
  return Object.fromEntries([...body.matchAll(/^\s*(\w+):\s*(.+)$/gm)].map((m) => [m[1]!, m[2]!.trim()]));
}

/** One call the Action made on Auth0's `api`: its dotted path and its arguments. */
type ApiCall = [path: string, args: unknown[]];

/**
 * Runs the Action's code as Auth0 does (CommonJS, `exports.onExecutePostLogin(event, api)`), in a context of its own,
 * with a stand-in `api` that records every call on it, whatever its path. Throws when the Action does.
 */
export async function runAction(source: string, event: unknown): Promise<ApiCall[]> {
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
  if (JSON.stringify(Object.keys(exports)) !== '["onExecutePostLogin"]' || typeof exports.onExecutePostLogin !== "function") throw new Error("the Action must export onExecutePostLogin only");
  await (exports.onExecutePostLogin as (event: unknown, api: unknown) => unknown)(event, recorder(""));
  return calls;
}

/** A sign-in with a password at `first` and a second factor at `last` (ISO times), as the post-login event has it. */
const signIn = (first: string, last: string) => ({ authentication: { methods: [{ name: "pwd", timestamp: first }, { name: "mfa", timestamp: last }] }, user: { user_id: "auth0|1" } });
const FIRST = "2026-11-10T10:00:00.000Z";
const LAST = "2026-11-10T10:05:30.900Z";

/**
 * What the Action does, by running it: the claim is the time of the most recent authentication, in whole seconds, and
 * the only thing it sets; an event without a usable time sets nothing (never the current time, which would make a
 * token renewal look like a new sign-in). One message per problem.
 */
export async function actionProblems(source: string): Promise<string[]> {
  const p: string[] = [];
  const cases: [string, unknown, ApiCall[]][] = [
    ["a sign-in with two methods", signIn(FIRST, LAST), [["accessToken.setCustomClaim", [AUTH_TIME_CLAIM, Math.floor(Date.parse(LAST) / 1000)]]]],
    ["the same methods in the other order", { authentication: { methods: [...signIn(FIRST, LAST).authentication.methods].reverse() } }, [["accessToken.setCustomClaim", [AUTH_TIME_CLAIM, Math.floor(Date.parse(LAST) / 1000)]]]],
    ["an event without authentication details", { user: { user_id: "auth0|1" } }, []],
    ["an event without methods", { authentication: { methods: [] } }, []],
    ["a method without a readable time", { authentication: { methods: [{ name: "pwd", timestamp: "yesterday" }, { name: "mfa" }, null] } }, []],
  ];
  for (const [label, event, want] of cases) {
    try {
      const got = await runAction(source, event);
      if (JSON.stringify(got) !== JSON.stringify(want)) p.push(`the Action, for ${label}, must call ${JSON.stringify(want)}, not ${JSON.stringify(got)}`);
    } catch (e) {
      p.push(`the Action, for ${label}, must not throw (a failing Action stops every sign-in of the tenant): ${(e as Error).message}`);
    }
  }
  return p;
}

const mutate = (s: Sources, file: string, from: string | RegExp, to: string): Sources => {
  const text = (file in s.tf ? s.tf[file] : s.all[file])!;
  expect(typeof from === "string" ? text.includes(from) : from.test(text), `${file} contains the mutation anchor`).toBe(true);
  const next = text.replace(from, to);
  return { ...s, tf: file in s.tf ? { ...s.tf, [file]: next } : s.tf, all: { ...s.all, [file]: next } };
};

const terraform = spawnSync("terraform", ["version"], { encoding: "utf8" }).status === 0;

describe("T-IAC-02 Auth0 tenant as code (auth0/)", () => {
  it("the real configuration has no problem", () => {
    expect(auth0Problems(load())).toEqual([]);
  });

  it("the parameter file's ciba object is the one main.bicep reads, and starts off", () => {
    expect(bicepObject(load().bicepparam, "ciba")).toMatchObject({ enabled: "false", credential: "'key'" });
  });

  it("013: the parameter file's identity object has the three keys main.bicep reads", () => {
    expect(Object.keys(bicepObject(load().bicepparam, "identity")).sort()).toEqual(["agentClientIds", "audience", "issuer"]);
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
    ["a managed user", "main.tf", "data \"auth0_user\" \"approver\" {", 'resource "auth0_user" "approver" {\n  password = "x"\n}\ndata "auth0_user" "approver" {', "users and passwords are never managed here"],
    ["a local state", "versions.tf", /  backend "azurerm" \{\n    use_azuread_auth = true\n  \}\n/, "", 'the state must be in Azure with an Entra sign-in (backend "azurerm", use_azuread_auth = true)'],
    ["a state account key", "versions.tf", "    use_azuread_auth = true\n", '    use_azuread_auth = true\n    access_key       = "abc"\n', "the backend block must hold no key and no name: the pipeline passes the account, container and key from the parameter file"],
    ["an output missing clientKeyId", "outputs.tf", '    clientKeyId = ""\n', "", "output bicepparam_ciba must have exactly the ciba keys of the parameter file (approver, audience, clientId, clientKeyId, credential, enabled, issuer), got approver, audience, clientId, credential, enabled, issuer"],
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
  const ONE_PERMISSION = `people's API must have exactly one permission, ${PERMISSION}`;
  const ROLE_HOLDS = `the role ${ROLE} must hold exactly the permission ${PERMISSION} on people's API`;
  const PORTAL_PUBLIC = "the portal's client must be a public spa client: authentication_method none, no secret and no key";
  const CLI_PUBLIC = "the agent CLI's client must be a public native client: authentication_method none, no secret and no key";
  const PORTAL_GRANT = "the portal's client must have only its own grant (authorization_code, refresh_token)";
  const CLI_GRANT = `the agent CLI's client must have only its own grant (${DEVICE_GRANT})`;
  const PORTAL_URLS = `the portal client's callbacks, web origins and logout URLs must be exactly ${LOCAL_PORTAL} and var.portal_origin when set`;
  const ONE_ACTION = `the one Action must be the post-login sign-in time Action (${ACTION_FILE}, no secret, no package), appended to the flow (auth0_trigger_action), never replacing it`;
  const ONE_CLAIM = `the Action must write one namespaced claim, ${AUTH_TIME_CLAIM}, on the access token, and do nothing else`;
  const NOBODY_ASSIGNED = `no role or permission is assigned to a person here: an administrator assigns ${ROLE} in Auth0`;
  const IDENTITY_OUTPUT = "output bicepparam_identity must be the tenant's issuer, people's API and the agent CLI's client only, never the portal's";
  it.each<[string, string, string | RegExp, string, string]>([
    ["an API without RBAC", "main.tf", /enforce_policies(\s*)= true/, "enforce_policies$1= false", "people's API must enforce RBAC (enforce_policies = true)"],
    ["permissions left out of the token", "main.tf", '"access_token_authz"', '"access_token"', 'people\'s API must put the permissions in the access token (token_dialect = "access_token_authz")'],
    ["an API without refresh tokens", "main.tf", /(resource "auth0_resource_server" "identity" \{[\s\S]*?allow_offline_access\s*=\s*)true/, "$1false", "people's API must allow offline access (the web app's refresh-token rotation)"],
    ["HS256 tokens for people", "main.tf", /(resource "auth0_resource_server" "identity" \{[\s\S]*?signing_alg\s*=\s*)"RS256"/, '$1"HS256"', "people's API must sign with RS256 (the services accept RS256 only)"],
    ["the approval API reused for people", "main.tf", /identifier(\s*)= local\.identity_audience/, "identifier$1= var.api_identifier", "people's API must have an identifier of its own (local.identity_audience), never the approval API's"],
    ["another permission name", "main.tf", new RegExp(`permission(\\s*)= "${PERMISSION}"`), 'permission$1= "agent:admin"', ONE_PERMISSION],
    ["a second permission", "main.tf", /(\n  scopes \{\n[^}]*\})/, '$1\n  scopes {\n    name = "portal:admin"\n  }', ONE_PERMISSION],
    ["a role under another name", "main.tf", `"${ROLE}"`, '"x402-admin"', `the one role must be ${ROLE}`],
    ["a second role", "main.tf", 'resource "auth0_role" "user" {', 'resource "auth0_role" "admin" {\n  name = "x402-admin"\n}\n\nresource "auth0_role" "user" {', `the one role must be ${ROLE}`],
    ["a role with a second permission", "main.tf", /(\n  permissions \{\n[^}]*\})/, '$1\n  permissions {\n    name                       = "read:users"\n    resource_server_identifier = "https://x402-dev.us.auth0.com/api/v2/"\n  }', ROLE_HOLDS],
    ["a role holding a permission of another API", "main.tf", /(permissions \{\n\s+name\s*= local\.permission\n\s+resource_server_identifier\s*= )auth0_resource_server\.identity\.identifier/, "$1auth0_resource_server.payments.identifier", ROLE_HOLDS],
    ["a portal client with a secret", "main.tf", /(resource "auth0_client_credentials" "portal" \{[\s\S]*?authentication_method\s*=\s*)"none"/, '$1"client_secret_post"', PORTAL_PUBLIC],
    ["a confidential portal client", "main.tf", 'app_type        = "spa"', 'app_type        = "regular_web"', PORTAL_PUBLIC],
    ["an agent CLI client with a secret", "main.tf", /(resource "auth0_client_credentials" "agent_cli" \{[\s\S]*?authentication_method\s*=\s*)"none"/, '$1"client_secret_basic"', CLI_PUBLIC],
    ["a portal client with the implicit grant", "main.tf", '["authorization_code", "refresh_token"]', '["authorization_code", "refresh_token", "implicit"]', PORTAL_GRANT],
    ["a portal client with the device grant", "main.tf", '["authorization_code", "refresh_token"]', `["authorization_code", "refresh_token", "${DEVICE_GRANT}"]`, PORTAL_GRANT],
    ["an agent CLI client that can use the authorization code", "main.tf", `["${DEVICE_GRANT}"]`, `["${DEVICE_GRANT}", "authorization_code"]`, CLI_GRANT],
    ["an agent CLI client with refresh tokens", "main.tf", `["${DEVICE_GRANT}"]`, `["${DEVICE_GRANT}", "refresh_token"]`, CLI_GRANT],
    ["an agent CLI client with a callback", "main.tf", 'app_type        = "native"', 'app_type        = "native"\n  callbacks       = ["http://localhost:8080"]', "the agent CLI's client must have no callback, origin or logout URL: the device flow needs none"],
    ["a fourth client", "main.tf", 'resource "auth0_client" "portal" {', 'resource "auth0_client" "admin" {\n  name = "admin"\n}\n\nresource "auth0_client" "portal" {', "the clients must be exactly L2's, the portal's and the agent CLI's"],
    ["a second callback URL", "main.tf", `concat(["${LOCAL_PORTAL}"], `, `concat(["${LOCAL_PORTAL}", "https://portal.example"], `, PORTAL_URLS],
    ["another local origin", "main.tf", `"${LOCAL_PORTAL}"`, '"http://localhost:3000"', PORTAL_URLS],
    ["a callback written in the client", "main.tf", /callbacks(\s*)= local\.portal_origins/, 'callbacks$1= ["https://portal.example/callback"]', PORTAL_URLS],
    ["a cross-origin URL of its own", "main.tf", /(\n  web_origins\s*= local\.portal_origins)/, "$1\n  allowed_origins     = local.portal_origins", PORTAL_URLS],
    ["a wildcard portal origin", "variables.tf", 'can(regex("^https://[a-z0-9][a-z0-9.-]*$", var.portal_origin))', 'startswith(var.portal_origin, "https://")', "var.portal_origin must be empty or one https origin: a host, with no path, port, wildcard or trailing slash"],
    ["refresh tokens that don't rotate", "main.tf", 'rotation_type                = "rotating"', 'rotation_type                = "non-rotating"', "the portal client's refresh tokens must rotate and expire"],
    ["refresh tokens that never expire", "main.tf", "infinite_token_lifetime      = false", "infinite_token_lifetime      = true", "the portal client's refresh tokens must rotate and expire"],
    ["an Action that replaces the tenant's flow", "main.tf", /resource "auth0_trigger_action" "sign_in_time" \{\n\s+trigger\s*= "post-login"\n\s+action_id\s*= auth0_action\.sign_in_time\.id\n\}/, 'resource "auth0_trigger_actions" "sign_in_time" {\n  trigger = "post-login"\n  actions {\n    id           = auth0_action.sign_in_time.id\n    display_name = "x"\n  }\n}', ONE_ACTION],
    ["an Action with a secret", "main.tf", /(\n  supported_triggers \{)/, '\n  secrets {\n    name  = "KEY"\n    value = "abc"\n  }\n$1', ONE_ACTION],
    ["an Action on another trigger", "main.tf", /(supported_triggers \{\n\s+id\s*= )"post-login"/, '$1"credentials-exchange"', ONE_ACTION],
    ["Action code written elsewhere", "main.tf", 'code    = file("${path.module}/sign-in-time.js")', 'code    = "exports.onExecutePostLogin = async () => {};"', ONE_ACTION],
    ["a second Action", "main.tf", 'resource "auth0_action" "sign_in_time" {', 'resource "auth0_action" "other" {\n  name = "other"\n  code = "x"\n}\n\nresource "auth0_action" "sign_in_time" {', ONE_ACTION],
    ["another claim name in Terraform", "main.tf", `auth_time_claim   = "${AUTH_TIME_CLAIM}"`, 'auth_time_claim   = "https://example.com/auth_time"', `local.auth_time_claim must be ${AUTH_TIME_CLAIM}, the services' default AUTH_TIME_CLAIM`],
    ["an Action that also writes the ID token", ACTION_FILE, /(\n\s+api\.accessToken\.setCustomClaim\(CLAIM, [^\n]+)/, "$1\n    api.idToken.setCustomClaim(CLAIM, 1);", ONE_CLAIM],
    ["an Action that writes a second claim", ACTION_FILE, /(\n\s+api\.accessToken\.setCustomClaim\(CLAIM, [^\n]+)/, '$1\n    api.accessToken.setCustomClaim("https://x402.dev/roles", []);', ONE_CLAIM],
    ["an Action that writes a claim without a namespace", ACTION_FILE, `"${AUTH_TIME_CLAIM}"`, '"auth_time"', ONE_CLAIM],
    ["an Action that refuses sign-ins", ACTION_FILE, /(\n\s+api\.accessToken\.setCustomClaim\(CLAIM, [^\n]+)/, '$1\n    api.access.deny("no");', ONE_CLAIM],
    ["a role assigned to a person", "main.tf", 'resource "auth0_role_permissions" "user" {', 'resource "auth0_user_roles" "someone" {\n  user_id = var.approver_user_id\n  roles   = [auth0_role.user.id]\n}\n\nresource "auth0_role_permissions" "user" {', NOBODY_ASSIGNED],
    ["a connection with a password in code", "main.tf", 'resource "auth0_role" "user" {', 'resource "auth0_connection" "db" {\n  name     = "db"\n  strategy = "auth0"\n  options {\n    password = "x"\n  }\n}\n\nresource "auth0_role" "user" {', "users and passwords are never managed here"],
    ["the portal's client on the agent's allow-list", "outputs.tf", "agentClientIds = [auth0_client.agent_cli.client_id]", "agentClientIds = [auth0_client.agent_cli.client_id, auth0_client.portal.client_id]", IDENTITY_OUTPUT],
    ["an identity output for the approval API", "outputs.tf", /(output "bicepparam_identity" \{[\s\S]*?audience\s*= )auth0_resource_server\.identity\.identifier/, "$1auth0_resource_server.payments.identifier", IDENTITY_OUTPUT],
    ["an identity output missing the audience", "outputs.tf", /(output "bicepparam_identity" \{[\s\S]*?)\n\s+audience\s*= auth0_resource_server\.identity\.identifier/, "$1", "output bicepparam_identity must have exactly the identity keys of the parameter file (agentClientIds, audience, issuer), got agentClientIds, issuer"],
    ["the agent CLI's client as the portal's client ID", "outputs.tf", /(output "bicepparam_portal_client_id" \{[\s\S]*?value\s*= )auth0_client\.portal\.client_id/, "$1auth0_client.agent_cli.client_id", "output bicepparam_portal_client_id must be the portal client's ID (userAccounts.portalClientId)"],
  ])("013 must fail: %s is reported", (_label, file, from, to, message) => {
    expect(auth0Problems(mutate(load(), file, from, to))).toContain(message);
  });

  it("013: the Action, run against a stand-in for Auth0's api, sets the one claim to the most recent sign-in time and nothing else", async () => {
    const source = load().all[ACTION_FILE]!;
    expect(await actionProblems(source)).toEqual([]);
    expect(await runAction(source, signIn(FIRST, LAST))).toEqual([["accessToken.setCustomClaim", [AUTH_TIME_CLAIM, 1794305130]]]);
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

  it("must fail: a private key in the folder, committed state, and missing ignores are reported", () => {
    const s = load();
    const withKey = { ...s, all: { ...s.all, "key.pem": "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n", "terraform.tfstate": "{}" } };
    expect(auth0Problems(withKey)).toEqual(expect.arrayContaining(["key.pem holds a private key", "terraform.tfstate must not be committed"]));
    expect(auth0Problems({ ...s, all: { ...s.all, "dev.tfvars": 'environment = "dev"\n' } })).toContain("dev.tfvars must not be committed");
    expect(auth0Problems({ ...s, gitignore: s.gitignore.replace("auth0/*.tfvars\n", "") })).toContain(".gitignore must have auth0/*.tfvars");
    const ignores = { ...s, gitignore: s.gitignore.replace("auth0/*.tfstate\n", ""), dockerignore: s.dockerignore.replace("auth0\n", "") };
    expect(auth0Problems(ignores)).toEqual(expect.arrayContaining([".gitignore must have auth0/*.tfstate", ".dockerignore must exclude auth0"]));
  });

  it("the pipeline (provision-auth0.yml) has no problem", () => {
    expect(pipelineProblems(load())).toEqual([]);
  });

  const SECRET_SCOPE = "the secrets must reach only the plan and apply steps, as their environment: never the job, another step or a script";
  const VARS_SCOPE = "the variables must reach only the plan step, and no tfvars file or -var argument may be used";
  const VARS_WIRED = "Terraform's variables must come from the GitHub environment's variables, as TF_VAR_* in the plan step: all seven wired, the four without a usable default required";
  const KEY_ONLY = 'the pipeline must provision credential = "key" only, and never hold L2\'s client secret (Constitution V)';
  const ONLY_APPLY = "the only change to the tenant must be the apply step, when the apply input is checked, applying exactly the saved plan";
  it.each<[string, string | RegExp, string, string]>([
    ["a run on every push", "on:\n  workflow_dispatch:", "on:\n  push:\n    branches: [main]\n  workflow_dispatch:", "the pipeline must run by hand only (workflow_dispatch): never on a push, a pull request or a schedule"],
    ["write permission on the repository", "  contents: read", "  contents: write", "the pipeline's permissions must be id-token: write and contents: read only"],
    ["the deploy environment", "    environment: auth0-${{ inputs.environment }}", "    environment: ${{ inputs.environment }}", "the pipeline's one job must run in the GitHub environment auth0-<environment>, which holds the Auth0 credential, never the deploy environment"],
    ["cancelled runs", "  cancel-in-progress: false", "  cancel-in-progress: true", "the pipeline must hold the concurrency group provision-auth0 without cancelling: one run at a time for the tenant"],
    ["another secret", "          VAR_tenant_domain: ${{ vars.AUTH0_TENANT_DOMAIN }}", "          PAYER: ${{ secrets.PAYER_PRIVATE_KEY }}\n          VAR_tenant_domain: ${{ vars.AUTH0_TENANT_DOMAIN }}", "the pipeline reads secrets.PAYER_PRIVATE_KEY: only its two secrets and its Terraform variables may be read"],
    ["a GitHub variable", "  TF_INPUT: \"0\"", "  TF_INPUT: \"0\"\n  TENANT: ${{ vars.AUTH0_DOMAIN }}", "the pipeline reads vars.AUTH0_DOMAIN: only its two secrets and its Terraform variables may be read"],
    ["a variable in every step", "  TF_INPUT: \"0\"", "  TF_INPUT: \"0\"\n  TENANT: ${{ vars.AUTH0_TENANT_DOMAIN }}", VARS_SCOPE],
    ["a tfvars file", '-out="$RUNNER_TEMP/auth0.tfplan"\n          {\n            echo "### Plan', '-var-file="$ENVIRONMENT.tfvars" -out="$RUNNER_TEMP/auth0.tfplan"\n          {\n            echo "### Plan', VARS_SCOPE],
    ["a variable that is never set", "          VAR_guardian_policy: ${{ vars.AUTH0_GUARDIAN_POLICY }}\n", "", VARS_WIRED],
    ["a portal origin that never reaches Terraform", "client_public_key_pem manage_guardian guardian_policy portal_origin; do", "client_public_key_pem manage_guardian guardian_policy; do", VARS_WIRED],
    ["a summary without the identity values", "            terraform -chdir=auth0 output -json bicepparam_identity\n", "", "the apply step must show the output bicepparam_identity in the run's summary, for infra/main.<environment>.bicepparam"],
    ["a variable taken from another one", "VAR_approver_user_id: ${{ vars.AUTH0_APPROVER_USER_ID }}", "VAR_approver_user_id: ${{ vars.AUTH0_TENANT_DOMAIN }}", VARS_WIRED],
    ["a plan with a placeholder", 'if [[ "${!source}" == REPLACE_ME ]]; then', 'if [[ "${!source}" == NEVER ]]; then', "the plan step must refuse a variable that still holds infra/github-setup.sh's placeholder, before it plans"],
    ["an approver that may be missing", " approver_user_id:AUTH0_APPROVER_USER_ID", "", VARS_WIRED],
    ["a public key that may be missing", " client_public_key_pem:AUTH0_CLIENT_PUBLIC_KEY; do", "; do", VARS_WIRED],
    ["L2's client secret in GitHub", "          VAR_tenant_domain: ${{ vars.AUTH0_TENANT_DOMAIN }}", "          L2_CLIENT_SECRET: ${{ secrets.AUTH0_L2_CLIENT_SECRET }}\n          VAR_tenant_domain: ${{ vars.AUTH0_TENANT_DOMAIN }}", KEY_ONLY],
    ["a credential kind chosen by a variable", 'export TF_VAR_environment="$ENVIRONMENT" TF_VAR_credential=key', 'export TF_VAR_environment="$ENVIRONMENT" TF_VAR_credential="$VAR_credential"', KEY_ONLY],
    ["the credential in every step", "  TF_INPUT: \"0\"", "  TF_INPUT: \"0\"\n  AUTH0_CLIENT_SECRET: ${{ secrets.AUTH0_CLIENT_SECRET }}", SECRET_SCOPE],
    ["the credential in the tests step", "        id: tests\n", "        id: tests\n        env:\n          AUTH0_CLIENT_SECRET: ${{ secrets.AUTH0_CLIENT_SECRET }}\n", SECRET_SCOPE],
    ["an input pasted into a script", 'if [[ ! "$ENVIRONMENT" =~', 'if [[ ! "${{ inputs.environment }}" =~', "an input is never pasted into a script"],
    ["an Azure client secret", "  ARM_USE_AZUREAD: \"true\"", "  ARM_USE_AZUREAD: \"true\"\n  ARM_CLIENT_SECRET: abc", "the pipeline must hold no Azure credential and no Auth0 token: OIDC for the state, the Management API application for Auth0"],
    ["a state read with the account key", "  ARM_USE_AZUREAD: \"true\"", "  ARM_USE_AZUREAD: \"false\"", "the state's sign-in must be OIDC as the deploy app of the parameter file, with Entra authorization (ARM_USE_OIDC, ARM_USE_AZUREAD)"],
    ["an unchecked Terraform download", /\n +echo "\$TERRAFORM_SHA256 {2}\$RUNNER_TEMP\/terraform\.zip" \| sha256sum -c -/, "", "Terraform must be pinned by version and checked against its SHA-256 before it runs"],
    ["a provider the lock file doesn't pin", "init -lockfile=readonly", "init -upgrade", "init must use the provider exactly as .terraform.lock.hcl pins it (-lockfile=readonly)"],
    ["another state container", 'container_name=tfstate"', 'container_name=state"', "the state must be the blob auth0.<environment>.tfstate in the container and account of infra/pre-deploy.<environment>.bicepparam (names.stateStorage)"],
    ["one state for every environment", 'key=auth0.$ENVIRONMENT.tfstate"', 'key=auth0.tfstate"', "the state must be the blob auth0.<environment>.tfstate in the container and account of infra/pre-deploy.<environment>.bicepparam (names.stateStorage)"],
    ["no offline checks", "npx vitest run test/auth0-iac.test.ts", "true", "the offline checks (T-IAC-02) must run before init"],
    ["an apply on every run", "        if: ${{ inputs.apply }}\n", "", ONLY_APPLY],
    ["an apply of a new plan", 'apply -no-color -lock-timeout=120s "$RUNNER_TEMP/auth0.tfplan"', "apply -no-color -lock-timeout=120s -auto-approve", ONLY_APPLY],
    ["a destroy", "          terraform -chdir=auth0 validate -no-color", "          terraform -chdir=auth0 destroy -auto-approve", ONLY_APPLY],
    ["a plan that isn't shown", '          } >> "$GITHUB_STEP_SUMMARY"\n\n      # Exactly', "          } > /dev/null\n\n      # Exactly", "the plan must be saved, and be shown in the run's summary"],
  ])("must fail (pipeline): %s is reported", (_label, from, to, message) => {
    const s = load();
    expect(typeof from === "string" ? s.workflow.includes(from) : from.test(s.workflow), "the workflow contains the mutation anchor").toBe(true);
    expect(pipelineProblems({ ...s, workflow: s.workflow.replace(from, () => to) })).toContain(message);
  });

  it("013 must fail (pipeline): a set-up script that creates the portal's origin, which has no value yet, is reported", () => {
    const s = load();
    const anchor = '  "AUTH0_GUARDIAN_POLICY=never"\n';
    expect(s.setup.includes(anchor), "github-setup.sh contains the mutation anchor").toBe(true);
    expect(pipelineProblems({ ...s, setup: s.setup.replace(anchor, `${anchor}  "AUTH0_PORTAL_ORIGIN=$PLACEHOLDER"\n`) })).toContain(
      "infra/github-setup.sh must create exactly the variables the pipeline reads, but the ones set later (the portal's origin)",
    );
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
