# S4b Implementation Plan

## Phases, Dependencies & Parallelization

**Architecture:** S4b — On-Chain Authorization + Unlink Execution Pool  
**Team:** 3 developers + 1 marketing  
**Date:** February 2026

---

## Phase Overview

```
Week  1  2  3  4  5  6  7  8  9  10  11  12  13  14
      ├──────────────┤
      │  PHASE 1     │  Foundation (Smart Contracts + Infra)
      │              ├──────────────┤
      │              │  PHASE 2     │  Backend Bridge + Policy Engine
      │              │              ├──────────────────┤
      │              │              │  PHASE 3         │  Unlink Integration + Client App
      │              │              │                  ├────────┤
      │              │              │                  │ PHASE 4│  Testing + Audit
      ├──────────────┴──────────────┴──────────────────┴────────┤
      │  MARKETING: positioning, docs, outreach (continuous)    │
```

---

## Phase 1 — Foundation (Weeks 1-4)

**Goal:** Core smart contracts deployed on testnet. M1 and M2 Safes operational. On-chain authorization working end-to-end in isolation (without Unlink or backend).

### 1A. SpendInteractor Contract (Dev 1 — weeks 1-4)

The critical new contract. Authorization-only module for M2 Safes.

**Week 1-2: Core logic**
- Rolling spend tracker (24h window per EOA)
- `authorizeSpend()` function with revert on limit exceeded
- `SpendAuthorized` event emission with nonce
- EOA registration/revocation (only M2 signers can manage)
- Limit management (update daily caps)
- Unit tests for all limit enforcement edge cases

**Week 3: Security hardening**
- Replay protection (nonce tracking)
- Reentrancy guards
- Access control (only registered EOAs or M2 signers can call)
- Gas optimization (rolling window cleanup)
- Fuzz testing with Foundry

**Week 4: Integration with Safe**
- Deploy as Zodiac-compatible module on Safe
- Test with actual Safe multisig (M2) configured as 3/3
- Verify module enable/disable by Safe owners
- Test Path A: EOA → IntEOA → M2 → SpendInteractor (module validates, no multisig needed)
- Test Path B: 3/3 signed tx → SpendInteractor validates → event emitted
- Verify that Path B requires all 3 signatures before tx executes

**Deliverable:** `SpendInteractor.sol` deployed on testnet, full test suite passing, compatible with Safe + IntEOA.

### 1B. DeFi Interactor Adaptation (Dev 2 — weeks 1-3)

Adapt existing MultiSub DeFi Interactor for Tier B M2 operations.

**Week 1-2: Adaptation**
- Fork existing DeFi Interactor from MultiSub codebase
- Configure for target protocols (Aave v3, Uniswap v3 initially)
- Function selector allowlists per protocol
- Amount limits per DeFi operation type
- Asset direction validation (USDC out → aUSDC in for supply, etc.)

**Week 3: Testing**
- Test against Aave v3 on testnet (supply, withdraw)
- Test against Uniswap v3 on testnet (swap, addLiquidity)
- Test limit enforcement (revert on over-limit)
- Test EOA → IntEOA → M2 → DeFi Interactor → protocol chain

**Deliverable:** `DeFiInteractor.sol` configured and tested for Aave + Uniswap on testnet.

### 1C. M1 Treasury Safe Setup (Dev 3 — weeks 1-3)

**Week 1: Safe deployment + module setup**
- Deploy M1 Safe (3/5 multisig configuration)
- Deploy and configure xVault module (role-based access)
- Deploy and configure xTimelock (TimelockController with configurable delay)
- Test basic multisig operations

**Week 2: Timelock integration**
- Configure thresholds (e.g., >€100k requires 24h timelock)
- Test: propose → queue → cancel flow
- Test: propose → queue → delay → execute flow
- Test: emergency veto during delay period

**Week 3: Funding flows (mock Unlink)**
- Test M1 → external address transfers (simulating Unlink deposit)
- Test with timelocked large withdrawals
- Configure pre-authorized routine operations (auto-approve < threshold)

**Deliverable:** M1 Safe fully operational on testnet with xVault + xTimelock.

### 1D. Infrastructure Setup (Dev 3 — weeks 3-4, after M1 Safe)

**Week 3-4:**
- Database setup for Compliance Vault (PostgreSQL + event log schema)
- Redis for nonce deduplication
- Docker compose for local dev environment
- CI/CD pipeline (GitHub Actions → testnet deployment)
- Monitoring setup (contract event indexing)

