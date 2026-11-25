# What Auth0 needs for L2's backchannel approval (SPEC L2-7, specs/012 quickstart §2): the approval API with its
# payment-details type, L2's CIBA client and its credential, the grant that lets only that client request the type,
# and Guardian push. Least privilege throughout: the client can do CIBA and nothing else, and no other client and no
# machine token can request the payment details. Users, passwords and private keys are never managed here.
#
# And what people's sign-in needs (SPEC L2-8, specs/013 research R19), further down: one API, the portal's public
# client and the post-login Actions that date the sign-in and its second factor, and ask an administrator for one.
# Using the portal needs no permission and no role (research R21): whoever signs in through the portal's client may
# use it, for their own account only.
#
# And what the hosted agent's callers need (specs/016 research R9, R10), last: the agent's public client, through
# which the agent's docs page signs a person in, and one confidential client per machine caller, with a key and no
# secret. The tenant's applications are exactly L2's, the portal's, the agent's, the desktop client (019) and the
# machine callers' (T-IAC-02 fails on any other). People's API has two permissions, portal:admin (014) and agent:run (016), each held by one
# role. A tenant administrator assigns a role per person, by hand: nobody is assigned here, and no user is created
# here. To keep one person out, block that user in Auth0.
#
# And how people sign in (SPEC v1.28, specs/018), after the callers: email and password, and Google, each enabled for
# the portal's and the agent's clients only. Google sign-up is public by design: a first Google sign-in makes a person
# with no role, through the project's own Google application. Email-and-password sign-up follows var.allow_sign_ups,
# through the database connection's own Disable Sign Ups, the one switch: no Action refuses sign-ups (T-IAC-02 rule 6),
# so the operator can still add a person in the Dashboard. var.google_sign_in false stops Google sign-in in an
# emergency, for existing Google people too.
#
# And the desktop client (SPEC v1.29, specs/019): a person signs in from their own computer, in their browser, and the
# sign-in returns to a fixed loopback address there, with PKCE and rotating refresh tokens. The first post-login
# Action refuses a desktop sign-in, and a renewal, to anyone without x402-agent, and any PKCE method but S256.

locals {
  # Must equal DETAILS_TYPE in src/layer2-control/payment-details.ts (T-IAC-02): Auth0's Guardian schema, the only
  # format the stock Guardian app displays (specs/012 research R4).
  details_type = "urn:auth0:schemas:authorization-details:v1:x402-payment"
  issuer       = "https://${var.tenant_domain}/"

  # People's sign-in. The API's identifier is the services' AUTH_AUDIENCE; it can't change
  # once created. The claim is the services' default AUTH_TIME_CLAIM, and the one sign-in-time.js writes (T-IAC-02).
  identity_audience = "https://x402-api/${var.environment}"
  admin_permission  = "portal:admin"
  # Must equal AGENT_RUN_PERMISSION in src/shared/identity-token.ts (T-IAC-02): what the agent and L2 look for.
  agent_permission = "agent:run"
  auth_time_claim  = "https://x402.dev/auth_time"
  # The time of the latest second factor, written by mfa-time.js: the services require it, fresh, for an
  # administrator's decision (Phase 3).
  mfa_time_claim = "https://x402.dev/mfa_time"
  # The local portal (its default port) only where var.local_origins is on (dev), and the deployed one once
  # var.portal_origin is set. A deployed environment's client accepts no localhost address.
  portal_origins = concat(var.local_origins ? ["http://localhost:4025"] : [], var.portal_origin == "" ? [] : [var.portal_origin])
  # The agent's docs page: the local agent (its default port, under both names a browser may use) only where
  # var.local_origins is on, and the deployed one once var.agent_origin is set. The page's sign-in returns to one
  # address under each origin, and nowhere else.
  agent_origins   = concat(var.local_origins ? ["http://localhost:4024", "http://127.0.0.1:4024"] : [], var.agent_origin == "" ? [] : [var.agent_origin])
  agent_callbacks = [for origin in local.agent_origins : "${origin}/docs/oauth2-redirect.html"]
  # 019: the desktop client returns to the person's own computer, at one fixed port, under both names a browser may
  # use. Not under var.local_origins: these addresses are never a page an environment serves, so every environment's
  # desktop client has exactly these two (RFC 8252 section 7.3).
  desktop_callbacks = ["http://127.0.0.1:53682/callback", "http://localhost:53682/callback"]
}

