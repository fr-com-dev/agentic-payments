# The Auth0 tenant for backchannel approval (SPEC L2-7; specs/012 research R17), as code. Applied by a tenant
# administrator by hand, like infra/pre-deploy.bicep: no pipeline runs it. Azure stays Bicep only; this folder holds
# only what Auth0 needs. T-IAC-02 (test/auth0-iac.test.ts) checks it.
terraform {
  # 1.11 or later: the client secret (credential = "secret") is a write-only argument, never stored in state.
  required_version = ">= 1.11.0"

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
# environment only (AUTH0_CLIENT_ID and AUTH0_CLIENT_SECRET, or AUTH0_API_TOKEN), never from a file.
provider "auth0" {
  domain = var.tenant_domain
}
