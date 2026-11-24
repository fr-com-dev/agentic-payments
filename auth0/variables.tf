# The values live in one tfvars file on the operator's host, outside every checkout (by default
# ~/x402-tfstate/auth0.<environment>.tfvars, auth0/README.md), never in the repository. None of them is a secret.
# scripts/auth0-tenant.sh sets environment and credential itself, always credential = "key", and refuses a tfvars
# file that sets either, or client_secret: L2's credential is held by L2 only (Constitution V). No variable holds a
# private key: L2's and every machine caller's are public halves only.

variable "environment" {
  description = "The deployment environment these objects serve, as in infra/main.<environment>.bicepparam (dev)."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9]{2,10}$", var.environment))
    error_message = "environment must be 2-10 lowercase letters or digits, like the Azure environment names."
  }
}

variable "tenant_domain" {
  description = "The tenant's canonical domain, without https:// (for example x402-dev.us.auth0.com). The issuer is https://<tenant_domain>/."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]*\\.[a-z]{2,}$", var.tenant_domain))
    error_message = "tenant_domain must be a bare host name, with no scheme, path or trailing slash."
  }
}

variable "api_identifier" {
  description = "The approval API's identifier, which becomes CIBA_AUDIENCE (for example https://x402-payments/dev). It can't change once created."
  type        = string
  validation {
    condition     = length(var.api_identifier) > 0 && length(var.api_identifier) <= 255 && !can(regex("\\s", var.api_identifier))
    error_message = "api_identifier must be 1-255 characters with no whitespace."
  }
}

variable "credential" {
  description = "How L2 authenticates to Auth0: key (private_key_jwt with RS256, preferred; Enterprise plan) or secret (client_secret_post)."
  type        = string
  default     = "key"
  validation {
    condition     = contains(["key", "secret"], var.credential)
    error_message = "credential must be key or secret."
  }
}

variable "client_public_key_pem" {
  description = "The PUBLIC half (SPKI PEM, RSA 2048-4096) of L2's client key, as text, when credential = key. The private half goes only into the l2 vault, never here."
  type        = string
  default     = ""
  validation {
    condition     = var.client_public_key_pem == "" || (startswith(trimspace(var.client_public_key_pem), "-----BEGIN PUBLIC KEY-----") && !strcontains(var.client_public_key_pem, "PRIVATE KEY"))
    error_message = "client_public_key_pem must be a PEM public key (-----BEGIN PUBLIC KEY-----), never a private key."
  }
}

variable "client_secret" {
  description = "L2's client secret, when credential = secret: scripts/auth0-tenant.sh never sets it (it provisions credential = key only), because the secret is held by L2 only; it would come from TF_VAR_client_secret in an administrator's own shell running Terraform by hand, with the same value given to L2. Write-only: never stored in state or plan."
  type        = string
  default     = null
  sensitive   = true
  ephemeral   = true
}

variable "client_secret_version" {
  description = "Bump to rotate the client secret (credential = secret): Terraform sends the write-only secret again only when this changes."
  type        = number
  default     = 1
}

variable "manage_guardian" {
  description = "Manage the tenant's Guardian MFA settings here (push through the Guardian app). Set false if another configuration owns them: auth0_guardian is a tenant-wide singleton."
  type        = bool
  default     = true
}

variable "guardian_policy" {
  description = "When Auth0 asks for MFA at login (never, all-applications, confidence-score). CIBA needs the push factor on, not MFA at login, so the default changes no login."
  type        = string
  default     = "never"
  validation {
    condition     = contains(["never", "all-applications", "confidence-score"], var.guardian_policy)
    error_message = "guardian_policy must be never, all-applications or confidence-score."
  }
}

variable "portal_origin" {
  description = "The deployed portal's origin, https://<host>[:<port>] (infra/main.bicep's portalFqdn output, or the VPS's address), which becomes an allowed callback, web origin and logout URL of the portal's client (beside http://localhost:4025 where var.local_origins is on). Empty until the portal is deployed."
  type        = string
  default     = ""
  validation {
    condition     = var.portal_origin == "" || can(regex("^https://[a-z0-9][a-z0-9.-]*(:[1-9][0-9]{0,4})?$", var.portal_origin))
    error_message = "portal_origin must be empty or https://<host>[:<port>], with no path, wildcard or trailing slash."
  }
}

variable "agent_origin" {
  description = "The deployed hosted agent's origin, https://<host>[:<port>] (infra/main.bicep's agentFqdn output, or the VPS's address, https://dev.fabriciorojas.com:8443), whose docs page (/docs) then may sign people in through the agent's client (beside http://localhost:4024 and http://127.0.0.1:4024 where var.local_origins is on). Empty until the agent is deployed; needed only where its docs page is on (agent.apiDocs)."
  type        = string
  default     = ""
  validation {
    condition     = var.agent_origin == "" || can(regex("^https://[a-z0-9][a-z0-9.-]*(:[1-9][0-9]{0,4})?$", var.agent_origin))
    error_message = "agent_origin must be empty or https://<host>[:<port>], with no path, wildcard or trailing slash."
  }
}

variable "machine_caller_keys" {
  description = "The machine callers: each one's name (it names the client, app-machine-<name>-<environment>) and the PUBLIC half (SPKI PEM, RSA 2048-4096) of its key, as text. The deployment pipeline's own caller is checks. The private half goes only where the caller runs (the l1 vault's machine-client-key for checks), never here. Empty: no machine caller."
  type        = map(string)
  default     = {}
  validation {
    condition     = alltrue([for name, pem in var.machine_caller_keys : can(regex("^[a-z][a-z0-9-]{1,19}$", name))])
    error_message = "A machine caller's name must be 2-20 lowercase letters, digits or hyphens, starting with a letter."
  }
  validation {
    condition     = alltrue([for name, pem in var.machine_caller_keys : startswith(trimspace(pem), "-----BEGIN PUBLIC KEY-----") && !strcontains(pem, "PRIVATE KEY")])
    error_message = "Each value of machine_caller_keys must be a PEM public key (-----BEGIN PUBLIC KEY-----), never a private key."
  }
}

variable "local_origins" {
  description = "Add the local portal's and the local agent's origins (http://localhost:4025, http://localhost:4024 and http://127.0.0.1:4024) to the portal's and the agent's clients, for development against this tenant. Off by default: a deployed environment's clients accept their deployed origins only."
  type        = bool
  default     = false
}

variable "allow_sign_ups" {
  description = "Let anyone create an account in the tenant's database and passwordless connections. True by default, as before. False binds the pre-user-registration Action deny-sign-up.js, which refuses every such registration, those made in the Dashboard or with the Management API included. A first sign-in through a social or enterprise connection doesn't run that trigger: turn those connections off for the applications too."
  type        = bool
  default     = true
}
