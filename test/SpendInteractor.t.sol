// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {SpendInteractor} from "../src/SpendInteractor.sol";
import {ISpendInteractor} from "../src/interfaces/ISpendInteractor.sol";
import {MockSafe} from "./mocks/MockSafe.sol";

contract SpendInteractorTest is Test {
    SpendInteractor public interactor;
    MockSafe public safe;

    address public owner;
    address public cardEOA;
    address public transferEOA;
    address public interbankEOA;

    // Transfer types
    uint8 constant TYPE_PAYMENT = 0;
    uint8 constant TYPE_TRANSFER = 1;
    uint8 constant TYPE_INTERBANK = 2;

    // Common limits (18 decimals)
    uint256 constant CARD_LIMIT = 500e18;       // €500/day
    uint256 constant TRANSFER_LIMIT = 5000e18;  // €5000/day
    uint256 constant INTERBANK_LIMIT = 10000e18;// €10000/day

    function setUp() public {
        // Use a realistic starting timestamp to avoid edge cases with WINDOW_DURATION subtraction
        vm.warp(1_000_000);

        owner = address(this);
        cardEOA = makeAddr("cardEOA");
        transferEOA = makeAddr("transferEOA");
        interbankEOA = makeAddr("interbankEOA");

        // Deploy Safe (3/3 as per S4b architecture)
        address[] memory owners = new address[](3);
        owners[0] = makeAddr("clientKey1");
        owners[1] = makeAddr("clientKey2");
        owners[2] = makeAddr("bankKey");
        safe = new MockSafe(owners, 3);

        // Deploy SpendInteractor (Safe is avatar, test contract is owner)
        interactor = new SpendInteractor(address(safe), owner);

        // Enable module on Safe
        safe.enableModule(address(interactor));

        // Register EOAs with appropriate limits and types
        uint8[] memory cardTypes = new uint8[](1);
        cardTypes[0] = TYPE_PAYMENT;
        interactor.registerEOA(cardEOA, CARD_LIMIT, cardTypes);

        uint8[] memory transferTypes = new uint8[](2);
        transferTypes[0] = TYPE_PAYMENT;
        transferTypes[1] = TYPE_TRANSFER;
        interactor.registerEOA(transferEOA, TRANSFER_LIMIT, transferTypes);

        uint8[] memory interbankTypes = new uint8[](3);
        interbankTypes[0] = TYPE_PAYMENT;
        interbankTypes[1] = TYPE_TRANSFER;
        interbankTypes[2] = TYPE_INTERBANK;
        interactor.registerEOA(interbankEOA, INTERBANK_LIMIT, interbankTypes);
    }

    // ========== Registration Tests ==========

    function test_registerEOA() public view {
        assertTrue(interactor.isRegisteredEOA(cardEOA));
        assertEq(interactor.getDailyLimit(cardEOA), CARD_LIMIT);
    }

    function test_registerEOA_revert_alreadyRegistered() public {
        uint8[] memory types = new uint8[](1);
        types[0] = TYPE_PAYMENT;
        vm.expectRevert(SpendInteractor.EOAAlreadyRegistered.selector);
        interactor.registerEOA(cardEOA, CARD_LIMIT, types);
    }

    function test_registerEOA_revert_zeroAddress() public {
        uint8[] memory types = new uint8[](1);
        types[0] = TYPE_PAYMENT;
        vm.expectRevert();
        interactor.registerEOA(address(0), CARD_LIMIT, types);
    }

    function test_registerEOA_revert_avatarAddress() public {
        uint8[] memory types = new uint8[](1);
        types[0] = TYPE_PAYMENT;
        vm.expectRevert(abi.encodeWithSelector(SpendInteractor.CannotRegisterCoreAddress.selector, address(safe)));
        interactor.registerEOA(address(safe), CARD_LIMIT, types);
    }

    function test_registerEOA_revert_zeroLimit() public {
        address newEOA = makeAddr("newEOA");
        uint8[] memory types = new uint8[](1);
        types[0] = TYPE_PAYMENT;
        vm.expectRevert(SpendInteractor.InvalidDailyLimit.selector);
        interactor.registerEOA(newEOA, 0, types);
    }

    function test_registerEOA_revert_onlyOwner() public {
        address newEOA = makeAddr("newEOA");
        uint8[] memory types = new uint8[](1);
        types[0] = TYPE_PAYMENT;

        vm.prank(cardEOA);
        vm.expectRevert();
        interactor.registerEOA(newEOA, CARD_LIMIT, types);
    }

    function test_revokeEOA() public {
        interactor.revokeEOA(cardEOA);
        assertFalse(interactor.isRegisteredEOA(cardEOA));
        assertEq(interactor.getDailyLimit(cardEOA), 0);
    }

    function test_revokeEOA_revert_notRegistered() public {
        address notRegistered = makeAddr("notRegistered");
        vm.expectRevert(SpendInteractor.EOANotRegistered.selector);
        interactor.revokeEOA(notRegistered);
    }

    function test_updateLimit() public {
        uint256 newLimit = 1000e18;
        interactor.updateLimit(cardEOA, newLimit);
        assertEq(interactor.getDailyLimit(cardEOA), newLimit);
    }

    function test_updateLimit_revert_zeroLimit() public {
        vm.expectRevert(SpendInteractor.InvalidDailyLimit.selector);
        interactor.updateLimit(cardEOA, 0);
    }

    function test_getRegisteredEOAs() public view {
        address[] memory eoas = interactor.getRegisteredEOAs();
        assertEq(eoas.length, 3);
    }

    function test_revokeEOA_removesFromArray() public {
        interactor.revokeEOA(cardEOA);
        address[] memory eoas = interactor.getRegisteredEOAs();
        assertEq(eoas.length, 2);
    }

    // ========== Authorization Tests ==========

    function test_authorizeSpend_basic() public {
        uint256 amount = 85e18; // €85
        bytes32 recipientHash = keccak256("merchant123");

        vm.prank(cardEOA);
        interactor.authorizeSpend(amount, recipientHash, TYPE_PAYMENT);

        // Verify rolling spend updated
        assertEq(interactor.getRollingSpend(cardEOA), amount);
        assertEq(interactor.getRemainingLimit(cardEOA), CARD_LIMIT - amount);
    }

    function test_authorizeSpend_emitsEvent() public {
        uint256 amount = 85e18;
        bytes32 recipientHash = keccak256("merchant123");

        vm.expectEmit(true, true, false, true);
        emit ISpendInteractor.SpendAuthorized(
            address(safe),
            cardEOA,
            amount,
            recipientHash,
            TYPE_PAYMENT,
            0 // first nonce
        );

        vm.prank(cardEOA);
        interactor.authorizeSpend(amount, recipientHash, TYPE_PAYMENT);
    }

    function test_authorizeSpend_nonceIncrements() public {
        bytes32 recipientHash = keccak256("merchant");

        vm.prank(cardEOA);
        interactor.authorizeSpend(10e18, recipientHash, TYPE_PAYMENT);
        assertEq(interactor.nonce(), 1);

        vm.prank(cardEOA);
        interactor.authorizeSpend(10e18, recipientHash, TYPE_PAYMENT);
        assertEq(interactor.nonce(), 2);
    }

    function test_authorizeSpend_multipleWithinLimit() public {
        bytes32 recipientHash = keccak256("merchant");

        // 5 payments of €100 each = €500 total = exact limit
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(cardEOA);
            interactor.authorizeSpend(100e18, recipientHash, TYPE_PAYMENT);
        }

        assertEq(interactor.getRollingSpend(cardEOA), CARD_LIMIT);
        assertEq(interactor.getRemainingLimit(cardEOA), 0);
    }

    function test_authorizeSpend_exactLimit() public {
        bytes32 recipientHash = keccak256("merchant");

        vm.prank(cardEOA);
        interactor.authorizeSpend(CARD_LIMIT, recipientHash, TYPE_PAYMENT);

        assertEq(interactor.getRollingSpend(cardEOA), CARD_LIMIT);
        assertEq(interactor.getRemainingLimit(cardEOA), 0);
    }

    function test_authorizeSpend_revert_exceedsLimit() public {
        bytes32 recipientHash = keccak256("merchant");

        vm.prank(cardEOA);
        vm.expectRevert(
            abi.encodeWithSelector(
                SpendInteractor.DailyLimitExceeded.selector,
                CARD_LIMIT + 1,
                CARD_LIMIT
            )
        );
        interactor.authorizeSpend(CARD_LIMIT + 1, recipientHash, TYPE_PAYMENT);
    }

    function test_authorizeSpend_revert_exceedsRemainingLimit() public {
        bytes32 recipientHash = keccak256("merchant");

        vm.prank(cardEOA);
        interactor.authorizeSpend(400e18, recipientHash, TYPE_PAYMENT);

        // Now try to spend €200 more (only €100 remaining)
        vm.prank(cardEOA);
        vm.expectRevert(
            abi.encodeWithSelector(
                SpendInteractor.DailyLimitExceeded.selector,
                200e18,
                100e18
            )
        );
        interactor.authorizeSpend(200e18, recipientHash, TYPE_PAYMENT);
    }

    function test_authorizeSpend_revert_zeroAmount() public {
        vm.prank(cardEOA);
        vm.expectRevert(SpendInteractor.ZeroAmount.selector);
        interactor.authorizeSpend(0, keccak256("merchant"), TYPE_PAYMENT);
    }

    function test_authorizeSpend_revert_notRegistered() public {
        address unregistered = makeAddr("unregistered");
        vm.prank(unregistered);
        vm.expectRevert(SpendInteractor.EOANotRegistered.selector);
        interactor.authorizeSpend(10e18, keccak256("merchant"), TYPE_PAYMENT);
    }

    function test_authorizeSpend_revert_revokedEOA() public {
        interactor.revokeEOA(cardEOA);

        vm.prank(cardEOA);
        vm.expectRevert(SpendInteractor.EOANotRegistered.selector);
        interactor.authorizeSpend(10e18, keccak256("merchant"), TYPE_PAYMENT);
    }

    // ========== Transfer Type Tests ==========

    function test_authorizeSpend_revert_typeNotAllowed() public {
        // cardEOA only has TYPE_PAYMENT, try TYPE_TRANSFER
        vm.prank(cardEOA);
        vm.expectRevert(
            abi.encodeWithSelector(SpendInteractor.TransferTypeNotAllowed.selector, TYPE_TRANSFER)
        );
        interactor.authorizeSpend(10e18, keccak256("recipient"), TYPE_TRANSFER);
    }

    function test_authorizeSpend_transferType_allowed() public {
        // transferEOA has TYPE_PAYMENT and TYPE_TRANSFER
        vm.prank(transferEOA);
        interactor.authorizeSpend(100e18, keccak256("recipient"), TYPE_TRANSFER);

        assertEq(interactor.getRollingSpend(transferEOA), 100e18);
    }

    function test_authorizeSpend_interbankType() public {
        vm.prank(interbankEOA);
        interactor.authorizeSpend(5000e18, keccak256("otherbank"), TYPE_INTERBANK);

        assertEq(interactor.getRollingSpend(interbankEOA), 5000e18);
    }

    function test_updateAllowedTypes() public {
        // Add TYPE_TRANSFER to cardEOA
        uint8[] memory newTypes = new uint8[](2);
        newTypes[0] = TYPE_PAYMENT;
        newTypes[1] = TYPE_TRANSFER;
        interactor.updateAllowedTypes(cardEOA, newTypes);

        // Now cardEOA should be able to do transfers
        vm.prank(cardEOA);
        interactor.authorizeSpend(10e18, keccak256("recipient"), TYPE_TRANSFER);
    }

    // ========== Rolling Window Tests ==========

    function test_rollingWindow_resetsAfter24h() public {
        bytes32 recipientHash = keccak256("merchant");

        // Spend full limit
        vm.prank(cardEOA);
        interactor.authorizeSpend(CARD_LIMIT, recipientHash, TYPE_PAYMENT);
        assertEq(interactor.getRemainingLimit(cardEOA), 0);

        // Advance time by 24 hours + 1 second
        vm.warp(block.timestamp + 24 hours + 1);

        // Limit should be fully restored
        assertEq(interactor.getRollingSpend(cardEOA), 0);
        assertEq(interactor.getRemainingLimit(cardEOA), CARD_LIMIT);

        // Should be able to spend again
        vm.prank(cardEOA);
        interactor.authorizeSpend(CARD_LIMIT, recipientHash, TYPE_PAYMENT);
    }

    function test_rollingWindow_partialReset() public {
        bytes32 recipientHash = keccak256("merchant");

        // Spend €200 at T=0
        vm.prank(cardEOA);
        interactor.authorizeSpend(200e18, recipientHash, TYPE_PAYMENT);

        // Advance 12 hours, spend €200 more
        vm.warp(block.timestamp + 12 hours);
        vm.prank(cardEOA);
        interactor.authorizeSpend(200e18, recipientHash, TYPE_PAYMENT);

        // Total rolling spend = €400
        assertEq(interactor.getRollingSpend(cardEOA), 400e18);

        // Advance to T=24h+1s: first spend drops out, second remains
        vm.warp(block.timestamp + 12 hours + 1);

        // Only the second €200 should remain in window
        assertEq(interactor.getRollingSpend(cardEOA), 200e18);
        assertEq(interactor.getRemainingLimit(cardEOA), 300e18);
    }

    function test_rollingWindow_multipleSpends() public {
        bytes32 recipientHash = keccak256("merchant");

        // Note: setUp warps to 1_000_000. Use hardcoded timestamps to avoid
        // via_ir optimizer replacing local variables with TIMESTAMP opcode.

        // Spend 1: at 1_000_000
        vm.prank(cardEOA);
        interactor.authorizeSpend(100e18, recipientHash, TYPE_PAYMENT);

        // Spend 2: at 1_014_400 (+4h)
        vm.warp(1_014_400);
        vm.prank(cardEOA);
        interactor.authorizeSpend(100e18, recipientHash, TYPE_PAYMENT);

        // Spend 3: at 1_028_800 (+8h)
        vm.warp(1_028_800);
        vm.prank(cardEOA);
        interactor.authorizeSpend(100e18, recipientHash, TYPE_PAYMENT);

        // Spend 4: at 1_043_200 (+12h)
        vm.warp(1_043_200);
        vm.prank(cardEOA);
        interactor.authorizeSpend(100e18, recipientHash, TYPE_PAYMENT);

        // Spend 5: at 1_057_600 (+16h)
        vm.warp(1_057_600);
        vm.prank(cardEOA);
        interactor.authorizeSpend(100e18, recipientHash, TYPE_PAYMENT);

        // At +20h, all 5 spends within 24h window
        vm.warp(1_072_000);
        assertEq(interactor.getRollingSpend(cardEOA), 500e18);

        // At +24h+1s, first spend drops out of window
        vm.warp(1_086_401);
        assertEq(interactor.getRollingSpend(cardEOA), 400e18);
    }

    // ========== Pause Tests ==========

    function test_pause_blocksAuthorization() public {
        interactor.pause();

        vm.prank(cardEOA);
        vm.expectRevert();
        interactor.authorizeSpend(10e18, keccak256("merchant"), TYPE_PAYMENT);
    }

    function test_unpause_allowsAuthorization() public {
        interactor.pause();
        interactor.unpause();

        vm.prank(cardEOA);
        interactor.authorizeSpend(10e18, keccak256("merchant"), TYPE_PAYMENT);
    }

    function test_pause_revert_onlyOwner() public {
        vm.prank(cardEOA);
        vm.expectRevert();
        interactor.pause();
    }

    // ========== Multiple EOA Isolation Tests ==========

    function test_independentEOATracking() public {
        bytes32 recipientHash = keccak256("merchant");

        // cardEOA spends €300
        vm.prank(cardEOA);
        interactor.authorizeSpend(300e18, recipientHash, TYPE_PAYMENT);

        // transferEOA spends €2000
        vm.prank(transferEOA);
        interactor.authorizeSpend(2000e18, recipientHash, TYPE_PAYMENT);

        // Each EOA tracked independently
        assertEq(interactor.getRollingSpend(cardEOA), 300e18);
        assertEq(interactor.getRollingSpend(transferEOA), 2000e18);
        assertEq(interactor.getRemainingLimit(cardEOA), 200e18);
        assertEq(interactor.getRemainingLimit(transferEOA), 3000e18);
    }

    // ========== Nonce Tests ==========

    function test_nonceIncrementsGlobally() public {
        bytes32 recipientHash = keccak256("merchant");

        vm.prank(cardEOA);
        interactor.authorizeSpend(10e18, recipientHash, TYPE_PAYMENT);

        vm.prank(transferEOA);
        interactor.authorizeSpend(10e18, recipientHash, TYPE_PAYMENT);

        vm.prank(cardEOA);
        interactor.authorizeSpend(10e18, recipientHash, TYPE_PAYMENT);

        // Nonce should be 3 (0, 1, 2 used)
        assertEq(interactor.nonce(), 3);
    }

    // ========== View Function Tests ==========

    function test_getRemainingLimit_unregistered() public {
        address unknown = makeAddr("unknown");
        assertEq(interactor.getRemainingLimit(unknown), 0);
    }

    function test_getSpendRecordCount() public {
        bytes32 recipientHash = keccak256("merchant");

        assertEq(interactor.getSpendRecordCount(cardEOA), 0);

        vm.prank(cardEOA);
        interactor.authorizeSpend(10e18, recipientHash, TYPE_PAYMENT);
        assertEq(interactor.getSpendRecordCount(cardEOA), 1);

        vm.prank(cardEOA);
        interactor.authorizeSpend(10e18, recipientHash, TYPE_PAYMENT);
        assertEq(interactor.getSpendRecordCount(cardEOA), 2);
    }

    function test_getAllowedTypesBitmap() public view {
        // cardEOA: only TYPE_PAYMENT (bit 0) = 0b001 = 1
        assertEq(interactor.getAllowedTypesBitmap(cardEOA), 1);

        // transferEOA: TYPE_PAYMENT + TYPE_TRANSFER (bits 0,1) = 0b011 = 3
        assertEq(interactor.getAllowedTypesBitmap(transferEOA), 3);

        // interbankEOA: all 3 types (bits 0,1,2) = 0b111 = 7
        assertEq(interactor.getAllowedTypesBitmap(interbankEOA), 7);
    }

    // ========== Fuzz Tests ==========

    function testFuzz_authorizeSpend_withinLimit(uint256 amount) public {
        // Bound to uint128 range since SpendRecord packs to uint128
        amount = bound(amount, 1, uint256(type(uint128).max) < CARD_LIMIT ? type(uint128).max : CARD_LIMIT);
        bytes32 recipientHash = keccak256("merchant");

        vm.prank(cardEOA);
        interactor.authorizeSpend(amount, recipientHash, TYPE_PAYMENT);

        assertEq(interactor.getRollingSpend(cardEOA), amount);
    }

    function testFuzz_authorizeSpend_overLimit(uint256 amount) public {
        amount = bound(amount, CARD_LIMIT + 1, type(uint128).max);
        bytes32 recipientHash = keccak256("merchant");

        vm.prank(cardEOA);
        vm.expectRevert();
        interactor.authorizeSpend(amount, recipientHash, TYPE_PAYMENT);
    }

    function testFuzz_rollingWindow_correctSum(uint256 amount1, uint256 amount2) public {
        // Each must fit in uint128 and sum must be <= limit
        uint256 maxEach = TRANSFER_LIMIT / 2;
        if (maxEach > type(uint128).max) maxEach = type(uint128).max;
        amount1 = bound(amount1, 1, maxEach);
        amount2 = bound(amount2, 1, maxEach);
        bytes32 recipientHash = keccak256("merchant");

        vm.prank(transferEOA);
        interactor.authorizeSpend(amount1, recipientHash, TYPE_PAYMENT);

        vm.warp(block.timestamp + 6 hours);

        vm.prank(transferEOA);
        interactor.authorizeSpend(amount2, recipientHash, TYPE_PAYMENT);

        assertEq(interactor.getRollingSpend(transferEOA), amount1 + amount2);
    }

    // ========== Ownership Tests ==========

    function test_transferOwnership() public {
        address newOwner = makeAddr("newOwner");
        interactor.transferOwnership(newOwner);
        assertEq(interactor.owner(), newOwner);

        // Old owner can't register anymore
        uint8[] memory types = new uint8[](1);
        types[0] = TYPE_PAYMENT;
        vm.expectRevert();
        interactor.registerEOA(makeAddr("newEOA"), 100e18, types);

        // New owner can
        vm.prank(newOwner);
        interactor.registerEOA(makeAddr("newEOA"), 100e18, types);
    }
}
