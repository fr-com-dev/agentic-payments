# What Auth0 needs for L2's backchannel approval (SPEC L2-7, specs/012 quickstart §2): the approval API with its
# payment-details type, L2's CIBA client and its credential, the grant that lets only that client request the type,
# and Guardian push. Least privilege throughout: the client can do CIBA and nothing else, and no other client and no
# machine token can request the payment details. Users, passwords and private keys are never managed here.

locals {
  # Must equal DETAILS_TYPE in src/layer2-control/payment-details.ts (T-IAC-02): Auth0's Guardian schema, the only
  # format the stock Guardian app displays (specs/012 research R4).
  details_type = "urn:auth0:schemas:authorization-details:v1:x402-payment"
  issuer       = "https://${var.tenant_domain}/"
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
