// Everything an environment needs before its pipelines (.github/workflows/deploy-*.yml) can run (SPEC.md §3.1;
// specs/011 contracts/cloud-topology.md, access-and-sessions.md), as one subscription deployment that an
// administrator runs by hand (quickstart §4 step 0):
// - the resource group main.bicep deploys into;
// - the deploy app registration app-deploy-<location>-<environment>, its service principal and one federated
//   credential, for the repository's deploy environment: GitHub Actions sign in with OIDC, and no secret exists;
// - the operators' group grp-op-<location>-<environment> (main.bicep lets it start the operator job);
// - (SPEC 1.25) the units' user-assigned identities, id-<unit>-<location>-<environment>, which main.bicep's apps and
//   jobs look up by name: made here so their principal IDs are known to the deploy app's condition;
// - the deploy app's roles on the resource group (modules/deploy-access.bicep): it may give main.bicep's roles to
//   those identities and the operators' group, and to no other principal;
// - (SPEC 1.25) a policy that refuses any federated credential on an identity of the resource group
//   (modules/no-federated-credentials.bicep), so nobody outside Azure can sign in as one of them.
// SPEC 1.26: nothing here is the Auth0 tenant's. Its Terraform (auth0/) runs on the operator's host, with its state
// a local file there (scripts/auth0-tenant.sh), so the state's storage account (sttfstate<location><environment>,
// modules/state-storage.bicep) and the deploy app's second federated credential, for the GitHub environment
// auth0-<environment>, are gone from this file. Bicep never deletes what a template stops naming: in an environment
// deployed before 1.26, delete both by hand (az storage account delete, az ad app federated-credential delete).
// The Entra objects come from the Microsoft Graph Bicep extension (bicepconfig.json), which what-if can't preview.
// Every value comes from pre-deploy.<environment>.bicepparam, the target and every name included: run anywhere other
// than the file's tenant and subscription, the deployment fails validation before it creates anything. T-IAC-01
// rules 15–17 and 20 assert on the compiled form of this file and on its parameter file.
// Nobody's access to a service is described here. Every caller of the agent, a person or a machine, gets its token
// from the sign-in tenant, defined in auth0/ (Terraform; specs/013 research R19, specs/016 research R12), so the
// directory holds one app registration of ours, the deploy app. What 011 and 013 made here for the agent's callers
// is gone from this file: the API app registration app-l1-<location>-<environment> with its service principal, the
// Agent.Run role and its assignments, the user_impersonation scope and the Azure CLI's pre-authorization, the
// idtyp claim, and 013's Portal.Access scope, whose two-step retirement ends with the registration.
// Bicep never deletes what a template no longer names. In an environment deployed before 016, delete that
// registration by hand once the agent with 016 is deployed and refuses the directory's tokens
// (az ad app delete --id <its client ID>: its service principal, role and assignments go with it), as the old
// portal registration app-portal-<location>-<environment> was. infra/cleanup.sh no longer knows either.
targetScope = 'subscription'

extension microsoftGraphV1

@description('The Entra tenant the app registrations live in.')
param tenantId string
@description('The subscription the resource group goes in.')
param subscriptionId string
param location string
@description('The names, {type}-{app}-{location}-{environment}: resourceGroup (the one main.bicep deploys into), deployApp, operators, identities (the units\', the same as main\'s) and policy (the assignment that refuses federated credentials).')
param names object
@description('owner/name of the GitHub repository whose deploy job signs in as the deploy app.')
param githubRepository string
@description('The repository owner\'s numeric ID: GitHub\'s immutable OIDC subject names the owner and the repository by name and ID.')
param githubOwnerId string
@description('The repository\'s numeric ID (gh api repos/<owner>/<name> --jq .id).')
param githubRepositoryId string
@description('The GitHub environment the deploy job runs in (deploy.yml: environment: <environment>), so named like the environment.')
param githubEnvironment string
@description('People who may start the operator job, by user principal name: the operators\' group members.')
param operators array

