// Commit/reveal Ordinal inscription (Taproot script path), reveal output paid to the recipient.
import { bitcoin, NETWORK, xonly, fundingAddress, assertTaprootRecipient, feeRate, utxos, broadcast } from './btc.js';
import { CONFIG } from './config.js';
import { revealVsize, commitVsize, assertUnderCap, planBatches, batchRevealVsize } from './cost.js';
import { btcUsd as fetchBtcUsd } from './btc.js';

const OP = bitcoin.opcodes;
export const SAFE_MIN_FUNDING = 1000; // UTXOs at or below this are treated as inscription carriers, never spent as fees
function push(buf) {
  const n = buf.length;
  if (n < 0x4c) return Buffer.concat([Buffer.from([n]), buf]);
  if (n <= 0xff) return Buffer.concat([Buffer.from([0x4c, n]), buf]);
  return Buffer.concat([Buffer.from([0x4d, n & 0xff, n >> 8]), buf]);
}
const chunks = (b, n = 520) => { const o = []; for (let i = 0; i < b.length; i += n) o.push(b.subarray(i, i + n)); return o; };

// Minimal CBOR for metadata (text keys; text, int, nested map/array).
export function cbor(v) {
  const head = (major, n) => n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : n < 65536 ? Buffer.from([(major << 5) | 25, n >> 8, n & 255]) : Buffer.from([(major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return head(0, v);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, b.length), b]); }
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  if (v && typeof v === 'object') { const e = Object.entries(v).filter(([, x]) => x !== undefined && x !== null); return Buffer.concat([head(5, e.length), ...e.flatMap(([k, x]) => [cbor(k), cbor(typeof x === 'number' && !Number.isInteger(x) ? String(x) : x)])]); }
  return cbor(String(v));
}

/** <xonly> OP_CHECKSIG OP_FALSE OP_IF "ord" 01 <type> [05 <cbor>]* 00 <body>* OP_ENDIF */
export function envelope(pubXonly, contentType, body, metadata) {
  return Buffer.concat([push(pubXonly), Buffer.from([OP.OP_CHECKSIG]), envelopeOnly(contentType, body, metadata)]);
}
/** OP_FALSE OP_IF "ord" 01 <type> [05 <cbor>]* 00 <body>* OP_ENDIF (no key/checksig prefix). */
export function envelopeOnly(contentType, body, metadata) {
  const parts = [Buffer.from([OP.OP_0, OP.OP_IF]), push(Buffer.from('ord')), push(Buffer.from([1])), push(Buffer.from(contentType))];
  if (metadata) for (const c of chunks(cbor(metadata))) parts.push(push(Buffer.from([5])), push(c));
  parts.push(Buffer.from([OP.OP_0]));
  for (const c of chunks(body)) parts.push(push(c));
  parts.push(Buffer.from([OP.OP_ENDIF]));
  return Buffer.concat(parts);
}

