// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockChainlinkPriceFeedDeployable
 * @notice Deployable Chainlink AggregatorV3Interface mock with owner-updatable price.
 * @dev Used on Monad testnet where Chainlink feeds don't exist.
 *      Owner can update price; anyone can read via latestRoundData().
 */
contract MockChainlinkPriceFeedDeployable {
    int256 public price;
    uint8 public decimals;
    uint256 public updatedAt;
    address public owner;
    string public description;

    error OnlyOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    constructor(int256 _price, uint8 _decimals, string memory _description) {
        price = _price;
        decimals = _decimals;
        description = _description;
        updatedAt = block.timestamp;
        owner = msg.sender;
    }

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 _updatedAt,
            uint80 answeredInRound
        )
    {
        return (1, price, block.timestamp, updatedAt, 1);
    }

    function setPrice(int256 _price) external onlyOwner {
        price = _price;
        updatedAt = block.timestamp;
    }

    function setUpdatedAt(uint256 _updatedAt) external onlyOwner {
        updatedAt = _updatedAt;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
    }
}
