// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {SpendInteractor} from "../src/SpendInteractor.sol";

/**
 * @title DeploySpendInteractor
 * @notice Deploy SpendInteractor module for an M2 Safe
 * @dev Usage: forge script script/DeploySpendInteractor.s.sol --rpc-url $RPC_URL --broadcast
 *      Required env vars: M2_SAFE_ADDRESS, DEPLOYER_PRIVATE_KEY
 */
contract DeploySpendInteractor is Script {
    function run() external {
        address m2Safe = vm.envAddress("M2_SAFE_ADDRESS");
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerKey);

        // Owner is the M2 Safe itself (signers manage via multisig)
        SpendInteractor interactor = new SpendInteractor(m2Safe, m2Safe);

        console.log("SpendInteractor deployed at:", address(interactor));
        console.log("Avatar (M2 Safe):", m2Safe);
        console.log("Owner:", m2Safe);

        vm.stopBroadcast();
    }
}
