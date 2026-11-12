// dev parameters for pre-deploy.bicep: every value it uses, its target and every name included. An administrator
// deploys it by hand before the first pipeline run (quickstart §4 step 0). infra/github-setup.sh and
// infra/cleanup.sh compile this file with Bicep (az bicep build-params) to read their values.
using 'pre-deploy.bicep'

param tenantId = '88f8af2e-ee60-42cd-ba67-6806d30aac9d'
param subscriptionId = 'e1d827eb-1354-4f01-8651-60c67c08fc3b'
param location = 'eastus2'

// {type}-{app}-{location}-{environment}, as in main.dev.bicepparam (T-IAC-01 rules 15 and 17).
var environment = 'dev'
param names = {
  resourceGroup: 'rg-x402-${location}-${environment}'
  apiApp: 'app-l1-${location}-${environment}'
  deployApp: 'app-deploy-${location}-${environment}'
  portalApp: 'app-portal-${location}-${environment}'
  operators: 'grp-op-${location}-${environment}'
  stateStorage: 'sttfstate${location}${environment}'
}

// GitHub: the repository and environment whose deploy job signs in as the deploy app (OIDC), and the IDs in GitHub's
// immutable subject (gh api repos/fr-com-dev/agentic-payments --jq '.owner.id, .id'). deploy.yml's job runs in the
// GitHub environment named like the deploy environment.
param githubRepository = 'fr-com-dev/agentic-payments'
param githubOwnerId = '274163174'
param githubRepositoryId = '1422461966'
param githubEnvironment = environment
// provision-auth0.yml's job runs in its own GitHub environment, which holds the Auth0 Management API credential.
param githubAuth0Environment = 'auth0-${environment}'

// 013: the portal's public origin, https://<names.apps.portal>.<the x402 environment's default domain> (main.bicep's
// portalFqdn output), without a trailing slash: its /redirect.html becomes the web app's second redirect URI. Empty
// until the portal is deployed; then set it and deploy this file again (specs/013 quickstart §6 step 4).
param portalOrigin = ''

// People: who may run the agent (Agent.Run), and who may start the operator job (the operators' group).
param agentUsers = ['me@fabriciorojas.com']
param operators = ['me@fabriciorojas.com']
// 014: who may use the portal's administration area (Portal.Admin). Nobody until the area is turned on.
param portalAdmins = []
