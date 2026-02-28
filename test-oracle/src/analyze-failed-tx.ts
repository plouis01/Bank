/**
 * Failed Transaction Analyzer
 *
 * Analyzes failed transactions on Sepolia by:
 * 1. Fetching transaction data
 * 2. Decoding the calldata with full argument parsing
 * 3. Re-simulating to get the error (with trace support)
 * 4. Matching error to smart contract errors
 * 5. Providing human-readable explanation with rich context
 *
 * Usage: npx tsx src/analyze-failed-tx.ts <tx-hash>
 */

import {
  createPublicClient,
  http,
  decodeErrorResult,
  decodeFunctionData,
  decodeAbiParameters,
  formatEther,
  formatUnits,
  parseAbi,
  type Hex,
  type Address,
  type PublicClient,
} from 'viem'
import { monadTestnet } from './config.js'
import dotenv from 'dotenv'

dotenv.config()

// ============ Token Symbol Cache ============
const tokenSymbolCache = new Map<string, string>()
const tokenDecimalsCache = new Map<string, number>()

// Known token addresses on Sepolia
const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  '0xf8fb3713d459d7c1018bd0a49d19b4c44290ebe5': { symbol: 'LINK', decimals: 18 },
  '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238': { symbol: 'USDC', decimals: 6 },
  '0x94a9d9ac8a22534e3faca9f4e7f2e2cf85d5e4c8': { symbol: 'USDC (Aave)', decimals: 6 },
  '0xff34b3d4aee8ddcd6f9afffb6fe49bd371b8a357': { symbol: 'DAI', decimals: 18 },
  '0xaa8e23fb1079ea71e0a56f48a2aa51851d8433d0': { symbol: 'USDT', decimals: 6 },
  '0xc558dbdd856501fcd9aaf1e62eae57a9f0629a3c': { symbol: 'WETH', decimals: 18 },
  '0x29f2d40b0605204364af54ec677bd022da425d03': { symbol: 'WBTC', decimals: 8 },
  '0x88541670e55cc00beefd87eb59edd1b7c511ac9a': { symbol: 'AAVE', decimals: 18 },
  '0x6d906e526a4e2ca02097ba9d0caa3c382f52278e': { symbol: 'EURS', decimals: 2 },
  // aTokens
  '0x29598b72eb5cebd806c5dcd549490fda35b13cd8': { symbol: 'aDAI', decimals: 18 },
  '0x16da4541ad1807f4443d92d26044c1147406eb80': { symbol: 'aUSDC', decimals: 6 },
  '0xaf0f6e8b0dc5c913bbf4d14c22b4e78dd14310b6': { symbol: 'aUSDT', decimals: 6 },
  '0x5b071b590a59395fe4025a0ccc1fcc931aac1830': { symbol: 'aWETH', decimals: 18 },
  '0x1804bf30507dc2eb3bdebbbdd859991eaef6eeff': { symbol: 'aWBTC', decimals: 8 },
  '0x3ffaf50d4f4e96eb78f2407c090b72e86ecaed24': { symbol: 'aLINK', decimals: 18 },
  '0x6b8558764d3b7572136f17174cb9ab1ddc7e1259': { symbol: 'aAAVE', decimals: 18 },
}

// Known protocol addresses
const KNOWN_PROTOCOLS: Record<string, string> = {
  '0x6ae43d3271ff6888e7fc43fd7321a503ff738951': 'Aave V3 Pool',
  '0x3bfa4769fb09eefc5a80d6e87c3b9c650f7ae48e': 'Uniswap V3 SwapRouter',
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'Uniswap Universal Router',
}

