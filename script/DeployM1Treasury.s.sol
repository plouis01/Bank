// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {TreasuryTimelock} from "../src/TreasuryTimelock.sol";
import {TreasuryVault} from "../src/TreasuryVault.sol";

/**
 * @title DeployM1Treasury
 * @notice Deploy xTimelock + xVault modules for the M1 Treasury Safe
 * @dev Usage: forge script script/DeployM1Treasury.s.sol --rpc-url $RPC_URL --broadcast
 *
 *      Required env vars:
 *        M1_SAFE_ADDRESS      - The M1 Safe (3/5 multisig) address
 *        DEPLOYER_PRIVATE_KEY - Deployer key
 *        TIMELOCK_DELAY       - Minimum delay in seconds (e.g., 86400 for 24h)
 *        TIMELOCK_THRESHOLD   - USD threshold for timelock (18 decimals, e.g., 100000e18)
 *        OPERATOR_LIMIT       - Max transfer for Operator role (18 decimals)
 *        MANAGER_LIMIT        - Max transfer for Manager role (18 decimals)
 *
 *      After deployment, the M1 Safe multisig must:
 *        1. Enable both modules on the Safe (enableModule)
 *        2. Set proposers/executors/cancellers on TreasuryTimelock
 *        3. Assign roles on TreasuryVault
 *        4. Whitelist target addresses on TreasuryVault
 *        5. Set reserve requirements on TreasuryVault
 *        6. Link TreasuryTimelock address on TreasuryVault (setTimelockModule)
 */
contract DeployM1Treasury is Script {
    function run() external {
        address m1Safe = vm.envAddress("M1_SAFE_ADDRESS");
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        uint256 timelockDelay = vm.envUint("TIMELOCK_DELAY");
        uint256 timelockThreshold = vm.envUint("TIMELOCK_THRESHOLD");
        uint256 operatorLimit = vm.envUint("OPERATOR_LIMIT");
        uint256 managerLimit = vm.envUint("MANAGER_LIMIT");

        vm.startBroadcast(deployerKey);

        // Deploy TreasuryTimelock (xTimelock)
        // Owner is the M1 Safe itself (managed by 3/5 multisig)
        TreasuryTimelock timelock = new TreasuryTimelock(
            m1Safe,
            m1Safe,
            timelockDelay,
            timelockThreshold
        );

        console.log("TreasuryTimelock deployed at:", address(timelock));
        console.log("  Min delay:", timelockDelay, "seconds");
        console.log("  Threshold:", timelockThreshold);

        // Deploy TreasuryVault (xVault)
        // Owner is the M1 Safe itself
        TreasuryVault vault = new TreasuryVault(
            m1Safe,
            m1Safe,
            operatorLimit,
            managerLimit
        );

        console.log("TreasuryVault deployed at:", address(vault));
        console.log("  Operator limit:", operatorLimit);
        console.log("  Manager limit:", managerLimit);
        console.log("  Avatar (M1 Safe):", m1Safe);

        vm.stopBroadcast();

        console.log("");
        console.log("=== Post-deployment steps (via M1 Safe multisig) ===");
        console.log("1. Safe.enableModule(", address(timelock), ")");
        console.log("2. Safe.enableModule(", address(vault), ")");
        console.log("3. TreasuryTimelock.setProposer/setExecutor/setCanceller for signers");
        console.log("4. TreasuryVault.assignRole for operators/managers/directors");
        console.log("5. TreasuryVault.setWhitelistedTarget for Unlink pool, DeFi protocols");
        console.log("6. TreasuryVault.setTimelockModule(", address(timelock), ")");
        console.log("7. TreasuryVault.setReserveRequirement for each token");
    }
}
