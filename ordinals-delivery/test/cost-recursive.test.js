import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.ORDINALS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ord-test-'));
const { CONFIG } = await import('../src/config.js');
const { costSats, assertUnderCap, breakEvenRate } = await import('../src/cost.js');
const R = await import('../src/recursive.js');
const D = await import('../src/deliver.js');
const store = await import('../src/store.js');

const cap = { maxUsd: 20, marginUsd: 18, maxFeeRate: 0 };
const usdSats = (usd, px = 100000) => Math.round(usd * 1e8 / px);

test('cap: strictly under $20, ≤ $18 margin, fee ceiling, price unknown → queued', () => {
  assert.strictEqual(CONFIG.postageSats, 330);
  assert.ok(assertUnderCap({ sats: usdSats(17.99), rate: 5, btcUsd: 100000 }, cap) < 18);
  assert.doesNotThrow(() => assertUnderCap({ sats: usdSats(18), rate: 5, btcUsd: 100000 }, cap));
  assert.throws(() => assertUnderCap({ sats: usdSats(18.01), rate: 5, btcUsd: 100000 }, cap), (e) => e.queued && e.status === 202 && /above the \$18 margin/.test(e.message));
  assert.throws(() => assertUnderCap({ sats: usdSats(20), rate: 5, btcUsd: 100000 }, { ...cap, marginUsd: 20 }), /not under the \$20 cap/);
  assert.throws(() => assertUnderCap({ sats: 1000, rate: 30, btcUsd: 100000 }, { ...cap, maxFeeRate: 25 }), /Waiting for lower Bitcoin fees: fee rate 30/);
  assert.throws(() => assertUnderCap({ sats: 1000, rate: 1, btcUsd: 0 }, cap), /BTC price unavailable/);
});
test('cost model + break-even rate', () => {
  const s = costSats({ bodyBytes: 400, metaBytes: 330, typeLen: 24, rate: 1 });
  assert.strictEqual(s.total, s.revealFee + s.commitFee + 330);
  const r = breakEvenRate({ bodyBytes: 400, metaBytes: 330, typeLen: 24 }, 77000, 18);
  assert.ok(costSats({ bodyBytes: 400, metaBytes: 330, typeLen: 24, rate: r }).total * 77000 / 1e8 <= 18);
  assert.ok(costSats({ bodyBytes: 400, metaBytes: 330, typeLen: 24, rate: r + 1 }).total * 77000 / 1e8 > 18);
});

const lf = Object.values(R.loadCollections()).find((c) => c.slug === 'lil-foots');
const ATTR96 = [['Background', 'Tan'], ['Cloths', 'Diaper'], ['Drip', 'Diamonds'], ['Eyes', 'Bloodshot'], ['Flex', 'Platinum Cuban'], ['Fur type', 'Frozen'], ['Head', 'GD'], ['Left hand', 'Retsba'], ['Mouth', 'Labubu'], ['Right hand', 'GameBig']].map(([trait_type, value]) => ({ trait_type, value }));

