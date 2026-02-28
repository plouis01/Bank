import { z } from 'zod'
import dotenv from 'dotenv'
import { sepolia } from 'viem/chains'

dotenv.config()

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

// ============ Chainlink Sepolia Price Feeds ============
// Source: https://docs.chain.link/data-feeds/price-feeds/addresses
const CHAINLINK_SEPOLIA = {
  ETH_USD: '0x694AA1769357215DE4FAC081bf1f309aDC325306',
  BTC_USD: '0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43',
  LINK_USD: '0xc59E3633BAAC79493d908e63626716e204A45EdF',
  USDC_USD: '0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E',
  DAI_USD: '0x14866185B1962B63C3Ea9E03Bc1da838bab34C19',
  AAVE_USD: '0x2f2c0C6e9D5dbD7F8e7B3a3B8b5f5BACE3e9E0c0', // Placeholder - use LINK as proxy
  EUR_USD: '0x1a81afB8146aeFfCFc5E50e8479e826E7D55b910',
  // EURC uses EUR/USD feed (EURC is a Euro stablecoin)
}

// ============ Aave V3 Sepolia Token Addresses ============
// Source: https://github.com/bgd-labs/aave-address-book/blob/main/src/AaveV3Sepolia.sol
const AAVE_SEPOLIA_TOKENS = {
  // Underlying tokens
  DAI: '0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357',
  USDC: '0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8',
  USDT: '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0',
  WETH: '0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c',
  WBTC: '0x29f2D40B0605204364af54EC677bD022dA425d03',
  LINK: '0xf8Fb3713D459D7C1018BD0A49D19b4C44290EBE5',
  AAVE: '0x88541670E55cC00bEEFD87eB59EDd1b7C511AC9a',
  EURS: '0x6d906e526a4e2Ca02097BA9d0caA3c382F52278E',
  // aTokens
  aDAI: '0x29598b72eb5CeBd806C5dCD549490FdA35B13cD8',
  aUSDC: '0x16dA4541aD1807f4443d92D26044C1147406EB80',
  aUSDT: '0xAF0F6e8b0Dc5c913bbF4d14c22B4E78Dd14310B6',
  aWETH: '0x5b071b590a59395fE4025A0Ccc1FcC931AAc1830',
  aWBTC: '0x1804Bf30507dc2EB3bDEbbbdd859991EAeF6EefF',
  aLINK: '0x3FfAf50D4F4E96eB78f2407c090b72e86eCaed24',
  aAAVE: '0x6b8558764d3b7572136F17174Cb9aB1DDc7E1259',
  aEURS: '0xB20691021F9AcED8631eDaa3c0Cd2949EB45662D',
}

// ============ Other Sepolia Token Addresses ============
const OTHER_SEPOLIA_TOKENS = {
  // Circle USDC (different from Aave USDC)
  USDC_CIRCLE: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  // EURC (Euro Coin by Circle)
  EURC: '0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4',
}

// Parse RPC URLs from environment (comma-separated for fallback support)
function parseRpcUrls(): string[] {
  const primary = process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com'
  const fallbacks = process.env.RPC_FALLBACK_URLS?.split(',').map(u => u.trim()).filter(Boolean) || []
  return [primary, ...fallbacks]
}

