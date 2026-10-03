// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice EVM chain ids and official LayerZero V2 endpoint ids (mainnet).
/// Source: https://metadata.layerzero-api.com/v1/metadata
/// Abstract home eid is 30324. Do not use the stale 30310 placeholder.
library ChainIds {
    // EVM chain ids
    uint256 internal constant ABSTRACT_CHAIN_ID = 2741;
    uint256 internal constant ETHEREUM_CHAIN_ID = 1;
    uint256 internal constant BASE_CHAIN_ID = 8453;
    uint256 internal constant BNB_CHAIN_ID = 56;
    uint256 internal constant APECHAIN_CHAIN_ID = 33139;

    // LayerZero V2 endpoint ids (mainnet)
    uint32 internal constant ABSTRACT_EID = 30324;
    uint32 internal constant ETHEREUM_EID = 30101;
    uint32 internal constant BASE_EID = 30184;
    uint32 internal constant BNB_EID = 30102;
    uint32 internal constant APECHAIN_EID = 30312;

    /// @dev Non-EVM destinations. Messaging uses the LZ eid.
    uint32 internal constant SOLANA_EID = 30168;
    uint32 internal constant SUI_EID = 30378;
}
