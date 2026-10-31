# Ordinals destination: OrdinalsSink (option b)

## How the vault picks destinations
`NftLockVaultUpgradeable` (proxy `0xe81D…99e5` on Abstract) sends to any eid where `peers[eid] != 0`. There is no other allowlist.
`setPeer` and `setSendConfig` are `onlyOwner`. There is one peer per eid, and EVM locks need a non-zero 20-byte recipient.
The live implementation is `0x2a94…c507` and has the same selectors. Adding a destination needs **no upgrade**.

On-chain reads from 2026-10-31:
- `owner()` and the LayerZero delegate are both `0xb19F00e095B1387061d73751C772bbA848D196b1`.
- Peers already in use: 30101, 30184, 30102, 30312, 30416.

## Design
- **Chain:** the sink is on **Arbitrum One (eid 30110)**. It costs little and has no existing peer, so the Base twin route on 30184 is left alone.
- **No pseudo-eid:** the endpoint reverts for eids that have no library or DVN.
- **What the sink does:** `OrdinalsSink` is receive-only. It has no owner, no upgrade path and no send path, and it mints nothing.
  - It accepts `LOCK_MINT` only from (30324, vault).
  - It records `seen[lockId]` so a replayed message is rejected.
  - It emits `OrdinalsRequested`.
- **Delegate:** `delegate_` (the vault owner) can set only the sink's LayerZero receive config. Arbitrum's default DVN for Abstract is LZDeadDVN, so this config is required.
- **Recipient binding:** the lock's EVM `recipient` is `ordinalsCommitment(bc1p)`, the low 20 bytes of `keccak256("BIGFOOT404-ORDINALS-V1:" + lowercase bc1p)`.
  - The bc1p address is therefore committed inside the locker's own signed lock tx, so no extra signature is needed and nobody can redirect it.
  - The service recomputes the commitment and rejects a mismatch.
  - Nothing is ever sent to that address.
  - The front end, the service and Solidity share one pinned test vector.
- **Trust root:** the service still checks the lock on Abstract: the receipt, the confirmations, `destEid == 30110`, `locks(lockId).active`, and that the lockId hasn't been used before. Sink events are only an audit trail.

## Funds safety
- **No double bridge:** `activeLockId` stays set, so the same foot can't be bridged elsewhere (`AlreadyLocked`).
- **No unlock:** an unlock needs an `UNLOCK_BURN` from `peers[30110]`, and the sink can't send one.
- **No return path (Ordinal → EVM) yet.** The original NFT stays locked in the vault.
  A future return path would be a new sink v2 with a send path. The owner would `setPeer(30110, v2)` and set the receive config.
  v2 would send `UNLOCK_BURN(lockId, evmRecipient)` after proving the inscription was burned or returned, for example by sending it to a provably unspendable address checked by a trusted relayer.
  That trusted step is the hard part and is out of scope.

## Go-live (owner `0xb19F…96b1`)
The dry run is `forge script script/DeployOrdinalsSink.s.sol --rpc-url https://arb1.arbitrum.io/rpc`.
1. **Arbitrum:** deploy `OrdinalsSink(0x1a44…728c, 30324, vault, 0xb19F…96b1)`.
2. **Arbitrum, from the delegate, to EndpointV2:**
   - A1 `setReceiveLibrary(sink, 30324, ReceiveUln302 0x7B9E…05e6, 0)`;
   - A2 `setConfig(sink, ReceiveUln302, ULN{20 conf, LZ Labs DVN 0x2f55…6416})`.
3. **Abstract, to the vault:** B1 `setSendConfig(SendUln302 0x166C…29a1, 30110, 20, LZ Labs DVN 0xf4da…7112, 10000, executor 0x643E…58A5)`.
4. **Abstract, last:** B2 `setPeer(30110, sink)`. This opens the route.
5. Set `ORDINALS_SINK_ADDRESS` on the service and `window.BRIDGE_ORDINALS_SINK` on the page.
