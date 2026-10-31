import test from 'node:test';
import assert from 'node:assert';
import { assertNetwork } from '../src/config.js';
import { assertTaprootRecipient, ECPair, NETWORK, xonly, bitcoin } from '../src/btc.js';
import { envelope, cbor } from '../src/inscribe.js';

test('mainnet hard-blocked', () => {
  assert.throws(() => assertNetwork('mainnet'), /disabled/);
  assert.doesNotThrow(() => assertNetwork('signet'));
});
test('recipient must be signet taproot', () => {
  const k = ECPair.makeRandom({ network: NETWORK });
  const tb1p = bitcoin.payments.p2tr({ internalPubkey: xonly(k.publicKey), network: NETWORK }).address;
  const tb1q = bitcoin.payments.p2wpkh({ pubkey: k.publicKey, network: NETWORK }).address;
  const bc1p = bitcoin.payments.p2tr({ internalPubkey: xonly(k.publicKey), network: bitcoin.networks.bitcoin }).address;
  assert.doesNotThrow(() => assertTaprootRecipient(tb1p));
  assert.throws(() => assertTaprootRecipient(tb1q));
  assert.throws(() => assertTaprootRecipient(bc1p));
});
test('envelope shape', () => {
  const s = envelope(Buffer.alloc(32, 1), 'text/plain', Buffer.from('hi'), { name: 'x' });
  const asm = bitcoin.script.toASM(s);
  assert.match(asm, /OP_CHECKSIG OP_0 OP_IF 6f7264 OP_1 746578742f706c61696e OP_5 /);
  assert.ok(asm.endsWith('6869 OP_ENDIF'));
  assert.deepStrictEqual([...cbor({ a: 1 })], [0xa1, 0x61, 0x61, 0x01]);
});
