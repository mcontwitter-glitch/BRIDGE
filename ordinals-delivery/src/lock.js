// Verifies an Abstract NftLockVault lock before inscribing. Keyless JSON-RPC reads only.
import { keccak_256 } from '@noble/hashes/sha3';
import { CONFIG } from './config.js';

const hex = (b) => '0x' + Buffer.from(b).toString('hex');
export const NFT_LOCKED_TOPIC = hex(keccak_256('NftLocked(bytes32,address,uint256,address,uint32,string,address)'));
const LOCKS_SELECTOR = hex(keccak_256('locks(bytes32)')).slice(0, 10);
// Must match OrdinalsSink.ordinalsRecipient / docs/assets/ordinals.js.
export const COMMIT_PREFIX = 'BIGFOOT404-ORDINALS-V1:';
export function ordinalsCommitment(btcAddress) {
  const h = keccak_256(new TextEncoder().encode(COMMIT_PREFIX + String(btcAddress).trim().toLowerCase()));
  return '0x' + Buffer.from(h.slice(12)).toString('hex');
}
const err = (m, status = 400) => Object.assign(new Error(m), { status });
const word = (data, i) => data.slice(2 + i * 64, 2 + (i + 1) * 64);
const addrOf = (w) => '0x' + w.slice(24).toLowerCase();

export function makeRpc(url = CONFIG.lock.rpc) {
  let n = 0;
  return async (method, params) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) });
    const j = await r.json();
    if (j.error) throw err(`Abstract RPC: ${j.error.message}`, 502);
    return j.result;
  };
}

/**
 * Checks: tx succeeded, confirmed ≥ minConfirmations, emitted NftLocked from the vault for this
 * collection+tokenId with destEid == configured Ordinals eid, the lock is still active, and the tx/lockId was not
 * used before (isUsed callback). Returns { lockId, owner, tokenURI, destEid, blockNumber }.
 */
export async function verifyLock({ lockTxHash, collection, tokenId, recipient }, { rpc = makeRpc(), isUsed = () => false, cfg = CONFIG.lock } = {}) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(lockTxHash || ''))) throw err('lockTxHash must be a 32-byte tx hash');
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(collection || ''))) throw err('collection must be the NFT contract address');
  if (cfg.destEid == null) throw err('Ordinals lock path not configured: OrdinalsSink not deployed yet (ORDINALS_SINK_ADDRESS unset).', 503);
  const tx = lockTxHash.toLowerCase();
  if (isUsed(tx)) throw err('lockTxHash already used for a delivery', 409);
  const rc = await rpc('eth_getTransactionReceipt', [tx]);
  if (!rc) throw err('lock tx not found on Abstract');
  if (rc.status !== '0x1') throw err('lock tx reverted');
  const head = parseInt(await rpc('eth_blockNumber', []), 16);
  const conf = head - parseInt(rc.blockNumber, 16) + 1;
  if (conf < cfg.minConfirmations) throw err(`lock tx has ${conf} confirmations, need ${cfg.minConfirmations}`, 425);
  const id = BigInt(tokenId);
  const log = (rc.logs || []).find((l) => l.address.toLowerCase() === cfg.vault.toLowerCase() && l.topics[0] === NFT_LOCKED_TOPIC
    && addrOf(l.topics[2].slice(2)) === collection.toLowerCase() && BigInt(l.topics[3]) === id);
  if (!log) throw err('no NftLocked event from the vault for this collection/tokenId in that tx');
  const destEid = parseInt(word(log.data, 1), 16);
  if (destEid !== cfg.destEid) throw err(`lock targets eid ${destEid}, not the Ordinals eid ${cfg.destEid}`);
  if (cfg.requireCommitment !== false) {
    // NftLocked data: owner, destEid, tokenURI offset, recipient (word 3).
    if (!recipient) throw err('recipient (bc1p) required');
    if (addrOf(word(log.data, 3)) !== ordinalsCommitment(recipient)) throw err('lock recipient does not commit to this BTC address (expected ordinalsCommitment(bc1p))', 403);
  }
  const lockId = log.topics[1];
  if (isUsed(lockId.toLowerCase())) throw err('lockId already used for a delivery', 409);
  const rec = await rpc('eth_call', [{ to: cfg.vault, data: LOCKS_SELECTOR + lockId.slice(2) }, 'latest']);
  // LockRecord getter: (collection, tokenId, owner, destEid, tokenURI offset, active) — active is word 5.
  if (!rec || rec.length < 2 + 6 * 64 || BigInt('0x' + word(rec, 5)) !== 1n) throw err('lock is no longer active on the vault');
  return { lockId: lockId.toLowerCase(), owner: addrOf(word(log.data, 0)), destEid, blockNumber: parseInt(rc.blockNumber, 16) };
}
