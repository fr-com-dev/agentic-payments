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

// 013: people sign in with Auth0 now (auth0/, specs/013 research R19), so what 013 first added to Entra for the
// portal is taken out. Entra refuses to remove a scope that is still enabled, so it takes two deployments of this
// file:
// 1. with true: the Portal.Access scope stays in the API app, disabled, and the portal web app's pre-authorization
//    and the auth_time claim go;
// 2. with false: the scope is left out, and Entra removes it.
// A new environment, which never had the scope, uses false from the start.
// Dev has the scope enabled and pre-authorized (both deployments of 2026-11-10), so it is true here until step 1 has
// run; then set it to false and deploy again.
// Bicep never deletes what a template no longer names: after step 1, delete the portal web app registration
// app-portal-eastus2-dev by hand (az ad app delete --id <its client ID>). infra/cleanup.sh no longer knows it.
param retirePortalScope = true

// People: who may run the agent (Agent.Run), and who may start the operator job (the operators' group).
param agentUsers = ['me@fabriciorojas.com']
param operators = ['me@fabriciorojas.com']
