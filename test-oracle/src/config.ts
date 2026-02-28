import { z } from 'zod'
import dotenv from 'dotenv'
import { type Chain } from 'viem'

dotenv.config()

// ============ Monad Testnet Chain Definition ============
// viem doesn't have Monad testnet built-in; define manually
export const monadTestnet: Chain = {
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: {
    name: 'Monad',
    symbol: 'MON',
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [process.env.RPC_URL || 'https://testnet-rpc.monad.xyz'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Monad Explorer',
      url: 'https://testnet.monadexplorer.com',
    },
  },
  testnet: true,
}

// Token configuration for safe-value calculation
export const TokenConfigSchema = z.object({
  address: z.string(),
  priceFeedAddress: z.string(),
  symbol: z.string(),
  type: z.enum(['erc20', 'aave-atoken', 'morpho-vault', 'uniswap-v2-lp']).optional().default('erc20'),
  underlyingAsset: z.string().optional(),
  token0: z.string().optional(),
  token1: z.string().optional(),
  priceFeed0: z.string().optional(),
  priceFeed1: z.string().optional(),
})

export type TokenConfig = z.infer<typeof TokenConfigSchema>

// ============ Mock Price Feed Addresses (Monad Testnet) ============
// Deployed via DeployAll.s.sol — load from env vars
const PRICE_FEEDS = {
  USDC_USD: process.env.PRICE_FEED_USDC_USD || '',
  ETH_USD: process.env.PRICE_FEED_ETH_USD || '',
  DAI_USD: process.env.PRICE_FEED_DAI_USD || '',
}

// ============ Mock Token Addresses (Monad Testnet) ============
// Deployed via DeployAll.s.sol — load from env vars
const TOKENS = {
  USDC: process.env.TOKEN_USDC || '',
  WETH: process.env.TOKEN_WETH || '',
  DAI: process.env.TOKEN_DAI || '',
  // aTokens (deployed by MockAaveVault.addAsset)
  aUSDC: process.env.TOKEN_AUSDC || '',
  aWETH: process.env.TOKEN_AWETH || '',
  aDAI: process.env.TOKEN_ADAI || '',
}

// Parse RPC URLs from environment (comma-separated for fallback support)
function parseRpcUrls(): string[] {
  const primary = process.env.RPC_URL || 'https://testnet-rpc.monad.xyz'
  const fallbacks = process.env.RPC_FALLBACK_URLS?.split(',').map(u => u.trim()).filter(Boolean) || []
  return [primary, ...fallbacks]
}

// Build token list from env vars (only include tokens that have addresses configured)
function buildTokenList(): TokenConfig[] {
  const tokenDefs: { address: string; priceFeed: string; symbol: string; type: 'erc20' | 'aave-atoken' }[] = [
    { address: TOKENS.USDC, priceFeed: PRICE_FEEDS.USDC_USD, symbol: 'USDC', type: 'erc20' },
    { address: TOKENS.WETH, priceFeed: PRICE_FEEDS.ETH_USD, symbol: 'WETH', type: 'erc20' },
    { address: TOKENS.DAI, priceFeed: PRICE_FEEDS.DAI_USD, symbol: 'DAI', type: 'erc20' },
    { address: TOKENS.aUSDC, priceFeed: PRICE_FEEDS.USDC_USD, symbol: 'aUSDC', type: 'aave-atoken' },
    { address: TOKENS.aWETH, priceFeed: PRICE_FEEDS.ETH_USD, symbol: 'aWETH', type: 'aave-atoken' },
    { address: TOKENS.aDAI, priceFeed: PRICE_FEEDS.DAI_USD, symbol: 'aDAI', type: 'aave-atoken' },
  ]

  return tokenDefs
    .filter(t => t.address && t.priceFeed)
    .map(t => ({
      address: t.address,
      priceFeedAddress: t.priceFeed,
      symbol: t.symbol,
      type: t.type,
    }))
}

// Main configuration
export const config = {
  // Primary RPC URL (first in the list)
  rpcUrl: parseRpcUrls()[0],
  // All RPC URLs including fallbacks
  rpcUrls: parseRpcUrls(),
  privateKey: process.env.ORACLE_PK as `0x${string}`,
  moduleAddress: process.env.MODULE_ADDRESS as `0x${string}`,
  // Optional registry address for multi-module support
  registryAddress: process.env.REGISTRY_ADDRESS as `0x${string}` | undefined,

  // Envio GraphQL endpoint for event indexing (replaces eth_getLogs)
  envioGraphqlUrl: process.env.ENVIO_GRAPHQL_URL || 'http://localhost:8080/v1/graphql',

  // Cron schedules
  safeValueCron: process.env.SAFE_VALUE_CRON || '0 */10 * * * *',
  spendingOracleCron: process.env.SPENDING_ORACLE_CRON || '0 */2 * * * *',

  // Polling (5s — Envio handles indexing, polling triggers state rebuild)
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '5000'),
  // Monad ~1s blocks: 86400 blocks = 24h
  blocksToLookBack: parseInt(process.env.BLOCKS_TO_LOOK_BACK || '86400'),
  windowDurationSeconds: parseInt(process.env.WINDOW_DURATION_SECONDS || '86400'),

  // Reorg protection: ~60 blocks on Monad (~1 min at 1s blocks)
  confirmationBlocks: parseInt(process.env.CONFIRMATION_BLOCKS || '60'),

  // Monad limits getLogs to 100-1000 blocks; Envio handles this,
  // but keep for any direct RPC fallback queries
  maxBlocksPerQuery: parseInt(process.env.MAX_BLOCKS_PER_QUERY || '1000'),

  // ~30 days at 1s blocks
  maxHistoricalBlocks: parseInt(process.env.MAX_HISTORICAL_BLOCKS || '2592000'),

  // Gas
  gasLimit: BigInt(process.env.GAS_LIMIT || '500000'),

  // Chain
  chain: monadTestnet,

  // Token list — loaded from env vars (deployed mock addresses)
  tokens: buildTokenList(),
}

// Validate required config
export function validateConfig() {
  if (!config.privateKey) {
    throw new Error('ORACLE_PK environment variable is required')
  }
  if (!config.moduleAddress) {
    throw new Error('MODULE_ADDRESS environment variable is required')
  }
}
