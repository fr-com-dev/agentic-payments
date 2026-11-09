# The values L2 needs, never a secret. bicepparam_ciba goes into infra/main.<environment>.bicepparam as param ciba;
# l2_env into a local env/l2-control.env. T-IAC-02 checks that bicepparam_ciba has exactly the keys main.bicep reads.

output "bicepparam_ciba" {
  description = "The ciba object for infra/main.<environment>.bicepparam. Set enabled to true there only once the l2 vault's ciba-client-credential holds the real credential (specs/012 quickstart §6)."
  value = {
    enabled     = false
    issuer      = local.issuer
    clientId    = auth0_client.l2.client_id
    audience    = auth0_resource_server.payments.identifier
    approver    = data.auth0_user.approver.user_id
    credential  = var.credential
    clientKeyId = ""
  }
}

output "l2_env" {
  description = "The non-secret CIBA_* lines for a local env/l2-control.env. Add CIBA_CLIENT_KEY (the private half) or CIBA_CLIENT_SECRET yourself."
  value = join("\n", [
    "CIBA_APPROVAL=1",
    "CIBA_ISSUER=${local.issuer}",
    "CIBA_CLIENT_ID=${auth0_client.l2.client_id}",
    "CIBA_AUDIENCE=${auth0_resource_server.payments.identifier}",
    "CIBA_APPROVER=${data.auth0_user.approver.user_id}",
  ])
}

output "credential_key_id" {
  description = "The private_key_jwt credential's key ID, for reference. CIBA_CLIENT_KEY_ID may stay empty: Auth0 then tries each of the client's credentials."
  value       = var.credential == "key" ? one(auth0_client_credentials.l2.private_key_jwt[0].credentials).key_id : ""
}
