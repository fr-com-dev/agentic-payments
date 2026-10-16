# Contract: MockUSDC ABI surface (CP-4, local only)

Compiled with solc 0.8.24 (`evmVersion: shanghai`, optimizer 200 runs) and deployed by
account #0 on chain 31337.

## Metadata

| Item | Value |
|---|---|
| `name()` | "USD Coin" |
| `symbol()` | "USDC" |
| `decimals()` | 6 |
| `version()` | "2" |
| EIP-712 domain | `(name, version, chainId, verifyingContract)` |

## Functions

```solidity
// ERC-20
function balanceOf(address) external view returns (uint256);
function transfer(address to, uint256 value) external returns (bool);
function approve(address spender, uint256 value) external returns (bool);
function transferFrom(address from, address to, uint256 value) external returns (bool);
function allowance(address owner, address spender) external view returns (uint256);
function totalSupply() external view returns (uint256);

// Owner only
function mint(address to, uint256 value) external;            // reverts for non-owner

// EIP-3009
function transferWithAuthorization(
  address from, address to, uint256 value,
  uint256 validAfter, uint256 validBefore, bytes32 nonce,
  uint8 v, bytes32 r, bytes32 s) external;
function transferWithAuthorization(
  address from, address to, uint256 value,
  uint256 validAfter, uint256 validBefore, bytes32 nonce,
  bytes signature) external;
function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
function DOMAIN_SEPARATOR() external view returns (bytes32);
```

The signed type is
`TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)`.

## Events

```solidity
event Transfer(address indexed from, address indexed to, uint256 value);
event Approval(address indexed owner, address indexed spender, uint256 value);
event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
```

## Revert conditions for `transferWithAuthorization`

- `block.timestamp <= validAfter`
- `block.timestamp >= validBefore`
- the nonce has already been used
- the recovered signer is not `from`
- `from` has an insufficient balance

L3 (feature 005) verifies settlement through the `Transfer` log that this contract emits.
