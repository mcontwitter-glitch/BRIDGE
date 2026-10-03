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
/// @dev A later upgrade can add Solana and Sui wiring without changing this proxy address.
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

    uint256[40] private __gap;

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
        IERC721(collection).safeTransferFrom(msg.sender, address(this), tokenId);

        lockId = keccak256(abi.encodePacked(collection, tokenId, msg.sender, destEid, block.number, localEid));
        locks[lockId] = LockRecord({
            collection: collection,
            tokenId: tokenId,
            owner: msg.sender,
            destEid: destEid,
            tokenURI: uri,
            active: true
        });
        activeLockId[collection][tokenId] = lockId;

        bytes memory message = SwapPayload.encodeLockMint(
            SwapPayload.LockMintPayload({
                action: SwapPayload.ACTION_LOCK_MINT,
                collection: collection,
                tokenId: tokenId,
                tokenURI: uri,
                recipient: recipient,
                originEid: localEid,
                lockId: lockId
            })
        );

        ILayerZeroEndpointV2.MessagingReceipt memory receipt = endpoint.send{value: msg.value}(
            ILayerZeroEndpointV2.MessagingParams({
                dstEid: destEid,
                receiver: peers[destEid],
                message: message,
                options: options,
                payInLzToken: false
            }),
            msg.sender
        );

        emit NftLocked(lockId, collection, tokenId, msg.sender, destEid, uri, recipient);
        emit MessageSent(lockId, destEid, receipt.guid);
    }

    /// @notice Present so a Solana peer can be configured later without redeploying the proxy.
    function lockAndSwapSolana(
        address collection,
        uint256 tokenId,
        uint32 destEid,
        bytes32 solanaRecipient,
        bytes calldata options
    ) external payable nonReentrant returns (bytes32 lockId) {
        if (destEid != ChainIds.SOLANA_EID) revert NotSolanaDestination(destEid);
        if (solanaRecipient == bytes32(0)) revert SolanaRecipientZero();
        if (peers[destEid] == bytes32(0)) revert PeerNotSet(destEid);
        if (activeLockId[collection][tokenId] != bytes32(0)) {
            revert AlreadyLocked(collection, tokenId);
        }
        if (IERC721(collection).ownerOf(tokenId) != msg.sender) revert NotTokenOwner();

        string memory uri = _tokenURI(collection, tokenId);
        IERC721(collection).safeTransferFrom(msg.sender, address(this), tokenId);

        lockId = keccak256(abi.encodePacked(collection, tokenId, msg.sender, destEid, block.number, localEid));
        locks[lockId] = LockRecord({
            collection: collection,
            tokenId: tokenId,
            owner: msg.sender,
            destEid: destEid,
            tokenURI: uri,
            active: true
        });
        activeLockId[collection][tokenId] = lockId;

        bytes memory message = SwapPayload.encodeLockMintSolana(
            SwapPayload.LockMintSolanaPayload({
                action: SwapPayload.ACTION_LOCK_MINT,
                collection: collection,
                tokenId: tokenId,
                tokenURI: uri,
                solanaRecipient: solanaRecipient,
                originEid: localEid,
                lockId: lockId
            })
        );

        ILayerZeroEndpointV2.MessagingReceipt memory receipt = endpoint.send{value: msg.value}(
            ILayerZeroEndpointV2.MessagingParams({
                dstEid: destEid,
                receiver: peers[destEid],
                message: message,
                options: options,
                payInLzToken: false
            }),
            msg.sender
        );

        emit SolanaNftLocked(lockId, solanaRecipient, destEid);
        emit MessageSent(lockId, destEid, receipt.guid);
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
        if (action != SwapPayload.ACTION_UNLOCK_BURN) revert BadAction(action);

        SwapPayload.UnlockBurnPayload memory p = SwapPayload.decodeUnlockBurn(message);
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

    function _unlock(bytes32 lockId, address recipient) internal {
        LockRecord storage rec = locks[lockId];
        if (!rec.active) revert LockNotActive(lockId);
        rec.active = false;
        delete activeLockId[rec.collection][rec.tokenId];
        IERC721(rec.collection).safeTransferFrom(address(this), recipient, rec.tokenId);
        emit NftUnlocked(lockId, rec.collection, rec.tokenId, recipient);
    }

    function _tokenURI(address collection, uint256 tokenId) internal view returns (string memory) {
        (bool ok, bytes memory data) = collection.staticcall(abi.encodeWithSignature("tokenURI(uint256)", tokenId));
        require(ok && data.length > 0, "tokenURI failed");
        return abi.decode(data, (string));
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    modifier nonReentrant() {
        if (_reentrancyStatus == 2) revert Reentrancy();
        _reentrancyStatus = 2;
        _;
        _reentrancyStatus = 1;
    }
}
