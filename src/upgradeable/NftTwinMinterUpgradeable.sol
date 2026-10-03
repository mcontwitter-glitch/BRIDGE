// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {ILayerZeroEndpointV2} from "../interfaces/ILayerZeroEndpointV2.sol";
import {IOAppReceiver} from "../interfaces/IOAppReceiver.sol";
import {ITwinCollection} from "../interfaces/ITwinCollection.sol";
import {TwinCollection} from "../TwinCollection.sol";
import {SwapPayload} from "../libraries/SwapPayload.sol";
import {OAppConfig} from "./OAppConfig.sol";

/// @title NftTwinMinterUpgradeable
/// @notice UUPS minter. The first lock for an origin collection creates "Twin <origin>".
contract NftTwinMinterUpgradeable is Initializable, OAppConfig, UUPSUpgradeable, IOAppReceiver {
    uint256 private _reentrancyStatus;
    uint32 public localEid;

    mapping(address => address) public collectionOf;
    mapping(bytes32 => bool) public minted;
    mapping(bytes32 => TwinRecord) public twins;

    struct TwinRecord {
        address originCollection;
        uint256 tokenId;
        address holder;
        uint32 originEid;
        bool active;
    }

    uint256[40] private __gap;

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
    error Reentrancy();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() Ownable(msg.sender) {
        _disableInitializers();
    }

    function initialize(address endpoint_, uint32 localEid_, address owner_) external initializer {
        if (owner_ == address(0)) revert OwnableInvalidOwner(address(0));
        _transferOwnership(owner_);
        endpoint = ILayerZeroEndpointV2(endpoint_);
        localEid = localEid_;
        _reentrancyStatus = 1;
        endpoint.setDelegate(owner_);
        emit DelegateSet(owner_);
    }

    function prepareCollection(address origin, address twin) external onlyOwner {
        collectionOf[origin] = twin;
        emit CollectionPrepared(origin, twin);
    }

    function lzReceive(
        uint32 srcEid,
        bytes32 sender,
        bytes32,
        bytes calldata message,
        bytes calldata
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

        bytes memory message = SwapPayload.encodeUnlockBurn(
            SwapPayload.UnlockBurnPayload({
                action: SwapPayload.ACTION_UNLOCK_BURN,
                collection: rec.originCollection,
                tokenId: rec.tokenId,
                recipient: recipient,
                destEid: localEid,
                lockId: lockId
            })
        );

        ILayerZeroEndpointV2.MessagingReceipt memory receipt = endpoint.send{value: msg.value}(
            ILayerZeroEndpointV2.MessagingParams({
                dstEid: originEid,
                receiver: peers[originEid],
                message: message,
                options: options,
                payInLzToken: false
            }),
            msg.sender
        );

        emit TwinBurnedForUnlock(lockId, rec.tokenId, msg.sender);
        emit MessageSent(lockId, originEid, receipt.guid);
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

    function _authorizeUpgrade(address) internal override onlyOwner {}

    modifier nonReentrant() {
        if (_reentrancyStatus == 2) revert Reentrancy();
        _reentrancyStatus = 2;
        _;
        _reentrancyStatus = 1;
    }
}
