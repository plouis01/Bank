/**
 * Comprehensive tests for the Spending Oracle
 *
 * Tests cover:
 * - FIFO queue operations (consume, add, get balance, prune)
 * - State building for various operation types
 * - Deposit/withdrawal matching
 * - Acquired token inheritance and expiry
 * - Spending tracking
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { Address } from 'viem'
import { formatUnits, parseUnits } from 'viem'
import { OperationType } from './abi.js'
import {
  consumeFromQueue,
  addToQueue,
  getValidQueueBalance,
  pruneExpiredEntries,
  buildSubAccountState,
  getTokenValueUSD,
  type AcquiredBalanceQueue,
  type AcquiredBalanceEntry,
  type ProtocolExecutionEvent,
  type TransferExecutedEvent,
  type TokenPriceCache,
} from './spending-oracle.js'

// ============ Test Constants ============

const SUB_ACCOUNT = '0x1234567890123456789012345678901234567890' as Address
const TARGET_AAVE = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa' as Address
const TARGET_UNISWAP = '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb' as Address
const TOKEN_LINK = '0x1111111111111111111111111111111111111111' as Address
const TOKEN_ALINK = '0x2222222222222222222222222222222222222222' as Address
const TOKEN_WETH = '0x3333333333333333333333333333333333333333' as Address
const TOKEN_USDC = '0x4444444444444444444444444444444444444444' as Address
const RECIPIENT = '0x5555555555555555555555555555555555555555' as Address

const ONE_DAY = 86400n
const WINDOW_DURATION = ONE_DAY

// Helper to create timestamps
const NOW = BigInt(Math.floor(Date.now() / 1000))
const HOUR_AGO = NOW - 3600n
const DAY_AGO = NOW - ONE_DAY
const TWO_DAYS_AGO = NOW - (ONE_DAY * 2n)

// ============ FIFO Queue Tests ============

describe('FIFO Queue Operations', () => {
  describe('addToQueue', () => {
    it('should add entry to empty queue', () => {
      const queue: AcquiredBalanceQueue = []
      addToQueue(queue, 100n, NOW)

      expect(queue).toHaveLength(1)
      expect(queue[0].amount).toBe(100n)
      expect(queue[0].originalTimestamp).toBe(NOW)
    })

    it('should add multiple entries preserving order', () => {
      const queue: AcquiredBalanceQueue = []
      addToQueue(queue, 100n, HOUR_AGO)
      addToQueue(queue, 200n, NOW)

      expect(queue).toHaveLength(2)
      expect(queue[0].amount).toBe(100n)
      expect(queue[0].originalTimestamp).toBe(HOUR_AGO)
      expect(queue[1].amount).toBe(200n)
      expect(queue[1].originalTimestamp).toBe(NOW)
    })

    it('should not add zero or negative amounts', () => {
      const queue: AcquiredBalanceQueue = []
      addToQueue(queue, 0n, NOW)
      addToQueue(queue, -100n, NOW)

      expect(queue).toHaveLength(0)
    })
  })

  describe('consumeFromQueue', () => {
    it('should consume from oldest entry first (FIFO)', () => {
      const queue: AcquiredBalanceQueue = [
        { amount: 100n, originalTimestamp: TWO_DAYS_AGO }, // Expired, skipped
        { amount: 200n, originalTimestamp: HOUR_AGO },     // Valid, consumed from
        { amount: 300n, originalTimestamp: NOW },          // Valid, not needed
      ]

      // TWO_DAYS_AGO is expired, so it should be skipped
      // HOUR_AGO has 200n which is enough for 150n
      const result = consumeFromQueue(queue, 150n, NOW, WINDOW_DURATION)

      // Should have consumed 150n from HOUR_AGO (which has 200n)
      expect(result.consumed).toHaveLength(1)
      expect(result.consumed[0].amount).toBe(150n)
      expect(result.consumed[0].originalTimestamp).toBe(HOUR_AGO)
      expect(result.remaining).toBe(0n)

      // Queue should have HOUR_AGO with 50n remaining, and NOW intact
      expect(queue).toHaveLength(2)
      expect(queue[0].amount).toBe(50n) // 200n - 150n
      expect(queue[0].originalTimestamp).toBe(HOUR_AGO)
      expect(queue[1].amount).toBe(300n)
    })

    it('should consume from multiple entries when needed', () => {
      const queue: AcquiredBalanceQueue = [
        { amount: 100n, originalTimestamp: HOUR_AGO },
        { amount: 200n, originalTimestamp: NOW },
      ]

      // Need 150n, first entry only has 100n
      const result = consumeFromQueue(queue, 150n, NOW, WINDOW_DURATION)

      // Should have consumed from both entries
      expect(result.consumed).toHaveLength(2)
      expect(result.consumed[0].amount).toBe(100n) // Full first entry
      expect(result.consumed[1].amount).toBe(50n)  // Partial second entry
      expect(result.remaining).toBe(0n)

      // Queue should have reduced NOW entry
      expect(queue).toHaveLength(1)
      expect(queue[0].amount).toBe(150n) // 200n - 50n
    })

    it('should skip expired entries', () => {
      const queue: AcquiredBalanceQueue = [
        { amount: 100n, originalTimestamp: TWO_DAYS_AGO }, // Expired
        { amount: 200n, originalTimestamp: HOUR_AGO },      // Valid
      ]

      const result = consumeFromQueue(queue, 50n, NOW, WINDOW_DURATION)

      // Should skip expired entry and consume from valid one
      expect(result.consumed).toHaveLength(1)
      expect(result.consumed[0].amount).toBe(50n)
      expect(result.consumed[0].originalTimestamp).toBe(HOUR_AGO)
      expect(result.remaining).toBe(0n)
    })

    it('should return remaining when queue is exhausted', () => {
      const queue: AcquiredBalanceQueue = [
        { amount: 100n, originalTimestamp: HOUR_AGO },
      ]

      const result = consumeFromQueue(queue, 150n, NOW, WINDOW_DURATION)

      expect(result.consumed).toHaveLength(1)
      expect(result.consumed[0].amount).toBe(100n)
      expect(result.remaining).toBe(50n)
      expect(queue).toHaveLength(0)
    })

    it('should handle partial consumption of entry', () => {
      const queue: AcquiredBalanceQueue = [
        { amount: 100n, originalTimestamp: HOUR_AGO },
      ]

      const result = consumeFromQueue(queue, 30n, NOW, WINDOW_DURATION)

      expect(result.consumed).toHaveLength(1)
      expect(result.consumed[0].amount).toBe(30n)
      expect(result.remaining).toBe(0n)
      expect(queue).toHaveLength(1)
      expect(queue[0].amount).toBe(70n) // 100 - 30
    })

    it('should handle empty queue', () => {
      const queue: AcquiredBalanceQueue = []

      const result = consumeFromQueue(queue, 100n, NOW, WINDOW_DURATION)

      expect(result.consumed).toHaveLength(0)
      expect(result.remaining).toBe(100n)
    })
  })

  describe('getValidQueueBalance', () => {
    it('should sum only non-expired entries', () => {
      const queue: AcquiredBalanceQueue = [
        { amount: 100n, originalTimestamp: TWO_DAYS_AGO }, // Expired
        { amount: 200n, originalTimestamp: HOUR_AGO },      // Valid
        { amount: 300n, originalTimestamp: NOW },           // Valid
      ]

      const balance = getValidQueueBalance(queue, NOW, WINDOW_DURATION)

      expect(balance).toBe(500n) // 200 + 300
    })

    it('should return 0 for empty queue', () => {
      const queue: AcquiredBalanceQueue = []

      const balance = getValidQueueBalance(queue, NOW, WINDOW_DURATION)

      expect(balance).toBe(0n)
    })

    it('should return 0 when all entries expired', () => {
      const queue: AcquiredBalanceQueue = [
        { amount: 100n, originalTimestamp: TWO_DAYS_AGO },
        { amount: 200n, originalTimestamp: TWO_DAYS_AGO - 3600n },
      ]

      const balance = getValidQueueBalance(queue, NOW, WINDOW_DURATION)

      expect(balance).toBe(0n)
    })
  })

  describe('pruneExpiredEntries', () => {
    it('should remove expired entries from front of queue', () => {
      const queue: AcquiredBalanceQueue = [
        { amount: 100n, originalTimestamp: TWO_DAYS_AGO },
        { amount: 200n, originalTimestamp: TWO_DAYS_AGO - 3600n },
        { amount: 300n, originalTimestamp: HOUR_AGO },
        { amount: 400n, originalTimestamp: NOW },
      ]

      pruneExpiredEntries(queue, NOW, WINDOW_DURATION)

      expect(queue).toHaveLength(2)
      expect(queue[0].amount).toBe(300n)
      expect(queue[1].amount).toBe(400n)
    })

    it('should handle queue with no expired entries', () => {
      const queue: AcquiredBalanceQueue = [
        { amount: 100n, originalTimestamp: HOUR_AGO },
        { amount: 200n, originalTimestamp: NOW },
      ]

      pruneExpiredEntries(queue, NOW, WINDOW_DURATION)

      expect(queue).toHaveLength(2)
    })

    it('should handle empty queue', () => {
      const queue: AcquiredBalanceQueue = []

      pruneExpiredEntries(queue, NOW, WINDOW_DURATION)

      expect(queue).toHaveLength(0)
    })

    it('should remove expired entries from unsorted queue (middle/end)', () => {
      // This tests the fix for queues that aren't sorted by timestamp
      // E.g., swaps can produce entries where inherited tokens (older) come after new ones
      const queue: AcquiredBalanceQueue = [
        { amount: 100n, originalTimestamp: HOUR_AGO },       // Valid (front)
        { amount: 200n, originalTimestamp: TWO_DAYS_AGO },   // Expired (middle)
        { amount: 300n, originalTimestamp: NOW },            // Valid
        { amount: 400n, originalTimestamp: TWO_DAYS_AGO - 3600n }, // Expired (end)
        { amount: 500n, originalTimestamp: HOUR_AGO - 60n }, // Valid
      ]

      pruneExpiredEntries(queue, NOW, WINDOW_DURATION)

      // Should only have 3 valid entries left
      expect(queue).toHaveLength(3)
      expect(queue[0].amount).toBe(100n)
      expect(queue[1].amount).toBe(300n)
      expect(queue[2].amount).toBe(500n)
    })

    it('should handle queue where all entries are expired', () => {
      const queue: AcquiredBalanceQueue = [
        { amount: 100n, originalTimestamp: TWO_DAYS_AGO },
        { amount: 200n, originalTimestamp: TWO_DAYS_AGO - 3600n },
      ]

      pruneExpiredEntries(queue, NOW, WINDOW_DURATION)

      expect(queue).toHaveLength(0)
    })
  })
})

// ============ State Building Tests ============

describe('buildSubAccountState', () => {
  // Helper to create protocol events
  function createProtocolEvent(
    overrides: Partial<ProtocolExecutionEvent>
  ): ProtocolExecutionEvent {
    return {
      subAccount: SUB_ACCOUNT,
      target: TARGET_AAVE,
      opType: OperationType.SWAP,
      tokensIn: [TOKEN_LINK],
      amountsIn: [100n],
      tokensOut: [TOKEN_WETH],
      amountsOut: [50n],
      spendingCost: 10n,
      timestamp: HOUR_AGO,
      blockNumber: 1000n,
      logIndex: 0,
      ...overrides,
    }
  }

  // Helper to create transfer events
  function createTransferEvent(
    overrides: Partial<TransferExecutedEvent>
  ): TransferExecutedEvent {
    return {
      subAccount: SUB_ACCOUNT,
      token: TOKEN_LINK,
      recipient: RECIPIENT,
      amount: 50n,
      spendingCost: 5n,
      timestamp: HOUR_AGO,
      blockNumber: 1000n,
      logIndex: 0,
      ...overrides,
    }
  }

  describe('SWAP operations', () => {
    it('should mark output tokens as newly acquired for non-acquired input', () => {
      const events = [
        createProtocolEvent({
          opType: OperationType.SWAP,
          tokensIn: [TOKEN_LINK],
          amountsIn: [100n],
          tokensOut: [TOKEN_WETH],
          amountsOut: [50n],
          timestamp: HOUR_AGO,
        }),
      ]

      const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

      // Output token should be acquired with the swap timestamp
      expect(state.acquiredBalances.get(TOKEN_WETH.toLowerCase() as Address)).toBe(50n)
    })

    it('should inherit timestamp when swapping acquired tokens', () => {
      // First swap creates acquired tokens at HOUR_AGO
      // Second swap uses those tokens - output should inherit HOUR_AGO timestamp
      const events = [
        createProtocolEvent({
          opType: OperationType.SWAP,
          tokensIn: [TOKEN_LINK],
          amountsIn: [100n],
          tokensOut: [TOKEN_WETH],
          amountsOut: [50n],
          timestamp: HOUR_AGO,
        }),
        createProtocolEvent({
          opType: OperationType.SWAP,
          tokensIn: [TOKEN_WETH],
          amountsIn: [50n],
          tokensOut: [TOKEN_USDC],
          amountsOut: [100n],
          timestamp: NOW,
          blockNumber: 1001n,
          logIndex: 1,
        }),
      ]

      const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

      // WETH should be consumed, USDC should be acquired
      expect(state.acquiredBalances.get(TOKEN_WETH.toLowerCase() as Address)).toBeUndefined()
      expect(state.acquiredBalances.get(TOKEN_USDC.toLowerCase() as Address)).toBe(100n)

      // Check the queue to verify timestamp inheritance
      const usdcQueue = state.acquiredQueues.get(TOKEN_USDC.toLowerCase() as Address)
      expect(usdcQueue).toBeDefined()
      expect(usdcQueue![0].originalTimestamp).toBe(HOUR_AGO) // Inherited from WETH
    })

    it('should track spending cost for SWAP', () => {
      const events = [
        createProtocolEvent({
          opType: OperationType.SWAP,
          spendingCost: 100n,
          timestamp: HOUR_AGO, // Within window
        }),
      ]

      const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

      expect(state.totalSpendingInWindow).toBe(100n)
      expect(state.spendingRecords).toHaveLength(1)
    })

    it('should not track spending outside window', () => {
      const events = [
        createProtocolEvent({
          opType: OperationType.SWAP,
          spendingCost: 100n,
          timestamp: TWO_DAYS_AGO, // Outside window
        }),
      ]

      const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

      expect(state.totalSpendingInWindow).toBe(0n)
    })
  })

  describe('DEPOSIT operations', () => {
    it('should track deposit record with input and output tokens', () => {
      const events = [
        createProtocolEvent({
          opType: OperationType.DEPOSIT,
          target: TARGET_AAVE,
          tokensIn: [TOKEN_LINK],
          amountsIn: [100n],
          tokensOut: [TOKEN_ALINK],
          amountsOut: [100n],
          spendingCost: 10n,
          timestamp: HOUR_AGO,
        }),
      ]

      const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

      // Should have created a deposit record
      expect(state.depositRecords).toHaveLength(1)
      expect(state.depositRecords[0].tokenIn).toBe(TOKEN_LINK)
      expect(state.depositRecords[0].tokenOut).toBe(TOKEN_ALINK)
      expect(state.depositRecords[0].amountIn).toBe(100n)
      expect(state.depositRecords[0].amountOut).toBe(100n)
      expect(state.depositRecords[0].remainingAmount).toBe(100n)
      expect(state.depositRecords[0].remainingOutputAmount).toBe(100n)

      // aLINK should be marked as acquired
      expect(state.acquiredBalances.get(TOKEN_ALINK.toLowerCase() as Address)).toBe(100n)
    })

    it('should inherit timestamp from acquired input for deposit output', () => {
      // First swap creates acquired LINK at HOUR_AGO
      // Then deposit that LINK - aLINK should inherit HOUR_AGO
      const events = [
        createProtocolEvent({
          opType: OperationType.SWAP,
          tokensIn: [TOKEN_WETH],
          amountsIn: [1n],
          tokensOut: [TOKEN_LINK],
          amountsOut: [100n],
          timestamp: HOUR_AGO,
          blockNumber: 1000n,
        }),
        createProtocolEvent({
          opType: OperationType.DEPOSIT,
          target: TARGET_AAVE,
          tokensIn: [TOKEN_LINK],
          amountsIn: [100n],
          tokensOut: [TOKEN_ALINK],
          amountsOut: [100n],
          spendingCost: 0n, // Deposit of acquired tokens shouldn't have spending cost
          timestamp: NOW,
          blockNumber: 1001n,
        }),
      ]

      const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

      // Check that aLINK inherited the HOUR_AGO timestamp
      const aLinkQueue = state.acquiredQueues.get(TOKEN_ALINK.toLowerCase() as Address)
      expect(aLinkQueue).toBeDefined()
      expect(aLinkQueue![0].originalTimestamp).toBe(HOUR_AGO)

      // Deposit record should also have the original timestamp
      expect(state.depositRecords[0].originalAcquisitionTimestamp).toBe(HOUR_AGO)
    })
  })

  describe('WITHDRAW operations', () => {
    it('should match withdraw to deposit and inherit original timestamp', () => {
      const events = [
        // First: acquire LINK via swap
        createProtocolEvent({
          opType: OperationType.SWAP,
          tokensIn: [TOKEN_WETH],
          amountsIn: [1n],
          tokensOut: [TOKEN_LINK],
          amountsOut: [100n],
          spendingCost: 10n,
          timestamp: HOUR_AGO,
          blockNumber: 1000n,
        }),
        // Then: deposit LINK into AAVE
        createProtocolEvent({
          opType: OperationType.DEPOSIT,
          target: TARGET_AAVE,
          tokensIn: [TOKEN_LINK],
          amountsIn: [100n],
          tokensOut: [TOKEN_ALINK],
          amountsOut: [100n],
          spendingCost: 0n,
          timestamp: HOUR_AGO + 100n,
          blockNumber: 1001n,
        }),
        // Finally: withdraw LINK from AAVE
        createProtocolEvent({
          opType: OperationType.WITHDRAW,
          target: TARGET_AAVE,
          tokensIn: [],
          amountsIn: [],
          tokensOut: [TOKEN_LINK],
          amountsOut: [100n],
          spendingCost: 0n,
          timestamp: NOW,
          blockNumber: 1002n,
        }),
      ]

      const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

      // LINK should be acquired with inherited timestamp
      expect(state.acquiredBalances.get(TOKEN_LINK.toLowerCase() as Address)).toBe(100n)

      // Check that LINK inherited the original HOUR_AGO timestamp (from the original swap)
      const linkQueue = state.acquiredQueues.get(TOKEN_LINK.toLowerCase() as Address)
      expect(linkQueue).toBeDefined()
      expect(linkQueue![0].originalTimestamp).toBe(HOUR_AGO)
    })

    it('should consume deposit output tokens (aTokens) on withdraw', () => {
      const events = [
        // Deposit LINK into AAVE, get aLINK
        createProtocolEvent({
          opType: OperationType.DEPOSIT,
          target: TARGET_AAVE,
          tokensIn: [TOKEN_LINK],
          amountsIn: [100n],
          tokensOut: [TOKEN_ALINK],
          amountsOut: [100n],
          timestamp: HOUR_AGO,
          blockNumber: 1000n,
        }),
        // Withdraw LINK from AAVE
        createProtocolEvent({
          opType: OperationType.WITHDRAW,
          target: TARGET_AAVE,
          tokensIn: [],
          amountsIn: [],
          tokensOut: [TOKEN_LINK],
          amountsOut: [100n],
          timestamp: NOW,
          blockNumber: 1001n,
        }),
      ]

      const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

      // aLINK should have been consumed (balance = 0 or undefined)
      const aLinkBalance = state.acquiredBalances.get(TOKEN_ALINK.toLowerCase() as Address)
      expect(aLinkBalance).toBeUndefined()

      // LINK should be acquired
      expect(state.acquiredBalances.get(TOKEN_LINK.toLowerCase() as Address)).toBe(100n)
    })

    it('should NOT mark unmatched withdraw as acquired', () => {
      // Withdraw without prior deposit - tokens belong to multisig
      const events = [
        createProtocolEvent({
          opType: OperationType.WITHDRAW,
          target: TARGET_AAVE,
          tokensIn: [],
          amountsIn: [],
          tokensOut: [TOKEN_LINK],
          amountsOut: [100n],
          timestamp: NOW,
        }),
      ]

      const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

      // LINK should NOT be acquired (no matching deposit)
      expect(state.acquiredBalances.get(TOKEN_LINK.toLowerCase() as Address)).toBeUndefined()
    })

    it('should handle partial withdraw matching', () => {
      const events = [
        // Deposit 100 LINK
        createProtocolEvent({
          opType: OperationType.DEPOSIT,
          target: TARGET_AAVE,
          tokensIn: [TOKEN_LINK],
          amountsIn: [100n],
          tokensOut: [TOKEN_ALINK],
          amountsOut: [100n],
          timestamp: HOUR_AGO,
          blockNumber: 1000n,
        }),
        // Withdraw only 50 LINK
        createProtocolEvent({
          opType: OperationType.WITHDRAW,
          target: TARGET_AAVE,
          tokensIn: [],
          amountsIn: [],
          tokensOut: [TOKEN_LINK],
          amountsOut: [50n],
          timestamp: NOW,
          blockNumber: 1001n,
        }),
      ]

      const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

      // 50 LINK should be acquired
      expect(state.acquiredBalances.get(TOKEN_LINK.toLowerCase() as Address)).toBe(50n)

      // 50 aLINK should remain acquired
      expect(state.acquiredBalances.get(TOKEN_ALINK.toLowerCase() as Address)).toBe(50n)

      // Deposit record should have 50 remaining
      expect(state.depositRecords[0].remainingAmount).toBe(50n)
    })
  })

  describe('CLAIM operations', () => {
    it('should mark CLAIM as acquired if matching deposit exists', () => {
      const events = [
        // First deposit to establish position
        createProtocolEvent({
          opType: OperationType.DEPOSIT,
          target: TARGET_AAVE,
          tokensIn: [TOKEN_LINK],
          amountsIn: [100n],
          tokensOut: [TOKEN_ALINK],
          amountsOut: [100n],
          timestamp: HOUR_AGO,
          blockNumber: 1000n,
        }),
        // Then claim rewards from same target
        createProtocolEvent({
          opType: OperationType.CLAIM,
          target: TARGET_AAVE,
          tokensIn: [],
          amountsIn: [],
          tokensOut: [TOKEN_WETH],
          amountsOut: [10n],
          spendingCost: 0n,
          timestamp: NOW,
          blockNumber: 1001n,
        }),
      ]

      const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

      // WETH rewards should be acquired
      expect(state.acquiredBalances.get(TOKEN_WETH.toLowerCase() as Address)).toBe(10n)
    })

    it('should NOT mark CLAIM as acquired if no matching deposit', () => {
      // Claim from a protocol where subaccount never deposited
      const events = [
        createProtocolEvent({
          opType: OperationType.CLAIM,
          target: TARGET_AAVE,
          tokensIn: [],
          amountsIn: [],
          tokensOut: [TOKEN_WETH],
          amountsOut: [10n],
          timestamp: NOW,
        }),
      ]

      const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

      // WETH should NOT be acquired (no deposit at that target)
      expect(state.acquiredBalances.get(TOKEN_WETH.toLowerCase() as Address)).toBeUndefined()
    })

    it('should inherit oldest deposit timestamp for CLAIM', () => {
      const events = [
        // Deposit at HOUR_AGO
        createProtocolEvent({
          opType: OperationType.DEPOSIT,
          target: TARGET_AAVE,
          tokensIn: [TOKEN_LINK],
          amountsIn: [100n],
          tokensOut: [TOKEN_ALINK],
          amountsOut: [100n],
          timestamp: HOUR_AGO,
          blockNumber: 1000n,
        }),
        // Claim at NOW
        createProtocolEvent({
          opType: OperationType.CLAIM,
          target: TARGET_AAVE,
          tokensIn: [],
          amountsIn: [],
          tokensOut: [TOKEN_WETH],
          amountsOut: [10n],
          timestamp: NOW,
          blockNumber: 1001n,
        }),
      ]

      const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

      // Check that claim output inherited deposit timestamp
      const wethQueue = state.acquiredQueues.get(TOKEN_WETH.toLowerCase() as Address)
      expect(wethQueue).toBeDefined()
      expect(wethQueue![0].originalTimestamp).toBe(HOUR_AGO)
    })
  })

  describe('Transfer operations', () => {
    it('should consume acquired tokens on transfer', () => {
      const protocolEvents = [
        // First acquire tokens via swap
        createProtocolEvent({
          opType: OperationType.SWAP,
          tokensIn: [TOKEN_WETH],
          amountsIn: [1n],
          tokensOut: [TOKEN_LINK],
          amountsOut: [100n],
          timestamp: HOUR_AGO,
          blockNumber: 1000n,
        }),
      ]

      const transferEvents = [
        createTransferEvent({
          token: TOKEN_LINK,
          amount: 30n,
          spendingCost: 5n,
          timestamp: NOW,
          blockNumber: 1001n,
        }),
      ]

      const state = buildSubAccountState(protocolEvents, transferEvents, SUB_ACCOUNT, NOW, WINDOW_DURATION)

      // 70 LINK should remain acquired (100 - 30)
      expect(state.acquiredBalances.get(TOKEN_LINK.toLowerCase() as Address)).toBe(70n)
    })

    it('should track spending cost for transfers', () => {
      const transferEvents = [
        createTransferEvent({
          token: TOKEN_LINK,
          amount: 50n,
          spendingCost: 100n,
          timestamp: HOUR_AGO,
        }),
      ]

      const state = buildSubAccountState([], transferEvents, SUB_ACCOUNT, NOW, WINDOW_DURATION)

      expect(state.totalSpendingInWindow).toBe(100n)
    })
  })

  describe('Multi-token operations', () => {
    it('should handle multi-token DEPOSIT (LP positions)', () => {
      const events = [
        createProtocolEvent({
          opType: OperationType.DEPOSIT,
          target: TARGET_UNISWAP,
          tokensIn: [TOKEN_LINK, TOKEN_WETH],
          amountsIn: [100n, 50n],
          tokensOut: [TOKEN_USDC], // LP token
          amountsOut: [1000n],
          timestamp: HOUR_AGO,
        }),
      ]

      const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

      // Should have deposit records for each input token
      expect(state.depositRecords).toHaveLength(2)

      // LP token should be acquired
      expect(state.acquiredBalances.get(TOKEN_USDC.toLowerCase() as Address)).toBe(1000n)
    })

    it('should handle multi-token output (WITHDRAW from LP)', () => {
      const events = [
        // Deposit to create LP
        createProtocolEvent({
          opType: OperationType.DEPOSIT,
          target: TARGET_UNISWAP,
          tokensIn: [TOKEN_LINK],
          amountsIn: [100n],
          tokensOut: [TOKEN_USDC], // LP token
          amountsOut: [1000n],
          timestamp: HOUR_AGO,
          blockNumber: 1000n,
        }),
        // Withdraw returns both tokens
        createProtocolEvent({
          opType: OperationType.WITHDRAW,
          target: TARGET_UNISWAP,
          tokensIn: [],
          amountsIn: [],
          tokensOut: [TOKEN_LINK, TOKEN_WETH],
          amountsOut: [100n, 50n],
          timestamp: NOW,
          blockNumber: 1001n,
        }),
      ]

      const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

      // LINK should be acquired (matched to deposit)
      expect(state.acquiredBalances.get(TOKEN_LINK.toLowerCase() as Address)).toBe(100n)

      // WETH should NOT be acquired (no matching deposit for WETH input)
      expect(state.acquiredBalances.get(TOKEN_WETH.toLowerCase() as Address)).toBeUndefined()
    })
  })

  describe('Expiry handling', () => {
    it('should not count expired acquired tokens in balance', () => {
      const events = [
        // Swap 2 days ago (outside window)
        createProtocolEvent({
          opType: OperationType.SWAP,
          tokensIn: [TOKEN_WETH],
          amountsIn: [1n],
          tokensOut: [TOKEN_LINK],
          amountsOut: [100n],
          timestamp: TWO_DAYS_AGO,
          blockNumber: 1000n,
        }),
      ]

      const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

      // LINK should NOT be in acquired balance (expired)
      expect(state.acquiredBalances.get(TOKEN_LINK.toLowerCase() as Address)).toBeUndefined()
    })

    it('should handle mix of expired and valid acquired tokens', () => {
      const events = [
        // Swap 2 days ago (expired)
        createProtocolEvent({
          opType: OperationType.SWAP,
          tokensIn: [TOKEN_WETH],
          amountsIn: [1n],
          tokensOut: [TOKEN_LINK],
          amountsOut: [100n],
          timestamp: TWO_DAYS_AGO,
          blockNumber: 1000n,
        }),
        // Swap 1 hour ago (valid)
        createProtocolEvent({
          opType: OperationType.SWAP,
          tokensIn: [TOKEN_USDC],
          amountsIn: [50n],
          tokensOut: [TOKEN_LINK],
          amountsOut: [50n],
          timestamp: HOUR_AGO,
          blockNumber: 1001n,
        }),
      ]

      const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

      // Only 50 LINK should be acquired (the valid one)
      expect(state.acquiredBalances.get(TOKEN_LINK.toLowerCase() as Address)).toBe(50n)
    })
  })

  describe('Chronological ordering', () => {
    it('should process events in timestamp order', () => {
      // Events provided in wrong order
      const events = [
        createProtocolEvent({
          opType: OperationType.SWAP,
          tokensIn: [TOKEN_LINK],
          amountsIn: [50n],
          tokensOut: [TOKEN_USDC],
          amountsOut: [50n],
          timestamp: NOW, // Later
          blockNumber: 1001n,
          logIndex: 1,
        }),
        createProtocolEvent({
          opType: OperationType.SWAP,
          tokensIn: [TOKEN_WETH],
          amountsIn: [1n],
          tokensOut: [TOKEN_LINK],
          amountsOut: [100n],
          timestamp: HOUR_AGO, // Earlier
          blockNumber: 1000n,
          logIndex: 0,
        }),
      ]

      const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

      // Should process HOUR_AGO first (creates 100 LINK)
      // Then NOW (consumes 50 LINK, creates 50 USDC)
      // Result: 50 LINK + 50 USDC
      expect(state.acquiredBalances.get(TOKEN_LINK.toLowerCase() as Address)).toBe(50n)
      expect(state.acquiredBalances.get(TOKEN_USDC.toLowerCase() as Address)).toBe(50n)
    })

    it('should use log index for same-block ordering', () => {
      const events = [
        createProtocolEvent({
          opType: OperationType.SWAP,
          tokensIn: [TOKEN_LINK],
          amountsIn: [50n],
          tokensOut: [TOKEN_USDC],
          amountsOut: [50n],
          timestamp: HOUR_AGO,
          blockNumber: 1000n,
          logIndex: 1, // Later in block
        }),
        createProtocolEvent({
          opType: OperationType.SWAP,
          tokensIn: [TOKEN_WETH],
          amountsIn: [1n],
          tokensOut: [TOKEN_LINK],
          amountsOut: [100n],
          timestamp: HOUR_AGO,
          blockNumber: 1000n,
          logIndex: 0, // Earlier in block
        }),
      ]

      const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

      // Should process logIndex 0 first (creates 100 LINK)
      // Then logIndex 1 (consumes 50 LINK, creates 50 USDC)
      expect(state.acquiredBalances.get(TOKEN_LINK.toLowerCase() as Address)).toBe(50n)
      expect(state.acquiredBalances.get(TOKEN_USDC.toLowerCase() as Address)).toBe(50n)
    })
  })

  describe('Edge cases', () => {
    it('should handle empty events', () => {
      const state = buildSubAccountState([], [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

      expect(state.totalSpendingInWindow).toBe(0n)
      expect(state.acquiredBalances.size).toBe(0)
      expect(state.depositRecords).toHaveLength(0)
    })

    it('should filter events by subaccount', () => {
      const otherSubAccount = '0x9999999999999999999999999999999999999999' as Address

      const events = [
        createProtocolEvent({
          subAccount: SUB_ACCOUNT,
          tokensOut: [TOKEN_LINK],
          amountsOut: [100n],
        }),
        createProtocolEvent({
          subAccount: otherSubAccount,
          tokensOut: [TOKEN_WETH],
          amountsOut: [200n],
        }),
      ]

      const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

      // Should only have LINK from SUB_ACCOUNT
      expect(state.acquiredBalances.get(TOKEN_LINK.toLowerCase() as Address)).toBe(100n)
      expect(state.acquiredBalances.get(TOKEN_WETH.toLowerCase() as Address)).toBeUndefined()
    })

    it('should handle zero amounts gracefully', () => {
      const events = [
        createProtocolEvent({
          opType: OperationType.SWAP,
          tokensIn: [TOKEN_WETH],
          amountsIn: [0n],
          tokensOut: [TOKEN_LINK],
          amountsOut: [0n],
        }),
      ]

      const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

      // Should not create acquired balance for zero amount
      expect(state.acquiredBalances.size).toBe(0)
    })
  })
})

// ============ Mixed Acquisition Tests ============

describe('Mixed acquisition scenarios', () => {
  function createProtocolEvent(
    overrides: Partial<ProtocolExecutionEvent>
  ): ProtocolExecutionEvent {
    return {
      subAccount: SUB_ACCOUNT,
      target: TARGET_AAVE,
      opType: OperationType.SWAP,
      tokensIn: [TOKEN_LINK],
      amountsIn: [100n],
      tokensOut: [TOKEN_WETH],
      amountsOut: [50n],
      spendingCost: 10n,
      timestamp: HOUR_AGO,
      blockNumber: 1000n,
      logIndex: 0,
      ...overrides,
    }
  }

  it('should proportionally split output when mixing acquired and non-acquired input', () => {
    const events = [
      // First: acquire 50 LINK
      createProtocolEvent({
        opType: OperationType.SWAP,
        tokensIn: [TOKEN_WETH],
        amountsIn: [1n],
        tokensOut: [TOKEN_LINK],
        amountsOut: [50n],
        timestamp: HOUR_AGO,
        blockNumber: 1000n,
      }),
      // Then: swap 100 LINK (50 acquired + 50 from multisig)
      createProtocolEvent({
        opType: OperationType.SWAP,
        tokensIn: [TOKEN_LINK],
        amountsIn: [100n], // 50% from acquired, 50% from multisig
        tokensOut: [TOKEN_USDC],
        amountsOut: [200n],
        timestamp: NOW,
        blockNumber: 1001n,
      }),
    ]

    const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

    // USDC should be acquired proportionally:
    // 50% inherits HOUR_AGO timestamp, 50% is newly acquired at NOW
    const usdcQueue = state.acquiredQueues.get(TOKEN_USDC.toLowerCase() as Address)
    expect(usdcQueue).toBeDefined()
    expect(usdcQueue!.length).toBe(2)

    // Total should be 200
    expect(state.acquiredBalances.get(TOKEN_USDC.toLowerCase() as Address)).toBe(200n)
  })
})

// ============ Complex Scenario Tests ============

describe('Complex real-world scenarios', () => {
  function createProtocolEvent(
    overrides: Partial<ProtocolExecutionEvent>
  ): ProtocolExecutionEvent {
    return {
      subAccount: SUB_ACCOUNT,
      target: TARGET_AAVE,
      opType: OperationType.SWAP,
      tokensIn: [TOKEN_LINK],
      amountsIn: [100n],
      tokensOut: [TOKEN_WETH],
      amountsOut: [50n],
      spendingCost: 10n,
      timestamp: HOUR_AGO,
      blockNumber: 1000n,
      logIndex: 0,
      ...overrides,
    }
  }

  function createTransferEvent(
    overrides: Partial<TransferExecutedEvent>
  ): TransferExecutedEvent {
    return {
      subAccount: SUB_ACCOUNT,
      token: TOKEN_LINK,
      recipient: RECIPIENT,
      amount: 50n,
      spendingCost: 5n,
      timestamp: HOUR_AGO,
      blockNumber: 1000n,
      logIndex: 0,
      ...overrides,
    }
  }

  describe('DeFi yield farming scenario', () => {
    it('should track full deposit -> earn rewards -> withdraw cycle', () => {
      const events = [
        // 1. Swap ETH for LINK (acquire 100 LINK)
        createProtocolEvent({
          opType: OperationType.SWAP,
          tokensIn: [TOKEN_WETH],
          amountsIn: [5n],
          tokensOut: [TOKEN_LINK],
          amountsOut: [100n],
          spendingCost: 50n,
          timestamp: HOUR_AGO,
          blockNumber: 1000n,
        }),
        // 2. Deposit LINK into AAVE (get 100 aLINK)
        createProtocolEvent({
          opType: OperationType.DEPOSIT,
          target: TARGET_AAVE,
          tokensIn: [TOKEN_LINK],
          amountsIn: [100n],
          tokensOut: [TOKEN_ALINK],
          amountsOut: [100n],
          spendingCost: 0n,
          timestamp: HOUR_AGO + 60n,
          blockNumber: 1001n,
        }),
        // 3. Claim rewards (get 5 WETH rewards)
        createProtocolEvent({
          opType: OperationType.CLAIM,
          target: TARGET_AAVE,
          tokensIn: [],
          amountsIn: [],
          tokensOut: [TOKEN_WETH],
          amountsOut: [5n],
          spendingCost: 0n,
          timestamp: HOUR_AGO + 120n,
          blockNumber: 1002n,
        }),
        // 4. Withdraw LINK from AAVE (105 LINK due to interest)
        createProtocolEvent({
          opType: OperationType.WITHDRAW,
          target: TARGET_AAVE,
          tokensIn: [],
          amountsIn: [],
          tokensOut: [TOKEN_LINK],
          amountsOut: [105n],
          spendingCost: 0n,
          timestamp: NOW,
          blockNumber: 1003n,
        }),
      ]

      const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

      // aLINK should be consumed (balance = 0 or undefined)
      expect(state.acquiredBalances.get(TOKEN_ALINK.toLowerCase() as Address)).toBeUndefined()

      // LINK should be acquired (matched portion from deposit)
      // The deposit was 100, withdraw is 105, so 100 is matched, 5 is unmatched
      expect(state.acquiredBalances.get(TOKEN_LINK.toLowerCase() as Address)).toBe(100n)

      // WETH rewards should be acquired (has matching deposit at target)
      expect(state.acquiredBalances.get(TOKEN_WETH.toLowerCase() as Address)).toBe(5n)

      // Total spending should be 50 (from the initial swap)
      expect(state.totalSpendingInWindow).toBe(50n)
    })
  })

  describe('Multiple deposits and partial withdrawals', () => {
    it('should handle FIFO matching for multiple deposits', () => {
      const events = [
        // Deposit 1: 50 LINK at HOUR_AGO
        createProtocolEvent({
          opType: OperationType.DEPOSIT,
          target: TARGET_AAVE,
          tokensIn: [TOKEN_LINK],
          amountsIn: [50n],
          tokensOut: [TOKEN_ALINK],
          amountsOut: [50n],
          timestamp: HOUR_AGO,
          blockNumber: 1000n,
        }),
        // Deposit 2: 75 LINK at HOUR_AGO + 60
        createProtocolEvent({
          opType: OperationType.DEPOSIT,
          target: TARGET_AAVE,
          tokensIn: [TOKEN_LINK],
          amountsIn: [75n],
          tokensOut: [TOKEN_ALINK],
          amountsOut: [75n],
          timestamp: HOUR_AGO + 60n,
          blockNumber: 1001n,
        }),
        // Withdraw 80 LINK (should match 50 from deposit 1, 30 from deposit 2)
        createProtocolEvent({
          opType: OperationType.WITHDRAW,
          target: TARGET_AAVE,
          tokensIn: [],
          amountsIn: [],
          tokensOut: [TOKEN_LINK],
          amountsOut: [80n],
          spendingCost: 0n,
          timestamp: NOW,
          blockNumber: 1002n,
        }),
      ]

      const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

      // LINK should be acquired (80 withdrawn, 80 matched from deposits)
      expect(state.acquiredBalances.get(TOKEN_LINK.toLowerCase() as Address)).toBe(80n)

      // aLINK should have 45 remaining (125 - 80)
      expect(state.acquiredBalances.get(TOKEN_ALINK.toLowerCase() as Address)).toBe(45n)

      // Deposit records should show remaining amounts
      expect(state.depositRecords[0].remainingAmount).toBe(0n) // First deposit fully consumed
      expect(state.depositRecords[1].remainingAmount).toBe(45n) // Second deposit partially consumed
    })

    it('should handle withdrawal when output tokens have expired', () => {
      // Scenario: Deposit aTokens, wait for them to expire, then withdraw
      // The deposit record should only reduce by actual consumed amount from queue
      const events = [
        // Deposit 100 LINK → get 100 aLINK (2 days ago, outside window)
        createProtocolEvent({
          opType: OperationType.DEPOSIT,
          target: TARGET_AAVE,
          tokensIn: [TOKEN_LINK],
          amountsIn: [100n],
          tokensOut: [TOKEN_ALINK],
          amountsOut: [100n],
          spendingCost: 0n,
          timestamp: TWO_DAYS_AGO, // Outside window, aLINK will be expired
          blockNumber: 1000n,
        }),
        // Withdraw 50 LINK
        createProtocolEvent({
          opType: OperationType.WITHDRAW,
          target: TARGET_AAVE,
          tokensIn: [],
          amountsIn: [],
          tokensOut: [TOKEN_LINK],
          amountsOut: [50n],
          spendingCost: 0n,
          timestamp: NOW,
          blockNumber: 1001n,
        }),
      ]

      const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

      // The deposit was matched (remainingAmount reduced)
      expect(state.depositRecords[0].remainingAmount).toBe(50n)

      // The aLINK was expired, so actual queue consumption was 0
      // remainingOutputAmount should only be reduced by actual consumption (0), not calculated (50)
      // This tests the fix where we update based on actual queue consumption
      expect(state.depositRecords[0].remainingOutputAmount).toBe(100n) // Unchanged because aLINK expired

      // Withdrawn LINK should be acquired (inherits deposit timestamp, which is expired)
      // Since it inherits TWO_DAYS_AGO timestamp, it's also expired
      expect(state.acquiredBalances.get(TOKEN_LINK.toLowerCase() as Address) ?? 0n).toBe(0n)

      // aLINK should have 0 acquired balance (all expired)
      expect(state.acquiredBalances.get(TOKEN_ALINK.toLowerCase() as Address) ?? 0n).toBe(0n)
    })

    it('should handle multi-token LP deposits without double-counting output', () => {
      // Scenario: LP deposit with 2 tokens IN → 1 LP token OUT
      // This tests the fix for the double-counting bug where both deposit records
      // would have the full amountOut, causing 2x remainingOutputAmount
      const TOKEN_LP = '0x6666666666666666666666666666666666666666' as Address

      const events = [
        // LP Deposit: 1000 USDC + 1 WETH → 500 LP tokens
        createProtocolEvent({
          opType: OperationType.DEPOSIT,
          target: TARGET_UNISWAP,
          tokensIn: [TOKEN_USDC, TOKEN_WETH],
          amountsIn: [1000n, 1n],
          tokensOut: [TOKEN_LP],
          amountsOut: [500n],
          spendingCost: 100n,
          timestamp: HOUR_AGO,
          blockNumber: 1000n,
        }),
      ]

      const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

      // Should have 2 deposit records (one per input token)
      expect(state.depositRecords.length).toBe(2)

      // Each record should have HALF of the LP output (250 each, not 500 each)
      const usdcRecord = state.depositRecords.find(r => r.tokenIn.toLowerCase() === TOKEN_USDC.toLowerCase())
      const wethRecord = state.depositRecords.find(r => r.tokenIn.toLowerCase() === TOKEN_WETH.toLowerCase())

      expect(usdcRecord).toBeDefined()
      expect(wethRecord).toBeDefined()
      expect(usdcRecord!.amountOut).toBe(250n) // 500 / 2
      expect(wethRecord!.amountOut).toBe(250n) // 500 / 2
      expect(usdcRecord!.remainingOutputAmount).toBe(250n)
      expect(wethRecord!.remainingOutputAmount).toBe(250n)

      // Total remainingOutputAmount across all records should equal actual LP tokens (500)
      const totalRemainingOutput = state.depositRecords.reduce((sum, r) => sum + r.remainingOutputAmount, 0n)
      expect(totalRemainingOutput).toBe(500n) // Not 1000n (the bug)

      // LP token should be in acquired balance
      expect(state.acquiredBalances.get(TOKEN_LP.toLowerCase() as Address)).toBe(500n)
    })

    it('should correctly consume LP tokens on withdrawal after multi-token deposit', () => {
      // Full cycle: multi-token deposit → withdrawal should not over-consume
      const TOKEN_LP = '0x6666666666666666666666666666666666666666' as Address

      const events = [
        // LP Deposit: 1000 USDC + 1 WETH → 500 LP tokens
        createProtocolEvent({
          opType: OperationType.DEPOSIT,
          target: TARGET_UNISWAP,
          tokensIn: [TOKEN_USDC, TOKEN_WETH],
          amountsIn: [1000n, 1n],
          tokensOut: [TOKEN_LP],
          amountsOut: [500n],
          spendingCost: 100n,
          timestamp: HOUR_AGO,
          blockNumber: 1000n,
        }),
        // Withdraw USDC (full amount)
        createProtocolEvent({
          opType: OperationType.WITHDRAW,
          target: TARGET_UNISWAP,
          tokensIn: [],
          amountsIn: [],
          tokensOut: [TOKEN_USDC],
          amountsOut: [1000n],
          spendingCost: 0n,
          timestamp: NOW - 60n,
          blockNumber: 1001n,
        }),
        // Withdraw WETH (full amount)
        createProtocolEvent({
          opType: OperationType.WITHDRAW,
          target: TARGET_UNISWAP,
          tokensIn: [],
          amountsIn: [],
          tokensOut: [TOKEN_WETH],
          amountsOut: [1n],
          spendingCost: 0n,
          timestamp: NOW,
          blockNumber: 1002n,
        }),
      ]

      const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

      // After full withdrawal, LP token acquired balance should be 0 or undefined
      // (250 consumed by USDC withdrawal + 250 consumed by WETH withdrawal = 500 total)
      const lpBalance = state.acquiredBalances.get(TOKEN_LP.toLowerCase() as Address) ?? 0n
      expect(lpBalance).toBe(0n)

      // Both deposit records should be fully consumed
      expect(state.depositRecords[0].remainingAmount).toBe(0n)
      expect(state.depositRecords[1].remainingAmount).toBe(0n)
      expect(state.depositRecords[0].remainingOutputAmount).toBe(0n)
      expect(state.depositRecords[1].remainingOutputAmount).toBe(0n)

      // Withdrawn tokens should be acquired
      expect(state.acquiredBalances.get(TOKEN_USDC.toLowerCase() as Address)).toBe(1000n)
      expect(state.acquiredBalances.get(TOKEN_WETH.toLowerCase() as Address)).toBe(1n)
    })

    it('should handle single-input multi-output deposits with separate deposit records', () => {
      // Scenario: 1 input → 2 outputs (e.g., some protocols give back multiple receipt tokens)
      // This tests the fix where only output[0] would get a deposit record, leaving output[1] orphaned
      const TOKEN_RECEIPT_A = '0x7777777777777777777777777777777777777777' as Address
      const TOKEN_RECEIPT_B = '0x8888888888888888888888888888888888888888' as Address

      const events = [
        // Single input → multiple outputs
        createProtocolEvent({
          opType: OperationType.DEPOSIT,
          target: TARGET_AAVE,
          tokensIn: [TOKEN_LINK],
          amountsIn: [100n],
          tokensOut: [TOKEN_RECEIPT_A, TOKEN_RECEIPT_B],
          amountsOut: [50n, 30n],
          spendingCost: 10n,
          timestamp: HOUR_AGO,
          blockNumber: 1000n,
        }),
      ]

      const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

      // Should have 2 deposit records (one per output token)
      expect(state.depositRecords.length).toBe(2)

      // Each record should track its corresponding output, with input divided equally
      const recordA = state.depositRecords.find(r => r.tokenOut.toLowerCase() === TOKEN_RECEIPT_A.toLowerCase())
      const recordB = state.depositRecords.find(r => r.tokenOut.toLowerCase() === TOKEN_RECEIPT_B.toLowerCase())

      expect(recordA).toBeDefined()
      expect(recordB).toBeDefined()

      // Input is divided equally among outputs (100 / 2 = 50 each)
      expect(recordA!.amountIn).toBe(50n)
      expect(recordB!.amountIn).toBe(50n)
      expect(recordA!.remainingAmount).toBe(50n)
      expect(recordB!.remainingAmount).toBe(50n)

      // Each record tracks its own output amount
      expect(recordA!.amountOut).toBe(50n)
      expect(recordB!.amountOut).toBe(30n)
      expect(recordA!.remainingOutputAmount).toBe(50n)
      expect(recordB!.remainingOutputAmount).toBe(30n)

      // Both output tokens should be in acquired balance
      expect(state.acquiredBalances.get(TOKEN_RECEIPT_A.toLowerCase() as Address)).toBe(50n)
      expect(state.acquiredBalances.get(TOKEN_RECEIPT_B.toLowerCase() as Address)).toBe(30n)
    })

    it('should correctly match withdrawals to single-input multi-output deposit records', () => {
      // Full cycle: single-input multi-output deposit → withdraw each output
      const TOKEN_RECEIPT_A = '0x7777777777777777777777777777777777777777' as Address
      const TOKEN_RECEIPT_B = '0x8888888888888888888888888888888888888888' as Address

      const events = [
        // Deposit: 100 LINK → 50 RECEIPT_A + 30 RECEIPT_B
        createProtocolEvent({
          opType: OperationType.DEPOSIT,
          target: TARGET_AAVE,
          tokensIn: [TOKEN_LINK],
          amountsIn: [100n],
          tokensOut: [TOKEN_RECEIPT_A, TOKEN_RECEIPT_B],
          amountsOut: [50n, 30n],
          spendingCost: 10n,
          timestamp: HOUR_AGO,
          blockNumber: 1000n,
        }),
        // Withdraw using RECEIPT_A as input (simulating burning receipt token)
        createProtocolEvent({
          opType: OperationType.WITHDRAW,
          target: TARGET_AAVE,
          tokensIn: [],
          amountsIn: [],
          tokensOut: [TOKEN_LINK],
          amountsOut: [50n], // Get back 50 LINK (proportional to the 50 input share)
          spendingCost: 0n,
          timestamp: NOW - 60n,
          blockNumber: 1001n,
        }),
      ]

      const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

      // First deposit record (for RECEIPT_A) should be fully consumed by the withdrawal
      const recordA = state.depositRecords.find(r => r.tokenOut.toLowerCase() === TOKEN_RECEIPT_A.toLowerCase())
      expect(recordA!.remainingAmount).toBe(0n) // 50 - 50 = 0 consumed

      // Second deposit record (for RECEIPT_B) should be untouched
      const recordB = state.depositRecords.find(r => r.tokenOut.toLowerCase() === TOKEN_RECEIPT_B.toLowerCase())
      expect(recordB!.remainingAmount).toBe(50n) // Still has its 50 input share

      // LINK should be acquired (withdrawn amount)
      expect(state.acquiredBalances.get(TOKEN_LINK.toLowerCase() as Address)).toBe(50n)
    })
  })

  describe('USD-weighted ratio calculation', () => {
    it('should use USD-weighted ratio for mixed multi-token swaps', () => {
      // Scenario: Swap with 1 WETH ($3000) + 1000 USDC ($1000) where WETH is acquired
      // Without USD weighting: acquiredRatio = 1/1001 ≈ 0.1%
      // With USD weighting: acquiredRatio = 3000/4000 = 75%

      // First acquire some WETH via a swap
      const events = [
        // Acquire 1 WETH
        createProtocolEvent({
          opType: OperationType.SWAP,
          tokensIn: [TOKEN_LINK],
          amountsIn: [100n],
          tokensOut: [TOKEN_WETH],
          amountsOut: [parseUnits('1', 18)], // 1 WETH
          spendingCost: 0n,
          timestamp: HOUR_AGO,
          blockNumber: 1000n,
        }),
        // Multi-token swap: 1 WETH (acquired) + 1000 USDC (original) → 4000 OUTPUT tokens
        createProtocolEvent({
          opType: OperationType.SWAP,
          tokensIn: [TOKEN_WETH, TOKEN_USDC],
          amountsIn: [parseUnits('1', 18), parseUnits('1000', 6)], // 1 WETH + 1000 USDC
          tokensOut: [TOKEN_LINK],
          amountsOut: [4000n], // 4000 output tokens
          spendingCost: 0n,
          timestamp: NOW,
          blockNumber: 1001n,
        }),
      ]

      // Create price cache with realistic prices
      // WETH: $3000, USDC: $1
      const priceCache: TokenPriceCache = new Map([
        [TOKEN_WETH.toLowerCase() as Address, { priceUSD: parseUnits('3000', 18), decimals: 18 }],
        [TOKEN_USDC.toLowerCase() as Address, { priceUSD: parseUnits('1', 18), decimals: 6 }],
      ])

      const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION, priceCache)

      // With USD weighting:
      // - WETH value: 1 * $3000 = $3000 (acquired)
      // - USDC value: 1000 * $1 = $1000 (original)
      // - Total: $4000
      // - Acquired ratio: 3000/4000 = 75%
      // - Output from acquired: 4000 * 75% = 3000
      // - Output newly acquired: 4000 * 25% = 1000

      const linkBalance = state.acquiredBalances.get(TOKEN_LINK.toLowerCase() as Address) ?? 0n
      expect(linkBalance).toBe(4000n) // Total output

      // Check that the inherited portion is ~75% (3000 tokens with old timestamp)
      // The LINK queue should have two entries: 3000 with old timestamp, 1000 with new timestamp
      const linkQueue = state.acquiredQueues.get(TOKEN_LINK.toLowerCase() as Address)
      expect(linkQueue).toBeDefined()
      expect(linkQueue!.length).toBe(2)

      // First entry should be ~75% with inherited timestamp (from WETH acquisition)
      expect(linkQueue![0].amount).toBe(3000n)
      expect(linkQueue![0].originalTimestamp).toBe(HOUR_AGO) // Inherited from WETH

      // Second entry should be ~25% with new timestamp
      expect(linkQueue![1].amount).toBe(1000n)
      expect(linkQueue![1].originalTimestamp).toBe(NOW) // Newly acquired
    })

    it('should fall back to amount-weighted ratio when price cache is empty', () => {
      // Same scenario but without price cache - should use amount-weighted ratio

      const events = [
        // Acquire 1 WETH
        createProtocolEvent({
          opType: OperationType.SWAP,
          tokensIn: [TOKEN_LINK],
          amountsIn: [100n],
          tokensOut: [TOKEN_WETH],
          amountsOut: [parseUnits('1', 18)],
          spendingCost: 0n,
          timestamp: HOUR_AGO,
          blockNumber: 1000n,
        }),
        // Multi-token swap without price info
        createProtocolEvent({
          opType: OperationType.SWAP,
          tokensIn: [TOKEN_WETH, TOKEN_USDC],
          amountsIn: [parseUnits('1', 18), parseUnits('1000', 6)],
          tokensOut: [TOKEN_LINK],
          amountsOut: [4000n],
          spendingCost: 0n,
          timestamp: NOW,
          blockNumber: 1001n,
        }),
      ]

      // No price cache - should fall back to amount-weighted
      const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

      const linkQueue = state.acquiredQueues.get(TOKEN_LINK.toLowerCase() as Address)
      expect(linkQueue).toBeDefined()
      expect(linkQueue!.length).toBe(2)

      // Without USD weighting, ratio is based on raw amounts:
      // WETH amount: 1e18, USDC amount: 1e9 (1000 * 1e6)
      // Total: 1e18 + 1e9 ≈ 1e18 (WETH dominates)
      // Acquired ratio ≈ 1e18 / (1e18 + 1e9) ≈ 99.9%
      // This is the "wrong" result that USD weighting fixes

      // The first entry should be almost all of the output (amount-weighted favors WETH)
      expect(linkQueue![0].amount).toBeGreaterThan(3900n) // Almost all 4000
    })
  })

  describe('Transfer scenarios', () => {
    it('should properly track transfers of acquired tokens', () => {
      const protocolEvents = [
        // Acquire 100 LINK via swap
        createProtocolEvent({
          opType: OperationType.SWAP,
          tokensIn: [TOKEN_WETH],
          amountsIn: [5n],
          tokensOut: [TOKEN_LINK],
          amountsOut: [100n],
          spendingCost: 50n,
          timestamp: HOUR_AGO,
          blockNumber: 1000n,
        }),
      ]

      const transferEvents = [
        // Transfer 30 LINK
        createTransferEvent({
          token: TOKEN_LINK,
          amount: 30n,
          spendingCost: 10n,
          timestamp: HOUR_AGO + 60n,
          blockNumber: 1001n,
        }),
        // Transfer another 20 LINK
        createTransferEvent({
          token: TOKEN_LINK,
          amount: 20n,
          spendingCost: 5n,
          timestamp: NOW,
          blockNumber: 1002n,
        }),
      ]

      const state = buildSubAccountState(protocolEvents, transferEvents, SUB_ACCOUNT, NOW, WINDOW_DURATION)

      // LINK should have 50 remaining (100 - 30 - 20)
      expect(state.acquiredBalances.get(TOKEN_LINK.toLowerCase() as Address)).toBe(50n)

      // Total spending should be 65 (50 from swap + 10 + 5 from transfers)
      expect(state.totalSpendingInWindow).toBe(65n)
    })

    it('should handle transfer of non-acquired tokens', () => {
      // Transfer without prior acquisition
      const transferEvents = [
        createTransferEvent({
          token: TOKEN_LINK,
          amount: 100n,
          spendingCost: 50n,
          timestamp: NOW,
        }),
      ]

      const state = buildSubAccountState([], transferEvents, SUB_ACCOUNT, NOW, WINDOW_DURATION)

      // No acquired balance (nothing was acquired)
      expect(state.acquiredBalances.get(TOKEN_LINK.toLowerCase() as Address)).toBeUndefined()

      // Spending should still be tracked
      expect(state.totalSpendingInWindow).toBe(50n)
    })
  })

  describe('Window boundary scenarios', () => {
    it('should handle events inside vs outside window', () => {
      const events = [
        // Event inside window (should be valid for both spending and acquisition)
        createProtocolEvent({
          opType: OperationType.SWAP,
          tokensIn: [TOKEN_WETH],
          amountsIn: [1n],
          tokensOut: [TOKEN_LINK],
          amountsOut: [50n],
          spendingCost: 25n,
          timestamp: HOUR_AGO,
          blockNumber: 1000n,
        }),
        // Event outside window (should not count for spending or acquisition)
        createProtocolEvent({
          opType: OperationType.SWAP,
          tokensIn: [TOKEN_USDC],
          amountsIn: [100n],
          tokensOut: [TOKEN_WETH],
          amountsOut: [1n],
          spendingCost: 100n,
          timestamp: TWO_DAYS_AGO,
          blockNumber: 999n,
        }),
      ]

      const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

      // LINK from inside window should be acquired
      expect(state.acquiredBalances.get(TOKEN_LINK.toLowerCase() as Address)).toBe(50n)

      // WETH from outside window should NOT be acquired (expired)
      expect(state.acquiredBalances.get(TOKEN_WETH.toLowerCase() as Address)).toBeUndefined()

      // Only spending from within window should count
      expect(state.totalSpendingInWindow).toBe(25n)
    })

    it('should handle events far outside window', () => {
      const events = [
        // Event 2 days ago (clearly outside 1-day window)
        createProtocolEvent({
          opType: OperationType.SWAP,
          tokensIn: [TOKEN_WETH],
          amountsIn: [1n],
          tokensOut: [TOKEN_LINK],
          amountsOut: [100n],
          spendingCost: 50n,
          timestamp: TWO_DAYS_AGO,
          blockNumber: 1000n,
        }),
      ]

      const state = buildSubAccountState(events, [], SUB_ACCOUNT, NOW, WINDOW_DURATION)

      // LINK should NOT be acquired (expired)
      expect(state.acquiredBalances.get(TOKEN_LINK.toLowerCase() as Address)).toBeUndefined()

      // Spending should NOT be counted
      expect(state.totalSpendingInWindow).toBe(0n)
    })
  })
})
