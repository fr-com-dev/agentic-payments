// SPEC 1.25 (Phase 3 gap review, finding 2): no user-assigned identity of the resource group may have a federated
// credential. Contributor, the deploy app's role, may otherwise write one: a credential on id-l2 that trusts an issuer
// an attacker controls (their own GitHub repository, say) would let them sign in as L2's identity from outside Azure,
// at any time after the run, and read the l2 vault (the payer key, the wallet mnemonic). Nothing in this system needs
// one: the deploy app's own federated credentials are on its Entra app registration, which no Azure policy governs.
// The built-in definition, with federated credentials not allowed and the effect Deny, refuses every one, whatever its
// issuer, for every principal, Owner included. Deployed by pre-deploy.bicep, by an administrator: the deploy app can't
// change, delete or exempt a policy assignment (Contributor's NotActions hold Microsoft.Authorization/*/Write and
// */Delete). It goes with the resource group. T-IAC-01 rule 16 asserts all of this.
@description('Every name of pre-deploy.<environment>.bicepparam: policy is used here.')
param names object

@description('Built-in "[Preview]: Managed Identity Federated Credentials should be from allowed issuer types".')
var definitionId = tenantResourceId('Microsoft.Authorization/policyDefinitions', '2571b7c3-3056-4a61-b00a-9bc5232234f5')

resource noFederatedCredentials 'Microsoft.Authorization/policyAssignments@2024-04-01' = {
  name: names.policy
  properties: {
    displayName: 'No federated credential on an identity of this resource group (SPEC 1.25)'
    policyDefinitionId: definitionId
    enforcementMode: 'Default'
    parameters: {
      allowFederatedCredentials: { value: false }
      effect: { value: 'Deny' }
    }
  }
}
