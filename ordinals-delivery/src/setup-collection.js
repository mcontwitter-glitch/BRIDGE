// One-time collection setup for recursive (p5.js) delivery. DRY RUN by default: builds deduped, compressed trait
// layers + the renderer and prints the setup cost. Nothing is signed or broadcast unless --broadcast is passed.
//   node src/setup-collection.js [--slug lil-foots] [--src <layer dir>] [--width 480] [--broadcast]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { CONFIG } from './config.js';
import { feeRate, btcUsd } from './btc.js';
import { costSats, toUsd } from './cost.js';
import { loadCollections, collectionsDir, layerKey, layerFile, buildRenderer, P5_INSCRIPTION_ID } from './recursive.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const slug = arg('slug', 'lil-foots');
const width = Number(arg('width', 480));
const src = arg('src', process.env.ORDINALS_LAYERS_SRC || "/workspace/gold_char/src/Lil' Foots");
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
    const cache = path.join(out, 'layers', `${crypto.createHash('sha256').update(`${p}|${width}`).digest('hex').slice(0, 16)}.src`);
    let body;
    if (fs.existsSync(cache)) body = fs.readFileSync(cache);
    else { body = await sharp(p).resize(width, width).webp({ quality: 75, alphaQuality: 80, effort: 6 }).toBuffer(); fs.writeFileSync(cache, body); }
    const h = crypto.createHash('sha256').update(body).digest('hex');
    files[h] ??= { sha256: h, contentType: 'image/webp', bytes: body.length, file: `layers/${h.slice(0, 16)}.webp` };
    fs.writeFileSync(path.join(out, files[h].file), body);
    keys[layerKey(t, v)] = h;
  }
  return { files, keys };
}

const { files, keys } = await buildLayers();
const uniq = Object.values(files);
const [rate, px] = await Promise.all([feeRate(), btcUsd()]);
const fakeIds = Object.fromEntries(Object.keys(keys).map((k) => [k, 'f'.repeat(64) + 'i0']));
const rendererBytes = Buffer.byteLength(buildRenderer(c, fakeIds));
const layerSats = uniq.reduce((s, f) => s + costSats({ bodyBytes: f.bytes, metaBytes: 0, typeLen: 10, rate }).total, 0);
const rendSats = costSats({ bodyBytes: rendererBytes, metaBytes: 0, typeLen: 15, rate }).total;
const total = layerSats + rendSats;
const bytes = uniq.reduce((s, f) => s + f.bytes, 0);
const plan = { slug, collection: c.collection, width, p5Id: P5_INSCRIPTION_ID, layers: Object.keys(keys).length, unique: uniq.length, bytes, rendererBytes, keys, files,
  estimate: { feeRate: rate, btcUsd: px, sats: total, usd: toUsd(total, px), layerSats, rendererSats: rendSats } };
fs.writeFileSync(path.join(out, 'plan.json'), JSON.stringify(plan, null, 1));
fs.writeFileSync(path.join(collectionsDir(), `${slug}.plan.json`), JSON.stringify({ ...plan, estimate: undefined }, null, 1) + '\n'); // public sizes/hashes for estimates
console.log(`${slug}: ${plan.layers} trait layers → ${uniq.length} unique WebP @${width}px, ${bytes} B; renderer ${rendererBytes} B; p5 ${P5_INSCRIPTION_ID} (reused, not re-inscribed)`);
console.log(`setup cost @ ${rate} sat/vB, BTC $${px}: ${total} sats = $${toUsd(total, px)} (${uniq.length + 1} inscriptions, postage ${CONFIG.postageSats} each)`);
console.log(`per +1 sat/vB: +$${toUsd(uniq.reduce((s, f) => s + costSats({ bodyBytes: f.bytes, metaBytes: 0, rate: rate + 1 }).total, 0) + costSats({ bodyBytes: rendererBytes, metaBytes: 0, typeLen: 15, rate: rate + 1 }).total - total, px)}`);
console.log(`plan: ${path.join(out, 'plan.json')}`);

if (!broadcastMode) { console.log('DRY RUN: nothing signed or broadcast. Manifest not written.'); process.exit(0); }

// ---- --broadcast: resumable. Inscribes pending layers (one per confirmed funding UTXO set), then the renderer. ----
const { inscribe, broadcastWithRetry } = await import('./inscribe.js');
const { loadKey, fundingAddress } = await import('./btc.js');
const key = loadKey();
const mp = path.join(collectionsDir(), `${slug}.manifest.json`);
const man = fs.existsSync(mp) ? JSON.parse(fs.readFileSync(mp, 'utf8')) : { slug, collection: c.collection, p5Id: P5_INSCRIPTION_ID, width, layers: {}, files: {}, complete: false };
const save = () => fs.writeFileSync(mp, JSON.stringify(man, null, 1) + '\n');
const self = fundingAddress(key);
try {
  for (const f of uniq) {
    if (man.files[f.sha256]) continue;
    man.pending ??= {};
    const p = man.pending[f.sha256];
    if (p) { // a previous run committed but the reveal did not land: finish it instead of paying again
      await broadcastWithRetry(p.commitHex, { tries: 1 }); await broadcastWithRetry(p.revealHex);
      man.files[f.sha256] = `${p.revealTxid}i0`; delete man.pending[f.sha256]; save(); continue;
    }
    const r = await inscribe({ key, recipient: self, contentType: f.contentType, body: fs.readFileSync(path.join(out, f.file)), metadata: null,
      onCommit: (c) => { man.pending[f.sha256] = c; save(); } });
    delete man.pending[f.sha256];
    man.files[f.sha256] = r.inscriptionId; save();
    console.log(`layer ${f.sha256.slice(0, 12)} → ${r.inscriptionId}`);
  }
  for (const [k, h] of Object.entries(keys)) man.layers[k] = man.files[h];
  if (!man.rendererId) {
    const r = await inscribe({ key, recipient: self, contentType: 'text/javascript', body: Buffer.from(buildRenderer(c, man.layers)), metadata: null });
    man.rendererId = r.inscriptionId;
  }
  man.complete = true; save();
  console.log(`setup complete → ${mp}`);
} catch (e) { save(); console.log(`stopped (resume later): ${e.message}`); process.exitCode = 2; }
