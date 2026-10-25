// Log Analytics for container stdout (FR-025; the post-deployment secret scan reads it).
param location string

resource law 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-x402'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

output workspaceName string = law.name
output customerId string = law.properties.customerId
