// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {TreasuryVault} from "../src/TreasuryVault.sol";
import {ITreasuryVault} from "../src/interfaces/ITreasuryVault.sol";
import {MockSafe} from "./mocks/MockSafe.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract TreasuryVaultTest is Test {
    TreasuryVault public vault;
    MockSafe public safe;
    MockERC20 public token;

    address public owner;
    address public operator;
    address public manager;
    address public director;
    address public unlinkPool;
    address public defiProtocol;

    uint256 constant OPERATOR_LIMIT = 10_000e18;   // €10k
    uint256 constant MANAGER_LIMIT = 100_000e18;    // €100k

    function setUp() public {
        vm.warp(1_000_000);

        owner = makeAddr("owner");
        operator = makeAddr("operator");
        manager = makeAddr("manager");
        director = makeAddr("director");
        unlinkPool = makeAddr("unlinkPool");
        defiProtocol = makeAddr("defiProtocol");

        // Deploy Safe (3/5 multisig)
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

        // Deploy vault
        vault = new TreasuryVault(
            address(safe),
            owner,
            OPERATOR_LIMIT,
            MANAGER_LIMIT
        );

        // Enable module on Safe
        safe.enableModule(address(vault));

        // Set up roles and whitelist
        vm.startPrank(owner);
        vault.assignRole(operator, ITreasuryVault.Role.Operator);
        vault.assignRole(manager, ITreasuryVault.Role.Manager);
        vault.assignRole(director, ITreasuryVault.Role.Director);
        vault.setWhitelistedTarget(unlinkPool, true);
        vault.setWhitelistedTarget(defiProtocol, true);
        vm.stopPrank();
    }

    // ============ Constructor Tests ============

    function test_constructor() public view {
        assertEq(vault.avatar(), address(safe));
        assertEq(vault.owner(), owner);
        assertEq(vault.operatorLimit(), OPERATOR_LIMIT);
        assertEq(vault.managerLimit(), MANAGER_LIMIT);
    }

    function test_constructor_revert_zeroOperatorLimit() public {
        vm.expectRevert(TreasuryVault.InvalidLimit.selector);
        new TreasuryVault(address(safe), owner, 0, MANAGER_LIMIT);
    }

    function test_constructor_revert_zeroManagerLimit() public {
        vm.expectRevert(TreasuryVault.InvalidLimit.selector);
        new TreasuryVault(address(safe), owner, OPERATOR_LIMIT, 0);
    }

    function test_constructor_revert_operatorGtManager() public {
        vm.expectRevert(TreasuryVault.InvalidLimit.selector);
        new TreasuryVault(address(safe), owner, 200_000e18, 100_000e18);
    }

    // ============ Role Management Tests ============

    function test_assignRole() public {
        address newUser = makeAddr("newUser");
        vm.prank(owner);
        vault.assignRole(newUser, ITreasuryVault.Role.Operator);
        assertEq(uint8(vault.roles(newUser)), uint8(ITreasuryVault.Role.Operator));
    }

    function test_assignRole_emitsEvent() public {
        address newUser = makeAddr("newUser");
        vm.expectEmit(true, false, false, true);
        emit ITreasuryVault.RoleAssigned(newUser, ITreasuryVault.Role.Manager);

        vm.prank(owner);
        vault.assignRole(newUser, ITreasuryVault.Role.Manager);
    }

    function test_revokeRole() public {
        vm.prank(owner);
        vault.revokeRole(operator);
        assertEq(uint8(vault.roles(operator)), uint8(ITreasuryVault.Role.None));
    }

    function test_revokeRole_emitsEvent() public {
        vm.expectEmit(true, false, false, false);
        emit ITreasuryVault.RoleRevoked(operator);

        vm.prank(owner);
        vault.revokeRole(operator);
    }

    function test_assignRole_revert_notOwner() public {
        vm.prank(operator);
        vm.expectRevert();
        vault.assignRole(makeAddr("x"), ITreasuryVault.Role.Operator);
    }

    function test_assignRole_revert_zeroAddress() public {
        vm.prank(owner);
        vm.expectRevert();
        vault.assignRole(address(0), ITreasuryVault.Role.Operator);
    }

    // ============ Whitelist Tests ============

    function test_setWhitelistedTarget() public {
        address newTarget = makeAddr("newTarget");
        vm.prank(owner);
        vault.setWhitelistedTarget(newTarget, true);
        assertTrue(vault.whitelistedTargets(newTarget));
    }

    function test_removeWhitelistedTarget() public {
        vm.prank(owner);
        vault.setWhitelistedTarget(unlinkPool, false);
        assertFalse(vault.whitelistedTargets(unlinkPool));
    }

    function test_setWhitelistedTarget_emitsEvent() public {
        address newTarget = makeAddr("newTarget");
        vm.expectEmit(true, false, false, true);
        emit ITreasuryVault.TargetWhitelisted(newTarget, true);

        vm.prank(owner);
        vault.setWhitelistedTarget(newTarget, true);
    }

    // ============ Transfer Tests — Operator ============

    function test_operator_transferWithinLimit() public {
        uint256 amount = 5_000e18; // Under €10k operator limit
        vm.prank(operator);
        vault.executeTransfer(address(token), unlinkPool, amount);

        assertEq(token.balanceOf(unlinkPool), amount);
        assertEq(token.balanceOf(address(safe)), 1_000_000e18 - amount);
    }

    function test_operator_transferExactLimit() public {
        vm.prank(operator);
        vault.executeTransfer(address(token), unlinkPool, OPERATOR_LIMIT);

        assertEq(token.balanceOf(unlinkPool), OPERATOR_LIMIT);
    }

    function test_operator_revert_exceedsLimit() public {
        uint256 amount = OPERATOR_LIMIT + 1;
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(TreasuryVault.AmountExceedsRoleLimit.selector, amount, OPERATOR_LIMIT)
        );
        vault.executeTransfer(address(token), unlinkPool, amount);
    }

    function test_operator_emitsEvent() public {
        uint256 amount = 5_000e18;
        vm.expectEmit(true, true, true, true);
        emit ITreasuryVault.TransferExecuted(operator, address(token), unlinkPool, amount);

        vm.prank(operator);
        vault.executeTransfer(address(token), unlinkPool, amount);
    }

    // ============ Transfer Tests — Manager ============

    function test_manager_transferWithinLimit() public {
        uint256 amount = 50_000e18; // Under €100k manager limit
        vm.prank(manager);
        vault.executeTransfer(address(token), defiProtocol, amount);

        assertEq(token.balanceOf(defiProtocol), amount);
    }

    function test_manager_transferAboveOperatorLimit() public {
        // Manager can do more than operator
        uint256 amount = OPERATOR_LIMIT + 1;
        vm.prank(manager);
        vault.executeTransfer(address(token), unlinkPool, amount);

        assertEq(token.balanceOf(unlinkPool), amount);
    }

    function test_manager_revert_exceedsLimit() public {
        uint256 amount = MANAGER_LIMIT + 1;
        vm.prank(manager);
        vm.expectRevert(
            abi.encodeWithSelector(TreasuryVault.AmountExceedsRoleLimit.selector, amount, MANAGER_LIMIT)
        );
        vault.executeTransfer(address(token), unlinkPool, amount);
    }

    // ============ Transfer Tests — Director ============

    function test_director_transferAboveManagerLimit() public {
        // Director has no limit (type(uint256).max)
        uint256 amount = MANAGER_LIMIT + 1;
        vm.prank(director);
        vault.executeTransfer(address(token), unlinkPool, amount);

        assertEq(token.balanceOf(unlinkPool), amount);
    }

    function test_director_transferLargeAmount() public {
        uint256 amount = 500_000e18;
        vm.prank(director);
        vault.executeTransfer(address(token), unlinkPool, amount);

        assertEq(token.balanceOf(unlinkPool), amount);
    }

    // ============ Target Whitelist Enforcement ============

    function test_revert_targetNotWhitelisted() public {
        address notWhitelisted = makeAddr("notWhitelisted");
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TreasuryVault.TargetNotWhitelisted.selector, notWhitelisted));
        vault.executeTransfer(address(token), notWhitelisted, 1_000e18);
    }

    // ============ Authorization Tests ============

    function test_revert_noRole() public {
        address nobody = makeAddr("nobody");
        vm.prank(nobody);
        vm.expectRevert(TreasuryVault.NotAuthorized.selector);
        vault.executeTransfer(address(token), unlinkPool, 1_000e18);
    }

    function test_revert_revokedRole() public {
        vm.prank(owner);
        vault.revokeRole(operator);

        vm.prank(operator);
        vm.expectRevert(TreasuryVault.NotAuthorized.selector);
        vault.executeTransfer(address(token), unlinkPool, 1_000e18);
    }

    // ============ Reserve Requirement Tests ============

    function test_reserveRequirement_set() public {
        vm.prank(owner);
        vault.setReserveRequirement(address(token), 100_000e18);
        assertEq(vault.reserveRequirements(address(token)), 100_000e18);
    }

    function test_reserveRequirement_emitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit ITreasuryVault.ReserveRequirementUpdated(address(token), 0, 100_000e18);

        vm.prank(owner);
        vault.setReserveRequirement(address(token), 100_000e18);
    }

    function test_reserveRequirement_allowsTransferAboveReserve() public {
        vm.prank(owner);
        vault.setReserveRequirement(address(token), 100_000e18);

        // Safe has 1M, reserve is 100k, can transfer up to 900k
        uint256 amount = 500_000e18;
        vm.prank(director);
        vault.executeTransfer(address(token), unlinkPool, amount);

        assertEq(token.balanceOf(unlinkPool), amount);
    }

    function test_reserveRequirement_revert_wouldViolate() public {
        vm.prank(owner);
        vault.setReserveRequirement(address(token), 500_000e18);

        // Safe has 1M, reserve is 500k, trying to transfer 600k
        uint256 amount = 600_000e18;
        vm.prank(director);
        vm.expectRevert(
            abi.encodeWithSelector(
                TreasuryVault.ReserveViolation.selector,
                address(token),
                1_000_000e18,
                500_000e18
            )
        );
        vault.executeTransfer(address(token), unlinkPool, amount);
    }

    function test_reserveRequirement_noReserve_transfersFreely() public {
        // No reserve set — should transfer without issue
        vm.prank(director);
        vault.executeTransfer(address(token), unlinkPool, 999_000e18);

        assertEq(token.balanceOf(unlinkPool), 999_000e18);
    }

    // ============ ETH Transfer Tests ============

    function test_ethTransfer() public {
        vm.deal(address(safe), 100 ether);

        vm.prank(operator);
        vault.executeEthTransfer(unlinkPool, 5 ether);

        assertEq(unlinkPool.balance, 5 ether);
        assertEq(address(safe).balance, 95 ether);
    }

    function test_ethTransfer_emitsEvent() public {
        vm.deal(address(safe), 100 ether);

        vm.expectEmit(true, true, false, true);
        emit ITreasuryVault.EthTransferExecuted(operator, unlinkPool, 5 ether);

        vm.prank(operator);
        vault.executeEthTransfer(unlinkPool, 5 ether);
    }

    function test_ethTransfer_revert_exceedsLimit() public {
        vm.deal(address(safe), 100 ether);

        // Operator limit is 10_000e18 — ETH amount checked against same limit
        uint256 amount = OPERATOR_LIMIT + 1;
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(TreasuryVault.AmountExceedsRoleLimit.selector, amount, OPERATOR_LIMIT)
        );
        vault.executeEthTransfer(unlinkPool, amount);
    }

    function test_ethTransfer_revert_notWhitelisted() public {
        vm.deal(address(safe), 100 ether);
        address notWhitelisted = makeAddr("notWhitelisted");

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TreasuryVault.TargetNotWhitelisted.selector, notWhitelisted));
        vault.executeEthTransfer(notWhitelisted, 1 ether);
    }

    // ============ Configuration Tests ============

    function test_setOperatorLimit() public {
        vm.prank(owner);
        vault.setOperatorLimit(20_000e18);
        assertEq(vault.operatorLimit(), 20_000e18);
    }

    function test_setOperatorLimit_emitsEvent() public {
        vm.expectEmit(false, false, false, true);
        emit ITreasuryVault.OperatorLimitUpdated(OPERATOR_LIMIT, 20_000e18);

        vm.prank(owner);
        vault.setOperatorLimit(20_000e18);
    }

    function test_setManagerLimit() public {
        vm.prank(owner);
        vault.setManagerLimit(200_000e18);
        assertEq(vault.managerLimit(), 200_000e18);
    }

    function test_setOperatorLimit_revert_zero() public {
        vm.prank(owner);
        vm.expectRevert(TreasuryVault.InvalidLimit.selector);
        vault.setOperatorLimit(0);
    }

    function test_setManagerLimit_revert_zero() public {
        vm.prank(owner);
        vm.expectRevert(TreasuryVault.InvalidLimit.selector);
        vault.setManagerLimit(0);
    }

    // ============ Pause Tests ============

    function test_pause_blocksTransfers() public {
        vm.prank(owner);
        vault.pause();

        vm.prank(operator);
        vm.expectRevert();
        vault.executeTransfer(address(token), unlinkPool, 1_000e18);
    }

    function test_pause_blocksEthTransfers() public {
        vm.deal(address(safe), 100 ether);

        vm.prank(owner);
        vault.pause();

        vm.prank(operator);
        vm.expectRevert();
        vault.executeEthTransfer(unlinkPool, 1 ether);
    }

    function test_unpause_allowsTransfers() public {
        vm.prank(owner);
        vault.pause();
        vm.prank(owner);
        vault.unpause();

        vm.prank(operator);
        vault.executeTransfer(address(token), unlinkPool, 1_000e18);
        assertEq(token.balanceOf(unlinkPool), 1_000e18);
    }

    function test_pause_revert_notOwner() public {
        vm.prank(operator);
        vm.expectRevert();
        vault.pause();
    }

    // ============ View Function Tests ============

    function test_getRole() public {
        assertEq(uint8(vault.getRole(operator)), uint8(ITreasuryVault.Role.Operator));
        assertEq(uint8(vault.getRole(manager)), uint8(ITreasuryVault.Role.Manager));
        assertEq(uint8(vault.getRole(director)), uint8(ITreasuryVault.Role.Director));
        assertEq(uint8(vault.getRole(makeAddr("nobody"))), uint8(ITreasuryVault.Role.None));
    }

    function test_isWhitelistedTarget() public {
        assertTrue(vault.isWhitelistedTarget(unlinkPool));
        assertTrue(vault.isWhitelistedTarget(defiProtocol));
        assertFalse(vault.isWhitelistedTarget(makeAddr("random")));
    }

    function test_getOperatorLimit() public view {
        assertEq(vault.getOperatorLimit(), OPERATOR_LIMIT);
    }

    function test_getManagerLimit() public view {
        assertEq(vault.getManagerLimit(), MANAGER_LIMIT);
    }

    function test_getReserveRequirement() public {
        vm.prank(owner);
        vault.setReserveRequirement(address(token), 50_000e18);
        assertEq(vault.getReserveRequirement(address(token)), 50_000e18);
    }

    function test_getRoleLimit() public view {
        assertEq(vault.getRoleLimit(ITreasuryVault.Role.None), 0);
        assertEq(vault.getRoleLimit(ITreasuryVault.Role.Operator), OPERATOR_LIMIT);
        assertEq(vault.getRoleLimit(ITreasuryVault.Role.Manager), MANAGER_LIMIT);
        assertEq(vault.getRoleLimit(ITreasuryVault.Role.Director), type(uint256).max);
    }

    // ============ Multiple Token Tests ============

    function test_multipleTokens_independentReserves() public {
        MockERC20 token2 = new MockERC20();
        token2.mint(address(safe), 500_000e6);

        vm.startPrank(owner);
        vault.setReserveRequirement(address(token), 200_000e18);
        vault.setReserveRequirement(address(token2), 100_000e6);
        vm.stopPrank();

        // Transfer token1 — should respect token1 reserve
        vm.prank(director);
        vault.executeTransfer(address(token), unlinkPool, 700_000e18);
        assertEq(token.balanceOf(unlinkPool), 700_000e18);

        // Transfer token2 — should respect token2 reserve
        vm.prank(director);
        vault.executeTransfer(address(token2), unlinkPool, 300_000e6);
        assertEq(token2.balanceOf(unlinkPool), 300_000e6);
    }
}
