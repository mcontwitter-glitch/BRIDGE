# BRIDGE

NFT lock bridge. Home is Abstract.

`NftLockVault` locks an ERC-721 (it does not burn the original). A LayerZero V2 message carries `tokenId`, `tokenURI`, and `recipient`. The destination mints a twin with the same URI. Unlock releases the original back to the recipient.

Abstract LayerZero V2 endpoint id is **30324** (not 30310). Destination eids: Ethereum 30101, Base 30184, BNB 30102, ApeChain 30312, Solana 30168, Sui 30378.

## Automatic mint

A lock is one user transaction. The vault sends the LayerZero packet in that same call. `script/ownerDvnWorker.mjs` watches `MessageSent` on the vault and each minter, reads `PacketSent` from the transaction, waits the pathway's configured confirmations, and uses `BRIDGE_OWNER_PK` to call `verify` on the destination `OwnerDVN`. That function only records the DVN witness. The worker then calls `commitVerification` on the receive ULN and, if `inboundPayloadHash` is still the payload hash, `endpoint.lzReceive`. If the LayerZero executor already delivered it, the worker does not send a second execute.

The site then says the twin is minting and polls the destination `minted` flag. The user does not sign again.

ApeChain nonces 1 and 2 stay skipped. The worker does not change DVN config and does not print the key.

```bash
node script/ownerDvnWorker.test.mjs
node script/ownerDvnWorker.mjs
```

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
