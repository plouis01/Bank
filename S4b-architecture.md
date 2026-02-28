# S4b Architecture — On-Chain Authorization + Unlink Execution Pool

## Crypto Banking Infrastructure: Full Technical Specification

**Version:** 1.1  
**Date:** February 2026  
**Status:** Architecture Design — Ready for Implementation Planning  
**Update:** M2 multisig corrected to 3/3. Two distinct paths (EOA module + M2 direct with bank auto-sign).

---

## 1. Executive Summary

S4b is a crypto banking architecture that separates **authorization** (on-chain, trustless) from **execution** (Unlink private transfers, maximally private). Clients hold accounts represented by Safe multisig wallets (M2) that enforce spending limits via Interactor smart contracts. Payments don't move funds from the Safe — instead, on-chain authorization emits an event, and the bank's backend executes the actual payment from a single shared Unlink spending pool.

This design achieves three properties simultaneously that previous architectures traded against each other:

- **Trustless spending enforcement** — Interactor reverts on violation, no off-chain trust needed
- **Maximum payment privacy** — all client payments exit from one shared pool, hiding sender/recipient/amount
- **Maximum capital efficiency** — M1 treasury holds everything except a small shared spending pool, all earning yield

For DeFi-enabled clients (Tier B), the M2 Safe receives a dedicated allocation and interacts directly with protocols (Aave, Uniswap, etc.), owning positions on-chain with no omnibus bookkeeping.

---

## 2. Architecture Overview

### 2.1 Design Principles

1. **Authorization ≠ Execution.** Validating that a payment is allowed (on-chain Interactor) is separate from moving the funds (Unlink private transfer). This separation is the core innovation.
2. **Privacy where it matters.** External payments are private (Unlink). Internal controls are transparent (on-chain). Regulators can verify enforcement rules independently.
3. **Capital stays productive.** Funds live in M1 (yield strategies) until the moment they're needed. The Unlink spending pool holds only 1-2 days of total bank spending volume.
4. **No omnibus accounting for DeFi.** When clients do DeFi, their M2 Safe owns the position (aTokens, LP tokens). No off-chain bookkeeping to track "who owns what share of a shared pool."
5. **Minimal Unlink dependency surface.** Unlink handles private transfers only. It doesn't need to support multisig, enforce limits, or manage per-client accounts.

### 2.2 Component Map

```
┌─────────────────────────────────────────────────────────┐
│                    M1 — TREASURY SAFE                    │
│         (3/5 multisig, xVault + xTimelock)              │
│         Holds majority of bank funds                     │
│         DeFi yield strategies (Aave, Morpho, etc.)      │
│         Timelocked withdrawals for large amounts         │
└────────────┬────────────────────────┬───────────────────┘
             │                        │
             │ JIT funding            │ DeFi allocation
             │ (batched, standardized)│ (on-demand)
             ▼                        ▼
┌────────────────────────┐  ┌──────────────────────────────┐
│  BANK UNLINK SPENDING  │  │  M2 SAFE (Tier B — DeFi)     │
│  POOL                  │  │  (3/3 multisig per client)    │
│                        │  │  Holds DeFi allocation only   │
│  Single Unlink account │  │  Interacts with protocols     │
│  controlled by bank    │  │  Owns aTokens, LP NFTs, etc.  │
│  All client spending   │  │  EOA subaccounts for DeFi ops │
│  exits from here       │  │  IntEOA module validates      │
│  Funded from M1 (JIT)  │  └──────────────────────────────┘
└────────────▲───────────┘
             │ backend executes
             │ after on-chain auth
┌────────────┴────────────────────────────────────────────┐
│            ON-CHAIN AUTHORIZATION LAYER                   │
│                                                          │
│  M2-1 (no spending funds)     M2-2 (no spending funds)   │
│   ├── EOA-a (card)             ├── EOA-c (card)          │
│   └── EOA-b (transfer)         └── EOA-d (DeFi — Tier B)│
│                                                          │
│  Each M2 has SpendInteractor module:                     │
│   • Per-EOA 24h rolling spend tracking                   │
│   • Amount validation (reverts if over limit)            │
│   • Recipient type validation                            │
│   • Emits SpendAuthorized(m2, eoa, amount, recipient,    │
│     nonce) event on success                              │
│   • DOES NOT move funds — authorization only             │
└──────────────────────────────────────────────────────────┘
```

