// L2's apps in names.environments.x402 (specs/011 contracts/cloud-topology.md "Apps and jobs", "Non-secret env",
// "Secrets"): the control service (names.apps.l2) and the operator job (names.jobs.l2), both from L2's image. Deployed by
// main.bicep. The platform's resources it uses are looked up by their names (the names parameter), never passed in
// as another module's outputs: what-if skips a module whose parameters hold runtime values, so this keeps the module
// in the preview of a first deployment. main.bicep deploys it after the platform (dependsOn).
// T-IAC-01 asserts on the compiled form of this file:
// - PAYER_PRIVATE_KEY reaches only the l2 container, as a Key Vault reference from the l2 vault;
// - internal-only ingress through a loopback proxy sidecar that has no env and no secrets;
// - exactly one replica with the NFS ledger at /app/.local (L2-6); identity lifecycle None.
param location string
@description('Every resource name (main.<environment>.bicepparam).')
param names object
@description('The NFS ledger storage environments.bicep adds to names.environments.x402.')
param ledgerStorageName string
@description('x402-l2-control:<imageTag> in the registry (research R14).')
param image string
param proxyImage string
@description('The registry\'s login server.')
param acrServer string
param sellerPayTo string
@description('The operators\' Entra group (pre-deploy.bicep): the only principal that may start the operator job.')
param operatorsGroupId string

resource idL2 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: names.identities.l2 }
resource idOp 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: names.identities.op }
resource mainEnv 'Microsoft.App/managedEnvironments@2025-01-01' existing = { name: names.environments.x402 }
resource sellerEnv 'Microsoft.App/managedEnvironments@2025-01-01' existing = { name: names.environments.seller }

var vaultL2 = 'https://${names.vaults.l2}${az.environment().suffixes.keyvaultDns}/'
var vaultOp = 'https://${names.vaults.op}${az.environment().suffixes.keyvaultDns}/'
var mainDomain = mainEnv.properties.defaultDomain
var sellerDomain = sellerEnv.properties.defaultDomain
var controlUrl = 'http://${names.apps.l2}.internal.${mainDomain}'

// ---------------------------------------------------------------------------------------------
// L2 control: internal-only ingress through the proxy sidecar; exactly one replica; NFS ledger; lifecycle None.
// ---------------------------------------------------------------------------------------------
resource control 'Microsoft.App/containerApps@2025-01-01' = {
  name: names.apps.l2
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${idL2.id}': {} } }
  properties: {
    environmentId: mainEnv.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: { external: false, targetPort: 8080, transport: 'http', allowInsecure: true }
      registries: [{ server: acrServer, identity: idL2.id }]
      secrets: [
        { name: 'payer-private-key', keyVaultUrl: '${vaultL2}secrets/payer-private-key', identity: idL2.id }
        { name: 'control-token', keyVaultUrl: '${vaultL2}secrets/control-token', identity: idL2.id }
        { name: 'settlement-token', keyVaultUrl: '${vaultL2}secrets/settlement-token', identity: idL2.id }
        { name: 'operator-token', keyVaultUrl: '${vaultL2}secrets/operator-token', identity: idL2.id }
        // The proxy config is not a secret; Container Apps mounts files only through secret volumes.
        #disable-next-line use-secure-value-for-secure-inputs
        { name: 'nginx-conf', value: loadTextContent('../proxy/nginx-l2.conf') }
      ]
      identitySettings: [{ identity: idL2.id, lifecycle: 'None' }]
    }
    template: {
      containers: [
        {
          name: 'l2'
          image: image
          command: ['node', 'dist/src/layer2-control/service.js']
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'NETWORK', value: 'base-sepolia' }
            { name: 'ALLOWED_PAYEES', value: sellerPayTo }
            { name: 'ALLOWED_HOSTS', value: '${names.apps.seller}.${sellerDomain}' }
            { name: 'PAYER_PRIVATE_KEY', secretRef: 'payer-private-key' }
            { name: 'CONTROL_TOKEN', secretRef: 'control-token' }
            { name: 'SETTLEMENT_TOKEN', secretRef: 'settlement-token' }
            { name: 'OPERATOR_TOKEN', secretRef: 'operator-token' }
          ]
          volumeMounts: [{ volumeName: 'ledger', mountPath: '/app/.local' }]
        }
        {
          name: 'proxy'
          image: proxyImage
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          volumeMounts: [{ volumeName: 'nginx-conf', mountPath: '/etc/nginx/conf.d' }]
          probes: [
            { type: 'Liveness', tcpSocket: { port: 8080 } }
            { type: 'Readiness', tcpSocket: { port: 8080 } }
          ]
        }
      ]
      volumes: [
        { name: 'ledger', storageType: 'NfsAzureFile', storageName: ledgerStorageName }
        { name: 'nginx-conf', storageType: 'Secret', secrets: [{ secretRef: 'nginx-conf', path: 'default.conf' }] }
      ]
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Operator job: the private operator path (FR-021). Start rights on it equal holding OPERATOR_TOKEN.
// Its own command verifies the hash chain, so deploy.yml starts it as it is; an operator's start overrides command
// and args (approve, reject, escalations; quickstart §5).
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
