// L2's app in names.environments.x402 (specs/011 contracts/cloud-topology.md "Apps and jobs", "Non-secret env",
// "Secrets"): the control service (names.apps.l2) from L2's image; the operator job is the operator's own unit
// (operator-apps.bicep). Deployed by main.bicep when unit is 'l2' (deploy-l2.yml). The platform's resources it uses
// are looked up by their names (the names parameter), never passed in as another module's outputs: what-if skips a
// module whose parameters hold runtime values, so this keeps the module in the preview of a first deployment.
// main.bicep deploys it after the platform (dependsOn).
// T-IAC-01 asserts on the compiled form of this file:
// - PAYER_PRIVATE_KEY reaches only the l2 container, as a Key Vault reference from the l2 vault;
// - internal-only ingress through a loopback proxy sidecar that has no env and no secrets;
// - exactly one replica with the NFS ledger at /app/.local (L2-6); identity lifecycle None.
// - 012 (rule 19): the Auth0 client credential reaches only the l2 container, as a reference to the l2 vault's
//   ciba-client-credential, and every other CIBA_* value comes from the ciba parameter. The secret is always referenced,
//   so every environment seeds it (the placeholder off while ciba.enabled is false); the arrays stay literal.
// - 013 (rule 21): the portal's token and the user wallet mnemonic reach only the l2 container, as references to the l2
//   vault's portal-token and user-wallet-mnemonic, always referenced like the CIBA credential (the placeholder off
//   while userAccounts.enabled is false, when L2 ignores both). USER_ACCOUNTS comes from the userAccounts parameter,
//   and PLATFORM_SELLERS is the one seller L2 allows: the same host as ALLOWED_HOSTS, never the alias.
// - 014 (rule 22): the administration role's token reaches only the l2 container, as a reference to the l2 vault's
//   portal-admin-token, always referenced (the placeholder off while userAccounts.administration is false, when L2
//   ignores it). PORTAL_ADMIN comes from userAccounts.administration.
param location string
@description('Every resource name (main.<environment>.bicepparam).')
param names object
@description('The NFS ledger storage environments.bicep adds to names.environments.x402.')
param ledgerStorageName string
@description('x402-l2-control:<imageTag> in the registry (research R14).')
param image string
param proxyImage string
@description('The registry\'s login server.')
param acrServer string
param sellerPayTo string
@description('012 backchannel approval (SPEC L2-7): the non-secret settings from the parameter file.')
param ciba object
@description('013 user accounts (SPEC L2-8): the non-secret settings from the parameter file.')
param userAccounts object

resource idL2 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: names.identities.l2 }
resource mainEnv 'Microsoft.App/managedEnvironments@2025-01-01' existing = { name: names.environments.x402 }
resource sellerEnv 'Microsoft.App/managedEnvironments@2025-01-01' existing = { name: names.environments.seller }

var vaultL2 = 'https://${names.vaults.l2}${az.environment().suffixes.keyvaultDns}/'
var sellerDomain = sellerEnv.properties.defaultDomain
// The one seller host L2 allows: ALLOWED_HOSTS, and the host of 013's platform seller list.
var sellerHost = '${names.apps.seller}.${sellerDomain}'

