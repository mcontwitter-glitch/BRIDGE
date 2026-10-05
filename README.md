# BRIDGE

NFT lock bridge. Home is Abstract.

`NftLockVault` locks an ERC-721 (it does not burn the original). A LayerZero V2 message carries `tokenId`, `tokenURI`, and `recipient`. The destination mints a twin with the same URI. Unlock releases the original back to the recipient.

Abstract LayerZero V2 endpoint id is **30324** (not 30310). Destination eids: Ethereum 30101, Base 30184, BNB 30102, ApeChain 30312, Solana 30168, Sui 30378.

## Automatic mint

A lock is one user signature on the source chain. It escrows the NFT, pays the LayerZero fee, and the send library calls `ExecutorDVN.assignJob`, which records the payload hash.

That fee does not make the stock LayerZero executor call `verifyAndCommit`. `Executor.execute302` only calls `EndpointV2.lzReceive` after the packet is already verifiable, and it never verifies this DVN. The mint is a second signature from the user, on the destination chain. The user pays that gas.

`ExecutorDVN.verifyAndCommit(encodedPacket, signature)` checks the signature when the caller is not the configured executor and not an `ADMIN_ROLE` holder on that executor. The signer signs `keccak256(abi.encode(srcEid, dstEid, payloadHash))` with a personal sign (`\x19Ethereum Signed Message:\n32`). `payloadHash` is `keccak256` of the bytes after the 81-byte packet header. A different packet does not recover to `signer`. An empty signature from a normal wallet reverts. The executor path still accepts an empty signature. On success the same transaction calls `ReceiveUln302.verify`, `commitVerification`, and `EndpointV2.lzReceive`.

The signer key is `BRIDGE_RELAY_SIGNER_PK`. It is not in git. This machine keeps it in `/home/box/.bridge/relay-signer`. The signer never sends a transaction.

```bash
node script/signRelay.mjs --tx 0xLOCK_TX --src-chain 2741
```

That command reads `PacketSent` and the `assignJob` record for that one transaction, refuses to sign if the hashes differ, prints the signature, and exits. It does not poll. Do not start `script/ownerDvnWorker.mjs`.

The bridge page, after the lock receipt, reads `PacketSent` and POSTs `{ txHash, srcChainId }` to `/api/sign-relay`, then asks the wallet to switch to the destination and sign `verifyAndCommit`. GitHub Pages has no backend, so that call fails until the host that serves the site has `BRIDGE_RELAY_SIGNER_PK` and answers `/api/sign-relay` with this script. The key must be present where the site runs.

ApeChain inbound nonces 1 and 2 stay skipped. Peers are unchanged. LayerZero Labs is not a required DVN. The Abstract vault was not upgraded and was not whitelisted.

Deployed `ExecutorDVN` (required DVN for send and receive, both directions). Signer `0x592bcc953F683C4B0A42b0950af1DA18AAfF55e3`. The UI reads `docs/dvn.json`.

| Chain | eid | DVN |
| --- | --- | --- |
| Abstract | 30324 | `0xa101a956712cca75ef10de23f832509708daef1e` |
| Ethereum | 30101 | `0x56De702bEDa3C03e26d13d5475bCA5b365F89767` |
| Base | 30184 | `0x0a3D1dEd83B443399073537eCd6d4040dD707731` |
| BNB | 30102 | `0x1B02E30141eE4D21718CD5C6C4430621d5A0C33B` |
| ApeChain | 30312 | `0x8485e28276051aB947197775D57E7dA702e8f864` |
| Robinhood | 30416 | `0x011C25b6ced570E01772e3C3F7217eEE146106Af` |

`script/broadcastRelayDvn.mjs <chain>` deployed and wired these with `BRIDGE_OWNER_PK` and `BRIDGE_RELAY_SIGNER` (the address). Fork check against the deployed Base bytecode: `test/fork/RelayDeliveryFork.t.sol` (runs only with its `RELAY_FORK_*` env).

The mint signature HTTP endpoint is `worker/sign-relay` (Cloudflare Worker, viem). See that folder's README. Set `docs/dvn.json` `signRelayUrl` after `wrangler deploy`. Do not put the private key in the Worker source — use `wrangler secret put BRIDGE_RELAY_SIGNER_PK`.

## Test


```bash
forge test
```

Dependencies are vendored under `lib/` (`forge-std` v1.17.0, OpenZeppelin Contracts v5.0.2).

## Deploy the home vault later

`script/DeployHome.s.sol` deploys `NftLockVault` on Abstract mainnet (chain id 2741) against the official LayerZero Endpoint V2:

`0x5c6cff4b7c49805f8295ff73c204ac83f3bc4ae7`

That address is hardcoded from [LayerZero metadata](https://metadata.layerzero-api.com/v1/metadata) (`abstract` → version 2, eid 30324, `endpointV2`). This repository does not broadcast and does not contain a private key.

When you are ready, fund the deployer with Abstract ETH and broadcast with your own key:

```bash
export DEPLOYER_PK=0xYOUR_KEY
forge script script/DeployHome.s.sol \
  --rpc-url https://api.mainnet.abs.xyz \
  --private-key "$DEPLOYER_PK" \
  --broadcast
```

Simulate only (no transaction):

```bash
forge script script/DeployHome.s.sol --rpc-url https://api.mainnet.abs.xyz
```

Gas is paid in ETH on Abstract. Never commit `DEPLOYER_PK`.
