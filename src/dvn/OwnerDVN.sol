// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ILayerZeroDVN, IReceiveUln302} from "./ILayerZeroDVN.sol";

/// @title OwnerDVN
/// @notice Minimal DVN the owner verifies by hand.
/// @dev assignJob and getFee are the ILayerZeroDVN surface the send ULN calls. Both return 0
///      so a lock does not pay this DVN and does not depend on LayerZero Labs.
///      verify is owner-only and forwards the packet header and payload hash to this chain's
///      receive ULN. DVN addresses passed to the ULN must be strictly ascending; a single
///      DVN is already ordered.
contract OwnerDVN is ILayerZeroDVN, Ownable {
    address public immutable receiveUln;

    error ReceiveUlnZero();

    event JobAssigned(uint32 dstEid, bytes32 payloadHash, uint64 confirmations, address sender);
    event PayloadSubmitted(bytes32 payloadHash, uint64 confirmations);

    constructor(address receiveUln_, address owner_) Ownable(owner_) {
        if (receiveUln_ == address(0)) revert ReceiveUlnZero();
        receiveUln = receiveUln_;
    }

    /// @inheritdoc ILayerZeroDVN
    function assignJob(AssignJobParam calldata _param, bytes calldata) external payable returns (uint256 fee) {
        emit JobAssigned(_param.dstEid, _param.payloadHash, _param.confirmations, _param.sender);
        return 0;
    }

    /// @inheritdoc ILayerZeroDVN
    function getFee(uint32, uint64, address, bytes calldata) external pure returns (uint256 fee) {
        return 0;
    }

    /// @notice Record verification on this chain's receive ULN.
    /// @dev confirmations must be at least the pathway's configured value or the ULN will not commit.
    function verify(bytes calldata packetHeader, bytes32 payloadHash, uint64 confirmations) external onlyOwner {
        IReceiveUln302(receiveUln).verify(packetHeader, payloadHash, confirmations);
        emit PayloadSubmitted(payloadHash, confirmations);
    }
}
