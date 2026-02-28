// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {TreasuryTimelock} from "../src/TreasuryTimelock.sol";
import {ITreasuryTimelock} from "../src/interfaces/ITreasuryTimelock.sol";
import {MockSafe} from "./mocks/MockSafe.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract TreasuryTimelockTest is Test {
    TreasuryTimelock public timelock;
    MockSafe public safe;
    MockERC20 public token;

    address public owner;
    address public proposer;
    address public executor;
    address public canceller;
    address public recipient;

    uint256 constant MIN_DELAY = 24 hours;
    uint256 constant THRESHOLD = 100_000e18; // €100k

    function setUp() public {
        vm.warp(1_000_000);

        owner = makeAddr("owner");
        proposer = makeAddr("proposer");
        executor = makeAddr("executor");
        canceller = makeAddr("canceller");
        recipient = makeAddr("recipient");

        // Deploy Safe with 5 owners, threshold 3
        address[] memory owners = new address[](5);
        owners[0] = makeAddr("signer1");
        owners[1] = makeAddr("signer2");
        owners[2] = makeAddr("signer3");
        owners[3] = makeAddr("signer4");
        owners[4] = makeAddr("signer5");
        safe = new MockSafe(owners, 3);

        // Deploy token and fund Safe
        token = new MockERC20();
        token.mint(address(safe), 1_000_000e18);

        // Deploy timelock
        vm.prank(owner);
        timelock = new TreasuryTimelock(
            address(safe),
            owner,
            MIN_DELAY,
            THRESHOLD
        );

        // Enable module on Safe
        safe.enableModule(address(timelock));

        // Set up roles
        vm.startPrank(owner);
        timelock.setProposer(proposer, true);
        timelock.setExecutor(executor, true);
        timelock.setCanceller(canceller, true);
        vm.stopPrank();
    }

    // ============ Constructor Tests ============

    function test_constructor() public view {
        assertEq(timelock.avatar(), address(safe));
        assertEq(timelock.owner(), owner);
        assertEq(timelock.minDelay(), MIN_DELAY);
        assertEq(timelock.timelockThreshold(), THRESHOLD);
    }

    function test_constructor_revert_delayTooLong() public {
        vm.expectRevert(abi.encodeWithSelector(TreasuryTimelock.DelayTooLong.selector, 8 days));
        new TreasuryTimelock(address(safe), owner, 8 days, THRESHOLD);
    }

    function test_constructor_revert_zeroThreshold() public {
        vm.expectRevert(TreasuryTimelock.InvalidThreshold.selector);
        new TreasuryTimelock(address(safe), owner, MIN_DELAY, 0);
    }

    // ============ Role Management Tests ============

    function test_setProposer() public {
        address newProposer = makeAddr("newProposer");
        vm.prank(owner);
        timelock.setProposer(newProposer, true);
        assertTrue(timelock.proposers(newProposer));
    }

    function test_setProposer_revoke() public {
        vm.prank(owner);
        timelock.setProposer(proposer, false);
        assertFalse(timelock.proposers(proposer));
    }

    function test_setProposer_revert_notOwner() public {
        vm.prank(proposer);
        vm.expectRevert();
        timelock.setProposer(makeAddr("x"), true);
    }

    function test_setExecutor() public {
        address newExecutor = makeAddr("newExecutor");
        vm.prank(owner);
        timelock.setExecutor(newExecutor, true);
        assertTrue(timelock.executors(newExecutor));
    }

    function test_setCanceller() public {
        address newCanceller = makeAddr("newCanceller");
        vm.prank(owner);
        timelock.setCanceller(newCanceller, true);
        assertTrue(timelock.cancellers(newCanceller));
    }

    // ============ Configuration Tests ============

    function test_setMinDelay() public {
        vm.prank(owner);
        timelock.setMinDelay(48 hours);
        assertEq(timelock.minDelay(), 48 hours);
    }

    function test_setMinDelay_revert_tooLong() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TreasuryTimelock.DelayTooLong.selector, 8 days));
        timelock.setMinDelay(8 days);
    }

    function test_setTimelockThreshold() public {
        vm.prank(owner);
        timelock.setTimelockThreshold(200_000e18);
        assertEq(timelock.timelockThreshold(), 200_000e18);
    }

    function test_setTimelockThreshold_revert_zero() public {
        vm.prank(owner);
        vm.expectRevert(TreasuryTimelock.InvalidThreshold.selector);
        timelock.setTimelockThreshold(0);
    }

    // ============ Schedule Tests ============

    function test_schedule() public {
        bytes memory data = abi.encodeWithSelector(
            token.transfer.selector,
            recipient,
            150_000e18
        );
        bytes32 salt = bytes32(uint256(1));
        bytes32 expectedId = timelock.hashOperation(address(token), 0, data, salt);

        vm.prank(proposer);
        bytes32 operationId = timelock.schedule(
            address(token),
            0,
            data,
            150_000e18,  // above threshold
            salt
        );

        assertEq(operationId, expectedId);

        ITreasuryTimelock.OperationState state = timelock.getOperationState(operationId);
        assertEq(uint8(state), uint8(ITreasuryTimelock.OperationState.Pending));
    }

    function test_schedule_emitsEvent() public {
        bytes memory data = abi.encodeWithSelector(
            token.transfer.selector,
            recipient,
            150_000e18
        );
        bytes32 salt = bytes32(uint256(1));
        bytes32 expectedId = timelock.hashOperation(address(token), 0, data, salt);
        uint256 expectedExecAt = block.timestamp + MIN_DELAY;

        vm.expectEmit(true, true, false, true);
        emit ITreasuryTimelock.OperationScheduled(
            expectedId,
            proposer,
            address(token),
            0,
            data,
            expectedExecAt
        );

        vm.prank(proposer);
        timelock.schedule(address(token), 0, data, 150_000e18, salt);
    }

    function test_schedule_revert_notProposer() public {
        bytes memory data = "";
        vm.prank(executor);
        vm.expectRevert(TreasuryTimelock.NotProposer.selector);
        timelock.schedule(recipient, 0, data, 150_000e18, bytes32(0));
    }

    function test_schedule_revert_belowThreshold() public {
        bytes memory data = "";
        vm.prank(proposer);
        vm.expectRevert(
            abi.encodeWithSelector(TreasuryTimelock.OperationBelowThreshold.selector, 50_000e18, THRESHOLD)
        );
        timelock.schedule(recipient, 0, data, 50_000e18, bytes32(0));
    }

    function test_schedule_revert_duplicate() public {
        bytes memory data = abi.encodeWithSelector(token.transfer.selector, recipient, 150_000e18);
        bytes32 salt = bytes32(uint256(1));

        vm.prank(proposer);
        bytes32 opId = timelock.schedule(address(token), 0, data, 150_000e18, salt);

        vm.prank(proposer);
        vm.expectRevert(abi.encodeWithSelector(TreasuryTimelock.OperationAlreadyExists.selector, opId));
        timelock.schedule(address(token), 0, data, 150_000e18, salt);
    }

    function test_schedule_revert_whenPaused() public {
        vm.prank(owner);
        timelock.pause();

        vm.prank(proposer);
        vm.expectRevert();
        timelock.schedule(recipient, 0, "", 150_000e18, bytes32(0));
    }

    // ============ Execute Tests ============

    function test_execute_afterDelay() public {
        bytes memory data = abi.encodeWithSelector(
            token.transfer.selector,
            recipient,
            150_000e18
        );
        bytes32 salt = bytes32(uint256(1));

        vm.prank(proposer);
        bytes32 opId = timelock.schedule(address(token), 0, data, 150_000e18, salt);

        // Advance time past delay
        vm.warp(1_000_000 + MIN_DELAY + 1);

        // State should be Ready
        assertEq(uint8(timelock.getOperationState(opId)), uint8(ITreasuryTimelock.OperationState.Ready));

        vm.prank(executor);
        timelock.execute(opId);

        assertEq(uint8(timelock.getOperationState(opId)), uint8(ITreasuryTimelock.OperationState.Executed));
        assertEq(token.balanceOf(recipient), 150_000e18);
    }

    function test_execute_emitsEvent() public {
        bytes memory data = abi.encodeWithSelector(token.transfer.selector, recipient, 150_000e18);
        bytes32 salt = bytes32(uint256(1));

        vm.prank(proposer);
        bytes32 opId = timelock.schedule(address(token), 0, data, 150_000e18, salt);

        vm.warp(1_000_000 + MIN_DELAY + 1);

        vm.expectEmit(true, true, false, false);
        emit ITreasuryTimelock.OperationExecuted(opId, executor);

        vm.prank(executor);
        timelock.execute(opId);
    }

    function test_execute_revert_notExecutor() public {
        bytes memory data = abi.encodeWithSelector(token.transfer.selector, recipient, 150_000e18);
        bytes32 salt = bytes32(uint256(1));

        vm.prank(proposer);
        bytes32 opId = timelock.schedule(address(token), 0, data, 150_000e18, salt);

        vm.warp(1_000_000 + MIN_DELAY + 1);

        vm.prank(proposer);
        vm.expectRevert(TreasuryTimelock.NotExecutor.selector);
        timelock.execute(opId);
    }

    function test_execute_revert_timelockNotExpired() public {
        bytes memory data = abi.encodeWithSelector(token.transfer.selector, recipient, 150_000e18);
        bytes32 salt = bytes32(uint256(1));

        vm.prank(proposer);
        bytes32 opId = timelock.schedule(address(token), 0, data, 150_000e18, salt);

        // Don't advance time - still in delay period
        uint256 executableAt = 1_000_000 + MIN_DELAY;
        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(TreasuryTimelock.TimelockNotExpired.selector, executableAt, 1_000_000)
        );
        timelock.execute(opId);
    }

    function test_execute_revert_alreadyExecuted() public {
        bytes memory data = abi.encodeWithSelector(token.transfer.selector, recipient, 150_000e18);
        bytes32 salt = bytes32(uint256(1));

        vm.prank(proposer);
        bytes32 opId = timelock.schedule(address(token), 0, data, 150_000e18, salt);

        vm.warp(1_000_000 + MIN_DELAY + 1);

        vm.prank(executor);
        timelock.execute(opId);

        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(TreasuryTimelock.OperationNotPending.selector, opId));
        timelock.execute(opId);
    }

    function test_execute_revert_whenPaused() public {
        bytes memory data = abi.encodeWithSelector(token.transfer.selector, recipient, 150_000e18);
        bytes32 salt = bytes32(uint256(1));

        vm.prank(proposer);
        bytes32 opId = timelock.schedule(address(token), 0, data, 150_000e18, salt);

        vm.warp(1_000_000 + MIN_DELAY + 1);

        vm.prank(owner);
        timelock.pause();

        vm.prank(executor);
        vm.expectRevert();
        timelock.execute(opId);
    }

    // ============ Cancel Tests ============

    function test_cancel() public {
        bytes memory data = abi.encodeWithSelector(token.transfer.selector, recipient, 150_000e18);
        bytes32 salt = bytes32(uint256(1));

        vm.prank(proposer);
        bytes32 opId = timelock.schedule(address(token), 0, data, 150_000e18, salt);

        vm.prank(canceller);
        timelock.cancel(opId);

        assertEq(uint8(timelock.getOperationState(opId)), uint8(ITreasuryTimelock.OperationState.Cancelled));
    }

    function test_cancel_emitsEvent() public {
        bytes memory data = abi.encodeWithSelector(token.transfer.selector, recipient, 150_000e18);
        bytes32 salt = bytes32(uint256(1));

        vm.prank(proposer);
        bytes32 opId = timelock.schedule(address(token), 0, data, 150_000e18, salt);

        vm.expectEmit(true, true, false, false);
        emit ITreasuryTimelock.OperationCancelled(opId, canceller);

        vm.prank(canceller);
        timelock.cancel(opId);
    }

    function test_cancel_revert_notCanceller() public {
        bytes memory data = abi.encodeWithSelector(token.transfer.selector, recipient, 150_000e18);
        bytes32 salt = bytes32(uint256(1));

        vm.prank(proposer);
        bytes32 opId = timelock.schedule(address(token), 0, data, 150_000e18, salt);

        vm.prank(executor);
        vm.expectRevert(TreasuryTimelock.NotCanceller.selector);
        timelock.cancel(opId);
    }

    function test_cancel_revert_notPending() public {
        bytes32 fakeOpId = bytes32(uint256(999));

        vm.prank(canceller);
        vm.expectRevert(abi.encodeWithSelector(TreasuryTimelock.OperationNotPending.selector, fakeOpId));
        timelock.cancel(fakeOpId);
    }

    function test_cancel_prevents_execution() public {
        bytes memory data = abi.encodeWithSelector(token.transfer.selector, recipient, 150_000e18);
        bytes32 salt = bytes32(uint256(1));

        vm.prank(proposer);
        bytes32 opId = timelock.schedule(address(token), 0, data, 150_000e18, salt);

        // Cancel before delay expires
        vm.prank(canceller);
        timelock.cancel(opId);

        // Try to execute after delay
        vm.warp(1_000_000 + MIN_DELAY + 1);
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(TreasuryTimelock.OperationNotPending.selector, opId));
        timelock.execute(opId);
    }

    // ============ Emergency Veto Flow ============

    function test_emergencyVeto_duringDelay() public {
        // Full flow: schedule → wait partially → cancel (veto)
        bytes memory data = abi.encodeWithSelector(token.transfer.selector, recipient, 500_000e18);
        bytes32 salt = bytes32(uint256(42));

        vm.prank(proposer);
        bytes32 opId = timelock.schedule(address(token), 0, data, 500_000e18, salt);

        // Advance 12 hours (still in delay)
        vm.warp(1_000_000 + 12 hours);

        // Another signer vetoes
        vm.prank(canceller);
        timelock.cancel(opId);

        // Verify cancelled
        assertEq(uint8(timelock.getOperationState(opId)), uint8(ITreasuryTimelock.OperationState.Cancelled));

        // Verify funds untouched
        assertEq(token.balanceOf(address(safe)), 1_000_000e18);
    }

    // ============ Full Lifecycle Tests ============

    function test_fullLifecycle_scheduleWaitExecute() public {
        uint256 transferAmount = 200_000e18;
        bytes memory data = abi.encodeWithSelector(token.transfer.selector, recipient, transferAmount);
        bytes32 salt = bytes32(uint256(100));

        // 1. Schedule
        vm.prank(proposer);
        bytes32 opId = timelock.schedule(address(token), 0, data, transferAmount, salt);
        assertEq(uint8(timelock.getOperationState(opId)), uint8(ITreasuryTimelock.OperationState.Pending));

        // 2. Wait for delay to expire
        vm.warp(1_000_000 + MIN_DELAY);
        assertEq(uint8(timelock.getOperationState(opId)), uint8(ITreasuryTimelock.OperationState.Ready));

        // 3. Execute
        vm.prank(executor);
        timelock.execute(opId);
        assertEq(uint8(timelock.getOperationState(opId)), uint8(ITreasuryTimelock.OperationState.Executed));

        // 4. Verify transfer
        assertEq(token.balanceOf(recipient), transferAmount);
        assertEq(token.balanceOf(address(safe)), 1_000_000e18 - transferAmount);
    }

    function test_differentSalts_allowSameOperation() public {
        bytes memory data = abi.encodeWithSelector(token.transfer.selector, recipient, 150_000e18);

        vm.prank(proposer);
        bytes32 opId1 = timelock.schedule(address(token), 0, data, 150_000e18, bytes32(uint256(1)));

        vm.prank(proposer);
        bytes32 opId2 = timelock.schedule(address(token), 0, data, 150_000e18, bytes32(uint256(2)));

        assertTrue(opId1 != opId2);

        // Both should be pending
        assertEq(uint8(timelock.getOperationState(opId1)), uint8(ITreasuryTimelock.OperationState.Pending));
        assertEq(uint8(timelock.getOperationState(opId2)), uint8(ITreasuryTimelock.OperationState.Pending));
    }

    // ============ View Function Tests ============

    function test_getOperation() public {
        bytes memory data = abi.encodeWithSelector(token.transfer.selector, recipient, 150_000e18);
        bytes32 salt = bytes32(uint256(1));

        vm.prank(proposer);
        bytes32 opId = timelock.schedule(address(token), 0, data, 150_000e18, salt);

        (
            address to,
            uint256 value,
            bytes memory opData,
            address opProposer,
            uint256 scheduledAt,
            uint256 executableAt,
            ITreasuryTimelock.OperationState state
        ) = timelock.getOperation(opId);

        assertEq(to, address(token));
        assertEq(value, 0);
        assertEq(keccak256(opData), keccak256(data));
        assertEq(opProposer, proposer);
        assertEq(scheduledAt, 1_000_000);
        assertEq(executableAt, 1_000_000 + MIN_DELAY);
        assertEq(uint8(state), uint8(ITreasuryTimelock.OperationState.Pending));
    }

    function test_getOperation_readyState() public {
        bytes memory data = abi.encodeWithSelector(token.transfer.selector, recipient, 150_000e18);
        bytes32 salt = bytes32(uint256(1));

        vm.prank(proposer);
        bytes32 opId = timelock.schedule(address(token), 0, data, 150_000e18, salt);

        vm.warp(1_000_000 + MIN_DELAY);

        (,,,,,, ITreasuryTimelock.OperationState state) = timelock.getOperation(opId);
        assertEq(uint8(state), uint8(ITreasuryTimelock.OperationState.Ready));
    }

    function test_hashOperation_deterministic() public view {
        bytes memory data = abi.encodeWithSelector(token.transfer.selector, recipient, 100e18);
        bytes32 salt = bytes32(uint256(1));

        bytes32 hash1 = timelock.hashOperation(address(token), 0, data, salt);
        bytes32 hash2 = timelock.hashOperation(address(token), 0, data, salt);
        assertEq(hash1, hash2);
    }

    // ============ ETH Transfer Tests ============

    function test_execute_ethTransfer() public {
        // Fund the Safe with ETH
        vm.deal(address(safe), 200 ether);

        bytes memory data = "";
        bytes32 salt = bytes32(uint256(1));
        uint256 ethAmount = 150 ether;

        vm.prank(proposer);
        bytes32 opId = timelock.schedule(recipient, ethAmount, data, 150_000e18, salt);

        vm.warp(1_000_000 + MIN_DELAY + 1);

        vm.prank(executor);
        timelock.execute(opId);

        assertEq(recipient.balance, ethAmount);
    }

    // ============ Pause Tests ============

    function test_pause_onlyOwner() public {
        vm.prank(proposer);
        vm.expectRevert();
        timelock.pause();
    }

    function test_unpause() public {
        vm.prank(owner);
        timelock.pause();

        vm.prank(owner);
        timelock.unpause();

        // Should be able to schedule again
        vm.prank(proposer);
        timelock.schedule(recipient, 0, "", 150_000e18, bytes32(uint256(1)));
    }

    // ============ Interface View Tests ============

    function test_isProposer() public view {
        assertTrue(timelock.isProposer(proposer));
        assertFalse(timelock.isProposer(executor));
    }

    function test_isExecutor() public view {
        assertTrue(timelock.isExecutor(executor));
        assertFalse(timelock.isExecutor(proposer));
    }

    function test_isCanceller() public view {
        assertTrue(timelock.isCanceller(canceller));
        assertFalse(timelock.isCanceller(proposer));
    }

    function test_getMinDelay() public view {
        assertEq(timelock.getMinDelay(), MIN_DELAY);
    }

    function test_getTimelockThreshold() public view {
        assertEq(timelock.getTimelockThreshold(), THRESHOLD);
    }
}
