// Delivery records in the Durable Object's SQLite storage (ctx.storage.kv: synchronous, strongly consistent).
// Same API as ../../src/store.js. Output gates hold every outgoing fetch (e.g. a broadcast) until earlier writes are durable,
// so "persist signed txs before broadcast" holds exactly as in the Node service.
let kv = null;
export const bind = (storageKv) => { kv = storageKv; };
const need = () => { if (!kv) throw new Error('store not bound'); return kv; };
const P = 'd:';
export const get = (id) => need().get(P + id) ?? null;
export const list = () => [...need().list({ prefix: P })].map(([, v]) => v);
export function create(fields) {
  const b = crypto.getRandomValues(new Uint8Array(8));
  const id = 'ord_' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const rec = { id, status: 'pending', network: process.env.ORDINALS_NETWORK || 'mainnet', createdAt: new Date().toISOString(), ...fields };
  need().put(P + id, rec); return rec;
}
export function patch(id, fields) {
  const rec = JSON.parse(JSON.stringify({ ...get(id), ...fields, updatedAt: new Date().toISOString() })); // drops undefined like the JSON file store
  need().put(P + id, rec); return rec;
}
export const isUsed = (key) => list().some((r) => r.lockTxHash?.toLowerCase() === key || r.lockId?.toLowerCase() === key);