test('recursive is the default mode; item HTML < 600 B, text/html;charset=utf-8, embeds tokenId + traits', () => {
  assert.strictEqual(CONFIG.mode, 'recursive');
  assert.strictEqual(R.P5_INSCRIPTION_ID, '13a5c8e41dfc110514b450b2f15317988c0aaf276d3dbdcca9aa3c7d0b2188a7i0');
  const idx = R.traitIndices(lf, ATTR96);
  assert.deepStrictEqual(idx, [5, 1, 1, 7, 5, 5, 20, 4, 3, 6]);
  const html = R.buildItemHtml({ p5Id: R.P5_INSCRIPTION_ID, rendererId: 'f'.repeat(64) + 'i0', name: lf.name, tokenId: 4404, idx: lf.vals.map((v) => v.length - 1) });
  assert.ok(Buffer.byteLength(html) < 600);
  assert.match(html, new RegExp(`src=/content/${R.P5_INSCRIPTION_ID}>`));
  assert.match(html, /go\(4404,\[/);
  assert.strictEqual(R.HTML_TYPE, 'text/html;charset=utf-8');
  assert.throws(() => R.traitIndices(lf, [{ trait_type: 'Eyes', value: 'Nope' }]), /unknown trait/);
  const js = R.buildRenderer(lf, { 'Head/GD': 'a'.repeat(64) + 'i0' });
  assert.match(js, /^var T=\["a{64}"\],L=\[/); assert.ok(js.includes("'i'+i%1e4"));
});

test('no manifest → "collection setup not inscribed", nothing inscribed', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ord-col-'));
  fs.copyFileSync(path.join(R.collectionsDir(), 'lil-foots.json'), path.join(empty, 'lil-foots.json'));
  await assert.rejects(D.loadContent({ collection: lf.collection, tokenId: 96, attributes: ATTR96 }, { mode: 'recursive', dir: empty }), (e) => e.status === 503 && /collection setup not inscribed/.test(e.message));
  // with a complete manifest the same request yields the recursive HTML
  fs.writeFileSync(path.join(empty, 'lil-foots.manifest.json'), JSON.stringify({ complete: true, p5Id: R.P5_INSCRIPTION_ID, rendererId: 'e'.repeat(64) + 'i0', layers: {} }));
  const c = await D.loadContent({ collection: lf.collection, tokenId: 96, lockTxHash: '0x1', attributes: ATTR96 }, { mode: 'recursive', dir: empty });
  assert.strictEqual(c.contentType, 'text/html;charset=utf-8'); assert.ok(c.body.length < 600); assert.strictEqual(c.metadata.a.Head, 'GD');
  await assert.rejects(D.loadContent({ collection: '0x' + '1'.repeat(40), tokenId: 1, attributes: [] }, { mode: 'recursive', dir: empty }), /collection setup not inscribed/);
  // a collection without a setup manifest → startDelivery refuses before lock checks
  await assert.rejects(D.startDelivery({ dest: 'ordinals', network: 'mainnet', recipient: 'bc1pua8xnvy6cx7g632g3rx8gy5z9qg5s446d267gkzgenmsd6ewkwasrsmmg9', collection: '0x' + '1'.repeat(40), tokenId: 1, lockTxHash: '0x' + 'ab'.repeat(32) }), /collection setup not inscribed/);
});

test('over the cap → delivery stays queued, then inscribes when fees drop', async () => {
  const rec = store.create({ recipient: 'bc1p', collection: lf.collection, tokenId: '1', lockTxHash: '0x' + 'cd'.repeat(32), req: {} });
  let calls = 0, high = true;
  const deps = { loadKey: () => null, loadContent: async () => ({ contentType: 'text/plain', body: Buffer.from('x'), metadata: null }),
    inscribe: async () => { calls++; if (high) assertUnderCap({ sats: usdSats(25), rate: 200, btcUsd: 100000 }, cap); return { commitTxid: 'c', revealTxid: 'r', inscriptionId: 'ri0', costUsd: 0.8 }; } };
  let r = await D.run(rec.id, deps);
  assert.strictEqual(r.status, 'queued'); assert.match(r.waiting, /^Waiting for lower Bitcoin fees/); assert.strictEqual(r.estUsd, 25);
  await D.retryQueued(deps); assert.strictEqual(store.get(rec.id).status, 'queued');
  high = false; await D.retryQueued(deps);
  r = store.get(rec.id); assert.strictEqual(r.status, 'inscribed'); assert.strictEqual(r.inscriptionId, 'ri0'); assert.strictEqual(calls, 3);
});

test('batched setup: one reveal under the vsize limit, auto-split above it', async () => {
  const { batchCostSats, planBatches } = await import('../src/cost.js');
  const items = Array.from({ length: 97 }, () => ({ bodyBytes: 2400, typeLen: 10 }));
  const one = batchCostSats({ items, rate: 1 });
  assert.strictEqual(one.reveals.length, 1);
  assert.ok(one.total < items.reduce((s, it) => s + costSats({ bodyBytes: it.bodyBytes, metaBytes: 0, rate: 1 }).total, 0) / 2);
  const g = planBatches(items, 40_000);
  assert.strictEqual(g.length, 2); assert.deepStrictEqual(g.flat(), items.map((_, i) => i));
  assert.ok(batchCostSats({ items, rate: 0.2 }).total < one.total / 4);
});

test('repo manifest: lil-foots setup inscribed on mainnet (97 layers in one reveal + renderer)', () => {
  const m = R.loadManifest('lil-foots');
  assert.ok(m && m.complete); assert.strictEqual(m.rendererId, 'd1ee1cbec698deb7df8fd4f478c71c81616a35c1ec760ee84f8516a31643faf1i0');
  const ids = Object.values(m.files); assert.strictEqual(ids.length, 97);
  assert.ok(ids.every((id, i) => id === `6d500cccf7841c5964d6f0969339cddbd69b774eace781084d50c5d588dd1efdi${i}`));
});
