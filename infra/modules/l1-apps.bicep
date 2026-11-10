// L1's apps in names.environments.x402 (specs/011 contracts/cloud-topology.md "Apps and jobs", "Non-secret env",
// "Secrets"): the hosted agent (names.apps.l1) and the regression job (names.jobs.l1), both from L1's image. Deployed by
// main.bicep. The platform's resources it uses are looked up by their names (the names parameter), never passed in
// as another module's outputs: what-if skips a module whose parameters hold runtime values, so this keeps the module
// in the preview of a first deployment. main.bicep deploys it after the platform (dependsOn).
// T-IAC-01 asserts on the compiled form of this file:
// - secrets come only from the l1 vault, as Key Vault references;
// - identity lifecycle is Main only for the agent (Foundry tokens), None for the regression job;
// - the agent's AUTH_AUDIENCE comes from the authAudience parameter;
// - 013 (rule 21): the agent's PORTAL_CLIENT_ID, the azp it refuses, comes from the userAccounts parameter.
param location string
@description('Every resource name (main.<environment>.bicepparam).')
param names object
@description('x402-l1-agent:<imageTag> in the registry (research R14).')
param image string
@description('The registry\'s login server.')
param acrServer string
param authTenantId string
param authAudience string
@description('The Foundry model deployment, named exactly the model id: the agent\'s ANTHROPIC_MODEL.')
param modelDeployment string
@description('The agent revision that keeps serving until the new one passes the regression (empty on the first deployment).')
param agentStableRevision string = ''
@description('013 user accounts (SPEC L2-8): the non-secret settings from the parameter file. The agent reads portalClientId only.')
param userAccounts object

resource idL1 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: names.identities.l1 }
resource mainEnv 'Microsoft.App/managedEnvironments@2025-01-01' existing = { name: names.environments.x402 }
resource sellerEnv 'Microsoft.App/managedEnvironments@2025-01-01' existing = { name: names.environments.seller }
resource ais 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = { name: names.foundry }

var vaultL1 = 'https://${names.vaults.l1}${az.environment().suffixes.keyvaultDns}/'
var mainDomain = mainEnv.properties.defaultDomain
var sellerDomain = sellerEnv.properties.defaultDomain
var controlUrl = 'http://${names.apps.l2}.internal.${mainDomain}'
var settlementUrl = 'http://${names.apps.l3}.internal.${mainDomain}'
var sellerUrl = 'https://${names.apps.seller}.${sellerDomain}'

// ---------------------------------------------------------------------------------------------
// Hosted agent service (L1-6): public ingress, multiple revisions, 0–1 replicas, identity lifecycle Main.
// ---------------------------------------------------------------------------------------------
resource agent 'Microsoft.App/containerApps@2025-01-01' = {
  name: names.apps.l1
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${idL1.id}': {} } }
  properties: {
    environmentId: mainEnv.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Multiple'
      ingress: {
        external: true
        targetPort: 4024
        transport: 'auto'
        allowInsecure: false
        traffic: empty(agentStableRevision)
          ? [{ latestRevision: true, weight: 100 }]
          : [{ revisionName: agentStableRevision, weight: 100 }, { latestRevision: true, weight: 0, label: 'candidate' }]
      }
      registries: [{ server: acrServer, identity: idL1.id }]
      secrets: [
        { name: 'control-token', keyVaultUrl: '${vaultL1}secrets/control-token', identity: idL1.id }
        { name: 'verifier-token', keyVaultUrl: '${vaultL1}secrets/verifier-token', identity: idL1.id }
        { name: 'session-ref-secret', keyVaultUrl: '${vaultL1}secrets/session-ref-secret', identity: idL1.id }
      ]
      identitySettings: [{ identity: idL1.id, lifecycle: 'Main' }]
    }
    template: {
      containers: [
        {
          name: 'agent'
          image: image
          command: ['node', 'dist/src/hosted-main.js']
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'NETWORK', value: 'base-sepolia' }
            { name: 'SELLER_URL', value: sellerUrl }
            { name: 'CONTROL_URL', value: controlUrl }
            { name: 'SETTLEMENT_URL', value: settlementUrl }
            { name: 'MODEL_PROVIDER', value: 'foundry' }
            { name: 'ANTHROPIC_MODEL', value: modelDeployment }
            { name: 'FOUNDRY_BASE_URL', value: 'https://${ais.properties.customSubDomainName}.services.ai.azure.com/anthropic/v1' }
            { name: 'AZURE_CLIENT_ID', value: idL1.properties.clientId }
            { name: 'AUTH_TENANT_ID', value: authTenantId }
            { name: 'AUTH_AUDIENCE', value: authAudience }
            { name: 'PORTAL_CLIENT_ID', value: userAccounts.portalClientId }
            { name: 'AGENT_BIND_HOST', value: '0.0.0.0' }
            { name: 'AGENT_PORT', value: '4024' }
            { name: 'MASTRA_TELEMETRY_DISABLED', value: '1' }
            { name: 'CONTROL_TOKEN', secretRef: 'control-token' }
            { name: 'VERIFIER_TOKEN', secretRef: 'verifier-token' }
            { name: 'SESSION_REF_SECRET', secretRef: 'session-ref-secret' }
          ]
          probes: [
            { type: 'Liveness', httpGet: { path: '/healthz', port: 4024 } }
            { type: 'Readiness', httpGet: { path: '/readyz', port: 4024 } }
          ]
        }
      ]
      scale: { minReplicas: 0, maxReplicas: 1 }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Regression job: the L1-4 scripted plan through the deployed environment, gated by --check-baseline
// (FR-024). L1 credentials from the l1 vault only; no operator token (the chain check runs in L2's operator job).
// Start rights on it equal holding L1's credentials: only the deploy identity gets them.
// ---------------------------------------------------------------------------------------------
resource regressionJob 'Microsoft.App/jobs@2025-01-01' = {
  name: names.jobs.l1
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${idL1.id}': {} } }
  properties: {
    environmentId: mainEnv.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 900
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: [{ server: acrServer, identity: idL1.id }]
      secrets: [
        { name: 'control-token', keyVaultUrl: '${vaultL1}secrets/control-token', identity: idL1.id }
        { name: 'verifier-token', keyVaultUrl: '${vaultL1}secrets/verifier-token', identity: idL1.id }
      ]
      identitySettings: [{ identity: idL1.id, lifecycle: 'None' }]
    }
    template: {
      containers: [
        {
          name: 'regression'
          image: image
          command: ['node', 'dist/src/main.js', '--scripted', '--check-baseline']
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            { name: 'NETWORK', value: 'base-sepolia' }
            { name: 'SELLER_URL', value: sellerUrl }
            { name: 'SELLER_ALIAS_URL', value: 'https://${names.apps.sellerAlias}.${sellerDomain}' }
            { name: 'CONTROL_URL', value: controlUrl }
            { name: 'SETTLEMENT_URL', value: settlementUrl }
            { name: 'CONTROL_TOKEN', secretRef: 'control-token' }
            { name: 'VERIFIER_TOKEN', secretRef: 'verifier-token' }
          ]
        }
      ]
    }
  }
}

output agentFqdn string = agent.properties.configuration.ingress.fqdn
