// dev environment parameters. No secret values: vaults are seeded by hand (quickstart §4 step 2).
using '../main.bicep'

param imageTag = readEnvironmentVariable('IMAGE_TAG', 'dev')
param sellerPayTo = readEnvironmentVariable('SELLER_PAY_TO', '')
param authAudience = readEnvironmentVariable('AUTH_AUDIENCE', '')
param agentStableRevision = readEnvironmentVariable('AGENT_STABLE_REVISION', '')
