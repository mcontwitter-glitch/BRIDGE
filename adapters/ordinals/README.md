# Bitcoin Ordinals adapter

Destination key `ordinals`, Bitcoin mainnet (signet via config). Request payload:
`{ dest:'ordinals', network:'mainnet', recipient:'bc1p…', collection:'0x…', tokenId, tokenURI, image, name, lockTxHash, srcChainId:2741 }`.
Implementation: `../../ordinals-delivery` (lock verification in `src/lock.js`). UI: `docs/assets/ordinals.js`.
