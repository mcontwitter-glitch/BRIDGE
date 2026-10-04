// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice LayerZero V2 DVN surface the send ULN calls when quoting and paying a pathway.
/// @dev Field order matches LayerZero's ILayerZeroDVN.AssignJobParam.
interface ILayerZeroDVN {
    struct AssignJobParam {
        uint32 dstEid;
        bytes packetHeader;
        bytes32 payloadHash;
        uint64 confirmations;
        address sender;
    }

    function assignJob(AssignJobParam calldata _param, bytes calldata _options) external payable returns (uint256 fee);

    function getFee(uint32 _dstEid, uint64 _confirmations, address _sender, bytes calldata _options)
        external
        view
        returns (uint256 fee);
}

/// @notice Receive ULN302 entry the DVN uses to record a verification and commit it.
interface IReceiveUln302 {
    struct UlnConfig {
        uint64 confirmations;
        uint8 requiredDVNCount;
        uint8 optionalDVNCount;
        uint8 optionalDVNThreshold;
        address[] requiredDVNs;
        address[] optionalDVNs;
    }

    function verify(bytes calldata _packetHeader, bytes32 _payloadHash, uint64 _confirmations) external;

    function commitVerification(bytes calldata _packetHeader, bytes32 _payloadHash) external;

    function getUlnConfig(address _oapp, uint32 _remoteEid) external view returns (UlnConfig memory);
}
