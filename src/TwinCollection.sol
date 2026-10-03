// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ITwinCollection} from "./interfaces/ITwinCollection.sol";

/// @notice One destination collection for one origin collection.
/// @dev Name and symbol can be corrected later by the admin. The minter holds MINTER_ROLE.
contract TwinCollection is ERC721, AccessControl, ITwinCollection {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    string private _nameOverride;
    string private _symbolOverride;
    mapping(uint256 => string) private _uris;

    constructor(string memory name_, string memory symbol_, address admin, address minter)
        ERC721(name_, symbol_)
    {
        _nameOverride = name_;
        _symbolOverride = symbol_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, minter);
    }

    function setNameAndSymbol(string calldata name_, string calldata symbol_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _nameOverride = name_;
        _symbolOverride = symbol_;
    }

    function name() public view override returns (string memory) {
        return _nameOverride;
    }

    function symbol() public view override returns (string memory) {
        return _symbolOverride;
    }

    function mintWithURI(address to, uint256 tokenId, string calldata uri)
        external
        onlyRole(MINTER_ROLE)
    {
        _safeMint(to, tokenId);
        _uris[tokenId] = uri;
    }

    function burn(uint256 tokenId) external onlyRole(MINTER_ROLE) {
        _burn(tokenId);
        delete _uris[tokenId];
    }

    function tokenURI(uint256 tokenId) public view override(ERC721, ITwinCollection) returns (string memory) {
        _requireOwned(tokenId);
        return _uris[tokenId];
    }

    function ownerOf(uint256 tokenId) public view override(ERC721, ITwinCollection) returns (address) {
        return super.ownerOf(tokenId);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
