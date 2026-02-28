/**
 * Local Spending Oracle
 *
 * Tracks spending and acquired balances for sub-accounts.
 * Uses Envio GraphQL indexer for event detection on Monad testnet
 * (replaces eth_getLogs which is limited to 100-1000 blocks on Monad).
 *
 * Features:
 * - Rolling 24h window tracking for spending
 * - Deposit/withdrawal matching for acquired status
 * - Envio-based event querying for reliable indexing
 * - Cron-based periodic refresh
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Log,
  formatUnits,
  keccak256,
  toHex,
  decodeAbiParameters,
  parseAbiItem,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import cron from 'node-cron'
import { GraphQLClient, gql } from 'graphql-request'
import { config, validateConfig, type TokenConfig } from './config.js'
import { DeFiInteractorABI, OperationType, ChainlinkPriceFeedABI, ERC20ABI, ModuleRegistryABI } from './abi.js'

// ============ Token Price Cache ============

export interface TokenPriceInfo {
  priceUSD: bigint      // Price in USD with 18 decimals
  decimals: number      // Token decimals
}

export type TokenPriceCache = Map<Address, TokenPriceInfo>

// ============ Types ============

export interface ProtocolExecutionEvent {
  subAccount: Address
  target: Address
  opType: OperationType
  tokensIn: Address[]     // Array of input tokens
  amountsIn: bigint[]     // Array of input amounts
  tokensOut: Address[]    // Array of output tokens
  amountsOut: bigint[]    // Array of output amounts
  spendingCost: bigint
  timestamp: bigint
  blockNumber: bigint
  logIndex: number
}

export interface TransferExecutedEvent {
  subAccount: Address
  token: Address
  recipient: Address
  amount: bigint
  spendingCost: bigint
  timestamp: bigint
  blockNumber: bigint
  logIndex: number
}

export interface DepositRecord {
  subAccount: Address
  target: Address
  tokenIn: Address
  amountIn: bigint
  remainingAmount: bigint  // Tracks how much of the deposit hasn't been withdrawn yet
  tokenOut: Address        // Output token received from deposit (e.g., aToken, LP token)
  amountOut: bigint        // Amount of output token received
  remainingOutputAmount: bigint  // Tracks how much output hasn't been consumed by withdrawal
  timestamp: bigint  // When the deposit happened
  originalAcquisitionTimestamp: bigint  // When the tokens were originally acquired (for FIFO inheritance)
}

/**
 * FIFO queue entry for acquired balances
 * Tracks the original acquisition timestamp so tokens expire together
 * when swapped (output inherits input's original timestamp)
 */
export interface AcquiredBalanceEntry {
  amount: bigint
  originalTimestamp: bigint  // When the tokens were originally acquired (for expiry calculation)
}

/**
 * FIFO queue for each token's acquired balance
 * Oldest entries are consumed first when spending
 */
export type AcquiredBalanceQueue = AcquiredBalanceEntry[]

export interface SubAccountState {
  spendingRecords: { amount: bigint; timestamp: bigint }[]
  depositRecords: DepositRecord[]
  totalSpendingInWindow: bigint
  // FIFO queues for acquired balances per token
  acquiredQueues: Map<Address, AcquiredBalanceQueue>
  // Final calculated acquired balances (sum of non-expired entries)
  acquiredBalances: Map<Address, bigint>
}

// ============ Event Signatures ============

const PROTOCOL_EXECUTION_EVENT = parseAbiItem(
  'event ProtocolExecution(address indexed subAccount, address indexed target, uint8 opType, address[] tokensIn, uint256[] amountsIn, address[] tokensOut, uint256[] amountsOut, uint256 spendingCost)'
)

const TRANSFER_EXECUTED_EVENT = parseAbiItem(
  'event TransferExecuted(address indexed subAccount, address indexed token, address indexed recipient, uint256 amount, uint256 spendingCost)'
)

const ACQUIRED_BALANCE_UPDATED_EVENT = parseAbiItem(
  'event AcquiredBalanceUpdated(address indexed subAccount, address indexed token, uint256 newBalance)'
)

// ============ Initialize Clients with RPC Fallback ============

/**
 * RPC client manager with automatic fallback support
 * Tracks health of each RPC endpoint and rotates on failures
 */
class RpcClientManager {
  private clients: ReturnType<typeof createPublicClient>[]
  private currentIndex = 0
  private failureCounts: number[] = []
  private readonly maxFailures = 3

  constructor(rpcUrls: string[]) {
    if (rpcUrls.length === 0) {
      throw new Error('At least one RPC URL is required')
    }

    this.clients = rpcUrls.map(url =>
      createPublicClient({
        chain: config.chain,
        transport: http(url),
      })
    )
    this.failureCounts = new Array(rpcUrls.length).fill(0)

    log(`Initialized RPC client manager with ${rpcUrls.length} endpoint(s)`)
  }

  /**
   * Get the current active client
   */
  get client(): ReturnType<typeof createPublicClient> {
    return this.clients[this.currentIndex]
  }

  /**
   * Report a failure and potentially rotate to next RPC
   */
  reportFailure(): void {
    this.failureCounts[this.currentIndex]++

    if (this.failureCounts[this.currentIndex] >= this.maxFailures) {
      const oldIndex = this.currentIndex
      this.rotateToNextHealthy()
      if (this.currentIndex !== oldIndex) {
        log(`RPC endpoint ${oldIndex} exceeded failure threshold, rotated to endpoint ${this.currentIndex}`)
      }
    }
  }

  /**
   * Report a success, reset failure count for current endpoint
   */
  reportSuccess(): void {
    this.failureCounts[this.currentIndex] = 0
  }

  /**
   * Rotate to the next healthy endpoint
   */
  private rotateToNextHealthy(): void {
    const startIndex = this.currentIndex

    for (let i = 1; i <= this.clients.length; i++) {
      const nextIndex = (startIndex + i) % this.clients.length
      if (this.failureCounts[nextIndex] < this.maxFailures) {
        this.currentIndex = nextIndex
        return
      }
    }

    // All endpoints are unhealthy, reset counts and use first
    log('All RPC endpoints unhealthy, resetting failure counts')
    this.failureCounts = new Array(this.clients.length).fill(0)
    this.currentIndex = 0
  }

  /**
   * Execute an operation with automatic fallback
   */
  async executeWithFallback<T>(
    operation: (client: ReturnType<typeof createPublicClient>) => Promise<T>,
    operationName: string
  ): Promise<T> {
    const startIndex = this.currentIndex
    let lastError: unknown

    // Try each endpoint once
    for (let attempt = 0; attempt < this.clients.length; attempt++) {
      try {
        const result = await operation(this.client)
        this.reportSuccess()
        return result
      } catch (error) {
        lastError = error
        log(`${operationName} failed on RPC endpoint ${this.currentIndex}: ${error}`)
        this.reportFailure()

        // If we've tried all endpoints, throw
        if ((this.currentIndex + 1) % this.clients.length === startIndex) {
          break
        }
      }
    }

    throw lastError
  }
}

// Initialize RPC client manager
const rpcManager = new RpcClientManager(config.rpcUrls)

// ============ Envio GraphQL Client ============

const graphqlClient = new GraphQLClient(config.envioGraphqlUrl)

const QUERY_PROTOCOL_EXECUTIONS = gql`
  query ProtocolExecutions($sinceBlock: numeric!, $contractAddress: String) {
    ProtocolExecution(
      where: { blockNumber: { _gt: $sinceBlock } }
      order_by: { blockNumber: asc, logIndex: asc }
    ) {
      id
      subAccount
      target
      opType
      tokensIn
      amountsIn
      tokensOut
      amountsOut
      spendingCost
      blockNumber
      txHash
      logIndex
      timestamp
    }
  }
`

const QUERY_TRANSFER_EXECUTIONS = gql`
  query TransferExecutions($sinceBlock: numeric!) {
    TransferExecuted(
      where: { blockNumber: { _gt: $sinceBlock } }
      order_by: { blockNumber: asc, logIndex: asc }
    ) {
      id
      subAccount
      token
      recipient
      amount
      spendingCost
      blockNumber
      txHash
      logIndex
      timestamp
    }
  }
`

const QUERY_ACQUIRED_BALANCE_TOKENS = gql`
  query AcquiredBalanceTokens($subAccount: String!) {
    AcquiredBalanceUpdated(
      where: { subAccount: { _eq: $subAccount } }
      distinct_on: [token]
    ) {
      token
    }
  }
`

// Convenience getter for the current public client
const getPublicClient = () => rpcManager.client

let walletClient: ReturnType<typeof createWalletClient>
let account: ReturnType<typeof privateKeyToAccount>

// Track last processed block for event polling
let lastProcessedBlock = 0n

// Track block hashes for reorg detection
// Maps block number -> block hash (limited to recent blocks)
const processedBlockHashes = new Map<bigint, `0x${string}`>()
const MAX_BLOCK_HASH_CACHE = 1000

// Prevent overlapping operations - single mutex for all state updates
let isProcessing = false

function initWalletClient() {
  account = privateKeyToAccount(config.privateKey)
  walletClient = createWalletClient({
    chain: config.chain,
    transport: http(config.rpcUrls[0]), // Use primary RPC for writes
    account,
  })
}

/**
 * Check for chain reorganization by comparing block hashes
 * Returns the block number to reprocess from if reorg detected, otherwise null
 */
async function checkForReorg(): Promise<bigint | null> {
  if (processedBlockHashes.size === 0) {
    return null
  }

  // Check recent blocks for hash mismatches (reorg indicator)
  const blocksToCheck = Math.min(config.confirmationBlocks * 2, processedBlockHashes.size)
  const recentBlocks = Array.from(processedBlockHashes.entries())
    .sort((a, b) => Number(b[0] - a[0])) // Sort descending by block number
    .slice(0, blocksToCheck)

  for (const [blockNum, expectedHash] of recentBlocks) {
    try {
      const block = await rpcManager.executeWithFallback(
        (client) => client.getBlock({ blockNumber: blockNum }),
        `checkForReorg(block ${blockNum})`
      )

      if (block.hash !== expectedHash) {
        log(`Reorg detected at block ${blockNum}: expected ${expectedHash}, got ${block.hash}`)
        // Clear affected block hashes and return the reorg point
        for (const [num] of processedBlockHashes) {
          if (num >= blockNum) {
            processedBlockHashes.delete(num)
          }
        }
        return blockNum - 1n // Reprocess from before the reorg
      }
    } catch (error) {
      log(`Error checking block ${blockNum} for reorg: ${error}`)
      // On error, assume no reorg to avoid false positives
    }
  }

  return null
}

