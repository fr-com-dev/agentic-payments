// VNet and one infrastructure subnet per Container Apps environment (specs/011 contracts/cloud-topology.md).
// Both subnets carry the Key Vault service endpoint, so each vault can allow only its unit's subnet.
param location string
@description('Every resource name (main.<environment>.bicepparam).')
param names object

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: names.network
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.40.0.0/16'] }
    subnets: [
      {
        name: names.subnets.x402
        properties: {
          addressPrefix: '10.40.0.0/23'
          delegations: [{ name: 'aca', properties: { serviceName: 'Microsoft.App/environments' } }]
          serviceEndpoints: [{ service: 'Microsoft.KeyVault' }, { service: 'Microsoft.Storage' }]
        }
      }
      {
        name: names.subnets.seller
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
output sellerSubnetId string = vnet.properties.subnets[1].id
