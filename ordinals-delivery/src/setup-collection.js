// One-time collection setup for recursive (p5.js) delivery. DRY RUN by default: builds deduped AVIF trait layers +
// the renderer and prints the setup cost. Nothing is signed or broadcast unless --broadcast is passed.
// Broadcast = ONE commit + batched reveal(s) (all layers as envelopes in one tapscript, ids <revealTxid>i0..iN), then
// the compact renderer as its own small commit/reveal funded by the batch commit's change.
//   node src/setup-collection.js [--slug lil-foots] [--src <layer dir>] [--width 480] [--max-usd 150] [--broadcast]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { CONFIG } from './config.js';
import { feeRate, btcUsd } from './btc.js';
import { costSats, batchCostSats, toUsd } from './cost.js';
import { loadCollections, collectionsDir, layerKey, layerFile, buildRenderer, P5_INSCRIPTION_ID } from './recursive.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const slug = arg('slug', 'lil-foots');
const width = Number(arg('width', 480));
const src = arg('src', process.env.ORDINALS_LAYERS_SRC || "/workspace/gold_char/src/Lil' Foots");
const maxUsd = Number(arg('max-usd', 150));
const LAYER_TYPE = 'image/avif';
const encodeLayer = (p) => sharp(p).resize(width, width).avif({ quality: 50, effort: 9 }).toBuffer(); // visually ≥ old WebP q75 (PSNR 49.6 vs 39.3 dB)
const broadcastMode = process.argv.includes('--broadcast');
const c = Object.values(loadCollections()).find((x) => x.slug === slug);
if (!c) throw new Error(`no collections/${slug}.json`);
const out = path.join(CONFIG.dataDir, 'collections', slug);
fs.mkdirSync(path.join(out, 'layers'), { recursive: true });

export async function buildLayers() {
  const files = {}; const keys = {};
  for (const [k, t] of c.types.entries()) for (const v of c.vals[k]) {
    if (v === c.none) continue;
    const p = path.join(src, layerFile(c, t, v));
    if (!fs.existsSync(p)) throw new Error(`missing layer ${p}`);
    const cache = path.join(out, 'layers', `${crypto.createHash('sha256').update(`${p}|${width}|avif50`).digest('hex').slice(0, 16)}.src`);
    let body;
    if (fs.existsSync(cache)) body = fs.readFileSync(cache);
    else { body = await encodeLayer(p); fs.writeFileSync(cache, body); }
    const h = crypto.createHash('sha256').update(body).digest('hex');
    files[h] ??= { sha256: h, contentType: LAYER_TYPE, bytes: body.length, file: `layers/${h.slice(0, 16)}.avif` };
    fs.writeFileSync(path.join(out, files[h].file), body);
    keys[layerKey(t, v)] = h;
  }
  return { files, keys };
}

const { files, keys } = await buildLayers();
const uniq = Object.values(files);
const [rate, px] = await Promise.all([feeRate(), btcUsd()]);
const fakeIds = Object.fromEntries(Object.keys(keys).map((k, i) => [k, `${'f'.repeat(64)}i${i}`])); // batched: one txid
const rendererBytes = Buffer.byteLength(buildRenderer(c, fakeIds));
const items = uniq.map((f) => ({ bodyBytes: f.bytes, typeLen: f.contentType.length }));
const batch = batchCostSats({ items, rate });
const rendSats = costSats({ bodyBytes: rendererBytes, metaBytes: 0, typeLen: 15, rate }).total;
const total = batch.total + rendSats;
const unbatched = items.reduce((s, it) => s + costSats({ bodyBytes: it.bodyBytes, metaBytes: 0, typeLen: it.typeLen, rate }).total, 0) + rendSats;
const bytes = uniq.reduce((s, f) => s + f.bytes, 0);
const plan = { slug, collection: c.collection, width, format: LAYER_TYPE, p5Id: P5_INSCRIPTION_ID, layers: Object.keys(keys).length, unique: uniq.length, bytes, rendererBytes, keys, files,
  estimate: { feeRate: rate, btcUsd: px, sats: total, usd: toUsd(total, px), layerSats: batch.total, rendererSats: rendSats, reveals: batch.reveals, commitFee: batch.commitFee, unbatchedSats: unbatched } };