/**
 * Record a processed block hash for future reorg detection
 */
function recordBlockHash(blockNumber: bigint, blockHash: `0x${string}`): void {
  processedBlockHashes.set(blockNumber, blockHash)

  // Prune old entries to prevent unbounded growth
  if (processedBlockHashes.size > MAX_BLOCK_HASH_CACHE) {
    const sortedBlocks = Array.from(processedBlockHashes.keys()).sort((a, b) => Number(a - b))
    const toDelete = sortedBlocks.slice(0, processedBlockHashes.size - MAX_BLOCK_HASH_CACHE)
    for (const blockNum of toDelete) {
      processedBlockHashes.delete(blockNum)
    }
  }
}

// ============ Logging ============

function log(message: string) {
  console.log(`[SpendingOracle ${new Date().toISOString()}] ${message}`)
}

// ============ Multi-Module Support ============

/**
 * Get active modules from registry, or fall back to single moduleAddress
 */
async function getActiveModules(): Promise<Address[]> {
  if (!config.registryAddress) {
    // Backwards compatibility: use single module
    return [config.moduleAddress]
  }

  try {
    const modules = await rpcManager.executeWithFallback(
      (client) => client.readContract({
        address: config.registryAddress!,
        abi: ModuleRegistryABI,
        functionName: 'getActiveModules',
      }),
      'getActiveModules'
    )

    if (modules.length === 0) {
      log('Registry returned no active modules, falling back to config.moduleAddress')
      return [config.moduleAddress]
    }

    log(`Found ${modules.length} active modules in registry`)
    return modules as Address[]
  } catch (error) {
    log(`Error querying registry, falling back to single module: ${error}`)
    return [config.moduleAddress]
  }
}

// ============ Retry Helper ============

/**
 * Retry an async operation once on failure, then throw
 */
async function retryOnce<T>(
  operation: () => Promise<T>,
  operationName: string
): Promise<T> {
  try {
    return await operation()
  } catch (firstError) {
    log(`${operationName} failed, retrying once: ${firstError}`)
    try {
      return await operation()
    } catch (secondError) {
      log(`${operationName} failed after retry: ${secondError}`)
      throw secondError
    }
  }
}

// ============ Contract Read Functions ============

async function getSafeValue(moduleAddress: Address): Promise<bigint> {
  const [totalValueUSD] = await rpcManager.executeWithFallback(
    (client) => client.readContract({
      address: moduleAddress,
      abi: DeFiInteractorABI,
      functionName: 'getSafeValue',
    }),
    'getSafeValue'
  )
  return totalValueUSD
}

async function getSubAccountLimits(moduleAddress: Address, subAccount: Address): Promise<{ maxSpendingBps: bigint; windowDuration: bigint }> {
  const [maxSpendingBps, windowDuration] = await rpcManager.executeWithFallback(
    (client) => client.readContract({
      address: moduleAddress,
      abi: DeFiInteractorABI,
      functionName: 'getSubAccountLimits',
      args: [subAccount],
    }),
    `getSubAccountLimits(${subAccount})`
  )
  return { maxSpendingBps, windowDuration }
}

async function getActiveSubaccounts(moduleAddress: Address): Promise<Address[]> {
  const subaccounts = await rpcManager.executeWithFallback(
    (client) => client.readContract({
      address: moduleAddress,
      abi: DeFiInteractorABI,
      functionName: 'getSubaccountsByRole',
      args: [1], // DEFI_EXECUTE_ROLE
    }),
    'getActiveSubaccounts'
  )
  return subaccounts as Address[]
}

async function getOnChainSpendingAllowance(moduleAddress: Address, subAccount: Address): Promise<bigint> {
  const allowance = await rpcManager.executeWithFallback(
    (client) => client.readContract({
      address: moduleAddress,
      abi: DeFiInteractorABI,
      functionName: 'getSpendingAllowance',
      args: [subAccount],
    }),
    `getOnChainSpendingAllowance(${subAccount})`
  )
  return allowance as bigint
}

async function getOnChainAcquiredBalance(moduleAddress: Address, subAccount: Address, token: Address): Promise<bigint> {
  const balance = await rpcManager.executeWithFallback(
    (client) => client.readContract({
      address: moduleAddress,
      abi: DeFiInteractorABI,
      functionName: 'getAcquiredBalance',
      args: [subAccount, token],
    }),
    `getOnChainAcquiredBalance(${subAccount}, ${token})`
  )
  return balance as bigint
}

// ============ Event Parsing ============

function parseProtocolExecutionLog(log: Log): ProtocolExecutionEvent {
  const subAccount = log.topics[1] ? (`0x${log.topics[1].slice(-40)}` as Address) : ('0x' as Address)
  const target = log.topics[2] ? (`0x${log.topics[2].slice(-40)}` as Address) : ('0x' as Address)

  const decoded = decodeAbiParameters(
    [
      { name: 'opType', type: 'uint8' },
      { name: 'tokensIn', type: 'address[]' },
      { name: 'amountsIn', type: 'uint256[]' },
      { name: 'tokensOut', type: 'address[]' },
      { name: 'amountsOut', type: 'uint256[]' },
      { name: 'spendingCost', type: 'uint256' },
    ],
    log.data
  )

  const tokensIn = decoded[1] as Address[]
  const amountsIn = decoded[2] as bigint[]
  const tokensOut = decoded[3] as Address[]
  const amountsOut = decoded[4] as bigint[]

  // Validate array lengths match to prevent processing malformed events
  if (tokensIn.length !== amountsIn.length) {
    throw new Error(`Malformed event: tokensIn.length (${tokensIn.length}) !== amountsIn.length (${amountsIn.length})`)
  }
  if (tokensOut.length !== amountsOut.length) {
    throw new Error(`Malformed event: tokensOut.length (${tokensOut.length}) !== amountsOut.length (${amountsOut.length})`)
  }

  return {
    subAccount,
    target,
    opType: decoded[0] as OperationType,
    tokensIn,
    amountsIn,
    tokensOut,
    amountsOut,
    spendingCost: decoded[5],
    // Timestamp will be set from block data when processing
    timestamp: 0n,
    blockNumber: log.blockNumber || 0n,
    logIndex: log.logIndex || 0,
  }
}

function parseTransferExecutedLog(log: Log): TransferExecutedEvent {
  const subAccount = log.topics[1] ? (`0x${log.topics[1].slice(-40)}` as Address) : ('0x' as Address)
  const token = log.topics[2] ? (`0x${log.topics[2].slice(-40)}` as Address) : ('0x' as Address)
  const recipient = log.topics[3] ? (`0x${log.topics[3].slice(-40)}` as Address) : ('0x' as Address)

  const decoded = decodeAbiParameters(
    [
      { name: 'amount', type: 'uint256' },
      { name: 'spendingCost', type: 'uint256' },
    ],
    log.data
  )

  return {
    subAccount,
    token,
    recipient,
    amount: decoded[0],
    spendingCost: decoded[1],
    // Timestamp will be set from block data when processing
    timestamp: 0n,
    blockNumber: log.blockNumber || 0n,
    logIndex: log.logIndex || 0,
  }
}

// ============ Event Queries ============

/**
 * Fetch block timestamps with retry logic
 * Throws if any block timestamp cannot be fetched after retry
 */
async function fetchBlockTimestamps(blockNumbers: bigint[]): Promise<Map<bigint, bigint>> {
  const blockTimestamps = new Map<bigint, bigint>()

  await Promise.all(
    blockNumbers.map(async (blockNum) => {
      const block = await rpcManager.executeWithFallback(
        (client) => client.getBlock({ blockNumber: blockNum }),
        `getBlock(${blockNum})`
      )
      blockTimestamps.set(blockNum, block.timestamp)
      // Record block hash for reorg detection
      if (block.hash) {
        recordBlockHash(blockNum, block.hash)
      }
    })
  )

  return blockTimestamps
}

async function queryProtocolExecutionEvents(moduleAddress: Address, fromBlock: bigint, toBlock: bigint, subAccount?: Address): Promise<ProtocolExecutionEvent[]> {
  try {
    // Query Envio indexer instead of eth_getLogs
    const data = await graphqlClient.request<{
      ProtocolExecution: Array<{
        subAccount: string; target: string; opType: number
        tokensIn: string[]; amountsIn: string[]
        tokensOut: string[]; amountsOut: string[]
        spendingCost: string; blockNumber: string
        txHash: string; logIndex: number; timestamp: string
      }>
    }>(QUERY_PROTOCOL_EXECUTIONS, { sinceBlock: fromBlock.toString() })

    const events: ProtocolExecutionEvent[] = data.ProtocolExecution
      .filter(e => !subAccount || e.subAccount.toLowerCase() === subAccount.toLowerCase())
      .map(e => ({
        subAccount: e.subAccount as Address,
        target: e.target as Address,
        opType: e.opType as OperationType,
        tokensIn: e.tokensIn as Address[],
        amountsIn: e.amountsIn.map(a => BigInt(a)),
        tokensOut: e.tokensOut as Address[],
        amountsOut: e.amountsOut.map(a => BigInt(a)),
        spendingCost: BigInt(e.spendingCost),
        timestamp: BigInt(e.timestamp),
        blockNumber: BigInt(e.blockNumber),
        logIndex: e.logIndex,
      }))

    return events
  } catch (error) {
    log(`Envio query failed for ProtocolExecution, falling back to RPC: ${error}`)
    return queryProtocolExecutionEventsRpc(moduleAddress, fromBlock, toBlock, subAccount)
  }
}

