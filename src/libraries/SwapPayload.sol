// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SwapPayload
/// @notice Shared ABI encoding for cross-chain NFT lock/unlock messages (LayerZero V2-style).
library SwapPayload {
    /// @dev Action discriminators
    uint8 internal constant ACTION_LOCK_MINT = 1;
    uint8 internal constant ACTION_UNLOCK_BURN = 2;

    struct LockMintPayload {
        uint8 action; // ACTION_LOCK_MINT
        address collection; // origin ERC721 on Abstract
        uint256 tokenId;
        string tokenURI; // IPFS/Arweave URI copied verbatim to twin
        address recipient; // who receives the twin on dest
        uint32 originEid; // LayerZero endpoint id of home (Abstract)
        bytes32 lockId; // unique lock identifier for unlock matching
    }

    struct UnlockBurnPayload {
        uint8 action; // ACTION_UNLOCK_BURN
        address collection; // origin ERC721 on Abstract
        uint256 tokenId;
        address recipient; // who receives unlocked original on home
        uint32 destEid; // chain where twin was burned
        bytes32 lockId;
    }

    function encodeLockMint(LockMintPayload memory p) internal pure returns (bytes memory) {
        return abi.encode(
            p.action, p.collection, p.tokenId, p.tokenURI, p.recipient, p.originEid, p.lockId
        );
    }

    function decodeLockMint(bytes memory data) internal pure returns (LockMintPayload memory p) {
        (p.action, p.collection, p.tokenId, p.tokenURI, p.recipient, p.originEid, p.lockId) =
            abi.decode(data, (uint8, address, uint256, string, address, uint32, bytes32));
    }

    function encodeUnlockBurn(UnlockBurnPayload memory p) internal pure returns (bytes memory) {
        return abi.encode(p.action, p.collection, p.tokenId, p.recipient, p.destEid, p.lockId);
    }

    function decodeUnlockBurn(bytes memory data) internal pure returns (UnlockBurnPayload memory p) {
        (p.action, p.collection, p.tokenId, p.recipient, p.destEid, p.lockId) =
            abi.decode(data, (uint8, address, uint256, address, uint32, bytes32));
    }

    /// @dev Solana recipient is a 32-byte address, not an EVM address.
    struct LockMintSolanaPayload {
        uint8 action;
        address collection;
        uint256 tokenId;
        string tokenURI;
        bytes32 solanaRecipient;
        uint32 originEid;
        bytes32 lockId;
    }

    function encodeLockMintSolana(LockMintSolanaPayload memory p) internal pure returns (bytes memory) {
        return abi.encode(
            p.action, p.collection, p.tokenId, p.tokenURI, p.solanaRecipient, p.originEid, p.lockId
        );
    }

    function peekAction(bytes memory data) internal pure returns (uint8 action) {
        (action) = abi.decode(data, (uint8));
    }
}
