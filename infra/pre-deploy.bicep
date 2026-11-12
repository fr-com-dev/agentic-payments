// Everything an environment needs before its pipelines (.github/workflows/deploy-*.yml) can run (SPEC.md §3.1;
// specs/011 contracts/cloud-topology.md, access-and-sessions.md), as one subscription deployment that an
// administrator runs by hand (quickstart §4 step 0):
// - the resource group main.bicep deploys into;
// - the API app registration app-l1-<location>-<environment> and its service principal: the identifier URI
//   api://app-l1-…, v2.0 access tokens, the Agent.Run app role (assignment required) and the delegated scope
//   user_impersonation, with the Azure CLI pre-authorized so a person assigned Agent.Run can get a token; and (013)
//   the delegated scope Portal.Access, with the portal web app pre-authorized for it only, and the optional
//   access-token claims auth_time and idtyp;
// - (013) the portal web app registration app-portal-<location>-<environment>: a public single-page client
//   (authorization code with PKCE), with no secret, no role and no permissions of its own;
// - the deploy app registration app-deploy-<location>-<environment>, its service principal and a federated
//   credential for each of the repository's two GitHub environments, the deploy pipelines' and the Auth0 pipeline's:
//   GitHub Actions sign in with OIDC, and no secret exists;
// - Agent.Run for the deploy app (the pipeline's smoke run) and for agentUsers;
// - the operators' group grp-op-<location>-<environment> (main.bicep lets it start the operator job);
// - the deploy app's roles on the resource group (modules/deploy-access.bicep);
// - the storage for the Terraform state of auth0/, which only the deploy app reads and writes
//   (modules/state-storage.bicep; .github/workflows/provision-auth0.yml).
// The Entra objects come from the Microsoft Graph Bicep extension (bicepconfig.json), which what-if can't preview.
// Every value comes from pre-deploy.<environment>.bicepparam, the target and every name included: run anywhere other
// than the file's tenant and subscription, the deployment fails validation before it creates anything. T-IAC-01
// rules 15–17 and 20 assert on the compiled form of this file and on its parameter file.
targetScope = 'subscription'

extension microsoftGraphV1

@description('The Entra tenant the app registrations live in.')
param tenantId string
@description('The subscription the resource group goes in.')
param subscriptionId string
param location string
@description('The names, {type}-{app}-{location}-{environment}: resourceGroup (the one main.bicep deploys into), apiApp, deployApp, portalApp, operators and stateStorage (the Terraform state of auth0/).')
param names object
@description('owner/name of the GitHub repository whose deploy job signs in as the deploy app.')
param githubRepository string
@description('The repository owner\'s numeric ID: GitHub\'s immutable OIDC subject names the owner and the repository by name and ID.')
param githubOwnerId string
@description('The repository\'s numeric ID (gh api repos/<owner>/<name> --jq .id).')
param githubRepositoryId string
@description('The GitHub environment the deploy job runs in (deploy.yml: environment: <environment>), so named like the environment.')
param githubEnvironment string
@description('The GitHub environment the Auth0 job runs in (provision-auth0.yml: environment: auth0-<environment>). It holds the Auth0 Management API credential, so it is not the deploy pipelines\' environment.')
param githubAuth0Environment string
@description('People who may run the agent (Agent.Run), by user principal name.')
param agentUsers array
@description('People who may start the operator job, by user principal name: the operators\' group members.')
param operators array
@description('014: people who may use the portal\'s administration area (Portal.Admin), by user principal name. Separate from agentUsers: holding one role never gives the other.')
param portalAdmins array
@description('013: the portal\'s public origin, https://<its app>.<the environment\'s default domain>, without a trailing slash. Empty until the portal is deployed: the web app then has its local redirect URI only.')
param portalOrigin string

// Validation fails, naming both, when this runs anywhere other than the parameter file says.
var target = tenant().tenantId == tenantId && subscription().subscriptionId == subscriptionId
  ? subscriptionId
  : fail('pre-deploy: the parameter file names tenant ${tenantId}, subscription ${subscriptionId}; this deployment runs in tenant ${tenant().tenantId}, subscription ${subscription().subscriptionId}')

