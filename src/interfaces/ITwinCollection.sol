// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Dest-chain collection that grants MINTER_ROLE to NftTwinMinter.
interface ITwinCollection {
    function mintWithURI(address to, uint256 tokenId, string calldata tokenURI) external;
    function burn(uint256 tokenId) external;
    function ownerOf(uint256 tokenId) external view returns (address);
    function tokenURI(uint256 tokenId) external view returns (string memory);
}
