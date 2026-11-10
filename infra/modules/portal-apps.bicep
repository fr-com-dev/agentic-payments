// The portal's app in names.environments.x402 (specs/013 contracts/config-and-secrets.md "modules/portal-apps.bicep",
// research R16): the web portal (names.apps.portal) from the portal's image, which serves the web app and its API on
// one origin. Deployed by main.bicep when unit is 'portal' (deploy-portal.yml). The platform's resources it uses are
// looked up by their names (the names parameter), never passed in as another module's outputs: what-if skips a
// module whose parameters hold runtime values, so this keeps the module in the preview of a first deployment.
// main.bicep deploys it after the platform (dependsOn).
// T-IAC-01 asserts on the compiled form of this file:
// - external ingress (rule 3 lists it); identity lifecycle None; its own image and entry point (rule 12);
// - one replica at most, single revision, the NFS profiles storage at /app/.local/portal, which only it mounts
//   (rule 4);
// - secrets only from the portal vault, portal-token and card-vault-key, always referenced, so every environment
//   seeds both (the placeholder off while user accounts or cards are off); the arrays stay literal (rule 21);
// - no payment key and no token but PORTAL_TOKEN; it calls L2 only; the API docs switch is never set (rule 21).
param location string
@description('Every resource name (main.<environment>.bicepparam).')
param names object
@description('The NFS profiles storage environments.bicep adds to names.environments.x402.')
param profilesStorageName string
@description('x402-portal:<imageTag> in the registry.')
param image string
@description('The registry\'s login server.')
param acrServer string
param authTenantId string
@description('The API app\'s client ID: the audience of the person\'s token, as for the agent.')
param authAudience string
@description('013 user accounts (SPEC L2-8): the non-secret settings from the parameter file.')
param userAccounts object

resource idPortal 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: names.identities.portal }
resource mainEnv 'Microsoft.App/managedEnvironments@2025-01-01' existing = { name: names.environments.x402 }

var vaultPortal = 'https://${names.vaults.portal}${az.environment().suffixes.keyvaultDns}/'
var mainDomain = mainEnv.properties.defaultDomain
var controlUrl = 'http://${names.apps.l2}.internal.${mainDomain}'

// ---------------------------------------------------------------------------------------------
// Portal (L2-8): public ingress, single revision, 0–1 replicas, NFS profiles, identity lifecycle None.
// ---------------------------------------------------------------------------------------------
resource portal 'Microsoft.App/containerApps@2025-01-01' = {
  name: names.apps.portal
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${idPortal.id}': {} } }
  properties: {
    environmentId: mainEnv.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: { external: true, targetPort: 4025, transport: 'auto', allowInsecure: false }
      registries: [{ server: acrServer, identity: idPortal.id }]
      secrets: [
        { name: 'portal-token', keyVaultUrl: '${vaultPortal}secrets/portal-token', identity: idPortal.id }
        { name: 'card-vault-key', keyVaultUrl: '${vaultPortal}secrets/card-vault-key', identity: idPortal.id }
      ]
      identitySettings: [{ identity: idPortal.id, lifecycle: 'None' }]
    }
    template: {
      containers: [
        {
          name: 'portal'
          image: image
          command: ['node', 'dist/src/portal-main.js']
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'NETWORK', value: 'base-sepolia' }
            { name: 'PORTAL_BIND_HOST', value: '0.0.0.0' }
            { name: 'CONTROL_URL', value: controlUrl }
            { name: 'AUTH_TENANT_ID', value: authTenantId }
            { name: 'AUTH_AUDIENCE', value: authAudience }
            { name: 'PORTAL_CLIENT_ID', value: userAccounts.portalClientId }
            { name: 'PROFILE_DIR', value: '/app/.local/portal/profiles' }
            // Empty unless stripe: the portal reads an empty CARD_VAULT as cards off, and then ignores both keys.
            { name: 'CARD_VAULT', value: userAccounts.cardVault == 'stripe' ? 'stripe' : '' }
            { name: 'CARD_VAULT_PUBLISHABLE_KEY', value: userAccounts.cardVaultPublishableKey }
            { name: 'PORTAL_TOKEN', secretRef: 'portal-token' }
            { name: 'CARD_VAULT_KEY', secretRef: 'card-vault-key' }
          ]
          volumeMounts: [{ volumeName: 'profiles', mountPath: '/app/.local/portal' }]
          probes: [
            { type: 'Liveness', httpGet: { path: '/healthz', port: 4025 } }
            { type: 'Readiness', httpGet: { path: '/readyz', port: 4025 } }
          ]
        }
      ]
      volumes: [{ name: 'profiles', storageType: 'NfsAzureFile', storageName: profilesStorageName }]
      scale: { minReplicas: 0, maxReplicas: 1 }
    }
  }
}

output portalFqdn string = portal.properties.configuration.ingress.fqdn
