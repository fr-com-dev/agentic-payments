// The deploy identity's Azure roles, on its resource group only (specs/011 contracts/cloud-topology.md "Role
// assignments"). Contributor deploys main.bicep. Role Based Access Control Administrator lets it make main.bicep's
// role assignments, and a condition limits it to those roles: it can't grant Owner, Contributor or itself more.
// Deployed by pre-deploy.bicep; T-IAC-01 rule 16 asserts the condition lists exactly the roles main.bicep assigns.
@description('The deploy app\'s service principal.')
param principalId string

var contributorRoleId = 'b24988ac-6180-42a0-ab88-20f7382dd24c'
var rbacAdministratorRoleId = 'f58310d9-a9f6-439a-9e8d-f62e7b41a168'
// Key Vault Secrets User, AcrPull, Cognitive Services User, Container Apps Jobs Operator.
var assignableRoleIds = [
  '4633458b-17de-408a-b874-0445c86b69e6'
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
  'a97b65f3-24c7-4388-baec-2e87135dc908'
  'b9a307c4-5aa3-4b52-ba60-2b17c136cd7b'
]
var assignable = join(assignableRoleIds, ', ')

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
    condition: '((!(ActionMatches{\'Microsoft.Authorization/roleAssignments/write\'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${assignable}})) AND ((!(ActionMatches{\'Microsoft.Authorization/roleAssignments/delete\'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${assignable}}))'
  }
}