# The approval API: its identifier is CIBA_AUDIENCE. L2 verifies its access tokens (RS256, RFC 9068 profile, so they
# carry jti) and nothing else consumes them, so they live 5 minutes and are never refreshed.
resource "auth0_resource_server" "payments" {
  name                 = "api-x402-payments-${var.environment}"
  identifier           = var.api_identifier
  signing_alg          = "RS256"
  token_dialect        = "rfc9068_profile"
  token_lifetime       = 300
  allow_offline_access = false

  # Standard consent. The provider takes the string "null" for it; CIBA is not supported with
  # transactional-authorization-with-mfa (Auth0's RAR guide).
  consent_policy = "null"

  authorization_details {
    type = local.details_type
  }

  # Only clients with a user-delegated grant may request the type (auth0_client_grant.l2_ciba below), and no client
  # gets a machine-to-machine token for this API.
  subject_type_authorization {
    user {
      policy = "require_client_grant"
    }
    client {
      policy = "deny_all"
    }
  }
}

# L2's client: confidential, first-party, OIDC-conformant, with the CIBA grant only, notifying by Guardian push only.
# Its client ID is CIBA_CLIENT_ID.
resource "auth0_client" "l2" {
  name                                 = "app-l2-ciba-${var.environment}"
  description                          = "x402 L2 control (${var.environment}): asks the person an escalated payment is for to approve it, by CIBA (SPEC L2-7). No user signs in to it."
  app_type                             = "regular_web"
  is_first_party                       = true
  oidc_conformant                      = true
  grant_types                          = ["urn:openid:params:grant-type:ciba"]
  async_approval_notification_channels = ["guardian-push"]

  jwt_configuration {
    alg = "RS256"
  }
}

# The user-delegated grant that lets L2's client, and only it, request the payment-details type.
resource "auth0_client_grant" "l2_ciba" {
  client_id                   = auth0_client.l2.client_id
  audience                    = auth0_resource_server.payments.identifier
  subject_type                = "user"
  scopes                      = []
  authorization_details_types = [local.details_type]
}

# How L2 authenticates: private_key_jwt with the public half of its key (preferred: no shared secret exists), or a
# client secret you generate, sent write-only (never in state). RS256 only: Auth0's private_key_jwt never takes ES256.
resource "auth0_client_credentials" "l2" {
  client_id             = auth0_client.l2.client_id
  authentication_method = var.credential == "key" ? "private_key_jwt" : "client_secret_post"

  dynamic "private_key_jwt" {
    for_each = var.credential == "key" ? [1] : []
    content {
      credentials {
        name            = "l2-ciba-${var.environment}"
        credential_type = "public_key"
        pem             = var.client_public_key_pem
        algorithm       = "RS256"
      }
    }
  }

  client_secret_wo         = var.credential == "secret" ? var.client_secret : null
  client_secret_wo_version = var.credential == "secret" ? var.client_secret_version : null

  lifecycle {
    precondition {
      condition     = var.credential != "key" || var.client_public_key_pem != ""
      error_message = "credential = key needs client_public_key_pem: the public half of L2's key."
    }
  }
}

# Guardian push through the Guardian app: CIBA delivers the approval request this way, and only for requests that
# live 300 s or less. A tenant-wide singleton: destroying it would disable every MFA factor, so it never is.
# One-time codes (otp, an authenticator app; the Guardian app shows one too) are on as well (Phase 3): sign-in-time.js
# challenges an administrator with push or a code, and Auth0 skips a factor that is off. Turning a factor on asks
# nobody for it: with guardian_policy never, only that Action asks, and only administrators.
resource "auth0_guardian" "this" {
  count  = var.manage_guardian ? 1 : 0
  policy = var.guardian_policy
  otp    = true

  push {
    enabled  = true
    provider = "guardian"
  }

  lifecycle {
    prevent_destroy = true
  }
}

# The tenant setting without which a post-login Action can't choose the second factor (Auth0's "Customize MFA
# Factors using Actions"): sign-in-time.js's challenge needs it. It sets nothing else of the tenant's, and goes with
# Guardian: where another configuration owns the MFA settings (manage_guardian = false), that one turns it on.
# Removing this resource changes nothing in the tenant.
resource "auth0_tenant" "mfa_actions" {
  count                             = var.manage_guardian ? 1 : 0
  customize_mfa_in_postlogin_action = true
}

