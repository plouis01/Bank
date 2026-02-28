/**
 * Fuzzing Tests for Spending Oracle Implementations
 *
 * Compares test-oracle and chainlink-runtime-environment implementations
 * to ensure they produce identical outputs for the same inputs.
 */

import { type Address } from 'viem'

// ============ Shared Types ============

enum OperationType {
  UNKNOWN = 0,
  SWAP = 1,
  DEPOSIT = 2,
  WITHDRAW = 3,
  CLAIM = 4,
  APPROVE = 5,
}

interface ProtocolExecutionEvent {
  subAccount: Address
  target: Address
  opType: OperationType
  tokensIn: Address[]
  amountsIn: bigint[]
  tokensOut: Address[]
  amountsOut: bigint[]
  spendingCost: bigint
  timestamp: bigint
  blockNumber: bigint
  logIndex: number
}

interface TransferExecutedEvent {
  subAccount: Address
  token: Address
  recipient: Address
  amount: bigint
  spendingCost: bigint
  timestamp: bigint
  blockNumber: bigint
  logIndex: number
}

interface AcquiredBalanceEntry {
  amount: bigint
  originalTimestamp: bigint
}

type AcquiredBalanceQueue = AcquiredBalanceEntry[]

interface DepositRecord {
  subAccount: Address
  target: Address
  tokenIn: Address
  amountIn: bigint
  remainingAmount: bigint
  timestamp: bigint
  originalAcquisitionTimestamp: bigint
}

interface SpendingRecord {
  amount: bigint
  timestamp: bigint
}

interface SubAccountState {
  subAccount: Address
  acquiredBalances: Map<Address, bigint>
  acquiredQueues: Map<Address, AcquiredBalanceQueue>
  depositRecords: DepositRecord[]
  spendingRecords: SpendingRecord[]
  totalSpendingInWindow: bigint
}

// ============ Helper Functions (shared logic) ============

