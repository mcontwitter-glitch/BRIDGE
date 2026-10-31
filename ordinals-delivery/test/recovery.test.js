// Reveal-failure recovery + underfunded queueing, fully offline (mock broadcast/utxos, random throwaway keys).
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.ORDINALS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ord-rec-'));
const ecc = await import('@bitcoinerlab/secp256k1');
const { ECPair, bitcoin, xonly, fundingAddress, NETWORK } = await import('../src/btc.js');
const { inscribe, buildSweep, broadcastWithRetry } = await import('../src/inscribe.js');
const D = await import('../src/deliver.js');
const store = await import('../src/store.js');

const key = ECPair.makeRandom({ network: NETWORK });
const recipient = bitcoin.payments.p2tr({ internalPubkey: xonly(ECPair.makeRandom().publicKey), network: NETWORK }).address;
const utxo = (value) => async () => [{ txid: 'aa'.repeat(32), vout: 0, value, status: { confirmed: true } }];
const content = { contentType: 'text/html;charset=utf-8', body: Buffer.from('<p>lil foot</p>'), metadata: { t: '1' } };
const txid = (hex) => bitcoin.Transaction.fromHex(hex).getId();
// mock mempool: records broadcasts; reveal fails `revealFails` times
function chain({ revealFails = 0, invalidReveal = false } = {}) {
  const seen = []; let fails = revealFails;
  const bc = async (hex) => {
    const tx = bitcoin.Transaction.fromHex(hex);
    if (Buffer.from(tx.ins[0].hash).reverse().toString('hex') !== 'aa'.repeat(32) && tx.outs.length === 1 && tx.outs[0].value === 546) {
      if (invalidReveal) throw new Error('broadcast failed: mandatory-script-verify-flag-failed');
      if (fails-- > 0) throw new Error('broadcast failed: 503 upstream timeout');
    }
    if (seen.includes(tx.getId())) throw new Error('broadcast failed: Transaction already in block chain');
    seen.push(tx.getId()); return tx.getId();
  };
  return { bc, seen };
}
const inscribeWith = (c, utxos = utxo(100_000)) => (a) => inscribe({ ...a, rate: 2, btcUsd: 77000, deps: { utxos, broadcast: c.bc, revealTries: 1 } });

test('signed commit + reveal are persisted BEFORE any broadcast', async () => {
  const c = chain(); let saved;
  const r = await inscribe({ key, recipient, ...content, rate: 2, btcUsd: 77000, deps: { utxos: utxo(100_000), broadcast: c.bc },
    onCommit: (x) => { saved = x; assert.strictEqual(c.seen.length, 0, 'nothing broadcast yet'); } });
  assert.strictEqual(txid(saved.commitHex), saved.commitTxid);
  assert.strictEqual(txid(saved.revealHex), saved.revealTxid);
  assert.deepStrictEqual(c.seen, [saved.commitTxid, saved.revealTxid]);
  assert.strictEqual(r.inscriptionId, `${saved.revealTxid}i0`);
});

test('reveal broadcast fails after commit → status revealing (hexes kept) → retried on the loop → inscribed', async () => {
  const c = chain({ revealFails: 2 });
  const rec = store.create({ recipient, req: {}, lockTxHash: '0x01' });
  const deps = { loadKey: () => key, loadContent: async () => content, inscribe: inscribeWith(c), broadcast: c.bc, revealTries: 1, waitMs: 1, txStatus: async () => ({ confirmed: true }) };
  let r = await D.run(rec.id, deps);
  assert.strictEqual(r.status, 'revealing'); assert.match(r.waiting, /Reveal broadcast pending/);
  assert.ok(r.commitTxid && r.revealHex && r.commitHex && r.leafHex); assert.strictEqual(c.seen[0], r.commitTxid);
  await D.retryQueued(deps); // reveal fails again (2nd injected failure)
  assert.strictEqual(store.get(rec.id).status, 'revealing');
  await D.retryQueued(deps); // succeeds; commit re-broadcast reported "already in block chain" = ok
  r = store.get(rec.id);
  assert.strictEqual(r.status, 'inscribed'); assert.strictEqual(r.inscriptionId, `${r.revealTxid}i0`); assert.ok(r.recovered);
  assert.deepStrictEqual(c.seen, [r.commitTxid, r.revealTxid]); // one commit only: never paid twice
});