### 2.3 Two Client Tiers

**Tier A — Non-DeFi Clients (expected majority)**

- M2 Safe exists for identity, authorization, and recovery
- M2 holds **zero spending funds** — all payments come from the shared Unlink pool
- EOA subaccounts authorized via Interactor for spending within limits
- Simple, low-gas footprint per client

**Tier B — DeFi Clients**

- Everything in Tier A, plus:
- M2 receives a DeFi allocation from M1 via Unlink (funded on-demand)
- M2 interacts directly with DeFi protocols (Aave, Uniswap, Morpho, etc.)
- M2 owns DeFi positions on-chain (aTokens, LP NFTs minted to M2 address)
- EOA subaccounts can operate DeFi via IntEOA module with protocol/selector allowlists
- When DeFi unwinds, excess funds return to M1 via Unlink

---

## 3. Component Specifications

### 3.1 M1 — Treasury Safe

**Purpose:** Hold the majority of bank funds. Generate yield. Fund the Unlink spending pool and DeFi allocations.

| Property | Specification |
|---|---|
| Type | Safe (Gnosis Safe) multisig |
| Signers | 3/5 threshold (bank directors/operators) |
| Security modules | xVault + xTimelock (from MS+Timelock architecture) |
| Timelock | Configurable delay on withdrawals above threshold (e.g., €100k → 24h delay) |
| DeFi | Actively managed yield strategies (Aave, Morpho, Compound, etc.) |
| Funding operations | M1 → Unlink pool (JIT, batched) and M1 → Unlink → M2 (DeFi allocations) |

**Timelocked withdrawal flow:**

1. Signer proposes withdrawal exceeding threshold
2. TimelockController queues the operation with delay
3. During delay: other signers can cancel (emergency veto)
4. After delay: operation becomes executable
5. Any authorized signer can execute

**Yield strategy constraints:**

- Maximum protocol concentration (e.g., no more than 40% in any single protocol)
- Only whitelisted protocols (governed by M1 multisig vote)
- Reserve requirement: maintain minimum liquid balance to fund spending pool + expected DeFi allocations

### 3.2 Bank Unlink Spending Pool

**Purpose:** Single shared account from which all client spending payments are executed privately.

| Property | Specification |
|---|---|
| Type | Unlink account controlled by bank |
| Funded by | M1 → Unlink (JIT batched transfers) |
| Target balance | 1-2 days of total bank spending volume (e.g., €50k-€100k for a small bank) |
| Controls | Bank holds the key; no client has direct access |
| Privacy | All payments exit from this single address — maximum anonymity set |

**Why one shared pool (not per-client accounts):**

- Larger anonymity set: 1000 clients' payments all mixed in one pool vs. per-client accounts with identifiable traffic patterns
- One funding operation covers all clients (M1 → pool) vs. 1000 per-client JIT top-ups
- Simpler operational model: one balance to monitor, one threshold to maintain
- No per-client Unlink account management (creation, recovery, key management)

**Pool balance management:**

- Policy Engine monitors pool balance continuously
- When balance drops below low-water mark → triggers M1 → Unlink top-up
- Top-ups use standardized amounts (e.g., €50k increments) for privacy
- High-water mark prevents over-funding (capital stays in M1 for yield)
- Emergency: M1 multisig can manually trigger top-up bypassing Policy Engine

### 3.3 M2 — Client Account Safe

**Purpose:** Represent a client account. Enforce spending limits on-chain. Hold DeFi allocations (Tier B only).

| Property | Specification |
|---|---|
| Type | Safe multisig |
| Signers | 3/3 threshold (2 client keys + 1 bank co-sign key) |
| Modules | SpendInteractor (authorization for EOA spending) + DeFi Interactor (Tier B, execution guard) |
| Funds (Tier A) | Zero spending funds. M2 is authorization-only for payments. |
| Funds (Tier B) | DeFi allocation only. No spending funds. |
| SubAccounts (EOAs) | Registered via SpendInteractor. Per-EOA spending limits. |

**Two distinct paths on the same M2:**

