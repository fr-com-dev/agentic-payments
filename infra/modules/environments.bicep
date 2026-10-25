// Two Container Apps environments (specs/011 contracts/cloud-topology.md, research R10).
// cae-x402: the agent, L2, L3 and the jobs; internal-only ingress here is reachable only from this
// environment. cae-x402-cp: the sellers, an external party that must not reach the internal apps.
param location string
param mainSubnetId string
param cpSubnetId string
param logWorkspaceName string
param nfsServer string
param nfsShareName string

resource law 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: logWorkspaceName
}

var logs = {
  destination: 'log-analytics'
  logAnalyticsConfiguration: {
    customerId: law.properties.customerId
    sharedKey: law.listKeys().primarySharedKey
  }
}

resource main 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: 'cae-x402'
  location: location
  properties: {
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    vnetConfiguration: { infrastructureSubnetId: mainSubnetId, internal: false }
    peerTrafficConfiguration: { encryption: { enabled: true } }
    appLogsConfiguration: logs
  }
}

resource ledger 'Microsoft.App/managedEnvironments/storages@2025-01-01' = {
  parent: main
  name: 'ledger'
  properties: {
    nfsAzureFile: {
      server: nfsServer
      shareName: nfsShareName
      accessMode: 'ReadWrite'
    }
  }
}

resource cp 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: 'cae-x402-cp'
  location: location
  properties: {
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    vnetConfiguration: { infrastructureSubnetId: cpSubnetId, internal: false }
    appLogsConfiguration: logs
  }
}

output mainId string = main.id
output mainDomain string = main.properties.defaultDomain
output cpId string = cp.id
output cpDomain string = cp.properties.defaultDomain
output ledgerStorageName string = ledger.name
