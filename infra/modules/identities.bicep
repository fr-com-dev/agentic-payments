// One user-assigned identity per runtime unit, names.identities.<key> (specs/011 contracts/cloud-topology.md).
param location string
@description('Every resource name (main.<environment>.bicepparam).')
param names object
@description('The units\' keys: l1, l2, l3, op, seller.')
param keys array

resource ids 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = [for k in keys: {
  name: names.identities[k]
  location: location
}]

output ids array = [for (k, i) in keys: { key: k, name: ids[i].name, id: ids[i].id, principalId: ids[i].properties.principalId, clientId: ids[i].properties.clientId }]
