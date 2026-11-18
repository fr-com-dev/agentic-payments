// One user-assigned identity per key of names.identities (specs/011 contracts/cloud-topology.md). SPEC 1.25: deployed
// by pre-deploy.bicep, by an administrator, so the deploy app's condition can name each principal; main.bicep's
// modules only look the identities up by name.
param location string
@description('Every resource name (pre-deploy.<environment>.bicepparam).')
param names object
@description('The identities\' keys: names.identities\'s, l1, l2, l3, op, portal and seller.')
param keys array

resource ids 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = [for k in keys: {
  name: names.identities[k]
  location: location
}]

output ids array = [for (k, i) in keys: { key: k, name: ids[i].name, id: ids[i].id, principalId: ids[i].properties.principalId, clientId: ids[i].properties.clientId }]
