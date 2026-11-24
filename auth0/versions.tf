# The Auth0 tenant for backchannel approval (SPEC L2-7; specs/012 research R17), for people's sign-in (specs/013
# research R19) and for the hosted agent's callers (specs/016), as code. Applied by an operator on the operator's host
# with scripts/auth0-tenant.sh (npm run auth0:tenant): a plan saved beside the state, and exactly that plan applied
# when asked (SPEC 1.26). No GitHub workflow changes the tenant; validate-auth0.yml only validates this folder. Azure
# stays Bicep only; this folder holds only what Auth0 needs. T-IAC-02 (test/auth0-iac.test.ts) checks it.
terraform {
  # 1.11 or later: the client secret (credential = "secret") is a write-only argument, never stored in state.
  required_version = ">= 1.11.0"

  # The state is a local file on the operator's host, outside every checkout (SPEC 1.26): by default
  # ~/x402-tfstate/auth0.<environment>.tfstate, mode 0600. scripts/auth0-tenant.sh passes its path (-backend-config);
  # no value is written here. The local backend locks the file, so one run at a time changes the tenant.
  backend "local" {}

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
# environment only (AUTH0_CLIENT_ID and AUTH0_CLIENT_SECRET, which scripts/auth0-tenant.sh reads from the operator's
# own 0600 file and passes to Terraform alone), never from a file of this folder.
provider "auth0" {
  domain = var.tenant_domain
}
