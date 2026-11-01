// Public, read-only listing of bridged Ordinals for one collection (used by MultiSea).
// Only public on-chain fields are exposed: no tx hex, no keys, no errors, no internal state.
const ADDR = /^0x[0-9a-f]{40}$/;
/** Resolve a slug ("lil-foots") or EVM contract address to the set of keys a record's `collection` may hold. */
export function collectionKeys(param, collections) {
  const p = String(param || '').toLowerCase();
  const c = Object.values(collections || {}).find((x) => x.slug === p || String(x.collection).toLowerCase() === p);
  if (!c) return ADDR.test(p) ? new Set([p]) : null;
  return new Set([c.slug, String(c.collection).toLowerCase()]);
}
/** Delivered (or inscribed, reveal broadcast) records for a collection, newest first. */
export function listInscriptions(records, param, collections) {
  const keys = collectionKeys(param, collections);
  if (!keys) return null;
  const c = Object.values(collections || {}).find((x) => keys.has(x.slug));
  const items = records
    .filter((r) => keys.has(String(r.collection || '').toLowerCase()) && r.inscriptionId && ['inscribed', 'delivered'].includes(r.status))
    .map((r) => ({ tokenId: String(r.tokenId), inscriptionId: r.inscriptionId, recipient: r.recipient, revealTxid: r.revealTxid,
      status: r.status, deliveredAt: r.updatedAt || r.createdAt, network: r.network }))
    .sort((a, b) => String(b.deliveredAt).localeCompare(String(a.deliveredAt)));
  return { collection: c ? c.slug : String(param).toLowerCase(), contract: c ? String(c.collection).toLowerCase() : String(param).toLowerCase(), count: items.length, items };
}
export const COLLECTION_ROUTE = /^\/api\/ordinals\/collections\/([a-z0-9-]{1,64}|0x[0-9a-fA-F]{40})\/inscriptions$/;