// ---------------------------------------------------------------------------------------------
// L2 control: internal-only ingress through the proxy sidecar; exactly one replica; NFS ledger; lifecycle None.
// ---------------------------------------------------------------------------------------------
resource control 'Microsoft.App/containerApps@2025-01-01' = {
  name: names.apps.l2
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${idL2.id}': {} } }
  properties: {
    environmentId: mainEnv.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: { external: false, targetPort: 8080, transport: 'http', allowInsecure: true }
      registries: [{ server: acrServer, identity: idL2.id }]
      secrets: [
        { name: 'payer-private-key', keyVaultUrl: '${vaultL2}secrets/payer-private-key', identity: idL2.id }
        { name: 'control-token', keyVaultUrl: '${vaultL2}secrets/control-token', identity: idL2.id }
        { name: 'settlement-token', keyVaultUrl: '${vaultL2}secrets/settlement-token', identity: idL2.id }
        { name: 'operator-token', keyVaultUrl: '${vaultL2}secrets/operator-token', identity: idL2.id }
        { name: 'ciba-client-credential', keyVaultUrl: '${vaultL2}secrets/ciba-client-credential', identity: idL2.id }
        { name: 'portal-token', keyVaultUrl: '${vaultL2}secrets/portal-token', identity: idL2.id }
        { name: 'user-wallet-mnemonic', keyVaultUrl: '${vaultL2}secrets/user-wallet-mnemonic', identity: idL2.id }
        { name: 'portal-admin-token', keyVaultUrl: '${vaultL2}secrets/portal-admin-token', identity: idL2.id }
        // The proxy config is not a secret; Container Apps mounts files only through secret volumes.
        #disable-next-line use-secure-value-for-secure-inputs
        { name: 'nginx-conf', value: loadTextContent('../proxy/nginx-l2.conf') }
      ]
      identitySettings: [{ identity: idL2.id, lifecycle: 'None' }]
    }
    template: {
      containers: [
        {
          name: 'l2'
          image: image
          command: ['node', 'dist/src/layer2-control/service.js']
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'NETWORK', value: 'base-sepolia' }
            { name: 'ALLOWED_PAYEES', value: sellerPayTo }
            { name: 'ALLOWED_HOSTS', value: sellerHost }
            { name: 'PAYER_PRIVATE_KEY', secretRef: 'payer-private-key' }
            { name: 'CONTROL_TOKEN', secretRef: 'control-token' }
            { name: 'SETTLEMENT_TOKEN', secretRef: 'settlement-token' }
            { name: 'OPERATOR_TOKEN', secretRef: 'operator-token' }
            { name: 'CIBA_APPROVAL', value: ciba.enabled ? '1' : '0' }
            { name: 'CIBA_ISSUER', value: ciba.issuer }
            { name: 'CIBA_CLIENT_ID', value: ciba.clientId }
            { name: 'CIBA_AUDIENCE', value: ciba.audience }
            { name: 'CIBA_APPROVER', value: ciba.approver }
            { name: 'CIBA_CLIENT_KEY_ID', value: ciba.clientKeyId }
            { name: ciba.credential == 'secret' ? 'CIBA_CLIENT_SECRET' : 'CIBA_CLIENT_KEY', secretRef: 'ciba-client-credential' }
            { name: 'USER_ACCOUNTS', value: userAccounts.enabled ? '1' : '0' }
            { name: 'PLATFORM_SELLERS', value: string([{ host: sellerHost, name: userAccounts.sellerName, payees: [sellerPayTo] }]) }
            { name: 'PORTAL_TOKEN', secretRef: 'portal-token' }
            { name: 'USER_WALLET_MNEMONIC', secretRef: 'user-wallet-mnemonic' }
            { name: 'PORTAL_ADMIN', value: userAccounts.administration ? '1' : '0' }
            { name: 'PORTAL_ADMIN_TOKEN', secretRef: 'portal-admin-token' }
          ]
          volumeMounts: [{ volumeName: 'ledger', mountPath: '/app/.local' }]
        }
        {
          name: 'proxy'
          image: proxyImage
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          volumeMounts: [{ volumeName: 'nginx-conf', mountPath: '/etc/nginx/conf.d' }]
          probes: [
            { type: 'Liveness', tcpSocket: { port: 8080 } }
            { type: 'Readiness', tcpSocket: { port: 8080 } }
          ]
        }
      ]
      volumes: [
        { name: 'ledger', storageType: 'NfsAzureFile', storageName: ledgerStorageName }
        { name: 'nginx-conf', storageType: 'Secret', secrets: [{ secretRef: 'nginx-conf', path: 'default.conf' }] }
      ]
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}
