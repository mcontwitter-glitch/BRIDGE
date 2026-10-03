// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {ILayerZeroEndpointV2} from "./interfaces/ILayerZeroEndpointV2.sol";
import {IOAppReceiver} from "./interfaces/IOAppReceiver.sol";
import {ITwinCollection} from "./interfaces/ITwinCollection.sol";
import {TwinCollection} from "./TwinCollection.sol";
import {SwapPayload} from "./libraries/SwapPayload.sol";

/// @title NftTwinMinter
/// @notice Mints a twin into a destination collection that belongs to one origin collection.
/// @dev The first lock for an origin collection creates its twin collection. Later locks reuse it.
contract NftTwinMinter is Ownable, ReentrancyGuard, IOAppReceiver {
    ILayerZeroEndpointV2 public endpoint;
    uint32 public immutable localEid;

    /// @dev peers[eid] = OApp address on that chain (NftLockVault on Abstract)
    mapping(uint32 => bytes32) public peers;

    /// @dev origin collection on Abstract => twin collection on this chain
    mapping(address => address) public collectionOf;

    /// lockId => twin minted
    mapping(bytes32 => bool) public minted;
    mapping(bytes32 => TwinRecord) public twins;

    struct TwinRecord {
        address originCollection;
        uint256 tokenId;
        address holder;
        uint32 originEid;
        bool active;
    }

    event PeerSet(uint32 indexed eid, bytes32 peer);
    event EndpointUpdated(address indexed endpoint);
    event CollectionPrepared(address indexed origin, address indexed twin);
    event TwinMinted(
        bytes32 indexed lockId,
        address indexed to,
        uint256 indexed tokenId,
        string tokenURI,
        uint32 originEid
    );
    event TwinBurnedForUnlock(bytes32 indexed lockId, uint256 indexed tokenId, address initiator);
    event MessageSent(bytes32 indexed lockId, uint32 destEid, bytes32 guid);

    error PeerNotSet(uint32 eid);
    error NotPeer(uint32 srcEid, bytes32 sender);
    error AlreadyMinted(bytes32 lockId);
    error TwinNotActive(bytes32 lockId);
    error NotTwinOwner();
    error BadAction(uint8 action);
    error OnlyEndpoint();
    error CollectionUnset(address origin);

    constructor(address endpoint_, uint32 localEid_) Ownable(msg.sender) {
        endpoint = ILayerZeroEndpointV2(endpoint_);
        localEid = localEid_;
    }

    function setEndpoint(address endpoint_) external onlyOwner {
        endpoint = ILayerZeroEndpointV2(endpoint_);
        emit EndpointUpdated(endpoint_);
    }

    /// @notice Point an origin collection at a twin collection this minter can mint into.
    function prepareCollection(address origin, address twin) external onlyOwner {
        collectionOf[origin] = twin;
        emit CollectionPrepared(origin, twin);
    }

    function setPeer(uint32 eid, bytes32 peer) external onlyOwner {
        peers[eid] = peer;
        emit PeerSet(eid, peer);
    }

    /// @notice Receive lock message from Abstract vault and mint into that origin's twin collection.
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
        if (action != SwapPayload.ACTION_LOCK_MINT) revert BadAction(action);

        SwapPayload.LockMintPayload memory p = SwapPayload.decodeLockMint(message);
        if (minted[p.lockId]) revert AlreadyMinted(p.lockId);

        ITwinCollection twin = _collectionFor(p.collection);

        minted[p.lockId] = true;
        twins[p.lockId] = TwinRecord({
            originCollection: p.collection,
            tokenId: p.tokenId,
            holder: p.recipient,
            originEid: p.originEid,
            active: true
        });

        twin.mintWithURI(p.recipient, p.tokenId, p.tokenURI);

        emit TwinMinted(p.lockId, p.recipient, p.tokenId, p.tokenURI, p.originEid);
    }

    /// @notice Burn the dest twin and send the unlock message back to the Abstract vault.
    function unlockBack(bytes32 lockId, address recipient, bytes calldata options)
        external
        payable
        nonReentrant
    {
        TwinRecord storage rec = twins[lockId];
        if (!rec.active) revert TwinNotActive(lockId);
        ITwinCollection twin = ITwinCollection(collectionOf[rec.originCollection]);
        if (address(twin) == address(0)) revert CollectionUnset(rec.originCollection);
        if (twin.ownerOf(rec.tokenId) != msg.sender) revert NotTwinOwner();

        uint32 originEid = rec.originEid;
        if (peers[originEid] == bytes32(0)) revert PeerNotSet(originEid);

        twin.burn(rec.tokenId);
        rec.active = false;

        SwapPayload.UnlockBurnPayload memory payload = SwapPayload.UnlockBurnPayload({
            action: SwapPayload.ACTION_UNLOCK_BURN,
            collection: rec.originCollection,
            tokenId: rec.tokenId,
            recipient: recipient,
            destEid: localEid,
            lockId: lockId
        });

        bytes memory message = SwapPayload.encodeUnlockBurn(payload);

        ILayerZeroEndpointV2.MessagingParams memory params = ILayerZeroEndpointV2.MessagingParams({
            dstEid: originEid,
            receiver: peers[originEid],
            message: message,
            options: options,
            payInLzToken: false
        });

        ILayerZeroEndpointV2.MessagingReceipt memory receipt =
            endpoint.send{value: msg.value}(params, msg.sender);

        emit TwinBurnedForUnlock(lockId, rec.tokenId, msg.sender);
        emit MessageSent(lockId, originEid, receipt.guid);
    }

    function quoteUnlock(bytes32 lockId, address recipient, bytes calldata options)
        external
        view
        returns (ILayerZeroEndpointV2.MessagingFee memory fee)
    {
        TwinRecord storage rec = twins[lockId];
        if (!rec.active) revert TwinNotActive(lockId);
        uint32 originEid = rec.originEid;
        if (peers[originEid] == bytes32(0)) revert PeerNotSet(originEid);

        SwapPayload.UnlockBurnPayload memory payload = SwapPayload.UnlockBurnPayload({
            action: SwapPayload.ACTION_UNLOCK_BURN,
            collection: rec.originCollection,
            tokenId: rec.tokenId,
            recipient: recipient,
            destEid: localEid,
            lockId: lockId
        });

        ILayerZeroEndpointV2.MessagingParams memory params = ILayerZeroEndpointV2.MessagingParams({
            dstEid: originEid,
            receiver: peers[originEid],
            message: SwapPayload.encodeUnlockBurn(payload),
            options: options,
            payInLzToken: false
        });
        return endpoint.quote(params, address(this));
    }

    function _collectionFor(address origin) internal returns (ITwinCollection twin) {
        address existing = collectionOf[origin];
        if (existing != address(0)) return ITwinCollection(existing);

        string memory label = string.concat("Twin ", Strings.toHexString(origin));
        TwinCollection created = new TwinCollection(label, "TWIN", owner(), address(this));
        collectionOf[origin] = address(created);
        emit CollectionPrepared(origin, address(created));
        return ITwinCollection(address(created));
    }
}
