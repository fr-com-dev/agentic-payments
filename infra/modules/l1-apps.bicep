// L1's apps in cae-x402 (specs/011 contracts/cloud-topology.md "Apps and jobs", "Non-secret env",
// "Secrets"): the hosted agent and job-regression, both from L1's image. Deployed by l1-agent.bicep
// (deploy-l1.yml). T-IAC-01 asserts on the compiled form of this file:
// - secrets come only from the l1 vault, as Key Vault references;
// - identity lifecycle is Main only for the agent (Foundry tokens), None for job-regression;
// - the agent's AUTH_AUDIENCE comes from the authAudience parameter.
param location string
param mainEnvId string
param mainDomain string
param cpDomain string
@description('x402-l1-agent:<imageTag> in the registry (research R14).')
param image string
param acrServer string
@description('id-l1 → { id, clientId }.')
param identities object
@description('l1 → the l1 vault URI (ends with /).')
param vaultUri object
param authTenantId string
param authAudience string
param foundryBaseUrl string
@description('The agent revision that keeps serving until the new one passes the regression (empty on the first deployment).')
param agentStableRevision string = ''

var controlUrl = 'http://ca-l2-control.internal.${mainDomain}'
var settlementUrl = 'http://ca-l3-verifier.internal.${mainDomain}'
var sellerUrl = 'https://ca-seller.${cpDomain}'

// ---------------------------------------------------------------------------------------------
// Hosted agent service (L1-6): public ingress, multiple revisions, 0–1 replicas, identity lifecycle Main.
// ---------------------------------------------------------------------------------------------
resource agent 'Microsoft.App/containerApps@2025-01-01' = {
  name: 'ca-l1-agent'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identities['id-l1'].id}': {} } }
  properties: {
    environmentId: mainEnvId
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
      registries: [{ server: acrServer, identity: identities['id-l1'].id }]
      secrets: [
        { name: 'control-token', keyVaultUrl: '${vaultUri.l1}secrets/control-token', identity: identities['id-l1'].id }
        { name: 'verifier-token', keyVaultUrl: '${vaultUri.l1}secrets/verifier-token', identity: identities['id-l1'].id }
        { name: 'session-ref-secret', keyVaultUrl: '${vaultUri.l1}secrets/session-ref-secret', identity: identities['id-l1'].id }
      ]
      identitySettings: [{ identity: identities['id-l1'].id, lifecycle: 'Main' }]
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
            { name: 'ANTHROPIC_MODEL', value: 'claude-sonnet-5-5' }
            { name: 'FOUNDRY_BASE_URL', value: foundryBaseUrl }
            { name: 'AZURE_CLIENT_ID', value: identities['id-l1'].clientId }
            { name: 'AUTH_TENANT_ID', value: authTenantId }
            { name: 'AUTH_AUDIENCE', value: authAudience }
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
// (FR-024). L1 credentials from the l1 vault only; no operator token (the chain check runs in job-operator).
// Start rights on it equal holding L1's credentials: only the deploy identity gets them.
// ---------------------------------------------------------------------------------------------
resource regressionJob 'Microsoft.App/jobs@2025-01-01' = {
  name: 'job-regression'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identities['id-l1'].id}': {} } }
  properties: {
    environmentId: mainEnvId
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 900
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: [{ server: acrServer, identity: identities['id-l1'].id }]
      secrets: [
        { name: 'control-token', keyVaultUrl: '${vaultUri.l1}secrets/control-token', identity: identities['id-l1'].id }
        { name: 'verifier-token', keyVaultUrl: '${vaultUri.l1}secrets/verifier-token', identity: identities['id-l1'].id }
      ]
      identitySettings: [{ identity: identities['id-l1'].id, lifecycle: 'None' }]
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
            { name: 'SELLER_ALIAS_URL', value: 'https://ca-seller-alias.${cpDomain}' }
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