// ============ Contract Error Definitions ============
const CONTRACT_ERRORS: Record<string, { description: string; solution: string }> = {
  UnknownSelector: {
    description: 'The function selector is not registered in the module',
    solution: 'Register the selector using registerSelector() or use a supported function',
  },
  TransactionFailed: {
    description: 'The underlying transaction to the protocol failed',
    solution: 'Check the target protocol for the actual error (insufficient balance, slippage, etc.)',
  },
  ApprovalFailed: {
    description: 'The token approval transaction failed',
    solution: 'Check if the token contract allows approvals or if there are approval restrictions',
  },
  InvalidLimitConfiguration: {
    description: 'Invalid sub-account limit configuration (maxSpendingBps > 10000 or windowDuration < 1 hour)',
    solution: 'Ensure maxSpendingBps <= 10000 and windowDuration >= 3600',
  },
  AddressNotAllowed: {
    description: 'The target address is not in the sub-account\'s whitelist',
    solution: 'Add the target address to allowedAddresses using setAllowedAddresses()',
  },
  ExceedsSpendingLimit: {
    description: 'The operation would exceed the sub-account\'s spending allowance',
    solution: 'Wait for oracle to refresh allowance, use acquired tokens, or reduce operation size',
  },
  OnlyAuthorizedOracle: {
    description: 'Only the authorized oracle can call this function',
    solution: 'Use the authorized oracle address to call this function',
  },
  InvalidOracleAddress: {
    description: 'Cannot set oracle to zero address',
    solution: 'Provide a valid oracle address',
  },
  StaleOracleData: {
    description: 'Oracle data for this sub-account is too old or never set',
    solution: 'Wait for oracle to update spending allowance (must be within maxOracleAge)',
  },
  StalePortfolioValue: {
    description: 'Safe\'s portfolio value is stale or never updated',
    solution: 'Oracle must call updateSafeValue() first',
  },
  InvalidPriceFeed: {
    description: 'Price feed address is invalid (zero address)',
    solution: 'Set a valid Chainlink price feed address',
  },
  StalePriceFeed: {
    description: 'Chainlink price feed data is stale',
    solution: 'Check if Chainlink price feed is still active on this network',
  },
  InvalidPrice: {
    description: 'Chainlink returned a zero or negative price',
    solution: 'Check if the price feed contract is correct',
  },
  NoPriceFeedSet: {
    description: 'No Chainlink price feed configured for this token',
    solution: 'Owner must set price feed using setTokenPriceFeed()',
  },
  ApprovalExceedsLimit: {
    description: 'Approval amount exceeds spending allowance for non-acquired tokens',
    solution: 'Reduce approval amount or wait for allowance refresh',
  },
  SpenderNotAllowed: {
    description: 'The spender address in approve() is not whitelisted',
    solution: 'Add the spender to allowedAddresses before approving',
  },
  NoParserRegistered: {
    description: 'No calldata parser is registered for this protocol',
    solution: 'Owner must register a parser using registerParser()',
  },
  ExceedsAbsoluteMaxSpending: {
    description: 'Oracle tried to set spending above absolute max limit',
    solution: 'This is a safety limit - cannot be exceeded even by oracle',
  },
  CannotRegisterUnknown: {
    description: 'Cannot register a selector with UNKNOWN operation type',
    solution: 'Use a valid operation type (SWAP, DEPOSIT, WITHDRAW, CLAIM, APPROVE)',
  },
  LengthMismatch: {
    description: 'Array lengths don\'t match (tokens vs amounts or balances)',
    solution: 'Ensure arrays have the same length',
  },
  ExceedsMaxBps: {
    description: 'Basis points value exceeds 10000 (100%)',
    solution: 'Use a value <= 10000',
  },
  InvalidRecipient: {
    description: 'Operation recipient is not the Safe (potential fund theft)',
    solution: 'Ensure recipient in calldata matches the Safe address',
  },
  CannotBeSubaccount: {
    description: 'This address cannot be a sub-account (Safe, Module, or Oracle)',
    solution: 'Use a different address for the sub-account',
  },
  CannotBeOracle: {
    description: 'This address cannot be the oracle (Safe, Module, or existing sub-account)',
    solution: 'Use a different address for the oracle',
  },
  CannotWhitelistCoreAddress: {
    description: 'Cannot whitelist Safe or Module as interaction targets',
    solution: 'These addresses are blocked for security',
  },
  CannotRegisterParserForCoreAddress: {
    description: 'Cannot register parser for Safe or Module',
    solution: 'Parsers cannot be registered for core addresses',
  },
  Unauthorized: {
    description: 'Caller is not authorized (not owner or lacks required role)',
    solution: 'Use an address with the required role (DEFI_EXECUTE_ROLE or DEFI_TRANSFER_ROLE)',
  },
  InvalidAddress: {
    description: 'Address is invalid (zero address)',
    solution: 'Provide a valid non-zero address',
  },
  ModuleTransactionFailed: {
    description: 'Module transaction execution failed on the Safe',
    solution: 'Check if the module is enabled on the Safe',
  },
  UnsupportedSelector: {
    description: 'The function selector is not supported by the parser',
    solution: 'Use a supported function or register a new selector',
  },
  Panic: {
    description: 'Solidity panic error (assertion failure, overflow, division by zero, etc.)',
    solution: 'Check panic code: 0x01=assert, 0x11=overflow, 0x12=div-by-zero, 0x21=invalid enum, 0x31=pop empty array, 0x32=out-of-bounds, 0x41=too much memory, 0x51=zero-init function pointer',
  },
  NonPayableFunctionWithValue: {
    description: 'Called a non-payable function with ETH value attached',
    solution: 'Use the payable version of the function (e.g., executeOnProtocolWithValue instead of executeOnProtocol)',
  },
  // Common protocol errors
  'ERC20: insufficient allowance': {
    description: 'Token allowance is insufficient for the transfer',
    solution: 'Approve more tokens before the operation',
  },
  'ERC20: transfer amount exceeds balance': {
    description: 'Trying to transfer more tokens than available',
    solution: 'Check token balance before transfer',
  },
}

// ABI for error decoding
const ERROR_ABI = parseAbi([
  'error UnknownSelector(bytes4 selector)',
  'error TransactionFailed()',
  'error ApprovalFailed()',
  'error InvalidLimitConfiguration()',
  'error AddressNotAllowed()',
  'error ExceedsSpendingLimit()',
  'error OnlyAuthorizedOracle()',
  'error InvalidOracleAddress()',
  'error StaleOracleData()',
  'error StalePortfolioValue()',
  'error InvalidPriceFeed()',
  'error StalePriceFeed()',
  'error InvalidPrice()',
  'error NoPriceFeedSet()',
  'error ApprovalExceedsLimit()',
  'error SpenderNotAllowed()',
  'error NoParserRegistered(address target)',
  'error ExceedsAbsoluteMaxSpending(uint256 requested, uint256 maximum)',
  'error CannotRegisterUnknown()',
  'error LengthMismatch()',
  'error ExceedsMaxBps()',
  'error InvalidRecipient(address recipient, address expected)',
  'error CannotBeSubaccount(address account)',
  'error CannotBeOracle(address account)',
  'error CannotWhitelistCoreAddress(address account)',
  'error CannotRegisterParserForCoreAddress(address account)',
  'error Unauthorized()',
  'error InvalidAddress()',
  'error ModuleTransactionFailed()',
  'error UnsupportedSelector()',
  'error Panic(uint256 code)',
])

// Non-payable functions that have payable counterparts
const NON_PAYABLE_WITH_VALUE_COUNTERPART: Record<string, string> = {
  executeOnProtocol: 'executeOnProtocolWithValue',
}

// DeFiInteractor function signatures for decoding
const MODULE_ABI = parseAbi([
  'function executeOnProtocol(address target, bytes calldata data) external returns (bytes memory)',
  'function executeOnProtocolWithValue(address target, bytes calldata data) external payable returns (bytes memory)',
  'function transferToken(address token, address recipient, uint256 amount) external returns (bool)',
  'function updateSafeValue(uint256 totalValueUSD) external',
  'function updateSpendingAllowance(address subAccount, uint256 newAllowance) external',
  'function updateAcquiredBalance(address subAccount, address token, uint256 newBalance) external',
  'function batchUpdate(address subAccount, uint256 newAllowance, address[] calldata tokens, uint256[] calldata balances) external',
  'function grantRole(address member, uint16 roleId) external',
  'function revokeRole(address member, uint16 roleId) external',
  'function registerSelector(bytes4 selector, uint8 opType) external',
  'function unregisterSelector(bytes4 selector) external',
  'function registerParser(address protocol, address parser) external',
  'function setSubAccountLimits(address subAccount, uint256 maxSpendingBps, uint256 windowDuration) external',
  'function setAllowedAddresses(address subAccount, address[] calldata targets, bool allowed) external',
  'function setTokenPriceFeed(address token, address priceFeed) external',
  'function setTokenPriceFeeds(address[] calldata tokens, address[] calldata priceFeeds) external',
  'function setAuthorizedOracle(address newOracle) external',
  'function setAbsoluteMaxSpendingBps(uint256 newMaxBps) external',
  'function pause() external',
  'function unpause() external',
])