test('reveal permanently invalid → after N tries the commit output is swept back to the inscriber wallet, then re-queued', async () => {
  const c = chain({ invalidReveal: true });
  const rec = store.create({ recipient, req: {}, lockTxHash: '0x02' });
  const deps = { loadKey: () => key, loadContent: async () => content, inscribe: inscribeWith(c), broadcast: c.bc, revealTries: 1, waitMs: 1, feeRate: async () => 2, txStatus: async () => ({ confirmed: true }) };
  await D.run(rec.id, deps);
  const stuck = store.get(rec.id);
  for (let i = 1; i < D.MAX_REVEAL_ATTEMPTS && store.get(rec.id).status === 'revealing'; i++) await D.retryQueued(deps);
  const r = store.get(rec.id);
  assert.strictEqual(r.status, 'queued'); assert.match(r.waiting, /swept back to the inscriber wallet/);
  assert.strictEqual(r.swept[0].commitTxid, stuck.commitTxid);
  assert.ok(c.seen.includes(r.swept[0].sweepTxid));
});

test('sweep tx: spends commit:0 by key path with a valid Schnorr sig, pays the inscriber wallet', async () => {
  let saved; const c = chain();
  await inscribe({ key, recipient, ...content, rate: 2, btcUsd: 77000, deps: { utxos: utxo(100_000), broadcast: c.bc }, onCommit: (x) => { saved = x; } });
  const sw = buildSweep({ key, commitTxid: saved.commitTxid, commitValue: saved.commitValue, leafHex: saved.leafHex, rate: 2 });
  const tx = bitcoin.Transaction.fromHex(sw.hex);
  const commitOut = bitcoin.Transaction.fromHex(saved.commitHex).outs[0];
  assert.strictEqual(Buffer.from(tx.ins[0].hash).reverse().toString('hex'), saved.commitTxid);
  assert.strictEqual(tx.outs[0].value, saved.commitValue - sw.fee);
  assert.strictEqual(bitcoin.address.fromOutputScript(tx.outs[0].script, NETWORK), fundingAddress(key));
  const sighash = tx.hashForWitnessV1(0, [commitOut.script], [commitOut.value], bitcoin.Transaction.SIGHASH_DEFAULT);
  assert.strictEqual(tx.ins[0].witness.length, 1);
  assert.ok(ecc.verifySchnorr(sighash, commitOut.script.subarray(2), tx.ins[0].witness[0]));
});

test('broadcastWithRetry: already-known = success, transient errors retried, persistent error thrown', async () => {
  let n = 0;
  assert.strictEqual(await broadcastWithRetry('00', { bcast: async () => { throw new Error('txn-already-in-mempool'); } }), null);
  assert.strictEqual(await broadcastWithRetry('00', { waitMs: 1, bcast: async () => { if (n++ < 2) throw new Error('timeout'); return 'ok'; } }), 'ok');
  await assert.rejects(broadcastWithRetry('00', { tries: 2, waitMs: 1, bcast: async () => { throw new Error('nope'); } }), /nope/);
});

test('underfunded wallet → queued "Inscriber wallet needs funding" (nothing signed), retried, inscribes once funded', async () => {
  const c = chain(); let funds = utxo(500);
  const rec = store.create({ recipient, req: {}, lockTxHash: '0x03' });
  const deps = { loadKey: () => key, loadContent: async () => content, inscribe: (a) => inscribeWith(c, (x) => funds(x))(a) };
  let r = await D.run(rec.id, deps);
  assert.strictEqual(r.status, 'queued'); assert.strictEqual(r.waiting, 'Inscriber wallet needs funding'); assert.match(r.detail, /need \d+ sats confirmed/);
  assert.strictEqual(c.seen.length, 0);
  for (const o of store.list()) if (o.id !== rec.id && o.status === 'queued') store.patch(o.id, { status: 'failed' }); // isolate from earlier tests
  await D.retryQueued(deps); assert.strictEqual(store.get(rec.id).status, 'queued');
  funds = utxo(100_000); await D.retryQueued(deps);
  r = store.get(rec.id); assert.strictEqual(r.status, 'inscribed', r.waiting); assert.strictEqual(c.seen.length, 2);
});
