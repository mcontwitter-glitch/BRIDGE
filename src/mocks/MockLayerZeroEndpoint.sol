// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ILayerZeroEndpointV2} from "../interfaces/ILayerZeroEndpointV2.sol";
import {IOAppReceiver} from "../interfaces/IOAppReceiver.sol";

/// @notice Local mock: stores last send and can deliver messages synchronously for tests.
/// TODO: swap for real LayerZero EndpointV2 address per chain; wire setPeer + _lzSend.
contract MockLayerZeroEndpoint is ILayerZeroEndpointV2 {
    uint64 public nonce;
    address public lastSender;
    MessagingParams internal _lastParams;

    event MessageSent(uint32 dstEid, bytes32 receiver, bytes message, bytes32 guid);
    event MessageDelivered(uint32 srcEid, bytes32 sender, address to, bytes32 guid);

    function quote(MessagingParams calldata, address) external pure returns (MessagingFee memory fee) {
        fee = MessagingFee({nativeFee: 0.001 ether, lzTokenFee: 0});
    }

    function send(MessagingParams calldata params, address /* refundAddress */)
        external
        payable
        returns (MessagingReceipt memory receipt)
    {
        nonce += 1;
        lastSender = msg.sender;
        _lastParams = params;
        bytes32 guid = keccak256(abi.encodePacked(nonce, params.dstEid, params.message));
        receipt = MessagingReceipt({
            guid: guid,
            nonce: nonce,
            fee: MessagingFee({nativeFee: msg.value, lzTokenFee: 0})
        });
        emit MessageSent(params.dstEid, params.receiver, params.message, guid);
    }

    /// @dev Test helper: deliver a message to an OApp receiver as if from LZ.
    function deliver(
        address to,
        uint32 srcEid,
        bytes32 sender,
        bytes calldata message
    ) external payable {
        bytes32 guid = keccak256(abi.encodePacked(block.timestamp, srcEid, sender, message));
        IOAppReceiver(to).lzReceive{value: msg.value}(srcEid, sender, guid, message, "");
        emit MessageDelivered(srcEid, sender, to, guid);
    }

    function lastMessage() external view returns (bytes memory) {
        return _lastParams.message;
    }

    function setDelegate(address) external {}
}
