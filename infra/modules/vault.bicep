// One Key Vault for one runtime unit, names.vaults.<key>, readable by exactly that unit's
// identity (FR-010, SEC-2).
// Firewall: deny by default, allow only the unit's subnet. No secret values here; vaults are seeded by hand.
// Its inputs are names, never another module's outputs, so what-if previews it on a first deployment (main.bicep).
param location string
@description('Every resource name (main.<environment>.bicepparam).')
param names object
@description('The unit\'s key: l1, l2, l3, op or seller. Its identity names.identities.<key> is the only reader.')
param key string
@description('The only subnet allowed through the firewall, names.subnets.<subnet>: x402 or seller.')
param subnet string
@description('An operator\'s public IP, allowed only while the vaults are seeded (quickstart §4 step 3); empty otherwise.')
param seedIp string = ''
@description('Recover this vault from soft-delete (after infra/cleanup.sh) instead of creating it: same name, same secrets.')
param recover bool = false

resource reader 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: names.identities[key] }

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: names.vaults[key]
  location: location
  properties: {
    tenantId: tenant().tenantId
    sku: { family: 'A', name: 'standard' }
    createMode: recover ? 'recover' : 'default'
    enableRbacAuthorization: true
    enablePurgeProtection: true
    softDeleteRetentionInDays: 90
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'None'
      virtualNetworkRules: [{ id: resourceId('Microsoft.Network/virtualNetworks/subnets', names.network, names.subnets[subnet]) }]
      ipRules: empty(seedIp) ? [] : [{ value: seedIp }]
    }
  }
}

var secretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource readerAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: kv
  name: guid(kv.id, reader.id, secretsUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', secretsUserRoleId)
    principalId: reader.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

output uri string = kv.properties.vaultUri
