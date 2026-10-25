// dev environment parameters for l1-agent.bicep. No secret values: vaults are seeded by hand (quickstart §4 step 2).
using '../l1-agent.bicep'

param imageTag = readEnvironmentVariable('IMAGE_TAG', 'dev')
param authAudience = readEnvironmentVariable('AUTH_AUDIENCE', '')
param agentStableRevision = readEnvironmentVariable('AGENT_STABLE_REVISION', '')
