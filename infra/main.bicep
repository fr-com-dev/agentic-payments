// x402 three-layer agent payments in Azure (SPEC.md §3.1; specs/011 contracts/cloud-topology.md): everything in
// the resource group that pre-deploy.bicep creates. The platform (network, logs, registry, vaults, storage, the
// ledger's head (1.23), Foundry and its model, the two Container Apps environments; SPEC 1.25: pre-deploy.bicep makes
// the identities), and each unit's apps, each from its own
// image: L1 (the agent, the regression job and the smoke job), L2 (the control service), L3 (the verifier), the
// operator (the operator job), the portal (013: the web portal) and the sellers. One deployment deploys one of them, chosen by
// `unit`: the platform by .github/workflows/deploy-infra.yml, each unit by its own pipeline (deploy-l1.yml,
// deploy-l2.yml, deploy-l3.yml, deploy-operator.yml, deploy-portal.yml, deploy-seller.yml), all through the shared
// deploy.yml. What a deployment leaves out stays as it
// is (incremental mode). Every name comes from the parameter file's `names` ({type}-{app}-{location}-{environment},
// the registry's and storage's without hyphens; T-IAC-01 rule 15): no template names a resource itself. T-IAC-01
// (test/infra.test.ts) asserts the identity, secret and exposure rules. No secret value appears here: vaults are
// seeded by hand (quickstart §4), never by a template. Every secret an app references must exist before its unit's
// deployment, as the placeholder off where a feature is off: in the l2 vault, ledger-mac-key too (Phase 3, rule 24).
targetScope = 'resourceGroup'

// Every value comes from main.<environment>.bicepparam, the target and every name included: the pipelines sign in to
// this tenant and deploy to this subscription and resource group, and a deployment anywhere else fails validation.
@description('The Entra tenant of the deploy app and of the subscription: the pipelines sign in to it, and the target check below compares it. No service verifies its tokens: every caller, a person or a machine, gets its token from the sign-in tenant (identity).')
param tenantId string
param subscriptionId string
param location string
@description('Every resource name, {type}-{app}-{location}-{environment}: resourceGroup (made by pre-deploy.bicep), network, subnets, logs, registry, storage, ledgerHead (1.23), foundry, environments, and per unit identities (plus l2head, the ledger head\'s writer; all made by pre-deploy.bicep, looked up here), vaults, apps and jobs.')
param names object
@description('The deploy app\'s client ID (pre-deploy.bicep): the pipelines sign in as it with OIDC. Read by deploy.yml, not by any resource.')
#disable-next-line no-unused-params
param deployClientId string
@description('The payer\'s public address: deploy.yml checks its USDC balance before the regression. Read by deploy.yml, not by any resource.')
#disable-next-line no-unused-params
param payerAddress string
@description('What this deployment deploys: the platform (deploy-infra.yml), or one unit\'s apps (deploy-<unit>.yml). Everything else stays as it is.')
@allowed(['platform', 'l1', 'l2', 'l3', 'operator', 'portal', 'seller'])
param unit string
@description('Image tag of the unit\'s image: the Git commit SHA (FR-023), or last-good on a rollback. The platform has no image.')
param imageTag string
@description('An operator\'s public IP, allowed through every vault firewall while the vaults are seeded (quickstart §4 step 3). Empty otherwise. Platform only.')
param seedIp string = ''
@description('Recover the soft-deleted vaults of a cleaned-up environment (infra/cleanup.sh), with their secrets, instead of creating them: one platform run, within 90 days of the clean-up.')
param recoverVaults bool = false
@description('The operators\' group (pre-deploy.bicep): the only principal that may start the operator job.')
@minLength(36)
@maxLength(36)
param operatorsGroupId string
@description('The seller payTo address (public). L2 allows only this payee.')
param sellerPayTo string
@description('The agent revision that keeps serving until the new one passes the regression (empty to give the latest all traffic).')
param agentStableRevision string = ''