// Inner call ABIs for full decoding
const INNER_CALL_ABI = parseAbi([
  // ERC20
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  // Aave V3
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)',
  'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)',
  // Uniswap V3
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) returns (uint256)',
  'function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum)) returns (uint256)',
  'function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96)) returns (uint256)',
])

// Module view functions ABI
const MODULE_VIEW_ABI = parseAbi([
  'function getSpendingAllowance(address subAccount) external view returns (uint256)',
  'function getAcquiredBalance(address subAccount, address token) external view returns (uint256)',
  'function lastOracleUpdate(address) external view returns (uint256)',
  'function maxOracleAge() external view returns (uint256)',
  'function allowedAddresses(address subAccount, address target) external view returns (bool)',
  'function hasRole(address member, uint16 roleId) external view returns (bool)',
  'function authorizedOracle() external view returns (address)',
  'function avatar() external view returns (address)',
  'function safeValue() external view returns (uint256 totalValueUSD, uint256 lastUpdated, uint256 updateCount)',
  'function tokenPriceFeeds(address token) external view returns (address)',
])

// Chainlink price feed ABI
const PRICE_FEED_ABI = parseAbi([
  'function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() external view returns (uint8)',
])

// ERC20 ABI
const ERC20_ABI = parseAbi([
  'function symbol() external view returns (string)',
  'function decimals() external view returns (uint8)',
  'function balanceOf(address account) external view returns (uint256)',
])

// ============ Interfaces ============
interface DecodedInnerCall {
  selector: string
  functionName: string
  args: Record<string, unknown>
  formattedArgs: string[]
}

interface AnalysisResult {
  txHash: string
  status: 'failed' | 'success' | 'pending'
  from: Address
  to: Address
  value: string
  gasUsed: string
  timestamp: Date
  blockNumber: number
  decodedFunction?: {
    name: string
    args: Record<string, unknown>
  }
  innerCall?: {
    target: Address
    targetName?: string
    selector: string
    decoded?: DecodedInnerCall
  }
  error?: {
    name: string
    args?: Record<string, unknown>
    description: string
    solution: string
    rawData?: string
    underlyingError?: {
      name: string
      description: string
    }
  }
  simulationError?: string
  context?: Record<string, string>
}

interface TxData {
  from: Address
  to: Address
  value: string
  input: Hex
  blockNumber: number
  hash: string
}

// ============ Client Setup ============
function getClient(): PublicClient {
  const rpcUrl = process.env.RPC_URL || 'https://testnet-rpc.monad.xyz'
  return createPublicClient({
    chain: monadTestnet,
    transport: http(rpcUrl),
  })
}

// ============ Token Symbol Resolution ============
async function getTokenSymbol(client: PublicClient, tokenAddress: Address): Promise<string> {
  const lower = tokenAddress.toLowerCase()

  // Check cache first
  if (tokenSymbolCache.has(lower)) {
    return tokenSymbolCache.get(lower)!
  }

  // Check known tokens
  if (KNOWN_TOKENS[lower]) {
    tokenSymbolCache.set(lower, KNOWN_TOKENS[lower].symbol)
    return KNOWN_TOKENS[lower].symbol
  }

  // Fetch from chain
  try {
    const symbol = await client.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'symbol',
    })
    tokenSymbolCache.set(lower, symbol)
    return symbol
  } catch {
    // Return shortened address if symbol fetch fails
    return `${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}`
  }
}

async function getTokenDecimals(client: PublicClient, tokenAddress: Address): Promise<number> {
  const lower = tokenAddress.toLowerCase()

  if (tokenDecimalsCache.has(lower)) {
    return tokenDecimalsCache.get(lower)!
  }

  if (KNOWN_TOKENS[lower]) {
    tokenDecimalsCache.set(lower, KNOWN_TOKENS[lower].decimals)
    return KNOWN_TOKENS[lower].decimals
  }

  try {
    const decimals = await client.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'decimals',
    })
    tokenDecimalsCache.set(lower, decimals)
    return decimals
  } catch {
    return 18 // Default to 18
  }
}

function getProtocolName(address: Address): string | undefined {
  return KNOWN_PROTOCOLS[address.toLowerCase()]
}

// ============ Amount Formatting ============
function formatAmount(amount: bigint, decimals: number, symbol: string): string {
  // Check for max uint256 (unlimited approval)
  const MAX_UINT256 = 2n ** 256n - 1n
  if (amount === MAX_UINT256) {
    return `MAX (unlimited ${symbol})`
  }

  const formatted = formatUnits(amount, decimals)
  // Show full precision for small amounts, truncate large ones
  const num = parseFloat(formatted)
  if (num > 1000000) {
    return `${(num / 1000000).toFixed(2)}M ${symbol}`
  } else if (num > 1000) {
    return `${(num / 1000).toFixed(2)}K ${symbol}`
  } else if (num < 0.0001 && num > 0) {
    return `${formatted} ${symbol}`
  }
  return `${num.toFixed(6).replace(/\.?0+$/, '')} ${symbol}`
}

