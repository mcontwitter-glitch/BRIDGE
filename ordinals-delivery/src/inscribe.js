// Commit/reveal Ordinal inscription (Taproot script path), reveal output paid to the recipient.
import { bitcoin, NETWORK, xonly, fundingAddress, assertTaprootRecipient, feeRate, utxos, broadcast } from './btc.js';
import { CONFIG } from './config.js';
import { revealVsize, commitVsize, assertUnderCap } from './cost.js';
import { btcUsd as fetchBtcUsd } from './btc.js';

const OP = bitcoin.opcodes;
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
  const parts = [push(pubXonly), Buffer.from([OP.OP_CHECKSIG, OP.OP_0, OP.OP_IF]), push(Buffer.from('ord')), push(Buffer.from([1])), push(Buffer.from(contentType))];
  if (metadata) for (const c of chunks(cbor(metadata))) parts.push(push(Buffer.from([5])), push(c));
  parts.push(Buffer.from([OP.OP_0]));
  for (const c of chunks(body)) parts.push(push(c));
  parts.push(Buffer.from([OP.OP_ENDIF]));
  return Buffer.concat(parts);
}

export async function inscribe({ key, recipient, contentType, body, metadata, onCommit, dryRun = false, rate: rateIn, btcUsd: usdIn }) {
  if (body.length > CONFIG.maxBodyBytes) throw new Error(`Body too large (${body.length} B)`);
  const recipientScript = assertTaprootRecipient(recipient);
  const pub = xonly(key.publicKey);
  const leaf = envelope(pub, contentType, body, metadata);
  const tree = { output: leaf };
  const redeem = { output: leaf, redeemVersion: 0xc0 };
  const commitPay = bitcoin.payments.p2tr({ internalPubkey: pub, scriptTree: tree, redeem, network: NETWORK });
  const rate = rateIn ?? await feeRate();
  const btcUsd = usdIn ?? await fetchBtcUsd();
  const revealFee = Math.ceil(revealVsize(leaf.length) * rate) + 50;
  const commitValue = CONFIG.postageSats + revealFee;

  // Commit: spend the inscriber's key-path p2tr UTXOs.
  const fundAddr = fundingAddress(key);
  const fundScript = bitcoin.address.toOutputScript(fundAddr, NETWORK);
  const list = (await utxos(fundAddr)).filter((u) => u.status?.confirmed).sort((a, b) => b.value - a.value);
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
  if (inSum < commitValue + commitFee) throw Object.assign(new Error(`Inscriber wallet underfunded: need ${commitValue + commitFee} sats confirmed at ${fundAddr}, have ${inSum}`), { status: 503 });
  if (dryRun) return { dryRun: true, feeRate: rate, btcUsd, usd, commitFee, revealFee, postage: CONFIG.postageSats, total: commitValue + commitFee, fundAddr, inSum };
  psbt.addOutput({ address: commitPay.address, value: commitValue });
  const change = inSum - commitValue - commitFee;
  if (change >= 546) psbt.addOutput({ address: fundAddr, value: change });
  const tweaked = key.tweak(bitcoin.crypto.taggedHash('TapTweak', pub));
  psbt.signAllInputs(tweaked);
  psbt.finalizeAllInputs();
  const commitTx = psbt.extractTransaction();
  const commitTxid = await broadcast(commitTx.toHex());
  await onCommit?.(commitTxid);

  // Reveal: script-path spend of the commit output, inscription lands on sat 0 of output 0 → recipient.
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
  const revealTxid = await broadcast(reveal.extractTransaction().toHex());
  return { commitTxid, revealTxid, inscriptionId: `${revealTxid}i0`, feeRate: rate, costSats: commitValue + commitFee, costUsd: Math.round(usd * 100) / 100 };
}
