// Premium NFS share for the L2 ledger and its L2-6 lock (POSIX exclusive create and rename).
// Its inputs are names, never another module's outputs, so what-if previews it on a first deployment (main.bicep).
param location string
@description('Every resource name (main.<environment>.bicepparam).')
param names object

resource st 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  // Lowercase letters and digits only.
  name: names.storage
  location: location
  kind: 'FileStorage'
  sku: { name: 'Premium_LRS' }
  properties: {
    // NFS shares need this off; traffic stays inside the VNet (service endpoint plus firewall).
    supportsHttpsTrafficOnly: false
    minimumTlsVersion: 'TLS1_2'
    allowSharedKeyAccess: false
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'None'
      virtualNetworkRules: [{ id: resourceId('Microsoft.Network/virtualNetworks/subnets', names.network, names.subnets.x402), action: 'Allow' }]
    }
  }
}

resource files 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: st
  name: 'default'
}

resource share 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: files
  name: 'ledger'
  properties: {
    enabledProtocols: 'NFS'
    rootSquash: 'NoRootSquash'
    shareQuota: 100
  }
}

output nfsServer string = '${st.name}.file.${az.environment().suffixes.storage}'
output nfsShareName string = '/${st.name}/${share.name}'
