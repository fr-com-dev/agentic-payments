// One user-assigned identity per runtime unit (specs/011 contracts/cloud-topology.md).
param location string
param names array

resource ids 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = [for n in names: {
  name: n
  location: location
}]

output ids array = [for (n, i) in names: { name: n, id: ids[i].id, principalId: ids[i].properties.principalId, clientId: ids[i].properties.clientId }]
