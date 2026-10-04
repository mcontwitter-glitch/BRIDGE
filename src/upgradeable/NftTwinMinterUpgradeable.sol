// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {ILayerZeroEndpointV2} from "../interfaces/ILayerZeroEndpointV2.sol";
import {IOAppReceiver} from "../interfaces/IOAppReceiver.sol";
import {ITwinCollection} from "../interfaces/ITwinCollection.sol";
import {TwinCollection} from "../TwinCollection.sol";
import {SwapPayload} from "../libraries/SwapPayload.sol";
import {OAppConfig} from "./OAppConfig.sol";

/// @title NftTwinMinterUpgradeable
/// @notice UUPS minter. The first lock for an origin collection creates "Twin <origin>".
/// @dev Push-only unlock. The holder prepays the LayerZero fee, then safeTransferFrom the
///      twin into this minter. onERC721Received burns the twin and messages Abstract so the
///      vault releases the original to that same wallet. This contract does not pull.
///      Storage: slots 0-7 and the first 39 gap slots match the previous implementation.
///      `pushCredit` occupies the former last gap slot (47). Peers, endpoint, owner,
///      delegate, and localEid are untouched by an upgrade.
contract NftTwinMinterUpgradeable is Initializable, OAppConfig, UUPSUpgradeable, IERC721Receiver, IOAppReceiver {
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

    /// @dev Shrunk by one slot so `pushCredit` can be appended without shifting 0-7.
    uint256[39] private __gap;

    /// @dev depositor => twin collection => tokenId => prepaid native fee. Slot 47.
    mapping(address => mapping(address => mapping(uint256 => uint256))) public pushCredit;

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
    event PushPrepaid(address indexed depositor, address indexed collection, uint256 indexed tokenId, uint256 amount);

    error PeerNotSet(uint32 eid);
    error NotPeer(uint32 srcEid, bytes32 sender);
    error AlreadyMinted(bytes32 lockId);
    error TwinNotActive(bytes32 lockId);
    error NotTwinOwner();
    error BadAction(uint8 action);
    error OnlyEndpoint();
    error CollectionUnset(address origin);
    error Reentrancy();
    error MinterDoesNotPull();
    error BridgeDataRequired();
    error BadPushData();
    error InsufficientPushFee();
    error NotHolding();
    error RecipientZero();

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

    /// @notice Kept so old calldata does not fall through the proxy. Does not pull or burn.
    function unlockBack(bytes32, address, bytes calldata) external payable {
        revert MinterDoesNotPull();
    }

    /// @notice Store the LayerZero fee before the holder transfers the twin in.
    /// @dev The following safeTransferFrom must use `from` equal to msg.sender here.
    function prepayPush(address collection, uint256 tokenId) external payable nonReentrant {
        if (msg.value == 0) revert InsufficientPushFee();
        pushCredit[msg.sender][collection][tokenId] += msg.value;
        emit PushPrepaid(msg.sender, collection, tokenId, msg.value);
    }

    function withdrawPushCredit(address collection, uint256 tokenId) external nonReentrant {
        uint256 amount = pushCredit[msg.sender][collection][tokenId];
        if (amount == 0) revert InsufficientPushFee();
        pushCredit[msg.sender][collection][tokenId] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "refund failed");
    }

    function quoteUnlock(bytes32 lockId, address recipient, bytes calldata options)
        external
        view
        returns (ILayerZeroEndpointV2.MessagingFee memory fee)
    {
        TwinRecord storage rec = twins[lockId];
        if (!rec.active) revert TwinNotActive(lockId);
        if (recipient == address(0)) revert RecipientZero();
        uint32 originEid = rec.originEid;
        if (peers[originEid] == bytes32(0)) revert PeerNotSet(originEid);
        return endpoint.quote(
            ILayerZeroEndpointV2.MessagingParams({
                dstEid: originEid,
                receiver: peers[originEid],
                message: _encodeUnlock(rec.originCollection, rec.tokenId, recipient, lockId),
                options: options,
                payInLzToken: false
            }),
            address(this)
        );
    }

    /// @dev Push payload: abi.encode(bytes32 lockId, bytes options).
    ///      The original is released to `from`, the wallet that sent the twin.
    function onERC721Received(address, address from, uint256 tokenId, bytes calldata data)
        external
        nonReentrant
        returns (bytes4)
    {
        if (data.length == 0) revert BridgeDataRequired();
        _unlockPushed(msg.sender, from, tokenId, data);
        return IERC721Receiver.onERC721Received.selector;
    }

    function _unlockPushed(address collection, address from, uint256 tokenId, bytes calldata data) internal {
        if (from == address(0) || from == address(this)) revert BadPushData();
        (bytes32 lockId, bytes memory options) = abi.decode(data, (bytes32, bytes));
        _checkPush(collection, tokenId, lockId);
        uint256 fee = _takeCredit(from, collection, tokenId);
        _burnAndSend(collection, from, tokenId, lockId, options, fee);
    }

    function _checkPush(address collection, uint256 tokenId, bytes32 lockId) internal view {
        TwinRecord storage rec = twins[lockId];
        if (!rec.active) revert TwinNotActive(lockId);
        if (rec.tokenId != tokenId) revert BadPushData();
        address twinAddr = collectionOf[rec.originCollection];
        if (twinAddr == address(0)) revert CollectionUnset(rec.originCollection);
        if (twinAddr != collection) revert BadPushData();
        if (peers[rec.originEid] == bytes32(0)) revert PeerNotSet(rec.originEid);
        if (ITwinCollection(collection).ownerOf(tokenId) != address(this)) revert NotHolding();
    }

    function _takeCredit(address from, address collection, uint256 tokenId) internal returns (uint256 fee) {
        uint256 prepaid = pushCredit[from][collection][tokenId];
        fee = prepaid + msg.value;
        if (fee == 0) revert InsufficientPushFee();
        if (prepaid != 0) pushCredit[from][collection][tokenId] = 0;
    }

    function _burnAndSend(
        address collection,
        address from,
        uint256 tokenId,
        bytes32 lockId,
        bytes memory options,
        uint256 fee
    ) internal {
        TwinRecord storage rec = twins[lockId];
        ITwinCollection(collection).burn(tokenId);
        rec.active = false;
        uint32 originEid = rec.originEid;
        bytes32 peer = peers[originEid];
        bytes memory message = _encodeUnlock(rec.originCollection, tokenId, from, lockId);
        bytes32 guid = endpoint.send{value: fee}(
            ILayerZeroEndpointV2.MessagingParams({
                dstEid: originEid,
                receiver: peer,
                message: message,
                options: options,
                payInLzToken: false
            }),
            from
        ).guid;
        emit TwinBurnedForUnlock(lockId, tokenId, from);
        emit MessageSent(lockId, originEid, guid);
    }

    function _encodeUnlock(address originCollection, uint256 tokenId, address recipient, bytes32 lockId)
        internal
        view
        returns (bytes memory)
    {
        if (recipient == address(0)) revert RecipientZero();
        return SwapPayload.encodeUnlockBurn(
            SwapPayload.UnlockBurnPayload({
                action: SwapPayload.ACTION_UNLOCK_BURN,
                collection: originCollection,
                tokenId: tokenId,
                recipient: recipient,
                destEid: localEid,
                lockId: lockId
            })
        );
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
