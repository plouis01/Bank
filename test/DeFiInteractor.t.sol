// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {DeFiInteractorBase} from "./base/DeFiInteractorBase.t.sol";
import {DeFiInteractor} from "../src/DeFiInteractor.sol";

contract DeFiInteractorTest is DeFiInteractorBase {
    function setUp() public override {
        super.setUp();

        // Grant DEFI_EXECUTE_ROLE to subAccount1
        defiModule.grantRole(subAccount1, defiModule.DEFI_EXECUTE_ROLE());

        // Set sub-account limits and whitelist
        defiModule.setSubAccountLimits(subAccount1, 500, 1 days); // 5%

        address[] memory targets = new address[](1);
        targets[0] = address(protocol);
        defiModule.setAllowedAddresses(subAccount1, targets, true);

        // Owner calls oracle function directly (test-oracle pattern)
        defiModule.updateSpendingAllowance(subAccount1, 50000e18); // $50k allowance
    }

    // ============ Core DeFi Operations ============

    function test_executeDeposit() public {
        bytes memory data = abi.encodeWithSignature(
            "deposit(uint256,address)",
            1000e18,
            address(safe) // recipient = Safe
        );

        vm.prank(subAccount1);
        defiModule.executeOnProtocol(address(protocol), data);
    }

    function test_executeDeposit_revert_exceedsLimit() public {
        // Try to deposit more than spending allowance
        bytes memory data = abi.encodeWithSignature(
            "deposit(uint256,address)",
            60000e18, // $60k > $50k allowance
            address(safe)
        );

        vm.prank(subAccount1);
        vm.expectRevert(DeFiInteractor.ExceedsSpendingLimit.selector);
        defiModule.executeOnProtocol(address(protocol), data);
    }

    function test_executeWithdraw_noSpendingCost() public {
        bytes memory data = abi.encodeWithSignature(
            "withdraw(uint256,address)",
            1000e18,
            address(safe)
        );

        uint256 allowanceBefore = defiModule.getSpendingAllowance(subAccount1);

        vm.prank(subAccount1);
        defiModule.executeOnProtocol(address(protocol), data);

        // Allowance unchanged (withdrawals are free)
        assertEq(defiModule.getSpendingAllowance(subAccount1), allowanceBefore);
    }

    function test_revert_unauthorizedSubaccount() public {
        bytes memory data = abi.encodeWithSignature(
            "deposit(uint256,address)",
            100e18,
            address(safe)
        );

        vm.prank(subAccount2); // Not granted role
        vm.expectRevert();
        defiModule.executeOnProtocol(address(protocol), data);
    }

    // ============ Test-Oracle: Owner Calls Oracle Functions Directly ============

    function test_owner_updateSafeValue() public {
        // Owner (not oracle) calls updateSafeValue directly
        defiModule.updateSafeValue(2_000_000e18);

        (uint256 val,,) = defiModule.getSafeValue();
        assertEq(val, 2_000_000e18);
    }

    function test_owner_updateSpendingAllowance() public {
        defiModule.updateSpendingAllowance(subAccount1, 80_000e18);
        assertEq(defiModule.getSpendingAllowance(subAccount1), 80_000e18);
    }

    function test_owner_updateAcquiredBalance() public {
        defiModule.updateAcquiredBalance(subAccount1, address(token), 5000e18);
        assertEq(defiModule.getAcquiredBalance(subAccount1, address(token)), 5000e18);
    }

    function test_owner_batchUpdate() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(token);
        uint256[] memory balances = new uint256[](1);
        balances[0] = 2000e18;

        defiModule.batchUpdate(subAccount1, 30000e18, tokens, balances);

        assertEq(defiModule.getSpendingAllowance(subAccount1), 30000e18);
        assertEq(defiModule.getAcquiredBalance(subAccount1, address(token)), 2000e18);
    }

    // ============ Separate Oracle Calls Oracle Functions ============

    function test_oracle_updateSafeValue() public {
        vm.prank(oracle);
        defiModule.updateSafeValue(3_000_000e18);

        (uint256 val,,) = defiModule.getSafeValue();
        assertEq(val, 3_000_000e18);
    }

    function test_oracle_updateSpendingAllowance() public {
        vm.prank(oracle);
        defiModule.updateSpendingAllowance(subAccount1, 70_000e18);
        assertEq(defiModule.getSpendingAllowance(subAccount1), 70_000e18);
    }

    function test_oracle_updateAcquiredBalance() public {
        vm.prank(oracle);
        defiModule.updateAcquiredBalance(subAccount1, address(token), 8000e18);
        assertEq(defiModule.getAcquiredBalance(subAccount1, address(token)), 8000e18);
    }

    function test_oracle_batchUpdate() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(token);
        uint256[] memory balances = new uint256[](1);
        balances[0] = 4000e18;

        vm.prank(oracle);
        defiModule.batchUpdate(subAccount1, 40000e18, tokens, balances);

        assertEq(defiModule.getSpendingAllowance(subAccount1), 40000e18);
        assertEq(defiModule.getAcquiredBalance(subAccount1, address(token)), 4000e18);
    }

    // ============ Unauthorized Cannot Call Oracle Functions ============

    function test_unauthorized_revert_updateSafeValue() public {
        vm.prank(subAccount1);
        vm.expectRevert(DeFiInteractor.OnlyAuthorizedOracle.selector);
        defiModule.updateSafeValue(1e18);
    }

    function test_unauthorized_revert_updateSpendingAllowance() public {
        vm.prank(subAccount1);
        vm.expectRevert(DeFiInteractor.OnlyAuthorizedOracle.selector);
        defiModule.updateSpendingAllowance(subAccount1, 1e18);
    }

    function test_unauthorized_revert_updateAcquiredBalance() public {
        vm.prank(subAccount1);
        vm.expectRevert(DeFiInteractor.OnlyAuthorizedOracle.selector);
        defiModule.updateAcquiredBalance(subAccount1, address(token), 1e18);
    }

    function test_unauthorized_revert_batchUpdate() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(token);
        uint256[] memory balances = new uint256[](1);
        balances[0] = 1e18;

        vm.prank(subAccount1);
        vm.expectRevert(DeFiInteractor.OnlyAuthorizedOracle.selector);
        defiModule.batchUpdate(subAccount1, 1e18, tokens, balances);
    }

    // ============ Oracle Swap: Owner Swaps Oracle, Old Oracle Loses Access ============

    function test_setAuthorizedOracle_ownerRetainsAccess() public {
        address newOracle = makeAddr("newOracle");
        defiModule.setAuthorizedOracle(newOracle);

        // Old oracle can no longer update
        vm.prank(oracle);
        vm.expectRevert(DeFiInteractor.OnlyAuthorizedOracle.selector);
        defiModule.updateSafeValue(500_000e18);

        // New oracle can
        vm.prank(newOracle);
        defiModule.updateSafeValue(500_000e18);

        // Owner STILL can (test-oracle pattern preserved after swap)
        defiModule.updateSafeValue(600_000e18);
        (uint256 val,,) = defiModule.getSafeValue();
        assertEq(val, 600_000e18);
    }

    // ============ Pause / Stale / Cap ============

    function test_pause_blocksExecution() public {
        defiModule.pause();

        bytes memory data = abi.encodeWithSignature(
            "deposit(uint256,address)",
            100e18,
            address(safe)
        );

        vm.prank(subAccount1);
        vm.expectRevert();
        defiModule.executeOnProtocol(address(protocol), data);
    }

    function test_absoluteMaxSpendingCap() public {
        // Safe value = $1M, absolute max = 20% = $200k
        vm.expectRevert();
        defiModule.updateSpendingAllowance(subAccount1, 300_000e18); // $300k > $200k cap
    }

    function test_absoluteMaxSpendingCap_oracle() public {
        // Same cap applies when oracle calls
        vm.prank(oracle);
        vm.expectRevert();
        defiModule.updateSpendingAllowance(subAccount1, 300_000e18);
    }

    function test_staleOracle_reverts() public {
        // Advance time beyond oracle age
        vm.warp(block.timestamp + 61 minutes);

        bytes memory data = abi.encodeWithSignature(
            "deposit(uint256,address)",
            100e18,
            address(safe)
        );

        vm.prank(subAccount1);
        vm.expectRevert(DeFiInteractor.StaleOracleData.selector);
        defiModule.executeOnProtocol(address(protocol), data);
    }
}
