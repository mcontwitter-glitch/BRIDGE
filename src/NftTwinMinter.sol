// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ILayerZeroEndpointV2} from "./interfaces/ILayerZeroEndpointV2.sol";
import {IOAppReceiver} from "./interfaces/IOAppReceiver.sol";
import {ITwinCollection} from "./interfaces/ITwinCollection.sol";
import {SwapPayload} from "./libraries/SwapPayload.sol";

/// @title NftTwinMinter
/// @notice Dest-chain minter: mint twin with same tokenURI; burn/lock twin to unlock home original.
/// @dev Twin collection must grant MINTER_ROLE to this contract.
/// TODO: replace mock endpoint; setPeer to Abstract NftLockVault; real _lzSend.
contract NftTwinMinter is Ownable, ReentrancyGuard, IOAppReceiver {
    ILayerZeroEndpointV2 public endpoint;
    uint32 public immutable localEid;

    /// @dev twin collection this minter controls (existing collection + minter role)
    ITwinCollection public twinCollection;

    /// @dev peers[eid] = OApp address on that chain (NftLockVault on Abstract)
    mapping(uint32 => bytes32) public peers;

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
    event TwinCollectionUpdated(address indexed collection);
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

    constructor(address endpoint_, uint32 localEid_, address twinCollection_) Ownable(msg.sender) {
        endpoint = ILayerZeroEndpointV2(endpoint_);
        localEid = localEid_;
        twinCollection = ITwinCollection(twinCollection_);
    }

    function setEndpoint(address endpoint_) external onlyOwner {
        endpoint = ILayerZeroEndpointV2(endpoint_);
        emit EndpointUpdated(endpoint_);
    }

    function setTwinCollection(address twinCollection_) external onlyOwner {
        twinCollection = ITwinCollection(twinCollection_);
        emit TwinCollectionUpdated(twinCollection_);
    }

    /// @notice TODO: real OApp setPeer
    function setPeer(uint32 eid, bytes32 peer) external onlyOwner {
        peers[eid] = peer;
        emit PeerSet(eid, peer);
    }

    /// @notice Receive lock message from Abstract vault → mint twin with same tokenURI.
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

        minted[p.lockId] = true;
        twins[p.lockId] = TwinRecord({
            originCollection: p.collection,
            tokenId: p.tokenId,
            holder: p.recipient,
            originEid: p.originEid,
            active: true
        });

        // Mint into existing collection with same tokenURI (IPFS/Arweave verbatim)
        twinCollection.mintWithURI(p.recipient, p.tokenId, p.tokenURI);

        emit TwinMinted(p.lockId, p.recipient, p.tokenId, p.tokenURI, p.originEid);
    }

    /// @notice Burn/lock dest twin and send unlock message back to Abstract vault.
    /// @dev Burns twin via collection minter role; home vault unlocks original.
    function unlockBack(bytes32 lockId, address recipient, bytes calldata options)
        external
        payable
        nonReentrant
    {
        TwinRecord storage rec = twins[lockId];
        if (!rec.active) revert TwinNotActive(lockId);
        if (twinCollection.ownerOf(rec.tokenId) != msg.sender) revert NotTwinOwner();

        uint32 originEid = rec.originEid;
        if (peers[originEid] == bytes32(0)) revert PeerNotSet(originEid);

        // Burn twin (dest-side lock/burn of twin)
        twinCollection.burn(rec.tokenId);
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

        // TODO: real _lzSend to Abstract NftLockVault
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
}
