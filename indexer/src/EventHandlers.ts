/**
 * S4b Envio Event Handlers
 *
 * Persists raw event data from SpendInteractor and DeFiInteractor.
 * Business logic (FIFO, state building) stays in spending-oracle.ts.
 */

import {
  SpendInteractor,
  DeFiInteractor,
} from "generated";

// ============ SpendInteractor Events ============

SpendInteractor.SpendAuthorized.handler(async ({ event, context }) => {
  context.SpendAuthorized.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    m2: event.params.m2,
    eoa: event.params.eoa,
    amount: event.params.amount,
    recipientHash: event.params.recipientHash,
    transferType: event.params.transferType,
    nonce: event.params.nonce,
    blockNumber: BigInt(event.block.number),
    txHash: event.transaction.hash,
    logIndex: event.logIndex,
    timestamp: BigInt(event.block.timestamp),
  });
});

// ============ DeFiInteractor Events ============

DeFiInteractor.ProtocolExecution.handler(async ({ event, context }) => {
  context.ProtocolExecution.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    subAccount: event.params.subAccount,
    target: event.params.target,
    opType: event.params.opType,
    tokensIn: event.params.tokensIn,
    amountsIn: event.params.amountsIn.map((a: bigint) => a),
    tokensOut: event.params.tokensOut,
    amountsOut: event.params.amountsOut.map((a: bigint) => a),
    spendingCost: event.params.spendingCost,
    blockNumber: BigInt(event.block.number),
    txHash: event.transaction.hash,
    logIndex: event.logIndex,
    timestamp: BigInt(event.block.timestamp),
  });
});

DeFiInteractor.TransferExecuted.handler(async ({ event, context }) => {
  context.TransferExecuted.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    subAccount: event.params.subAccount,
    token: event.params.token,
    recipient: event.params.recipient,
    amount: event.params.amount,
    spendingCost: event.params.spendingCost,
    blockNumber: BigInt(event.block.number),
    txHash: event.transaction.hash,
    logIndex: event.logIndex,
    timestamp: BigInt(event.block.timestamp),
  });
});

DeFiInteractor.SafeValueUpdated.handler(async ({ event, context }) => {
  context.SafeValueUpdated.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    totalValueUSD: event.params.totalValueUSD,
    updateCount: event.params.updateCount,
    blockNumber: BigInt(event.block.number),
    txHash: event.transaction.hash,
    logIndex: event.logIndex,
    timestamp: BigInt(event.block.timestamp),
  });
});

DeFiInteractor.SpendingAllowanceUpdated.handler(async ({ event, context }) => {
  context.SpendingAllowanceUpdated.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    subAccount: event.params.subAccount,
    newAllowance: event.params.newAllowance,
    blockNumber: BigInt(event.block.number),
    txHash: event.transaction.hash,
    logIndex: event.logIndex,
    timestamp: BigInt(event.block.timestamp),
  });
});

DeFiInteractor.AcquiredBalanceUpdated.handler(async ({ event, context }) => {
  context.AcquiredBalanceUpdated.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    subAccount: event.params.subAccount,
    token: event.params.token,
    newBalance: event.params.newBalance,
    blockNumber: BigInt(event.block.number),
    txHash: event.transaction.hash,
    logIndex: event.logIndex,
    timestamp: BigInt(event.block.timestamp),
  });
});