// ============ Inner Call Decoding ============
async function decodeInnerCall(
  client: PublicClient,
  target: Address,
  data: Hex
): Promise<DecodedInnerCall | null> {
  const selector = data.slice(0, 10).toLowerCase()

  try {
    const decoded = decodeFunctionData({
      abi: INNER_CALL_ABI,
      data,
    })

    const args: Record<string, unknown> = {}
    const formattedArgs: string[] = []

    // Handle different function types
    switch (decoded.functionName) {
      case 'approve': {
        const [spender, amount] = decoded.args as [Address, bigint]
        const symbol = await getTokenSymbol(client, target)
        const decimals = await getTokenDecimals(client, target)
        const spenderName = getProtocolName(spender) || spender

        args.spender = spender
        args.amount = amount
        formattedArgs.push(`spender: ${spenderName}`)
        formattedArgs.push(`amount: ${formatAmount(amount, decimals, symbol)}`)
        break
      }

      case 'transfer': {
        const [to, amount] = decoded.args as [Address, bigint]
        const symbol = await getTokenSymbol(client, target)
        const decimals = await getTokenDecimals(client, target)

        args.to = to
        args.amount = amount
        formattedArgs.push(`to: ${to}`)
        formattedArgs.push(`amount: ${formatAmount(amount, decimals, symbol)}`)
        break
      }

      case 'supply': {
        const [asset, amount, onBehalfOf, referralCode] = decoded.args as [Address, bigint, Address, number]
        const symbol = await getTokenSymbol(client, asset)
        const decimals = await getTokenDecimals(client, asset)

        args.asset = asset
        args.amount = amount
        args.onBehalfOf = onBehalfOf
        args.referralCode = referralCode
        formattedArgs.push(`asset: ${symbol} (${asset})`)
        formattedArgs.push(`amount: ${formatAmount(amount, decimals, symbol)}`)
        formattedArgs.push(`onBehalfOf: ${onBehalfOf}`)
        break
      }

      case 'withdraw': {
        const [asset, amount, to] = decoded.args as [Address, bigint, Address]
        const symbol = await getTokenSymbol(client, asset)
        const decimals = await getTokenDecimals(client, asset)

        args.asset = asset
        args.amount = amount
        args.to = to
        formattedArgs.push(`asset: ${symbol} (${asset})`)
        formattedArgs.push(`amount: ${formatAmount(amount, decimals, symbol)}`)
        formattedArgs.push(`to: ${to}`)
        break
      }

      case 'repay': {
        const [asset, amount, interestRateMode, onBehalfOf] = decoded.args as [Address, bigint, bigint, Address]
        const symbol = await getTokenSymbol(client, asset)
        const decimals = await getTokenDecimals(client, asset)
        const rateMode = interestRateMode === 1n ? 'Stable' : 'Variable'

        args.asset = asset
        args.amount = amount
        args.interestRateMode = interestRateMode
        args.onBehalfOf = onBehalfOf
        formattedArgs.push(`asset: ${symbol} (${asset})`)
        formattedArgs.push(`amount: ${formatAmount(amount, decimals, symbol)}`)
        formattedArgs.push(`rateMode: ${rateMode}`)
        formattedArgs.push(`onBehalfOf: ${onBehalfOf}`)
        break
      }

      case 'exactInputSingle': {
        const [params] = decoded.args as [{ tokenIn: Address; tokenOut: Address; fee: number; recipient: Address; amountIn: bigint; amountOutMinimum: bigint }]
        const symbolIn = await getTokenSymbol(client, params.tokenIn)
        const symbolOut = await getTokenSymbol(client, params.tokenOut)
        const decimalsIn = await getTokenDecimals(client, params.tokenIn)
        const decimalsOut = await getTokenDecimals(client, params.tokenOut)

        args.params = params
        formattedArgs.push(`tokenIn: ${symbolIn} (${params.tokenIn})`)
        formattedArgs.push(`tokenOut: ${symbolOut} (${params.tokenOut})`)
        formattedArgs.push(`fee: ${params.fee / 10000}%`)
        formattedArgs.push(`amountIn: ${formatAmount(params.amountIn, decimalsIn, symbolIn)}`)
        formattedArgs.push(`minOut: ${formatAmount(params.amountOutMinimum, decimalsOut, symbolOut)}`)
        formattedArgs.push(`recipient: ${params.recipient}`)
        break
      }

      default: {
        // Generic handling for unknown functions
        if (decoded.args) {
          decoded.args.forEach((arg, i) => {
            args[`arg${i}`] = arg
            formattedArgs.push(`arg${i}: ${String(arg)}`)
          })
        }
      }
    }

    return {
      selector,
      functionName: decoded.functionName,
      args,
      formattedArgs,
    }
  } catch {
    // If decoding fails, try to show raw data
    return null
  }
}

// ============ Transaction Fetching ============
async function fetchTransaction(txHash: Hex): Promise<TxData | null> {
  const client = getClient()

  try {
    const tx = await client.getTransaction({ hash: txHash })
    if (!tx) return null

    return {
      from: tx.from,
      to: tx.to as Address,
      value: tx.value.toString(),
      input: tx.input,
      blockNumber: Number(tx.blockNumber),
      hash: tx.hash,
    }
  } catch (error) {
    console.error('Error fetching transaction:', error)
    return null
  }
}

async function fetchTxReceipt(txHash: Hex): Promise<{ status: 'success' | 'reverted'; gasUsed: string } | null> {
  const client = getClient()

  try {
    const receipt = await client.getTransactionReceipt({ hash: txHash })
    if (!receipt) return null

    return {
      status: receipt.status,
      gasUsed: receipt.gasUsed.toString(),
    }
  } catch (error) {
    console.error('Error fetching receipt:', error)
    return null
  }
}

async function getBlockTimestamp(blockNumber: number): Promise<Date | null> {
  const client = getClient()

  try {
    const block = await client.getBlock({ blockNumber: BigInt(blockNumber) })
    if (block?.timestamp) {
      return new Date(Number(block.timestamp) * 1000)
    }
    return null
  } catch {
    return null
  }
}

// ============ Function Decoding ============
function decodeModuleFunction(input: Hex): { name: string; args: Record<string, unknown> } | null {
  try {
    const decoded = decodeFunctionData({
      abi: MODULE_ABI,
      data: input,
    })

    const args: Record<string, unknown> = {}
    if (decoded.args) {
      decoded.args.forEach((arg, i) => {
        args[`arg${i}`] = arg
      })
    }

    return {
      name: decoded.functionName,
      args,
    }
  } catch {
    return null
  }
}

function decodeContractError(errorData: Hex): { name: string; args?: Record<string, unknown> } | null {
  try {
    const decoded = decodeErrorResult({
      abi: ERROR_ABI,
      data: errorData,
    })

    const args: Record<string, unknown> = {}
    if (decoded.args && decoded.args.length > 0) {
      decoded.args.forEach((arg, i) => {
        args[`arg${i}`] = arg
      })
    }

    return {
      name: decoded.errorName,
      args: Object.keys(args).length > 0 ? args : undefined,
    }
  } catch {
    // Try to extract error selector for unknown errors
    if (errorData.length >= 10) {
      const selector = errorData.slice(0, 10)
      return {
        name: `UnknownError(${selector})`,
        args: { rawData: errorData },
      }
    }
    return null
  }
}

// ============ Tenderly Trace Fetching ============
async function fetchTenderlyTrace(
  txHash: string,
  chainId: number = 10143 // Monad testnet
): Promise<{ errorData?: Hex; error?: string } | null> {
  try {
    const response = await fetch(
      `https://api.tenderly.co/api/v1/public-contract/${chainId}/trace/${txHash}`
    )

    if (!response.ok) {
      return null
    }

    const data = await response.json()

    if (data.call_trace?.error_hex_data) {
      return {
        errorData: data.call_trace.error_hex_data as Hex,
        error: data.call_trace.error,
      }
    }

    return null
  } catch {
    return null
  }
}