/** RPC fallback for when Envio is unavailable */
async function queryProtocolExecutionEventsRpc(moduleAddress: Address, fromBlock: bigint, toBlock: bigint, subAccount?: Address): Promise<ProtocolExecutionEvent[]> {
  const logs = await rpcManager.executeWithFallback(
    (client) => client.getLogs({
      address: moduleAddress,
      event: PROTOCOL_EXECUTION_EVENT,
      fromBlock,
      toBlock,
      args: subAccount ? { subAccount } : undefined,
    }),
    'queryProtocolExecutionEventsRpc'
  )

  const events = logs.map(parseProtocolExecutionLog)

  if (events.length === 0) {
    return events
  }

  const uniqueBlocks = [...new Set(events.map(e => e.blockNumber))]
  const blockTimestamps = await fetchBlockTimestamps(uniqueBlocks)

  for (const event of events) {
    const timestamp = blockTimestamps.get(event.blockNumber)
    if (timestamp === undefined) {
      throw new Error(`Missing timestamp for block ${event.blockNumber}`)
    }
    event.timestamp = timestamp
  }

  return events
}

async function queryTransferEvents(moduleAddress: Address, fromBlock: bigint, toBlock: bigint, subAccount?: Address): Promise<TransferExecutedEvent[]> {
  try {
    // Query Envio indexer instead of eth_getLogs
    const data = await graphqlClient.request<{
      TransferExecuted: Array<{
        subAccount: string; token: string; recipient: string
        amount: string; spendingCost: string; blockNumber: string
        txHash: string; logIndex: number; timestamp: string
      }>
    }>(QUERY_TRANSFER_EXECUTIONS, { sinceBlock: fromBlock.toString() })

    const events: TransferExecutedEvent[] = data.TransferExecuted
      .filter(e => !subAccount || e.subAccount.toLowerCase() === subAccount.toLowerCase())
      .map(e => ({
        subAccount: e.subAccount as Address,
        token: e.token as Address,
        recipient: e.recipient as Address,
        amount: BigInt(e.amount),
        spendingCost: BigInt(e.spendingCost),
        timestamp: BigInt(e.timestamp),
        blockNumber: BigInt(e.blockNumber),
        logIndex: e.logIndex,
      }))

    return events
  } catch (error) {
    log(`Envio query failed for TransferExecuted, falling back to RPC: ${error}`)
    return queryTransferEventsRpc(moduleAddress, fromBlock, toBlock, subAccount)
  }
}

/** RPC fallback for when Envio is unavailable */
async function queryTransferEventsRpc(moduleAddress: Address, fromBlock: bigint, toBlock: bigint, subAccount?: Address): Promise<TransferExecutedEvent[]> {
  const logs = await rpcManager.executeWithFallback(
    (client) => client.getLogs({
      address: moduleAddress,
      event: TRANSFER_EXECUTED_EVENT,
      fromBlock,
      toBlock,
      args: subAccount ? { subAccount } : undefined,
    }),
    'queryTransferEventsRpc'
  )

  const events = logs.map(parseTransferExecutedLog)

  if (events.length === 0) {
    return events
  }

  const uniqueBlocks = [...new Set(events.map(e => e.blockNumber))]
  const blockTimestamps = await fetchBlockTimestamps(uniqueBlocks)

  for (const event of events) {
    const timestamp = blockTimestamps.get(event.blockNumber)
    if (timestamp === undefined) {
      throw new Error(`Missing timestamp for block ${event.blockNumber}`)
    }
    event.timestamp = timestamp
  }

  return events
}

/**
 * Query historical AcquiredBalanceUpdated events to find all tokens
 * that have ever had acquired balance set for a subaccount.
 * Uses Envio indexer (single query, no pagination needed) with RPC fallback.
 */
async function queryHistoricalAcquiredTokens(moduleAddress: Address, subAccount: Address): Promise<Set<Address>> {
  const tokens = new Set<Address>()

  try {
    // Envio: single query returns distinct tokens for this subaccount
    const data = await graphqlClient.request<{
      AcquiredBalanceUpdated: Array<{ token: string }>
    }>(QUERY_ACQUIRED_BALANCE_TOKENS, { subAccount: subAccount.toLowerCase() })

    for (const entry of data.AcquiredBalanceUpdated) {
      tokens.add(entry.token.toLowerCase() as Address)
    }

    log(`Envio historical token query: ${tokens.size} unique tokens for ${subAccount}`)
    return tokens
  } catch (error) {
    log(`Envio query failed for historical tokens, falling back to RPC: ${error}`)
  }

  // RPC fallback: paginated getLogs
  const currentBlock = await rpcManager.executeWithFallback(
    (client) => client.getBlockNumber(),
    'getBlockNumber'
  )

  const maxHistoricalBlocks = BigInt(config.maxHistoricalBlocks)
  const maxBlocksPerQuery = BigInt(config.maxBlocksPerQuery)
  const earliestBlock = currentBlock > maxHistoricalBlocks
    ? currentBlock - maxHistoricalBlocks
    : 0n

  log(`RPC fallback: querying historical tokens from block ${earliestBlock} to ${currentBlock}`)

  let fromBlock = earliestBlock

  while (fromBlock < currentBlock) {
    const toBlock = fromBlock + maxBlocksPerQuery > currentBlock
      ? currentBlock
      : fromBlock + maxBlocksPerQuery

    try {
      const logs = await rpcManager.executeWithFallback(
        (client) => client.getLogs({
          address: moduleAddress,
          event: ACQUIRED_BALANCE_UPDATED_EVENT,
          fromBlock,
          toBlock,
          args: { subAccount },
        }),
        `queryHistoricalAcquiredTokens RPC fallback`
      )

      for (const logEntry of logs) {
        const token = logEntry.args.token as Address
        if (token) {
          tokens.add(token.toLowerCase() as Address)
        }
      }
    } catch (chunkError) {
      log(`RPC chunk failed (blocks ${fromBlock}-${toBlock}), skipping: ${chunkError}`)
    }

    fromBlock = toBlock + 1n
  }

  log(`RPC historical token query: ${tokens.size} unique tokens for ${subAccount}`)
  return tokens
}

// ============ Token Price Helpers ============

/**
 * Get price feed address for a token from config
 */
function getPriceFeedForToken(tokenAddress: Address): Address | null {
  const tokenLower = tokenAddress.toLowerCase()
  const tokenConfig = config.tokens.find(t => t.address.toLowerCase() === tokenLower)
  if (tokenConfig?.priceFeedAddress) {
    return tokenConfig.priceFeedAddress as Address
  }
  return null
}

/**
 * Get token decimals
 */
async function getTokenDecimals(tokenAddress: Address): Promise<number> {
  try {
    const decimals = await rpcManager.executeWithFallback(
      (client) => client.readContract({
        address: tokenAddress,
        abi: ERC20ABI,
        functionName: 'decimals',
      }),
      `getTokenDecimals(${tokenAddress})`
    )
    return decimals
  } catch (error) {
    log(`Error getting decimals for ${tokenAddress}: ${error}`)
    return 18 // Default to 18
  }
}

/**
 * Get price from Chainlink price feed (normalized to 18 decimals)
 */
async function getChainlinkPriceUSD(priceFeedAddress: Address): Promise<bigint> {
  try {
    const [, answer] = await rpcManager.executeWithFallback(
      (client) => client.readContract({
        address: priceFeedAddress,
        abi: ChainlinkPriceFeedABI,
        functionName: 'latestRoundData',
      }),
      `getChainlinkPrice(${priceFeedAddress})`
    )

    const feedDecimals = await rpcManager.executeWithFallback(
      (client) => client.readContract({
        address: priceFeedAddress,
        abi: ChainlinkPriceFeedABI,
        functionName: 'decimals',
      }),
      `getChainlinkDecimals(${priceFeedAddress})`
    )

    // Normalize to 18 decimals
    const price18 = BigInt(answer) * BigInt(10 ** (18 - feedDecimals))
    return price18
  } catch (error) {
    log(`Error getting price from ${priceFeedAddress}: ${error}`)
    return 0n
  }
}

/**
 * Build a price cache for all tokens involved in events
 * Returns a map of token address -> { priceUSD (18 decimals), decimals }
 */
export async function buildTokenPriceCache(tokens: Set<Address>): Promise<TokenPriceCache> {
  const cache: TokenPriceCache = new Map()

  await Promise.all(
    Array.from(tokens).map(async (token) => {
      const tokenLower = token.toLowerCase() as Address
      const priceFeed = getPriceFeedForToken(tokenLower)

      if (!priceFeed) {
        // No price feed configured - use 0 (will fall back to amount-weighted)
        return
      }

      try {
        const [priceUSD, decimals] = await Promise.all([
          getChainlinkPriceUSD(priceFeed),
          getTokenDecimals(tokenLower),
        ])

        if (priceUSD > 0n) {
          cache.set(tokenLower, { priceUSD, decimals })
        }
      } catch (error) {
        log(`Error fetching price for ${token}: ${error}`)
      }
    })
  )

  return cache
}

/**
 * Calculate USD value for a token amount using the price cache
 * Returns value in 18 decimals, or null if price not available
 */
export function getTokenValueUSD(
  token: Address,
  amount: bigint,
  priceCache: TokenPriceCache
): bigint | null {
  const tokenLower = token.toLowerCase() as Address
  const priceInfo = priceCache.get(tokenLower)

  if (!priceInfo || priceInfo.priceUSD === 0n) {
    return null
  }

  // value = amount * price / 10^decimals
  // Both price and result are in 18 decimals
  return (amount * priceInfo.priceUSD) / BigInt(10 ** priceInfo.decimals)
}

// ============ FIFO Queue Helpers ============

/**
 * Consume tokens from a FIFO queue (oldest first)
 * Returns the entries consumed with their original timestamps
 * Only consumes non-expired entries based on the event timestamp
 */
