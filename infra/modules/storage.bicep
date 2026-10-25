// Premium NFS share for the L2 ledger and its L2-6 lock (POSIX exclusive create and rename).
param location string
param suffix string
param subnetId string

resource st 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'stx402${suffix}'
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
      virtualNetworkRules: [{ id: subnetId, action: 'Allow' }]
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

output nfsServer string = '${st.name}.file.${environment().suffixes.storage}'
output nfsShareName string = '/${st.name}/${share.name}'