**PATH A — EOA SubAccount (daily operations: card payments, routine transfers)**
- EOA calls `authorizeSpend()` on SpendInteractor module
- Module validates guardrails on-chain → reverts if violated
- No multisig signatures needed — the module IS the enforcement
- Backend Bridge listens for event → executes from Unlink pool
- Fast, cheap, one signature from the EOA

**PATH B — M2 Direct Transaction (larger ops: big transfers, DeFi, account changes)**
- Client signs intent in the app (1st signature — "confirm transfer")
- Client enters PIN/password (2nd signature — authentication)
- App sends signed intent to bank backend
- Bank validates: within guardrails? Fraud check? Sanctions screen?
- If OK → bank auto-signs with 3rd key → 3/3 tx submitted on-chain
- If NOT OK → bank rejects → client notified ("exceeds limit, please contact us")

**Why 3/3 (not 2/3):**
- A single compromised client key can NEVER execute a transaction alone — not even with the bank's auto-sign, because the bank only signs after 2 client signatures
- Both client keys + bank key must all agree — maximum security for the paths that handle larger amounts or DeFi
- The bank's 3rd signature is a policy gate: it validates the transaction against guardrails before signing, not after

**M2 as authorization module (spending via EOA — Path A):**

The SpendInteractor module on M2 is modified from the original MultiSub pattern. Instead of guarding a fund-moving Safe transaction, it validates a spending intent and emits an event:

```solidity
// Simplified — actual implementation needs nonce, replay protection, etc.
function authorizeSpend(
    address eoa,
    uint256 amount,
    bytes32 recipientHash,   // hashed recipient identifier
    uint8 transferType       // 0=payment, 1=transfer, 2=interbank
) external {
    // Verify caller is registered EOA or M2 signer
    require(isAuthorizedCaller(msg.sender), "unauthorized");
    
    // Check per-EOA 24h rolling spend
    require(
        rollingSpend[eoa] + amount <= dailyLimit[eoa],
        "daily limit exceeded"
    );
    
    // Update rolling spend tracker
    _updateRollingSpend(eoa, amount);
    
    // Emit authorization event — backend listens for this
    emit SpendAuthorized(
        address(this),      // M2 address
        eoa,                // which sub-account
        amount,
        recipientHash,
        transferType,
        nonce++
    );
}
```

**Key properties:**

- `authorizeSpend` reverts if limits exceeded → trustless enforcement, no funds at risk
- The function does NOT move funds — it only validates and emits
- Backend listens for `SpendAuthorized` events and executes from Unlink pool
- On-chain state tracks per-EOA rolling spend (verifiable by anyone)
- Nonce prevents replay attacks

**M2 as DeFi operator (Tier B):**

For DeFi operations, the existing MultiSub DeFi Interactor pattern applies directly:

- EOA → IntEOA → M2 → protocol (e.g., Aave supply)
- Interactor validates: target address (allowlisted protocol), function selector (allowlisted operation), amount (within DeFi limits), asset direction (correct flow)
- M2 Safe executes the DeFi call — funds move from M2 to protocol, receipt tokens (aTokens, LP NFTs) minted to M2
- M2 owns the position on-chain

### 3.4 EOA — SubAccounts

**Purpose:** Represent specific spending channels (card, transfer, DeFi operator) with per-EOA limits.

| Property | Specification |
|---|---|
| Type | Externally Owned Account (standard private key) |
| Registration | Registered on M2's SpendInteractor with specific limits and permissions |
| Fund holding | Never holds funds (same as original MultiSub) |
| For spending | Calls `authorizeSpend()` on M2's SpendInteractor |
| For DeFi (Tier B) | Calls DeFi functions via IntEOA → M2 → protocol |

**EOA types per M2:**

- **Card EOA**: daily limit (e.g., €500), payment type only, auto-approved by policy engine
- **Transfer EOA**: higher limit (e.g., €5k), payment + transfer types, may require additional approval for large amounts
- **DeFi EOA (Tier B)**: protocol-specific limits, function selector allowlist, exposure caps

### 3.5 Policy Engine (Off-Chain)

**Purpose:** Bank-grade controls that complement on-chain enforcement. Manages funding, monitors events, orchestrates Unlink execution.

