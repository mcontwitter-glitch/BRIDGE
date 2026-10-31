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

## Cost cap and delivery modes (Phase 3/4)

- **Modes** (`ORDINALS_MODE`): `recursive` (default), `image` (fallback: NFT image shrunk to WebP/AVIF/palette PNG ≤ 20 KB), `metadata` (compact JSON).
- **Recursive (p5.js)**: each item is a < 600 B `text/html;charset=utf-8` inscription that loads the canonical p5.js v1.11.2
  inscription (`13a5c8e41dfc110514b450b2f15317988c0aaf276d3dbdcca9aa3c7d0b2188a7i0`, reused, never re-inscribed) and a shared
  renderer by `/content/<id>`, then draws the LIL FOOTS trait layers in order. tokenId + trait indices are in the HTML; the trait names are in the CBOR metadata.
- **One-time setup**: `npm run setup:collection` (DRY RUN: builds 97 deduped 480 px WebP layers from the original trait PNGs and prints the cost).
  `-- --broadcast` inscribes the layers + renderer (resumable) and writes `collections/lil-foots.manifest.json`. Until that manifest exists, the service answers
  **503 "collection setup not inscribed"** and inscribes nothing, and the page refuses before any lock.
- **Hard cap**: the live cost (mempool.space fee rate × `/v1/prices` BTC/USD) is checked before signing. It must be under $20 and at most $18 (`ORDINALS_MARGIN_USD`),
  with an optional `ORDINALS_MAX_FEE_RATE`. Otherwise the delivery stays `queued` ("Waiting for lower Bitcoin fees") and is retried every `ORDINALS_RETRY_MS`.
- `GET /api/ordinals/estimate` returns the USD cost per mode plus the setup cost. `npm run estimate [image]` prints the same.

## Failure recovery

- **Reveal failure**: the commit and reveal are both signed, and their hex is written to the delivery record (status `revealing`) *before* the commit is broadcast.
  The retry loop (and server startup) re-broadcasts the stored commit, which is a no-op if already known, and then the reveal. After `ORDINALS_MAX_REVEAL_ATTEMPTS` (default 6) failures with a confirmed commit,
  the commit output is swept back to the inscriber wallet by key path (`sweepTxid` recorded, status `sweeping` until it broadcasts), and the delivery is re-queued for a fresh inscription.
  Nothing is dropped: every state keeps the signed hex needed to finish. `setup:collection --broadcast` resumes pending reveals the same way (`manifest.pending`).
- **Underfunded wallet**: the delivery is `queued` with "Inscriber wallet needs funding" (nothing signed) and retried on the same 10-minute loop.

## Cloudflare Worker
`worker/` bundles this service for Cloudflare Workers. It uses a Durable Object store and a cron trigger every 10 minutes. Collection setup stays a local CLI. To build it, run `cd worker && npm test && npm run dry-run`. Go-live steps are in `../GO_LIVE.md`.
