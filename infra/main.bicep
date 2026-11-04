// x402 three-layer agent payments in Azure (SPEC.md §3.1; specs/011 contracts/cloud-topology.md): everything in
// the resource group that pre-deploy.bicep creates, from one commit. The platform (network, logs, identities,
// registry, vaults, storage, Foundry and its model, the two Container Apps environments), then each unit's apps,
// each from its own image: L1 (the agent and the regression job), L2 (the control service and the operator job),
// L3 (the verifier) and the sellers. Deployed by .github/workflows/deploy.yml: with platformOnly first, so the
// registry exists before the images are pushed (and, on the very first run, the vaults before they are seeded),
// then whole. Every name comes from the parameter file's `names` ({type}-{app}-{location}-{environment}, the
// registry's and storage's without hyphens; T-IAC-01 rule 15): no template names a resource itself. T-IAC-01
// (test/infra.test.ts) asserts the identity, secret and exposure rules. No secret value appears here: vaults are
// seeded by hand (quickstart §4), never by a template.
targetScope = 'resourceGroup'

// Every value comes from main.<environment>.bicepparam, the target and every name included: deploy.yml signs in to
// this tenant and deploys to this subscription and resource group, and a deployment anywhere else fails validation.
@description('The Entra tenant: the deploy app\'s, and the one requesters\' tokens come from (AUTH_TENANT_ID).')
param tenantId string
param subscriptionId string
param location string
@description('Every resource name, {type}-{app}-{location}-{environment}: resourceGroup (made by pre-deploy.bicep), network, subnets, logs, registry, storage, foundry, environments, and per unit identities, vaults, apps and jobs.')
param names object
@description('The deploy app\'s client ID (pre-deploy.bicep): deploy.yml signs in as it with OIDC. Read by the workflow, not by any resource.')
#disable-next-line no-unused-params
param deployClientId string
@description('The payer\'s public address: deploy.yml checks its USDC balance before the regression. Read by the workflow, not by any resource.')
#disable-next-line no-unused-params
param payerAddress string
@description('Image tag of all four images: the Git commit SHA (FR-023), or last-good on a rollback.')
param imageTag string
@description('Only the platform, without any app: the run before images are pushed, and the very first run, before the vaults are seeded.')
param platformOnly bool = false
@description('An operator\'s public IP, allowed through every vault firewall while the vaults are seeded (quickstart §4 step 3). Empty otherwise.')
param seedIp string = ''
@description('Recover the soft-deleted vaults of a cleaned-up environment (infra/cleanup.sh), with their secrets, instead of creating them: one platform-only run, within 90 days of the clean-up.')
param recoverVaults bool = false
@description('The API app\'s client ID (pre-deploy.bicep). Entra v2.0 tokens carry it as aud, never the api:// URI, so there is no default.')
@minLength(36)
@maxLength(36)
param authAudience string
@description('The operators\' group (pre-deploy.bicep): the only principal that may start the operator job.')
@minLength(36)
@maxLength(36)
param operatorsGroupId string
@description('The seller payTo address (public). L2 allows only this payee.')
param sellerPayTo string
@description('The agent revision that keeps serving until the new one passes the regression (empty to give the latest all traffic).')
param agentStableRevision string = ''
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

// The identity and vault matrix (contracts/cloud-topology.md "Role assignments"): one identity and one
// vault per runtime unit, and each identity reads only its own vault. The key names the unit's identity
// (names.identities.<key>) and vault (names.vaults.<key>); the subnet names the vault's only subnet
// (names.subnets.<subnet>). T-IAC-01 asserts on this variable.
var units = [
  { key: 'l1', subnet: 'x402' }
  { key: 'l2', subnet: 'x402' }
  { key: 'l3', subnet: 'x402' }
  { key: 'op', subnet: 'x402' }
  { key: 'seller', subnet: 'seller' }
]
@description('nginx-unprivileged 1.29-alpine, pinned by index digest on 2026-10-22: the L2 and L3 proxy sidecars.')
var proxyImage = 'docker.io/nginxinc/nginx-unprivileged@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6'
var acrServer = '${names.registry}${az.environment().suffixes.acrLoginServer}'
@description('The Foundry model deployment, named exactly the model id: the agent\'s ANTHROPIC_MODEL.')
var modelDeployment = 'claude-sonnet-5-5'

