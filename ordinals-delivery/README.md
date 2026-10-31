# Ordinals delivery (signet test)

Destination adapter for **Bitcoin Ordinals** on Bridge.bigfoot404.biz. `mainnet:false` in `src/config.js`
hard-blocks mainnet (requests for `network: "mainnet"` get HTTP 403).

Flow: EVM lock (existing vault flow; **skipped while signet-only**) → `POST /api/ordinals/deliveries`
→ inscribe NFT image (≤60 KB, else metadata JSON) with CBOR metadata (tag 5) via Taproot commit/reveal
→ reveal output (10,000 sat postage) pays the user's Taproot address.
Status: `pending` → `inscribed` (commit + reveal broadcast) → `delivered` (reveal confirmed) / `failed`.
Fees: mempool.space signet `halfHourFee`.

```
npm install
npm run keygen            # creates ~/.bridge-ordinals/signet.key (chmod 600), prints the public funding address
npm test                  # offline tests (mainnet block, taproot-only recipients, envelope)
npm run deliver -- tb1p…  # one signet test delivery from the CLI
npm start                 # HTTP on 127.0.0.1:8790 (ORDINALS_PORT)
```
Key: `ORDINALS_INSCRIBER_WIF` env or `ORDINALS_INSCRIBER_KEY_FILE` (default `~/.bridge-ordinals/signet.key`).
Records: `~/.bridge-ordinals/deliveries-signet.json`. Neither is in the repo.

Front end: `docs/assets/ordinals.js` (add-on, like `deliver.js`). Set `window.BRIDGE_ORDINALS_URL` to the
hosted service URL to enable requests; until then submit shows "Coming soon / pilot" and sends nothing.

Before mainnet: verify `lockTxHash` is a real vault lock on Abstract (TODO in `src/deliver.js`), run the real
lock for the ordinals destination, fund a mainnet inscriber wallet, choose hosting, flip `mainnet` in both
`src/config.js` and `docs/assets/ordinals.js` — only with explicit approval.