// 012 backchannel approval (SPEC L2-7; specs/012 contracts/config-and-secrets.md "Azure"): non-secret values only,
// { enabled, issuer, clientId, audience, credential: 'key' | 'secret', clientKeyId }. No approver (SPEC v1.16,
// specs/015): each request goes to the user the escalated payment is for. A plain object, not a
// user-defined type: a type would switch the compiled template to languageVersion 2.0 (symbolic names).
@description('012: L2\'s backchannel approval. The credential is the l2 vault\'s ciba-client-credential, seeded by hand in every environment (the placeholder off while enabled is false).')
param ciba object
// 013 user accounts (SPEC L2-8; specs/013 contracts/config-and-secrets.md "Azure"): non-secret values only,
// { enabled, portalClientId, sellerName, cardVault: 'off' | 'stripe', cardVaultPublishableKey }. A plain object, not a
// user-defined type, as for ciba.
@description('013: user accounts and the portal. The secrets are the l2 vault\'s portal-token and user-wallet-mnemonic and the portal vault\'s portal-token and card-vault-key, seeded by hand in every environment (the placeholder off while enabled is false).')
param userAccounts object
// The sign-in tenant (SPEC L2-8; specs/013 research R19; specs/016 research R11): the Auth0 tenant's values, from
// Terraform's output bicepparam_identity (auth0/), { issuer, audience }. None is a secret. A plain object, not a
// user-defined type, as for ciba. The portal, the agent and L2 verify tokens against it, and the two jobs that call
// as the machine caller ask it for theirs.
@description('The sign-in tenant (Auth0), for the portal, the agent, L2 and the machine caller: its issuer (https://<domain>/) and the API\'s identifier.')
param identity object
// 016 the agent's callers (specs/016 contracts/tenant-and-config.md "Azure"): non-secret values only,
// { clientId, apiDocs, machineClientId, machineKeyId }. clientId, machineClientId and machineKeyId are Terraform's
// output bicepparam_agent (auth0/); apiDocs is the environment's own choice. A plain object, not a user-defined
// type, as for ciba.
@description('016: the agent\'s client at the sign-in tenant (the only one whose people\'s tokens the agent and L2 accept), whether the agent serves its docs page, and the client and key ID of the pipeline\'s machine caller. Its private key is the l1 vault\'s machine-client-key, seeded by hand (the placeholder off until the tenant has the client).')
param agent object
@description('Who uses Claude, declared to Anthropic with the model deployment, which accepts Anthropic\'s Azure Marketplace terms: the legal entity\'s name.')
param claudeOrganizationName string
@description('The organization\'s two-letter country code.')
@minLength(2)
@maxLength(2)
param claudeCountryCode string
@allowed(['technology', 'finance', 'healthcare', 'education', 'retail', 'manufacturing', 'government', 'media', 'other'])
param claudeIndustry string

// Validation fails, naming both, when this runs anywhere other than the parameter file says.
#disable-next-line no-unused-vars
var target = tenant().tenantId == tenantId && subscription().subscriptionId == subscriptionId && resourceGroup().name == names.resourceGroup
  ? names.resourceGroup
  : fail('main: the parameter file names tenant ${tenantId}, subscription ${subscriptionId}, resource group ${names.resourceGroup}; this deployment runs in tenant ${tenant().tenantId}, subscription ${subscription().subscriptionId}, resource group ${resourceGroup().name}')

// 012: an enabled ciba must name an https issuer, a client and an audience (T-IAC-01 rule 19).
// 015: and it needs user accounts on, because a request goes to the user a payment is for: L2 refuses to start with
// CIBA_APPROVAL=1 and no USER_ACCOUNTS=1.
#disable-next-line no-unused-vars
var cibaChecked = contains(['key', 'secret'], ciba.credential) && (!ciba.enabled || (startsWith(ciba.issuer, 'https://') && !empty(ciba.clientId) && !empty(ciba.audience) && userAccounts.enabled))
  ? ciba.enabled
  : fail('main: ciba.credential must be key or secret, and ciba.enabled needs an https:// issuer, a clientId, an audience and userAccounts.enabled (specs/012 and specs/015 contracts/config-and-secrets.md)')

// 013: an enabled userAccounts must name the portal web app's client ID (an Auth0 client ID, which is not a GUID, so
// the check is "not empty"), and so must any deployment of the portal itself, enabled or not: the portal doesn't
// start without it. A stripe card vault needs a test-mode publishable key (T-IAC-01 rule 21).
// 014: the portal's administration area needs user accounts on (rule 22).
#disable-next-line no-unused-vars
var userAccountsChecked = contains(['off', 'stripe'], userAccounts.cardVault) && ((!userAccounts.enabled && unit != 'portal') || !empty(userAccounts.portalClientId)) && (userAccounts.cardVault != 'stripe' || startsWith(userAccounts.cardVaultPublishableKey, 'pk_test_')) && (!userAccounts.administration || userAccounts.enabled)
  ? userAccounts.enabled
  : fail('main: userAccounts.cardVault must be off or stripe, userAccounts.enabled and the portal unit each need a portalClientId, cardVault stripe needs a cardVaultPublishableKey that starts with pk_test_, and userAccounts.administration needs userAccounts.enabled (specs/013 and specs/014 contracts/config-and-secrets.md)')