// Stable IDs, so a redeployment updates the same role and scope instead of adding new ones.
var agentRunRoleId = '5b2c3a7e-6f1d-4c55-9f0e-0a1b2c3d4e51'
// 014: the portal administrator's role. A fixed ID, like the role and the scopes beside it, so a redeployment never
// re-creates it and no assignment is lost.
var portalAdminRoleId = '5b2c3a7e-6f1d-4c55-9f0e-0a1b2c3d4e54'
var userImpersonationId = '5b2c3a7e-6f1d-4c55-9f0e-0a1b2c3d4e52'
var portalAccessId = '5b2c3a7e-6f1d-4c55-9f0e-0a1b2c3d4e53'
// The Azure CLI's well-known public client ID.
var azureCliAppId = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: names.resourceGroup
  location: location
  tags: { subscription: target }
}

// ---- The API app: what requesters' tokens are issued for -------------------------------------------------------
// Entra v2.0 tokens carry the app's client ID as aud, never the identifier URI, so AUTH_AUDIENCE is apiAppId.
resource apiApp 'Microsoft.Graph/applications@v1.0' = {
  uniqueName: names.apiApp
  displayName: names.apiApp
  signInAudience: 'AzureADMyOrg'
  identifierUris: ['api://${names.apiApp}']
  api: {
    requestedAccessTokenVersion: 2
    oauth2PermissionScopes: [
      {
        id: userImpersonationId
        value: 'user_impersonation'
        type: 'Admin'
        isEnabled: true
        adminConsentDisplayName: 'Run the x402 agent as the signed-in user'
        adminConsentDescription: 'Lets a client run the x402 purchasing agent as the signed-in user. The user still needs the Agent.Run role.'
      }
      {
        id: portalAccessId
        value: 'Portal.Access'
        type: 'Admin'
        isEnabled: true
        adminConsentDisplayName: 'Use the x402 portal as the signed-in user'
        adminConsentDescription: 'Lets the portal web app read and change the signed-in user\'s own profile, account and expense policy. The user still needs the Agent.Run role.'
      }
    ]
    // The Azure CLI may request user_impersonation without a consent prompt, so `az account get-access-token
    // --scope api://app-l1-…/user_impersonation` works for a person assigned Agent.Run. Pre-authorization needs no
    // service principal for the Azure CLI in the tenant (a consent grant would). 013: the portal web app may request
    // Portal.Access only, so its tokens never carry user_impersonation, the scope the agent service requires.
    preAuthorizedApplications: [
      { appId: azureCliAppId, delegatedPermissionIds: [userImpersonationId] }
      { appId: portalApp.appId, delegatedPermissionIds: [portalAccessId] }
    ]
  }
  // 013: auth_time dates the person's last interactive sign-in (a loosening policy change needs a fresh one), and
  // idtyp tells a user token from an app-only one; include_user_token puts it in user tokens too.
  optionalClaims: {
    accessToken: [
      { name: 'auth_time' }
      { name: 'idtyp', additionalProperties: ['include_user_token'] }
    ]
  }
  appRoles: [
    {
      id: agentRunRoleId
      value: 'Agent.Run'
      displayName: 'Agent.Run'
      description: 'Run the x402 purchasing agent (spends from the shared budget within the mandate)'
      allowedMemberTypes: ['User', 'Application']
      isEnabled: true
    }
    // 014: decides escalated payments and reads the ledger check in the portal. People only: no application, and
    // not the deploy app, can hold it.
    {
      id: portalAdminRoleId
      value: 'Portal.Admin'
      displayName: 'Portal.Admin'
      description: 'Lets a person use the portal\'s administration area'
      allowedMemberTypes: ['User']
      isEnabled: true
    }
  ]
}

// Only principals assigned Agent.Run can get a token for the API.
resource apiSp 'Microsoft.Graph/servicePrincipals@v1.0' = {
  appId: apiApp.appId
  appRoleAssignmentRequired: true
}