| Function | Description |
|---|---|
| Event Listener | Monitors `SpendAuthorized` events from all M2 contracts |
| Unlink Executor | After receiving authorized event, executes private transfer from pool to recipient |
| Pre-validation | Optional additional checks before EOA submits on-chain (velocity, geofence, device posture) |
| Pool Manager | Monitors Unlink pool balance, triggers M1 → pool top-ups |
| DeFi Allocator | Manages M1 → Unlink → M2 funding for Tier B DeFi requests |
| Compliance Logger | Records all authorizations + executions in Compliance Vault |
| Internal Ledger | Tracks per-client spending attribution against the shared pool |

**Pre-validation flow (optional fast-path):**

Before an EOA submits `authorizeSpend()` on-chain, the client app can call the Policy Engine to pre-check:

1. Client app sends intent (amount, recipient, type) to Policy Engine API
2. Policy Engine checks: velocity (7d/30d rolling), beneficiary registry, sanctions screen, device posture, geofence
3. If pre-approved → client app submits on-chain `authorizeSpend()`
4. If rejected → client sees rejection reason without wasting gas
5. On-chain Interactor remains the trustless backstop regardless

This is an optimization, not a requirement. The on-chain Interactor enforces limits independently.

### 3.6 Backend Bridge

**Purpose:** Stateless service that bridges on-chain authorization events to Unlink pool execution.

```
SpendAuthorized event (on-chain)
       │
       ▼
┌─────────────────┐
│  Backend Bridge  │
│                  │
│  1. Listen for   │
│     events       │
│  2. Verify event │
│     authenticity  │
│  3. Check nonce  │
│     (no replay)  │
│  4. Call Unlink  │
│     SDK: private │
│     transfer     │
│  5. Log result   │
│     to Compliance│
│     Vault        │
└─────────────────┘
       │
       ▼
Unlink pool → private transfer → merchant/recipient
```

**Critical properties:**

- **Stateless**: all state is on-chain (events) or in Compliance Vault. Restart = replay unprocessed events.
- **Horizontally scalable**: multiple instances can listen and execute. Nonce deduplication prevents double-execution.
- **Failure mode**: if backend is down, authorized events queue on-chain. When backend recovers, it replays from last processed nonce. No funds lost — just delayed execution.
- **No signing authority over M2**: the backend cannot authorize spending. It can only execute from the Unlink pool after a valid on-chain authorization event.

---

## 4. Transaction Flows

### 4.1 EOA Payment (Tier A or Tier B spending)

The most common operation. Client pays a merchant or sends a transfer.

```
Step 1: Client initiates payment via bank app
        App calls Policy Engine API for pre-validation (optional)
        Policy Engine checks velocity, sanctions, device → approved

Step 2: EOA submits authorizeSpend() to M2 SpendInteractor (on-chain)
        Interactor validates:
          ✓ EOA is registered on this M2
          ✓ amount (€85) ≤ daily limit (€500)
          ✓ rollingSpend[EOA] + €85 ≤ €500
          ✓ transfer type is allowed for this EOA
        Updates rolling spend tracker
        Emits SpendAuthorized(M2, EOA, €85, recipientHash, type, nonce)

Step 3: Backend Bridge detects SpendAuthorized event
        Verifies event came from known M2 contract
        Checks nonce hasn't been processed
        Calls Unlink SDK: privateTransfer(pool, merchant, €85)

Step 4: Unlink pool executes private transfer to merchant
        On-chain observer sees: Unlink pool → private transfer
        Cannot determine: which client, which M2, what for

Step 5: Backend logs to Compliance Vault:
        {m2, eoa, amount, recipient, txHash_auth, txHash_exec, timestamp}

Step 6: Client app receives confirmation
```

**What an on-chain observer sees:**

- M2 contract emitted a SpendAuthorized event (they can see amount + recipientHash, but recipientHash is hashed)
- Separately, the Unlink pool made a private transfer (amount and recipient are hidden by Unlink)
- No on-chain link between the M2 event and the Unlink transfer
- Even if an observer identifies the M2 address, they can't link it to the private payment

### 4.2 M2 Direct Payment (larger amounts, 3/3 multisig)

For larger payments or operations beyond EOA subaccount limits.

