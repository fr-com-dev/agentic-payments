// x402 three-layer agent payments: Azure profile (SPEC.md §3.1; specs/011 contracts/cloud-topology.md).
// One resource group per environment. Deployed by .github/workflows/deploy-azure.yml from one commit;
// T-IAC-01 (test/infra.test.ts) compiles this file and asserts the identity, secret and exposure rules.
// No secret value appears here: vaults are seeded by hand (quickstart §4), never by a template or a script.
targetScope = 'resourceGroup'

param location string = 'eastus2'
@description('Short unique suffix for globally named resources (registry, storage, vaults, Foundry).')
param suffix string = take(uniqueString(resourceGroup().id), 6)
@description('Image tag: the Git commit SHA (FR-023).')
param imageTag string
param authTenantId string = tenant().tenantId
@description('The API app\'s client ID, printed by infra/entra-app.sh as AUTH_AUDIENCE. Entra v2.0 tokens carry it as aud, never the api:// URI, so there is no default.')
@minLength(36)
@maxLength(36)
param authAudience string
@description('The seller payTo address (public). L2 allows only this payee.')
param sellerPayTo string
@description('The agent revision that keeps serving during checks (empty on the first deployment).')
param agentStableRevision string = ''
@description('false deploys the base (network, identities, registry, vaults, storage, Foundry, environments) without apps: the pipeline does this first so the image can be pushed before the apps reference it.')
param deployApps bool = true
@description('nginx-unprivileged 1.29-alpine, pinned by index digest on 2026-10-22.')
param proxyImage string = 'docker.io/nginxinc/nginx-unprivileged@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6'

// The identity and vault matrix (contracts/cloud-topology.md "Role assignments"): one identity and one
// vault per runtime unit, and each identity reads only its own vault. T-IAC-01 asserts on this variable.
var units = [
  { key: 'l1', identity: 'id-l1', subnet: 'main' }
  { key: 'l2', identity: 'id-l2', subnet: 'main' }
  { key: 'l3', identity: 'id-l3', subnet: 'main' }
  { key: 'op', identity: 'id-op', subnet: 'main' }
  { key: 'seller', identity: 'id-seller', subnet: 'cp' }
]

module network 'modules/network.bicep' = {
  name: 'network'
  params: { location: location }
}

module logs 'modules/logs.bicep' = {
  name: 'logs'
  params: { location: location }
}

module ids 'modules/identities.bicep' = {
  name: 'identities'
  params: { location: location, names: map(units, u => u.identity) }
}

var identity = toObject(ids.outputs.ids, i => i.name)

module registry 'modules/registry.bicep' = {
  name: 'registry'
  params: { location: location, suffix: suffix, pullPrincipalIds: map(ids.outputs.ids, i => i.principalId) }
}

module vaults 'modules/vault.bicep' = [for u in units: {
  name: 'vault-${u.key}'
  params: {
    location: location
    name: 'kv-x402-${u.key}-${suffix}'
    principalId: identity[u.identity].principalId
    subnetId: u.subnet == 'cp' ? network.outputs.cpSubnetId : network.outputs.mainSubnetId
  }
}]

module storage 'modules/storage.bicep' = {
  name: 'storage'
  params: { location: location, suffix: suffix, subnetId: network.outputs.mainSubnetId }
}

module foundry 'modules/foundry.bicep' = {
  name: 'foundry'
  params: { location: location, suffix: suffix, agentPrincipalId: identity['id-l1'].principalId }
}

module envs 'modules/environments.bicep' = {
  name: 'environments'
  params: {
    location: location
    mainSubnetId: network.outputs.mainSubnetId
    cpSubnetId: network.outputs.cpSubnetId
    logWorkspaceName: logs.outputs.workspaceName
    nfsServer: storage.outputs.nfsServer
    nfsShareName: storage.outputs.nfsShareName
  }
}

// One image per layer, and the seller's (research R14), all tagged with the commit. Each app and job runs
// from its own unit's image, so a process carries only its own code. T-IAC-01 rule 12 asserts on this.
var images = {
  l1: '${registry.outputs.loginServer}/x402-l1-agent:${imageTag}'
  l2: '${registry.outputs.loginServer}/x402-l2-control:${imageTag}'
  l3: '${registry.outputs.loginServer}/x402-l3-verifier:${imageTag}'
  seller: '${registry.outputs.loginServer}/x402-seller:${imageTag}'
}

module apps 'modules/apps.bicep' = if (deployApps) {
  name: 'apps'
  params: {
    location: location
    mainEnvId: envs.outputs.mainId
    mainDomain: envs.outputs.mainDomain
    cpDomain: envs.outputs.cpDomain
    ledgerStorageName: envs.outputs.ledgerStorageName
    images: { l1: images.l1, l2: images.l2, l3: images.l3 }
    proxyImage: proxyImage
    acrServer: registry.outputs.loginServer
    identities: identity
    vaultUri: { l1: vaults[0].outputs.uri, l2: vaults[1].outputs.uri, l3: vaults[2].outputs.uri, op: vaults[3].outputs.uri }
    authTenantId: authTenantId
    authAudience: authAudience
    foundryBaseUrl: foundry.outputs.anthropicBaseUrl
    sellerPayTo: sellerPayTo
    agentStableRevision: agentStableRevision
  }
}

module sellers 'modules/sellers.bicep' = if (deployApps) {
  name: 'sellers'
  params: {
    location: location
    cpEnvId: envs.outputs.cpId
    image: images.seller
    acrServer: registry.outputs.loginServer
    identity: identity['id-seller']
    vaultUri: vaults[4].outputs.uri
    sellerPayTo: sellerPayTo
  }
}

output agentFqdn string = apps.?outputs.agentFqdn ?? ''
output sellerFqdn string = sellers.?outputs.fqdn ?? ''
output sellerAliasFqdn string = sellers.?outputs.aliasFqdn ?? ''
output controlUrl string = apps.?outputs.controlUrl ?? ''
output settlementUrl string = apps.?outputs.settlementUrl ?? ''
output logWorkspaceCustomerId string = logs.outputs.customerId
output registry string = registry.outputs.loginServer
output vaults array = [for (u, i) in units: { key: u.key, uri: vaults[i].outputs.uri }]
