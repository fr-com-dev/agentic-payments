// VNet and one infrastructure subnet per Container Apps environment (specs/011 contracts/cloud-topology.md).
// Both subnets carry the Key Vault service endpoint, so each vault can allow only its unit's subnet.
param location string

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: 'vnet-x402'
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.40.0.0/16'] }
    subnets: [
      {
        name: 'snet-cae'
        properties: {
          addressPrefix: '10.40.0.0/23'
          delegations: [{ name: 'aca', properties: { serviceName: 'Microsoft.App/environments' } }]
          serviceEndpoints: [{ service: 'Microsoft.KeyVault' }, { service: 'Microsoft.Storage' }]
        }
      }
      {
        name: 'snet-cae-cp'
        properties: {
          addressPrefix: '10.40.2.0/23'
          delegations: [{ name: 'aca', properties: { serviceName: 'Microsoft.App/environments' } }]
          serviceEndpoints: [{ service: 'Microsoft.KeyVault' }]
        }
      }
    ]
  }
}

output mainSubnetId string = vnet.properties.subnets[0].id
output cpSubnetId string = vnet.properties.subnets[1].id