```
Step 1: Client initiates transfer in bank app
        Client reviews details → presses "confirm" → 1st client signature
        Client enters PIN/password → 2nd client signature
        App sends signed intent to bank backend

Step 2: Bank backend validates:
          ✓ Transaction within M2 guardrails
          ✓ Fraud detection check passed
          ✓ Sanctions screening passed
          ✓ Amount within M2-level limits
        If all checks pass → bank auto-signs with 3rd key

Step 3: If REJECTED:
          → Client receives notification: "Transaction exceeds limits" or
            "Requires manual approval — please contact us"
          → No on-chain transaction submitted, no gas spent

Step 4: If APPROVED:
          → 3/3 signed transaction submitted on-chain
          → SpendInteractor validates (same on-chain limits as EOA path)
          → Emits SpendAuthorized event

Step 5-7: Same as EOA payment flow (backend → Unlink → merchant)
```

**UX note:** The two client signatures feel like a standard banking app: tap "send" then enter your PIN. The bank's 3rd signature happens in the background (~100ms). From the client's perspective, it's instant unless rejected.

### 4.3 M2 DeFi Operation (Tier B only)

Client wants to supply €5k to Aave for yield. Two sub-paths depending on who initiates.

**Via M2 direct (client initiates large DeFi position):**

```
Step 1: Client requests DeFi operation via bank app
        Client confirms + enters PIN → 2 client signatures
        App sends intent to bank backend

Step 2: Bank validates:
          ✓ Client is Tier B (DeFi enabled)
          ✓ Aave is on protocol allowlist
          ✓ supply() is on function allowlist
          ✓ €5k within DeFi allocation limit
          ✓ Exposure: Aave 25% < 30% cap
        If OK → bank auto-signs 3rd key

Step 3: IF M2 needs DeFi allocation funding:
        Bank triggers: M1 → Unlink → M2 (€5k)
        M2 receives DeFi funds via Unlink (privacy preserved)
        (Skip this step if M2 already has sufficient DeFi balance)

Step 4: 3/3 signed transaction submitted on-chain
        DeFi Interactor validates:
          ✓ Target = Aave pool address (allowlisted)
          ✓ Selector = supply() (allowlisted)
          ✓ Asset = USDC (approved)
          ✓ Amount = €5k (within limit)
        M2 Safe executes: approve(Aave, €5k) + supply(€5k, M2)

Step 5: Aave mints aUSDC to M2 address
        M2 now owns €5k aUSDC position on-chain
        Position is verifiable, attributed to M2 (not omnibus)

Step 6: Compliance Vault logs DeFi position entry
        Monitors yield accrual
```

**Via EOA DeFi subaccount (routine DeFi operations within pre-approved limits):**

```
Step 1: EOA submits via IntEOA → M2
        DeFi Interactor validates guardrails on-chain
        No multisig needed — module enforces
Step 2: M2 Safe executes DeFi call
Step 3: Compliance Vault logs
```

### 4.4 DeFi Unwind (Tier B)

```
Step 1: Client or Policy Engine triggers DeFi unwind
Step 2: M2 calls Aave withdraw() → USDC returned to M2
Step 3: Excess funds: M2 → Unlink → M1 (returns to treasury for yield)
Step 4: Compliance Vault logs position exit + realized yield
```

### 4.5 External Incoming Funds

New deposit or incoming transfer to a client.

```
Step 1: Sender sends to bank's Unlink pool address
        (They may send via their own Unlink for privacy, or direct)
Step 2: Bank detects incoming funds in pool
Step 3: Internal ledger credits client's M2 account
        (No on-chain movement needed — pool balance increased,
         internal attribution updated)
Step 4: If pool exceeds high-water mark:
        Excess swept to M1 for yield (pool → M1 via Unlink)
```

### 4.6 Client-to-Client Internal Transfer

Client A sends €500 to Client B (both within the bank).

```
Step 1: Client A's EOA calls authorizeSpend() on M2-A SpendInteractor
        Interactor validates limits, emits SpendAuthorized

Step 2: Backend detects event, identifies as INTERNAL transfer
        (Recipient is another M2 within the bank)

Step 3: Internal ledger: debit M2-A attribution, credit M2-B attribution
        NO Unlink movement needed — pool balance unchanged
        Instant settlement

Step 4: Compliance Vault logs both sides of the transfer
```

