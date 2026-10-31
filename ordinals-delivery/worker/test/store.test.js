import test from 'node:test'; import assert from 'node:assert';
import * as store from '../src/store.worker.js';
// Fake of the SQLite-backed ctx.storage.kv (sync get/put/list).
const m = new Map(); store.bind({ get: (k) => m.get(k), put: (k, v) => m.set(k, structuredClone(v)), list: ({ prefix }) => [...m].filter(([k]) => k.startsWith(prefix)) });
test('DO store: create / patch (drops undefined) / list / isUsed — same API as the file store', () => {
  const r = store.create({ lockTxHash: '0xabc', lockId: '0xid' });
  assert.match(r.id, /^ord_[0-9a-f]{16}$/); assert.strictEqual(r.status, 'pending');
  const p = store.patch(r.id, { status: 'revealing', revealHex: 'ff', waiting: undefined });
  assert.strictEqual(store.get(r.id).revealHex, 'ff'); assert.ok(!('waiting' in p));
  assert.strictEqual(store.list().length, 1); assert.ok(store.isUsed('0xabc')); assert.ok(store.isUsed('0xid')); assert.ok(!store.isUsed('0xdef'));
});
