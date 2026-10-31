import fs from 'node:fs';
import path from 'node:path';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';
import { ECPairFactory } from 'ecpair';
import { CONFIG } from './config.js';

bitcoin.initEccLib(ecc);
export const ECPair = ECPairFactory(ecc);
export { bitcoin };
// Signet uses the testnet address params (tb1…).
export const NETWORK = CONFIG.mainnet ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
export const keyFile = () => process.env.ORDINALS_INSCRIBER_KEY_FILE || path.join(CONFIG.dataDir, `${CONFIG.network}.key`);

/** Inscriber key: ORDINALS_INSCRIBER_WIF env, else the chmod-600 key file outside the repo. Never logged. */
export function loadKey() {
  const wif = process.env.ORDINALS_INSCRIBER_WIF || fs.readFileSync(keyFile(), 'utf8').trim();
  return ECPair.fromWIF(wif, NETWORK);
}
export const xonly = (pub) => Buffer.from(pub.subarray(1, 33));
export function fundingAddress(key) {
  return bitcoin.payments.p2tr({ internalPubkey: xonly(key.publicKey), network: NETWORK }).address;
}

/** Recipient must be a Taproot address on the configured network. */
export function assertTaprootRecipient(addr) {
  let out;
  try { out = bitcoin.address.toOutputScript(addr, NETWORK); } catch { throw Object.assign(new Error('Invalid recipient for ' + CONFIG.network), { status: 400 }); }
  if (out.length !== 34 || out[0] !== 0x51 || out[1] !== 0x20) throw Object.assign(new Error('Recipient must be a Taproot (p2tr) address'), { status: 400 });
  return out;
}

// ---- mempool.space ----
const api = (p) => `${CONFIG.mempool}${p}`;
async function getJ(p) { const r = await fetch(api(p)); if (!r.ok) throw new Error(`${r.status} ${p}`); return r.json(); }
export const feeRate = async () => Math.max(1, (await getJ('/v1/fees/recommended')).halfHourFee || 1);
export const utxos = (a) => getJ(`/address/${a}/utxo`);
export const txStatus = (txid) => getJ(`/tx/${txid}/status`);
export async function broadcast(hex) {
  const r = await fetch(api('/tx'), { method: 'POST', body: hex });
  const t = await r.text();
  if (!r.ok) throw new Error(`broadcast failed: ${t}`);
  return t.trim();
}
