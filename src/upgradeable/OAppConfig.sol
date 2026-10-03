// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ILayerZeroEndpointV2} from "../interfaces/ILayerZeroEndpointV2.sol";
import {ILayerZeroEndpointConfig} from "../interfaces/ILayerZeroEndpointConfig.sol";

/// @notice Shared owner-gated LayerZero delegate and ULN/executor config.
/// @dev Storage: Ownable._owner is slot 0. `endpoint` is the next slot.
abstract contract OAppConfig is Ownable {
    uint32 internal constant CONFIG_TYPE_EXECUTOR = 1;
    uint32 internal constant CONFIG_TYPE_ULN = 2;

    ILayerZeroEndpointV2 public endpoint;
    mapping(uint32 => bytes32) public peers;

    event DelegateSet(address indexed delegate);
    event PeerSet(uint32 indexed eid, bytes32 peer);
    event SendConfigSet(uint32 indexed eid, address indexed sendLib, address dvn, address executor);
    event ReceiveConfigSet(uint32 indexed eid, address indexed receiveLib, address dvn);

    function setPeer(uint32 eid, bytes32 peer) external onlyOwner {
        peers[eid] = peer;
        emit PeerSet(eid, peer);
    }

    /// @notice One transaction: peer, delegate, send ULN+executor, receive ULN.
    function configureRemote(
        uint32 remoteEid,
        bytes32 peer,
        address delegate,
        address sendLib,
        address receiveLib,
        uint64 sendConfirmations,
        uint64 recvConfirmations,
        address dvn,
        uint32 maxMessageSize,
        address executor_
    ) external onlyOwner {
        peers[remoteEid] = peer;
        emit PeerSet(remoteEid, peer);
        endpoint.setDelegate(delegate);
        emit DelegateSet(delegate);
        _setSendConfig(sendLib, remoteEid, sendConfirmations, dvn, maxMessageSize, executor_);
        _setReceiveConfig(receiveLib, remoteEid, recvConfirmations, dvn);
    }

    function setDelegate(address delegate) external onlyOwner {
        endpoint.setDelegate(delegate);
        emit DelegateSet(delegate);
    }

    function lzDelegate() external view returns (address) {
        return ILayerZeroEndpointConfig(address(endpoint)).delegates(address(this));
    }

    /// @notice Set send ULN (1 required DVN, 0 optional) and executor for one destination.
    function setSendConfig(
        address sendLib,
        uint32 eid,
        uint64 confirmations,
        address dvn,
        uint32 maxMessageSize,
        address executor_
    ) external onlyOwner {
        _setSendConfig(sendLib, eid, confirmations, dvn, maxMessageSize, executor_);
    }

    function _setSendConfig(
        address sendLib,
        uint32 eid,
        uint64 confirmations,
        address dvn,
        uint32 maxMessageSize,
        address executor_
    ) internal {
        ILayerZeroEndpointConfig.SetConfigParam[] memory params =
            new ILayerZeroEndpointConfig.SetConfigParam[](2);
        params[0] = ILayerZeroEndpointConfig.SetConfigParam({
            eid: eid,
            configType: CONFIG_TYPE_ULN,
            config: _ulnConfig(confirmations, dvn)
        });
        params[1] = ILayerZeroEndpointConfig.SetConfigParam({
            eid: eid,
            configType: CONFIG_TYPE_EXECUTOR,
            config: abi.encode(
                ILayerZeroEndpointConfig.ExecutorConfig({maxMessageSize: maxMessageSize, executor: executor_})
            )
        });
        ILayerZeroEndpointConfig(address(endpoint)).setConfig(address(this), sendLib, params);
        emit SendConfigSet(eid, sendLib, dvn, executor_);
    }

    /// @notice Set receive ULN (1 required DVN, 0 optional) for one source eid.
    function setReceiveConfig(address receiveLib, uint32 eid, uint64 confirmations, address dvn)
        external
        onlyOwner
    {
        _setReceiveConfig(receiveLib, eid, confirmations, dvn);
    }

    function _setReceiveConfig(address receiveLib, uint32 eid, uint64 confirmations, address dvn) internal {
        ILayerZeroEndpointConfig.SetConfigParam[] memory params =
            new ILayerZeroEndpointConfig.SetConfigParam[](1);
        params[0] = ILayerZeroEndpointConfig.SetConfigParam({
            eid: eid,
            configType: CONFIG_TYPE_ULN,
            config: _ulnConfig(confirmations, dvn)
        });
        ILayerZeroEndpointConfig(address(endpoint)).setConfig(address(this), receiveLib, params);
        emit ReceiveConfigSet(eid, receiveLib, dvn);
    }

    function _ulnConfig(uint64 confirmations, address dvn) internal pure returns (bytes memory) {
        address[] memory required = new address[](1);
        required[0] = dvn;
        address[] memory optional = new address[](0);
        return abi.encode(
            ILayerZeroEndpointConfig.UlnConfig({
                confirmations: confirmations,
                requiredDVNCount: 1,
                optionalDVNCount: 0,
                optionalDVNThreshold: 0,
                requiredDVNs: required,
                optionalDVNs: optional
            })
        );
    }
}