// Main configuration
export const config = {
  // Primary RPC URL (first in the list)
  rpcUrl: parseRpcUrls()[0],
  // All RPC URLs including fallbacks
  rpcUrls: parseRpcUrls(),
  privateKey: process.env.PRIVATE_KEY as `0x${string}`,
  moduleAddress: process.env.MODULE_ADDRESS as `0x${string}`,
  // Optional registry address for multi-module support
  registryAddress: process.env.REGISTRY_ADDRESS as `0x${string}` | undefined,

  // Cron schedules
  safeValueCron: process.env.SAFE_VALUE_CRON || '0 */10 * * * *', // Every 30 minutes
  spendingOracleCron: process.env.SPENDING_ORACLE_CRON || '0 */2 * * * *', // Every 5 minutes

  // Polling (15s default - slightly longer than Sepolia's ~12s block time)
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '15000'),
  blocksToLookBack: parseInt(process.env.BLOCKS_TO_LOOK_BACK || '7200'),
  windowDurationSeconds: parseInt(process.env.WINDOW_DURATION_SECONDS || '86400'),

  // Reorg protection: number of blocks to wait before considering a block finalized
  // Sepolia: 12 blocks (~2.4 min), Mainnet: 64 blocks (~12 min) recommended
  confirmationBlocks: parseInt(process.env.CONFIRMATION_BLOCKS || '12'),

  // Maximum blocks per log query to prevent RPC timeouts
  // Most RPCs limit to 2000-10000 blocks per request
  maxBlocksPerQuery: parseInt(process.env.MAX_BLOCKS_PER_QUERY || '5000'),

  // Maximum total blocks to search for historical tokens
  // Limits unbounded growth; set based on expected token lifetime
  // Default: ~30 days of blocks on Sepolia (7200 blocks/day * 30)
  maxHistoricalBlocks: parseInt(process.env.MAX_HISTORICAL_BLOCKS || '216000'),

  // Gas
  gasLimit: BigInt(process.env.GAS_LIMIT || '500000'),

  // Chain
  chain: sepolia,

  // Aave V3 Sepolia tokens to track for safe value calculation
  tokens: [
    // Underlying tokens
    {
      address: AAVE_SEPOLIA_TOKENS.WETH,
      priceFeedAddress: CHAINLINK_SEPOLIA.ETH_USD,
      symbol: 'WETH',
      type: 'erc20' as const,
    },
    {
      address: AAVE_SEPOLIA_TOKENS.WBTC,
      priceFeedAddress: CHAINLINK_SEPOLIA.BTC_USD,
      symbol: 'WBTC',
      type: 'erc20' as const,
    },
    {
      address: AAVE_SEPOLIA_TOKENS.USDC,
      priceFeedAddress: CHAINLINK_SEPOLIA.USDC_USD,
      symbol: 'USDC',
      type: 'erc20' as const,
    },
    {
      address: AAVE_SEPOLIA_TOKENS.DAI,
      priceFeedAddress: CHAINLINK_SEPOLIA.DAI_USD,
      symbol: 'DAI',
      type: 'erc20' as const,
    },
    {
      address: AAVE_SEPOLIA_TOKENS.USDT,
      priceFeedAddress: CHAINLINK_SEPOLIA.USDC_USD, // Use USDC feed as proxy for USDT
      symbol: 'USDT',
      type: 'erc20' as const,
    },
    {
      address: AAVE_SEPOLIA_TOKENS.LINK,
      priceFeedAddress: CHAINLINK_SEPOLIA.LINK_USD,
      symbol: 'LINK',
      type: 'erc20' as const,
    },
    {
      address: AAVE_SEPOLIA_TOKENS.AAVE,
      priceFeedAddress: CHAINLINK_SEPOLIA.LINK_USD, // Use LINK as proxy for AAVE (similar price range on testnet)
      symbol: 'AAVE',
      type: 'erc20' as const,
    },
    {
      address: AAVE_SEPOLIA_TOKENS.EURS,
      priceFeedAddress: CHAINLINK_SEPOLIA.EUR_USD,
      symbol: 'EURS',
      type: 'erc20' as const,
    },
    // aTokens (1:1 with underlying, use same price feeds)
    {
      address: AAVE_SEPOLIA_TOKENS.aWETH,
      priceFeedAddress: CHAINLINK_SEPOLIA.ETH_USD,
      symbol: 'aWETH',
      type: 'aave-atoken' as const,
    },
    {
      address: AAVE_SEPOLIA_TOKENS.aWBTC,
      priceFeedAddress: CHAINLINK_SEPOLIA.BTC_USD,
      symbol: 'aWBTC',
      type: 'aave-atoken' as const,
    },
    {
      address: AAVE_SEPOLIA_TOKENS.aUSDC,
      priceFeedAddress: CHAINLINK_SEPOLIA.USDC_USD,
      symbol: 'aUSDC',
      type: 'aave-atoken' as const,
    },
    {
      address: AAVE_SEPOLIA_TOKENS.aDAI,
      priceFeedAddress: CHAINLINK_SEPOLIA.DAI_USD,
      symbol: 'aDAI',
      type: 'aave-atoken' as const,
    },
    {
      address: AAVE_SEPOLIA_TOKENS.aUSDT,
      priceFeedAddress: CHAINLINK_SEPOLIA.USDC_USD,
      symbol: 'aUSDT',
      type: 'aave-atoken' as const,
    },
    {
      address: AAVE_SEPOLIA_TOKENS.aLINK,
      priceFeedAddress: CHAINLINK_SEPOLIA.LINK_USD,
      symbol: 'aLINK',
      type: 'aave-atoken' as const,
    },
    {
      address: AAVE_SEPOLIA_TOKENS.aAAVE,
      priceFeedAddress: CHAINLINK_SEPOLIA.LINK_USD,
      symbol: 'aAAVE',
      type: 'aave-atoken' as const,
    },
    {
      address: AAVE_SEPOLIA_TOKENS.aEURS,
      priceFeedAddress: CHAINLINK_SEPOLIA.EUR_USD,
      symbol: 'aEURS',
      type: 'aave-atoken' as const,
    },
    // ============ Other tokens in Safe ============
    // Circle USDC (different contract from Aave USDC)
    {
      address: OTHER_SEPOLIA_TOKENS.USDC_CIRCLE,
      priceFeedAddress: CHAINLINK_SEPOLIA.USDC_USD,
      symbol: 'USDC (Circle)',
      type: 'erc20' as const,
    },
    // EURC (Euro Coin by Circle)
    {
      address: OTHER_SEPOLIA_TOKENS.EURC,
      priceFeedAddress: CHAINLINK_SEPOLIA.EUR_USD,
      symbol: 'EURC',
      type: 'erc20' as const,
    },
  ] as TokenConfig[],
}

// Validate required config
export function validateConfig() {
  if (!config.privateKey) {
    throw new Error('PRIVATE_KEY environment variable is required')
  }
  if (!config.moduleAddress) {
    throw new Error('MODULE_ADDRESS environment variable is required')
  }
}
