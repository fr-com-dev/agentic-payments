// dev environment parameters for l2-control.bicep. No secret values: vaults are seeded by hand (quickstart §4 step 2).
using '../l2-control.bicep'

param imageTag = readEnvironmentVariable('IMAGE_TAG', 'dev')
param sellerPayTo = readEnvironmentVariable('SELLER_PAY_TO', '')