**Deliverable:** Dev infrastructure ready for Phase 2 backend work.

---

## Phase 2 — Backend Bridge + Policy Engine (Weeks 4-8)

**Goal:** Backend listens for on-chain authorization events, executes mock payments, manages internal ledger. Policy Engine handles pre-validation and pool management.

### 2A. Backend Bridge + Bank Auto-Sign Service (Dev 1 — weeks 4-7)

**Week 4-5: Event listener + executor**
- Blockchain event listener (ethers.js or viem)
- Filter `SpendAuthorized` events from known M2 contracts
- Nonce deduplication (Redis-backed)
- Mock execution (log the payment intent — real Unlink comes in Phase 3)
- Compliance Vault logging (auth event + execution pair)
- Stateless recovery: query last processed nonce, replay unprocessed

**Week 5-6: Bank Auto-Sign Service (M2 Path B)**
- API endpoint: receives client-signed intent (2 of 3 signatures)
- Guardrail validation: check amount, recipient, tx type against M2 policy
- Fraud detection: velocity analysis, new recipient flagging, unusual patterns
- Sanctions screening (mock integration initially)
- If approved: bank signs with 3rd key → submits 3/3 tx on-chain
- If rejected: returns rejection reason to client app
- Logging: every decision (approve/reject) logged to Compliance Vault

**Week 6: Internal ledger**
- Per-client balance attribution against shared pool
- Credit/debit on authorization events
- Internal transfer detection (M2-A → M2-B within bank = ledger movement only)
- Balance reconciliation endpoint

**Week 7: Error handling + resilience**
- Retry logic for failed executions
- Dead letter queue for irreconcilable events
- Health check endpoint
- Graceful shutdown (finish processing current event before stopping)
- Alert on: nonce gap, execution failure, pool balance critical

**Deliverable:** Backend Bridge processing authorization events, maintaining internal ledger, logging to Compliance Vault. Mock execution (no real Unlink yet).

### 2B. Policy Engine (Dev 2 — weeks 4-8)

**Week 4-5: Pre-validation API**
- REST API for client app pre-validation
- Velocity checks (7d/30d rolling limits — off-chain complement to on-chain 24h)
- Beneficiary registry (known recipients)
- Transfer type validation
- Response: approved / rejected with reason

**Week 6: Pool management**
- Pool balance monitoring service
- Low-water mark detection → trigger M1 top-up
- High-water mark detection → sweep excess to M1
- Standardized top-up amounts
- Manual override endpoint for emergency funding

**Week 7: DeFi allocation management (Tier B)**
- DeFi allocation request workflow
- M1 → M2 funding trigger
- Protocol exposure tracking per M2
- Position monitoring (yield accrual, IL tracking)

**Week 8: Sanctions + compliance**
- Integration with sanctions screening API (Chainalysis or Elliptic — start with mock)
- Transaction monitoring rules
- Alert generation for anomalous patterns
- Compliance report generation

**Deliverable:** Policy Engine with pre-validation API, pool management, DeFi allocation, compliance foundations.

### 2C. End-to-End Test (mock Unlink) (Dev 3 — weeks 6-8)

**Week 6-8:**
- Full flow test Path A: EOA → SpendInteractor → Backend Bridge → mock execution → Compliance Vault
- Full flow test Path B: client 2 sigs → bank auto-sign → 3/3 on-chain → Backend Bridge → mock execution
- Path B rejection test: client 2 sigs → bank rejects (over guardrails) → no on-chain tx → client notified
- DeFi flow test: Policy Engine → M1 funding → M2 → Aave (on testnet)
- Internal transfer test: M2-A auth → Backend → ledger update → M2-B credited
- Pool management test: balance drops → Policy Engine triggers → M1 funds pool
- Load test: simulate 100+ authorizations per block
- Reconciliation validation: verify invariant holds after all operations

**Deliverable:** Full system working end-to-end with mock Unlink execution.

---

## Phase 3 — Unlink Integration + Client App (Weeks 8-12)

**Goal:** Replace mock execution with real Unlink private transfers. Build client-facing app.

### 3A. Unlink Integration (Dev 1 — weeks 8-11)

**Dependency: Unlink SDK access + testnet availability on Monad**