// Validation fails, naming both, when this runs anywhere other than the parameter file says.
var target = tenant().tenantId == tenantId && subscription().subscriptionId == subscriptionId
  ? subscriptionId
  : fail('pre-deploy: the parameter file names tenant ${tenantId}, subscription ${subscriptionId}; this deployment runs in tenant ${tenant().tenantId}, subscription ${subscription().subscriptionId}')

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: names.resourceGroup
  location: location
  tags: { subscription: target }
}

// ---- The deploy app: what GitHub Actions sign in as ------------------------------------------------------------
resource deployApp 'Microsoft.Graph/applications@v1.0' = {
  uniqueName: names.deployApp
  displayName: names.deployApp
  signInAudience: 'AzureADMyOrg'
}

// OIDC from the repository's deploy job (job `environment: <githubEnvironment>`): no client secret anywhere. The
// repository uses GitHub's immutable subject, repo:<owner>@<owner ID>/<name>@<repository ID>:…, so a deleted and
// recreated repository of the same name can't sign in as the deploy app; infra/github-setup.sh checks it.
var githubSubject = 'repo:${split(githubRepository, '/')[0]}@${githubOwnerId}/${split(githubRepository, '/')[1]}@${githubRepositoryId}:environment:${githubEnvironment}'

resource githubCredential 'Microsoft.Graph/applications/federatedIdentityCredentials@v1.0' = {
  name: '${deployApp.uniqueName}/github-${githubEnvironment}'
  description: 'GitHub Actions: the deploy job of ${githubRepository} in its ${githubEnvironment} environment'
  audiences: ['api://AzureADTokenExchange']
  issuer: 'https://token.actions.githubusercontent.com'
  subject: githubSubject
}

resource deploySp 'Microsoft.Graph/servicePrincipals@v1.0' = {
  appId: deployApp.appId
}

// ---- Who may start the operator job (main.bicep assigns the role on that job only) -----------------------------
resource operatorUser 'Microsoft.Graph/users@v1.0' existing = [for upn in operators: {
  userPrincipalName: upn
}]

resource operatorsGroup 'Microsoft.Graph/groups@v1.0' = {
  uniqueName: names.operators
  displayName: names.operators
  mailEnabled: false
  mailNickname: names.operators
  securityEnabled: true
  // Append (the default): a group can't be created with replace semantics. Removing someone from `operators`
  // doesn't remove them from the group; remove them in Entra too.
  members: {
    relationships: [for (upn, i) in operators: operatorUser[i].id]
  }
}

// ---- The units' identities (SPEC 1.25) ---------------------------------------------------------------------------
// One per key of names.identities. main.bicep's apps, jobs, vaults, registry and Foundry look them up by name and
// never make one. Made here, by an administrator, so the condition below can name each identity's principal: a
// pipeline run (Contributor and the conditioned Role Based Access Control Administrator) may give main.bicep's roles
// to these principals only, never to one of its own choosing (Phase 3 gap review, finding 2).
module ids 'modules/identities.bicep' = {
  name: 'identities'
  scope: rg
  params: { location: location, names: names, keys: objectKeys(names.identities) }
}

// ---- The deploy app's Azure roles: its resource group only -----------------------------------------------------
module deployAccess 'modules/deploy-access.bicep' = {
  name: 'deploy-access'
  scope: rg
  params: {
    principalId: deploySp.id
    // Every principal main.bicep assigns a role to: the units' identities, and the operators' group (the operator job).
    assigneeIds: concat(map(ids.outputs.ids, i => i.principalId), [operatorsGroup.id])
  }
}

// ---- No federated credential on the resource group's identities (SPEC 1.25) ------------------------------------
// Contributor may write a user-assigned identity's federated credentials: one on id-l2 trusting an issuer of an
// attacker's would let them sign in as L2's identity from anywhere and read the l2 vault. Nothing here needs one.
module noFederatedCredentials 'modules/no-federated-credentials.bicep' = {
  name: 'no-federated-credentials'
  scope: rg
  params: { names: names }
}

output resourceGroup string = rg.name
@description('The IDs main.<environment>.bicepparam needs, as its lines.')
output mainParameters string = join([
  'param deployClientId = \'${deployApp.appId}\''
  'param operatorsGroupId = \'${operatorsGroup.id}\''
], '\n')