// Every module gets names and settings only, never another module's outputs: what-if skips a module whose
// parameters hold runtime values, and a first deployment would then preview almost nothing. Each module looks
// up the resources it uses by name, so dependsOn orders them.

// ---- The platform ----------------------------------------------------------------------------------------------
module network 'modules/network.bicep' = {
  name: 'network'
  params: { location: location, names: names }
}

module logs 'modules/logs.bicep' = {
  name: 'logs'
  params: { location: location, names: names }
}

module ids 'modules/identities.bicep' = {
  name: 'identities'
  params: { location: location, names: names, keys: map(units, u => u.key) }
}

module registry 'modules/registry.bicep' = {
  name: 'registry'
  params: { location: location, names: names, identityKeys: map(units, u => u.key) }
  dependsOn: [ids]
}

module vaults 'modules/vault.bicep' = [for u in units: {
  name: 'vault-${u.key}'
  params: { location: location, names: names, key: u.key, subnet: u.subnet, seedIp: seedIp, recover: recoverVaults }
  dependsOn: [ids, network]
}]

module storage 'modules/storage.bicep' = {
  name: 'storage'
  params: { location: location, names: names }
  dependsOn: [network]
}

module foundry 'modules/foundry.bicep' = {
  name: 'foundry'
  params: {
    location: location
    names: names
    modelName: modelDeployment
    claudeOrganizationName: claudeOrganizationName
    claudeCountryCode: claudeCountryCode
    claudeIndustry: claudeIndustry
  }
  dependsOn: [ids]
}

module envs 'modules/environments.bicep' = {
  name: 'environments'
  params: { location: location, names: names }
  dependsOn: [network, logs, storage]
}

// ---- The units: each on its own image, with its own identities and vaults only (T-IAC-01 rules 12 and 13) -------
module l1 'modules/l1-apps.bicep' = if (!platformOnly) {
  name: 'l1-apps'
  params: {
    location: location
    names: names
    image: '${acrServer}/x402-l1-agent:${imageTag}'
    acrServer: acrServer
    authTenantId: tenantId
    authAudience: authAudience
    modelDeployment: modelDeployment
    agentStableRevision: agentStableRevision
  }
  dependsOn: [ids, registry, vaults, envs, foundry]
}

module l2 'modules/l2-apps.bicep' = if (!platformOnly) {
  name: 'l2-apps'
  params: {
    location: location
    names: names
    ledgerStorageName: 'ledger'
    image: '${acrServer}/x402-l2-control:${imageTag}'
    proxyImage: proxyImage
    acrServer: acrServer
    sellerPayTo: sellerPayTo
    operatorsGroupId: operatorsGroupId
  }
  dependsOn: [ids, registry, vaults, envs]
}

module l3 'modules/l3-apps.bicep' = if (!platformOnly) {
  name: 'l3-apps'
  params: {
    location: location
    names: names
    image: '${acrServer}/x402-l3-verifier:${imageTag}'
    proxyImage: proxyImage
    acrServer: acrServer
  }
  dependsOn: [ids, registry, vaults, envs]
}

module sellers 'modules/sellers.bicep' = if (!platformOnly) {
  name: 'sellers'
  params: {
    location: location
    names: names
    image: '${acrServer}/x402-seller:${imageTag}'
    acrServer: acrServer
    sellerPayTo: sellerPayTo
  }
  dependsOn: [ids, registry, vaults, envs]
}

output registry string = acrServer
output logWorkspaceCustomerId string = logs.outputs.customerId
output vaults array = [for (u, i) in units: { key: u.key, uri: vaults[i].outputs.uri }]
output agentFqdn string = platformOnly ? '' : l1!.outputs.agentFqdn
output sellerFqdn string = platformOnly ? '' : sellers!.outputs.fqdn
output sellerAliasFqdn string = platformOnly ? '' : sellers!.outputs.aliasFqdn