# ---- People's sign-in (specs/013 research R19) ---------------------------------------------------------------------

# People's API: its identifier is AUTH_AUDIENCE for the portal, the hosted agent and L2. The token profile is the one
# the sign-in was verified with: it names the client as azp and carries a permissions list. RBAC is enforced, so
# that list holds only the permissions of the person's roles (or of a machine caller's grant), and nobody can ask
# for one. Each service verifies the token offline. Refresh tokens are allowed, for the portal web app's rotation and
# the desktop client's (019). Tokens live an hour. Consent is skipped for first-party clients Auth0 can verify, which a
# loopback return isn't: a desktop sign-in may show a consent screen once (specs/019 Edge Cases).
resource "auth0_resource_server" "identity" {
  name                                            = "api-x402-${var.environment}"
  identifier                                      = local.identity_audience
  signing_alg                                     = "RS256"
  enforce_policies                                = true
  token_dialect                                   = "access_token_authz"
  token_lifetime                                  = 3600
  token_lifetime_for_web                          = 3600
  allow_offline_access                            = true
  skip_consent_for_verifiable_first_party_clients = true

  lifecycle {
    precondition {
      condition     = var.api_identifier != local.identity_audience
      error_message = "api_identifier is the approval API's: it can't be people's API identifier too."
    }
  }
}

# The two permissions of people's API, and the two roles, each of which holds exactly one. Using the portal needs
# neither (research R21). portal:admin (014) opens the portal's administration area, where a person decides other
# people's escalated payments. agent:run (016, research R10) lets its holder start a run at the hosted agent: a
# person through the role below, a machine caller through its grant. A person's token carries the permissions of
# their roles whichever client they signed in through, and each service reads only its own: the portal never reads
# agent:run, and the agent and L2 never read portal:admin. An administrator of the tenant assigns a role per person,
# by hand, in Auth0: nobody is assigned here. Taking a role away takes effect when the person's access token expires
# (an hour at most, above).
resource "auth0_resource_server_scopes" "identity" {
  resource_server_identifier = auth0_resource_server.identity.identifier

  scopes {
    name        = local.admin_permission
    description = "Use the x402 portal's administration area: decide escalated payments"
  }

  scopes {
    name        = local.agent_permission
    description = "Start a run at the x402 hosted agent"
  }
}

resource "auth0_role" "admin" {
  name        = "x402-admin"
  description = "May use the x402 portal's administration area (${var.environment})."
}

resource "auth0_role_permissions" "admin" {
  role_id = auth0_role.admin.id

  permissions {
    name                       = local.admin_permission
    resource_server_identifier = auth0_resource_server.identity.identifier
  }

  depends_on = [auth0_resource_server_scopes.identity]
}

resource "auth0_role" "agent" {
  name        = "x402-agent"
  description = "May start runs at the x402 hosted agent, for their own account (${var.environment})."
}

resource "auth0_role_permissions" "agent" {
  role_id = auth0_role.agent.id

  permissions {
    name                       = local.agent_permission
    resource_server_identifier = auth0_resource_server.identity.identifier
  }

  depends_on = [auth0_resource_server_scopes.identity]
}

# The portal's web app: a public single-page client. Authorization code with PKCE (a public client has no other way
# to use the code), and the refresh_token grant only because its refresh tokens rotate. Its client ID is
# PORTAL_CLIENT_ID: the only client whose tokens the portal accepts. The hosted agent and L2 never accept it: the
# agent's callers have a client of their own, further down, and both refuse to start with this one on
# AGENT_CLIENT_IDS.
resource "auth0_client" "portal" {
  name            = "app-portal-${var.environment}"
  description     = "x402 portal (${var.environment}): people sign in to it to see and change their own profile, account and expense policy."
  app_type        = "spa"
  is_first_party  = true
  oidc_conformant = true
  grant_types     = ["authorization_code", "refresh_token"]

  callbacks           = local.portal_origins
  web_origins         = local.portal_origins
  allowed_logout_urls = local.portal_origins

  jwt_configuration {
    alg = "RS256"
  }

  # A used refresh token is revoked, and using it again revokes its whole family. One lives a day at most, and
  # twelve hours unused.
  refresh_token {
    rotation_type                = "rotating"
    expiration_type              = "expiring"
    token_lifetime               = 86400
    idle_token_lifetime          = 43200
    infinite_token_lifetime      = false
    infinite_idle_token_lifetime = false
    leeway                       = 0
  }
}