export function consumeFromQueue(
  queue: AcquiredBalanceQueue,
  amount: bigint,
  eventTimestamp: bigint,
  windowDuration: bigint
): { consumed: AcquiredBalanceEntry[]; remaining: bigint } {
  const consumed: AcquiredBalanceEntry[] = []
  let remaining = amount
  const expiryThreshold = eventTimestamp - windowDuration

  while (remaining > 0n && queue.length > 0) {
    const entry = queue[0]

    // Skip expired entries (they shouldn't be consumed as acquired)
    if (entry.originalTimestamp < expiryThreshold) {
      queue.shift()
      continue
    }

    if (entry.amount <= remaining) {
      // Consume entire entry
      consumed.push({ ...entry })
      remaining -= entry.amount
      queue.shift()
    } else {
      // Partial consumption
      consumed.push({ amount: remaining, originalTimestamp: entry.originalTimestamp })
      entry.amount -= remaining
      remaining = 0n
    }
  }

  return { consumed, remaining }
}

/**
 * Add tokens to a FIFO queue with the given original timestamp
 */
export function addToQueue(
  queue: AcquiredBalanceQueue,
  amount: bigint,
  originalTimestamp: bigint
): void {
  if (amount <= 0n) return
  queue.push({ amount, originalTimestamp })
}

/**
 * Get total amount in queue that hasn't expired
 */
export function getValidQueueBalance(
  queue: AcquiredBalanceQueue,
  currentTimestamp: bigint,
  windowDuration: bigint
): bigint {
  const expiryThreshold = currentTimestamp - windowDuration
  let total = 0n
  for (const entry of queue) {
    if (entry.originalTimestamp >= expiryThreshold) {
      total += entry.amount
    }
  }
  return total
}

/**
 * Remove expired entries from queue
 * Note: Queue may not be sorted by timestamp (e.g., inherited tokens from swaps
 * can have older timestamps than newly acquired tokens), so we filter all entries
 */
export function pruneExpiredEntries(
  queue: AcquiredBalanceQueue,
  currentTimestamp: bigint,
  windowDuration: bigint
): void {
  const expiryThreshold = currentTimestamp - windowDuration

  // Filter in-place: remove all expired entries, not just from front
  // Queue may be unsorted due to inherited timestamps from swaps
  let writeIndex = 0
  for (let readIndex = 0; readIndex < queue.length; readIndex++) {
    if (queue[readIndex].originalTimestamp >= expiryThreshold) {
      queue[writeIndex] = queue[readIndex]
      writeIndex++
    }
  }
  queue.length = writeIndex
}

// ============ State Building ============

// High precision for ratio calculations to minimize truncation errors
// Using 1e18 instead of 10000 (basis points) for much higher accuracy
const PRECISION = 10n ** 18n

// Unified event type for chronological processing
export type UnifiedEvent =
  | { type: 'protocol'; event: ProtocolExecutionEvent }
  | { type: 'transfer'; event: TransferExecutedEvent }