// 013: with user accounts on, people's sign-in at the portal must be usable: an issuer of the form https://…/ and
// an audience (T-IAC-01 rule 21). The agent's client is not part of identity: it is agent.clientId, checked below.
#disable-next-line no-unused-vars
var identityChecked = !userAccounts.enabled || (startsWith(identity.issuer, 'https://') && endsWith(identity.issuer, '/') && !empty(identity.audience))
  ? userAccounts.enabled
  : fail('main: userAccounts.enabled needs an identity.issuer of the form https://<domain>/ and an identity.audience (specs/013 contracts/config-and-secrets.md)')

// 016: the agent and L2 verify every caller's token against the sign-in tenant, so a deployment of either needs a
// usable identity and the agent's client; neither starts without them. An agent that serves its docs page signs
// people in through that client. L1's two jobs call as the machine caller, so its deployment needs that client's
// ID and its key's ID (T-IAC-01 rule 23). The other units read none of this, so they deploy while agent is empty.
#disable-next-line no-unused-vars
var agentChecked = (!contains(['l1', 'l2'], unit) || (startsWith(identity.issuer, 'https://') && endsWith(identity.issuer, '/') && !empty(identity.audience) && !empty(agent.clientId))) && (unit != 'l1' || !agent.apiDocs || !empty(agent.clientId)) && (unit != 'l1' || (!empty(agent.machineClientId) && !empty(agent.machineKeyId)))
  ? agent.apiDocs
  : fail('main: the l1 and l2 units need an identity.issuer of the form https://<domain>/, an identity.audience and an agent.clientId; agent.apiDocs needs an agent.clientId; the l1 unit needs an agent.machineClientId and an agent.machineKeyId (specs/016 contracts/tenant-and-config.md)')

// The identity and vault matrix (contracts/cloud-topology.md "Role assignments"): one identity and one
// vault per runtime unit, and each identity reads only its own vault. SPEC 1.25: pre-deploy.bicep makes the
// identities (names.identities), so the deploy app's condition can name their principals; this template only looks
// them up, by name. The key names the unit's identity
// (names.identities.<key>) and vault (names.vaults.<key>); the subnet names the vault's only subnet
// (names.subnets.<subnet>). T-IAC-01 asserts on this variable.
var units = [
  { key: 'l1', subnet: 'x402' }
  { key: 'l2', subnet: 'x402' }
  { key: 'l3', subnet: 'x402' }
  { key: 'op', subnet: 'x402' }
  { key: 'portal', subnet: 'x402' }
  { key: 'seller', subnet: 'seller' }
]
@description('nginx-unprivileged 1.29-alpine, pinned by index digest on 2026-10-22: the L2 and L3 proxy sidecars.')
var proxyImage = 'docker.io/nginxinc/nginx-unprivileged@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6'
var acrServer = '${names.registry}${az.environment().suffixes.acrLoginServer}'
@description('The Foundry model deployment, named exactly the model id: the agent\'s ANTHROPIC_MODEL.')
var modelDeployment = 'claude-sonnet-5-5'

// Every module gets names and settings only, never another module's outputs: what-if skips a module whose
// parameters hold runtime values, and a first deployment would then preview almost nothing. Each module looks
// up the resources it uses by name, so dependsOn orders them. Each module is deployed by exactly one unit
// (T-IAC-01 rule 18): a unit's apps find the platform deployed by an earlier run of deploy-infra.yml.
var platform = unit == 'platform'

// ---- The platform (unit 'platform', deploy-infra.yml) ------------------------------------------------------------
module network 'modules/network.bicep' = if (platform) {
  name: 'network'
  params: { location: location, names: names }
}

module logs 'modules/logs.bicep' = if (platform) {
  name: 'logs'
  params: { location: location, names: names }
}

module registry 'modules/registry.bicep' = if (platform) {
  name: 'registry'
  params: { location: location, names: names, identityKeys: map(units, u => u.key) }
}

module vaults 'modules/vault.bicep' = [for u in units: if (platform) {
  name: 'vault-${u.key}'
  params: { location: location, names: names, key: u.key, subnet: u.subnet, seedIp: seedIp, recover: recoverVaults }
  dependsOn: [network]
}]