# No secret and no key: a browser can't keep one.
resource "auth0_client_credentials" "portal" {
  client_id             = auth0_client.portal.client_id
  authentication_method = "none"
}

# The first post-login Action: it writes the time of the person's most recent authentication on the access token,
# as local.auth_time_claim (Auth0 puts auth_time in the ID token only). L2 judges from it whether a loosening policy
# change follows a fresh sign-in. Phase 3: on an administrator's (auth0_role.admin) interactive sign-in in a browser
# without a second factor as recent as the rest of it, it asks Auth0 for one (push or a one-time code). 019: for the
# desktop client only (its client_metadata x402_client = "agent-desktop"), it first refuses a sign-in or a renewal
# by a person without x402-agent, and a sign-in whose authorization did not use PKCE with S256, then asks for the
# second factor as it does for an administrator. It sets nothing else, holds no secret and uses no package. T-IAC-02
# runs its code.
resource "auth0_action" "sign_in_time" {
  name    = "x402-sign-in-time-${var.environment}"
  runtime = "node22"
  deploy  = true
  code    = file("${path.module}/sign-in-time.js")

  supported_triggers {
    id      = "post-login"
    version = "v3"
  }

  lifecycle {
    precondition {
      condition     = strcontains(file("${path.module}/sign-in-time.js"), "\"${local.auth_time_claim}\"")
      error_message = "sign-in-time.js must write local.auth_time_claim, the claim the services read."
    }
  }
}

# Appended to the tenant's post-login flow: an Action another configuration bound there stays.
resource "auth0_trigger_action" "sign_in_time" {
  trigger   = "post-login"
  action_id = auth0_action.sign_in_time.id
}

# The second post-login Action (Phase 3): it writes the time of the person's most recent second factor on the
# access token, as local.mfa_time_claim. The services require it, fresh, for an administrator's decision on a
# payment. It must run after sign_in_time: Auth0 asks for the second factor an Action requests once that Action has
# run, before the next one, so only an Action bound later sees it. It sets nothing else, holds no secret and uses
# no package. T-IAC-02 runs its code.
resource "auth0_action" "mfa_time" {
  name    = "x402-mfa-time-${var.environment}"
  runtime = "node22"
  deploy  = true
  code    = file("${path.module}/mfa-time.js")

  supported_triggers {
    id      = "post-login"
    version = "v3"
  }

  lifecycle {
    precondition {
      condition     = strcontains(file("${path.module}/mfa-time.js"), "\"${local.mfa_time_claim}\"")
      error_message = "mfa-time.js must write local.mfa_time_claim, the claim the services read."
    }
  }
}

# Appended to the post-login flow after sign_in_time's binding (depends_on): a binding is appended where it is
# created, so this one comes later in a new tenant as in one that already has sign_in_time.
resource "auth0_trigger_action" "mfa_time" {
  trigger   = "post-login"
  action_id = auth0_action.mfa_time.id

  depends_on = [auth0_trigger_action.sign_in_time]
}

# ---- The hosted agent's callers (specs/016 research R9, R10) -------------------------------------------------------

# The agent's client: a public single-page client, for the agent's docs page. Authorization code with PKCE and no
# other grant: no refresh token exists, so a person signs in again when their token expires (an hour). Its client ID
# is API_DOCS_CLIENT_ID and the one entry of AGENT_CLIENT_IDS, for the agent and for L2. The sign-in returns to the
# docs page's redirect address only, and only the docs origins may call the tenant from a browser. Signing in
# through it gives a person nothing by itself: the agent and L2 also require agent:run, from the role above.
resource "auth0_client" "agent" {
  name            = "app-agent-${var.environment}"
  description     = "x402 hosted agent (${var.environment}): people sign in to it from the agent's docs page, to start runs for their own account."
  app_type        = "spa"
  is_first_party  = true
  oidc_conformant = true
  grant_types     = ["authorization_code"]

  callbacks       = local.agent_callbacks
  allowed_origins = local.agent_origins
  web_origins     = local.agent_origins

  jwt_configuration {
    alg = "RS256"
  }
}

