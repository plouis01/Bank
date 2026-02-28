/**
 * Local Oracle Entry Point
 *
 * Runs both safe-value and spending-oracle locally.
 *
 * Usage:
 *   npm start           - Run both oracles
 *   npm run safe-value  - Run only safe-value oracle
 *   npm run spending-oracle - Run only spending oracle
 */

import { startCron as startSafeValue } from './safe-value.js'
import { start as startSpendingOracle } from './spending-oracle.js'
import { validateConfig } from './config.js'

function main() {
  console.log('===========================================')
  console.log('  S4b Local Oracle')
  console.log('===========================================')
  console.log('')

  try {
    validateConfig()
  } catch (error) {
    console.error('Configuration error:', error)
    console.error('')
    console.error('Please copy .env.example to .env and configure:')
    console.error('  - PRIVATE_KEY: Private key of the authorized updater')
    console.error('  - MODULE_ADDRESS: DeFiInteractor contract address')
    console.error('  - RPC_URL: Ethereum RPC URL')
    process.exit(1)
  }

  console.log('Starting Safe Value Oracle...')
  startSafeValue()

  console.log('')
  console.log('Starting Spending Oracle...')
  startSpendingOracle()

  console.log('')
  console.log('Both oracles are now running.')
  console.log('Press Ctrl+C to stop.')
}

main()
