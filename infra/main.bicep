// x402 three-layer agent payments: the Azure platform (SPEC.md §3.1; specs/011 contracts/cloud-topology.md).
// One resource group per environment: network, logs, identities, registry, vaults, storage, Foundry and the
// two Container Apps environments. No apps: each layer's template (l1-agent.bicep, l2-control.bicep,
// l3-verifier.bicep) and the seller's (seller.bicep) deploys its own apps on this platform. Deployed by
// .github/workflows/deploy-infra.yml; T-IAC-01 (test/infra.test.ts) compiles it with the unit templates and
// asserts the identity, secret and exposure rules. No secret value appears here: vaults are seeded by hand
// (quickstart §4), never by a template or a script.
targetScope = 'resourceGroup'

param location string = 'eastus2'
@description('Short unique suffix for globally named resources (registry, storage, vaults, Foundry).')
param suffix string = take(uniqueString(resourceGroup().id), 6)

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

output logWorkspaceCustomerId string = logs.outputs.customerId
output registry string = registry.outputs.loginServer
output vaults array = [for (u, i) in units: { key: u.key, uri: vaults[i].outputs.uri }]
