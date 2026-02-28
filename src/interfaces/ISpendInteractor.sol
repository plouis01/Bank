// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ISpendInteractor {
    // ============ Events ============

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

    // ============ Core Authorization ============

    function authorizeSpend(
        uint256 amount,
        bytes32 recipientHash,
        uint8 transferType
    ) external;

    // ============ EOA Management (only M2 signers / owner) ============

    function registerEOA(address eoa, uint256 dailyLimit, uint8[] calldata allowedTypes) external;
    function revokeEOA(address eoa) external;
    function updateLimit(address eoa, uint256 newDailyLimit) external;

    // ============ View Functions ============

    function getRollingSpend(address eoa) external view returns (uint256);
    function getRemainingLimit(address eoa) external view returns (uint256);
    function getDailyLimit(address eoa) external view returns (uint256);
    function isRegisteredEOA(address eoa) external view returns (bool);
}
