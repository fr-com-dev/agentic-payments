// 1.23 (SPEC.md §8.2 L2-4, SEC-39; Phase 3 finding #7): the ledger's head, outside the ledger's NFS share. L2 writes
// one blob here after every serialized section, { entries, hash, mac } of its ledger, and refuses at startup a ledger
// shorter than it, or another ledger in its place. A cut of the share (which every app of the x402 subnet can reach)
// therefore no longer goes unnoticed: whoever cuts it would also have to move this head back, and only the head
// identity may write it.
// - The account takes Entra sign-in only (no account key, no SAS, no anonymous access) and only the x402 subnet.
// - One private container, ledger-head. One role on it: Storage Blob Data Contributor for the head identity
//   (names.identities.l2head), whose only use is this. L2's own identity stays at lifecycle None: Container Apps gives
//   an identity to every main container of an app, L2's nginx sidecar included, and L2's identity can read the l2
//   vault (the payer key). This one can write the head only.
// - Platform module (deploy-infra.yml), so the role exists before L2's first start with 1.23, which writes the head.
// Its inputs are names, never another module's outputs, so what-if previews it on a first deployment (main.bicep).
// T-IAC-01 rule 25 asserts all of this; rule 1 knows the role, rule 16 the deploy app's condition for it.
param location string
@description('Every resource name (main.<environment>.bicepparam): ledgerHead is made here; identities.l2head (made by pre-deploy.bicep) is looked up.')
param names object

// Storage Blob Data Contributor.
var blobContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

// SPEC 1.25: pre-deploy.bicep makes the head identity with the others, so the deploy app's condition admits it as the
// principal of the role below; this module only looks it up.
resource writer 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: names.identities.l2head
}

resource st 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  // Lowercase letters and digits only.
  name: names.ledgerHead
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowSharedKeyAccess: false
    allowBlobPublicAccess: false
    allowCrossTenantReplication: false
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'None'
      virtualNetworkRules: [{ id: resourceId('Microsoft.Network/virtualNetworks/subnets', names.network, names.subnets.x402), action: 'Allow' }]
    }
  }
}

resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: st
  name: 'default'
  properties: {
    // A deleted head or container can be undone for a week. No versions: every write would keep one.
    deleteRetentionPolicy: { enabled: true, days: 7 }
    containerDeleteRetentionPolicy: { enabled: true, days: 7 }
  }
}

resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobs
  name: 'ledger-head'
  properties: { publicAccess: 'None' }
}

// On the container only, for the head identity only.
resource headAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(container.id, writer.id, blobContributorRoleId)
  scope: container
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobContributorRoleId)
    principalId: writer.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
