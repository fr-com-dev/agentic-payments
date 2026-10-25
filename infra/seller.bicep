// The demo seller's unit (specs/011 contracts/cloud-topology.md): ca-seller and ca-seller-alias from the
// x402-seller image, in cae-x402-cp. The seller is the counterparty, test infrastructure rather than a
// layer, so .github/workflows/deploy-infra.yml deploys it after the platform. T-IAC-01
// (test/infra.test.ts) compiles it with the other templates.
targetScope = 'resourceGroup'

param location string = 'eastus2'
@description('Same suffix as main.bicep, so the platform resources are found by name.')
param suffix string = take(uniqueString(resourceGroup().id), 6)
@description('Image tag: the Git commit SHA (FR-023), or last-good on a rollback.')
param imageTag string
@description('The seller payTo address (public).')
param sellerPayTo string

module platform 'modules/platform.bicep' = {
  name: 'platform-seller'
  params: { suffix: suffix, identityNames: ['id-seller'], vaultKeys: ['seller'] }
}

module sellers 'modules/sellers.bicep' = {
  name: 'sellers'
  params: {
    location: location
    cpEnvId: platform.outputs.cpId
    image: '${platform.outputs.acrServer}/x402-seller:${imageTag}'
    acrServer: platform.outputs.acrServer
    identity: toObject(platform.outputs.identities, i => i.name)['id-seller']
    vaultUri: toObject(platform.outputs.vaults, v => v.key, v => v.uri).seller
    sellerPayTo: sellerPayTo
  }
}

output sellerFqdn string = sellers.outputs.fqdn
output sellerAliasFqdn string = sellers.outputs.aliasFqdn
