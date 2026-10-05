# bridge-sign-relay

Cloudflare Worker that answers `POST /api/sign-relay` for the bridge UI.

A lock already recorded the payload hash on the source `ExecutorDVN` via `assignJob` and emitted `PacketSent`. This Worker:

1. Fetches that one transaction receipt from the source chain RPC.
2. Reads `PacketSent` and the matching `JobAssigned` / `packetHash` record.
3. Refuses to sign unless the on-chain hash matches the packet bytes.
4. Signs `(srcEid, dstEid, payloadHash)` the same way the deployed verifiers check in `relayDigest`.
5. Returns `{ encodedPacket, signature, dstChainId, verifier }` and exits. It never sends a transaction and does not poll.

The private key is the Worker secret `BRIDGE_RELAY_SIGNER_PK` only. It never appears in the repo. RPC URLs and verifier addresses come from `docs/dvn.json` (`npm run sync-config` regenerates `src/config.js`; it runs automatically before test and deploy).

CORS allows `https://bridge.bigfoot404.biz` and `http(s)://localhost*` for local testing. Non-POST requests are rejected. A small per-IP rate limit rejects bursts.

## Deploy (after Cloudflare account + API token)

```bash
cd worker/sign-relay
npm install
export CLOUDFLARE_API_TOKEN=...   # or: npx wrangler login
# optional if the token does not imply an account:
# export CLOUDFLARE_ACCOUNT_ID=...

npx wrangler secret put BRIDGE_RELAY_SIGNER_PK
# paste the same key stored in /home/box/.bridge/relay-signer (never commit it)

npx wrangler deploy
```

Copy the printed `*.workers.dev` URL into `docs/dvn.json` as `signRelayUrl` (include `/api/sign-relay`), commit that config change, and redeploy Pages / the static site. Same-domain routing is also fine: set `signRelayUrl` to `https://bridge.bigfoot404.biz/api/sign-relay` once a Cloudflare route or Pages Function proxies to this Worker.

Dry-run (no credentials required for a local bundle check):

```bash
npx wrangler deploy --dry-run
```

## Test

```bash
npm test
```

The unit test mocks RPC. There is no past lock against the new verifiers yet; when one exists, set `SIGN_RELAY_LIVE_TX` and `SIGN_RELAY_LIVE_SRC` plus `BRIDGE_RELAY_SIGNER_PK` to exercise a live receipt.