fs.writeFileSync(path.join(out, 'plan.json'), JSON.stringify(plan, null, 1));
fs.writeFileSync(path.join(collectionsDir(), `${slug}.plan.json`), JSON.stringify({ ...plan, estimate: undefined }, null, 1) + '\n'); // public sizes/hashes for estimates
console.log(`${slug}: ${plan.layers} trait layers → ${uniq.length} unique AVIF @${width}px, ${bytes} B; compact renderer ${rendererBytes} B; p5 ${P5_INSCRIPTION_ID} (reused, not re-inscribed)`);
console.log(`batch: 1 commit (${batch.commitFee} sats) + ${batch.reveals.length} reveal(s) [${batch.reveals.map((r) => `${r.n} inscr ${r.vsize} vB ${r.fee} sats`).join('; ')}] + postage ${CONFIG.postageSats} × ${batch.reveals.length} = ${batch.total} sats; renderer ${rendSats} sats`);
console.log(`setup cost @ ${rate} sat/vB, BTC $${px}: ${total} sats = $${toUsd(total, px)} (${uniq.length + 1} inscriptions; unbatched would be ${unbatched} sats)`);
const r1 = rate + 1, at1 = batchCostSats({ items, rate: r1 }).total + costSats({ bodyBytes: rendererBytes, metaBytes: 0, typeLen: 15, rate: r1 }).total;
console.log(`per +1 sat/vB: +${at1 - total} sats (+$${toUsd(at1 - total, px)})`);
console.log(`plan: ${path.join(out, 'plan.json')}`);

if (!broadcastMode) { console.log('DRY RUN: nothing signed or broadcast. Manifest not written.'); process.exit(0); }

// ---- --broadcast: resumable. ONE batched commit/reveal(s) for all layers (persisted before broadcast), then the renderer. ----
const { inscribe, inscribeBatch, broadcastWithRetry } = await import('./inscribe.js');
const { loadKey, fundingAddress } = await import('./btc.js');
const key = loadKey();
const mp = path.join(collectionsDir(), `${slug}.manifest.json`);
const man = fs.existsSync(mp) ? JSON.parse(fs.readFileSync(mp, 'utf8')) : { slug, collection: c.collection, p5Id: P5_INSCRIPTION_ID, width, format: LAYER_TYPE, layers: {}, files: {}, complete: false };
const save = () => fs.writeFileSync(mp, JSON.stringify(man, null, 1) + '\n');
const self = fundingAddress(key);
try {
  const todo = uniq.filter((f) => !man.files[f.sha256]);
  if (todo.length) {
    let b = man.batch;
    if (b && b.shas.join() !== todo.map((f) => f.sha256).join()) throw new Error('pending batch does not match the current layers; resolve manually');
    if (b) { // a previous run signed (maybe broadcast) the batch: finish it instead of paying again
      await broadcastWithRetry(b.commitHex, { tries: 1 });
      for (const r of b.reveals) await broadcastWithRetry(r.hex);
    } else {
      await inscribeBatch({ key, recipient: self, maxUsd, items: todo.map((f) => ({ contentType: f.contentType, body: fs.readFileSync(path.join(out, f.file)) })),
        onCommit: (r) => { man.batch = { shas: todo.map((f) => f.sha256), commitTxid: r.commitTxid, commitHex: r.commitHex, reveals: r.reveals, ids: r.ids, change: r.change }; save(); } });
      b = man.batch;
    }
    todo.forEach((f, i) => { man.files[f.sha256] = b.ids[i]; });
    man.setupTxids = { commit: b.commitTxid, reveals: b.reveals.map((r) => r.txid) };
    man.rendererFunding = b.change; delete man.batch; save();
    console.log(`layers: ${todo.length} inscribed in commit ${b.commitTxid} + reveal(s) ${b.reveals.map((r) => r.txid).join(', ')}`);
  }
  for (const [k, h] of Object.entries(keys)) man.layers[k] = man.files[h];
  if (!man.rendererId) {
    const p = man.rendererPending;
    if (p) { await broadcastWithRetry(p.commitHex, { tries: 1 }); await broadcastWithRetry(p.revealHex); man.rendererId = `${p.revealTxid}i0`; }
    else {
      const r = await inscribe({ key, recipient: self, contentType: 'text/javascript', body: Buffer.from(buildRenderer(c, man.layers)), metadata: null,
        deps: man.rendererFunding ? { utxoList: [man.rendererFunding] } : {}, onCommit: (x) => { man.rendererPending = x; save(); } });
      man.rendererId = r.inscriptionId;
    }
    delete man.rendererPending; delete man.rendererFunding;
  }
  man.complete = true; save();
  console.log(`setup complete → ${mp}`);
} catch (e) { save(); console.log(`stopped (resume later): ${e.message}`); process.exitCode = 2; }
