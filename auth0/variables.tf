# No tfvars file exists: the pipeline (provision-auth0.yml) sets every value as TF_VAR_<name>, from the variables of
# its GitHub environment (AUTH0_TENANT_DOMAIN and the like; auth0/README.md). None of those is a secret. The one
# secret, the ephemeral client secret, comes from the environment's secret AUTH0_L2_CLIENT_SECRET, with
# credential = "secret" only. No variable holds a private key.

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

variable "approver_user_id" {
  description = "The approver's existing user ID (auth0|...), which becomes CIBA_APPROVER. Users and passwords are never managed here; the approver enrolls their phone in Guardian themselves."
  type        = string
  validation {
    condition     = length(var.approver_user_id) > 0 && length(var.approver_user_id) <= 255 && !can(regex("\\s", var.approver_user_id))
    error_message = "approver_user_id must be 1-255 characters with no whitespace."
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
  description = "L2's client secret, when credential = secret: generate it yourself (16+ characters), store it as the secret AUTH0_L2_CLIENT_SECRET of the pipeline's GitHub environment (it becomes TF_VAR_client_secret), and seed the same value into the l2 vault. Write-only: never stored in state or plan."
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
