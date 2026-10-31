// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SwapPayload} from "../libraries/SwapPayload.sol";

interface IEndpointDelegate {
    function setDelegate(address delegate) external;
}

/// @title OrdinalsSink
/// @notice LayerZero V2 receive-only destination for the Abstract NftLockVault's "Bitcoin Ordinals" route.
///         It mints NOTHING and holds nothing. It accepts a LOCK_MINT message from the one vault peer, records
///         the lockId (replay guard) and emits `OrdinalsRequested`. The off-chain ordinals-delivery service
///         inscribes the Ordinal to the bc1p address committed in `recipient` (see `ordinalsRecipient`).
/// @dev No owner, no upgrade, no send path. `delegate_` is registered on the LayerZero endpoint ONLY so it can set
///      this OApp's receive library / DVN config (Arbitrum's default DVN for Abstract is LZDeadDVN). The delegate
///      cannot change the peer, which is immutable. The delivery service verifies every lock on Abstract itself,
///      so a misconfigured DVN can at worst emit a bogus event, never cause an inscription. The original NFT stays locked in the vault: this sink never sends
///      an UNLOCK_BURN, so the vault's `activeLockId` stays set (no second bridge) and there is no unlock.
///      A return path (Ordinal -> EVM) is NOT supported by this contract; it would need a new peer on this eid.
contract OrdinalsSink {
    /// @dev EndpointV2 origin; field order is the wire ABI.
    struct Origin {
        uint32 srcEid;
        bytes32 sender;
        uint64 nonce;
    }

    string public constant COMMIT_PREFIX = "BIGFOOT404-ORDINALS-V1:";

    address public immutable endpoint;
    uint32 public immutable srcEid; // Abstract 30324
    bytes32 public immutable vaultPeer; // NftLockVault proxy, left-padded

    mapping(bytes32 => bool) public seen; // lockId => received

    event OrdinalsRequested(
        bytes32 indexed lockId,
        address indexed collection,
        uint256 indexed tokenId,
        address recipientCommitment,
        string tokenURI,
        bytes32 guid
    );

    error OnlyEndpoint();
    error NotPeer(uint32 srcEid, bytes32 sender);
    error BadAction(uint8 action);
    error BadOrigin(uint32 originEid);
    error Replay(bytes32 lockId);
    error NoValue();
    error ZeroArg();

    constructor(address endpoint_, uint32 srcEid_, address vault_, address delegate_) {
        if (endpoint_ == address(0) || srcEid_ == 0 || vault_ == address(0) || delegate_ == address(0)) revert ZeroArg();
        endpoint = endpoint_;
        srcEid = srcEid_;
        vaultPeer = bytes32(uint256(uint160(vault_)));
        IEndpointDelegate(endpoint_).setDelegate(delegate_);
    }

    /// @notice The EVM `recipient` the locker puts in the vault payload for a given Taproot address.
    ///         Lower 160 bits of keccak256(COMMIT_PREFIX || lowercase bc1p). Nobody holds a key for it, and
    ///         nothing is ever sent to it; it only binds the bc1p address to the lock on-chain.
    function ordinalsRecipient(string calldata btcAddressLower) external pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(COMMIT_PREFIX, btcAddressLower)))));
    }

    function lzReceive(Origin calldata origin, bytes32 guid, bytes calldata message, address, bytes calldata)
        external
        payable
    {
        if (msg.sender != endpoint) revert OnlyEndpoint();
        if (msg.value != 0) revert NoValue();
        if (origin.srcEid != srcEid || origin.sender != vaultPeer) revert NotPeer(origin.srcEid, origin.sender);
        uint8 action = SwapPayload.peekAction(message);
        if (action != SwapPayload.ACTION_LOCK_MINT) revert BadAction(action);
        SwapPayload.LockMintPayload memory p = SwapPayload.decodeLockMint(message);
        if (p.originEid != srcEid) revert BadOrigin(p.originEid);
        if (seen[p.lockId]) revert Replay(p.lockId);
        seen[p.lockId] = true;
        emit OrdinalsRequested(p.lockId, p.collection, p.tokenId, p.recipient, p.tokenURI, guid);
    }

    /// @notice First message on the path may initialize only from the vault peer.
    function allowInitializePath(Origin calldata origin) external view returns (bool) {
        return origin.srcEid == srcEid && origin.sender == vaultPeer;
    }

    /// @notice Unordered delivery.
    function nextNonce(uint32, bytes32) external pure returns (uint64) {
        return 0;
    }
}