# No secret and no key: a browser can't keep one.
resource "auth0_client_credentials" "agent" {
  client_id             = auth0_client.agent.client_id
  authentication_method = "none"
}

# 019: the desktop client, a public native client. A person signs in from their own computer: the browser at the
# tenant, the return to a fixed loopback address (local.desktop_callbacks), the code exchanged with its PKCE verifier,
# then rotating refresh tokens, so they sign in through the browser at most once every 30 days. Its client ID is on
# AGENT_CLIENT_IDS at the agent and at L2, and is the agent's AGENT_DESKTOP_CLIENT_ID. A token from it gives a person
# nothing by itself: the agent and L2 require agent:run, and sign-in-time.js refuses a sign-in or a renewal through it
# without x402-agent, or without S256 (it recognizes the client by client_metadata, never by a secret). A spent
# refresh token presented again revokes its whole family (leeway 0).
resource "auth0_client" "desktop" {
  name            = "app-agent-desktop-${var.environment}"
  description     = "x402 hosted agent (${var.environment}): people sign in to it from a desktop client on their own computer (browser, loopback return, PKCE), to start runs for their own account."
  app_type        = "native"
  is_first_party  = true
  oidc_conformant = true
  grant_types     = ["authorization_code", "refresh_token"]

  callbacks = local.desktop_callbacks

  client_metadata = {
    x402_client = "agent-desktop"
  }

  jwt_configuration {
    alg = "RS256"
  }

  refresh_token {
    rotation_type                = "rotating"
    expiration_type              = "expiring"
    token_lifetime               = 2592000
    idle_token_lifetime          = 604800
    infinite_token_lifetime      = false
    infinite_idle_token_lifetime = false
    leeway                       = 0
  }
}

# No secret and no key: a program on a person's computer can't keep one. Declared, not left to the provider's
# default, which isn't documented.
resource "auth0_client_credentials" "desktop" {
  client_id             = auth0_client.desktop.client_id
  authentication_method = "none"
}

# One confidential client per machine caller (var.machine_caller_keys: its name and the public half of its key). Its
# only grant type is client credentials, so it can't sign a person in, and it has no callback. The first one is
# `checks`: the deployment pipeline's smoke run and scripted regression (research R9).
resource "auth0_client" "machine" {
  for_each = var.machine_caller_keys

  name            = "app-machine-${each.key}-${var.environment}"
  description     = "x402 machine caller ${each.key} (${var.environment}): a system that starts runs at the hosted agent, for the platform account. No person signs in to it."
  app_type        = "non_interactive"
  is_first_party  = true
  oidc_conformant = true
  grant_types     = ["client_credentials"]

  jwt_configuration {
    alg = "RS256"
  }
}

# How a machine caller authenticates: private_key_jwt with the public half of its key, and nothing else. No secret
# exists, so none is in the state or in GitHub (FR-022); the private half is held where the caller runs (the l1
# vault's machine-client-key for `checks`). RS256 only: Auth0's private_key_jwt never takes ES256.
resource "auth0_client_credentials" "machine" {
  for_each = var.machine_caller_keys

  client_id             = auth0_client.machine[each.key].client_id
  authentication_method = "private_key_jwt"

  private_key_jwt {
    credentials {
      name            = "machine-${each.key}-${var.environment}"
      credential_type = "public_key"
      pem             = each.value
      algorithm       = "RS256"
    }
  }
}

# A machine caller's one grant: client credentials for people's API, with agent:run and nothing else. It never gets
# portal:admin, and it has no grant for the approval API (whose policy refuses every machine token anyway).
resource "auth0_client_grant" "machine" {
  for_each = var.machine_caller_keys

  client_id = auth0_client.machine[each.key].client_id
  audience  = auth0_resource_server.identity.identifier
  scopes    = [local.agent_permission]

  depends_on = [auth0_resource_server_scopes.identity]
}

# ---- People's connections (specs/018) ------------------------------------------------------------------------------

# How a person signs in: email and password, or Google, and nothing else (T-IAC-02 fails on a third connection). Only
# the portal's and the agent's clients, and the desktop client (019), may use them. L2's approval client asks a person for an approval by Guardian
# push and needs no connection, and a machine caller signs nobody in (research R3). Google sign-up is public by
# design: a first Google sign-in creates the person, with no role. Email-and-password sign-up follows
# var.allow_sign_ups.