export async function inscribe({ key, recipient, contentType, body, metadata, onCommit, onBroadcast, dryRun = false, rate: rateIn, btcUsd: usdIn, deps = {} }) {
  const bcast = deps.broadcast || broadcast, revealTries = deps.revealTries ?? 3;
  if (body.length > CONFIG.maxBodyBytes) throw new Error(`Body too large (${body.length} B)`);
  const recipientScript = assertTaprootRecipient(recipient);
  const pub = xonly(key.publicKey);
  const leaf = envelope(pub, contentType, body, metadata);
  const tree = { output: leaf };
  const redeem = { output: leaf, redeemVersion: 0xc0 };
  const commitPay = bitcoin.payments.p2tr({ internalPubkey: pub, scriptTree: tree, redeem, network: NETWORK });
  const rate = rateIn ?? await (deps.feeRate || feeRate)();
  const btcUsd = usdIn ?? await fetchBtcUsd();
  const revealFee = Math.ceil(revealVsize(leaf.length) * rate) + 50;
  const commitValue = CONFIG.postageSats + revealFee;

  // Commit: spend the inscriber's key-path p2tr UTXOs.
  const fundAddr = fundingAddress(key);
  const fundScript = bitcoin.address.toOutputScript(fundAddr, NETWORK);
  // Never fund with postage-sized outputs (they may carry inscriptions, e.g. the collection layers sent to self).
  const list = (deps.utxoList || (await (deps.utxos || utxos)(fundAddr)).filter((u) => u.status?.confirmed)).filter((u) => u.value > SAFE_MIN_FUNDING).sort((a, b) => b.value - a.value);
  const psbt = new bitcoin.Psbt({ network: NETWORK });
  let inSum = 0;
  const commitFeeFor = (n) => Math.ceil(commitVsize(n) * rate) + 20;
  for (const u of list) {
    psbt.addInput({ hash: u.txid, index: u.vout, witnessUtxo: { script: fundScript, value: u.value }, tapInternalKey: pub });
    inSum += u.value;
    if (inSum >= commitValue + commitFeeFor(psbt.inputCount) + 546) break;
  }
  const commitFee = commitFeeFor(psbt.inputCount);
  // Hard USD cap on the exact fees about to be signed (throws queued:true → nothing signed or broadcast).
  const usd = assertUnderCap({ sats: commitValue + commitFee, rate, btcUsd });
  if (inSum < commitValue + commitFee) throw Object.assign(new Error(`Inscriber wallet needs funding: need ${commitValue + commitFee} sats confirmed at ${fundAddr}, have ${inSum}`), { status: 503, queued: true, needsFunding: true, usd });
  if (dryRun) return { dryRun: true, feeRate: rate, btcUsd, usd, commitFee, revealFee, postage: CONFIG.postageSats, total: commitValue + commitFee, fundAddr, inSum };
  psbt.addOutput({ address: commitPay.address, value: commitValue });
  const change = inSum - commitValue - commitFee;
  if (change >= 546) psbt.addOutput({ address: fundAddr, value: change });
  const tweaked = key.tweak(bitcoin.crypto.taggedHash('TapTweak', pub));
  psbt.signAllInputs(tweaked);
  psbt.finalizeAllInputs();
  const commitTx = psbt.extractTransaction();
  const commitTxid = commitTx.getId();

  // Reveal is fully built + signed BEFORE the commit is broadcast (its input txid is known from the unsigned-safe commit).
  const reveal = new bitcoin.Psbt({ network: NETWORK });
  reveal.addInput({
    hash: commitTxid,
    index: 0,
    witnessUtxo: { script: commitPay.output, value: commitValue },
    tapLeafScript: [{ leafVersion: 0xc0, script: leaf, controlBlock: commitPay.witness[commitPay.witness.length - 1] }],
  });
  reveal.addOutput({ script: recipientScript, value: CONFIG.postageSats });
  reveal.signInput(0, key);
  reveal.finalizeAllInputs();
  const revealTx = reveal.extractTransaction();
  const revealHex = revealTx.toHex(), revealTxid = revealTx.getId();
  // Persist everything needed to finish (or sweep) BEFORE any broadcast → a crash can never orphan the commit output.
  await onCommit?.({ commitTxid, commitHex: commitTx.toHex(), revealTxid, revealHex, commitValue, leafHex: leaf.toString('hex') });
  await bcast(commitTx.toHex());
  await onBroadcast?.({ commitTxid });
  try { await broadcastWithRetry(revealHex, { bcast, tries: revealTries }); }
  catch (e) { throw Object.assign(new Error(`reveal broadcast failed after commit ${commitTxid}: ${e.message}`), { revealPending: true, commitTxid, revealTxid, revealHex }); }
  return { commitTxid, revealTxid, inscriptionId: `${revealTxid}i0`, feeRate: rate, costSats: commitValue + commitFee, costUsd: Math.round(usd * 100) / 100 };
}

