// dev parameters for main.bicep: every value it uses, its target and every resource name included. deploy.yml (the
// pipelines' shared workflow) compiles this file with the Bicep CLI to read its sign-in, target and names, and sets
// the five values at the end on each run. No secret values: the vaults are seeded by hand (quickstart §4 step 3).
using 'main.bicep'

param tenantId = '88f8af2e-ee60-42cd-ba67-6806d30aac9d'
param subscriptionId = 'e1d827eb-1354-4f01-8651-60c67c08fc3b'
param location = 'eastus2'

// Every resource name is {type}-{app}-{location}-{environment}; the registry's and storage's drop the hyphens
// (letters and digits only). The templates name nothing themselves, and T-IAC-01 rule 15 checks each name here.
var environment = 'dev'
param names = {
  resourceGroup: 'rg-x402-${location}-${environment}'
  network: 'vnet-x402-${location}-${environment}'
  subnets: {
    x402: 'snet-x402-${location}-${environment}'
    seller: 'snet-seller-${location}-${environment}'
  }
  logs: 'log-x402-${location}-${environment}'
  registry: 'crx402${location}${environment}'
  storage: 'stx402${location}${environment}'
  // 1.23: the ledger's head (SPEC L2-4), outside the ledger's share; written only by identities.l2head.
  ledgerHead: 'stl2head${location}${environment}'
  foundry: 'ais-x402-${location}-${environment}'
  environments: {
    x402: 'cae-x402-${location}-${environment}'
    seller: 'cae-seller-${location}-${environment}'
  }
  identities: {
    l1: 'id-l1-${location}-${environment}'
    l2: 'id-l2-${location}-${environment}'
    l3: 'id-l3-${location}-${environment}'
    op: 'id-op-${location}-${environment}'
    portal: 'id-portal-${location}-${environment}'
    seller: 'id-seller-${location}-${environment}'
    // 1.23: the one identity that may write the ledger's head; L2's control app uses it for that alone.
    l2head: 'id-l2head-${location}-${environment}'
  }
  vaults: {
    l1: 'kv-l1-${location}-${environment}'
    l2: 'kv-l2-${location}-${environment}'
    l3: 'kv-l3-${location}-${environment}'
    op: 'kv-op-${location}-${environment}'
    portal: 'kv-portal-${location}-${environment}'
    seller: 'kv-seller-${location}-${environment}'
  }
  apps: {
    l1: 'ca-l1-${location}-${environment}'
    l2: 'ca-l2-${location}-${environment}'
    l3: 'ca-l3-${location}-${environment}'
    portal: 'ca-portal-${location}-${environment}'
    seller: 'ca-seller-${location}-${environment}'
    sellerAlias: 'ca-seller-alias-${location}-${environment}'
  }
  jobs: {
    l1: 'caj-l1-${location}-${environment}'
    l2: 'caj-l2-${location}-${environment}'
    smoke: 'caj-smoke-${location}-${environment}'
  }
}

// pre-deploy.bicep's outputs (az deployment sub show -n pre-deploy-dev --query properties.outputs.mainParameters.value).
param deployClientId = '62ea98ec-a6d9-48b4-96d0-591f872c7b17'
param operatorsGroupId = '6d09c1a1-ae43-4b55-b6d3-277b546adf3c'

// Public addresses on Base Sepolia: the seller's payTo (L2's only payee), and the payer whose balance deploy.yml checks.
param sellerPayTo = '0x95Aca02416F949489C1128223B35fBBE8c04f057'
param payerAddress = '0x0048A66969cE8886A5e9bC00059Cb8c5D3989516'

// 012 backchannel approval (SPEC L2-7): the values are Terraform's output bicepparam_ciba (auth0/, applied by
// provision-auth0.yml on 2026-11-12, and with scripts/auth0-tenant.sh on 2026-11-24, unchanged). Still off in dev: enabled goes to true only once the l2 vault's
// ciba-client-credential holds L2's private key (specs/012 quickstart §6), and it needs userAccounts.enabled. Until
// then the vault holds the placeholder off. There is no approver (SPEC v1.16, specs/015): each request goes to the
// user the payment is for.
param ciba = {
  enabled: false
  issuer: 'https://fabriciorojas.us.auth0.com/'
  clientId: 'EqXwAxwj0VXpiE9pn7vR5r6P2KBc5UD4'
  audience: 'https://x402-payments/dev'
  credential: 'key'
  clientKeyId: ''
}

