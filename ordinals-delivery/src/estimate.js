// Dry run: fee estimate + funding check against the live network. Builds nothing, signs nothing, broadcasts nothing.
// node src/estimate.js [taproot-recipient]
import { CONFIG } from './config.js';
import { loadKey, fundingAddress, feeRate, ECPair, NETWORK, xonly, bitcoin } from './btc.js';
import { inscribe } from './inscribe.js';
const key = loadKey();
const rate = await feeRate();
const sats = (bytes) => { const leafVb = Math.ceil((bytes + 200) / 4) + 110; const commit = Math.ceil(3 * 58 * rate) / 3 + Math.ceil((58 + 97) * rate) + 20; return Math.ceil(CONFIG.postageSats + Math.ceil(leafVb * rate) + 50 + commit); };
console.log(`${CONFIG.network} funding address: ${fundingAddress(key)}  fee rate (halfHourFee): ${rate} sat/vB`);
for (const b of [1_000, 20_000, CONFIG.maxBodyBytes]) console.log(`  ~${b} B inscription: ~${sats(b)} sats (incl. ${CONFIG.postageSats} postage to the user)`);
const recipient = process.argv[2] || bitcoin.payments.p2tr({ internalPubkey: xonly(ECPair.makeRandom({ network: NETWORK }).publicKey), network: NETWORK }).address;
try {
  const r = await inscribe({ key, recipient, contentType: 'application/json', body: Buffer.from(JSON.stringify({ name: 'estimate' })), metadata: { name: 'estimate' }, dryRun: true });
  console.log(`funded: have ${r.inSum} sats, small inscription needs ${r.total}`);
} catch (e) { console.log(e.message); process.exitCode = 2; }
