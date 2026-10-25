// L3's app in cae-x402 (specs/011 contracts/cloud-topology.md "Apps and jobs", "Non-secret env",
// "Secrets"): the settlement verifier from L3's image. Deployed by l3-verifier.bicep (deploy-l3.yml).
// T-IAC-01 asserts on the compiled form of this file:
// - secrets come only from the l3 vault, as Key Vault references;
// - internal-only ingress through a loopback proxy sidecar that has no env and no secrets;
// - identity lifecycle None.
param location string
param mainEnvId string
param mainDomain string
@description('x402-l3-verifier:<imageTag> in the registry (research R14).')
param image string
param proxyImage string
param acrServer string
@description('id-l3 → { id, clientId }.')
param identities object
@description('l3 → the l3 vault URI (ends with /).')
param vaultUri object

var controlUrl = 'http://ca-l2-control.internal.${mainDomain}'

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
          image: image
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
