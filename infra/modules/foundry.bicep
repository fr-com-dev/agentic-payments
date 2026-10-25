// Microsoft Foundry resource for Claude (MODEL_PROVIDER=foundry), keyless: only the agent's identity may call it.
// The model deployment is created in the portal (quickstart §4 step 1) and must be named exactly the model id.
param location string
param suffix string
param agentPrincipalId string

resource ais 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: 'ais-x402-${suffix}'
  location: location
  kind: 'AIServices'
  sku: { name: 'S0' }
  properties: {
    customSubDomainName: 'ais-x402-${suffix}'
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

var cognitiveServicesUserRoleId = 'a97b65f3-24c7-4388-baec-2e87135dc908'

resource agentUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: ais
  name: guid(ais.id, agentPrincipalId, cognitiveServicesUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesUserRoleId)
    principalId: agentPrincipalId
    principalType: 'ServicePrincipal'
  }
}

output anthropicBaseUrl string = 'https://${ais.properties.customSubDomainName}.services.ai.azure.com/anthropic/v1'