**Week 8-9: SDK integration**
- Unlink SDK setup and authentication
- Private transfer function: pool → recipient
- Deposit function: M1 → Unlink pool
- Withdrawal function: Unlink pool → M1 (sweep excess)
- Viewing key management (store in Compliance Vault)

**Week 9-10: Backend Bridge — real execution**
- Replace mock executor with Unlink SDK calls
- Handle Unlink-specific errors (insufficient pool balance, gateway timeout)
- Confirmation tracking (Unlink transfer finality)
- Fallback path: if Unlink unavailable, queue for retry or flag for manual execution

**Week 10-11: Privacy validation**
- Verify: on-chain observer cannot link M2 authorization to pool payment
- Test timing decorrelation (random delay between auth and execution)
- Test batching (multiple auths → single batched pool operation)
- Verify viewing key reconstruction (auditor can see full history)

**Deliverable:** Real Unlink private transfers replacing mock execution. Privacy properties verified.

### 3B. Client App (Dev 2 + Dev 3 — weeks 8-12)

**Week 8-9: Core payment flow (Dev 2)**
- React Native setup (or web app — decide based on target)
- Authentication (wallet connect or custodial key management)
- **EOA payment flow (Path A):** tap send → sign with EOA key → SpendInteractor on-chain → status tracking
- **M2 payment flow (Path B):** tap send (1st signature) → enter PIN/password (2nd signature) → send to bank API → bank auto-signs or rejects → status tracking
- Two-phase status display: "Authorized ✓" → "Executed ✓"
- Rejection UX: "This transaction exceeds your spending limit. Please contact your account manager." with call/message action
- Transaction history (from Compliance Vault API)
- Native yield display on home screen (current account yield from M1 strategies)

**Week 9-10: Account management (Dev 3)**
- Balance display (from internal ledger API)
- EOA subaccount management (view cards, transfer accounts, limits per subaccount)
- Spending limit visibility (remaining daily/weekly allowance per EOA)
- Receive money feature: display client's deposit reference number + Unlink deposit address
- Notification system (payment confirmed, limit approaching, rejection alert)
- Security summary screen: signature workflow explanation, active subaccounts, recent activity