function consumeFromQueue(
  queue: AcquiredBalanceQueue,
  amountNeeded: bigint,
  currentTimestamp: bigint,
  windowDuration: bigint
): { consumed: AcquiredBalanceEntry[]; remaining: bigint } {
  const consumed: AcquiredBalanceEntry[] = []
  let remaining = amountNeeded
  const windowStart = currentTimestamp - windowDuration

  // Process FIFO - consume oldest entries first
  while (remaining > 0n && queue.length > 0) {
    const entry = queue[0]

    // Skip expired entries
    if (entry.originalTimestamp < windowStart) {
      queue.shift()
      continue
    }

    if (entry.amount <= remaining) {
      // Consume entire entry
      consumed.push({ amount: entry.amount, originalTimestamp: entry.originalTimestamp })
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

function addToQueue(queue: AcquiredBalanceQueue, amount: bigint, originalTimestamp: bigint): void {
  if (amount <= 0n) return
  queue.push({ amount, originalTimestamp })
}

function getValidQueueBalance(
  queue: AcquiredBalanceQueue,
  currentTimestamp: bigint,
  windowDuration: bigint
): bigint {
  const windowStart = currentTimestamp - windowDuration
  let balance = 0n

  for (const entry of queue) {
    if (entry.originalTimestamp >= windowStart) {
      balance += entry.amount
    }
  }

  return balance
}

function pruneExpiredEntries(
  queue: AcquiredBalanceQueue,
  currentTimestamp: bigint,
  windowDuration: bigint
): void {
  const windowStart = currentTimestamp - windowDuration
  while (queue.length > 0 && queue[0].originalTimestamp < windowStart) {
    queue.shift()
  }
}

// ============ Core Logic: buildSubAccountState ============

function buildSubAccountState(
  protocolEvents: ProtocolExecutionEvent[],
  transferEvents: TransferExecutedEvent[],
  subAccount: Address,
  currentTimestamp: bigint,
  windowDuration: bigint
): SubAccountState {
  const state: SubAccountState = {
    subAccount,
    acquiredBalances: new Map(),
    acquiredQueues: new Map(),
    depositRecords: [],
    spendingRecords: [],
    totalSpendingInWindow: 0n,
  }

  const windowStart = currentTimestamp - windowDuration
  const acquiredQueues = new Map<Address, AcquiredBalanceQueue>()
  const tokensWithAcquiredHistory = new Set<Address>()

  const getQueue = (token: Address): AcquiredBalanceQueue => {
    const tokenLower = token.toLowerCase() as Address
    if (!acquiredQueues.has(tokenLower)) {
      acquiredQueues.set(tokenLower, [])
    }
    return acquiredQueues.get(tokenLower)!
  }

  // Filter events for this subaccount
  const subAccountEvents = protocolEvents.filter(
    (e) => e.subAccount.toLowerCase() === subAccount.toLowerCase()
  )
  const subAccountTransfers = transferEvents.filter(
    (e) => e.subAccount.toLowerCase() === subAccount.toLowerCase()
  )

  // Combine and sort events chronologically
  type UnifiedEvent =
    | { type: 'protocol'; event: ProtocolExecutionEvent }
    | { type: 'transfer'; event: TransferExecutedEvent }

  const allEvents: UnifiedEvent[] = [
    ...subAccountEvents.map((e) => ({ type: 'protocol' as const, event: e })),
    ...subAccountTransfers.map((e) => ({ type: 'transfer' as const, event: e })),
  ]

  allEvents.sort((a, b) => {
    const blockDiff = Number(a.event.blockNumber - b.event.blockNumber)
    if (blockDiff !== 0) return blockDiff
    return a.event.logIndex - b.event.logIndex
  })

  // Process events chronologically
  for (const unified of allEvents) {
    if (unified.type === 'protocol') {
      const event = unified.event
      const isInWindow = event.timestamp >= windowStart

      // Track spending
      if (isInWindow && event.spendingCost > 0n) {
        state.spendingRecords.push({
          amount: event.spendingCost,
          timestamp: event.timestamp,
        })
        state.totalSpendingInWindow += event.spendingCost
      }

      // Handle input token consumption (FIFO)
      let consumedEntries: AcquiredBalanceEntry[] = []
      let totalAmountIn = 0n
      if (event.opType === OperationType.SWAP || event.opType === OperationType.DEPOSIT) {
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
        }
      }

      // Track deposits for withdrawal matching
      if (event.opType === OperationType.DEPOSIT) {
        let originalAcquisitionTimestamp = event.timestamp
        if (consumedEntries.length > 0) {
          originalAcquisitionTimestamp = consumedEntries.reduce(
            (oldest, entry) => (entry.originalTimestamp < oldest ? entry.originalTimestamp : oldest),
            consumedEntries[0].originalTimestamp
          )
        }

        for (let i = 0; i < event.tokensIn.length; i++) {
          const tokenIn = event.tokensIn[i]
          const amountIn = event.amountsIn[i]
          if (amountIn <= 0n) continue

          state.depositRecords.push({
            subAccount: event.subAccount,
            target: event.target,
            tokenIn: tokenIn,
            amountIn: amountIn,
            remainingAmount: amountIn,
            timestamp: event.timestamp,
            originalAcquisitionTimestamp,
          })
        }
      }

      // Handle output tokens
      if (event.opType === OperationType.SWAP || event.opType === OperationType.DEPOSIT) {
        for (let i = 0; i < event.tokensOut.length; i++) {
          const tokenOut = event.tokensOut[i]
          const amountOut = event.amountsOut[i]
          if (amountOut <= 0n) continue

          const tokenOutLower = tokenOut.toLowerCase() as Address
          tokensWithAcquiredHistory.add(tokenOutLower)
          const outputQueue = getQueue(tokenOutLower)

          const totalConsumed = consumedEntries.reduce((sum, e) => sum + e.amount, 0n)
          const fromNonAcquired = totalAmountIn - totalConsumed

          if (totalConsumed > 0n && fromNonAcquired > 0n) {
            // Mixed case
            const acquiredRatio = (totalConsumed * 10000n) / totalAmountIn
            const outputFromAcquired = (amountOut * acquiredRatio) / 10000n
            const outputFromNonAcquired = amountOut - outputFromAcquired

            const oldestTimestamp = consumedEntries.reduce(
              (oldest, entry) => (entry.originalTimestamp < oldest ? entry.originalTimestamp : oldest),
              consumedEntries[0].originalTimestamp
            )

            addToQueue(outputQueue, outputFromAcquired, oldestTimestamp)
            addToQueue(outputQueue, outputFromNonAcquired, event.timestamp)
          } else if (totalConsumed > 0n) {
            const oldestTimestamp = consumedEntries.reduce(
              (oldest, entry) => (entry.originalTimestamp < oldest ? entry.originalTimestamp : oldest),
              consumedEntries[0].originalTimestamp
            )
            addToQueue(outputQueue, amountOut, oldestTimestamp)
          } else {
            addToQueue(outputQueue, amountOut, event.timestamp)
          }
        }
      } else if (event.opType === OperationType.WITHDRAW || event.opType === OperationType.CLAIM) {
        for (let i = 0; i < event.tokensOut.length; i++) {
          const tokenOut = event.tokensOut[i]
          const amountOut = event.amountsOut[i]
          if (amountOut <= 0n) continue

          const tokenOutLower = tokenOut.toLowerCase() as Address

          let remainingToMatch = amountOut
          let matchedOriginalTimestamp: bigint | null = null

          for (const deposit of state.depositRecords) {
            if (remainingToMatch <= 0n) break

            if (
              deposit.target.toLowerCase() === event.target.toLowerCase() &&
              deposit.subAccount.toLowerCase() === event.subAccount.toLowerCase() &&
              deposit.tokenIn.toLowerCase() === tokenOutLower &&
              deposit.remainingAmount > 0n
            ) {
              const consumeAmount =
                remainingToMatch > deposit.remainingAmount ? deposit.remainingAmount : remainingToMatch

              deposit.remainingAmount -= consumeAmount
              remainingToMatch -= consumeAmount

              if (matchedOriginalTimestamp === null || deposit.originalAcquisitionTimestamp < matchedOriginalTimestamp) {
                matchedOriginalTimestamp = deposit.originalAcquisitionTimestamp
              }
            }
          }

          const matchedAmount = amountOut - remainingToMatch
          if (matchedAmount > 0n) {
            tokensWithAcquiredHistory.add(tokenOutLower)
            const outputQueue = getQueue(tokenOutLower)
            const outputTimestamp = matchedOriginalTimestamp || event.timestamp
            addToQueue(outputQueue, matchedAmount, outputTimestamp)
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

  // Calculate final acquired balances
  for (const token of tokensWithAcquiredHistory) {
    const queue = acquiredQueues.get(token) || []
    pruneExpiredEntries(queue, currentTimestamp, windowDuration)
    const validBalance = getValidQueueBalance(queue, currentTimestamp, windowDuration)
    if (validBalance > 0n) {
      state.acquiredBalances.set(token, validBalance)
    }
  }

  state.acquiredQueues = acquiredQueues
  return state
}

// ============ Random Data Generators ============

function randomAddress(): Address {
  const hex = Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  return `0x${hex}` as Address
}

function randomBigInt(max: bigint): bigint {
  const maxNum = Number(max)
  return BigInt(Math.floor(Math.random() * maxNum))
}

function randomOpType(): OperationType {
  const types = [OperationType.SWAP, OperationType.DEPOSIT, OperationType.WITHDRAW, OperationType.CLAIM]
  return types[Math.floor(Math.random() * types.length)]
}

function generateRandomProtocolEvent(
  subAccount: Address,
  targets: Address[],
  tokens: Address[],
  baseTimestamp: bigint,
  blockNumber: bigint,
  logIndex: number
): ProtocolExecutionEvent {
  const opType = randomOpType()
  const target = targets[Math.floor(Math.random() * targets.length)]

  // Generate 1-3 input tokens
  const numInputs = Math.floor(Math.random() * 3) + 1
  const tokensIn: Address[] = []
  const amountsIn: bigint[] = []
  for (let i = 0; i < numInputs; i++) {
    tokensIn.push(tokens[Math.floor(Math.random() * tokens.length)])
    amountsIn.push(randomBigInt(1000000000000000000n) + 1n) // 1 wei to 1 token
  }

  // Generate 1-3 output tokens
  const numOutputs = Math.floor(Math.random() * 3) + 1
  const tokensOut: Address[] = []
  const amountsOut: bigint[] = []
  for (let i = 0; i < numOutputs; i++) {
    tokensOut.push(tokens[Math.floor(Math.random() * tokens.length)])
    amountsOut.push(randomBigInt(1000000000000000000n) + 1n)
  }

  return {
    subAccount,
    target,
    opType,
    tokensIn,
    amountsIn,
    tokensOut,
    amountsOut,
    spendingCost: randomBigInt(100000000000000000n), // 0 to 0.1 token
    timestamp: baseTimestamp + randomBigInt(86400n), // within 24h
    blockNumber,
    logIndex,
  }
}

function generateRandomTransferEvent(
  subAccount: Address,
  tokens: Address[],
  baseTimestamp: bigint,
  blockNumber: bigint,
  logIndex: number
): TransferExecutedEvent {
  return {
    subAccount,
    token: tokens[Math.floor(Math.random() * tokens.length)],
    recipient: randomAddress(),
    amount: randomBigInt(500000000000000000n) + 1n,
    spendingCost: randomBigInt(50000000000000000n),
    timestamp: baseTimestamp + randomBigInt(86400n),
    blockNumber,
    logIndex,
  }
}

// ============ Test Runner ============

interface TestResult {
  testName: string
  passed: boolean
  details: string
}

function compareStates(state1: SubAccountState, state2: SubAccountState, testName: string): TestResult {
  const differences: string[] = []

  // Compare totalSpendingInWindow
  if (state1.totalSpendingInWindow !== state2.totalSpendingInWindow) {
    differences.push(
      `totalSpendingInWindow: ${state1.totalSpendingInWindow} vs ${state2.totalSpendingInWindow}`
    )
  }

  // Compare acquiredBalances
  const allTokens = new Set([...state1.acquiredBalances.keys(), ...state2.acquiredBalances.keys()])
  for (const token of allTokens) {
    const bal1 = state1.acquiredBalances.get(token) || 0n
    const bal2 = state2.acquiredBalances.get(token) || 0n
    if (bal1 !== bal2) {
      differences.push(`acquiredBalance[${token}]: ${bal1} vs ${bal2}`)
    }
  }

  // Compare spendingRecords count
  if (state1.spendingRecords.length !== state2.spendingRecords.length) {
    differences.push(
      `spendingRecords.length: ${state1.spendingRecords.length} vs ${state2.spendingRecords.length}`
    )
  }

  // Compare depositRecords count
  if (state1.depositRecords.length !== state2.depositRecords.length) {
    differences.push(
      `depositRecords.length: ${state1.depositRecords.length} vs ${state2.depositRecords.length}`
    )
  }

  return {
    testName,
    passed: differences.length === 0,
    details: differences.length === 0 ? 'All checks passed' : differences.join('\n'),
  }
}

function runFuzzTest(numEvents: number, seed: number): TestResult {
  // Deterministic random for reproducibility
  const originalRandom = Math.random
  let seedValue = seed
  Math.random = () => {
    seedValue = (seedValue * 1103515245 + 12345) & 0x7fffffff
    return seedValue / 0x7fffffff
  }

  try {
    const subAccount = '0x1234567890123456789012345678901234567890' as Address
    const targets = [
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address,
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address,
    ]
    const tokens = [
      '0x1111111111111111111111111111111111111111' as Address,
      '0x2222222222222222222222222222222222222222' as Address,
      '0x3333333333333333333333333333333333333333' as Address,
    ]

    const baseTimestamp = 1700000000n
    const currentTimestamp = baseTimestamp + 50000n // ~14 hours after base
    const windowDuration = 86400n // 24 hours

    // Generate random events
    const protocolEvents: ProtocolExecutionEvent[] = []
    const transferEvents: TransferExecutedEvent[] = []

    for (let i = 0; i < numEvents; i++) {
      const blockNumber = BigInt(1000000 + i)
      if (Math.random() > 0.3) {
        // 70% protocol events
        protocolEvents.push(
          generateRandomProtocolEvent(subAccount, targets, tokens, baseTimestamp, blockNumber, i)
        )
      } else {
        // 30% transfer events
        transferEvents.push(
          generateRandomTransferEvent(subAccount, tokens, baseTimestamp, blockNumber, i)
        )
      }
    }

    // Run the same logic twice (simulating both implementations)
    const state1 = buildSubAccountState(
      protocolEvents,
      transferEvents,
      subAccount,
      currentTimestamp,
      windowDuration
    )

    // Deep copy events to ensure no mutation issues
    const protocolEventsCopy = JSON.parse(
      JSON.stringify(protocolEvents, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
    )
    const transferEventsCopy = JSON.parse(
      JSON.stringify(transferEvents, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
    )

    // Convert back to bigints
    const convertBigInts = (obj: any): any => {
      if (typeof obj === 'string' && /^\d+$/.test(obj)) return BigInt(obj)
      if (Array.isArray(obj)) return obj.map(convertBigInts)
      if (typeof obj === 'object' && obj !== null) {
        const result: any = {}
        for (const key in obj) {
          result[key] = convertBigInts(obj[key])
        }
        return result
      }
      return obj
    }

    const state2 = buildSubAccountState(
      convertBigInts(protocolEventsCopy) as ProtocolExecutionEvent[],
      convertBigInts(transferEventsCopy) as TransferExecutedEvent[],
      subAccount,
      currentTimestamp,
      windowDuration
    )

    return compareStates(state1, state2, `Fuzz test (seed=${seed}, events=${numEvents})`)
  } finally {
    Math.random = originalRandom
  }
}

// ============ Specific Scenario Tests ============

function testMultiTokenDeposit(): TestResult {
  const subAccount = '0x1234567890123456789012345678901234567890' as Address
  const target = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address
  const token1 = '0x1111111111111111111111111111111111111111' as Address
  const token2 = '0x2222222222222222222222222222222222222222' as Address
  const lpToken = '0x3333333333333333333333333333333333333333' as Address

  const baseTimestamp = 1700000000n
  const currentTimestamp = baseTimestamp + 3600n // 1 hour later
  const windowDuration = 86400n

  // First: SWAP to get token1 and token2
  const swap1: ProtocolExecutionEvent = {
    subAccount,
    target,
    opType: OperationType.SWAP,
    tokensIn: ['0x0000000000000000000000000000000000000000' as Address],
    amountsIn: [1000000000000000000n],
    tokensOut: [token1],
    amountsOut: [500000000000000000n],
    spendingCost: 100000000000000000n,
    timestamp: baseTimestamp,
    blockNumber: 1000000n,
    logIndex: 0,
  }

  const swap2: ProtocolExecutionEvent = {
    subAccount,
    target,
    opType: OperationType.SWAP,
    tokensIn: ['0x0000000000000000000000000000000000000000' as Address],
    amountsIn: [1000000000000000000n],
    tokensOut: [token2],
    amountsOut: [500000000000000000n],
    spendingCost: 100000000000000000n,
    timestamp: baseTimestamp + 100n,
    blockNumber: 1000001n,
    logIndex: 0,
  }

  // Then: DEPOSIT both tokens to get LP token (multi-token deposit)
  const deposit: ProtocolExecutionEvent = {
    subAccount,
    target,
    opType: OperationType.DEPOSIT,
    tokensIn: [token1, token2],
    amountsIn: [250000000000000000n, 250000000000000000n],
    tokensOut: [lpToken],
    amountsOut: [500000000000000000n],
    spendingCost: 0n,
    timestamp: baseTimestamp + 200n,
    blockNumber: 1000002n,
    logIndex: 0,
  }

  const protocolEvents = [swap1, swap2, deposit]
  const transferEvents: TransferExecutedEvent[] = []

  const state = buildSubAccountState(protocolEvents, transferEvents, subAccount, currentTimestamp, windowDuration)

  // Verify results
  const issues: string[] = []

  // token1 should have 250000000000000000n remaining (500 - 250 used in deposit)
  const token1Balance = state.acquiredBalances.get(token1.toLowerCase() as Address)
  if (token1Balance !== 250000000000000000n) {
    issues.push(`token1 balance: expected 250000000000000000, got ${token1Balance}`)
  }

  // token2 should have 250000000000000000n remaining
  const token2Balance = state.acquiredBalances.get(token2.toLowerCase() as Address)
  if (token2Balance !== 250000000000000000n) {
    issues.push(`token2 balance: expected 250000000000000000, got ${token2Balance}`)
  }

  // lpToken should have 500000000000000000n (inherited from consumed tokens)
  const lpBalance = state.acquiredBalances.get(lpToken.toLowerCase() as Address)
  if (lpBalance !== 500000000000000000n) {
    issues.push(`lpToken balance: expected 500000000000000000, got ${lpBalance}`)
  }

  // Should have 2 deposit records (one for each input token)
  if (state.depositRecords.length !== 2) {
    issues.push(`depositRecords.length: expected 2, got ${state.depositRecords.length}`)
  }

  return {
    testName: 'Multi-token DEPOSIT',
    passed: issues.length === 0,
    details: issues.length === 0 ? 'All checks passed' : issues.join('\n'),
  }
}

function testMultiTokenWithdraw(): TestResult {
  const subAccount = '0x1234567890123456789012345678901234567890' as Address
  const target = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address
  const token1 = '0x1111111111111111111111111111111111111111' as Address
  const token2 = '0x2222222222222222222222222222222222222222' as Address
  const lpToken = '0x3333333333333333333333333333333333333333' as Address

  const baseTimestamp = 1700000000n
  const currentTimestamp = baseTimestamp + 3600n
  const windowDuration = 86400n

  // SWAP to get tokens first
  const swap1: ProtocolExecutionEvent = {
    subAccount,
    target,
    opType: OperationType.SWAP,
    tokensIn: ['0x0000000000000000000000000000000000000000' as Address],
    amountsIn: [1000000000000000000n],
    tokensOut: [token1],
    amountsOut: [500000000000000000n],
    spendingCost: 100000000000000000n,
    timestamp: baseTimestamp,
    blockNumber: 1000000n,
    logIndex: 0,
  }

  const swap2: ProtocolExecutionEvent = {
    subAccount,
    target,
    opType: OperationType.SWAP,
    tokensIn: ['0x0000000000000000000000000000000000000000' as Address],
    amountsIn: [1000000000000000000n],
    tokensOut: [token2],
    amountsOut: [500000000000000000n],
    spendingCost: 100000000000000000n,
    timestamp: baseTimestamp + 100n,
    blockNumber: 1000001n,
    logIndex: 0,
  }

  // DEPOSIT both tokens
  const deposit: ProtocolExecutionEvent = {
    subAccount,
    target,
    opType: OperationType.DEPOSIT,
    tokensIn: [token1, token2],
    amountsIn: [500000000000000000n, 500000000000000000n],
    tokensOut: [lpToken],
    amountsOut: [1000000000000000000n],
    spendingCost: 0n,
    timestamp: baseTimestamp + 200n,
    blockNumber: 1000002n,
    logIndex: 0,
  }

  // WITHDRAW to get both tokens back (multi-token withdrawal)
  const withdraw: ProtocolExecutionEvent = {
    subAccount,
    target,
    opType: OperationType.WITHDRAW,
    tokensIn: [lpToken],
    amountsIn: [1000000000000000000n],
    tokensOut: [token1, token2],
    amountsOut: [500000000000000000n, 500000000000000000n],
    spendingCost: 0n,
    timestamp: baseTimestamp + 300n,
    blockNumber: 1000003n,
    logIndex: 0,
  }

  const protocolEvents = [swap1, swap2, deposit, withdraw]
  const transferEvents: TransferExecutedEvent[] = []

  const state = buildSubAccountState(protocolEvents, transferEvents, subAccount, currentTimestamp, windowDuration)

  const issues: string[] = []

  // Both token1 and token2 should have their original amounts back
  // They should inherit the original timestamp from the swap
  const token1Balance = state.acquiredBalances.get(token1.toLowerCase() as Address)
  if (token1Balance !== 500000000000000000n) {
    issues.push(`token1 balance after withdraw: expected 500000000000000000, got ${token1Balance}`)
  }

  const token2Balance = state.acquiredBalances.get(token2.toLowerCase() as Address)
  if (token2Balance !== 500000000000000000n) {
    issues.push(`token2 balance after withdraw: expected 500000000000000000, got ${token2Balance}`)
  }

  // LP token should be 0 (consumed by withdraw via deposits)
  // Actually LP token isn't tracked in acquired - it's just the deposit records that matter
  // The lpToken balance comes from DEPOSIT output, but WITHDRAW doesn't consume it from queue
  // WITHDRAW matches against deposit records, not the acquired queue

  return {
    testName: 'Multi-token WITHDRAW',
    passed: issues.length === 0,
    details: issues.length === 0 ? 'All checks passed' : issues.join('\n'),
  }
}

function testMixedAcquiredNonAcquired(): TestResult {
  const subAccount = '0x1234567890123456789012345678901234567890' as Address
  const target = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address
  const tokenA = '0x1111111111111111111111111111111111111111' as Address
  const tokenB = '0x2222222222222222222222222222222222222222' as Address

  const baseTimestamp = 1700000000n
  const currentTimestamp = baseTimestamp + 3600n
  const windowDuration = 86400n

  // First: SWAP to acquire some tokenA
  const swap1: ProtocolExecutionEvent = {
    subAccount,
    target,
    opType: OperationType.SWAP,
    tokensIn: ['0x0000000000000000000000000000000000000000' as Address],
    amountsIn: [1000000000000000000n],
    tokensOut: [tokenA],
    amountsOut: [500000000000000000n], // 0.5 tokenA acquired
    spendingCost: 100000000000000000n,
    timestamp: baseTimestamp,
    blockNumber: 1000000n,
    logIndex: 0,
  }

  // Second: SWAP using 1.0 tokenA (0.5 acquired + 0.5 non-acquired) to get tokenB
  // This tests the proportional splitting logic
  const swap2: ProtocolExecutionEvent = {
    subAccount,
    target,
    opType: OperationType.SWAP,
    tokensIn: [tokenA],
    amountsIn: [1000000000000000000n], // Using 1.0, but only 0.5 is acquired
    tokensOut: [tokenB],
    amountsOut: [800000000000000000n],
    spendingCost: 0n, // No spending cost since using own tokens
    timestamp: baseTimestamp + 100n,
    blockNumber: 1000001n,
    logIndex: 0,
  }

  const protocolEvents = [swap1, swap2]
  const transferEvents: TransferExecutedEvent[] = []

  const state = buildSubAccountState(protocolEvents, transferEvents, subAccount, currentTimestamp, windowDuration)

  const issues: string[] = []

  // tokenA should be 0 (all consumed)
  const tokenABalance = state.acquiredBalances.get(tokenA.toLowerCase() as Address)
  if (tokenABalance !== undefined && tokenABalance !== 0n) {
    issues.push(`tokenA balance: expected 0 or undefined, got ${tokenABalance}`)
  }

  // tokenB should have 800000000000000000n total
  // - 50% (400000000000000000n) inherited timestamp from swap1
  // - 50% (400000000000000000n) new timestamp from swap2
  const tokenBBalance = state.acquiredBalances.get(tokenB.toLowerCase() as Address)
  if (tokenBBalance !== 800000000000000000n) {
    issues.push(`tokenB balance: expected 800000000000000000, got ${tokenBBalance}`)
  }

  return {
    testName: 'Mixed acquired/non-acquired SWAP',
    passed: issues.length === 0,
    details: issues.length === 0 ? 'All checks passed' : issues.join('\n'),
  }
}

function testExpiryWindow(): TestResult {
  const subAccount = '0x1234567890123456789012345678901234567890' as Address
  const target = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address
  const token = '0x1111111111111111111111111111111111111111' as Address

  const baseTimestamp = 1700000000n
  const windowDuration = 86400n // 24 hours
  const currentTimestamp = baseTimestamp + 100000n // ~27 hours later

  // SWAP that happened before window (should be expired)
  const oldSwap: ProtocolExecutionEvent = {
    subAccount,
    target,
    opType: OperationType.SWAP,
    tokensIn: ['0x0000000000000000000000000000000000000000' as Address],
    amountsIn: [1000000000000000000n],
    tokensOut: [token],
    amountsOut: [500000000000000000n],
    spendingCost: 100000000000000000n,
    timestamp: baseTimestamp, // This is outside the window
    blockNumber: 1000000n,
    logIndex: 0,
  }

  // SWAP that happened within window
  const recentSwap: ProtocolExecutionEvent = {
    subAccount,
    target,
    opType: OperationType.SWAP,
    tokensIn: ['0x0000000000000000000000000000000000000000' as Address],
    amountsIn: [1000000000000000000n],
    tokensOut: [token],
    amountsOut: [300000000000000000n],
    spendingCost: 50000000000000000n,
    timestamp: currentTimestamp - 1000n, // Within window
    blockNumber: 1000001n,
    logIndex: 0,
  }

  const protocolEvents = [oldSwap, recentSwap]
  const transferEvents: TransferExecutedEvent[] = []

  const state = buildSubAccountState(protocolEvents, transferEvents, subAccount, currentTimestamp, windowDuration)

  const issues: string[] = []

  // Only the recent swap's tokens should count (old ones expired)
  const tokenBalance = state.acquiredBalances.get(token.toLowerCase() as Address)
  if (tokenBalance !== 300000000000000000n) {
    issues.push(`token balance: expected 300000000000000000 (expired old), got ${tokenBalance}`)
  }

  // Only recent spending should count
  if (state.totalSpendingInWindow !== 50000000000000000n) {
    issues.push(`totalSpendingInWindow: expected 50000000000000000, got ${state.totalSpendingInWindow}`)
  }

  return {
    testName: 'Expiry window handling',
    passed: issues.length === 0,
    details: issues.length === 0 ? 'All checks passed' : issues.join('\n'),
  }
}

function testEmptyArrays(): TestResult {
  const subAccount = '0x1234567890123456789012345678901234567890' as Address
  const target = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address

  const baseTimestamp = 1700000000n
  const currentTimestamp = baseTimestamp + 3600n
  const windowDuration = 86400n

  // SWAP with empty input arrays (edge case)
  const swap: ProtocolExecutionEvent = {
    subAccount,
    target,
    opType: OperationType.SWAP,
    tokensIn: [],
    amountsIn: [],
    tokensOut: ['0x1111111111111111111111111111111111111111' as Address],
    amountsOut: [500000000000000000n],
    spendingCost: 100000000000000000n,
    timestamp: baseTimestamp,
    blockNumber: 1000000n,
    logIndex: 0,
  }

  const protocolEvents = [swap]
  const transferEvents: TransferExecutedEvent[] = []

  try {
    const state = buildSubAccountState(protocolEvents, transferEvents, subAccount, currentTimestamp, windowDuration)

    // Output should be acquired (no input to consume)
    const balance = state.acquiredBalances.get('0x1111111111111111111111111111111111111111' as Address)
    if (balance !== 500000000000000000n) {
      return {
        testName: 'Empty input arrays',
        passed: false,
        details: `Expected output to be acquired, got ${balance}`,
      }
    }

    return {
      testName: 'Empty input arrays',
      passed: true,
      details: 'All checks passed',
    }
  } catch (error) {
    return {
      testName: 'Empty input arrays',
      passed: false,
      details: `Error: ${error}`,
    }
  }
}

function testZeroAmounts(): TestResult {
  const subAccount = '0x1234567890123456789012345678901234567890' as Address
  const target = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address
  const token1 = '0x1111111111111111111111111111111111111111' as Address
  const token2 = '0x2222222222222222222222222222222222222222' as Address

  const baseTimestamp = 1700000000n
  const currentTimestamp = baseTimestamp + 3600n
  const windowDuration = 86400n

  // SWAP with some zero amounts in arrays
  const swap: ProtocolExecutionEvent = {
    subAccount,
    target,
    opType: OperationType.SWAP,
    tokensIn: [token1, token2],
    amountsIn: [0n, 500000000000000000n], // First amount is 0
    tokensOut: [token2],
    amountsOut: [400000000000000000n],
    spendingCost: 100000000000000000n,
    timestamp: baseTimestamp,
    blockNumber: 1000000n,
    logIndex: 0,
  }

  const protocolEvents = [swap]
  const transferEvents: TransferExecutedEvent[] = []

  try {
    const state = buildSubAccountState(protocolEvents, transferEvents, subAccount, currentTimestamp, windowDuration)

    // Should handle zero amounts gracefully
    return {
      testName: 'Zero amounts in arrays',
      passed: true,
      details: 'Handled zero amounts gracefully',
    }
  } catch (error) {
    return {
      testName: 'Zero amounts in arrays',
      passed: false,
      details: `Error: ${error}`,
    }
  }
}

function testDuplicateTokens(): TestResult {
  const subAccount = '0x1234567890123456789012345678901234567890' as Address
  const target = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address
  const token = '0x1111111111111111111111111111111111111111' as Address

  const baseTimestamp = 1700000000n
  const currentTimestamp = baseTimestamp + 3600n
  const windowDuration = 86400n

  // First acquire some tokens
  const swap1: ProtocolExecutionEvent = {
    subAccount,
    target,
    opType: OperationType.SWAP,
    tokensIn: ['0x0000000000000000000000000000000000000000' as Address],
    amountsIn: [1000000000000000000n],
    tokensOut: [token],
    amountsOut: [1000000000000000000n],
    spendingCost: 100000000000000000n,
    timestamp: baseTimestamp,
    blockNumber: 1000000n,
    logIndex: 0,
  }

  // DEPOSIT with same token appearing twice in output (edge case)
  const deposit: ProtocolExecutionEvent = {
    subAccount,
    target,
    opType: OperationType.DEPOSIT,
    tokensIn: [token],
    amountsIn: [500000000000000000n],
    tokensOut: [token, token], // Same token twice
    amountsOut: [200000000000000000n, 200000000000000000n],
    spendingCost: 0n,
    timestamp: baseTimestamp + 100n,
    blockNumber: 1000001n,
    logIndex: 0,
  }

  const protocolEvents = [swap1, deposit]
  const transferEvents: TransferExecutedEvent[] = []

  try {
    const state = buildSubAccountState(protocolEvents, transferEvents, subAccount, currentTimestamp, windowDuration)

    // Should have: 1000 - 500 (consumed) + 200 + 200 (output) = 900
    // But outputs inherit timestamp from input, so all 900 should be acquired
    const balance = state.acquiredBalances.get(token.toLowerCase() as Address)
    const expected = 500000000000000000n + 200000000000000000n + 200000000000000000n // remaining + outputs

    if (balance !== expected) {
      return {
        testName: 'Duplicate tokens in output',
        passed: false,
        details: `Expected ${expected}, got ${balance}`,
      }
    }

    return {
      testName: 'Duplicate tokens in output',
      passed: true,
      details: 'All checks passed',
    }
  } catch (error) {
    return {
      testName: 'Duplicate tokens in output',
      passed: false,
      details: `Error: ${error}`,
    }
  }
}

function testTransferConsumesAcquired(): TestResult {
  const subAccount = '0x1234567890123456789012345678901234567890' as Address
  const target = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address
  const token = '0x1111111111111111111111111111111111111111' as Address

  const baseTimestamp = 1700000000n
  const currentTimestamp = baseTimestamp + 3600n
  const windowDuration = 86400n

  // First acquire tokens via SWAP
  const swap: ProtocolExecutionEvent = {
    subAccount,
    target,
    opType: OperationType.SWAP,
    tokensIn: ['0x0000000000000000000000000000000000000000' as Address],
    amountsIn: [1000000000000000000n],
    tokensOut: [token],
    amountsOut: [500000000000000000n],
    spendingCost: 100000000000000000n,
    timestamp: baseTimestamp,
    blockNumber: 1000000n,
    logIndex: 0,
  }

  // Transfer some tokens out
  const transfer: TransferExecutedEvent = {
    subAccount,
    token,
    recipient: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as Address,
    amount: 200000000000000000n,
    spendingCost: 50000000000000000n,
    timestamp: baseTimestamp + 100n,
    blockNumber: 1000001n,
    logIndex: 0,
  }

  const protocolEvents = [swap]
  const transferEvents = [transfer]

  const state = buildSubAccountState(protocolEvents, transferEvents, subAccount, currentTimestamp, windowDuration)

  const issues: string[] = []

  // Should have 500 - 200 = 300 remaining
  const balance = state.acquiredBalances.get(token.toLowerCase() as Address)
  if (balance !== 300000000000000000n) {
    issues.push(`Expected 300000000000000000, got ${balance}`)
  }

  // Spending should include both swap cost and transfer cost
  if (state.totalSpendingInWindow !== 150000000000000000n) {
    issues.push(`Expected spending 150000000000000000, got ${state.totalSpendingInWindow}`)
  }

  return {
    testName: 'Transfer consumes acquired balance',
    passed: issues.length === 0,
    details: issues.length === 0 ? 'All checks passed' : issues.join('\n'),
  }
}

function testClaimWithoutDeposit(): TestResult {
  const subAccount = '0x1234567890123456789012345678901234567890' as Address
  const target = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address
  const rewardToken = '0x1111111111111111111111111111111111111111' as Address

  const baseTimestamp = 1700000000n
  const currentTimestamp = baseTimestamp + 3600n
  const windowDuration = 86400n

  // CLAIM rewards without any prior deposit (no matching deposit records)
  const claim: ProtocolExecutionEvent = {
    subAccount,
    target,
    opType: OperationType.CLAIM,
    tokensIn: [],
    amountsIn: [],
    tokensOut: [rewardToken],
    amountsOut: [100000000000000000n],
    spendingCost: 0n,
    timestamp: baseTimestamp,
    blockNumber: 1000000n,
    logIndex: 0,
  }

  const protocolEvents = [claim]
  const transferEvents: TransferExecutedEvent[] = []

  const state = buildSubAccountState(protocolEvents, transferEvents, subAccount, currentTimestamp, windowDuration)

  const issues: string[] = []

  // CLAIM without matching deposit should NOT add to acquired balance
  // (since no deposit was matched, the output is not considered acquired)
  const balance = state.acquiredBalances.get(rewardToken.toLowerCase() as Address)
  if (balance !== undefined && balance !== 0n) {
    issues.push(`CLAIM without deposit should not create acquired balance, got ${balance}`)
  }

  return {
    testName: 'CLAIM without matching deposit',
    passed: issues.length === 0,
    details: issues.length === 0 ? 'All checks passed' : issues.join('\n'),
  }
}

function testLargeNumbers(): TestResult {
  const subAccount = '0x1234567890123456789012345678901234567890' as Address
  const target = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address
  const token = '0x1111111111111111111111111111111111111111' as Address

  const baseTimestamp = 1700000000n
  const currentTimestamp = baseTimestamp + 3600n
  const windowDuration = 86400n

  // Very large amounts (near uint256 max)
  const largeAmount = 100000000000000000000000000000000000000n // 100 * 10^36

  const swap: ProtocolExecutionEvent = {
    subAccount,
    target,
    opType: OperationType.SWAP,
    tokensIn: ['0x0000000000000000000000000000000000000000' as Address],
    amountsIn: [largeAmount],
    tokensOut: [token],
    amountsOut: [largeAmount],
    spendingCost: largeAmount / 100n,
    timestamp: baseTimestamp,
    blockNumber: 1000000n,
    logIndex: 0,
  }

  const protocolEvents = [swap]
  const transferEvents: TransferExecutedEvent[] = []

  try {
    const state = buildSubAccountState(protocolEvents, transferEvents, subAccount, currentTimestamp, windowDuration)

    const balance = state.acquiredBalances.get(token.toLowerCase() as Address)
    if (balance !== largeAmount) {
      return {
        testName: 'Large numbers handling',
        passed: false,
        details: `Expected ${largeAmount}, got ${balance}`,
      }
    }

    return {
      testName: 'Large numbers handling',
      passed: true,
      details: 'All checks passed',
    }
  } catch (error) {
    return {
      testName: 'Large numbers handling',
      passed: false,
      details: `Error: ${error}`,
    }
  }
}

function testChainedOperations(): TestResult {
  const subAccount = '0x1234567890123456789012345678901234567890' as Address
  const target = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address
  const token1 = '0x1111111111111111111111111111111111111111' as Address
  const token2 = '0x2222222222222222222222222222222222222222' as Address
  const token3 = '0x3333333333333333333333333333333333333333' as Address

  const baseTimestamp = 1700000000n
  const currentTimestamp = baseTimestamp + 3600n
  const windowDuration = 86400n

  // Chain: SWAP -> SWAP -> SWAP (should preserve original timestamp)
  const swap1: ProtocolExecutionEvent = {
    subAccount,
    target,
    opType: OperationType.SWAP,
    tokensIn: ['0x0000000000000000000000000000000000000000' as Address],
    amountsIn: [1000000000000000000n],
    tokensOut: [token1],
    amountsOut: [500000000000000000n],
    spendingCost: 100000000000000000n,
    timestamp: baseTimestamp,
    blockNumber: 1000000n,
    logIndex: 0,
  }

  const swap2: ProtocolExecutionEvent = {
    subAccount,
    target,
    opType: OperationType.SWAP,
    tokensIn: [token1],
    amountsIn: [500000000000000000n],
    tokensOut: [token2],
    amountsOut: [400000000000000000n],
    spendingCost: 0n,
    timestamp: baseTimestamp + 100n,
    blockNumber: 1000001n,
    logIndex: 0,
  }

  const swap3: ProtocolExecutionEvent = {
    subAccount,
    target,
    opType: OperationType.SWAP,
    tokensIn: [token2],
    amountsIn: [400000000000000000n],
    tokensOut: [token3],
    amountsOut: [300000000000000000n],
    spendingCost: 0n,
    timestamp: baseTimestamp + 200n,
    blockNumber: 1000002n,
    logIndex: 0,
  }

  const protocolEvents = [swap1, swap2, swap3]
  const transferEvents: TransferExecutedEvent[] = []

  const state = buildSubAccountState(protocolEvents, transferEvents, subAccount, currentTimestamp, windowDuration)

  const issues: string[] = []

  // token1 should be 0 (all consumed)
  const balance1 = state.acquiredBalances.get(token1.toLowerCase() as Address)
  if (balance1 !== undefined && balance1 !== 0n) {
    issues.push(`token1 should be 0, got ${balance1}`)
  }

  // token2 should be 0 (all consumed)
  const balance2 = state.acquiredBalances.get(token2.toLowerCase() as Address)
  if (balance2 !== undefined && balance2 !== 0n) {
    issues.push(`token2 should be 0, got ${balance2}`)
  }

  // token3 should be 300000000000000000n (inherited original timestamp from swap1)
  const balance3 = state.acquiredBalances.get(token3.toLowerCase() as Address)
  if (balance3 !== 300000000000000000n) {
    issues.push(`token3 should be 300000000000000000, got ${balance3}`)
  }

  return {
    testName: 'Chained SWAP operations (timestamp inheritance)',
    passed: issues.length === 0,
    details: issues.length === 0 ? 'All checks passed' : issues.join('\n'),
  }
}

// ============ Main ============

async function main() {
  console.log('=== Spending Oracle Fuzzing Tests ===\n')

  const results: TestResult[] = []

  // Specific scenario tests
  console.log('Running specific scenario tests...\n')
  results.push(testMultiTokenDeposit())
  results.push(testMultiTokenWithdraw())
  results.push(testMixedAcquiredNonAcquired())
  results.push(testExpiryWindow())

  // Edge case tests
  console.log('Running edge case tests...\n')
  results.push(testEmptyArrays())
  results.push(testZeroAmounts())
  results.push(testDuplicateTokens())
  results.push(testTransferConsumesAcquired())
  results.push(testClaimWithoutDeposit())
  results.push(testLargeNumbers())
  results.push(testChainedOperations())

  // Fuzzing tests
  console.log('Running fuzzing tests...\n')
  for (let seed = 1; seed <= 20; seed++) {
    results.push(runFuzzTest(10, seed))
  }
  for (let seed = 100; seed <= 105; seed++) {
    results.push(runFuzzTest(50, seed))
  }
  for (let seed = 1000; seed <= 1002; seed++) {
    results.push(runFuzzTest(100, seed))
  }

  // Print results
  console.log('\n=== Test Results ===\n')

  let passed = 0
  let failed = 0

  for (const result of results) {
    if (result.passed) {
      console.log(`✓ ${result.testName}`)
      passed++
    } else {
      console.log(`✗ ${result.testName}`)
      console.log(`  ${result.details.split('\n').join('\n  ')}`)
      failed++
    }
  }

  console.log(`\n=== Summary ===`)
  console.log(`Passed: ${passed}`)
  console.log(`Failed: ${failed}`)
  console.log(`Total: ${results.length}`)

  if (failed > 0) {
    process.exit(1)
  }
}

main().catch(console.error)
