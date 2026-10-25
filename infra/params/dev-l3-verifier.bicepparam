// dev environment parameters for l3-verifier.bicep. No secret values: vaults are seeded by hand (quickstart §4 step 2).
using '../l3-verifier.bicep'

param imageTag = readEnvironmentVariable('IMAGE_TAG', 'dev')
