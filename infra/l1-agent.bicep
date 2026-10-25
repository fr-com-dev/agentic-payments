// L1's unit (specs/011 contracts/cloud-topology.md): the hosted agent and job-regression from the
// x402-l1-agent image, on the platform that main.bicep deploys. Deployed by .github/workflows/deploy-l1.yml
// with that commit's image; T-IAC-01 (test/infra.test.ts) compiles it with the other templates.
targetScope = 'resourceGroup'

param location string = 'eastus2'
@description('Same suffix as main.bicep, so the platform resources are found by name.')
param suffix string = take(uniqueString(resourceGroup().id), 6)
@description('Image tag: the Git commit SHA (FR-023), or last-good on a rollback.')
param imageTag string
param authTenantId string = tenant().tenantId
@description('The API app\'s client ID, printed by infra/entra-app.sh as AUTH_AUDIENCE. Entra v2.0 tokens carry it as aud, never the api:// URI, so there is no default.')
@minLength(36)
@maxLength(36)
param authAudience string
@description('The agent revision that keeps serving during checks (empty on the first deployment).')
param agentStableRevision string = ''

module platform 'modules/platform.bicep' = {
  name: 'platform-l1'
  params: { suffix: suffix, identityNames: ['id-l1'], vaultKeys: ['l1'] }
}

module apps 'modules/l1-apps.bicep' = {
  name: 'l1-apps'
  params: {
    location: location
    mainEnvId: platform.outputs.mainId
    mainDomain: platform.outputs.mainDomain
    cpDomain: platform.outputs.cpDomain
    image: '${platform.outputs.acrServer}/x402-l1-agent:${imageTag}'
    acrServer: platform.outputs.acrServer
    identities: toObject(platform.outputs.identities, i => i.name)
    vaultUri: toObject(platform.outputs.vaults, v => v.key, v => v.uri)
    authTenantId: authTenantId
    authAudience: authAudience
    foundryBaseUrl: platform.outputs.anthropicBaseUrl
    agentStableRevision: agentStableRevision
  }
}

output agentFqdn string = apps.outputs.agentFqdn
