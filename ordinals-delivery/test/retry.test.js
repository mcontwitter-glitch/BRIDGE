// #3973 regression: empty tokenURI from the page + ipfs.io 429 → 'failed'. Lock tokenURI decode, gateway fallback, safe re-queue.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.ORDINALS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ord-retry-'));
const D = await import('../src/deliver.js');
const store = await import('../src/store.js');
const { CONFIG } = await import('../src/config.js');
const { verifyLock, NFT_LOCKED_TOPIC, ordinalsCommitment, abiString } = await import('../src/lock.js');

const META = JSON.parse(fs.readFileSync(new URL('./fixtures-3973.json', import.meta.url), 'utf8'));
const URI = 'ipfs://QmeY3guj7YMSDLbByqhU7ESDCXSsXenJtUAaxKKtkerChd/3973';
const VAULT = '0xe81ddab112137112b8feeb853e22bc4c38f999e5', COLL = '0x22fc5bb9810ef92db35accea463693331bcd0a8a';
const BTC = 'bc1pqhkwh863ssxvlceqtm6huea8c54cfpjyew4w9krdjlgd4h46qhpsh37j0p', LOCKID = '0x' + 'cd'.repeat(32), EID = 30110;
const pad = (h) => h.replace(/^0x/, '').padStart(64, '0');
const strData = (s) => { const b = Buffer.from(s).toString('hex'); return pad((b.length / 2).toString(16)) + b.padEnd(Math.ceil(b.length / 64) * 64, '0'); };
const cfg = { ...CONFIG.lock, vault: VAULT, destEid: EID, minConfirmations: 1 };
const rpc = async (m) => {
  if (m === 'eth_getTransactionReceipt') return { status: '0x1', blockNumber: '0x10', logs: [{ address: VAULT, topics: [NFT_LOCKED_TOPIC, LOCKID, '0x' + pad(COLL), '0x' + pad((3973).toString(16))],
    data: '0x' + pad('11'.repeat(20)) + pad(EID.toString(16)) + pad('80') + pad(ordinalsCommitment(BTC)) + strData(URI) }] };
  if (m === 'eth_blockNumber') return '0x20';
  if (m === 'eth_call') return '0x' + [COLL, 'f85', '11', EID.toString(16), 'c0', '1'].map(pad).join('');
};
const gw = (calls) => async (url) => { calls.push(url); return /ipfs\.io|dweb/.test(url) ? new Response('switching to a service worker gateway only', { status: 429 }) : new Response(JSON.stringify(META)); };
const req = (tx) => ({ dest: 'ordinals', network: 'mainnet', recipient: BTC, collection: COLL, tokenId: 3973, tokenURI: '', image: 'ipfs://x', name: 'LIL FOOT #3973', lockTxHash: tx });

test('verifyLock returns the tokenURI from the NftLocked event', async () => {
  const r = await verifyLock({ lockTxHash: '0x' + 'ab'.repeat(32), collection: COLL, tokenId: 3973, recipient: BTC }, { rpc, cfg });
  assert.strictEqual(r.tokenURI, URI);
  assert.strictEqual(abiString('0x' + pad('20') + strData('hi'), 0), 'hi');
});
test('recursive content: empty tokenURI fails clearly; ipfs.io 429 falls through to another gateway', async () => {
  await assert.rejects(D.loadContent({ ...req('0x1'), tokenId: '99999' }, { mode: 'recursive' }), /tokenURI missing/);
  const p = await D.loadContent({ ...req('0x1'), tokenId: '3973' }, { mode: 'recursive', fetchImpl: () => { throw new Error('no network'); } });
  assert.strictEqual(p.metadata.a.Eyes, 'Icy'); // pinned traits, no IPFS needed
  const calls = [];
  const c = await D.loadContent({ ...req('0x1'), tokenId: '99998', tokenURI: URI }, { mode: 'recursive', fetchImpl: gw(calls) });
  assert.strictEqual(c.contentType, 'text/html;charset=utf-8'); assert.ok(c.body.length < 600);
  assert.deepStrictEqual(c.metadata.a, { Background: 'Tan', Eyes: 'Icy', 'Fur type': 'Chosen', Mouth: 'Frown' });
});
test('same lock again: failed (no commit) → re-queued with tokenURI; with commit → untouched; findByLock', async () => {
  const tx = '0x' + '88'.repeat(32);
  const rec = store.create({ recipient: BTC, collection: COLL, tokenId: '3973', lockTxHash: tx, lockId: LOCKID, status: 'failed', error: 'token attributes unavailable (tokenURI unreadable)', req: { tokenURI: '', collection: COLL, tokenId: '3973', lockTxHash: tx } });
  assert.strictEqual(D.findByLock(tx.toUpperCase().replace('0X', '0x')).id, rec.id);
  assert.strictEqual(D.findByLock(LOCKID).id, rec.id);
  const r = await D.resumeExisting(rec, req(tx), { rpc, cfg });
  assert.strictEqual(r.status, 'queued'); assert.strictEqual(r.req.tokenURI, URI); assert.strictEqual(r.error, undefined); assert.match(r.lastError, /unavailable/);
  // never double-inscribe: a failed record that has a commit stays as is
  const withCommit = store.patch(rec.id, { status: 'failed', commitTxid: 'ee'.repeat(32) });
  assert.strictEqual((await D.resumeExisting(withCommit, req(tx), { rpc, cfg })).status, 'failed');
  // different recipient → 409
  const fresh = store.create({ recipient: 'bc1pother', collection: COLL, tokenId: '3973', lockTxHash: '0x99', status: 'failed', req: {} });
  await assert.rejects(D.resumeExisting(fresh, req('0x99'), { rpc, cfg }), /different recipient/);
});
test('startDelivery on an existing lock returns the record instead of 409', async () => {
  const tx = '0x' + '77'.repeat(32);
  const rec = store.create({ recipient: BTC, collection: COLL, tokenId: '3973', lockTxHash: tx, status: 'inscribed', req: {} });
  const r = await D.startDelivery(req(tx), { rpc, cfg });
  assert.strictEqual(r.id, rec.id); assert.strictEqual(r.status, 'inscribed');
});
test('a NEW lock is not rejected as "already used" by its own in-flight marker', async () => {
  const tx = '0x' + '66'.repeat(32);
  for (const o of store.list()) store.patch(o.id, { lockId: '0xother' }); // isolate: mock rpc always returns LOCKID
  const rec = await D.startDelivery(req(tx), { rpc, cfg, isUsed: undefined });
  assert.strictEqual(rec.lockTxHash, tx); assert.ok(rec.id);
});
