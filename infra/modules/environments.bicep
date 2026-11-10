// Two Container Apps environments (specs/011 contracts/cloud-topology.md, research R10).
// names.environments.x402: the agent, L2, L3, the portal (013) and the jobs; internal-only ingress here is reachable
// only from this environment. Its two NFS storages, `ledger` (L2) and `profiles` (the portal), have one app each. names.environments.seller: the sellers, an external party that must not reach the internal apps.
// Its inputs are names, never another module's outputs, so what-if previews it on a first deployment (main.bicep).
param location string
@description('Every resource name (main.<environment>.bicepparam).')
param names object

resource law 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: names.logs
}

var logs = {
  destination: 'log-analytics'
  logAnalyticsConfiguration: {
    customerId: law.properties.customerId
    sharedKey: law.listKeys().primarySharedKey
  }
}

resource main 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: names.environments.x402
  location: location
  properties: {
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    vnetConfiguration: { infrastructureSubnetId: resourceId('Microsoft.Network/virtualNetworks/subnets', names.network, names.subnets.x402), internal: false }
    peerTrafficConfiguration: { encryption: { enabled: true } }
    appLogsConfiguration: logs
  }
}

resource ledger 'Microsoft.App/managedEnvironments/storages@2025-01-01' = {
  parent: main
  name: 'ledger'
  properties: {
    nfsAzureFile: {
      server: '${names.storage}.file.${az.environment().suffixes.storage}'
      shareName: '/${names.storage}/ledger'
      accessMode: 'ReadWrite'
    }
  }
}

resource profiles 'Microsoft.App/managedEnvironments/storages@2025-01-01' = {
  parent: main
  name: 'profiles'
  properties: {
    nfsAzureFile: {
      server: '${names.storage}.file.${az.environment().suffixes.storage}'
      shareName: '/${names.storage}/profiles'
      accessMode: 'ReadWrite'
    }
  }
}

resource seller 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: names.environments.seller
  location: location
  properties: {
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    vnetConfiguration: { infrastructureSubnetId: resourceId('Microsoft.Network/virtualNetworks/subnets', names.network, names.subnets.seller), internal: false }
    appLogsConfiguration: logs
  }
}

output mainId string = main.id
output mainDomain string = main.properties.defaultDomain
output sellerId string = seller.id
output sellerDomain string = seller.properties.defaultDomain
output ledgerStorageName string = ledger.name
output profilesStorageName string = profiles.name