// ============ Simulation with Trace Support ============
async function simulateWithTrace(
  client: PublicClient,
  tx: {
    from: Address
    to: Address
    data: Hex
    value: bigint
    blockNumber: bigint
  }
): Promise<{ success: boolean; error?: string; errorData?: Hex; traceError?: string }> {
  // First try debug_traceCall if available
  try {
    const rpcUrl = process.env.RPC_URL || 'https://testnet-rpc.monad.xyz'

    const traceResponse = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'debug_traceCall',
        params: [
          {
            from: tx.from,
            to: tx.to,
            data: tx.data,
            value: `0x${tx.value.toString(16)}`,
          },
          `0x${(tx.blockNumber - 1n).toString(16)}`,
          { tracer: 'callTracer', tracerConfig: { withLog: true } },
        ],
      }),
    })

    const traceResult = await traceResponse.json()

    if (traceResult.result) {
      const trace = traceResult.result

      // Check if the call reverted
      if (trace.error || trace.revertReason) {
        // Extract error from trace
        let errorData: Hex | undefined
        let traceError: string | undefined

        if (trace.output && trace.output.startsWith('0x')) {
          errorData = trace.output as Hex
        }

        if (trace.revertReason) {
          traceError = trace.revertReason
        }

        // Look for nested call errors (for TransactionFailed)
        if (trace.calls && Array.isArray(trace.calls)) {
          for (const call of trace.calls) {
            if (call.error && call.output) {
              // Found the inner error
              traceError = `Inner call to ${call.to} failed: ${call.error}`
              if (call.output.startsWith('0x') && call.output.length > 2) {
                errorData = call.output as Hex
              }
              break
            }
          }
        }

        return {
          success: false,
          error: trace.error || 'Transaction reverted',
          errorData,
          traceError,
        }
      }

      return { success: true }
    }
  } catch {
    // debug_traceCall not available, fall back to eth_call
  }

  // Fallback to regular eth_call simulation
  try {
    await client.call({
      account: tx.from,
      to: tx.to,
      data: tx.data,
      value: tx.value,
      blockNumber: tx.blockNumber - 1n,
    })
    return { success: true }
  } catch (error: unknown) {
    const extractErrorData = (obj: unknown): Hex | undefined => {
      if (!obj || typeof obj !== 'object') return undefined
      const o = obj as Record<string, unknown>

      // Direct data field
      if (typeof o.data === 'string' && o.data.startsWith('0x') && o.data.length >= 10) {
        return o.data as Hex
      }
      // Some RPCs use errorData
      if (typeof o.errorData === 'string' && o.errorData.startsWith('0x')) {
        return o.errorData as Hex
      }
      // Viem wraps errors in cause
      if (o.cause && typeof o.cause === 'object') {
        const causeData = extractErrorData(o.cause)
        if (causeData) return causeData
      }
      // Some errors nest in error field
      if (o.error && typeof o.error === 'object') {
        const errData = extractErrorData(o.error)
        if (errData) return errData
      }
      // Extract from message string
      if (typeof o.message === 'string') {
        // Match: data: "0x..." or data: 0x...
        const match = o.message.match(/data:\s*"?(0x[a-fA-F0-9]+)"?/)
        if (match) return match[1] as Hex
      }
      // Extract from details string
      if (typeof o.details === 'string') {
        const match = o.details.match(/(0x[a-fA-F0-9]{8,})/)
        if (match) return match[1] as Hex
      }
      // Viem sometimes puts it in metaMessages
      if (Array.isArray(o.metaMessages)) {
        for (const msg of o.metaMessages) {
          if (typeof msg === 'string') {
            const match = msg.match(/(0x[a-fA-F0-9]{8,})/)
            if (match) return match[1] as Hex
          }
        }
      }
      return undefined
    }

    const err = error as { message?: string; shortMessage?: string }
    const errorData = extractErrorData(error)

    return {
      success: false,
      error: err.shortMessage || err.message || 'Unknown simulation error',
      errorData,
    }
  }
}