**Week 11-12: DeFi dashboard — Tier B (Dev 2 + Dev 3)**
- DeFi position display (read M2's on-chain positions)
- Yield tracking
- Allocation request flow (request DeFi funding from bank)
- Protocol selection (Aave, Uniswap from allowlist)

**Deliverable:** Functional client app with payment, account management, and DeFi dashboard.

---

## Phase 4 — Testing, Audit & Hardening (Weeks 12-14)

### 4A. Security Audit Preparation (Dev 1 — weeks 12-13)

- Code freeze on smart contracts
- Documentation of all contract interactions and trust assumptions
- Formal specification of SpendInteractor invariants
- Known attack vectors documented with mitigations
- Prepare audit package for external auditor

### 4B. Integration Testing (Dev 2 + Dev 3 — weeks 12-13)

- Full end-to-end test suite (happy path + edge cases)
- Failure mode testing:
  - Backend Bridge down → events queue → recovery replay
  - Unlink gateway down → fallback behavior
  - Policy Engine down → direct on-chain submission (bypassing pre-validation)
  - Pool runs dry → M1 emergency top-up
  - EOA key compromised → revocation flow
- Performance testing under load
- Reconciliation verification after all test scenarios

### 4C. Audit + Fix (weeks 13-14)

- Submit to external auditor (if timeline allows — otherwise internal review)
- Address audit findings
- Final testnet deployment with all fixes
- Prepare for mainnet deployment plan

---

## Dependency Graph

```
SpendInteractor ──────────┐
                          ├── Backend Bridge + Auto-Sign ── Unlink Integration ── E2E Test
DeFi Interactor ──────────┘        │
                                   │
M1 Treasury Safe ─── Infra ────── Policy Engine ─── Client App (Path A + Path B UX)
                                   │
                                   └── Compliance Vault
```

**Critical path:** SpendInteractor → Backend Bridge + Auto-Sign Service → Unlink Integration → E2E Testing

**Parallel tracks that don't block each other:**
- SpendInteractor (Dev 1) ‖ DeFi Interactor (Dev 2) ‖ M1 Safe + Infra (Dev 3)
- Backend Bridge (Dev 1) ‖ Policy Engine (Dev 2) ‖ E2E mock testing (Dev 3)
- Unlink Integration (Dev 1) ‖ Client App (Dev 2 + Dev 3)

### External Dependencies

| Dependency | Blocker for | Risk | Mitigation |
|---|---|---|---|
| Unlink SDK access | Phase 3A | High — testnet only, access may be limited | Build with mock Unlink interface. Real integration is a drop-in replacement. |
| Unlink private transfer API | Phase 3A | Medium — API may change before mainnet | Abstract behind interface. Adapter pattern. |
| Unlink viewing keys | Phase 3A (audit) | Medium — may not be available on testnet | Test with mock viewing keys. Validate when available. |
| Safe module compatibility (Monad) | Phase 1 | Low if deploying on EVM-compatible chain | Safe is well-tested on EVM chains. Test early. |
| Aave/Uniswap on target chain | Phase 1B | Low — most EVM chains have deployments | Use testnet forks if needed. |
| External audit firm | Phase 4C | Medium — scheduling lead time | Book auditor at project start, not at Phase 4. |

---

## Dev Assignment Summary

| Dev | Phase 1 (wk 1-4) | Phase 2 (wk 4-8) | Phase 3 (wk 8-12) | Phase 4 (wk 12-14) |
|---|---|---|---|---|
| **Dev 1** | SpendInteractor contract | Backend Bridge + Auto-Sign | Unlink Integration | Audit prep |
| **Dev 2** | DeFi Interactor adaptation | Policy Engine | Client App (payment flow) | Integration testing |
| **Dev 3** | M1 Safe + Infra | E2E mock testing | Client App (account mgmt) | Integration testing |
| **Marketing** | Positioning & narrative | Documentation & site | Demo content | Launch prep |

---

## Marketing Track (continuous, parallel)

| Period | Focus |
|---|---|
| Weeks 1-4 | Define positioning: "crypto bank infrastructure" — what makes S4b different. Draft website copy. Identify target prospects (crypto treasuries, DAOs, neobanks). |
| Weeks 5-8 | Technical documentation for developers/partners. Blog post: "Why on-chain authorization matters." Engage Unlink team for partnership. |
| Weeks 9-12 | Demo video with testnet. Outreach to first prospects. Conference/event targeting. |
| Weeks 13-14 | Case study from testnet demo. Refine pitch deck. Sales pipeline. |

---

## Risk Register

| Risk | Impact | Probability | Mitigation |
|---|---|---|---|
| Unlink not ready for production | High — delays Phase 3 | Medium | Entire Phase 1-2 works without Unlink (mock). Ship with fallback direct on-chain payments. Add Unlink when ready. |
| SpendInteractor audit findings | High — delays launch | Medium | Start with thorough internal review + fuzzing. Book external auditor early. |
| Safe module incompatibility on Monad | High — blocks all | Low | Test Safe deployment on Monad testnet in week 1. If issues, fallback to Ethereum L2. |
| Rolling spend tracking gas cost too high | Medium — poor UX | Low | Optimize data structures. Consider checkpoint pattern instead of full history scan. |
| Unlink anonymity set too small (low usage) | Medium — weak privacy | Medium | Can launch on busier chain. Pool multiple banks' traffic (future). Accept weaker privacy initially. |

---

## Decision Points

**Week 1:** Confirm Safe deploys correctly on target chain (Monad). If not → pivot to Ethereum L2.

**Week 4:** SpendInteractor working on testnet. Demo internally. Go/no-go on architecture.

**Week 8:** Full system working with mock Unlink. Decision: pursue Unlink integration (if SDK available) or ship with direct on-chain payments as v1.

**Week 12:** Unlink integration validated OR fallback decided. Begin audit process.

---

## What to Start Monday

1. **Dev 1:** Create Foundry project. Write `SpendInteractor.sol` with `authorizeSpend()`, rolling spend tracking, and `SpendAuthorized` event. First test: register EOA, authorize spend within limit, verify event emitted.

2. **Dev 2:** Fork MultiSub's DeFi Interactor. Configure for Aave v3 supply/withdraw selectors. Deploy on local Hardhat/Anvil fork with Aave.

3. **Dev 3:** Deploy Safe on target testnet. Attach dummy module. Verify module can be enabled/disabled by Safe owners. Start Compliance Vault database schema.

4. **Marketing:** Draft one-page positioning doc: "What is S4b and why does it matter." Target audience: crypto treasury managers, DAO operators, neobank builders.