export function buildSubAccountState(
  events: ProtocolExecutionEvent[],
  transferEvents: TransferExecutedEvent[],
  subAccount: Address,
  currentTimestamp: bigint,
  windowDuration: bigint,
  priceCache?: TokenPriceCache
): SubAccountState {
  const windowStart = currentTimestamp - windowDuration

  const state: SubAccountState = {
    spendingRecords: [],
    depositRecords: [],
    totalSpendingInWindow: 0n,
    acquiredQueues: new Map(),
    acquiredBalances: new Map(),
  }

  // Filter events for this subaccount
  const filteredProtocol = events
    .filter(e => e.subAccount.toLowerCase() === subAccount.toLowerCase())

  const filteredTransfers = transferEvents
    .filter(e => e.subAccount.toLowerCase() === subAccount.toLowerCase())

  // Merge into unified event list and sort chronologically
  // This ensures transfers are processed in correct order relative to protocol events
  const unifiedEvents: UnifiedEvent[] = [
    ...filteredProtocol.map(e => ({ type: 'protocol' as const, event: e })),
    ...filteredTransfers.map(e => ({ type: 'transfer' as const, event: e })),
  ].sort((a, b) => {
    const timestampDiff = Number(a.event.timestamp - b.event.timestamp)
    if (timestampDiff !== 0) return timestampDiff
    // Same timestamp: sort by block number, then log index
    const blockDiff = Number(a.event.blockNumber - b.event.blockNumber)
    if (blockDiff !== 0) return blockDiff
    return a.event.logIndex - b.event.logIndex
  })

  log(`Processing ${unifiedEvents.length} events for ${subAccount} (FIFO mode, ${filteredProtocol.length} protocol + ${filteredTransfers.length} transfers)`)

  // Track all tokens that ever had acquired balance (for cleanup)
  const tokensWithAcquiredHistory = new Set<Address>()

  // FIFO queues per token - tracks (amount, originalTimestamp)
  const acquiredQueues: Map<Address, AcquiredBalanceQueue> = new Map()

  // Helper to get or create queue
  const getQueue = (token: Address): AcquiredBalanceQueue => {
    const lower = token.toLowerCase() as Address
    if (!acquiredQueues.has(lower)) {
      acquiredQueues.set(lower, [])
    }
    return acquiredQueues.get(lower)!
  }

  // Process ALL events chronologically (unified protocol + transfer events)
  for (const unified of unifiedEvents) {
    if (unified.type === 'protocol') {
      const event = unified.event
      const isInWindow = event.timestamp >= windowStart

      // Track spending (only count if in window)
      if (event.opType === OperationType.SWAP || event.opType === OperationType.DEPOSIT) {
        if (isInWindow && event.spendingCost > 0n) {
          state.spendingRecords.push({
            amount: event.spendingCost,
            timestamp: event.timestamp,
          })
          state.totalSpendingInWindow += event.spendingCost
        }
      }

      // Handle input token consumption (FIFO) - do this before creating deposit record
      // so we can capture the original acquisition timestamp for deposits
      // Use event timestamp to determine expiry - tokens must be valid at the time of the event
      // NOTE: Now handles multiple input tokens (e.g., LP position minting uses 2 tokens)
      let consumedEntries: AcquiredBalanceEntry[] = []
      let totalAmountIn = 0n
      let totalValueInUSD = 0n       // USD value of all inputs (for weighted ratio)
      let consumedValueUSD = 0n      // USD value of consumed acquired tokens
      let hasAllPrices = true        // Whether we have prices for all input tokens
      if (event.opType === OperationType.SWAP || event.opType === OperationType.DEPOSIT) {
        // Process each input token
        for (let i = 0; i < event.tokensIn.length; i++) {
          const tokenIn = event.tokensIn[i]
          const amountIn = event.amountsIn[i]
          if (amountIn <= 0n) continue

          totalAmountIn += amountIn
          const tokenInLower = tokenIn.toLowerCase() as Address
          const inputQueue = getQueue(tokenInLower)
          const result = consumeFromQueue(inputQueue, amountIn, event.timestamp, windowDuration)
          consumedEntries.push(...result.consumed)
          tokensWithAcquiredHistory.add(tokenInLower)

          // Track USD values for weighted ratio calculation
          if (priceCache) {
            const inputValueUSD = getTokenValueUSD(tokenIn, amountIn, priceCache)
            if (inputValueUSD !== null) {
              totalValueInUSD += inputValueUSD
              // Calculate USD value of consumed portion for this token
              const consumedAmount = result.consumed.reduce((sum, e) => sum + e.amount, 0n)
              const consumedTokenValueUSD = getTokenValueUSD(tokenIn, consumedAmount, priceCache)
              if (consumedTokenValueUSD !== null) {
                consumedValueUSD += consumedTokenValueUSD
              }
            } else {
              hasAllPrices = false
            }
          }
        }
      }

      // Track deposits for withdrawal matching
      // Store the original acquisition timestamp so withdrawals inherit it correctly
      // For multi-token deposits (LP), create a record for each input/output token pair
      // For mixed acquired/non-acquired inputs, we create seperate deposit records
      // so that the acquired portion inherits the proper timestamp and non-acquired gets event timestamp
      if (event.opType === OperationType.DEPOSIT) {
        // Calculate acquired ratio for splitting deposit records
        const totalConsumedForDeposit = consumedEntries.reduce((sum, e) => sum + e.amount, 0n)
        const fromNonAcquiredForDeposit = totalAmountIn - totalConsumedForDeposit

        // Find the oldest original timestamp from consumed acquired tokens (for acquired portion)
        let acquiredTimestamp = event.timestamp
        if (consumedEntries.length > 0) {
          acquiredTimestamp = consumedEntries.reduce(
            (oldest, entry) => entry.originalTimestamp < oldest ? entry.originalTimestamp : oldest,
            consumedEntries[0].originalTimestamp
          )
          log(`  DEPOSIT: acquired portion will inherit timestamp ${acquiredTimestamp}`)
        }

        // Create a deposit record linking input token to output token
        // This allows us to consume the output token (e.g., aLINK) when withdrawing the input token (LINK)

        // For multi-token LP deposits (N inputs → 1 output), we need to divide the output
        // proportionally among input tokens to avoid double-counting remainingOutputAmount
        const validInputCount = event.tokensIn.filter((_, i) => event.amountsIn[i] > 0n).length
        const validOutputCount = event.tokensOut.filter((_, i) => event.amountsOut[i] > 0n).length
        const isMultiInputSingleOutput = validInputCount > 1 && event.tokensOut.length === 1
        const isSingleInputMultiOutput = validInputCount === 1 && validOutputCount > 1

        // Calculate USD-weighted ratio for acquired vs non-acquired (needed for mixed deposits)
        let acquiredRatioForDeposit = 0n
        if (totalAmountIn > 0n) {
          if (priceCache && hasAllPrices && totalValueInUSD > 0n) {
            // USD-weighted ratio
            acquiredRatioForDeposit = (consumedValueUSD * PRECISION) / totalValueInUSD
          } else {
            // Amount-weighted ratio
            acquiredRatioForDeposit = (totalConsumedForDeposit * PRECISION) / totalAmountIn
          }
        }

        if (isSingleInputMultiOutput) {
          // Single input → multiple outputs: create deposit records for each output
          // Weight input allocation by output value (USD), not by count
          const tokenIn = event.tokensIn.find((_, i) => event.amountsIn[i] > 0n)!
          const amountIn = event.amountsIn.find(a => a > 0n)!

          // Calculate total output value for USD weighting
          let totalOutputValueUSD = 0n
          const outputValuesUSD: bigint[] = []
          for (let i = 0; i < event.tokensOut.length; i++) {
            const amountOut = event.amountsOut[i]
            if (amountOut <= 0n) {
              outputValuesUSD.push(0n)
              continue
            }
            const valueUSD = priceCache ? getTokenValueUSD(event.tokensOut[i], amountOut, priceCache) : null
            if (valueUSD !== null) {
              outputValuesUSD.push(valueUSD)
              totalOutputValueUSD += valueUSD
            } else {
              outputValuesUSD.push(0n)
            }
          }

          // Allocate input to each output
          let allocatedInput = 0n
          for (let i = 0; i < event.tokensOut.length; i++) {
            const tokenOut = event.tokensOut[i]
            const amountOut = event.amountsOut[i]
            if (amountOut <= 0n) continue

            // Calculate this output's share of the input
            let inputShare: bigint
            const remainingOutputs = event.tokensOut.slice(i).filter((_, idx) => event.amountsOut[i + idx] > 0n).length
            if (remainingOutputs === 1) {
              // Last output gets remainder to prevent dust loss
              inputShare = amountIn - allocatedInput
            } else if (totalOutputValueUSD > 0n && outputValuesUSD[i] > 0n) {
              // USD-weighted share
              inputShare = (amountIn * outputValuesUSD[i]) / totalOutputValueUSD
            } else {
              // Fallback: equal division
              inputShare = amountIn / BigInt(validOutputCount)
            }
            allocatedInput += inputShare

            log(`  DEPOSIT: single-input multi-output, allocating ${inputShare} ${tokenIn} to ${tokenOut} (value-weighted)`)

            // For mixed acquired/non-acquired, create separate deposit records
            if (totalConsumedForDeposit > 0n && fromNonAcquiredForDeposit > 0n) {
              // Split into acquired and non-acquired portions
              const acquiredInputShare = (inputShare * acquiredRatioForDeposit) / PRECISION
              const nonAcquiredInputShare = inputShare - acquiredInputShare
              const acquiredOutputShare = (amountOut * acquiredRatioForDeposit) / PRECISION
              const nonAcquiredOutputShare = amountOut - acquiredOutputShare

              if (acquiredInputShare > 0n) {
                log(`    Acquired portion: ${acquiredInputShare} ${tokenIn} -> ${acquiredOutputShare} ${tokenOut}, timestamp ${acquiredTimestamp}`)
                state.depositRecords.push({
                  subAccount: event.subAccount,
                  target: event.target,
                  tokenIn: tokenIn,
                  amountIn: acquiredInputShare,
                  remainingAmount: acquiredInputShare,
                  tokenOut: tokenOut,
                  amountOut: acquiredOutputShare,
                  remainingOutputAmount: acquiredOutputShare,
                  timestamp: event.timestamp,
                  originalAcquisitionTimestamp: acquiredTimestamp,
                })
              }
              if (nonAcquiredInputShare > 0n) {
                log(`    Non-acquired portion: ${nonAcquiredInputShare} ${tokenIn} -> ${nonAcquiredOutputShare} ${tokenOut}, timestamp ${event.timestamp}`)
                state.depositRecords.push({
                  subAccount: event.subAccount,
                  target: event.target,
                  tokenIn: tokenIn,
                  amountIn: nonAcquiredInputShare,
                  remainingAmount: nonAcquiredInputShare,
                  tokenOut: tokenOut,
                  amountOut: nonAcquiredOutputShare,
                  remainingOutputAmount: nonAcquiredOutputShare,
                  timestamp: event.timestamp,
                  originalAcquisitionTimestamp: event.timestamp, // Non-acquired = new spending
                })
              }
            } else {
              // All acquired or all non-acquired - single record
              const originalTimestamp = totalConsumedForDeposit > 0n ? acquiredTimestamp : event.timestamp
              state.depositRecords.push({
                subAccount: event.subAccount,
                target: event.target,
                tokenIn: tokenIn,
                amountIn: inputShare,
                remainingAmount: inputShare,
                tokenOut: tokenOut,
                amountOut: amountOut,
                remainingOutputAmount: amountOut,
                timestamp: event.timestamp,
                originalAcquisitionTimestamp: originalTimestamp,
              })
            }
          }
        } else {
          // Standard case: loop over inputs
          for (let i = 0; i < event.tokensIn.length; i++) {
            const tokenIn = event.tokensIn[i]
            const amountIn = event.amountsIn[i]
            if (amountIn <= 0n) continue

            // Find corresponding output token (same index if available, otherwise first output)
            const tokenOut = event.tokensOut[i] || event.tokensOut[0] || ('0x' as Address)
            let amountOut = event.amountsOut[i] || event.amountsOut[0] || 0n

            // For multi-input → single-output LP deposits, divide output equally among inputs
            // This prevents double-counting: if 2 tokens deposit into 1 LP, each record gets 50% of LP
            if (isMultiInputSingleOutput && amountOut > 0n) {
              amountOut = amountOut / BigInt(validInputCount)
              log(`  DEPOSIT: multi-input LP detected, allocating ${amountOut} ${tokenOut} to ${tokenIn} input (1/${validInputCount} share)`)
            }

            // For mixed acquired/non-acquired, create separate deposit records per input
            // Note: We use the overall acquired ratio as approximation since consumedEntries
            // contains entries from ALL input tokens. For accurate per-token split,
            // we'd need to track consumed entries per token.
            // Use overall ratio for this input's split
            if (totalConsumedForDeposit > 0n && fromNonAcquiredForDeposit > 0n) {
              // Split into acquired and non-acquired portions
              const acquiredAmountIn = (amountIn * acquiredRatioForDeposit) / PRECISION
              const nonAcquiredAmountIn = amountIn - acquiredAmountIn
              const acquiredAmountOut = (amountOut * acquiredRatioForDeposit) / PRECISION
              const nonAcquiredAmountOut = amountOut - acquiredAmountOut

              if (acquiredAmountIn > 0n) {
                log(`  DEPOSIT: acquired portion ${acquiredAmountIn} ${tokenIn} -> ${acquiredAmountOut} ${tokenOut}, timestamp ${acquiredTimestamp}`)
                state.depositRecords.push({
                  subAccount: event.subAccount,
                  target: event.target,
                  tokenIn: tokenIn,
                  amountIn: acquiredAmountIn,
                  remainingAmount: acquiredAmountIn,
                  tokenOut: tokenOut,
                  amountOut: acquiredAmountOut,
                  remainingOutputAmount: acquiredAmountOut,
                  timestamp: event.timestamp,
                  originalAcquisitionTimestamp: acquiredTimestamp,
                })
              }
              if (nonAcquiredAmountIn > 0n) {
                log(`  DEPOSIT: non-acquired portion ${nonAcquiredAmountIn} ${tokenIn} -> ${nonAcquiredAmountOut} ${tokenOut}, timestamp ${event.timestamp}`)
                state.depositRecords.push({
                  subAccount: event.subAccount,
                  target: event.target,
                  tokenIn: tokenIn,
                  amountIn: nonAcquiredAmountIn,
                  remainingAmount: nonAcquiredAmountIn,
                  tokenOut: tokenOut,
                  amountOut: nonAcquiredAmountOut,
                  remainingOutputAmount: nonAcquiredAmountOut,
                  timestamp: event.timestamp,
                  originalAcquisitionTimestamp: event.timestamp, // Non-acquired = new spending
                })
              }
            } else {
              // All acquired or all non-acquired - single record
              const originalTimestamp = totalConsumedForDeposit > 0n ? acquiredTimestamp : event.timestamp
              state.depositRecords.push({
                subAccount: event.subAccount,
                target: event.target,
                tokenIn: tokenIn,
                amountIn: amountIn,
                remainingAmount: amountIn,
                tokenOut: tokenOut,
                amountOut: amountOut,
                remainingOutputAmount: amountOut,
                timestamp: event.timestamp,
                originalAcquisitionTimestamp: originalTimestamp,
              })
            }
          }
        }
      }

      // Handle output tokens (add to acquired queue) - iterate over tokensOut/amountsOut arrays
      // For SWAPs and DEPOSITs: proportionally split output between acquired (inherited timestamp) and new (current timestamp)
      // For WITHDRAW/CLAIM: output matched to deposits inherits their original acquisition timestamp

      if (event.opType === OperationType.SWAP || event.opType === OperationType.DEPOSIT) {
        // Process all output tokens in the array
        for (let i = 0; i < event.tokensOut.length; i++) {
          const tokenOut = event.tokensOut[i]
          const amountOut = event.amountsOut[i]
          if (amountOut <= 0n) continue

          const tokenOutLower = tokenOut.toLowerCase() as Address
          tokensWithAcquiredHistory.add(tokenOutLower)
          const outputQueue = getQueue(tokenOutLower)

          // Calculate how much of the input was acquired vs non-acquired
          const totalConsumed = consumedEntries.reduce((sum, e) => sum + e.amount, 0n)
          const fromNonAcquired = totalAmountIn - totalConsumed // Remaining came from original funds

          if (totalConsumed > 0n && fromNonAcquired > 0n) {
            // Mixed case: proportionally split the output
            // Acquired portion inherits timestamps proportionally, non-acquired portion is newly acquired

            // Use USD-weighted ratio if we have prices for all input tokens
            // This correctly handles multi-token inputs with different values (e.g., 1 WETH + 1000 USDC)
            let acquiredRatio: bigint
            let useUSDWeighting = false

            if (priceCache && hasAllPrices && totalValueInUSD > 0n) {
              // USD-weighted ratio: based on actual value, not raw amounts
              // Using high precision (1e18) to minimize truncation errors
              acquiredRatio = (consumedValueUSD * PRECISION) / totalValueInUSD
              useUSDWeighting = true
            } else {
              // Fallback: amount-weighted ratio (original behavior)
              acquiredRatio = (totalConsumed * PRECISION) / totalAmountIn
            }

            const outputFromAcquired = (amountOut * acquiredRatio) / PRECISION
            const outputFromNonAcquired = amountOut - outputFromAcquired

            const opName = OperationType[event.opType]
            if (useUSDWeighting) {
              log(`  ${opName}: mixed input (USD-weighted) - $${formatUnits(consumedValueUSD, 18)} acquired + $${formatUnits(totalValueInUSD - consumedValueUSD, 18)} non-acquired`)
            } else {
              log(`  ${opName}: mixed input - ${totalConsumed} acquired + ${fromNonAcquired} non-acquired`)
            }

            // Proportionally split the acquired output among consumed entries by their amounts
            // Each consumed entry's portion of the output inherits that entry's timestamp
            // Track allocated amount to ensure no dust is lost
            let allocatedFromAcquired = 0n
            for (let idx = 0; idx < consumedEntries.length; idx++) {
              const entry = consumedEntries[idx]
              let entryOutput: bigint
              if (idx === consumedEntries.length - 1) {
                // Last entry gets remainder to prevent dust loss
                entryOutput = outputFromAcquired - allocatedFromAcquired
              } else {
                const entryRatio = (entry.amount * PRECISION) / totalConsumed
                entryOutput = (outputFromAcquired * entryRatio) / PRECISION
              }
              if (entryOutput > 0n) {
                log(`    ${entryOutput} ${tokenOut} inherits timestamp ${entry.originalTimestamp}`)
                addToQueue(outputQueue, entryOutput, entry.originalTimestamp)
                allocatedFromAcquired += entryOutput
              }
            }

            log(`    ${outputFromNonAcquired} ${tokenOut} newly acquired at ${event.timestamp}`)
            addToQueue(outputQueue, outputFromNonAcquired, event.timestamp)
          } else if (totalConsumed > 0n) {
            // Entire input was acquired - output inherits timestamps proportionally from consumed entries
            const opName = OperationType[event.opType]

            // Proportionally split the output among consumed entries by their amounts
            // Each consumed entry's portion of the output inherits that entry's timestamp
            // Track allocated amount to ensure no dust is lost
            let allocatedOutput = 0n
            for (let idx = 0; idx < consumedEntries.length; idx++) {
              const entry = consumedEntries[idx]
              let entryOutput: bigint
              if (idx === consumedEntries.length - 1) {
                // Last entry gets remainder to prevent dust loss
                entryOutput = amountOut - allocatedOutput
              } else {
                const entryRatio = (entry.amount * PRECISION) / totalConsumed
                entryOutput = (amountOut * entryRatio) / PRECISION
              }
              if (entryOutput > 0n) {
                log(`  ${opName}: ${entryOutput} ${tokenOut} inherits timestamp ${entry.originalTimestamp}`)
                addToQueue(outputQueue, entryOutput, entry.originalTimestamp)
                allocatedOutput += entryOutput
              }
            }
          } else {
            // No acquired input - output is newly acquired
            const opName = OperationType[event.opType]
            log(`  ${opName}: ${amountOut} ${tokenOut} is newly acquired at ${event.timestamp}`)
            addToQueue(outputQueue, amountOut, event.timestamp)
          }
        }
      } else if (event.opType === OperationType.WITHDRAW || event.opType === OperationType.CLAIM) {
        // Process all output tokens in the array
        for (let i = 0; i < event.tokensOut.length; i++) {
          const tokenOut = event.tokensOut[i]
          const amountOut = event.amountsOut[i]
          if (amountOut <= 0n) continue

          const tokenOutLower = tokenOut.toLowerCase() as Address

          // Find matching deposits
          let remainingToMatch = amountOut

          // Track output tokens to consume from acquired queue (e.g., aLINK when withdrawing LINK)
          // We track the deposit reference so we can update remainingOutputAmount after actual queue consumption
          const outputTokensToConsume: { token: Address; amount: bigint; deposit: DepositRecord }[] = []

          // Track matched amounts per timestamp - each deposit portion inherits its own timestamp
          const matchedByTimestamp: { amount: bigint; timestamp: bigint }[] = []

          for (const deposit of state.depositRecords) {
            if (remainingToMatch <= 0n) break

            if (deposit.target.toLowerCase() === event.target.toLowerCase() &&
                deposit.subAccount.toLowerCase() === event.subAccount.toLowerCase() &&
                deposit.tokenIn.toLowerCase() === tokenOutLower &&
                deposit.remainingAmount > 0n) {

              const consumeAmount = remainingToMatch > deposit.remainingAmount
                ? deposit.remainingAmount
                : remainingToMatch

              deposit.remainingAmount -= consumeAmount
              remainingToMatch -= consumeAmount

              // Calculate proportional output token consumption (e.g., aLINK)
              // If we're withdrawing 50% of the deposited amount, consume 50% of the output token
              // NOTE: We don't reduce remainingOutputAmount here - we do it after actual queue consumption
              // to handle cases where queue entries have expired
              if (deposit.tokenOut && deposit.tokenOut !== '0x' && deposit.remainingOutputAmount > 0n) {
                const ratio = (consumeAmount * 10000n) / deposit.amountIn
                const outputToConsume = (deposit.amountOut * ratio) / 10000n
                const maxConsume = outputToConsume > deposit.remainingOutputAmount
                  ? deposit.remainingOutputAmount
                  : outputToConsume

                if (maxConsume > 0n) {
                  outputTokensToConsume.push({
                    token: deposit.tokenOut.toLowerCase() as Address,
                    amount: maxConsume,
                    deposit: deposit
                  })
                  log(`  ${OperationType[event.opType]} will consume up to ${maxConsume} ${deposit.tokenOut} (deposit output token)`)
                }
              }

              // Track this matched portion with its own timestamp (not the oldest across all deposits)
              // This ensures each deposit's portion inherits its correct original acquisition timestamp
              matchedByTimestamp.push({
                amount: consumeAmount,
                timestamp: deposit.originalAcquisitionTimestamp
              })

              log(`  ${OperationType[event.opType]} consuming ${consumeAmount} from deposit (original acquisition: ${deposit.originalAcquisitionTimestamp})`)
            }
          }

          // Consume the deposit's output tokens (e.g., aLINK) from the acquired queue
          // These tokens were added when depositing and should be removed when withdrawing
          // We update deposit.remainingOutputAmount based on actual consumption (not calculated)
          // to handle cases where queue entries have expired
          for (const { token, amount, deposit } of outputTokensToConsume) {
            const outputTokenQueue = getQueue(token)
            tokensWithAcquiredHistory.add(token)
            const { consumed } = consumeFromQueue(outputTokenQueue, amount, event.timestamp, windowDuration)
            const totalConsumed = consumed.reduce((sum, e) => sum + e.amount, 0n)

            // Update deposit record with actual amount consumed (may be less than requested if expired)
            deposit.remainingOutputAmount -= totalConsumed
            log(`  ${OperationType[event.opType]} consumed ${totalConsumed} ${token} from acquired queue (deposit receipt token)`)
          }

          // Add each matched portion to the queue with its own inherited timestamp
          // This correctly preserves timestamp granularity from different deposits
          const totalMatched = matchedByTimestamp.reduce((sum, m) => sum + m.amount, 0n)
          if (totalMatched > 0n) {
            tokensWithAcquiredHistory.add(tokenOutLower)
            const outputQueue = getQueue(tokenOutLower)

            for (const { amount, timestamp } of matchedByTimestamp) {
              log(`  ${OperationType[event.opType]} matched: ${amount} inherits original timestamp ${timestamp}`)
              addToQueue(outputQueue, amount, timestamp)
            }
          }

          // Handle unmatched amount
          if (remainingToMatch > 0n) {
            if (event.opType === OperationType.CLAIM) {
              // CLAIM rewards should only be acquired if there's a matching deposit for this target
              // (i.e., the subaccount created the position that generates rewards)
              const hasMatchingDeposit = state.depositRecords.some(
                d => d.target.toLowerCase() === event.target.toLowerCase() &&
                     d.subAccount.toLowerCase() === event.subAccount.toLowerCase()
              )

              if (hasMatchingDeposit) {
                // Find the oldest deposit timestamp for this target to inherit
                const oldestDepositTimestamp = state.depositRecords
                  .filter(d => d.target.toLowerCase() === event.target.toLowerCase() &&
                              d.subAccount.toLowerCase() === event.subAccount.toLowerCase())
                  .reduce((oldest, d) => d.originalAcquisitionTimestamp < oldest ? d.originalAcquisitionTimestamp : oldest,
                          event.timestamp)

                tokensWithAcquiredHistory.add(tokenOutLower)
                const outputQueue = getQueue(tokenOutLower)
                log(`  CLAIM: ${remainingToMatch} ${tokenOut} is acquired (has deposit at target), inherits timestamp ${oldestDepositTimestamp}`)
                addToQueue(outputQueue, remainingToMatch, oldestDepositTimestamp)
              } else {
                // No matching deposit - claim is from multisig's position, not subaccount's
                log(`  CLAIM: ${remainingToMatch} ${tokenOut} NOT acquired (no matching deposit from subaccount)`)
              }
            } else {
              // Unmatched WITHDRAW - the LP/receipt tokens weren't acquired by subaccount
              // This means either: external aTokens sent to Safe, or deposit was outside window/by multisig
              // In either case, the withdrawn tokens belong to the multisig, not subaccount
              log(`  WITHDRAW unmatched: ${remainingToMatch} ${tokenOut} NOT acquired (no matching deposit from subaccount)`)
            }
          }
        }
      }
    } else {
      // Transfer event
      const transfer = unified.event
      const isInWindow = transfer.timestamp >= windowStart
      const tokenLower = transfer.token.toLowerCase() as Address

      if (isInWindow && transfer.spendingCost > 0n) {
        state.spendingRecords.push({
          amount: transfer.spendingCost,
          timestamp: transfer.timestamp,
        })
        state.totalSpendingInWindow += transfer.spendingCost
      }

      if (transfer.amount > 0n) {
        const queue = getQueue(tokenLower)
        consumeFromQueue(queue, transfer.amount, transfer.timestamp, windowDuration)
        tokensWithAcquiredHistory.add(tokenLower)
      }
    }
  }

  // Calculate final acquired balances (only non-expired entries count)
  for (const token of tokensWithAcquiredHistory) {
    const queue = acquiredQueues.get(token) || []

    // Prune expired entries
    pruneExpiredEntries(queue, currentTimestamp, windowDuration)

    // Sum remaining valid balance
    const validBalance = getValidQueueBalance(queue, currentTimestamp, windowDuration)
    if (validBalance > 0n) {
      state.acquiredBalances.set(token, validBalance)
    }

    log(`  Token ${token}: acquired balance = ${validBalance}`)
  }

  // Store queues in state for potential debugging
  state.acquiredQueues = acquiredQueues

  log(`State built: spending=${state.totalSpendingInWindow}, acquired tokens=${state.acquiredBalances.size}`)

  return state
}

