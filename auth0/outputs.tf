# The values L2 needs, never a secret. bicepparam_ciba goes into infra/main.<environment>.bicepparam as param ciba;
# l2_env into a local env/l2-control.env. T-IAC-02 checks that bicepparam_ciba has exactly the keys main.bicep reads.
# For people's sign-in (specs/013), further down: bicepparam_identity goes there as param identity, and
# bicepparam_portal_client_id as userAccounts.portalClientId; portal_env goes into a local env/portal.env. The
# portal's client is public, so none of this is a secret either.
# For the hosted agent's callers (specs/016 research R10), last: bicepparam_agent goes there as param agent, beside
# apiDocs, which that file sets itself; l1_env goes into a local env/l1-hosted.env, and l2_env carries the same
# sign-in lines for L2. Client IDs and a key's ID: none is a secret.

output "bicepparam_ciba" {
  description = "The ciba object for infra/main.<environment>.bicepparam. Set enabled to true there only once the l2 vault's ciba-client-credential holds the real credential (specs/012 quickstart §6)."
  value = {
    enabled     = false
    issuer      = local.issuer
    clientId    = auth0_client.l2.client_id
    audience    = auth0_resource_server.payments.identifier
    credential  = var.credential
    clientKeyId = ""
  }
}

output "l2_env" {
  description = "The non-secret lines for a local env/l2-control.env: the CIBA_* ones (no approver: each request goes to the person the payment is for, SPEC v1.16), then the callers' sign-in (the same three values as l1_env). Add CIBA_CLIENT_KEY (the private half) or CIBA_CLIENT_SECRET yourself."
  value = join("\n", [
    "CIBA_APPROVAL=1",
    "CIBA_ISSUER=${local.issuer}",
    "CIBA_CLIENT_ID=${auth0_client.l2.client_id}",
    "CIBA_AUDIENCE=${auth0_resource_server.payments.identifier}",
    "AUTH_ISSUER=${local.issuer}",
    "AUTH_AUDIENCE=${auth0_resource_server.identity.identifier}",
    "AGENT_CLIENT_IDS=${auth0_client.agent.client_id}",
  ])
}

output "credential_key_id" {
  description = "The private_key_jwt credential's key ID, for reference. CIBA_CLIENT_KEY_ID may stay empty: Auth0 then tries each of the client's credentials."
  value       = var.credential == "key" ? one(auth0_client_credentials.l2.private_key_jwt[0].credentials).key_id : ""
}

output "bicepparam_identity" {
  description = "The identity object for infra/main.<environment>.bicepparam: the tenant's issuer and people's API, for the portal, the hosted agent and L2. It names no client: the portal's is userAccounts.portalClientId and the agent's is in the agent object."
  value = {
    issuer   = local.issuer
    audience = auth0_resource_server.identity.identifier
  }
}

output "bicepparam_portal_client_id" {
  description = "userAccounts.portalClientId for infra/main.<environment>.bicepparam: the portal web app's client ID."
  value       = auth0_client.portal.client_id
}

output "portal_env" {
  description = "The lines of people's sign-in for a local env/portal.env."
  value = join("\n", [
    "AUTH_ISSUER=${local.issuer}",
    "AUTH_AUDIENCE=${auth0_resource_server.identity.identifier}",
    "PORTAL_CLIENT_ID=${auth0_client.portal.client_id}",
    "AUTH_TIME_CLAIM=${local.auth_time_claim}",
  ])
}

output "bicepparam_agent" {
  description = "The agent object for infra/main.<environment>.bicepparam, but its apiDocs, which that file sets itself: the agent's client, and the pipeline's machine caller (checks) with its key's ID, both empty until machine_caller_keys declares checks."
  value = {
    clientId        = auth0_client.agent.client_id
    machineClientId = try(auth0_client.machine["checks"].client_id, "")
    machineKeyId    = try(one(auth0_client_credentials.machine["checks"].private_key_jwt[0].credentials).key_id, "")
  }
}

output "l1_env" {
  description = "The callers' sign-in lines for a local env/l1-hosted.env pointed at the tenant (remove AUTH_JWKS_FILE there). A machine caller's client is never on AGENT_CLIENT_IDS, and neither is the portal's."
  value = join("\n", [
    "AUTH_ISSUER=${local.issuer}",
    "AUTH_AUDIENCE=${auth0_resource_server.identity.identifier}",
    "AGENT_CLIENT_IDS=${auth0_client.agent.client_id}",
    "API_DOCS_CLIENT_ID=${auth0_client.agent.client_id}",
  ])
}
