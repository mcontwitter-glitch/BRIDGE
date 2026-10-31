import test from 'node:test';
import assert from 'node:assert';
import { CONFIG, assertNetwork } from '../src/config.js';
import { assertTaprootRecipient, ECPair, xonly, bitcoin } from '../src/btc.js';
import { envelope, cbor } from '../src/inscribe.js';
import { verifyLock, NFT_LOCKED_TOPIC, ordinalsCommitment } from '../src/lock.js';

const k = ECPair.makeRandom();
const addr = (pay, net) => bitcoin.payments[pay](pay === 'p2tr' ? { internalPubkey: xonly(k.publicKey), network: net } : { pubkey: k.publicKey, network: net }).address;

test('default network is mainnet', () => {
  assert.strictEqual(CONFIG.network, 'mainnet'); assert.strictEqual(CONFIG.mainnet, true);
  assert.match(CONFIG.mempool, /^https:\/\/mempool\.space\/api$/);
  assert.doesNotThrow(() => assertNetwork('mainnet'));
  assert.throws(() => assertNetwork('signet'), /Only mainnet/);
});
test('mainnet accepts bc1p, rejects tb1p / bc1q / legacy / junk', () => {
  assert.doesNotThrow(() => assertTaprootRecipient(addr('p2tr', bitcoin.networks.bitcoin)));
  assert.throws(() => assertTaprootRecipient(addr('p2tr', bitcoin.networks.testnet)));
  assert.throws(() => assertTaprootRecipient(addr('p2wpkh', bitcoin.networks.bitcoin)), /Taproot/);
  assert.throws(() => assertTaprootRecipient(addr('p2pkh', bitcoin.networks.bitcoin)), /Taproot/);
  assert.throws(() => assertTaprootRecipient('bc1pnotanaddress'));
});
test('envelope shape', () => {
  const asm = bitcoin.script.toASM(envelope(Buffer.alloc(32, 1), 'text/plain', Buffer.from('hi'), { name: 'x' }));
  assert.match(asm, /OP_CHECKSIG OP_0 OP_IF 6f7264 OP_1 746578742f706c61696e OP_5 /);
  assert.ok(asm.endsWith('6869 OP_ENDIF'));
  assert.deepStrictEqual([...cbor({ a: 1 })], [0xa1, 0x61, 0x61, 0x01]);
});

// ---- lock verification against a mocked Abstract RPC ----
const VAULT = '0xe81ddab112137112b8feeb853e22bc4c38f999e5', COLL = '0x22fc5bb9810ef92db35accea463693331bcd0a8a';
const TX = '0x' + 'ab'.repeat(32), LOCKID = '0x' + 'cd'.repeat(32), EID = 30110;
const BTC = 'bc1pua8xnvy6cx7g632g3rx8gy5z9qg5s446d267gkzgenmsd6ewkwasrsmmg9';
const pad = (h) => h.replace(/^0x/, '').padStart(64, '0');
const cfg = { ...CONFIG.lock, vault: VAULT, destEid: EID, minConfirmations: 12 };
function rpcMock({ commit = ordinalsCommitment(BTC), status = '0x1', block = 100, head = 200, eid = EID, tokenId = 7, active = 1, from = VAULT, missing = false } = {}) {
  return async (m, p) => {
    if (m === 'eth_getTransactionReceipt') return missing ? null : { status, blockNumber: '0x' + block.toString(16), logs: [{ address: from,
      topics: [NFT_LOCKED_TOPIC, LOCKID, '0x' + pad(COLL), '0x' + pad(tokenId.toString(16))], data: '0x' + pad('11'.repeat(20)) + pad(eid.toString(16)) + pad('80') + pad(commit) }] };
    if (m === 'eth_blockNumber') return '0x' + head.toString(16);
    if (m === 'eth_call') return '0x' + [COLL, '7', '11', eid.toString(16), 'c0', String(active)].map(pad).join('');
  };
}
const req = { lockTxHash: TX, collection: COLL, tokenId: 7, recipient: BTC };
test('lock verify accepts a confirmed, active vault lock to the Ordinals eid', async () => {
  const r = await verifyLock(req, { rpc: rpcMock(), cfg });
  assert.strictEqual(r.lockId, LOCKID); assert.strictEqual(r.destEid, EID);
});
test('lock verify rejects bad locks', async () => {
  const bad = async (o, re, r = req) => assert.rejects(verifyLock(r, { rpc: rpcMock(o), cfg }), re);
  await bad({}, /32-byte/, { ...req, lockTxHash: '0xsignettest1' });
  await bad({ missing: true }, /not found/);
  await bad({ status: '0x0' }, /reverted/);
  await bad({ head: 105 }, /confirmations/);
  await bad({ from: '0x' + '99'.repeat(20) }, /no NftLocked/);
  await bad({ tokenId: 8 }, /no NftLocked/);
  await bad({ eid: 30101 }, /not the Ordinals eid/);
  await bad({ active: 0 }, /no longer active/);
  await assert.rejects(verifyLock(req, { rpc: rpcMock(), cfg: { ...cfg, destEid: null } }), /not configured/);
});
test('OrdinalsSink: commitment matches the Solidity vector; lock must commit to the requested bc1p', async () => {
  assert.strictEqual(ordinalsCommitment(BTC), '0xbbd71217bacde58264872802f5333865a5bd8d4b'); // cast keccak "BIGFOOT404-ORDINALS-V1:<bc1p>" low 20 bytes
  assert.strictEqual(ordinalsCommitment(BTC.toUpperCase()), ordinalsCommitment(BTC));
  const other = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';
  await assert.rejects(verifyLock({ ...req, recipient: other }, { rpc: rpcMock(), cfg }), /does not commit/);
  await assert.rejects(verifyLock(req, { rpc: rpcMock({ commit: '11'.repeat(20) }), cfg }), /does not commit/);
  await assert.rejects(verifyLock({ ...req, recipient: '' }, { rpc: rpcMock(), cfg }), /recipient/);
});
test('Ordinals eid stays disabled until the sink address is set', async () => {
  const { CONFIG: C } = await import('../src/config.js');
  if (!process.env.ORDINALS_SINK_ADDRESS && !process.env.ORDINALS_LOCK_DEST_EID) assert.strictEqual(C.lock.destEid, null);
  assert.strictEqual(C.lock.sinkEid, 30110);
});
test('lock verify rejects duplicate lockTx / lockId reuse', async () => {
  await assert.rejects(verifyLock(req, { rpc: rpcMock(), cfg, isUsed: (x) => x === TX }), /already used/);
  await assert.rejects(verifyLock(req, { rpc: rpcMock(), cfg, isUsed: (x) => x === LOCKID }), /already used/);
});