// ============ Rich Context Lookup ============
async function lookupRichContext(
  client: PublicClient,
  result: AnalysisResult,
  moduleAddress: Address,
  blockNumber: bigint
): Promise<Record<string, string>> {
  const context: Record<string, string> = {}

  try {
    // Get Safe (avatar) address
    const avatar = await client.readContract({
      address: moduleAddress,
      abi: MODULE_VIEW_ABI,
      functionName: 'avatar',
      blockNumber,
    })
    context['Safe Address'] = avatar

    // Get spending allowance
    const allowance = await client.readContract({
      address: moduleAddress,
      abi: MODULE_VIEW_ABI,
      functionName: 'getSpendingAllowance',
      args: [result.from],
      blockNumber,
    })
    context['Spending Allowance'] = `${formatUnits(allowance, 18)} USD`

    // Get last oracle update
    const lastUpdate = await client.readContract({
      address: moduleAddress,
      abi: MODULE_VIEW_ABI,
      functionName: 'lastOracleUpdate',
      args: [result.from],
      blockNumber,
    })
    if (lastUpdate > 0n) {
      context['Last Oracle Update'] = new Date(Number(lastUpdate) * 1000).toISOString()
    } else {
      context['Last Oracle Update'] = 'Never'
    }

    // Error-specific context
    if (result.error?.name === 'ApprovalExceedsLimit' || result.error?.name === 'ExceedsSpendingLimit') {
      // Get token info if we have an inner call
      if (result.innerCall?.decoded?.args) {
        const tokenAddress = result.innerCall.target
        const symbol = await getTokenSymbol(client, tokenAddress)
        const decimals = await getTokenDecimals(client, tokenAddress)

        // For ApprovalExceedsLimit, show spender info and whitelist status
        if (result.error?.name === 'ApprovalExceedsLimit' && result.innerCall.decoded.args.spender) {
          const spender = result.innerCall.decoded.args.spender as Address
          const spenderName = getProtocolName(spender) || `${spender.slice(0, 10)}...${spender.slice(-8)}`
          context['Spender'] = `${spenderName} (${spender})`

          // Check if spender is whitelisted
          try {
            const isAllowed = await client.readContract({
              address: moduleAddress,
              abi: MODULE_VIEW_ABI,
              functionName: 'allowedAddresses',
              args: [result.from, spender],
              blockNumber,
            })
            context['Spender Whitelisted'] = isAllowed ? 'Yes' : 'No (could also be SpenderNotAllowed)'
          } catch {
            // Whitelist check failed
          }
        }

        // Get acquired balance for this token
        const acquired = await client.readContract({
          address: moduleAddress,
          abi: MODULE_VIEW_ABI,
          functionName: 'getAcquiredBalance',
          args: [result.from, tokenAddress],
          blockNumber,
        })
        context[`Acquired ${symbol}`] = formatAmount(acquired, decimals, symbol)

        // Get Safe's token balance
        const balance = await client.readContract({
          address: tokenAddress,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [avatar],
          blockNumber,
        })
        context[`Safe ${symbol} Balance`] = formatAmount(balance, decimals, symbol)

        // Show the approval amount being requested
        if (result.innerCall.decoded.args.amount) {
          const amount = result.innerCall.decoded.args.amount as bigint
          context['Approval Amount'] = formatAmount(amount, decimals, symbol)
        }

        // Try to get token price
        try {
          const priceFeed = await client.readContract({
            address: moduleAddress,
            abi: MODULE_VIEW_ABI,
            functionName: 'tokenPriceFeeds',
            args: [tokenAddress],
            blockNumber,
          })

          if (priceFeed !== '0x0000000000000000000000000000000000000000') {
            const [, answer, , ,] = await client.readContract({
              address: priceFeed,
              abi: PRICE_FEED_ABI,
              functionName: 'latestRoundData',
              blockNumber,
            })
            const priceDecimals = await client.readContract({
              address: priceFeed,
              abi: PRICE_FEED_ABI,
              functionName: 'decimals',
              blockNumber,
            })
            context[`${symbol} Price`] = `$${formatUnits(answer, priceDecimals)}`

            // Calculate USD value of operation
            if (result.innerCall.decoded.args.amount) {
              const amount = result.innerCall.decoded.args.amount as bigint
              const MAX_UINT256 = 2n ** 256n - 1n
              if (amount !== MAX_UINT256) {
                const originalAmount = amount > acquired ? amount - acquired : 0n
                const usdValue = (originalAmount * answer) / (10n ** BigInt(decimals))
                context['USD Value (from original)'] = `$${formatUnits(usdValue, priceDecimals)}`
              }
            }
          }
        } catch {
          // Price feed not available
        }
      }
    }

    if (result.error?.name === 'SpenderNotAllowed' && result.innerCall?.decoded?.args?.spender) {
      const spender = result.innerCall.decoded.args.spender as Address
      const isAllowed = await client.readContract({
        address: moduleAddress,
        abi: MODULE_VIEW_ABI,
        functionName: 'allowedAddresses',
        args: [result.from, spender],
        blockNumber,
      })
      context[`Spender ${spender.slice(0, 10)}... Allowed`] = isAllowed ? 'Yes' : 'No'
    }

    if (result.error?.name === 'AddressNotAllowed' && result.innerCall) {
      const isAllowed = await client.readContract({
        address: moduleAddress,
        abi: MODULE_VIEW_ABI,
        functionName: 'allowedAddresses',
        args: [result.from, result.innerCall.target],
        blockNumber,
      })
      context['Target Allowed'] = isAllowed ? 'Yes' : 'No'
    }

    if (result.error?.name === 'Unauthorized') {
      const hasExecuteRole = await client.readContract({
        address: moduleAddress,
        abi: MODULE_VIEW_ABI,
        functionName: 'hasRole',
        args: [result.from, 1],
        blockNumber,
      })
      const hasTransferRole = await client.readContract({
        address: moduleAddress,
        abi: MODULE_VIEW_ABI,
        functionName: 'hasRole',
        args: [result.from, 2],
        blockNumber,
      })
      context['Has DEFI_EXECUTE_ROLE'] = hasExecuteRole ? 'Yes' : 'No'
      context['Has DEFI_TRANSFER_ROLE'] = hasTransferRole ? 'Yes' : 'No'
    }

    if (result.error?.name === 'StaleOracleData') {
      const maxAge = await client.readContract({
        address: moduleAddress,
        abi: MODULE_VIEW_ABI,
        functionName: 'maxOracleAge',
        blockNumber,
      })
      context['Max Oracle Age'] = `${maxAge} seconds (${Number(maxAge) / 3600} hours)`
    }

  } catch (error) {
    context['Context Error'] = 'Could not fetch some context data'
  }

  return context
}

// ============ TransactionFailed Deep Analysis ============
async function analyzeTransactionFailed(
  client: PublicClient,
  result: AnalysisResult,
  moduleAddress: Address,
  originalTx: TxData
): Promise<{ underlyingError?: string; description?: string }> {
  // TransactionFailed means the Safe's execTransactionFromModule failed
  // We need to simulate the inner call directly to find the actual error

  if (!result.innerCall) {
    return {}
  }

  try {
    // Get the Safe (avatar) address
    const avatar = await client.readContract({
      address: moduleAddress,
      abi: MODULE_VIEW_ABI,
      functionName: 'avatar',
      blockNumber: BigInt(originalTx.blockNumber) - 1n,
    })

    // Simulate the inner call as if from the Safe
    const innerData = (result.decodedFunction?.args?.arg1 as Hex) || '0x'

    try {
      await client.call({
        account: avatar,
        to: result.innerCall.target,
        data: innerData,
        blockNumber: BigInt(originalTx.blockNumber) - 1n,
      })
    } catch (innerError: unknown) {
      const extractErrorData = (obj: unknown): Hex | undefined => {
        if (!obj || typeof obj !== 'object') return undefined
        const o = obj as Record<string, unknown>
        if (typeof o.data === 'string' && o.data.startsWith('0x')) return o.data as Hex
        if (o.cause) return extractErrorData(o.cause)
        if (o.error) return extractErrorData(o.error)
        if (typeof o.details === 'string') {
          const match = o.details.match(/(0x[a-fA-F0-9]{8,})/)
          if (match) return match[1] as Hex
        }
        return undefined
      }

      const errorData = extractErrorData(innerError)
      const err = innerError as { message?: string; shortMessage?: string }

      if (errorData) {
        // Try to decode the underlying error
        const decoded = decodeContractError(errorData)
        if (decoded) {
          return {
            underlyingError: decoded.name,
            description: CONTRACT_ERRORS[decoded.name]?.description || err.shortMessage || err.message,
          }
        }
      }

      // Check for common revert strings
      const errMsg = err.message || ''
      if (errMsg.includes('insufficient')) {
        return {
          underlyingError: 'Insufficient Balance/Allowance',
          description: 'The Safe does not have enough tokens or allowance for this operation',
        }
      }

      return {
        underlyingError: 'Protocol Error',
        description: err.shortMessage || err.message || 'Unknown protocol error',
      }
    }
  } catch {
    return {}
  }

  return {}
}