// 013 user accounts (SPEC L2-8; specs/013 contracts/config-and-secrets.md "Azure"): off in dev until the portal is
// deployed and its secrets are seeded (specs/013 quickstart §6). portalClientId is the Auth0 single-page client's
// ID, Terraform's output bicepparam_portal_client_id (auth0/; the summary of provision-auth0.yml's apply run of
// 2026-11-12). The portal doesn't start without it, also while enabled is false, and main.bicep refuses the portal
// unit while it is empty. The l2 vault holds portal-token and user-wallet-mnemonic,
// and the portal vault portal-token and card-vault-key, either way: the placeholder off now, the real values once
// enabled.
param userAccounts = {
  enabled: false
  portalClientId: 'iMNhIDWoJNpQf4dLINxOAzKFbRvy3Wjq'
  // 014: the portal's administration area (the portal:admin permission of the sign-in tenant). It needs enabled:
  // true, and a real portal-admin-token in the l2 vault and in the portal's (the placeholder off until then).
  administration: false
  sellerName: 'x402 demo seller'
  cardVault: 'off'
  cardVaultPublishableKey: ''
  // 020: the portal's Coinbase connection (specs/020 contracts/config-and-secrets.md "Azure"). Off: Coinbase isn't
  // issuing OAuth clients now (specs/020 research R0). Seed coinbase-client-secret and coinbase-grant-key in the
  // portal vault as the placeholder off before the portal's first deployment with 020, or its revision fails and the
  // pipeline rolls back. enabled needs enabled: true above, the project's Coinbase client ID, the redirect registered
  // with it (https://<portal host>/wallet/return), the privacy policy's and support's addresses, and the two real
  // secrets in the vault.
  coinbase: {
    enabled: false
    clientId: ''
    redirectUri: ''
    privacyPolicyUrl: ''
    supportUrl: ''
  }
}

// The sign-in tenant (specs/013 research R19; specs/016): people sign in with Auth0, at the portal and at the agent,
// and the pipeline's machine caller gets its tokens there too. The two values are Terraform's output
// bicepparam_identity (auth0/; the same summary): the tenant's issuer (https://<domain>/) and the API's identifier,
// from the apply run of 2026-11-12. The portal, the agent and L2 verify tokens against them; main.bicep refuses
// userAccounts.enabled, and the l1 and l2 units, without them.
param identity = {
  issuer: 'https://fabriciorojas.us.auth0.com/'
  audience: 'https://x402-api/dev'
}

// 016: the agent's client, the docs switch and the pipeline's machine caller. clientId, machineClientId and
// machineKeyId are Terraform's output bicepparam_agent (auth0/): empty until 016's tenant is applied (it was on
// 2026-11-24, with scripts/auth0-tenant.sh, without a machine caller) and its values are pasted here, and until then main.bicep refuses the l1 and l2 units. apiDocs is this
// environment's own choice: true in dev, where the agent serves its docs page and signs people in through clientId.
// The l1 vault holds machine-client-key, the private half of the machine caller's key (the placeholder off until
// the tenant has the client).
param agent = {
  clientId: ''
  // 019: the desktop client's ID (Terraform's output bicepparam_agent); empty while the tenant has none.
  desktopClientId: ''
  apiDocs: true
  machineClientId: ''
  machineKeyId: ''
}

// Declared to Anthropic with the Claude deployment, which accepts its Azure Marketplace terms (owner's consent,
// 2026-11-01).
param claudeOrganizationName = 'Fabricio Rojas'
param claudeCountryCode = 'US'
param claudeIndustry = 'technology'

// Set by deploy.yml on each run: what the run deploys (the platform, or the pipeline's unit), the commit, an
// operator's IP while seeding the vaults, the recovery of a cleaned-up environment's vaults, and the agent revision
// that keeps its traffic until the new one passes the checks.
param unit = readEnvironmentVariable('UNIT', 'platform')
param imageTag = readEnvironmentVariable('IMAGE_TAG', 'dev')
param seedIp = readEnvironmentVariable('SEED_IP', '')
param recoverVaults = bool(readEnvironmentVariable('RECOVER_VAULTS', 'false'))
param agentStableRevision = readEnvironmentVariable('AGENT_STABLE_REVISION', '')