module storage 'modules/storage.bicep' = if (platform) {
  name: 'storage'
  params: { location: location, names: names }
  dependsOn: [network]
}

// 1.23 (SPEC L2-4, SEC-39): the ledger's head, outside the share, with the one identity that may write it. Before L2:
// its first start with 1.23 writes the head (T-IAC-01 rule 25).
module ledgerHead 'modules/ledger-head.bicep' = if (platform) {
  name: 'ledger-head'
  params: { location: location, names: names }
  dependsOn: [network]
}

module foundry 'modules/foundry.bicep' = if (platform) {
  name: 'foundry'
  params: {
    location: location
    names: names
    modelName: modelDeployment
    claudeOrganizationName: claudeOrganizationName
    claudeCountryCode: claudeCountryCode
    claudeIndustry: claudeIndustry
  }
}

module envs 'modules/environments.bicep' = if (platform) {
  name: 'environments'
  params: { location: location, names: names }
  dependsOn: [network, logs, storage]
}

// ---- The units: each on its own image, with its own identities and vaults only (T-IAC-01 rules 12 and 13), each
// deployed by its own pipeline (deploy-<unit>.yml) ------------------------------------------------------------------
module l1 'modules/l1-apps.bicep' = if (unit == 'l1') {
  name: 'l1-apps'
  params: {
    location: location
    names: names
    image: '${acrServer}/x402-l1-agent:${imageTag}'
    acrServer: acrServer
    identity: identity
    agent: agent
    modelDeployment: modelDeployment
    agentStableRevision: agentStableRevision
  }
  dependsOn: [registry, vaults, envs, foundry]
}

module l2 'modules/l2-apps.bicep' = if (unit == 'l2') {
  name: 'l2-apps'
  params: {
    location: location
    names: names
    ledgerStorageName: 'ledger'
    image: '${acrServer}/x402-l2-control:${imageTag}'
    proxyImage: proxyImage
    acrServer: acrServer
    sellerPayTo: sellerPayTo
    ciba: ciba
    userAccounts: userAccounts
    identity: identity
    agent: agent
  }
  dependsOn: [registry, vaults, envs, ledgerHead]
}

module operator 'modules/operator-apps.bicep' = if (unit == 'operator') {
  name: 'operator-apps'
  params: {
    location: location
    names: names
    image: '${acrServer}/x402-operator:${imageTag}'
    acrServer: acrServer
    operatorsGroupId: operatorsGroupId
  }
  dependsOn: [registry, vaults, envs]
}

module l3 'modules/l3-apps.bicep' = if (unit == 'l3') {
  name: 'l3-apps'
  params: {
    location: location
    names: names
    image: '${acrServer}/x402-l3-verifier:${imageTag}'
    proxyImage: proxyImage
    acrServer: acrServer
  }
  dependsOn: [registry, vaults, envs]
}

// 013: the portal, the second public app. It calls L2 only, with its own token, and mounts its own share. People
// sign in to it with Auth0 (identity), through its own client: it gets nothing of the agent's (agent).
module portal 'modules/portal-apps.bicep' = if (unit == 'portal') {
  name: 'portal-apps'
  params: {
    location: location
    names: names
    profilesStorageName: 'profiles'
    image: '${acrServer}/x402-portal:${imageTag}'
    acrServer: acrServer
    userAccounts: userAccounts
    identity: identity
  }
  dependsOn: [registry, vaults, envs]
}

module sellers 'modules/sellers.bicep' = if (unit == 'seller') {
  name: 'sellers'
  params: {
    location: location
    names: names
    image: '${acrServer}/x402-seller:${imageTag}'
    acrServer: acrServer
    sellerPayTo: sellerPayTo
  }
  dependsOn: [registry, vaults, envs]
}

// Each deployment outputs what it deployed: the platform's registry, logs and vaults, or a unit's addresses.
output registry string = acrServer
output logWorkspaceCustomerId string = platform ? logs!.outputs.customerId : ''
output vaults array = [for (u, i) in (platform ? units : []): { key: u.key, uri: vaults[i]!.outputs.uri }]
output agentFqdn string = unit == 'l1' ? l1!.outputs.agentFqdn : ''
output portalFqdn string = unit == 'portal' ? portal!.outputs.portalFqdn : ''
output sellerFqdn string = unit == 'seller' ? sellers!.outputs.fqdn : ''
output sellerAliasFqdn string = unit == 'seller' ? sellers!.outputs.aliasFqdn : ''
