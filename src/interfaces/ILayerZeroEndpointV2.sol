// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal LayerZero V2 Endpoint stub for local compile / mock messaging.
/// TODO: replace with real layerzerolabs lz-evm-protocol-v2 package interfaces and wire setPeer/_lzSend.
interface ILayerZeroEndpointV2 {
    struct MessagingParams {
        uint32 dstEid;
        bytes32 receiver;
        bytes message;
        bytes options;
        bool payInLzToken;
    }

    struct MessagingFee {
        uint256 nativeFee;
        uint256 lzTokenFee;
    }

    struct MessagingReceipt {
        bytes32 guid;
        uint64 nonce;
        MessagingFee fee;
    }

    function quote(MessagingParams calldata params, address sender)
        external
        view
        returns (MessagingFee memory fee);

    function send(MessagingParams calldata params, address refundAddress)
        external
        payable
        returns (MessagingReceipt memory receipt);

    function setDelegate(address delegate) external;
}
