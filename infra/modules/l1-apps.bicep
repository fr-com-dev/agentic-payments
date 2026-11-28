// L1's apps in names.environments.x402 (specs/011 contracts/cloud-topology.md "Apps and jobs", "Non-secret env",
// "Secrets"; specs/016 contracts/tenant-and-config.md "Azure"): the hosted agent (names.apps.l1), the regression job
// (names.jobs.l1) and the smoke job (names.jobs.smoke), all three from L1's image. Deployed by main.bicep. The platform's resources it uses are looked up by their names (the names parameter), never passed in
// as another module's outputs: what-if skips a module whose parameters hold runtime values, so this keeps the module
// in the preview of a first deployment. main.bicep deploys it after the platform (dependsOn).
// T-IAC-01 asserts on the compiled form of this file:
// - secrets come only from the l1 vault, as Key Vault references;
// - identity lifecycle is Main only for the agent (Foundry tokens), None for the two jobs;
// - 016 (rule 23): the agent accepts the sign-in tenant's callers only. It gets AUTH_ISSUER and AUTH_AUDIENCE from
//   the identity parameter and AGENT_CLIENT_IDS from agent.clientId (and agent.desktopClientId when set, 019), the
//   same values L2 gets, AGENT_DESKTOP_CLIENT_ID from agent.desktopClientId, and nothing of the
//   directory (no AUTH_TENANT_ID, no SERVICE_AUDIENCE). It is the only container with API_DOCS, which is
//   agent.apiDocs and nothing else;
// - 021 (rule 27): the agent is the only container with AGENT_TEST_MODE, which is agent.testMode and nothing else;
// - 016 (rule 23): the two jobs call as the pipeline's machine caller. Each gets the tenant, the machine client's ID
//   and its key's ID from the parameters, and the key itself as a reference to the l1 vault's machine-client-key,
//   which every environment seeds (the placeholder off until the tenant has the client). The agent's container gets
//   none of it, and the smoke job holds no role token: it calls the agent's public API only.
param location string
@description('Every resource name (main.<environment>.bicepparam).')
param names object
@description('x402-l1-agent:<imageTag> in the registry (research R14).')
param image string
@description('The registry\'s login server.')
param acrServer string
@description('The sign-in tenant (main.<environment>.bicepparam): its issuer and the API\'s identifier.')
param identity object
@description('016: the agent\'s client, the docs switch, the desktop client (019, empty when the tenant has none), and the machine caller\'s client and key ID (main.<environment>.bicepparam).')
param agent object
@description('The Foundry model deployment, named exactly the model id: the agent\'s ANTHROPIC_MODEL.')
param modelDeployment string
@description('The agent revision that keeps serving until the new one passes the regression (empty on the first deployment).')
param agentStableRevision string = ''

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
// The agent's public address, and the one of its `candidate` label: the revision an L1 deployment starts at 0% of
// the traffic (the ingress below). The smoke job can't be passed a value when it is started, so it gets both.
var agentUrl = 'https://${names.apps.l1}.${mainDomain}'
var agentCandidateUrl = 'https://${names.apps.l1}---candidate.${mainDomain}'

// ---------------------------------------------------------------------------------------------
// Hosted agent service (L1-6): public ingress, multiple revisions, 0–1 replicas, identity lifecycle Main.
// ---------------------------------------------------------------------------------------------
resource agentApp 'Microsoft.App/containerApps@2025-01-01' = {
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
            // The sign-in tenant's callers only (016): a person who signed in through the agent's client or (019) the
            // desktop client, or a machine caller. L2 gets the same three values and verifies the forwarded token again.
            { name: 'AUTH_ISSUER', value: identity.issuer }
            { name: 'AUTH_AUDIENCE', value: identity.audience }
            { name: 'AGENT_CLIENT_IDS', value: empty(agent.desktopClientId) ? agent.clientId : '${agent.clientId},${agent.desktopClientId}' }
            // 019: the desktop client, whose sign-in settings the agent serves (GET /.well-known/agent-auth); empty
            // where this environment's tenant has none, and the route doesn't exist.
            { name: 'AGENT_DESKTOP_CLIENT_ID', value: agent.desktopClientId }
            // The docs page, where this environment's parameter file turns it on: it signs people in through the
            // agent's own client.
            { name: 'API_DOCS', value: agent.apiDocs ? '1' : '0' }
            { name: 'API_DOCS_CLIENT_ID', value: agent.apiDocs ? agent.clientId : '' }
            // 021: the agent's mode, from this environment's parameter file: test mode is the agent of before 021,
            // straight to the configured seller; search mode may search the public x402 discovery index first, at
            // the network's default address (rule 27).
            { name: 'AGENT_TEST_MODE', value: agent.testMode ? '1' : '0' }
            { name: 'AGENT_BIND_HOST', value: '0.0.0.0' }
            // One proxy, the environment's ingress, is in front: the per-address request limit reads the client's
            // address from X-Forwarded-For (T-IAC-01 rule 3).
            { name: 'TRUSTED_PROXY_HOPS', value: '1' }
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
// Start rights on it equal holding L1's credentials: only the deploy identity gets them. 016: it calls L2 as the
// pipeline's machine caller, with a token it gets from the sign-in tenant itself.
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
        { name: 'machine-client-key', keyVaultUrl: '${vaultL1}secrets/machine-client-key', identity: idL1.id }
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
            { name: 'AUTH_ISSUER', value: identity.issuer }
            { name: 'AUTH_AUDIENCE', value: identity.audience }
            { name: 'MACHINE_CLIENT_ID', value: agent.machineClientId }
            { name: 'MACHINE_CLIENT_KEY_ID', value: agent.machineKeyId }
            { name: 'CONTROL_TOKEN', secretRef: 'control-token' }
            { name: 'VERIFIER_TOKEN', secretRef: 'verifier-token' }
            { name: 'MACHINE_CLIENT_KEY', secretRef: 'machine-client-key' }
          ]
        }
      ]
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Smoke job (016, research R9): one goal through the agent's public API, as the pipeline's machine caller
// (src/smoke-main.ts). It gets its own token from the sign-in tenant, so the pipeline holds none, and it exits 0
// only when the run completed, both purchases were paid and confirmed, nothing escalated and it took 120 s or
// less. It probes the candidate address and uses it while it answers (an L1 deployment in progress), the agent's
// own otherwise. No role token: it calls neither L2 nor L3.
// ---------------------------------------------------------------------------------------------
resource smokeJob 'Microsoft.App/jobs@2025-01-01' = {
  name: names.jobs.smoke
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
        { name: 'machine-client-key', keyVaultUrl: '${vaultL1}secrets/machine-client-key', identity: idL1.id }
      ]
      identitySettings: [{ identity: idL1.id, lifecycle: 'None' }]
    }
    template: {
      containers: [
        {
          name: 'smoke'
          image: image
          command: ['node', 'dist/src/smoke-main.js']
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            { name: 'NETWORK', value: 'base-sepolia' }
            { name: 'AUTH_ISSUER', value: identity.issuer }
            { name: 'AUTH_AUDIENCE', value: identity.audience }
            { name: 'MACHINE_CLIENT_ID', value: agent.machineClientId }
            { name: 'MACHINE_CLIENT_KEY_ID', value: agent.machineKeyId }
            { name: 'MACHINE_CLIENT_KEY', secretRef: 'machine-client-key' }
            { name: 'AGENT_URL', value: agentUrl }
            { name: 'AGENT_CANDIDATE_URL', value: agentCandidateUrl }
          ]
        }
      ]
    }
  }
}

output agentFqdn string = agentApp.properties.configuration.ingress.fqdn
