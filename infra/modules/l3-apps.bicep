// L3's app in names.environments.x402 (specs/011 contracts/cloud-topology.md "Apps and jobs", "Non-secret env",
// "Secrets"): the settlement verifier (names.apps.l3) from L3's image. Deployed by main.bicep.
// The platform's resources it uses are looked up by their names (the names parameter), never passed in
// as another module's outputs: what-if skips a module whose parameters hold runtime values, so this keeps the module
// in the preview of a first deployment. main.bicep deploys it after the platform (dependsOn).
// T-IAC-01 asserts on the compiled form of this file:
// - secrets come only from the l3 vault, as Key Vault references;
// - internal-only ingress through a loopback proxy sidecar that has no env and no secrets;
// - identity lifecycle None.
param location string
@description('Every resource name (main.<environment>.bicepparam).')
param names object
@description('x402-l3-verifier:<imageTag> in the registry (research R14).')
param image string
param proxyImage string
@description('The registry\'s login server.')
param acrServer string

resource idL3 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: names.identities.l3 }
resource mainEnv 'Microsoft.App/managedEnvironments@2025-01-01' existing = { name: names.environments.x402 }

var vaultL3 = 'https://${names.vaults.l3}${az.environment().suffixes.keyvaultDns}/'
var mainDomain = mainEnv.properties.defaultDomain
var controlUrl = 'http://${names.apps.l2}.internal.${mainDomain}'

// ---------------------------------------------------------------------------------------------
// L3 verifier: internal-only ingress through the proxy sidecar; one replica; lifecycle None.
// ---------------------------------------------------------------------------------------------
resource verifier 'Microsoft.App/containerApps@2025-01-01' = {
  name: names.apps.l3
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${idL3.id}': {} } }
  properties: {
    environmentId: mainEnv.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: { external: false, targetPort: 8080, transport: 'http', allowInsecure: true }
      registries: [{ server: acrServer, identity: idL3.id }]
      secrets: [
        { name: 'verifier-token', keyVaultUrl: '${vaultL3}secrets/verifier-token', identity: idL3.id }
        { name: 'settlement-token', keyVaultUrl: '${vaultL3}secrets/settlement-token', identity: idL3.id }
        // The proxy config is not a secret; Container Apps mounts files only through secret volumes.
        #disable-next-line use-secure-value-for-secure-inputs
        { name: 'nginx-conf', value: loadTextContent('../proxy/nginx-l3.conf') }
      ]
      identitySettings: [{ identity: idL3.id, lifecycle: 'None' }]
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
