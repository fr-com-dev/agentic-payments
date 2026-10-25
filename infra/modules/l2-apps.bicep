// L2's apps in cae-x402 (specs/011 contracts/cloud-topology.md "Apps and jobs", "Non-secret env",
// "Secrets"): the control service and job-operator, both from L2's image. Deployed by l2-control.bicep
// (deploy-l2.yml). T-IAC-01 asserts on the compiled form of this file:
// - PAYER_PRIVATE_KEY reaches only the l2 container, as a Key Vault reference from the l2 vault;
// - internal-only ingress through a loopback proxy sidecar that has no env and no secrets;
// - exactly one replica with the NFS ledger at /app/.local (L2-6); identity lifecycle None.
param location string
param mainEnvId string
param mainDomain string
param cpDomain string
param ledgerStorageName string
@description('x402-l2-control:<imageTag> in the registry (research R14).')
param image string
param proxyImage string
param acrServer string
@description('id-l2 and id-op → { id, clientId }.')
param identities object
@description('l2 and op → their vault URIs (end with /).')
param vaultUri object
param sellerPayTo string

var controlUrl = 'http://ca-l2-control.internal.${mainDomain}'

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
          image: image
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
          image: image
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
