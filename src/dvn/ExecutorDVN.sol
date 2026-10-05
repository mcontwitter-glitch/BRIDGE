// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ILayerZeroDVN, IReceiveUln302} from "./ILayerZeroDVN.sol";

/// @title ExecutorDVN
/// @notice DVN whose attestation is the packet hash the pathway MessageLib already produced.
/// @dev assignJob is called by the send MessageLib and is the only writer of `packetHash`.
///      verifyAndCommit hashes the packet the same way SendUln302 does (keccak256 of the bytes
///      after the 81-byte header). If this chain's MessageLib already recorded that header, the
///      hash must match. A normal wallet may present the packet only with a signature from `signer`
///      over (srcEid, dstEid, payloadHash). The configured executor, or an ADMIN_ROLE holder on
///      that executor, may present a packet with an empty signature. Either path then calls
///      ReceiveUln302.verify, commitVerification, and EndpointV2.lzReceive.
///      ApeChain inbound nonces 1 and 2 stay skipped.
contract ExecutorDVN is ILayerZeroDVN {
    bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    uint32 internal constant APE_EID = 30312;
    uint256 internal constant HEADER_LEN = 81;
    address public immutable endpoint;
    address public immutable receiveUln;
    address public immutable executor;
    address public immutable owner;

    /// @notice Address whose signature lets a normal wallet deliver a recorded packet.
    address public signer;

    /// @dev keccak256(packetHeader) => payload hash supplied by the send MessageLib.
    mapping(bytes32 headerHash => bytes32 payloadHash) public packetHash;

    error ReceiveUlnZero();
    error EndpointZero();
    error ExecutorZero();
    error OwnerZero();
    error NotMessageLib();
    error NotOwner();
    error SignerZero();
    error BadPacket();
    error ForgedHash();
    error ProtectedNonce();
    error HashConflict();
    error MissingSignature();
    error BadSignature();
    error BadSigner();

    event JobAssigned(uint32 dstEid, bytes32 payloadHash, uint64 confirmations, address sender);
    event PayloadSubmitted(bytes32 payloadHash, uint64 confirmations);
    event SignerSet(address signer);

    constructor(address endpoint_, address receiveUln_, address executor_, address owner_, address signer_) {
        if (endpoint_ == address(0)) revert EndpointZero();
        if (receiveUln_ == address(0)) revert ReceiveUlnZero();
        if (executor_ == address(0)) revert ExecutorZero();
        if (owner_ == address(0)) revert OwnerZero();
        endpoint = endpoint_;
        receiveUln = receiveUln_;
        executor = executor_;
        owner = owner_;
        if (signer_ != address(0)) {
            signer = signer_;
            emit SignerSet(signer_);
        }
    }

    /// @notice Owner sets the address that signs recorded payload hashes. The key never sends a transaction.
    function setSigner(address next) external {
        if (msg.sender != owner) revert NotOwner();
        if (next == address(0)) revert SignerZero();
        signer = next;
        emit SignerSet(next);
    }

    /// @inheritdoc ILayerZeroDVN
    function assignJob(AssignJobParam calldata param, bytes calldata) external payable returns (uint256 fee) {
        if (!IEndpointView(endpoint).isSendLibrary(msg.sender)) revert NotMessageLib();
        if (IEndpointView(endpoint).getSendLibrary(param.sender, param.dstEid) != msg.sender) revert NotMessageLib();
        bytes32 key = keccak256(param.packetHeader);
        bytes32 existing = packetHash[key];
        if (existing != bytes32(0) && existing != param.payloadHash) revert HashConflict();
        packetHash[key] = param.payloadHash;
        emit JobAssigned(param.dstEid, param.payloadHash, param.confirmations, param.sender);
        return 0;
    }

    /// @inheritdoc ILayerZeroDVN
    function getFee(uint32, uint64, address, bytes calldata) external pure returns (uint256 fee) {
        return 0;
    }

    /// @notice Personal-sign digest over the payload hash the send library recorded.
    /// @dev inner = keccak256(abi.encode(srcEid, dstEid, payloadHash)). The signer signs that 32-byte hash.
    function relayDigest(uint32 srcEid, uint32 dstEid, bytes32 payloadHash) public pure returns (bytes32) {
        bytes32 inner = keccak256(abi.encode(srcEid, dstEid, payloadHash));
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", inner));
    }

    /// @notice Verify, commit, and deliver one packet.
    /// @dev `encodedPacket` is header || guid || message. `signature` is empty for the executor / ADMIN_ROLE
    ///      path. A normal wallet must pass a 65-byte signature from `signer` over this packet's
    ///      (srcEid, dstEid, payloadHash). A different packet does not recover to `signer`.
    function verifyAndCommit(bytes calldata encodedPacket, bytes calldata signature) external payable {
        if (encodedPacket.length < HEADER_LEN + 32) revert BadPacket();
        if (uint8(encodedPacket[0]) != 1) revert BadPacket();

        bytes calldata header = encodedPacket[:HEADER_LEN];
        uint64 nonce = uint64(bytes8(header[1:9]));
        uint32 srcEid = uint32(bytes4(header[9:13]));
        uint32 dstEid = uint32(bytes4(header[45:49]));
        if (dstEid != IEndpointView(endpoint).eid()) revert BadPacket();
        if (dstEid == APE_EID && (nonce == 1 || nonce == 2)) revert ProtectedNonce();

        bytes32 payloadHash = keccak256(encodedPacket[HEADER_LEN:]);
        bytes32 recorded = packetHash[keccak256(header)];
        if (recorded != bytes32(0) && recorded != payloadHash) revert ForgedHash();

        if (!_isExecutor(msg.sender)) {
            if (signature.length == 0) revert MissingSignature();
            if (_recover(relayDigest(srcEid, dstEid, payloadHash), signature) != signer) revert BadSigner();
        }

        address receiver = address(uint160(uint256(bytes32(header[49:81]))));
        bytes32 sender = bytes32(header[13:45]);
        uint64 confirmations = IReceiveUln302(receiveUln).getUlnConfig(receiver, srcEid).confirmations;
        IReceiveUln302(receiveUln).verify(header, payloadHash, confirmations);
        IReceiveUln302(receiveUln).commitVerification(header, payloadHash);

        bytes32 guid = bytes32(encodedPacket[HEADER_LEN:HEADER_LEN + 32]);
        bytes calldata message = encodedPacket[HEADER_LEN + 32:];
        IEndpointExec(endpoint).lzReceive{value: msg.value}(
            IEndpointExec.Origin({srcEid: srcEid, sender: sender, nonce: nonce}),
            receiver,
            guid,
            message,
            bytes("")
        );
        emit PayloadSubmitted(payloadHash, confirmations);
    }

    function _isExecutor(address caller) internal view returns (bool) {
        if (caller == executor) return true;
        return IExecutorRoles(executor).hasRole(ADMIN_ROLE, caller);
    }

    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        if (signature.length != 65) revert BadSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert BadSignature();
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        address recovered = ecrecover(digest, v, r, s);
        if (recovered == address(0)) revert BadSignature();
        return recovered;
    }
}

interface IEndpointView {
    function eid() external view returns (uint32);
    function isSendLibrary(address lib) external view returns (bool);
    function getSendLibrary(address sender, uint32 dstEid) external view returns (address lib);
}

interface IEndpointExec {
    struct Origin {
        uint32 srcEid;
        bytes32 sender;
        uint64 nonce;
    }

    function lzReceive(
        Origin calldata origin,
        address receiver,
        bytes32 guid,
        bytes calldata message,
        bytes calldata extraData
    ) external payable;
}

interface IExecutorRoles {
    function hasRole(bytes32 role, address account) external view returns (bool);
}
