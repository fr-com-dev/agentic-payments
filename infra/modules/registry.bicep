// Container registry: no admin user; every identity pulls with AcrPull (specs/011 contracts/cloud-topology.md).
// Its inputs are names, never another module's outputs, so what-if previews it on a first deployment (main.bicep).
param location string
@description('Every resource name (main.<environment>.bicepparam).')
param names object
@description('Every unit\'s key: each identity names.identities.<key> is granted AcrPull.')
param identityKeys array

resource pullers 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = [for k in identityKeys: { name: names.identities[k] }]

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  // Letters and digits only.
  name: names.registry
  location: location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

resource pull 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (k, i) in identityKeys: {
  scope: acr
  name: guid(acr.id, pullers[i].id, acrPullRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: pullers[i].properties.principalId
    principalType: 'ServicePrincipal'
  }
}]

output loginServer string = acr.properties.loginServer
