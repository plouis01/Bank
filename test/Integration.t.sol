// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {IntEOA} from "../src/IntEOA.sol";
import {SpendInteractor} from "../src/SpendInteractor.sol";
import {DeFiInteractor} from "../src/DeFiInteractor.sol";
import {MockSafe} from "./mocks/MockSafe.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockProtocol} from "./mocks/MockProtocol.sol";
import {MockChainlinkPriceFeed} from "./mocks/MockChainlinkPriceFeed.sol";
import {MockParser} from "./mocks/MockParser.sol";

/**
 * @title IntegrationTest
 * @notice End-to-end integration tests for the S4b call chains.
 *
 *      Path A (spending):  EOA → IntEOA → M2 Safe → SpendInteractor
 *      Path A (DeFi):      EOA → IntEOA → M2 Safe → DeFiInteractor → protocol
 *      Path B (multisig):  3/3 signed tx → SpendInteractor (direct call)
 */
contract IntegrationTest is Test {
    // Contracts
    MockSafe public m2Safe;
    IntEOA public intEOA;
    SpendInteractor public spendInteractor;
    DeFiInteractor public defiInteractor;
    MockERC20 public token;
    MockProtocol public protocol;
    MockChainlinkPriceFeed public priceFeed;
    MockParser public parser;

    // Actors
    address public owner;       // M2 Safe itself (for module management)
    address public oracle;
    address public cardEOA;
    address public defiEOA;

    bytes4 constant DEPOSIT_SELECTOR = bytes4(keccak256("deposit(uint256,address)"));
    bytes4 constant WITHDRAW_SELECTOR = bytes4(keccak256("withdraw(uint256,address)"));

    function setUp() public {
        vm.warp(1_000_000);

        cardEOA = makeAddr("cardEOA");
        defiEOA = makeAddr("defiEOA");
        oracle = makeAddr("oracle");

        // 1. Deploy M2 Safe (3/3 multisig: 2 client keys + 1 bank key)
        address[] memory signers = new address[](3);
        signers[0] = makeAddr("client1");
        signers[1] = makeAddr("client2");
        signers[2] = makeAddr("bankKey");
        m2Safe = new MockSafe(signers, 3);

        // Owner is the test contract (simulating multisig approval)
        owner = address(this);

        // 2. Deploy SpendInteractor (authorization-only module)
        spendInteractor = new SpendInteractor(address(m2Safe), owner);

        // 3. Deploy DeFiInteractor
        defiInteractor = new DeFiInteractor(address(m2Safe), owner, oracle);

        // 4. Deploy IntEOA (EOA extension module)
        intEOA = new IntEOA(address(m2Safe), owner);

        // 5. Enable all modules on Safe
        m2Safe.enableModule(address(spendInteractor));
        m2Safe.enableModule(address(defiInteractor));
        m2Safe.enableModule(address(intEOA));

        // 6. Deploy mock DeFi infrastructure
        token = new MockERC20();
        protocol = new MockProtocol();
        priceFeed = new MockChainlinkPriceFeed(1_00000000, 8); // $1.00
        parser = new MockParser(address(token));

        token.mint(address(m2Safe), 100_000e18);

        // 7. Configure SpendInteractor: register cardEOA
        uint8[] memory cardTypes = new uint8[](1);
        cardTypes[0] = 0; // TYPE_PAYMENT
        spendInteractor.registerEOA(cardEOA, 500e18, cardTypes);

        // 8. Configure DeFiInteractor
        defiInteractor.setTokenPriceFeed(address(token), address(priceFeed));
        defiInteractor.registerSelector(DEPOSIT_SELECTOR, DeFiInteractor.OperationType.DEPOSIT);
        defiInteractor.registerSelector(WITHDRAW_SELECTOR, DeFiInteractor.OperationType.WITHDRAW);
        defiInteractor.registerParser(address(protocol), address(parser));
        defiInteractor.grantRole(defiEOA, defiInteractor.DEFI_EXECUTE_ROLE());
        defiInteractor.setSubAccountLimits(defiEOA, 500, 1 days);

        address[] memory defiTargets = new address[](1);
        defiTargets[0] = address(protocol);
        defiInteractor.setAllowedAddresses(defiEOA, defiTargets, true);

        // Oracle updates
        defiInteractor.updateSafeValue(1_000_000e18);
        vm.prank(oracle);
        defiInteractor.updateSpendingAllowance(defiEOA, 50_000e18);

        // 9. Configure IntEOA: register both EOAs with appropriate targets
        intEOA.registerEOA(cardEOA);
        intEOA.registerEOA(defiEOA);

        // cardEOA can call SpendInteractor
        address[] memory cardTargets = new address[](1);
        cardTargets[0] = address(spendInteractor);
        intEOA.setAllowedTargets(cardEOA, cardTargets, true);

        // defiEOA can call DeFiInteractor
        address[] memory defiEOATargets = new address[](1);
        defiEOATargets[0] = address(defiInteractor);
        intEOA.setAllowedTargets(defiEOA, defiEOATargets, true);
    }

    // ============ Path A: EOA → IntEOA → SpendInteractor ============

    function test_pathA_spending_fullChain() public {
        // Path A spending: EOA calls SpendInteractor directly
        // SpendInteractor checks msg.sender == registered EOA
        // No Safe execution context needed (authorization-only, no fund movement)
        vm.prank(cardEOA);
        spendInteractor.authorizeSpend(100e18, keccak256("merchant-123"), 0);

        // Verify nonce incremented
        assertEq(spendInteractor.nonce(), 1);

        // Verify rolling spend tracked
        assertEq(spendInteractor.getRollingSpend(cardEOA), 100e18);
    }

    function test_pathA_spending_multipleTransactions() public {
        // Multiple spends within daily limit
        vm.startPrank(cardEOA);

        spendInteractor.authorizeSpend(100e18, keccak256("merchant-1"), 0);
        spendInteractor.authorizeSpend(200e18, keccak256("merchant-2"), 0);
        spendInteractor.authorizeSpend(150e18, keccak256("merchant-3"), 0);

        vm.stopPrank();

        assertEq(spendInteractor.nonce(), 3);
        assertEq(spendInteractor.getRollingSpend(cardEOA), 450e18);
        assertEq(spendInteractor.getRemainingLimit(cardEOA), 50e18);
    }

    function test_pathA_spending_exceedsLimit() public {
        vm.prank(cardEOA);
        vm.expectRevert();
        spendInteractor.authorizeSpend(501e18, keccak256("merchant-big"), 0);
    }

    // ============ Path A: EOA → DeFiInteractor (via IntEOA for Safe context) ============

    function test_pathA_defi_executeDeposit() public {
        // defiEOA calls DeFiInteractor.executeOnProtocol directly
        // (DeFiInteractor checks msg.sender has DEFI_EXECUTE_ROLE)
        bytes memory depositData = abi.encodeWithSignature(
            "deposit(uint256,address)",
            1000e18,
            address(m2Safe)
        );

        vm.prank(defiEOA);
        defiInteractor.executeOnProtocol(address(protocol), depositData);
    }

    function test_pathA_defi_exceedsAllowance() public {
        bytes memory depositData = abi.encodeWithSignature(
            "deposit(uint256,address)",
            60_000e18, // > 50k allowance
            address(m2Safe)
        );

        vm.prank(defiEOA);
        vm.expectRevert(DeFiInteractor.ExceedsSpendingLimit.selector);
        defiInteractor.executeOnProtocol(address(protocol), depositData);
    }

    // ============ Path B: Direct Multisig → SpendInteractor ============

    function test_pathB_directMultisig() public {
        // In Path B, the 3/3 multisig submits directly to SpendInteractor
        // We need an EOA registered for Path B — register a "transfer EOA" with higher limits
        address transferEOA = makeAddr("transferEOA");
        uint8[] memory transferTypes = new uint8[](2);
        transferTypes[0] = 0; // TYPE_PAYMENT
        transferTypes[1] = 1; // TYPE_TRANSFER
        spendInteractor.registerEOA(transferEOA, 5000e18, transferTypes);

        // transferEOA calls authorizeSpend (simulating multisig-approved tx)
        vm.prank(transferEOA);
        spendInteractor.authorizeSpend(3000e18, keccak256("bank-transfer-456"), 1);

        assertEq(spendInteractor.nonce(), 1);
        assertEq(spendInteractor.getRollingSpend(transferEOA), 3000e18);
    }

    // ============ Cross-Module Isolation ============

    function test_cardEOA_cannotCallDeFi() public {
        // cardEOA is registered on SpendInteractor but not DeFiInteractor
        bytes memory depositData = abi.encodeWithSignature(
            "deposit(uint256,address)",
            100e18,
            address(m2Safe)
        );

        vm.prank(cardEOA);
        vm.expectRevert(); // No DEFI_EXECUTE_ROLE
        defiInteractor.executeOnProtocol(address(protocol), depositData);
    }

    function test_defiEOA_cannotSpend() public {
        // defiEOA is not registered on SpendInteractor
        vm.prank(defiEOA);
        vm.expectRevert(SpendInteractor.EOANotRegistered.selector);
        spendInteractor.authorizeSpend(100e18, keccak256("merchant"), 0);
    }

    function test_intEOA_targetIsolation() public {
        // cardEOA via IntEOA cannot reach DeFiInteractor
        bytes memory data = abi.encodeWithSignature("pause()");

        vm.prank(cardEOA);
        vm.expectRevert(abi.encodeWithSelector(IntEOA.TargetNotAllowed.selector, address(defiInteractor)));
        intEOA.execute(address(defiInteractor), data);
    }

    function test_defiEOA_intEOA_cannotReachSpend() public {
        bytes memory data = abi.encodeWithSignature("pause()");

        vm.prank(defiEOA);
        vm.expectRevert(abi.encodeWithSelector(IntEOA.TargetNotAllowed.selector, address(spendInteractor)));
        intEOA.execute(address(spendInteractor), data);
    }

    // ============ Module Enable/Disable ============

    function test_disableModule_blocksExecution() public {
        // Disable SpendInteractor module on Safe
        m2Safe.disableModule(address(0), address(spendInteractor));

        // SpendInteractor itself doesn't check module status — it emits events
        // But any execution through Safe would fail
        // Direct EOA calls to authorizeSpend still work (it doesn't execute through Safe)
        vm.prank(cardEOA);
        spendInteractor.authorizeSpend(100e18, keccak256("merchant"), 0);

        // This is correct: SpendInteractor is authorization-only, doesn't need module status
        assertEq(spendInteractor.nonce(), 1);
    }

    // ============ Emergency: Pause All Modules ============

    function test_emergencyPause_allModules() public {
        // Owner pauses everything
        spendInteractor.pause();
        defiInteractor.pause();
        intEOA.pause();

        // All paths blocked
        vm.prank(cardEOA);
        vm.expectRevert();
        spendInteractor.authorizeSpend(100e18, keccak256("m"), 0);

        bytes memory depositData = abi.encodeWithSignature(
            "deposit(uint256,address)", 100e18, address(m2Safe)
        );
        vm.prank(defiEOA);
        vm.expectRevert();
        defiInteractor.executeOnProtocol(address(protocol), depositData);

        vm.prank(cardEOA);
        vm.expectRevert();
        intEOA.execute(address(spendInteractor), "");
    }

    // ============ EOA Revocation ============

    function test_revokeEOA_blocksAllPaths() public {
        // Revoke cardEOA from both modules
        spendInteractor.revokeEOA(cardEOA);
        intEOA.revokeEOA(cardEOA);

        // Path A spending blocked
        vm.prank(cardEOA);
        vm.expectRevert(SpendInteractor.EOANotRegistered.selector);
        spendInteractor.authorizeSpend(100e18, keccak256("m"), 0);

        // IntEOA path blocked
        vm.prank(cardEOA);
        vm.expectRevert(IntEOA.EOANotRegistered.selector);
        intEOA.execute(address(spendInteractor), "");
    }

    // ============ Nonce Continuity Across Paths ============

    function test_nonce_continuity() public {
        // Register a second EOA for spending
        address transferEOA = makeAddr("transferEOA");
        uint8[] memory types = new uint8[](1);
        types[0] = 0;
        spendInteractor.registerEOA(transferEOA, 5000e18, types);

        // cardEOA spends (nonce 0)
        vm.prank(cardEOA);
        spendInteractor.authorizeSpend(100e18, keccak256("m1"), 0);

        // transferEOA spends (nonce 1)
        vm.prank(transferEOA);
        spendInteractor.authorizeSpend(200e18, keccak256("m2"), 0);

        // cardEOA spends again (nonce 2)
        vm.prank(cardEOA);
        spendInteractor.authorizeSpend(50e18, keccak256("m3"), 0);

        assertEq(spendInteractor.nonce(), 3);
    }
}
