// One Key Vault for one runtime unit, readable by exactly that unit's identity (FR-010, SEC-2).
// Firewall: deny by default, allow only the unit's subnet. No secret values here; vaults are seeded by hand.
param location string
param name string
@description('The only principal granted Key Vault Secrets User on this vault.')
param principalId string
@description('The only subnet allowed through the firewall.')
param subnetId string

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: name
  location: location
  properties: {
    tenantId: tenant().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enablePurgeProtection: true
    softDeleteRetentionInDays: 90
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'None'
      virtualNetworkRules: [{ id: subnetId }]
      ipRules: []
    }
  }
}

var secretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource reader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: kv
  name: guid(kv.id, principalId, secretsUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', secretsUserRoleId)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

output uri string = kv.properties.vaultUri
