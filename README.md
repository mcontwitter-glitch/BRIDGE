# BRIDGE

NFT lock bridge. Home is Abstract.

`NftLockVault` locks an ERC-721 (it does not burn the original). A LayerZero V2 message carries `tokenId`, `tokenURI`, and `recipient`. The destination mints a twin with the same URI. Unlock releases the original back to the recipient.

Abstract LayerZero V2 endpoint id is **30324** (not 30310). Destination eids: Ethereum 30101, Base 30184, BNB 30102, ApeChain 30312, Solana 30168, Sui 30378.

## Automatic mint

A lock is one user signature. It escrows the NFT and pays the LayerZero fee. The options in that fee include the destination `lzReceive` gas for the twin mint (12,000,000 gas). That payment is what funds delivery. A transaction on Abstract does not mint on the other chain, and it does not swap into destination gas.

`ExecutorDVN` is the required DVN. `assignJob` records a payload hash only when the pathway send MessageLib calls it. `verifyAndCommit` hashes the packet the same way that MessageLib does (`keccak256` of the bytes after the 81-byte header). It does not take a caller-supplied hash. If this chain's MessageLib already recorded the header, the hash must match that record. Otherwise only the configured LayerZero executor, or an `ADMIN_ROLE` holder on that executor, may present the packet. The contract then calls `ReceiveUln302.verify`, `commitVerification`, and `EndpointV2.lzReceive`, which mints the twin.

`script/ownerDvnWorker.mjs` exits immediately and must not be restarted. ApeChain inbound nonces 1 and 2 stay skipped. Peers are unchanged. LayerZero Labs is not a required DVN.

The stock LayerZero executor does not call `ExecutorDVN`. It waits until `ReceiveUln302.verifiable` is true, then calls `commitVerification` and `lzReceive`. `commitVerification` reverts `LZ_ULN_Verifying` until this DVN has called `verify`. The only destination call that does that without an owner key is `verifyAndCommit`, and only the configured executor or an `ADMIN_ROLE` holder on that executor may present a packet this chain did not already record. Their worker does not make that call. A destination mint therefore still needs that one destination transaction. It does not need a process on this machine.

Ethereum was not upgraded. The owner balance cannot pay the deploy. Pathways that verify on Ethereum still use the old owner DVN.

Deployed `ExecutorDVN` (send and receive, both directions, except Ethereum):

| Chain | DVN |
| --- | --- |
| Abstract | `0x565D9E3BA522de1090C645f372C2FF0Df67a9b42` |
| Base | `0xf7e5baae563b90295ac13ad199ac3c084962b09d` |
| BNB | `0xf7e5bAaE563B90295ac13aD199aC3c084962b09D` |
| ApeChain | `0x2e57bb5c4c78f9bedcdfae9a8eeabe0f6f6e3fb4` |
| Robinhood | `0xf7e5baae563b90295ac13ad199ac3c084962b09d` |

```bash
forge test
node script/ownerDvnWorker.test.mjs
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
