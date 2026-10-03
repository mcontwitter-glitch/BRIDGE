// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal OApp receiver hook (LZ V2 style).
interface IOAppReceiver {
    function lzReceive(
        uint32 srcEid,
        bytes32 sender,
        bytes32 guid,
        bytes calldata message,
        bytes calldata extraData
    ) external payable;
}
