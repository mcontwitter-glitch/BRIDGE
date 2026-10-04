// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {ILayerZeroEndpointV2} from "../interfaces/ILayerZeroEndpointV2.sol";
import {IOAppReceiver} from "../interfaces/IOAppReceiver.sol";
import {SwapPayload} from "../libraries/SwapPayload.sol";
import {ChainIds} from "../libraries/ChainIds.sol";
import {OAppConfig} from "./OAppConfig.sol";

/// @title NftLockVaultUpgradeable
/// @notice UUPS vault. Abstract must be compiled with evm_version paris (no PUSH0).
/// @dev Push-only custody. The holder calls the collection's safeTransferFrom into this
///      vault. This contract never calls transferFrom/safeTransferFrom to pull a token.
///      Limit Break's transfer validator (CallerOrFromMustBeWhitelisted) rejects the vault
///      as an operator caller. Do not whitelist the vault.
///      Storage: slots 0-6 and the first 39 gap slots match the previous implementation.
///      `pushCredit` occupies the former last gap slot (46). Peers, endpoint, owner,
///      delegate, and localEid are untouched by an upgrade.
///      `allowInitializePath` lets EndpointV2 verify the first return message on a path
///      whose peer is already set (destination twin). No new storage.
contract NftLockVaultUpgradeable is Initializable, OAppConfig, UUPSUpgradeable, IERC721Receiver, IOAppReceiver {
    using SwapPayload for SwapPayload.LockMintPayload;
    using SwapPayload for SwapPayload.UnlockBurnPayload;

    /// @dev slot after Ownable._owner (0) and OAppConfig.endpoint (1)
    uint256 private _reentrancyStatus;
    uint32 public localEid;

    struct LockRecord {
        address collection;
        uint256 tokenId;
        address owner;
        uint32 destEid;
        string tokenURI;
        bool active;
    }

    mapping(bytes32 => LockRecord) public locks;
    mapping(address => mapping(uint256 => bytes32)) public activeLockId;

    /// @dev Shrunk by one slot so `pushCredit` can be appended without shifting 0-6.
    uint256[39] private __gap;

    /// @dev depositor => collection => tokenId => prepaid native fee. Slot 46.
    mapping(address => mapping(address => mapping(uint256 => uint256))) public pushCredit;

    event NftLocked(
        bytes32 indexed lockId,
        address indexed collection,
        uint256 indexed tokenId,
        address owner,
        uint32 destEid,
        string tokenURI,
        address recipient
    );
    event NftUnlocked(bytes32 indexed lockId, address indexed collection, uint256 indexed tokenId, address recipient);
    event MessageSent(bytes32 indexed lockId, uint32 destEid, bytes32 guid);
    event SolanaNftLocked(bytes32 indexed lockId, bytes32 indexed solanaRecipient, uint32 destEid);
    event PushPrepaid(address indexed depositor, address indexed collection, uint256 indexed tokenId, uint256 amount);

    error PeerNotSet(uint32 eid);
    error NotPeer(uint32 srcEid, bytes32 sender);
    error AlreadyLocked(address collection, uint256 tokenId);
    error LockNotActive(bytes32 lockId);
    error NotTokenOwner();
    error BadAction(uint8 action);
    error OnlyEndpoint();
    error NotSolanaDestination(uint32 eid);
    error SolanaRecipientZero();
    error Reentrancy();
    error VaultDoesNotPull();
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

    /// @notice Kept so old calldata does not fall through the proxy. Does not pull.
    function lockAndSwap(address, uint256, uint32, address, bytes calldata)
        external
        payable
        returns (bytes32)
    {
        revert VaultDoesNotPull();
    }

    /// @notice Kept so old calldata does not fall through the proxy. Does not pull.
    function lockAndSwapSolana(address, uint256, uint32, bytes32, bytes calldata)
        external
        payable
        returns (bytes32)
    {
        revert VaultDoesNotPull();
    }

    /// @notice Store the LayerZero fee before the holder transfers the NFT in.
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

    /// @dev LayerZero EndpointV2 origin. Field order is the wire ABI. Not stored.
    struct LzOrigin {
        uint32 srcEid;
        bytes32 sender;
        uint64 nonce;
    }

    function lzReceive(
        uint32 srcEid,
        bytes32 sender,
        bytes32 guid,
        bytes calldata message,
        bytes calldata
    ) external payable override nonReentrant {
        if (msg.sender != address(endpoint)) revert OnlyEndpoint();
        _receiveUnlock(srcEid, sender, guid, message);
    }

    /// @notice EndpointV2 delivery. Selector matches ILayerZeroReceiver.lzReceive.
    function lzReceive(
        LzOrigin calldata origin,
        bytes32 guid,
        bytes calldata message,
        address,
        bytes calldata
    ) external payable nonReentrant {
        if (msg.sender != address(endpoint)) revert OnlyEndpoint();
        _receiveUnlock(origin.srcEid, origin.sender, guid, message);
    }

    /// @notice First message on a path may be verified only if that sender is the configured peer.
    /// @dev True only when `origin.sender == peers[origin.srcEid]` and the sender is non-zero.
    function allowInitializePath(LzOrigin calldata origin) external view returns (bool) {
        return origin.sender != bytes32(0) && origin.sender == peers[origin.srcEid];
    }

    /// @notice Unordered channel. Executors treat 0 as "do not gate on nonce".
    function nextNonce(uint32, bytes32) external pure returns (uint64) {
        return 0;
    }

    function _receiveUnlock(uint32 srcEid, bytes32 sender, bytes32, bytes calldata message) internal {
        if (peers[srcEid] != sender) revert NotPeer(srcEid, sender);

        uint8 action = SwapPayload.peekAction(message);
        if (action != SwapPayload.ACTION_UNLOCK_BURN) revert BadAction(action);

        SwapPayload.UnlockBurnPayload memory p = SwapPayload.decodeUnlockBurn(message);
        // Buyer is the address in the return message, not the original bridger.
        _unlock(p.lockId, p.recipient);
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
        bytes memory message = SwapPayload.encodeLockMint(
            SwapPayload.LockMintPayload({
                action: SwapPayload.ACTION_LOCK_MINT,
                collection: collection,
                tokenId: tokenId,
                tokenURI: uri,
                recipient: recipient,
                originEid: localEid,
                lockId: bytes32(0)
            })
        );
        return endpoint.quote(
            ILayerZeroEndpointV2.MessagingParams({
                dstEid: destEid,
                receiver: peers[destEid],
                message: message,
                options: options,
                payInLzToken: false
            }),
            address(this)
        );
    }

    /// @dev Push payload: abi.encode(uint32 destEid, bytes32 recipient, bool solana, bytes options).
    ///      EVM recipient is the address left-padded to bytes32. solana must be false unless destEid is Solana.
    function onERC721Received(address, address from, uint256 tokenId, bytes calldata data)
        external
        nonReentrant
        returns (bytes4)
    {
        if (data.length == 0) revert BridgeDataRequired();
        _lockPushed(msg.sender, from, tokenId, data);
        return IERC721Receiver.onERC721Received.selector;
    }

    function _lockPushed(address collection, address from, uint256 tokenId, bytes calldata data) internal {
        if (from == address(0) || from == address(this)) revert BadPushData();
        if (IERC721(collection).ownerOf(tokenId) != address(this)) revert NotHolding();
        bytes32 lockId = _storeLock(collection, from, tokenId, data);
        _payAndSend(lockId, from, data);
    }

    function _storeLock(address collection, address from, uint256 tokenId, bytes calldata data)
        internal
        returns (bytes32 lockId)
    {
        (uint32 destEid,,,) = abi.decode(data, (uint32, bytes32, bool, bytes));
        if (peers[destEid] == bytes32(0)) revert PeerNotSet(destEid);
        if (activeLockId[collection][tokenId] != bytes32(0)) revert AlreadyLocked(collection, tokenId);
        lockId = keccak256(abi.encodePacked(collection, tokenId, from, destEid, block.number, localEid));
        locks[lockId] = LockRecord({
            collection: collection,
            tokenId: tokenId,
            owner: from,
            destEid: destEid,
            tokenURI: _tokenURI(collection, tokenId),
            active: true
        });
        activeLockId[collection][tokenId] = lockId;
    }

    function _payAndSend(bytes32 lockId, address from, bytes calldata data) internal {
        LockRecord memory rec = locks[lockId];
        (, bytes32 recipientRaw, bool solana, bytes memory options) =
            abi.decode(data, (uint32, bytes32, bool, bytes));
        uint256 prepaid = pushCredit[from][rec.collection][rec.tokenId];
        uint256 fee = prepaid + msg.value;
        if (fee == 0) revert InsufficientPushFee();
        if (prepaid != 0) pushCredit[from][rec.collection][rec.tokenId] = 0;
        _dispatch(lockId, recipientRaw, solana, options, fee, from);
    }

    function _dispatch(
        bytes32 lockId,
        bytes32 recipientRaw,
        bool solana,
        bytes memory options,
        uint256 fee,
        address refundTo
    ) internal {
        LockRecord memory rec = locks[lockId];
        bytes memory message;
        if (rec.destEid == ChainIds.SOLANA_EID) {
            if (recipientRaw == bytes32(0)) revert SolanaRecipientZero();
            message = _encodeSolana(rec, recipientRaw, lockId);
            emit SolanaNftLocked(lockId, recipientRaw, rec.destEid);
        } else {
            if (solana) revert NotSolanaDestination(rec.destEid);
            address recipient = address(uint160(uint256(recipientRaw)));
            if (recipient == address(0)) revert RecipientZero();
            message = _encodeEvm(rec, recipient, lockId);
            emit NftLocked(lockId, rec.collection, rec.tokenId, rec.owner, rec.destEid, rec.tokenURI, recipient);
        }
        ILayerZeroEndpointV2.MessagingReceipt memory receipt = endpoint.send{value: fee}(
            ILayerZeroEndpointV2.MessagingParams({
                dstEid: rec.destEid,
                receiver: peers[rec.destEid],
                message: message,
                options: options,
                payInLzToken: false
            }),
            refundTo
        );
        emit MessageSent(lockId, rec.destEid, receipt.guid);
    }

    function _encodeEvm(LockRecord memory rec, address recipient, bytes32 lockId) internal view returns (bytes memory) {
        return SwapPayload.encodeLockMint(
            SwapPayload.LockMintPayload({
                action: SwapPayload.ACTION_LOCK_MINT,
                collection: rec.collection,
                tokenId: rec.tokenId,
                tokenURI: rec.tokenURI,
                recipient: recipient,
                originEid: localEid,
                lockId: lockId
            })
        );
    }

    function _encodeSolana(LockRecord memory rec, bytes32 recipientRaw, bytes32 lockId)
        internal
        view
        returns (bytes memory)
    {
        return SwapPayload.encodeLockMintSolana(
            SwapPayload.LockMintSolanaPayload({
                action: SwapPayload.ACTION_LOCK_MINT,
                collection: rec.collection,
                tokenId: rec.tokenId,
                tokenURI: rec.tokenURI,
                solanaRecipient: recipientRaw,
                originEid: localEid,
                lockId: lockId
            })
        );
    }

    function _unlock(bytes32 lockId, address recipient) internal {
        LockRecord storage rec = locks[lockId];
        if (!rec.active) revert LockNotActive(lockId);
        if (recipient == address(0)) revert RecipientZero();
        rec.active = false;
        delete activeLockId[rec.collection][rec.tokenId];
        _releaseOriginal(rec.collection, recipient, rec.tokenId);
        emit NftUnlocked(lockId, rec.collection, rec.tokenId, recipient);
    }

    /// @notice Send the escrowed original to `buyer`.
    /// @dev `buyer` is the recipient in the unlock message, not `locks[lockId].owner`.
    ///      The transfer is owner-initiated: `from` is this vault, which owns the token,
    ///      so the validator sees caller == from. A pull (caller != from) is what reverts
    ///      with CallerOrFromMustBeWhitelisted.
    ///
    ///      This can still revert. RulesetWhitelist blocks a contract caller when Block All
    ///      OTC is on (CallerOrFromMustBeWhitelisted) or when OTC for smart wallets is off
    ///      (OTCNotAllowedForSmartWallets), because this vault has code and is not
    ///      whitelisted. Do not whitelist. Owner-as-from is the best send available.
    function _releaseOriginal(address collection, address buyer, uint256 tokenId) internal {
        IERC721(collection).transferFrom(address(this), buyer, tokenId);
    }

    function _tokenURI(address collection, uint256 tokenId) internal view returns (string memory) {
        (bool ok, bytes memory data) = collection.staticcall(abi.encodeWithSignature("tokenURI(uint256)", tokenId));
        require(ok && data.length > 0, "tokenURI failed");
        return abi.decode(data, (string));
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    modifier nonReentrant() {
        if (_reentrancyStatus == 2) revert Reentrancy();
        _reentrancyStatus = 2;
        _;
        _reentrancyStatus = 1;
    }
}