// ============ Allowance Calculation ============

async function calculateSpendingAllowance(
  moduleAddress: Address,
  subAccount: Address,
  state: SubAccountState
): Promise<bigint> {
  const safeValue = await getSafeValue(moduleAddress)
  const { maxSpendingBps } = await getSubAccountLimits(moduleAddress, subAccount)

  const maxSpending = (safeValue * maxSpendingBps) / 10000n
  const newAllowance = maxSpending > state.totalSpendingInWindow
    ? maxSpending - state.totalSpendingInWindow
    : 0n

  log(`Allowance: safeValue=${formatUnits(safeValue, 18)}, maxBps=${maxSpendingBps}, max=${formatUnits(maxSpending, 18)}, spent=${formatUnits(state.totalSpendingInWindow, 18)}, new=${formatUnits(newAllowance, 18)}`)

  return newAllowance
}

// ============ Contract Write ============

// ============ Update Thresholds ============
// Spending allowance update rules:
// - Always update if acquired balances changed
// - Always update if allowance went down (any decrease)
// - Update if allowance went up by more than 2%
// - Update if stale for more than 50 minutes

// Only update if allowance INCREASED by more than this percentage
const ALLOWANCE_INCREASE_THRESHOLD_BPS = BigInt(process.env.ALLOWANCE_INCREASE_THRESHOLD_BPS || '200') // 2%

