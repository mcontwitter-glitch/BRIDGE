# Ordinals delivery (Bitcoin mainnet, pilot)

Destination adapter for **Bitcoin Ordinals** on bridge.bigfoot404.biz. Network is one switch:
`ORDINALS_NETWORK=mainnet` (default) or `signet` for tests. Front end: `window.BRIDGE_ORDINALS_NETWORK`.

Flow: user locks the NFT in the Abstract NftLockVault (`prepayPush` + `safeTransferFrom` with push data, from
`docs/assets/ordinals.js`) → `POST /api/ordinals/deliveries {dest, network, recipient, collection, tokenId, lockTxHash}`
→ `src/lock.js` verifies on Abstract (keyless RPC): receipt success, ≥12 confirmations, `NftLocked` from the vault for
that collection/tokenId, `destEid == ORDINALS_LOCK_DEST_EID`, lock still `active`, lockTx/lockId never used before
→ Taproot commit/reveal inscription (image ≤60 KB else metadata JSON, CBOR metadata) → reveal pays 10,000 sats
postage + inscription to the user's bc1p. Status: `pending` → `inscribed` → `delivered` (reveal confirmed) / `failed`.
Fees: mempool.space `halfHourFee`.

```
npm install
npm run keygen     # ~/.bridge-ordinals/mainnet.key (chmod 600); prints only the public bc1p funding address
npm run estimate   # dry run: fee estimate + funding check (signs/broadcasts nothing)
npm test
npm start          # 127.0.0.1:8790
```
Key: `ORDINALS_INSCRIBER_WIF` or `ORDINALS_INSCRIBER_KEY_FILE` (default `~/.bridge-ordinals/<network>.key`).

Env: `ABSTRACT_RPC`, `ORDINALS_LOCK_VAULT` (default 0xe81D…99e5), `ORDINALS_LOCK_DEST_EID` (**required; unset →
every request rejected 503**), `ORDINALS_LOCK_MIN_CONF` (12), `ORDINALS_SKIP_LOCK_CHECK=1` (signet only).

Front-end switches (set in docs/index.html before ordinals.js): `BRIDGE_ORDINALS_URL`, `BRIDGE_ORDINALS_LOCK_EID`,
optional `BRIDGE_ORDINALS_LZ_OPTIONS`. Until both URL and EID are set the button is disabled before any lock.

## Open: the vault has no Bitcoin destination
`NftLockVault` only locks toward a LayerZero `destEid` with a configured peer and immediately sends a LZ message
that mints a twin there (EVM recipient required). There is no Bitcoin/Ordinals eid. Before going live pick one:
(a) add an Ordinals lock path to the vault (upgrade: lock without LZ send, emit an event with the bc1p recipient), or
(b) wire a dedicated "Ordinals" peer eid whose receiver mints nothing. Then set `ORDINALS_LOCK_DEST_EID` /
`BRIDGE_ORDINALS_LOCK_EID` and adjust `src/lock.js` if the event changes.
