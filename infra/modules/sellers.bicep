// The demo seller, an external party, in its own environment names.environments.seller (FR-022).
// It can't reach the internal apps of names.environments.x402, and it holds only its own CDP
// credential (A8), from its own vault. Deployed by main.bicep.
// The platform's resources it uses are looked up by their names (the names parameter), never passed in
// as another module's outputs: what-if skips a module whose parameters hold runtime values, so this keeps the module
// in the preview of a first deployment. main.bicep deploys it after the platform (dependsOn).
param location string
@description('Every resource name (main.<environment>.bicepparam).')
param names object
@description('x402-seller:<imageTag> in the registry.')
param image string
@description('The registry\'s login server.')
param acrServer string
param sellerPayTo string

resource idSeller 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: names.identities.seller }
resource sellerEnv 'Microsoft.App/managedEnvironments@2025-01-01' existing = { name: names.environments.seller }

var vaultSeller = 'https://${names.vaults.seller}${az.environment().suffixes.keyvaultDns}/'

// names.apps.seller and names.apps.sellerAlias: the same seller on two FQDNs. L2 allows only the first, so the
// regression's step 6 through the alias is DENIED host_not_allowed (L1-4, research R17).
var sellerApps = ['seller', 'sellerAlias']

resource seller 'Microsoft.App/containerApps@2025-01-01' = [for a in sellerApps: {
  name: names.apps[a]
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${idSeller.id}': {} } }
  properties: {
    environmentId: sellerEnv.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: { external: true, targetPort: 4021, transport: 'auto', allowInsecure: false }
      registries: [{ server: acrServer, identity: idSeller.id }]
      secrets: [
        { name: 'cdp-api-key-id', keyVaultUrl: '${vaultSeller}secrets/cdp-api-key-id', identity: idSeller.id }
        { name: 'cdp-api-key-secret', keyVaultUrl: '${vaultSeller}secrets/cdp-api-key-secret', identity: idSeller.id }
      ]
      identitySettings: [{ identity: idSeller.id, lifecycle: 'None' }]
    }
    template: {
      containers: [
        {
          name: 'seller'
          image: image
          command: ['node', 'dist/src/counterparty/seller.js']
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'NETWORK', value: 'base-sepolia' }
            { name: 'SELLER_PAY_TO', value: sellerPayTo }
            { name: 'FACILITATOR', value: 'cdp' }
            { name: 'SELLER_PORT', value: '4021' }
            { name: 'CDP_API_KEY_ID', secretRef: 'cdp-api-key-id' }
            { name: 'CDP_API_KEY_SECRET', secretRef: 'cdp-api-key-secret' }
          ]
          probes: [{ type: 'Readiness', httpGet: { path: '/api/catalog', port: 4021 } }]
        }
      ]
      scale: { minReplicas: 0, maxReplicas: 1 }
    }
  }
}]

output fqdn string = seller[0].properties.configuration.ingress.fqdn
output aliasFqdn string = seller[1].properties.configuration.ingress.fqdn