// Always update if last update was more than this many seconds ago
const MAX_STALENESS_SECONDS = BigInt(process.env.SPENDING_ORACLE_MAX_STALENESS_SECONDS || '2700') // 45 minutes

// Track last update timestamp per module:subaccount (avoids collision across modules)
const lastUpdateTimestamp = new Map<string, bigint>()

// Pending transaction tracking for batch submissions
interface PendingTransaction {
  hash: `0x${string}`
  moduleAddress: Address
  subAccount: Address
  timestamp: bigint // Timestamp to set on successful confirmation
}

let pendingTransactions: PendingTransaction[] = []
let currentNonce: number | null = null

/**
 * Prepare a batch update (check if changes needed)
 * Returns the transaction parameters if update is needed, null otherwise
 *
 * Update logic:
 * - Always update if acquired balances changed
 * - Always update if allowance went down (any decrease)
 * - Update if allowance went up by more than 2%
 * - Update if stale for more than 50 minutes
 */
async function prepareBatchUpdate(
  moduleAddress: Address,
  subAccount: Address,
  newAllowance: bigint,
  acquiredBalances: Map<Address, bigint>
): Promise<{ tokens: Address[]; balances: bigint[]; allowanceChanged: boolean; timestamp: bigint } | null> {
  // Get current on-chain values
  const onChainAllowance = await getOnChainSpendingAllowance(moduleAddress, subAccount)
  const currentTimestamp = BigInt(Math.floor(Date.now() / 1000))

  // Check staleness (key includes moduleAddress to avoid collision across modules)
  const subAccountKey = `${moduleAddress}:${subAccount}`.toLowerCase()
  const lastUpdate = lastUpdateTimestamp.get(subAccountKey) || 0n
  const timeSinceUpdate = currentTimestamp - lastUpdate
  const isStale = timeSinceUpdate > MAX_STALENESS_SECONDS

  // Check allowance direction
  const allowanceDecreased = newAllowance < onChainAllowance
  const allowanceIncreased = newAllowance > onChainAllowance

  // Check if increase exceeds 2% threshold
  // Also consider any increase from 0 as significant
  let significantIncrease = false
  if (allowanceIncreased) {
    if (onChainAllowance > 0n) {
      const increaseAmount = newAllowance - onChainAllowance
      const threshold = (onChainAllowance * ALLOWANCE_INCREASE_THRESHOLD_BPS) / 10000n
      significantIncrease = increaseAmount > threshold
    } else {
      significantIncrease = newAllowance > 0n
    }
  }

  // Determine if allowance update is needed based on rules:
  // 1. Allowance went down (any decrease) -> always update
  // 2. Allowance went up by more than 2% -> update
  // 3. Stale for more than 50 minutes -> update
  const allowanceChanged = allowanceDecreased || significantIncrease || isStale

  if (!allowanceChanged && !allowanceDecreased && !significantIncrease) {
    if (allowanceIncreased) {
      const increaseAmount = newAllowance - onChainAllowance
      const increaseBps = onChainAllowance > 0n ? (increaseAmount * 10000n) / onChainAllowance : 0n
      log(`  Allowance increase within threshold: ${formatUnits(onChainAllowance, 18)} -> ${formatUnits(newAllowance, 18)} (+${increaseBps}bps, threshold: ${ALLOWANCE_INCREASE_THRESHOLD_BPS}bps)`)
    } else {
      log(`  Allowance unchanged: ${formatUnits(onChainAllowance, 18)}`)
    }
  }

  // Check if any acquired balances changed
  const tokens: Address[] = []
  const balances: bigint[] = []
  let acquiredChanged = false

  // First, add all tokens from calculated acquired balances
  for (const [token, newBalance] of acquiredBalances) {
    const onChainBalance = await getOnChainAcquiredBalance(moduleAddress, subAccount, token)
    if (newBalance !== onChainBalance) {
      acquiredChanged = true
    }
    tokens.push(token)
    balances.push(newBalance)
  }

  // Also check for tokens that have on-chain balance but aren't in calculated map
  // These need to be cleared to 0 (e.g., tokens that aged out or had incorrect matching)
  const historicalTokens = await queryHistoricalAcquiredTokens(moduleAddress, subAccount)
  for (const token of historicalTokens) {
    if (!acquiredBalances.has(token)) {
      const onChainBalance = await getOnChainAcquiredBalance(moduleAddress, subAccount, token)
      if (onChainBalance > 0n) {
        log(`  Clearing stale acquired balance for ${token}: ${onChainBalance} -> 0`)
        acquiredChanged = true
        tokens.push(token)
        balances.push(0n)
      }
    }
  }

  // Skip if no changes needed
  if (!allowanceChanged && !acquiredChanged) {
    log(`Skipping batch update - no changes needed:`)
    log(`  Allowance: ${formatUnits(onChainAllowance, 18)} -> ${formatUnits(newAllowance, 18)} (no decrease, increase <2%)`)
    log(`  Staleness: ${timeSinceUpdate}s (max: ${MAX_STALENESS_SECONDS}s)`)
    log(`  Acquired tokens: ${tokens.length} (no changes)`)
    return null
  }

  // Log reason for update
  const reasons: string[] = []
  if (acquiredChanged) reasons.push('acquired changed')
  if (allowanceDecreased) reasons.push('allowance decreased')
  if (significantIncrease) reasons.push('allowance increased >2%')
  if (isStale) reasons.push(`stale (${timeSinceUpdate}s > ${MAX_STALENESS_SECONDS}s)`)

  log(`Preparing batch update: subAccount=${subAccount}`)
  log(`  Reason: ${reasons.join(', ')}`)
  log(`  Allowance: ${formatUnits(onChainAllowance, 18)} -> ${formatUnits(newAllowance, 18)}`)
  log(`  Tokens: ${tokens.length}`)

  // Return timestamp to be set after successful tx confirmation (not before)
  return { tokens, balances, allowanceChanged, timestamp: currentTimestamp }
}

/**
 * Submit a batch update transaction without waiting for confirmation
 * Uses nonce management for parallel submission
 */
async function submitBatchUpdate(
  moduleAddress: Address,
  subAccount: Address,
  newAllowance: bigint,
  tokens: Address[],
  balances: bigint[],
  nonce: number
): Promise<`0x${string}`> {
  try {
    const hash = await walletClient.writeContract({
      chain: config.chain,
      account,
      address: moduleAddress,
      abi: DeFiInteractorABI,
      functionName: 'batchUpdate',
      args: [subAccount, newAllowance, tokens, balances],
      gas: config.gasLimit,
      nonce,
    })

    log(`Transaction submitted: ${hash} (nonce: ${nonce})`)
    return hash
  } catch (error) {
    log(`Error submitting batch update for ${subAccount}: ${error}`)
    throw error
  }
}

/**
 * Wait for all pending transactions to confirm
 */
async function waitForPendingTransactions(): Promise<void> {
  if (pendingTransactions.length === 0) return

  log(`Waiting for ${pendingTransactions.length} pending transactions...`)

  const results = await Promise.allSettled(
    pendingTransactions.map(async (tx) => {
      try {
        const receipt = await rpcManager.executeWithFallback(
          (client) => client.waitForTransactionReceipt({
            hash: tx.hash,
            timeout: 120_000 // 2 minute timeout
          }),
          `waitForTransactionReceipt(${tx.hash.slice(0, 10)})`
        )
        log(`Transaction ${tx.hash.slice(0, 10)}... confirmed in block ${receipt.blockNumber} (${tx.subAccount})`)
        return receipt
      } catch (error) {
        log(`Transaction ${tx.hash.slice(0, 10)}... failed for ${tx.subAccount}: ${error}`)
        throw error
      }
    })
  )

  // Log summary and update timestamps for successful transactions
  let successful = 0
  let failed = 0
  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    const tx = pendingTransactions[i]
    if (result.status === 'fulfilled') {
      successful++
      // Only update timestamp after successful confirmation (not before TX submission)
      const subAccountKey = `${tx.moduleAddress}:${tx.subAccount}`.toLowerCase()
      lastUpdateTimestamp.set(subAccountKey, tx.timestamp)
    } else {
      failed++
    }
  }
  log(`Transaction results: ${successful} confirmed, ${failed} failed`)

  // Clear pending transactions
  pendingTransactions = []
  currentNonce = null
}

