# The Auth0 tenant for backchannel approval (SPEC L2-7; specs/012 research R17) and for people's sign-in (specs/013
# research R19), as code. Applied by its pipeline,
# .github/workflows/provision-auth0.yml, by hand: a plan on every run, and that plan applied when asked. Azure stays
# Bicep only; this folder holds only what Auth0 needs. T-IAC-02 (test/auth0-iac.test.ts) checks it.
terraform {
  # 1.11 or later: the client secret (credential = "secret") is a write-only argument, never stored in state.
  required_version = ">= 1.11.0"

  # The state is a blob in the storage account infra/pre-deploy.bicep makes, read and written with an Entra sign-in
  # only (the account has no key access). The account, container and key come from the pipeline (-backend-config),
  # which takes them from infra/pre-deploy.<environment>.bicepparam; no value is written here.
  backend "azurerm" {
    use_azuread_auth = true
  }

  required_providers {
    auth0 = {
      source = "auth0/auth0"
      # 1.34.0 added async_approval_notification_channels (CIBA) and 1.47.0 the credentials set; 1.60.0 is the
      # version this was written against (2026-11-08).
      version = ">= 1.60.0, < 2.0.0"
    }
  }
}

# The domain is a variable; the credentials of the Management API application that applies this come from the
# environment only (AUTH0_CLIENT_ID and AUTH0_CLIENT_SECRET, secrets of the pipeline's GitHub environment), never
# from a file.
provider "auth0" {
  domain = var.tenant_domain
}
