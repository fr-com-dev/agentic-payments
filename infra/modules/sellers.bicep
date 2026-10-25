// The demo seller, an external party, in its own environment cae-x402-cp (FR-022). It can't reach the
// internal apps of cae-x402, and it holds only its own CDP credential (A8), from its own vault. Deployed by
// seller.bicep (deploy-infra.yml).
param location string
param cpEnvId string
param image string
param acrServer string
@description('id-seller → { id, clientId }.')
param identity object
param vaultUri string
param sellerPayTo string

// ca-seller and ca-seller-alias: the same seller on two FQDNs. L2 allows only the first, so the regression's
// step 6 through the alias is DENIED host_not_allowed (L1-4, research R17).
var sellerNames = ['ca-seller', 'ca-seller-alias']

resource seller 'Microsoft.App/containerApps@2025-01-01' = [for n in sellerNames: {
  name: n
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  properties: {
    environmentId: cpEnvId
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: { external: true, targetPort: 4021, transport: 'auto', allowInsecure: false }
      registries: [{ server: acrServer, identity: identity.id }]
      secrets: [
        { name: 'cdp-api-key-id', keyVaultUrl: '${vaultUri}secrets/cdp-api-key-id', identity: identity.id }
        { name: 'cdp-api-key-secret', keyVaultUrl: '${vaultUri}secrets/cdp-api-key-secret', identity: identity.id }
      ]
      identitySettings: [{ identity: identity.id, lifecycle: 'None' }]
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
