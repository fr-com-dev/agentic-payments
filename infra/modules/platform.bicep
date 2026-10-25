// The platform that main.bicep deploys (deploy-infra.yml), looked up by name for one unit's template
// (l1-agent.bicep, l2-control.bicep, l3-verifier.bicep, seller.bicep). Each unit asks for its own
// identities and vaults only; T-IAC-01 rule 13 asserts on what each unit passes here.
param suffix string
@description('The unit\'s own identities, e.g. [\'id-l2\', \'id-op\'].')
param identityNames array
@description('The unit\'s own vault keys, e.g. [\'l2\', \'op\'] for kv-x402-<key>-<suffix>.')
param vaultKeys array

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = { name: 'crx402${suffix}' }
resource main 'Microsoft.App/managedEnvironments@2025-01-01' existing = { name: 'cae-x402' }
resource cp 'Microsoft.App/managedEnvironments@2025-01-01' existing = { name: 'cae-x402-cp' }
resource ais 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = { name: 'ais-x402-${suffix}' }
resource ids 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = [for n in identityNames: { name: n }]
resource kvs 'Microsoft.KeyVault/vaults@2023-07-01' existing = [for k in vaultKeys: { name: 'kv-x402-${k}-${suffix}' }]

output acrServer string = acr.properties.loginServer
output mainId string = main.id
output mainDomain string = main.properties.defaultDomain
output cpId string = cp.id
output cpDomain string = cp.properties.defaultDomain
@description('The NFS ledger storage that environments.bicep adds to cae-x402.')
output ledgerStorageName string = 'ledger'
output anthropicBaseUrl string = 'https://${ais.properties.customSubDomainName}.services.ai.azure.com/anthropic/v1'
output identities array = [for (n, i) in identityNames: { name: n, id: ids[i].id, clientId: ids[i].properties.clientId }]
output vaults array = [for (k, i) in vaultKeys: { key: k, uri: kvs[i].properties.vaultUri }]
@description('nginx-unprivileged 1.29-alpine, pinned by index digest on 2026-10-22: the L2 and L3 proxy sidecars.')
output proxyImage string = 'docker.io/nginxinc/nginx-unprivileged@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6'
