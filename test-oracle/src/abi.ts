// DeFiInteractor ABI (S4b)
export const DeFiInteractorABI = [
  // ============ Oracle Functions ============
  {
    type: 'function',
    name: 'updateSafeValue',
    inputs: [{ name: 'totalValueUSD', type: 'uint256', internalType: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'updateSpendingAllowance',
    inputs: [
      { name: 'subAccount', type: 'address', internalType: 'address' },
      { name: 'newAllowance', type: 'uint256', internalType: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'updateAcquiredBalance',
    inputs: [
      { name: 'subAccount', type: 'address', internalType: 'address' },
      { name: 'token', type: 'address', internalType: 'address' },
      { name: 'newBalance', type: 'uint256', internalType: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'batchUpdate',
    inputs: [
      { name: 'subAccount', type: 'address', internalType: 'address' },
      { name: 'newAllowance', type: 'uint256', internalType: 'uint256' },
      { name: 'tokens', type: 'address[]', internalType: 'address[]' },
      { name: 'balances', type: 'uint256[]', internalType: 'uint256[]' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  // ============ View Functions ============
  {
    type: 'function',
    name: 'getSafeValue',
    inputs: [],
    outputs: [
      { name: 'totalValueUSD', type: 'uint256', internalType: 'uint256' },
      { name: 'lastUpdated', type: 'uint256', internalType: 'uint256' },
      { name: 'updateCount', type: 'uint256', internalType: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getSpendingAllowance',
    inputs: [{ name: 'subAccount', type: 'address', internalType: 'address' }],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getAcquiredBalance',
    inputs: [
      { name: 'subAccount', type: 'address', internalType: 'address' },
      { name: 'token', type: 'address', internalType: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'avatar',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getTokenBalances',
    inputs: [{ name: 'tokens', type: 'address[]', internalType: 'address[]' }],
    outputs: [{ name: 'balances', type: 'uint256[]', internalType: 'uint256[]' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getSubAccountLimits',
    inputs: [{ name: 'subAccount', type: 'address', internalType: 'address' }],
    outputs: [
      { name: 'maxSpendingBps', type: 'uint256', internalType: 'uint256' },
      { name: 'windowDuration', type: 'uint256', internalType: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getSubaccountsByRole',
    inputs: [{ name: 'roleId', type: 'uint16', internalType: 'uint16' }],
    outputs: [{ name: '', type: 'address[]', internalType: 'address[]' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'safeValue',
    inputs: [],
    outputs: [
      { name: 'totalValueUSD', type: 'uint256', internalType: 'uint256' },
      { name: 'lastUpdated', type: 'uint256', internalType: 'uint256' },
      { name: 'updateCount', type: 'uint256', internalType: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'absoluteMaxSpendingBps',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'subAccountLimits',
    inputs: [{ name: 'subAccount', type: 'address', internalType: 'address' }],
    outputs: [
      { name: 'maxSpendingBps', type: 'uint256', internalType: 'uint256' },
      { name: 'windowDuration', type: 'uint256', internalType: 'uint256' },
      { name: 'isConfigured', type: 'bool', internalType: 'bool' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'DEFI_EXECUTE_ROLE',
    inputs: [],
    outputs: [{ name: '', type: 'uint16', internalType: 'uint16' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'DEFI_TRANSFER_ROLE',
    inputs: [],
    outputs: [{ name: '', type: 'uint16', internalType: 'uint16' }],
    stateMutability: 'view',
  },
  // ============ Events ============
  // Note: Events no longer include timestamp - contract uses block.timestamp internally
  {
    type: 'event',
    name: 'ProtocolExecution',
    inputs: [
      { name: 'subAccount', type: 'address', indexed: true, internalType: 'address' },
      { name: 'target', type: 'address', indexed: true, internalType: 'address' },
      { name: 'opType', type: 'uint8', indexed: false, internalType: 'uint8' },
      { name: 'tokensIn', type: 'address[]', indexed: false, internalType: 'address[]' },
      { name: 'amountsIn', type: 'uint256[]', indexed: false, internalType: 'uint256[]' },
      { name: 'tokensOut', type: 'address[]', indexed: false, internalType: 'address[]' },
      { name: 'amountsOut', type: 'uint256[]', indexed: false, internalType: 'uint256[]' },
      { name: 'spendingCost', type: 'uint256', indexed: false, internalType: 'uint256' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'TransferExecuted',
    inputs: [
      { name: 'subAccount', type: 'address', indexed: true, internalType: 'address' },
      { name: 'token', type: 'address', indexed: true, internalType: 'address' },
      { name: 'recipient', type: 'address', indexed: true, internalType: 'address' },
      { name: 'amount', type: 'uint256', indexed: false, internalType: 'uint256' },
      { name: 'spendingCost', type: 'uint256', indexed: false, internalType: 'uint256' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'SafeValueUpdated',
    inputs: [
      { name: 'totalValueUSD', type: 'uint256', indexed: false, internalType: 'uint256' },
      { name: 'updateCount', type: 'uint256', indexed: false, internalType: 'uint256' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'SpendingAllowanceUpdated',
    inputs: [
      { name: 'subAccount', type: 'address', indexed: true, internalType: 'address' },
      { name: 'newAllowance', type: 'uint256', indexed: false, internalType: 'uint256' },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'AcquiredBalanceUpdated',
    inputs: [
      { name: 'subAccount', type: 'address', indexed: true, internalType: 'address' },
      { name: 'token', type: 'address', indexed: true, internalType: 'address' },
      { name: 'newBalance', type: 'uint256', indexed: false, internalType: 'uint256' },
    ],
    anonymous: false,
  },
] as const

// ERC20 ABI
export const ERC20ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'decimals',
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

// Chainlink Price Feed ABI
export const ChainlinkPriceFeedABI = [
  {
    inputs: [],
    name: 'latestRoundData',
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'decimals',
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

// Morpho Vault ABI
export const MorphoVaultABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'decimals',
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'shares', type: 'uint256' }],
    name: 'convertToAssets',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'asset',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

// Uniswap V2 Pair ABI
export const UniswapV2PairABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'totalSupply',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getReserves',
    outputs: [
      { name: 'reserve0', type: 'uint112' },
      { name: 'reserve1', type: 'uint112' },
      { name: 'blockTimestampLast', type: 'uint32' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'token0',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'token1',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

// Operation types enum (matches contract)
export enum OperationType {
  UNKNOWN = 0,
  SWAP = 1,
  DEPOSIT = 2,
  WITHDRAW = 3,
  CLAIM = 4,
  APPROVE = 5,
}

// ModuleRegistry ABI - for multi-module support
export const ModuleRegistryABI = [
  {
    inputs: [],
    name: 'getActiveModules',
    outputs: [{ name: 'modules', type: 'address[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'offset', type: 'uint256' },
      { name: 'limit', type: 'uint256' },
    ],
    name: 'getActiveModulesPaginated',
    outputs: [
      { name: 'modules', type: 'address[]' },
      { name: 'total', type: 'uint256' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getActiveModuleCount',
    outputs: [{ name: 'count', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'safe', type: 'address' }],
    name: 'getModuleForSafe',
    outputs: [{ name: 'module', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'module', type: 'address' }],
    name: 'isRegistered',
    outputs: [{ name: 'registered', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const