const already = (m) => /already in block chain|txn-already-known|txn-already-in-mempool|Transaction already in/i.test(m);
/** Broadcast; "already known/mined" counts as success. Retries transient errors with backoff. */
export async function broadcastWithRetry(hex, { bcast = broadcast, tries = 3, waitMs = 1500 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await bcast(hex); } catch (e) { if (already(e.message)) return null; last = e; if (i < tries - 1) await new Promise((r) => setTimeout(r, waitMs * (i + 1))); }
  }
  throw last;
}

/**
 * Recovery: key-path sweep of a stuck commit output back to the inscriber wallet (used when the stored reveal can no
 * longer be broadcast, e.g. it was rejected as invalid). The commit address = internal key + the inscription leaf.
 */
export function buildSweep({ key, commitTxid, commitValue, leafHex, rate }) {
  const pub = xonly(key.publicKey);
  const leaf = Buffer.from(leafHex, 'hex');
  const commitPay = bitcoin.payments.p2tr({ internalPubkey: pub, scriptTree: { output: leaf }, network: NETWORK });
  const fundAddr = fundingAddress(key);
  const fee = Math.ceil(111 * rate) + 10;
  if (commitValue - fee < 330) throw new Error(`commit output ${commitValue} sats too small to sweep at ${rate} sat/vB`);
  const psbt = new bitcoin.Psbt({ network: NETWORK });
  psbt.addInput({ hash: commitTxid, index: 0, witnessUtxo: { script: commitPay.output, value: commitValue }, tapInternalKey: pub, tapMerkleRoot: commitPay.hash });
  psbt.addOutput({ address: fundAddr, value: commitValue - fee });
  psbt.signInput(0, key.tweak(bitcoin.crypto.taggedHash('TapTweak', Buffer.concat([pub, commitPay.hash]))));
  psbt.finalizeAllInputs();
  const tx = psbt.extractTransaction();
  return { hex: tx.toHex(), txid: tx.getId(), fee, to: fundAddr };
}

/**
 * Batched setup inscription (ord-style): ONE commit with one output per group, then one reveal per group whose single
 * tapscript leaf is <xonly> OP_CHECKSIG + N envelopes. No pointers → all N inscriptions sit on the first sat of the
 * reveal's single postage output; ids are <revealTxid>i0..i(N-1) in envelope order. Groups are split so each reveal
 * stays ≤ maxVsize (standard limit 100k vB). Everything is signed and handed to onCommit BEFORE any broadcast.
 * items: [{ contentType, body }]. Returns { commitTxid, reveals:[{txid,hex,vsize,ids}], ids (item order), change }.
 */
