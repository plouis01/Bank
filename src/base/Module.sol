// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.20;

import {ISafe} from "../interfaces/ISafe.sol";

/**
 * @title Module
 * @notice Base contract for Zodiac modules
 * @dev Modules allow designated addresses to execute transactions through a Safe
 */
abstract contract Module {
    /// @notice Address of the Safe (avatar) that this module interacts with
    address public avatar;

    /// @notice Address where transactions are sent (usually the Safe itself)
    address public target;

    /// @notice Owner address that can configure the module
    address public owner;

    event AvatarSet(address indexed previousAvatar, address indexed newAvatar);
    event TargetSet(address indexed previousTarget, address indexed newTarget);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error Unauthorized();
    error InvalidAddress();
    error ModuleTransactionFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address _avatar, address _target, address _owner) {
        if (_avatar == address(0) || _target == address(0) || _owner == address(0)) {
            revert InvalidAddress();
        }
        avatar = _avatar;
        target = _target;
        owner = _owner;

        emit AvatarSet(address(0), _avatar);
        emit TargetSet(address(0), _target);
        emit OwnershipTransferred(address(0), _owner);
    }

    function setAvatar(address _avatar) public onlyOwner {
        if (_avatar == address(0)) revert InvalidAddress();
        address previousAvatar = avatar;
        avatar = _avatar;
        emit AvatarSet(previousAvatar, _avatar);
    }

    function setTarget(address _target) public onlyOwner {
        if (_target == address(0)) revert InvalidAddress();
        address previousTarget = target;
        target = _target;
        emit TargetSet(previousTarget, _target);
    }

    function transferOwnership(address _newOwner) public onlyOwner {
        if (_newOwner == address(0)) revert InvalidAddress();
        address previousOwner = owner;
        owner = _newOwner;
        emit OwnershipTransferred(previousOwner, _newOwner);
    }

    function exec(
        address to,
        uint256 value,
        bytes memory data,
        ISafe.Operation operation
    ) internal returns (bool success) {
        return ISafe(target).execTransactionFromModule(to, value, data, operation);
    }

}