// ============ Main Analysis Function ============
async function analyzeFailedTx(txHash: string): Promise<AnalysisResult> {
  const client = getClient()

  console.log(`\n${'═'.repeat(70)}`)
  console.log(`  TRANSACTION ANALYSIS: ${txHash.slice(0, 10)}...${txHash.slice(-8)}`)
  console.log(`${'═'.repeat(70)}`)

  // Initialize result
  const result: AnalysisResult = {
    txHash,
    status: 'pending',
    from: '0x0' as Address,
    to: '0x0' as Address,
    value: '0',
    gasUsed: '0',
    timestamp: new Date(),
    blockNumber: 0,
  }

  // Fetch transaction
  console.log('\n┌─ 1. TRANSACTION DATA ─────────────────────────────────────────────┐')
  const tx = await fetchTransaction(txHash as Hex)

  if (!tx) {
    console.error('│  ✗ Failed to fetch transaction')
    throw new Error('Transaction not found')
  }

  result.from = tx.from
  result.to = tx.to
  result.value = formatEther(BigInt(tx.value))
  result.blockNumber = tx.blockNumber

  console.log(`│  From:   ${result.from}`)
  console.log(`│  To:     ${result.to}`)
  console.log(`│  Value:  ${result.value} ETH`)
  console.log(`│  Block:  ${result.blockNumber}`)

  // Fetch receipt
  const receipt = await fetchTxReceipt(txHash as Hex)
  if (receipt) {
    result.status = receipt.status === 'success' ? 'success' : 'failed'
    result.gasUsed = receipt.gasUsed
    console.log(`│  Status: ${result.status === 'failed' ? '✗ FAILED' : '✓ SUCCESS'}`)
    console.log(`│  Gas:    ${parseInt(result.gasUsed).toLocaleString()}`)
  }

  // Get timestamp
  const timestamp = await getBlockTimestamp(tx.blockNumber)
  if (timestamp) {
    result.timestamp = timestamp
    console.log(`│  Time:   ${timestamp.toISOString()}`)
  }
  console.log('└───────────────────────────────────────────────────────────────────┘')

  // Decode function call
  console.log('\n┌─ 2. CALLDATA DECODING ────────────────────────────────────────────┐')
  const input = tx.input
  const decoded = decodeModuleFunction(input)

  if (decoded) {
    result.decodedFunction = decoded
    console.log(`│  Function: ${decoded.name}`)

    // For executeOnProtocol, decode the inner call
    if (decoded.name === 'executeOnProtocol' || decoded.name === 'executeOnProtocolWithValue') {
      const target = decoded.args.arg0 as Address
      const data = decoded.args.arg1 as Hex
      const selector = data.slice(0, 10)
      const protocolName = getProtocolName(target)
      const targetSymbol = await getTokenSymbol(client, target)

      result.innerCall = {
        target,
        targetName: protocolName || targetSymbol,
        selector,
      }

      console.log('│')
      console.log(`│  ┌─ Inner Call ─────────────────────────────────────────────────┐`)
      console.log(`│  │  Target: ${protocolName || targetSymbol} (${target})`)
      console.log(`│  │  Selector: ${selector}`)

      // Decode inner call arguments
      const decodedInner = await decodeInnerCall(client, target, data)
      if (decodedInner) {
        result.innerCall.decoded = decodedInner
        console.log(`│  │  Function: ${decodedInner.functionName}`)
        console.log(`│  │`)
        decodedInner.formattedArgs.forEach((arg) => {
          console.log(`│  │  ${arg}`)
        })
      }
      console.log(`│  └────────────────────────────────────────────────────────────────┘`)
    }
  } else {
    console.log(`│  Raw selector: ${input.slice(0, 10)}`)
  }
  console.log('└───────────────────────────────────────────────────────────────────┘')

  // Check for non-payable function called with ETH value
  const txValue = BigInt(tx.value)
  if (decoded && txValue > 0n && NON_PAYABLE_WITH_VALUE_COUNTERPART[decoded.name]) {
    const correctFunction = NON_PAYABLE_WITH_VALUE_COUNTERPART[decoded.name]
    const errorInfo = CONTRACT_ERRORS['NonPayableFunctionWithValue']

    result.error = {
      name: 'NonPayableFunctionWithValue',
      args: {
        calledFunction: decoded.name,
        correctFunction: correctFunction,
        ethValue: formatEther(txValue),
      },
      description: `${errorInfo.description}. Called '${decoded.name}' with ${formatEther(txValue)} ETH, but this function is not payable.`,
      solution: `Use '${correctFunction}' instead of '${decoded.name}' when sending ETH value.`,
    }

    console.log('\n┌─ 3. ERROR DETECTED (Pre-simulation) ─────────────────────────────┐')
    console.log(`│  ⚠ NON-PAYABLE FUNCTION CALLED WITH ETH VALUE`)
    console.log(`│`)
    console.log(`│  Called:    ${decoded.name}`)
    console.log(`│  ETH Value: ${formatEther(txValue)} ETH`)
    console.log(`│  Problem:   This function does not accept ETH (not payable)`)
    console.log(`│`)
    console.log(`│  Solution:  Use '${correctFunction}' instead`)
    console.log('└───────────────────────────────────────────────────────────────────┘')

    // Skip simulation since we already know the error
    console.log(`\n${'═'.repeat(70)}`)
    console.log('  Analysis complete')
    console.log(`${'═'.repeat(70)}\n`)

    return result
  }

  // If transaction failed, simulate to get error
  if (result.status === 'failed') {
    console.log('\n┌─ 3. ERROR SIMULATION ─────────────────────────────────────────────┐')

    const simResult = await simulateWithTrace(client, {
      from: result.from,
      to: result.to,
      data: input,
      value: BigInt(tx.value),
      blockNumber: BigInt(result.blockNumber),
    })

    if (!simResult.success) {
      result.simulationError = simResult.error

      if (simResult.errorData) {
        // Check if the "error data" is actually the calldata being echoed back
        // This happens when RPCs don't have archive state for historical blocks
        const inputSelector = input.slice(0, 10).toLowerCase()
        const errorSelector = simResult.errorData.slice(0, 10).toLowerCase()
        const isEchoedCalldata = inputSelector === errorSelector && simResult.errorData.length > 100

        if (isEchoedCalldata) {
          console.log(`│  Note: RPC lacks archive state for block ${result.blockNumber}`)

          // Try Tenderly's public API for actual error data
          console.log(`│  Fetching trace from Tenderly...`)
          const tenderlyTrace = await fetchTenderlyTrace(txHash)

          if (tenderlyTrace?.errorData) {
            console.log(`│  ✓ Got error from Tenderly: ${tenderlyTrace.errorData}`)

            const decodedError = decodeContractError(tenderlyTrace.errorData)
            if (decodedError) {
              const errorInfo = CONTRACT_ERRORS[decodedError.name]

              result.error = {
                name: decodedError.name,
                args: decodedError.args,
                description: errorInfo?.description || 'Unknown error',
                solution: errorInfo?.solution || 'Check contract source for error details',
                rawData: tenderlyTrace.errorData,
              }
            }
          } else {
            console.log(`│  Could not fetch trace from Tenderly`)

            // Fall back to inferring from call type
            if (result.innerCall?.decoded?.functionName === 'approve') {
              console.log(`│`)
              console.log(`│  ⚠ Detected failed approve() call - likely errors:`)
              console.log(`│    • ApprovalExceedsLimit - approval amount exceeds spending allowance`)
              console.log(`│    • SpenderNotAllowed - spender address not whitelisted`)

              // Set a likely error for context lookup
              result.error = {
                name: 'ApprovalExceedsLimit',
                description: CONTRACT_ERRORS['ApprovalExceedsLimit'].description,
                solution: CONTRACT_ERRORS['ApprovalExceedsLimit'].solution,
                rawData: simResult.errorData,
              }
            }
          }
        } else {
          console.log(`│  Error data: ${simResult.errorData}`)

          const decodedError = decodeContractError(simResult.errorData)
          if (decodedError) {
            const errorInfo = CONTRACT_ERRORS[decodedError.name]

            result.error = {
              name: decodedError.name,
              args: decodedError.args,
              description: errorInfo?.description || 'Unknown error',
              solution: errorInfo?.solution || 'Check contract source for error details',
              rawData: simResult.errorData,
            }
          }
        }
      }

      if (simResult.traceError) {
        console.log(`│  Trace info: ${simResult.traceError}`)
      }
    }
    console.log('└───────────────────────────────────────────────────────────────────┘')

    // Error analysis
    console.log('\n┌─ 4. ERROR ANALYSIS ───────────────────────────────────────────────┐')

    if (result.error) {
      console.log(`│  Error: ${result.error.name}`)

      if (result.error.args) {
        Object.entries(result.error.args).forEach(([key, value]) => {
          console.log(`│  ${key}: ${value}`)
        })
      }

      console.log('│')
      console.log(`│  Description:`)
      console.log(`│    ${result.error.description}`)
      console.log('│')
      console.log(`│  Solution:`)
      console.log(`│    ${result.error.solution}`)

      // Handle TransactionFailed specially
      if (result.error.name === 'TransactionFailed') {
        const moduleAddress = process.env.MODULE_ADDRESS as Address
        if (moduleAddress) {
          console.log('│')
          console.log('│  ┌─ Underlying Protocol Error ─────────────────────────────────┐')
          const underlying = await analyzeTransactionFailed(client, result, moduleAddress, tx)
          if (underlying.underlyingError) {
            result.error.underlyingError = {
              name: underlying.underlyingError,
              description: underlying.description || '',
            }
            console.log(`│  │  Error: ${underlying.underlyingError}`)
            console.log(`│  │  ${underlying.description}`)
          } else {
            console.log('│  │  Could not determine underlying error')
          }
          console.log('│  └────────────────────────────────────────────────────────────────┘')
        }
      }
    } else {
      console.log('│  Could not decode error. Possible causes:')
      console.log('│  - The error may be from the underlying protocol')
      console.log('│  - Out of gas')
      console.log('│  - State has changed since the original transaction')
      if (result.simulationError) {
        console.log('│')
        console.log(`│  Raw error: ${result.simulationError}`)
      }
    }
    console.log('└───────────────────────────────────────────────────────────────────┘')

    // Rich context lookup
    const moduleAddress = process.env.MODULE_ADDRESS as Address
    if (moduleAddress) {
      // Try historical state first, fall back to current state if unavailable
      let context = await lookupRichContext(
        client,
        result,
        moduleAddress,
        BigInt(tx.blockNumber) - 1n
      )

      let usingCurrentState = false
      if (context['Context Error']) {
        // Historical state unavailable, try current state
        console.log('\n┌─ 5. STATE CONTEXT (current - historical unavailable) ──────────┐')
        console.log('│  ⚠ Note: Showing CURRENT state, may differ from tx time')
        context = await lookupRichContext(
          client,
          result,
          moduleAddress,
          undefined as unknown as bigint // Use latest block
        )
        usingCurrentState = true
      } else {
        console.log('\n┌─ 5. STATE CONTEXT (at block before tx) ─────────────────────────┐')
      }

      result.context = context

      Object.entries(context).forEach(([key, value]) => {
        if (key !== 'Context Error' || !usingCurrentState) {
          console.log(`│  ${key}: ${value}`)
        }
      })
      console.log('└───────────────────────────────────────────────────────────────────┘')
    }
  } else if (result.status === 'success') {
    console.log('\n┌─ 3. RESULT ─────────────────────────────────────────────────────────┐')
    console.log('│  ✓ Transaction was successful - no error to analyze')
    console.log('└───────────────────────────────────────────────────────────────────┘')
  }

  console.log(`\n${'═'.repeat(70)}`)
  console.log('  Analysis complete')
  console.log(`${'═'.repeat(70)}\n`)

  return result
}

// ============ Main ============
async function main() {
  const txHash = process.argv[2]

  if (!txHash) {
    console.log('Usage: npx tsx src/analyze-failed-tx.ts <tx-hash>')
    console.log('')
    console.log('Environment variables:')
    console.log('  RPC_URL          - Sepolia RPC URL (default: public node)')
    console.log('  MODULE_ADDRESS   - DeFiInteractor address (for context lookup)')
    process.exit(1)
  }

  try {
    await analyzeFailedTx(txHash)
  } catch (error) {
    console.error('\nAnalysis failed:', error)
    process.exit(1)
  }
}

main()

export { analyzeFailedTx, CONTRACT_ERRORS, type AnalysisResult }
