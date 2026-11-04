// The operator's job in names.environments.x402 (specs/011 contracts/cloud-topology.md "Apps and jobs", "Non-secret
// env", "Secrets"): the private operator path (names.jobs.l2, FR-021), from the operator's own image. Deployed by
// main.bicep when unit is 'operator' (deploy-operator.yml). The platform's resources it uses are looked up by their
// names (the names parameter), never passed in as another module's outputs: what-if skips a module whose parameters
// hold runtime values, so this keeps the module in the preview of a first deployment. main.bicep deploys it after the
// platform (dependsOn).
// T-IAC-01 asserts on the compiled form of this file:
// - its only secret, OPERATOR_TOKEN, comes from the op vault, as a Key Vault reference;
// - its own command is ledger-verify, the only one the pipelines start it with;
// - only the operators' group may start it; identity lifecycle None.
param location string
@description('Every resource name (main.<environment>.bicepparam).')
param names object
@description('x402-operator:<imageTag> in the registry (research R14).')
param image string
@description('The registry\'s login server.')
param acrServer string
@description('The operators\' Entra group (pre-deploy.bicep): the only principal that may start the operator job.')
param operatorsGroupId string

resource idOp 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: names.identities.op }
resource mainEnv 'Microsoft.App/managedEnvironments@2025-01-01' existing = { name: names.environments.x402 }

var vaultOp = 'https://${names.vaults.op}${az.environment().suffixes.keyvaultDns}/'
var controlUrl = 'http://${names.apps.l2}.internal.${mainEnv.properties.defaultDomain}'

// ---------------------------------------------------------------------------------------------
// Operator job: the private operator path (FR-021). Start rights on it equal holding OPERATOR_TOKEN.
// Its own command verifies the hash chain, so the pipelines start it as it is; an operator's start overrides
// command and args (approve, reject, escalations; quickstart §5).
// ---------------------------------------------------------------------------------------------
resource operatorJob 'Microsoft.App/jobs@2025-01-01' = {
  name: names.jobs.l2
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${idOp.id}': {} } }
  properties: {
    environmentId: mainEnv.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 3600
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: [{ server: acrServer, identity: idOp.id }]
      secrets: [{ name: 'operator-token', keyVaultUrl: '${vaultOp}secrets/operator-token', identity: idOp.id }]
      identitySettings: [{ identity: idOp.id, lifecycle: 'None' }]
    }
    template: {
      containers: [
        {
          name: 'operator'
          image: image
          command: ['node', 'dist/scripts/ledger-verify.js']
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            { name: 'NETWORK', value: 'base-sepolia' }
            { name: 'CONTROL_URL', value: controlUrl }
            { name: 'OPERATOR_TOKEN', secretRef: 'operator-token' }
          ]
        }
      ]
    }
  }
}

// Starting the operator job grants its credentials (OPERATOR_TOKEN), so only the operators' group may: Container
// Apps Jobs Operator on this job, not on the resource group (the regression job holds L1's credentials).
var jobsOperatorRoleId = 'b9a307c4-5aa3-4b52-ba60-2b17c136cd7b'

resource operators 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: operatorJob
  name: guid(operatorJob.id, operatorsGroupId, jobsOperatorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', jobsOperatorRoleId)
    principalId: operatorsGroupId
    principalType: 'Group'
  }
}