This is the fastest possible transfer path: one on-chain authorization + one internal ledger update. Zero Unlink latency, zero gas beyond the authorization.

### 4.7 M1 → Unlink Pool Funding (JIT)

```
Step 1: Policy Engine detects pool balance < low-water mark
Step 2: Triggers M1 → Unlink pool top-up (standardized amount, e.g., €50k)
Step 3: M1 multisig approves (may be pre-authorized for routine < €100k)
Step 4: M1 deposits to Unlink pool
Step 5: Pool balance restored
```

### 4.8 Inter-Bank Transfer

```
Step 1: M2-A SpendInteractor authorizes (same as EOA payment)
Step 2: Backend executes: Unlink pool → private transfer → other bank's Unlink entry
Step 3: Neither bank sees the other's internal addresses
```

---

## 5. Security Model

### 5.1 Spending Limit Enforcement — Defense in Depth

Three independent layers, all of which must agree:

| Layer | Type | Enforcement | What it catches |
|---|---|---|---|
| **SpendInteractor** | On-chain | Reverts transaction | Per-EOA daily limits, unauthorized callers, invalid transfer types |
| **Pool Balance** | Trustless | Can't spend what's not there | Maximum aggregate loss capped by pool size |
| **Policy Engine** | Off-chain | Pre-validation | Velocity (7d/30d), sanctions, device posture, geofence, manual approval |

Even if the Policy Engine is completely compromised, the maximum damage is bounded by on-chain Interactor limits (per-EOA daily caps) AND pool balance (aggregate cap).

### 5.2 Attack Surface Analysis

**EOA key compromised (spending subaccount):**
- Maximum loss: daily spending limit for that EOA (e.g., €500)
- On-chain SpendInteractor enforces limit regardless of attacker's intent
- No multisig needed for EOA path — module is the enforcement
- Response: bank revokes EOA registration on Interactor (one tx)

**Single client key compromised:**
- M2 is 3/3 — attacker with one client key CANNOT execute any M2 transaction
- Needs both client keys + bank auto-sign to do anything via Path B
- Bank will never auto-sign without 2 valid client signatures
- Response: client reports compromise, bank freezes M2 pending key rotation

**Both client keys compromised:**
- Attacker has 2/3 — still needs bank's 3rd signature
- Bank validates guardrails + fraud checks before auto-signing
- If transactions look normal and within limits, bank will auto-sign (this is the risk)
- For DeFi (Tier B): attacker could move DeFi allocation within guardrails
- Response: bank detects anomalous patterns (unusual velocity, new recipients), freezes M2

**Bank co-sign key compromised:**
- Attacker has 1/3 — CANNOT execute any M2 transaction alone
- Needs both client keys to reach 3/3
- Response: rotate bank key across all M2s (operational, but manageable)

**Backend Bridge compromised:**
- Could execute unauthorized payments from Unlink pool
- Maximum loss: pool balance (~€50k-100k)
- Cannot create fake on-chain authorization events
- Response: freeze pool, rotate credentials, replay valid events

**Unlink pool key compromised:**
- Maximum loss: pool balance
- Mitigated by keeping pool small (JIT funding) + HSM key management
- Response: move remaining funds, create new Unlink account

**Policy Engine compromised:**
- On-chain SpendInteractor still enforces limits (trustless backstop for EOA path)
- For M2 path: attacker could manipulate bank auto-sign validation (more serious)
- Response: flag anomalies, manual review of recent M2 auto-signs

**Unlink gateway down:**
- External payments stop (queued, execute when gateway returns)
- Internal transfers still work (ledger movements)
- DeFi operations still work (on-chain, no Unlink dependency)
- Fallback: direct on-chain transfer from emergency Safe (sacrifices privacy)

---

## 6. Privacy Model

### 6.1 What Is Hidden from On-Chain Observers

| Data point | Hidden? | How |
|---|---|---|
| Payment sender (which client) | ✅ Yes | All payments exit from shared pool |
| Payment recipient | ✅ Yes | Unlink private transfer |
| Payment amount | ✅ Yes | Unlink private transfer |
| Bank aggregate position | ✅ Yes | M1 → pool uses standardized amounts + timing decorrelation |
| Client-to-client relationships | ✅ Yes | Internal = ledger movements; external = Unlink |
| DeFi positions (Tier B) | ⚠️ Partial | M2 DeFi is on-chain but M2 is pseudonymous (funded via Unlink) |
| M2 → M1 relationship | ✅ Yes | All funding via Unlink |

