// L3's unit (specs/011 contracts/cloud-topology.md): the settlement verifier from the x402-l3-verifier
// image, on the platform that main.bicep deploys. Deployed by .github/workflows/deploy-l3.yml with that
// commit's image; T-IAC-01 (test/infra.test.ts) compiles it with the other templates.
targetScope = 'resourceGroup'

param location string = 'eastus2'
@description('Same suffix as main.bicep, so the platform resources are found by name.')
param suffix string = take(uniqueString(resourceGroup().id), 6)
@description('Image tag: the Git commit SHA (FR-023), or last-good on a rollback.')
param imageTag string

module platform 'modules/platform.bicep' = {
  name: 'platform-l3'
  params: { suffix: suffix, identityNames: ['id-l3'], vaultKeys: ['l3'] }
}

module apps 'modules/l3-apps.bicep' = {
  name: 'l3-apps'
  params: {
    location: location
    mainEnvId: platform.outputs.mainId
    mainDomain: platform.outputs.mainDomain
    image: '${platform.outputs.acrServer}/x402-l3-verifier:${imageTag}'
    proxyImage: platform.outputs.proxyImage
    acrServer: platform.outputs.acrServer
    identities: toObject(platform.outputs.identities, i => i.name)
    vaultUri: toObject(platform.outputs.vaults, v => v.key, v => v.uri)
  }
}
