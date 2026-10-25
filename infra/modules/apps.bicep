// The agent, L2, L3 and the operator job in cae-x402 (specs/011 contracts/cloud-topology.md "Apps and jobs",
// "Non-secret env", "Secrets"). T-IAC-01 asserts on the compiled form of this file:
// - secrets reach only the container that needs them, as Key Vault references from the unit's own vault;
// - L2 and L3 have internal-only ingress through a loopback proxy sidecar that has no env and no secrets;
// - identity lifecycle is Main only for the agent (Foundry tokens); None everywhere else;
// - L2 runs exactly one replica with the NFS ledger at /app/.local (L2-6);
// - each app and job runs from its own layer's image: the agent and job-regression from L1's, L2 and
//   job-operator from L2's, L3 from L3's.
param location string
param mainEnvId string
param mainDomain string
param cpDomain string
param ledgerStorageName string
@description('Unit key (l1, l2, l3) → that layer\'s image (research R14).')
param images object
param proxyImage string
param acrServer string
@description('Identity name → { id, clientId }.')
param identities object
@description('Vault key (l1, l2, l3, op) → vault URI (ends with /).')
param vaultUri object
param authTenantId string
param authAudience string
param foundryBaseUrl string
param sellerPayTo string
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
          image: images.l1
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
// L2 control: internal-only ingress through the proxy sidecar; exactly one replica; NFS ledger; lifecycle None.
// ---------------------------------------------------------------------------------------------
resource control 'Microsoft.App/containerApps@2025-01-01' = {
  name: 'ca-l2-control'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identities['id-l2'].id}': {} } }
  properties: {
    environmentId: mainEnvId
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: { external: false, targetPort: 8080, transport: 'http', allowInsecure: true }
      registries: [{ server: acrServer, identity: identities['id-l2'].id }]
      secrets: [
        { name: 'payer-private-key', keyVaultUrl: '${vaultUri.l2}secrets/payer-private-key', identity: identities['id-l2'].id }
        { name: 'control-token', keyVaultUrl: '${vaultUri.l2}secrets/control-token', identity: identities['id-l2'].id }
        { name: 'settlement-token', keyVaultUrl: '${vaultUri.l2}secrets/settlement-token', identity: identities['id-l2'].id }
        { name: 'operator-token', keyVaultUrl: '${vaultUri.l2}secrets/operator-token', identity: identities['id-l2'].id }
        // The proxy config is not a secret; Container Apps mounts files only through secret volumes.
        #disable-next-line use-secure-value-for-secure-inputs
        { name: 'nginx-conf', value: loadTextContent('../proxy/nginx-l2.conf') }
      ]
      identitySettings: [{ identity: identities['id-l2'].id, lifecycle: 'None' }]
    }
    template: {
      containers: [
        {
          name: 'l2'
          image: images.l2
          command: ['node', 'dist/src/layer2-control/service.js']
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'NETWORK', value: 'base-sepolia' }
            { name: 'ALLOWED_PAYEES', value: sellerPayTo }
            { name: 'ALLOWED_HOSTS', value: 'ca-seller.${cpDomain}' }
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
// L3 verifier: internal-only ingress through the proxy sidecar; one replica; lifecycle None.
// ---------------------------------------------------------------------------------------------
resource verifier 'Microsoft.App/containerApps@2025-01-01' = {
  name: 'ca-l3-verifier'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identities['id-l3'].id}': {} } }
  properties: {
    environmentId: mainEnvId
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: { external: false, targetPort: 8080, transport: 'http', allowInsecure: true }
      registries: [{ server: acrServer, identity: identities['id-l3'].id }]
      secrets: [
        { name: 'verifier-token', keyVaultUrl: '${vaultUri.l3}secrets/verifier-token', identity: identities['id-l3'].id }
        { name: 'settlement-token', keyVaultUrl: '${vaultUri.l3}secrets/settlement-token', identity: identities['id-l3'].id }
        // The proxy config is not a secret; Container Apps mounts files only through secret volumes.
        #disable-next-line use-secure-value-for-secure-inputs
        { name: 'nginx-conf', value: loadTextContent('../proxy/nginx-l3.conf') }
      ]
      identitySettings: [{ identity: identities['id-l3'].id, lifecycle: 'None' }]
    }
    template: {
      containers: [
        {
          name: 'l3'
          image: images.l3
          command: ['node', 'dist/src/layer3-settlement/service.js']
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'NETWORK', value: 'base-sepolia' }
            { name: 'CONTROL_URL', value: controlUrl }
            { name: 'VERIFIER_TOKEN', secretRef: 'verifier-token' }
            { name: 'SETTLEMENT_TOKEN', secretRef: 'settlement-token' }
          ]
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
      volumes: [{ name: 'nginx-conf', storageType: 'Secret', secrets: [{ secretRef: 'nginx-conf', path: 'default.conf' }] }]
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Operator job: the private operator path (FR-021). Start rights on it equal holding OPERATOR_TOKEN.
// Each start overrides command and args (approve, reject, escalations, ledger-verify).
// ---------------------------------------------------------------------------------------------
resource operatorJob 'Microsoft.App/jobs@2025-01-01' = {
  name: 'job-operator'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identities['id-op'].id}': {} } }
  properties: {
    environmentId: mainEnvId
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 3600
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: [{ server: acrServer, identity: identities['id-op'].id }]
      secrets: [{ name: 'operator-token', keyVaultUrl: '${vaultUri.op}secrets/operator-token', identity: identities['id-op'].id }]
      identitySettings: [{ identity: identities['id-op'].id, lifecycle: 'None' }]
    }
    template: {
      containers: [
        {
          name: 'operator'
          image: images.l2
          command: ['node', 'dist/scripts/escalations.js']
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
          image: images.l1
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
output controlUrl string = controlUrl
output settlementUrl string = settlementUrl
output sellerUrl string = sellerUrl