/**
 * Legacy function for backward compatibility - prepares and submits with waiting
 */
async function pushBatchUpdate(
  moduleAddress: Address,
  subAccount: Address,
  newAllowance: bigint,
  acquiredBalances: Map<Address, bigint>
): Promise<string | null> {
  const prepared = await prepareBatchUpdate(moduleAddress, subAccount, newAllowance, acquiredBalances)
  if (!prepared) return null

  // Get nonce if not already tracking
  if (currentNonce === null) {
    currentNonce = await rpcManager.executeWithFallback(
      (client) => client.getTransactionCount({ address: account.address }),
      'getTransactionCount'
    )
  }

  const hash = await submitBatchUpdate(
    moduleAddress,
    subAccount,
    newAllowance,
    prepared.tokens,
    prepared.balances,
    currentNonce!
  )

  // Increment nonce for next transaction
  currentNonce!++

  // Track pending transaction with timestamp to set on success
  pendingTransactions.push({ hash, moduleAddress, subAccount, timestamp: prepared.timestamp })

  return hash
}

// ============ Event Polling ============

async function pollForNewEvents() {
  // Prevent overlapping operations (shared mutex with cron refresh)
  if (isProcessing) {
    return
  }
  isProcessing = true

  try {
    // Reset nonce tracking at start of batch
    currentNonce = null
    pendingTransactions = []

    const latestBlock = await rpcManager.executeWithFallback(
      (client) => client.getBlockNumber(),
      'getBlockNumber'
    )

    // Apply confirmation depth for reorg protection
    // Only process blocks that are sufficiently confirmed
    const confirmationBlocks = BigInt(config.confirmationBlocks)
    const currentBlock = latestBlock > confirmationBlocks ? latestBlock - confirmationBlocks : 0n

    if (lastProcessedBlock === 0n) {
      // First run - start from recent blocks
      lastProcessedBlock = currentBlock - BigInt(config.blocksToLookBack)
    }

    // Check for chain reorganization
    const reorgPoint = await checkForReorg()
    if (reorgPoint !== null) {
      log(`Reorg detected! Rewinding from block ${lastProcessedBlock} to ${reorgPoint}`)
      lastProcessedBlock = reorgPoint
    }

    if (currentBlock <= lastProcessedBlock) {
      isProcessing = false
      return // No new blocks
    }

    const blocksToProcess = currentBlock - lastProcessedBlock
    log(`Polling blocks ${lastProcessedBlock + 1n} to ${currentBlock} (${blocksToProcess} blocks, ${confirmationBlocks} confirmation depth)`)

    // Get all active modules
    const modules = await getActiveModules()

    // Process each module
    for (const moduleAddress of modules) {
      log(`--- Processing module: ${moduleAddress} ---`)

      // Query new events in parallel for this module
      const [protocolEvents, transferEvents] = await Promise.all([
        queryProtocolExecutionEvents(moduleAddress, lastProcessedBlock + 1n, currentBlock),
        queryTransferEvents(moduleAddress, lastProcessedBlock + 1n, currentBlock),
      ])

      if (protocolEvents.length > 0 || transferEvents.length > 0) {
        log(`Found ${protocolEvents.length} protocol events and ${transferEvents.length} transfer events`)

        // Get unique subaccounts from events
        const affectedSubaccounts = new Set<Address>()
        for (const e of protocolEvents) {
          affectedSubaccounts.add(e.subAccount)
        }
        for (const e of transferEvents) {
          affectedSubaccounts.add(e.subAccount)
        }

        // Process all affected subaccounts - transactions are submitted without waiting
        for (const subAccount of affectedSubaccounts) {
          // Skip if the subaccount is the module itself
          if (subAccount.toLowerCase() === moduleAddress.toLowerCase()) {
            log(`Skipping ${subAccount} - this is the module address, not a subaccount`)
            continue
          }

          try {
            await processSubaccount(moduleAddress, subAccount, currentBlock)
          } catch (error) {
            log(`Error processing ${subAccount}: ${error}`)
          }
        }
      }
    }

    // Wait for all pending transactions to confirm
    await waitForPendingTransactions()

    lastProcessedBlock = currentBlock
  } catch (error) {
    log(`Error polling for events: ${error}`)
  } finally {
    isProcessing = false
  }
}

// ============ Subaccount Processing ============

async function processSubaccount(moduleAddress: Address, subAccount: Address, currentBlock?: bigint) {
  const currentTimestamp = BigInt(Math.floor(Date.now() / 1000))
  const blockNumber = currentBlock ?? await rpcManager.executeWithFallback(
    (client) => client.getBlockNumber(),
    'getBlockNumber'
  )

  // Query from 2x the lookback range to discover tokens that may have acquired balance
  // even if the original acquisition is outside the current window
  const extendedFromBlock = blockNumber - BigInt(config.blocksToLookBack * 2)

  // Query limits and events in parallel (extended range for token discovery)
  const [{ windowDuration }, protocolEvents, transferEvents] = await Promise.all([
    getSubAccountLimits(moduleAddress, subAccount),
    queryProtocolExecutionEvents(moduleAddress, extendedFromBlock, blockNumber, subAccount),
    queryTransferEvents(moduleAddress, extendedFromBlock, blockNumber, subAccount),
  ])

  // Collect all unique tokens from events for price cache
  const tokensToPrice = new Set<Address>()
  for (const event of protocolEvents) {
    for (const token of event.tokensIn) {
      tokensToPrice.add(token.toLowerCase() as Address)
    }
    for (const token of event.tokensOut) {
      tokensToPrice.add(token.toLowerCase() as Address)
    }
  }
  for (const event of transferEvents) {
    tokensToPrice.add(event.token.toLowerCase() as Address)
  }

  // Build price cache for USD-weighted ratio calculations
  const priceCache = await buildTokenPriceCache(tokensToPrice)
  if (priceCache.size > 0) {
    log(`Built price cache for ${priceCache.size} tokens`)
  }

  // Build state with price cache for accurate ratio calculations
  const state = buildSubAccountState(protocolEvents, transferEvents, subAccount, currentTimestamp, windowDuration, priceCache)

  // Calculate allowance
  const newAllowance = await calculateSpendingAllowance(moduleAddress, subAccount, state)

  // Push update
  await pushBatchUpdate(moduleAddress, subAccount, newAllowance, state.acquiredBalances)
}

// ============ Cron Handler ============

async function onCronRefresh() {
  // Prevent overlapping operations (shared mutex with polling)
  if (isProcessing) {
    log('Skipping cron refresh - another operation is running')
    return
  }
  isProcessing = true

  log('=== Spending Oracle: Periodic Refresh ===')

  try {
    // Reset nonce tracking at start of batch
    currentNonce = null
    pendingTransactions = []

    // Get all active modules and current block
    const [modules, latestBlock] = await Promise.all([
      getActiveModules(),
      rpcManager.executeWithFallback(
        (client) => client.getBlockNumber(),
        'getBlockNumber'
      ),
    ])

    // Apply confirmation depth for reorg protection
    const confirmationBlocks = BigInt(config.confirmationBlocks)
    const currentBlock = latestBlock > confirmationBlocks ? latestBlock - confirmationBlocks : 0n
    log(`Processing ${modules.length} module(s)`)

    // Process each module
    for (const moduleAddress of modules) {
      log(`--- Processing module: ${moduleAddress} ---`)

      // Fetch subaccounts for this module
      const subaccounts = await getActiveSubaccounts(moduleAddress)
      log(`Found ${subaccounts.length} active subaccounts`)

      if (subaccounts.length === 0) {
        log('No active subaccounts for this module, skipping')
        continue
      }

      // Process all subaccounts - transactions are submitted without waiting
      for (const subAccount of subaccounts) {
        // Skip if the subaccount is the module itself (shouldn't happen but safety check)
        if (subAccount.toLowerCase() === moduleAddress.toLowerCase()) {
          log(`Skipping ${subAccount} - this is the module address, not a subaccount`)
          continue
        }

        try {
          log(`Processing subaccount: ${subAccount}`)
          await processSubaccount(moduleAddress, subAccount, currentBlock)
        } catch (error) {
          log(`Error processing ${subAccount}: ${error}`)
        }
      }
    }

    // Wait for all pending transactions to confirm
    await waitForPendingTransactions()

    log('=== Periodic Refresh Complete ===')
  } catch (error) {
    log(`Error in periodic refresh: ${error}`)
  } finally {
    isProcessing = false
  }
}

// ============ Main Functions ============

/**
 * Run a single update (for testing)
 */
export async function runOnce() {
  validateConfig()
  initWalletClient()
  await onCronRefresh()
}

/**
 * Start the oracle with polling and cron
 */
export function start() {
  validateConfig()
  initWalletClient()

  log(`Starting Spending Oracle`)
  log(`Module address: ${config.moduleAddress}`)
  if (config.registryAddress) {
    log(`Registry address: ${config.registryAddress} (multi-module mode)`)
  }
  log(`Updater address: ${account.address}`)
  log(`Poll interval: ${config.pollIntervalMs}ms`)
  log(`Cron schedule: ${config.spendingOracleCron}`)

  // Start event polling
  setInterval(pollForNewEvents, config.pollIntervalMs)

  // Start cron for periodic refresh
  cron.schedule(config.spendingOracleCron, onCronRefresh)

  // Run initial refresh
  onCronRefresh()
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  start()
}
