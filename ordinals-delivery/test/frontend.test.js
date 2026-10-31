// Loads docs/assets/ordinals.js in a stub DOM: address validator + "no delivery service" guard.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
const src = fs.readFileSync(new URL('../../docs/assets/ordinals.js', import.meta.url), 'utf8');
function load(win = {}) {
  const el = () => ({ classList: { toggle() {} }, style: {}, appendChild() {}, setAttribute() {} });
  const document = { addEventListener() {}, documentElement: {}, querySelectorAll: () => [], querySelector: () => null, createElement: el, head: el(), body: el() };
  const window = { ...win };
  vm.runInNewContext(src, { window, document, MutationObserver: class { observe() {} }, console, setTimeout });
  return window;
}
test('front end: mainnet bc1p ok, tb1p / bc1q / legacy rejected', () => {
  const w = load(), c = w.bridgeCheckOrdinalsAddress;
  assert.strictEqual(w.bridgeOrdinalsConfig.network, 'mainnet');
  assert.ok(c('bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297').ok);
  assert.ok(!c('tb1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297').ok);
  assert.match(c('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx').msg, /Testnet|SegWit/);
  assert.match(c('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4').msg, /SegWit/);
  assert.match(c('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2').msg, /Legacy/);
  assert.strictEqual(c('bc1pxyz').level, 'error');
});
test('front end: no delivery service → submit blocked before any lock', () => {
  const w = load();
  assert.strictEqual(w.bridgeOrdinalsGate(), 'Delivery service not live yet');
  assert.strictEqual(load({ BRIDGE_ORDINALS_URL: 'https://x' }).bridgeOrdinalsGate(), 'Ordinals lock path not live yet');
  assert.strictEqual(load({ BRIDGE_ORDINALS_URL: 'https://x', BRIDGE_ORDINALS_LOCK_EID: 40999 }).bridgeOrdinalsGate(), '');
});
