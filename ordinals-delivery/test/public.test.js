import test from 'node:test'; import assert from 'node:assert';
import { listInscriptions, COLLECTION_ROUTE } from '../src/public.js';
const cols = { '0x22fc5bb9810ef92db35accea463693331bcd0a8a': { slug: 'lil-foots', collection: '0x22fc5bb9810ef92db35accea463693331bcd0a8a' } };
const ins = '87c187cbfa3106e64cc82e2846ee652c6002c31b95c78d1ef15f136bf94dd885i0';
const recs = [
  { id: 'ord_1', collection: '0x22FC5BB9810EF92DB35ACCEA463693331BCD0A8A', tokenId: 3973, status: 'delivered', inscriptionId: ins, revealTxid: ins.slice(0, 64), recipient: 'bc1pqhkw', updatedAt: '2026-10-31T00:00:00Z', commitHex: 'SECRETISH', network: 'mainnet' },
  { id: 'ord_2', collection: 'lil-foots', tokenId: 5, status: 'queued', recipient: 'bc1px' },
  { id: 'ord_3', collection: '0xdead000000000000000000000000000000000000', tokenId: 7, status: 'delivered', inscriptionId: 'x', recipient: 'y' },
];
test('lists only delivered public fields, by slug or address', () => {
  for (const k of ['lil-foots', '0x22fc5bb9810ef92db35accea463693331bcd0a8a']) {
    const o = listInscriptions(recs, k, cols);
    assert.strictEqual(o.count, 1); assert.strictEqual(o.collection, 'lil-foots');
    assert.deepStrictEqual(Object.keys(o.items[0]).sort(), ['deliveredAt', 'inscriptionId', 'network', 'recipient', 'revealTxid', 'status', 'tokenId']);
    assert.strictEqual(o.items[0].tokenId, '3973');
  }
  assert.strictEqual(listInscriptions(recs, 'nope', cols), null);
  assert.ok(COLLECTION_ROUTE.test('/api/ordinals/collections/lil-foots/inscriptions'));
  assert.ok(!COLLECTION_ROUTE.test('/api/ordinals/collections/../inscriptions'));
});
