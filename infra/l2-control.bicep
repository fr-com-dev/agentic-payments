// L2's unit (specs/011 contracts/cloud-topology.md): the control service and job-operator from the
// x402-l2-control image, on the platform that main.bicep deploys. Deployed by
// .github/workflows/deploy-l2.yml with that commit's image; T-IAC-01 (test/infra.test.ts) compiles it with
// the other templates.
targetScope = 'resourceGroup'

param location string = 'eastus2'
@description('Same suffix as main.bicep, so the platform resources are found by name.')
param suffix string = take(uniqueString(resourceGroup().id), 6)
@description('Image tag: the Git commit SHA (FR-023), or last-good on a rollback.')
param imageTag string
@description('The seller payTo address (public). L2 allows only this payee.')
param sellerPayTo string

module platform 'modules/platform.bicep' = {
  name: 'platform-l2'
  params: { suffix: suffix, identityNames: ['id-l2', 'id-op'], vaultKeys: ['l2', 'op'] }
}

module apps 'modules/l2-apps.bicep' = {
  name: 'l2-apps'
  params: {
    location: location
    mainEnvId: platform.outputs.mainId
    mainDomain: platform.outputs.mainDomain
    cpDomain: platform.outputs.cpDomain
    ledgerStorageName: platform.outputs.ledgerStorageName
    image: '${platform.outputs.acrServer}/x402-l2-control:${imageTag}'
    proxyImage: platform.outputs.proxyImage
    acrServer: platform.outputs.acrServer
    identities: toObject(platform.outputs.identities, i => i.name)
    vaultUri: toObject(platform.outputs.vaults, v => v.key, v => v.uri)
    sellerPayTo: sellerPayTo
  }
}
