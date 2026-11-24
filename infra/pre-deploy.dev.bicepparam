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
  deployApp: 'app-deploy-${location}-${environment}'
  operators: 'grp-op-${location}-${environment}'
  // SPEC 1.25: the units' identities, made here so the deploy app's condition can name them: the same names as
  // main.dev.bicepparam's identities (T-IAC-01 rule 16), which main.bicep's apps look up.
  identities: {
    l1: 'id-l1-${location}-${environment}'
    l2: 'id-l2-${location}-${environment}'
    l3: 'id-l3-${location}-${environment}'
    op: 'id-op-${location}-${environment}'
    portal: 'id-portal-${location}-${environment}'
    seller: 'id-seller-${location}-${environment}'
    // 1.23: the one identity that may write the ledger's head (main's ledger-head module gives it its only role).
    l2head: 'id-l2head-${location}-${environment}'
  }
  // SPEC 1.25: the policy assignment that refuses a federated credential on any identity of the resource group.
  policy: 'pol-x402-${location}-${environment}'
}

// GitHub: the repository and environment whose deploy job signs in as the deploy app (OIDC), and the IDs in GitHub's
// immutable subject (gh api repos/fr-com-dev/agentic-payments --jq '.owner.id, .id'). deploy.yml's job runs in the
// GitHub environment named like the deploy environment.
param githubRepository = 'fr-com-dev/agentic-payments'
param githubOwnerId = '274163174'
param githubRepositoryId = '1422461966'
param githubEnvironment = environment
// SPEC 1.26: no Auth0 job runs in GitHub. The tenant's Terraform runs on the operator's host (scripts/auth0-tenant.sh),
// so the GitHub environment auth0-dev and the deploy app's credential for it are gone.

// Nobody is given access to the agent here (016): its callers, people and machines, are the sign-in tenant's
// (auth0/). The API app registration app-l1-eastus2-dev that 011 made for them is no longer in pre-deploy.bicep,
// and Bicep never deletes what a template stops naming: delete it by hand once the agent with 016 is deployed
// (az ad app delete --id 739f581a-8865-413f-9480-21dc4e012676, its client ID, the authAudience main.dev.bicepparam
// had; its service principal, the Agent.Run role and its assignments go with it, and so does what is left of 013's
// Portal.Access scope). infra/cleanup.sh no longer knows it, as it no longer knows the portal web app registration
// app-portal-eastus2-dev.

// People: who may start the operator job (the operators' group).
param operators = ['me@fabriciorojas.com']
