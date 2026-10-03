// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ILayerZeroEndpointV2} from "./interfaces/ILayerZeroEndpointV2.sol";
import {IOAppReceiver} from "./interfaces/IOAppReceiver.sol";
import {SwapPayload} from "./libraries/SwapPayload.sol";

/// @title NftLockVault
/// @notice Home-chain (Abstract) vault: LOCK ERC721 → send LZ message → unlock on return.
/// @dev Prefer lock (not burn) of originals. Metadata tokenURI copied verbatim in payload.
/// TODO: replace MockLayerZeroEndpoint with real EndpointV2; implement setPeer + _lzSend options.
contract NftLockVault is Ownable, ReentrancyGuard, IERC721Receiver, IOAppReceiver {
    using SwapPayload for SwapPayload.LockMintPayload;
    using SwapPayload for SwapPayload.UnlockBurnPayload;

    /// @dev LayerZero V2 endpoint (mock or real)
    ILayerZeroEndpointV2 public endpoint;

    /// @dev This chain's LZ endpoint id (Abstract placeholder)
    uint32 public immutable localEid;

    /// @dev peer OApp (NftTwinMinter) per destination eid
    mapping(uint32 => bytes32) public peers;

    struct LockRecord {
        address collection;
        uint256 tokenId;
        address owner;
        uint32 destEid;
        string tokenURI;
        bool active;
    }

    mapping(bytes32 => LockRecord) public locks;
    /// collection => tokenId => lockId (active)
    mapping(address => mapping(uint256 => bytes32)) public activeLockId;

    event PeerSet(uint32 indexed eid, bytes32 peer);
    event EndpointUpdated(address indexed endpoint);
    event NftLocked(
        bytes32 indexed lockId,
        address indexed collection,
        uint256 indexed tokenId,
        address owner,
        uint32 destEid,
        string tokenURI,
        address recipient
    );
    event NftUnlocked(
        bytes32 indexed lockId,
        address indexed collection,
        uint256 indexed tokenId,
        address recipient
    );
    event MessageSent(bytes32 indexed lockId, uint32 destEid, bytes32 guid);

    error PeerNotSet(uint32 eid);
    error NotPeer(uint32 srcEid, bytes32 sender);
    error AlreadyLocked(address collection, uint256 tokenId);
    error LockNotActive(bytes32 lockId);
    error NotTokenOwner();
    error BadAction(uint8 action);
    error OnlyEndpoint();

    constructor(address endpoint_, uint32 localEid_) Ownable(msg.sender) {
        endpoint = ILayerZeroEndpointV2(endpoint_);
        localEid = localEid_;
    }

    function setEndpoint(address endpoint_) external onlyOwner {
        endpoint = ILayerZeroEndpointV2(endpoint_);
        emit EndpointUpdated(endpoint_);
    }

    /// @notice TODO: call real OApp setPeer once wired to LayerZero OApp base.
    function setPeer(uint32 eid, bytes32 peer) external onlyOwner {
        peers[eid] = peer;
        emit PeerSet(eid, peer);
    }

    /// @notice Lock an NFT on Abstract and request twin mint on dest.
    /// @param collection ERC721 on Abstract
    /// @param tokenId token to lock
    /// @param destEid destination LayerZero eid (ETH/Base/BNB/Ape)
    /// @param recipient who receives the twin on dest (usually msg.sender or bridged address)
    /// @param options LZ executor options (empty for mock)
    function lockAndSwap(
        address collection,
        uint256 tokenId,
        uint32 destEid,
        address recipient,
        bytes calldata options
    ) external payable nonReentrant returns (bytes32 lockId) {
        if (peers[destEid] == bytes32(0)) revert PeerNotSet(destEid);
        if (activeLockId[collection][tokenId] != bytes32(0)) {
            revert AlreadyLocked(collection, tokenId);
        }
        if (IERC721(collection).ownerOf(tokenId) != msg.sender) revert NotTokenOwner();

        string memory uri = _tokenURI(collection, tokenId);

        // Lock: custody in vault (prefer lock, not burn)
        IERC721(collection).safeTransferFrom(msg.sender, address(this), tokenId);

        lockId = keccak256(
            abi.encodePacked(collection, tokenId, msg.sender, destEid, block.number, localEid)
        );

        locks[lockId] = LockRecord({
            collection: collection,
            tokenId: tokenId,
            owner: msg.sender,
            destEid: destEid,
            tokenURI: uri,
            active: true
        });
        activeLockId[collection][tokenId] = lockId;

        SwapPayload.LockMintPayload memory payload = SwapPayload.LockMintPayload({
            action: SwapPayload.ACTION_LOCK_MINT,
            collection: collection,
            tokenId: tokenId,
            tokenURI: uri,
            recipient: recipient,
            originEid: localEid,
            lockId: lockId
        });

        bytes memory message = SwapPayload.encodeLockMint(payload);

        // TODO: real OApp uses _lzSend(destEid, message, options, fee, refund)
        ILayerZeroEndpointV2.MessagingParams memory params = ILayerZeroEndpointV2.MessagingParams({
            dstEid: destEid,
            receiver: peers[destEid],
            message: message,
            options: options,
            payInLzToken: false
        });

        ILayerZeroEndpointV2.MessagingReceipt memory receipt =
            endpoint.send{value: msg.value}(params, msg.sender);

        emit NftLocked(lockId, collection, tokenId, msg.sender, destEid, uri, recipient);
        emit MessageSent(lockId, destEid, receipt.guid);
    }

    /// @notice Receive unlock confirmation from dest twin burn/lock.
    function lzReceive(
        uint32 srcEid,
        bytes32 sender,
        bytes32 /* guid */,
        bytes calldata message,
        bytes calldata /* extraData */
    ) external payable override nonReentrant {
        if (msg.sender != address(endpoint)) revert OnlyEndpoint();
        if (peers[srcEid] != sender) revert NotPeer(srcEid, sender);

        uint8 action = SwapPayload.peekAction(message);
        if (action != SwapPayload.ACTION_UNLOCK_BURN) revert BadAction(action);

        SwapPayload.UnlockBurnPayload memory p = SwapPayload.decodeUnlockBurn(message);
        _unlock(p.lockId, p.recipient);
    }

    function _unlock(bytes32 lockId, address recipient) internal {
        LockRecord storage rec = locks[lockId];
        if (!rec.active) revert LockNotActive(lockId);

        rec.active = false;
        delete activeLockId[rec.collection][rec.tokenId];

        IERC721(rec.collection).safeTransferFrom(address(this), recipient, rec.tokenId);
        emit NftUnlocked(lockId, rec.collection, rec.tokenId, recipient);
    }

    function quoteLock(
        address collection,
        uint256 tokenId,
        uint32 destEid,
        address recipient,
        bytes calldata options
    ) external view returns (ILayerZeroEndpointV2.MessagingFee memory fee) {
        if (peers[destEid] == bytes32(0)) revert PeerNotSet(destEid);
        string memory uri = _tokenURI(collection, tokenId);
        bytes32 lockId = bytes32(0); // quote-only placeholder
        SwapPayload.LockMintPayload memory payload = SwapPayload.LockMintPayload({
            action: SwapPayload.ACTION_LOCK_MINT,
            collection: collection,
            tokenId: tokenId,
            tokenURI: uri,
            recipient: recipient,
            originEid: localEid,
            lockId: lockId
        });
        ILayerZeroEndpointV2.MessagingParams memory params = ILayerZeroEndpointV2.MessagingParams({
            dstEid: destEid,
            receiver: peers[destEid],
            message: SwapPayload.encodeLockMint(payload),
            options: options,
            payInLzToken: false
        });
        return endpoint.quote(params, address(this));
    }

    function _tokenURI(address collection, uint256 tokenId) internal view returns (string memory) {
        // IERC721Metadata
        (bool ok, bytes memory data) =
            collection.staticcall(abi.encodeWithSignature("tokenURI(uint256)", tokenId));
        require(ok && data.length > 0, "tokenURI failed");
        return abi.decode(data, (string));
    }

    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IERC721Receiver.onERC721Received.selector;
    }
}
