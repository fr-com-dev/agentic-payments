// Container registry: no admin user; every identity pulls with AcrPull (specs/011 contracts/cloud-topology.md).
param location string
param suffix string
@description('Principal IDs of every runtime identity, all granted AcrPull.')
param pullPrincipalIds array

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'crx402${suffix}'
  location: location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

resource pull 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for p in pullPrincipalIds: {
  scope: acr
  name: guid(acr.id, p, acrPullRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: p
    principalType: 'ServicePrincipal'
  }
}]

output loginServer string = acr.properties.loginServer
