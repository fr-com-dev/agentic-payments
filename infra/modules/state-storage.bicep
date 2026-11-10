// Blob storage for the Terraform state of auth0/ (SPEC §13; specs/012 research R17), which
// .github/workflows/provision-auth0.yml reads and writes as the deploy app. Deployed by pre-deploy.bicep, before any
// pipeline runs. The state holds no secret (T-IAC-02), but it names the tenant and is what Terraform plans against:
// Entra sign-in only (no account key, no anonymous access), and versions and deleted blobs kept so a bad write can be
// undone. GitHub-hosted runners have no fixed address, so the account has no firewall: the role below is the gate.
// T-IAC-01 rule 20 asserts all of this.
param location string
@description('Every name of pre-deploy.<environment>.bicepparam: stateStorage is used here.')
param names object
@description('The deploy app\'s service principal: the only principal that reads and writes the state.')
param principalId string

// Storage Blob Data Contributor.
var blobContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource st 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  // Lowercase letters and digits only.
  name: names.stateStorage
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowSharedKeyAccess: false
    allowBlobPublicAccess: false
    allowCrossTenantReplication: false
  }
}

resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: st
  name: 'default'
  properties: {
    isVersioningEnabled: true
    deleteRetentionPolicy: { enabled: true, days: 30 }
    containerDeleteRetentionPolicy: { enabled: true, days: 30 }
  }
}

resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobs
  name: 'tfstate'
  properties: { publicAccess: 'None' }
}

// On the container only: the deploy app gets no other data in the account.
resource stateAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(container.id, principalId, blobContributorRoleId)
  scope: container
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobContributorRoleId)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}