# Google's connection is read here, never managed: managing it would put the Google application's secret in the
# state, and its write-only variant would keep that secret on the operator's host (research R4). The tenant holds the
# secret, entered in its Dashboard by hand (quickstart section 1). hide_client_secret keeps it out of the state, and
# the clients that may use Google are auth0_connection_clients.google's, below.
data "auth0_connection" "google" {
  name                 = "google-oauth2"
  hide_client_secret   = true
  skip_enabled_clients = true
}

# The email-and-password connection, imported (auth0/README.md, "Move to a new state"). Its own Disable Sign Ups is
# the one switch (research R1): with var.allow_sign_ups false, Auth0 refuses every self-service sign-up (the page,
# the sign-up address and the public endpoint) and the page shows no Sign up link, while the operator can still create
# a person in the Dashboard. Auth0 replaces the whole options object on an update, so every option is written out,
# with the dev tenant's values as its first plan read them on 2026-11-24 (research R2): the first plan after the
# import must change disable_signup and nothing else. If it shows another change, make this block match the tenant,
# never the other way, and never apply a plan that changes the password policy (quickstart section 3). The password
# policy is Auth0's flexible one, password_options; the provider refuses it together with the legacy fields
# (password_policy, password_complexity_options, password_history, password_dictionary, password_no_personal_info),
# so T-IAC-02 fails on any of those. It holds every email-and-password person, so it is never destroyed, and the
# Management API credential has no delete:connections.
resource "auth0_connection" "database" {
  name     = "Username-Password-Authentication"
  strategy = "auth0"

  options {
    disable_signup                 = !var.allow_sign_ups
    brute_force_protection         = true
    requires_username              = false
    import_mode                    = false
    enabled_database_customization = false
    strategy_version               = 2

    password_options {
      complexity {
        min_length            = 15
        character_type_rule   = "all"
        character_types       = []
        identical_characters  = "allow"
        sequential_characters = "allow"
        max_length_exceeded   = "error"
      }

      dictionary {
        active  = false
        default = "en_100k"
        custom  = []
      }

      history {
        active = false
        size   = 3
      }

      profile_data {
        active = false
        blocked_fields = [
          "email",
          "name",
          "nickname",
          "phone_number",
          "user_metadata.first",
          "user_metadata.last",
          "user_metadata.name",
          "username",
        ]
      }
    }

    authentication_methods {
      password {
        enabled         = true
        api_behavior    = "required"
        signup_behavior = "allow"
      }

      passkey {
        enabled = false
      }
    }

    passkey_options {
      challenge_ui                   = "both"
      local_enrollment_enabled       = true
      progressive_enrollment_enabled = true
    }

    mfa {
      active                 = true
      return_enroll_settings = true
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

# The clients that may sign a person in through each connection: the portal's, the agent's and the desktop client
# (019), nothing else. Each
# list is authoritative: a client enabled by hand in the Dashboard shows in the next plan, and the apply takes it off
# again (FR-018). An existing tenant imports both lists first: creating one fails on a connection that already has
# clients.
resource "auth0_connection_clients" "database" {
  connection_id   = auth0_connection.database.id
  enabled_clients = [auth0_client.portal.client_id, auth0_client.agent.client_id, auth0_client.desktop.client_id]
}

# var.google_sign_in false is the emergency stop: no client may use Google, which stops new Google people and every
# existing one until it is set back (research R6). The precondition stops the plan unless the tenant's Google
# connection runs on the project's own Google application, var.google_client_id: on Auth0's developer keys the
# connection has no client ID, so an empty var.google_client_id never passes. The live check reads the redirect to
# Google (quickstart section 1). Terraform never writes Google's settings, so a change made there by hand fails the
# next plan rather than being undone (FR-018).
resource "auth0_connection_clients" "google" {
  connection_id   = data.auth0_connection.google.id
  enabled_clients = var.google_sign_in ? [auth0_client.portal.client_id, auth0_client.agent.client_id, auth0_client.desktop.client_id] : []

  lifecycle {
    precondition {
      condition     = !var.google_sign_in || (var.google_client_id != "" && try(data.auth0_connection.google.options[0].client_id, "") == var.google_client_id)
      error_message = "The tenant's google-oauth2 connection must use the project's own Google application, google_client_id (specs/018 quickstart section 1): it still runs on Auth0's developer keys or on another Google application, or google_client_id is empty."
    }
  }
}
