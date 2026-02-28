// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {IntEOA} from "../src/IntEOA.sol";
import {IIntEOA} from "../src/interfaces/IIntEOA.sol";
import {MockSafe} from "./mocks/MockSafe.sol";

contract IntEOATest is Test {
    IntEOA public intEOA;
    MockSafe public safe;

    address public owner;
    address public cardEOA;
    address public transferEOA;
    address public targetModule;

    function setUp() public {
        vm.warp(1_000_000);

        owner = address(this);
        cardEOA = makeAddr("cardEOA");
        transferEOA = makeAddr("transferEOA");
        targetModule = makeAddr("targetModule");

        // Deploy M2 Safe (3/3 multisig)
        address[] memory owners = new address[](3);
        owners[0] = makeAddr("client1");
        owners[1] = makeAddr("client2");
        owners[2] = makeAddr("bankKey");
        safe = new MockSafe(owners, 3);

        // Deploy IntEOA module
        intEOA = new IntEOA(address(safe), owner);

        // Enable module on Safe
        safe.enableModule(address(intEOA));
    }

    // ============ Registration Tests ============

    function test_registerEOA() public {
        intEOA.registerEOA(cardEOA);
        assertTrue(intEOA.registeredEOAs(cardEOA));
    }

    function test_registerEOA_emitsEvent() public {
        vm.expectEmit(true, false, false, false);
        emit IIntEOA.EOARegistered(cardEOA);

        intEOA.registerEOA(cardEOA);
    }

    function test_registerEOA_revert_alreadyRegistered() public {
        intEOA.registerEOA(cardEOA);

        vm.expectRevert(IntEOA.EOAAlreadyRegistered.selector);
        intEOA.registerEOA(cardEOA);
    }

    function test_registerEOA_revert_zeroAddress() public {
        vm.expectRevert();
        intEOA.registerEOA(address(0));
    }

    function test_registerEOA_revert_avatar() public {
        vm.expectRevert(abi.encodeWithSelector(IntEOA.CannotRegisterCoreAddress.selector, address(safe)));
        intEOA.registerEOA(address(safe));
    }

    function test_registerEOA_revert_self() public {
        vm.expectRevert(abi.encodeWithSelector(IntEOA.CannotRegisterCoreAddress.selector, address(intEOA)));
        intEOA.registerEOA(address(intEOA));
    }

    function test_registerEOA_revert_notOwner() public {
        vm.prank(cardEOA);
        vm.expectRevert();
        intEOA.registerEOA(cardEOA);
    }

    // ============ Revoke Tests ============

    function test_revokeEOA() public {
        intEOA.registerEOA(cardEOA);
        intEOA.revokeEOA(cardEOA);
        assertFalse(intEOA.registeredEOAs(cardEOA));
    }

    function test_revokeEOA_emitsEvent() public {
        intEOA.registerEOA(cardEOA);

        vm.expectEmit(true, false, false, false);
        emit IIntEOA.EOARevoked(cardEOA);

        intEOA.revokeEOA(cardEOA);
    }

    function test_revokeEOA_revert_notRegistered() public {
        vm.expectRevert(IntEOA.EOANotRegistered.selector);
        intEOA.revokeEOA(cardEOA);
    }

    function test_revokeEOA_removesFromList() public {
        intEOA.registerEOA(cardEOA);
        intEOA.registerEOA(transferEOA);
        intEOA.revokeEOA(cardEOA);

        address[] memory eoas = intEOA.getRegisteredEOAs();
        assertEq(eoas.length, 1);
        assertEq(eoas[0], transferEOA);
    }

    // ============ Target Whitelisting Tests ============

    function test_setAllowedTargets() public {
        intEOA.registerEOA(cardEOA);

        address[] memory targets = new address[](1);
        targets[0] = targetModule;
        intEOA.setAllowedTargets(cardEOA, targets, true);

        assertTrue(intEOA.allowedTargets(cardEOA, targetModule));
    }

    function test_setAllowedTargets_emitsEvent() public {
        intEOA.registerEOA(cardEOA);

        address[] memory targets = new address[](1);
        targets[0] = targetModule;

        vm.expectEmit(true, true, false, true);
        emit IIntEOA.TargetAllowed(cardEOA, targetModule, true);

        intEOA.setAllowedTargets(cardEOA, targets, true);
    }

    function test_setAllowedTargets_revoke() public {
        intEOA.registerEOA(cardEOA);

        address[] memory targets = new address[](1);
        targets[0] = targetModule;
        intEOA.setAllowedTargets(cardEOA, targets, true);
        intEOA.setAllowedTargets(cardEOA, targets, false);

        assertFalse(intEOA.allowedTargets(cardEOA, targetModule));
    }

    function test_setAllowedTargets_revert_notRegistered() public {
        address[] memory targets = new address[](1);
        targets[0] = targetModule;

        vm.expectRevert(IntEOA.EOANotRegistered.selector);
        intEOA.setAllowedTargets(cardEOA, targets, true);
    }

    function test_setAllowedTargets_multiple() public {
        intEOA.registerEOA(cardEOA);

        address target2 = makeAddr("target2");
        address[] memory targets = new address[](2);
        targets[0] = targetModule;
        targets[1] = target2;
        intEOA.setAllowedTargets(cardEOA, targets, true);

        assertTrue(intEOA.allowedTargets(cardEOA, targetModule));
        assertTrue(intEOA.allowedTargets(cardEOA, target2));
    }

    // ============ Execution Tests ============

    function test_execute_revert_notRegistered() public {
        vm.prank(cardEOA);
        vm.expectRevert(IntEOA.EOANotRegistered.selector);
        intEOA.execute(targetModule, "");
    }

    function test_execute_revert_targetNotAllowed() public {
        intEOA.registerEOA(cardEOA);

        vm.prank(cardEOA);
        vm.expectRevert(abi.encodeWithSelector(IntEOA.TargetNotAllowed.selector, targetModule));
        intEOA.execute(targetModule, "");
    }

    function test_execute_revert_revokedEOA() public {
        intEOA.registerEOA(cardEOA);
        address[] memory targets = new address[](1);
        targets[0] = targetModule;
        intEOA.setAllowedTargets(cardEOA, targets, true);

        intEOA.revokeEOA(cardEOA);

        vm.prank(cardEOA);
        vm.expectRevert(IntEOA.EOANotRegistered.selector);
        intEOA.execute(targetModule, "");
    }

    // ============ Pause Tests ============

    function test_pause_blocksExecution() public {
        intEOA.registerEOA(cardEOA);
        address[] memory targets = new address[](1);
        targets[0] = targetModule;
        intEOA.setAllowedTargets(cardEOA, targets, true);

        intEOA.pause();

        vm.prank(cardEOA);
        vm.expectRevert();
        intEOA.execute(targetModule, "");
    }

    function test_unpause() public {
        intEOA.pause();
        intEOA.unpause();
        // No revert — module is operational again
    }

    function test_pause_revert_notOwner() public {
        vm.prank(cardEOA);
        vm.expectRevert();
        intEOA.pause();
    }

    // ============ View Function Tests ============

    function test_isRegisteredEOA() public {
        assertFalse(intEOA.isRegisteredEOA(cardEOA));
        intEOA.registerEOA(cardEOA);
        assertTrue(intEOA.isRegisteredEOA(cardEOA));
    }

    function test_isAllowedTarget() public {
        intEOA.registerEOA(cardEOA);

        assertFalse(intEOA.isAllowedTarget(cardEOA, targetModule));

        address[] memory targets = new address[](1);
        targets[0] = targetModule;
        intEOA.setAllowedTargets(cardEOA, targets, true);

        assertTrue(intEOA.isAllowedTarget(cardEOA, targetModule));
    }

    function test_getRegisteredEOAs() public {
        intEOA.registerEOA(cardEOA);
        intEOA.registerEOA(transferEOA);

        address[] memory eoas = intEOA.getRegisteredEOAs();
        assertEq(eoas.length, 2);
    }

    // ============ Per-EOA Isolation ============

    function test_perEOA_targetIsolation() public {
        intEOA.registerEOA(cardEOA);
        intEOA.registerEOA(transferEOA);

        address target2 = makeAddr("target2");

        // cardEOA can access targetModule only
        address[] memory targets1 = new address[](1);
        targets1[0] = targetModule;
        intEOA.setAllowedTargets(cardEOA, targets1, true);

        // transferEOA can access target2 only
        address[] memory targets2 = new address[](1);
        targets2[0] = target2;
        intEOA.setAllowedTargets(transferEOA, targets2, true);

        // cardEOA cannot access target2
        assertFalse(intEOA.allowedTargets(cardEOA, target2));
        // transferEOA cannot access targetModule
        assertFalse(intEOA.allowedTargets(transferEOA, targetModule));
    }
}
