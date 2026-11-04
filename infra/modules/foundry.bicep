// Microsoft Foundry resource for Claude (MODEL_PROVIDER=foundry), keyless: API keys are disabled, and only the
// agent's identity may call it (T-IAC-01 rules 1 and 14).
// The model deployment is named exactly the model id: the AI SDK's Anthropic provider adds a third tool under any
// other name, so the agent refuses unknown ids (CLAUDE.md).
// Its inputs are names, never another module's outputs, so what-if previews it on a first deployment (main.bicep).
param location string
@description('Every resource name (main.<environment>.bicepparam).')
param names object
@description('The Claude model, offered on Global Standard in the location (az cognitiveservices model list).')
param modelName string = 'claude-sonnet-5-5'
param modelVersion string = '2'
@description('Global Standard capacity, in thousands of tokens per minute (10 is the default the model list offers).')
param modelCapacity int = 10
@description('Who uses Claude, declared to Anthropic. Deploying the model accepts Anthropic\'s Azure Marketplace terms with these values (quickstart §4).')
param claudeOrganizationName string
@description('Two-letter country code of the organization.')
@minLength(2)
@maxLength(2)
param claudeCountryCode string
@allowed(['technology', 'finance', 'healthcare', 'education', 'retail', 'manufacturing', 'government', 'media', 'other'])
param claudeIndustry string

// The agent's identity, the only principal granted Cognitive Services User.
resource agent 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: names.identities.l1 }

resource ais 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: names.foundry
  location: location
  kind: 'AIServices'
  sku: { name: 'S0' }
  properties: {
    customSubDomainName: names.foundry
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

resource model 'Microsoft.CognitiveServices/accounts/deployments@2025-10-01-preview' = {
  parent: ais
  name: modelName
  sku: { name: 'GlobalStandard', capacity: modelCapacity }
  properties: {
    model: { format: 'Anthropic', name: modelName, version: modelVersion }
    // Required for Anthropic models: the resource provider accepts the Marketplace offer with these values. The
    // published type definitions don't list it yet (the API does; see the Azure-Samples/claude starter kit).
    #disable-next-line BCP037
    modelProviderData: { organizationName: claudeOrganizationName, countryCode: claudeCountryCode, industry: claudeIndustry }
    raiPolicyName: 'Microsoft.DefaultV2'
  }
}

var cognitiveServicesUserRoleId = 'a97b65f3-24c7-4388-baec-2e87135dc908'

resource agentUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: ais
  name: guid(ais.id, agent.id, cognitiveServicesUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesUserRoleId)
    principalId: agent.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

output modelDeployment string = model.name
output anthropicBaseUrl string = 'https://${ais.properties.customSubDomainName}.services.ai.azure.com/anthropic/v1'
