// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice LayerZero Endpoint V2 config surface used by the upgradeable OApps.
/// @dev Compile with evm_version paris so Abstract (no PUSH0) can deploy the callers.
interface ILayerZeroEndpointConfig {
    struct SetConfigParam {
        uint32 eid;
        uint32 configType;
        bytes config;
    }

    struct UlnConfig {
        uint64 confirmations;
        uint8 requiredDVNCount;
        uint8 optionalDVNCount;
        uint8 optionalDVNThreshold;
        address[] requiredDVNs;
        address[] optionalDVNs;
    }

    struct ExecutorConfig {
        uint32 maxMessageSize;
        address executor;
    }

    function setDelegate(address delegate) external;

    function delegates(address oapp) external view returns (address);

    function setConfig(address oapp, address lib, SetConfigParam[] calldata params) external;
}
