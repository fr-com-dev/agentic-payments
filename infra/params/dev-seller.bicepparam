// dev environment parameters for seller.bicep. No secret values: vaults are seeded by hand (quickstart §4 step 2).
using '../seller.bicep'

param imageTag = readEnvironmentVariable('IMAGE_TAG', 'dev')
param sellerPayTo = readEnvironmentVariable('SELLER_PAY_TO', '')