### 6.2 Anonymity Set

The anonymity set = all payments from the pool in a given time window. 1000 clients × 5 payments/day = each payment indistinguishable from the other 4999.

This is the maximum possible anonymity set for any architecture — a single shared pool.

### 6.3 Privacy Risk Mitigations

**Timing correlation (M2 auth event ↔ pool payment):** Backend introduces random delay + batches multiple authorizations.

**Pool balance analysis:** Standardized top-up amounts, floating balance (never drain to zero), top up before critical threshold.

**M2 address identification:** M2 funded exclusively via Unlink, never appears in external transactions, authorization events use hashed recipient data.

---

## 7. Audit & Compliance

### 7.1 Three Audit Views

**Client Statement:** M2 authorization events, payment confirmations, DeFi positions (Tier B), spending limit usage.

**Internal Ops:** All M2 events, pool balance/flow, policy decisions, execution logs, internal ledger.

**Regulator/Auditor:** Everything above + Unlink viewing key for pool → full private transfer history reconstruction.

### 7.2 Reconciliation Invariant

Must hold at all times:

```
M1_balance
+ Unlink_pool_balance
+ Σ(M2_DeFi_positions_at_mark)
+ pending_timelock_operations
= total_bank_assets
± rounding
```

Spending attribution:

```
Unlink_pool_balance = Σ(client_ledger_balances) + unattributed_incoming
```

---

## 8. Smart Contract Architecture

### 8.1 Contracts to Build / Modify

| Contract | Status | Description |
|---|---|---|
| `SpendInteractor.sol` | **New** | Validates spending intents, emits authorization events. Does NOT move funds. |
| `DeFiInteractor.sol` | **Existing (MultiSub)** | Guards DeFi operations on M2 Safe — protocol/selector allowlist, amount limits |
| `IntEOA.sol` | **Existing (MultiSub)** | EOA extension module for calling through to M2 |
| M2 Safe | **Existing (Gnosis Safe)** | Standard Safe with custom modules |
| M1 Safe | **Existing (Gnosis Safe)** | Treasury Safe with xVault + xTimelock |

### 8.2 SpendInteractor — Key Interface

```solidity
interface ISpendInteractor {
    // Events
    event SpendAuthorized(
        address indexed m2,
        address indexed eoa,
        uint256 amount,
        bytes32 recipientHash,
        uint8 transferType,
        uint256 nonce
    );
    
    event EOARegistered(address indexed eoa, uint256 dailyLimit, uint8[] allowedTypes);
    event EOARevoked(address indexed eoa);
    event LimitUpdated(address indexed eoa, uint256 newDailyLimit);
    
    // Core authorization
    function authorizeSpend(
        address eoa,
        uint256 amount,
        bytes32 recipientHash,
        uint8 transferType
    ) external;
    
    // EOA management (only M2 signers)
    function registerEOA(address eoa, uint256 dailyLimit, uint8[] calldata allowedTypes) external;
    function revokeEOA(address eoa) external;
    function updateLimit(address eoa, uint256 newDailyLimit) external;
    
    // View functions
    function getRollingSpend(address eoa) external view returns (uint256);
    function getRemainingLimit(address eoa) external view returns (uint256);
    function getDailyLimit(address eoa) external view returns (uint256);
    function isRegisteredEOA(address eoa) external view returns (bool);
}
```

### 8.3 Rolling Spend Tracking

```solidity
struct SpendRecord {
    uint256 amount;
    uint256 timestamp;
}

mapping(address => SpendRecord[]) private spendHistory;
mapping(address => uint256) public dailyLimit;

function _getRollingSpend(address eoa) internal view returns (uint256 total) {
    uint256 windowStart = block.timestamp - 24 hours;
    SpendRecord[] storage records = spendHistory[eoa];
    for (uint i = records.length; i > 0; i--) {
        if (records[i-1].timestamp < windowStart) break;
        total += records[i-1].amount;
    }
}
```

---

## 9. Off-Chain Components

### 9.1 Backend Bridge Service