// ---- The portal web app (013): what people sign in to the portal with -------------------------------------------
// A public single-page client: authorization code with PKCE, no secret, no certificate, no role and no permission
// of its own (the API app pre-authorizes it for Portal.Access). Its redirect URIs are the local portal's and, once
// the portal is deployed and portalOrigin is set, the deployed one's.
resource portalApp 'Microsoft.Graph/applications@v1.0' = {
  uniqueName: names.portalApp
  displayName: names.portalApp
  signInAudience: 'AzureADMyOrg'
  spa: {
    redirectUris: concat(['http://localhost:4025/redirect.html'], empty(portalOrigin) ? [] : ['${portalOrigin}/redirect.html'])
  }
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

// The Auth0 pipeline's job (provision-auth0.yml, job `environment: <githubAuth0Environment>`) signs in the same way,
// for the Terraform state only. One credential at a time: Entra refuses concurrent writes to one application.
var githubAuth0Subject = 'repo:${split(githubRepository, '/')[0]}@${githubOwnerId}/${split(githubRepository, '/')[1]}@${githubRepositoryId}:environment:${githubAuth0Environment}'

resource githubAuth0Credential 'Microsoft.Graph/applications/federatedIdentityCredentials@v1.0' = {
  name: '${deployApp.uniqueName}/github-${githubAuth0Environment}'
  description: 'GitHub Actions: the Auth0 job of ${githubRepository} in its ${githubAuth0Environment} environment'
  audiences: ['api://AzureADTokenExchange']
  issuer: 'https://token.actions.githubusercontent.com'
  subject: githubAuth0Subject
  dependsOn: [githubCredential]
}

resource deploySp 'Microsoft.Graph/servicePrincipals@v1.0' = {
  appId: deployApp.appId
}

// ---- Who may run the agent -------------------------------------------------------------------------------------
// The deploy app, for the pipeline's smoke run: it can then spend through the agent, within the mandate.
resource deployAgentRun 'Microsoft.Graph/appRoleAssignedTo@v1.0' = {
  appRoleId: agentRunRoleId
  principalId: deploySp.id
  resourceId: apiSp.id
}

resource agentUser 'Microsoft.Graph/users@v1.0' existing = [for upn in agentUsers: {
  userPrincipalName: upn
}]

resource userAgentRun 'Microsoft.Graph/appRoleAssignedTo@v1.0' = [for (upn, i) in agentUsers: {
  appRoleId: agentRunRoleId
  principalId: agentUser[i].id
  resourceId: apiSp.id
}]

// ---- Who may administer the portal (014) -----------------------------------------------------------------------
resource portalAdminUser 'Microsoft.Graph/users@v1.0' existing = [for upn in portalAdmins: {
  userPrincipalName: upn
}]

resource userPortalAdmin 'Microsoft.Graph/appRoleAssignedTo@v1.0' = [for (upn, i) in portalAdmins: {
  appRoleId: portalAdminRoleId
  principalId: portalAdminUser[i].id
  resourceId: apiSp.id
}]

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

// ---- The deploy app's Azure roles: its resource group only -----------------------------------------------------
module deployAccess 'modules/deploy-access.bicep' = {
  name: 'deploy-access'
  scope: rg
  params: {
    principalId: deploySp.id
  }
}

// ---- The Terraform state of auth0/: the deploy app's, on its container only ------------------------------------
module stateStorage 'modules/state-storage.bicep' = {
  name: 'state-storage'
  scope: rg
  params: {
    location: location
    names: names
    principalId: deploySp.id
  }
}

output resourceGroup string = rg.name
@description('The IDs main.<environment>.bicepparam needs, as its lines; the fourth is the one value to set inside its userAccounts object.')
output mainParameters string = join([
  'param deployClientId = \'${deployApp.appId}\''
  'param authAudience = \'${apiApp.appId}\''
  'param operatorsGroupId = \'${operatorsGroup.id}\''
  'param userAccounts = { ..., portalClientId: \'${portalApp.appId}\', ... }'
], '\n')
