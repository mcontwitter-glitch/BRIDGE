# Bitcoin Ordinals adapter

Destination key `ordinals`. Request payload (same `recipient` field as Solana/Sui):
`{ dest:'ordinals', network:'signet', recipient:'tb1p…', collection, tokenId, tokenURI, image, name, lockTxHash, lockId, srcChainId, test:true }`.
Implementation: `../../ordinals-delivery` (signet test only, mainnet hard-blocked). UI: `docs/assets/ordinals.js`.
