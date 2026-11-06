// dev parameters for main.bicep: every value it uses, its target and every resource name included. deploy.yml (the
// pipelines' shared workflow) compiles this file with the Bicep CLI to read its sign-in, target and names, and sets
// the five values at the end on each run. No secret values: the vaults are seeded by hand (quickstart §4 step 3).
using 'main.bicep'

param tenantId = '88f8af2e-ee60-42cd-ba67-6806d30aac9d'
param subscriptionId = 'e1d827eb-1354-4f01-8651-60c67c08fc3b'
param location = 'eastus2'

// Every resource name is {type}-{app}-{location}-{environment}; the registry's and storage's drop the hyphens
// (letters and digits only). The templates name nothing themselves, and T-IAC-01 rule 15 checks each name here.
var environment = 'dev'
param names = {
  resourceGroup: 'rg-x402-${location}-${environment}'
  network: 'vnet-x402-${location}-${environment}'
  subnets: {
    x402: 'snet-x402-${location}-${environment}'
    seller: 'snet-seller-${location}-${environment}'
  }
  logs: 'log-x402-${location}-${environment}'
  registry: 'crx402${location}${environment}'
  storage: 'stx402${location}${environment}'
  foundry: 'ais-x402-${location}-${environment}'
  environments: {
    x402: 'cae-x402-${location}-${environment}'
    seller: 'cae-seller-${location}-${environment}'
  }
  identities: {
    l1: 'id-l1-${location}-${environment}'
    l2: 'id-l2-${location}-${environment}'
    l3: 'id-l3-${location}-${environment}'
    op: 'id-op-${location}-${environment}'
    seller: 'id-seller-${location}-${environment}'
  }
  vaults: {
    l1: 'kv-l1-${location}-${environment}'
    l2: 'kv-l2-${location}-${environment}'
    l3: 'kv-l3-${location}-${environment}'
    op: 'kv-op-${location}-${environment}'
    seller: 'kv-seller-${location}-${environment}'
  }
  apps: {
    l1: 'ca-l1-${location}-${environment}'
    l2: 'ca-l2-${location}-${environment}'
    l3: 'ca-l3-${location}-${environment}'
    seller: 'ca-seller-${location}-${environment}'
    sellerAlias: 'ca-seller-alias-${location}-${environment}'
  }
  jobs: {
    l1: 'caj-l1-${location}-${environment}'
    l2: 'caj-l2-${location}-${environment}'
  }
}

// pre-deploy.bicep's outputs (az deployment sub show -n pre-deploy-dev --query properties.outputs.mainParameters.value).
param deployClientId = '62ea98ec-a6d9-48b4-96d0-591f872c7b17'
param authAudience = '739f581a-8865-413f-9480-21dc4e012676'
param operatorsGroupId = '6d09c1a1-ae43-4b55-b6d3-277b546adf3c'

// Public addresses on Base Sepolia: the seller's payTo (L2's only payee), and the payer whose balance deploy.yml checks.
param sellerPayTo = '0x95Aca02416F949489C1128223B35fBBE8c04f057'
param payerAddress = '0x0048A66969cE8886A5e9bC00059Cb8c5D3989516'

// Declared to Anthropic with the Claude deployment, which accepts its Azure Marketplace terms (owner's consent,
// 2026-11-01).
param claudeOrganizationName = 'Fabricio Rojas'
param claudeCountryCode = 'US'
param claudeIndustry = 'technology'

// Set by deploy.yml on each run: what the run deploys (the platform, or the pipeline's unit), the commit, an
// operator's IP while seeding the vaults, the recovery of a cleaned-up environment's vaults, and the agent revision
// that keeps its traffic until the new one passes the checks.
param unit = readEnvironmentVariable('UNIT', 'platform')
param imageTag = readEnvironmentVariable('IMAGE_TAG', 'dev')
param seedIp = readEnvironmentVariable('SEED_IP', '')
param recoverVaults = bool(readEnvironmentVariable('RECOVER_VAULTS', 'false'))
param agentStableRevision = readEnvironmentVariable('AGENT_STABLE_REVISION', '')
