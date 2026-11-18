// The deploy identity's Azure roles, on its resource group only (specs/011 contracts/cloud-topology.md "Role
// assignments"). Contributor deploys main.bicep. Role Based Access Control Administrator lets it make main.bicep's
// role assignments, and a condition limits it to those roles: it can't grant Owner or Contributor. SPEC 1.25 (Phase
// 3 gap review, finding 2): the condition also limits the principals, written or deleted, to the ones main.bicep
// assigns roles to: the units' identities, which pre-deploy.bicep makes, and the operators' group. So a pipeline run
// can't give one of those roles to the deploy app itself (1.19), nor to any other principal it chooses (a user, a
// guest, an app of its own, or a new identity). Deployed by pre-deploy.bicep; T-IAC-01 rule 16 asserts the condition
// lists exactly the roles main.bicep assigns and exactly those principals.
@description('The deploy app\'s service principal.')
param principalId string
@description('The only principals the deploy app may give a role to or take one from: the units\' identities\' principals and the operators\' group.')
param assigneeIds array

var contributorRoleId = 'b24988ac-6180-42a0-ab88-20f7382dd24c'
var rbacAdministratorRoleId = 'f58310d9-a9f6-439a-9e8d-f62e7b41a168'
// Key Vault Secrets User, AcrPull, Cognitive Services User, Container Apps Jobs Operator, and (1.23) Storage Blob
// Data Contributor, which main.bicep gives the ledger head's identity on the head's container.
var assignableRoleIds = [
  '4633458b-17de-408a-b874-0445c86b69e6'
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
  'a97b65f3-24c7-4388-baec-2e87135dc908'
  'b9a307c4-5aa3-4b52-ba60-2b17c136cd7b'
  'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
]
var assignable = join(assignableRoleIds, ', ')
var assignees = join(assigneeIds, ', ')

resource contributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, principalId, contributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', contributorRoleId)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

resource rbacAdministrator 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, principalId, rbacAdministratorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', rbacAdministratorRoleId)
    principalId: principalId
    principalType: 'ServicePrincipal'
    conditionVersion: '2.0'
    condition: '((!(ActionMatches{\'Microsoft.Authorization/roleAssignments/write\'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${assignable}} AND @Request[Microsoft.Authorization/roleAssignments:PrincipalId] ForAnyOfAnyValues:GuidEquals {${assignees}})) AND ((!(ActionMatches{\'Microsoft.Authorization/roleAssignments/delete\'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${assignable}} AND @Resource[Microsoft.Authorization/roleAssignments:PrincipalId] ForAnyOfAnyValues:GuidEquals {${assignees}}))'
  }
}
