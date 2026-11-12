# What Auth0 needs for L2's backchannel approval (SPEC L2-7, specs/012 quickstart §2): the approval API with its
# payment-details type, L2's CIBA client and its credential, the grant that lets only that client request the type,
# and Guardian push. Least privilege throughout: the client can do CIBA and nothing else, and no other client and no
# machine token can request the payment details. Users, passwords and private keys are never managed here.
#
# And what people's sign-in needs (SPEC L2-8 and L1-6, specs/013 research R19), further down: one API with one
# permission, the role that holds it, the portal's public client and the post-login Action that dates the sign-in.
# The tenant has two applications, L2's and the portal's: none for the hosted agent service (research R20). No user
# is created and no role is assigned here: an administrator does that in Auth0.

locals {
  # Must equal DETAILS_TYPE in src/layer2-control/payment-details.ts (T-IAC-02): Auth0's Guardian schema, the only
  # format the stock Guardian app displays (specs/012 research R4).
  details_type = "urn:auth0:schemas:authorization-details:v1:x402-payment"
  issuer       = "https://${var.tenant_domain}/"

  # People's sign-in. The API's identifier is the portal's AUTH_AUDIENCE; it can't change
  # once created. The claim is the services' default AUTH_TIME_CLAIM, and the one sign-in-time.js writes (T-IAC-02).
  identity_audience = "https://x402-api/${var.environment}"
  permission        = "agent:run"
  auth_time_claim   = "https://x402.dev/auth_time"
  # The local portal (its default port), and the deployed one once var.portal_origin is set.
  portal_origins = concat(["http://localhost:4025"], var.portal_origin == "" ? [] : [var.portal_origin])
}

# The approver must already exist (plan fails otherwise). Their Guardian enrollment is theirs to do, on their phone.
data "auth0_user" "approver" {
  user_id = var.approver_user_id
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
  description                          = "x402 L2 control (${var.environment}): asks the approver to approve escalated payments, by CIBA (SPEC L2-7). No user signs in to it."
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
resource "auth0_guardian" "this" {
  count  = var.manage_guardian ? 1 : 0
  policy = var.guardian_policy

  push {
    enabled  = true
    provider = "guardian"
  }

  lifecycle {
    prevent_destroy = true
  }
}

# ---- People's sign-in (specs/013 research R19) ---------------------------------------------------------------------

# People's API: its identifier is the portal's AUTH_AUDIENCE. RBAC is enforced and the permissions go into the access
# token (the default token profile, which names the client as azp), so a token says what its person may do, and the
# portal verifies it offline. Refresh tokens are allowed, for the web app's rotation.
# Tokens live an hour: a role taken from a person stays in their tokens no longer than that.
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

# Its one permission: the same grant opens the portal and starts runs. The two services tell their clients apart by
# client ID, never by permission.
resource "auth0_resource_server_scopes" "identity" {
  resource_server_identifier = auth0_resource_server.identity.identifier

  scopes {
    name        = local.permission
    description = "Use the x402 portal, as oneself"
  }
}

# The one role, with exactly that permission. An administrator assigns it per person, in Auth0: nobody is assigned
# here, and no user is created.
resource "auth0_role" "user" {
  name        = "x402-user"
  description = "May onboard at the x402 portal and use it (${var.environment})."
}

resource "auth0_role_permissions" "user" {
  role_id = auth0_role.user.id

  permissions {
    name                       = local.permission
    resource_server_identifier = auth0_resource_server.identity.identifier
  }

  depends_on = [auth0_resource_server_scopes.identity]
}

# The portal's web app: a public single-page client. Authorization code with PKCE (a public client has no other way
# to use the code), and the refresh_token grant only because its refresh tokens rotate. Its client ID is
# PORTAL_CLIENT_ID: the only client whose tokens the portal accepts. It is the only client for people: none exists for
# the hosted agent service, so no person's token from this tenant starts a run there (specs/013 research R20).
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

# The post-login Action: it writes the time of the person's most recent authentication on the access token, as
# local.auth_time_claim (Auth0 puts auth_time in the ID token only). L2 judges from it whether a loosening policy
# change follows a fresh sign-in. It sets nothing else, holds no secret and uses no package. T-IAC-02 runs its code.
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
