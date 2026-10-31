// Dry run: sats + USD at live mempool.space fees, for metadata-only and an image inscription. Signs/broadcasts nothing.
// node src/estimate.js [image-file-or-url]
import fs from 'node:fs';
import { CONFIG } from './config.js';
import { loadKey, fundingAddress, feeRate, btcUsd, ECPair, NETWORK, xonly, bitcoin } from './btc.js';
import { costSats, toUsd, breakEvenRate, assertUnderCap, setupCostFromPlan } from './cost.js';
import { cbor } from './inscribe.js';
import { loadCollections, loadPlan, loadManifest, buildItemHtml, itemMetadata, P5_INSCRIPTION_ID, HTML_TYPE } from './recursive.js';
import { shrinkImage } from './image.js';
import { inscribe } from './inscribe.js';

const [rate, px] = await Promise.all([feeRate(), btcUsd()]);
const key = loadKey();
console.log(`${CONFIG.network}  mode ${CONFIG.mode}  fee ${rate} sat/vB  BTC $${px}  postage ${CONFIG.postageSats} sats  cap < $${CONFIG.cost.maxUsd} (margin $${CONFIG.cost.marginUsd})`);
console.log(`funding address: ${fundingAddress(key)}`);
const meta = Buffer.from(JSON.stringify({ n: 'LIL FOOT #1', c: '0x22fc5bb9810ef92db35accea463693331bcd0a8a', t: '1', l: '0x' + 'ab'.repeat(32) }));
const rows = [];
const lf = Object.values(loadCollections()).find((c) => c.slug === 'lil-foots');
if (lf) { // recursive: real HTML for LIL FOOT #96 (all 10 traits set) with a placeholder renderer id
  const idx = [5, 1, 1, 7, 5, 5, 20, 4, 3, 6], req = { tokenId: 96, lockTxHash: '0x' + 'ab'.repeat(32) };
  const html = buildItemHtml({ p5Id: P5_INSCRIPTION_ID, rendererId: 'f'.repeat(64) + 'i0', name: lf.name, tokenId: 96, idx });
  rows.push([`recursive p5.js HTML ${Buffer.byteLength(html)} B (default)`, Buffer.byteLength(html), cbor(itemMetadata(lf, req, idx)).length, HTML_TYPE.length]);
}
rows.push(['metadata only', meta.length, meta.length + 70, 16]);
const src = process.argv[2];
if (src) {
  const raw = /^https?:/.test(src) ? Buffer.from(await (await fetch(src)).arrayBuffer()) : fs.readFileSync(src);
  const img = await shrinkImage(raw);
  rows.push([`image ${raw.length} B → ${img.contentType} ${img.body.length} B`, img.body.length, meta.length, img.contentType.length]);
}
rows.push([`image at target ${CONFIG.imageTargetBytes} B`, CONFIG.imageTargetBytes, meta.length, 10]);
for (const [label, bodyBytes, metaBytes, typeLen] of rows) {
  const s = costSats({ bodyBytes, metaBytes, typeLen, rate });
  let cap = 'under cap'; try { assertUnderCap({ sats: s.total, rate, btcUsd: px }); } catch (e) { cap = e.message; }
  const m = breakEvenRate({ bodyBytes, metaBytes, typeLen }, px, CONFIG.cost.marginUsd), c = breakEvenRate({ bodyBytes, metaBytes, typeLen }, px, CONFIG.cost.maxUsd - 0.01);
  console.log(`  ${label}: ${s.total} sats = $${toUsd(s.total, px)}  (${cap}; hits $${CONFIG.cost.marginUsd} margin above ${m} sat/vB, $${CONFIG.cost.maxUsd} cap above ${c} sat/vB)`);
}
const plan = loadPlan('lil-foots');
if (plan) {
  const st = setupCostFromPlan(plan, rate, px);
  console.log(`  one-time collection setup (${st.inscriptions} inscriptions: ${plan.unique} WebP layers @${plan.width}px + renderer, ${st.bytes} B; p5 reused): ${st.sats} sats = $${st.usd}  [${loadManifest('lil-foots') ? 'inscribed' : 'collection setup not inscribed'}]`);
}
const recipient = bitcoin.payments.p2tr({ internalPubkey: xonly(ECPair.makeRandom({ network: NETWORK }).publicKey), network: NETWORK }).address;
try {
  const r = await inscribe({ key, recipient, contentType: 'application/json', body: meta, metadata: null, dryRun: true, rate, btcUsd: px });
  console.log(`funded: have ${r.inSum} sats; a metadata inscription needs ${r.total}`);
} catch (e) { console.log(e.message); process.exitCode = 2; }