export async function inscribeBatch({ key, recipient, items, onCommit, rate: rateIn, btcUsd: usdIn, maxUsd, maxVsize = CONFIG.maxRevealVsize, dryRun = false, deps = {} }) {
  const bcast = deps.broadcast || broadcast;
  const recipientScript = assertTaprootRecipient(recipient);
  const pub = xonly(key.publicKey);
  const rate = rateIn ?? await (deps.feeRate || feeRate)();
  const btcUsd = usdIn ?? await fetchBtcUsd();
  const env = items.map((it) => envelopeOnly(it.contentType, it.body, it.metadata));
  const groups = planBatches(items.map((it) => ({ bodyBytes: it.body.length, typeLen: it.contentType.length })), maxVsize);
  const G = groups.map((idxs) => {
    const leaf = Buffer.concat([push(pub), Buffer.from([OP.OP_CHECKSIG]), ...idxs.map((i) => env[i])]);
    const pay = bitcoin.payments.p2tr({ internalPubkey: pub, scriptTree: { output: leaf }, redeem: { output: leaf, redeemVersion: 0xc0 }, network: NETWORK });
    const revealFee = Math.ceil(batchRevealVsize(leaf.length) * rate) + 50;
    return { idxs, leaf, pay, value: CONFIG.postageSats + revealFee, revealFee };
  });
  const need = G.reduce((s, g) => s + g.value, 0);
  const fundAddr = fundingAddress(key);
  const fundScript = bitcoin.address.toOutputScript(fundAddr, NETWORK);
  const list = (deps.utxoList || (await (deps.utxos || utxos)(fundAddr)).filter((u) => u.status?.confirmed)).filter((u) => u.value > SAFE_MIN_FUNDING).sort((a, b) => b.value - a.value);
  const commitFeeFor = (n) => Math.ceil(commitVsize(n, G.length + 1) * rate) + 20;
  const psbt = new bitcoin.Psbt({ network: NETWORK });
  let inSum = 0;
  for (const u of list) {
    psbt.addInput({ hash: u.txid, index: u.vout, witnessUtxo: { script: fundScript, value: u.value }, tapInternalKey: pub });
    inSum += u.value;
    if (inSum >= need + commitFeeFor(psbt.inputCount) + 546) break;
  }
  const commitFee = commitFeeFor(Math.max(1, psbt.inputCount));
  const total = need + commitFee;
  const usd = maxUsd ? assertUnderCap({ sats: total, rate, btcUsd }, { maxUsd: maxUsd + 0.01, marginUsd: maxUsd, maxFeeRate: CONFIG.cost.maxFeeRate }) : total * btcUsd / 1e8;
  const plan = { feeRate: rate, groups: G.map((g) => g.idxs.length), commitFee, revealFees: G.map((g) => g.revealFee), postage: CONFIG.postageSats, total, usd, fundAddr, inSum };
  if (inSum < total) throw Object.assign(new Error(`Inscriber wallet needs funding: need ${total} sats confirmed at ${fundAddr}, have ${inSum}`), { status: 503, needsFunding: true, plan });
  if (dryRun) return { dryRun: true, ...plan };
  for (const g of G) psbt.addOutput({ address: g.pay.address, value: g.value });
  const change = inSum - total;
  if (change >= 546) psbt.addOutput({ address: fundAddr, value: change });
  psbt.signAllInputs(key.tweak(bitcoin.crypto.taggedHash('TapTweak', pub)));
  psbt.finalizeAllInputs();
  const commitTx = psbt.extractTransaction();
  const commitTxid = commitTx.getId();
  const reveals = G.map((g, k) => {
    const r = new bitcoin.Psbt({ network: NETWORK });
    r.addInput({ hash: commitTxid, index: k, witnessUtxo: { script: g.pay.output, value: g.value },
      tapLeafScript: [{ leafVersion: 0xc0, script: g.leaf, controlBlock: g.pay.witness[g.pay.witness.length - 1] }] });
    r.addOutput({ script: recipientScript, value: CONFIG.postageSats });
    r.signInput(0, key);
    r.finalizeAllInputs();
    const tx = r.extractTransaction();
    if (tx.virtualSize() > 100_000) throw new Error(`reveal ${k} is ${tx.virtualSize()} vB (> 100k standard limit)`);
    const txid = tx.getId();
    return { txid, hex: tx.toHex(), vsize: tx.virtualSize(), ids: g.idxs.map((_, j) => `${txid}i${j}`), idxs: g.idxs };
  });
  const ids = []; for (const r of reveals) r.idxs.forEach((i, j) => { ids[i] = r.ids[j]; });
  const res = { commitTxid, commitHex: commitTx.toHex(), reveals: reveals.map(({ idxs, ...r }) => r), ids,
    change: change >= 546 ? { txid: commitTxid, vout: G.length, value: change, status: { confirmed: false } } : null, ...plan };
  await onCommit?.(res);
  await bcast(res.commitHex);
  for (const r of res.reveals) await broadcastWithRetry(r.hex, { bcast, tries: deps.revealTries ?? 3 });
  return res;
}