Lightweight event processor (Node.js/TypeScript or Rust).

- Listens for SpendAuthorized events from known M2 contracts
- Nonce deduplication (Redis or in-memory)
- Calls Unlink SDK for private transfers
- Logs to Compliance Vault
- Stateless: restart = replay unprocessed events from last nonce

### 9.2 Bank Auto-Sign Service

Validates M2 Path B transactions and provides the bank's 3rd signature.

- API endpoint: receives client-signed intent (2 of 3 signatures)
- Guardrail validation: amount, recipient, tx type against M2 policy
- Fraud detection: velocity analysis, new recipient flagging, unusual patterns
- Sanctions screening integration
- If approved: signs with bank key → submits 3/3 tx on-chain
- If rejected: returns reason to client app
- Every decision (approve/reject) logged to Compliance Vault

### 9.3 Policy Engine Service

Stateful rules engine (Node.js/TypeScript or Python).

- Pre-validation API for client app (EOA path — optional fast-path)
- Pool balance monitoring + M1 top-up triggering
- DeFi allocation management (Tier B)
- Internal ledger (per-client attribution against shared pool)
- Sanctions screening integration
- Alert generation for anomalous patterns

### 9.4 Client App

React Native (mobile) or web app.

- Display balance (from internal ledger) + native yield display on home screen
- **Path A (EOA spending):** tap send → sign with EOA key → on-chain authorization → status tracking
- **Path B (M2 direct):** tap send (1st sig) → enter PIN (2nd sig) → bank validates → auto-sign or reject → status tracking
- Rejection UX: clear message + contact action when bank rejects a Path B transaction
- Transaction history (from Compliance Vault)
- EOA subaccount view (cards, transfer accounts, limits, remaining allowance)
- Receive money: display deposit reference number + Unlink deposit address
- DeFi dashboard (Tier B): positions, yield, protocol selection
- Security summary: active subaccounts, signature workflow, recent activity

---

## 10. Key Trade-offs

### 10.1 Authorization-Execution Gap

On-chain authorization happens before Unlink execution. Client sees "authorized" before merchant receives funds. Backend should execute within seconds. Two-phase status UX: "Authorized ✓" → "Executed ✓". Events queue on-chain if backend is down — replay on recovery.

### 10.2 Internal Ledger = Omnibus for Spending

Per-client spending attribution against the shared pool is off-chain bookkeeping. This IS omnibus for spending. Acceptable because: pool is small (€50k-100k), DeFi positions are NOT omnibus (on-chain per-client), and traditional banks operate identically.

### 10.3 Unlink Maturity

Currently testnet-only on Monad. Need: mainnet deployment, private transfer API, viewing key mechanism, self-hosted gateway option. Fallback: emergency direct on-chain transfers (sacrifice privacy for liveness).

### 10.4 SpendInteractor Novelty

New smart contract pattern (authorization-only, no fund movement). Core limit-tracking logic is well-understood. Needs thorough testing and audit before production use.

---

## 11. Glossary

| Term | Definition |
|---|---|
| **M1** | Treasury multisig Safe. Holds majority of funds. Generates yield. |
| **M2** | Client account Safe. Authorizes spending. Holds DeFi allocation (Tier B). |
| **EOA** | SubAccount. Registered on M2 SpendInteractor with per-EOA limits. |
| **SpendInteractor** | Module on M2 — validates spending intents, emits auth events. No fund movement. |
| **DeFi Interactor** | Module on M2 — guards DeFi operations (allowlists, limits). Moves funds through Safe. |
| **IntEOA** | Extension module letting EOA subaccounts call through to M2. |
| **Unlink Pool** | Single bank-controlled Unlink account for all private payment execution. |
| **Backend Bridge** | Stateless service bridging on-chain auth events to Unlink execution. |
| **Policy Engine** | Off-chain service for pre-validation, pool management, compliance. |
| **Compliance Vault** | Audit-grade storage of all authorizations, executions, and decisions. |
| **xVault + xTimelock** | Safe modules for role-based access and timelocked withdrawals on M1. |
| **Tier A** | Non-DeFi client. M2 for authorization only. Spending from shared pool. |
| **Tier B** | DeFi-enabled client. Tier A + DeFi allocation on M2. |
