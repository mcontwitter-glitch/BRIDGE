import { CONFIG, assertNetwork } from './config.js';
import { loadKey, assertTaprootRecipient, txStatus } from './btc.js';
import { inscribe } from './inscribe.js';
import * as store from './store.js';
import { verifyLock } from './lock.js';
import { shrinkImage } from './image.js';
import { loadCollections, loadManifest, notInscribed, traitIndices, buildItemHtml, itemMetadata, HTML_TYPE } from './recursive.js';

const ipfs = (u) => (u || '').replace(/^ipfs:\/\//, 'https://ipfs.io/ipfs/');

/** Recursive mode needs the collection definition AND a complete setup manifest; otherwise nothing is inscribed. */
export function recursiveSetup(collection, { dir } = {}) {
  const c = loadCollections(dir)[String(collection || '').toLowerCase()];
  const m = c && loadManifest(c.slug, dir);
  if (!m) throw notInscribed(c?.slug || String(collection));
  return { c, m };
}

/** Content to inscribe, by mode: recursive (default) → p5.js HTML < 600 B; image → shrunk image (≤ ~20 KB); metadata → compact JSON. */
export async function loadContent(req, { fetchImpl = fetch, mode = CONFIG.mode, dir } = {}) {
  let meta = { name: req.name, image: req.image, attributes: req.attributes };
  if (req.tokenURI) {
    try { const r = await fetchImpl(ipfs(req.tokenURI)); if (r.ok) { const j = await r.json(); meta = { name: j.name || meta.name, image: j.image || meta.image, attributes: j.attributes || meta.attributes }; } } catch {}
  }
  if (mode === 'recursive') {
    const { c, m } = recursiveSetup(req.collection, { dir });
    if (!meta.attributes) throw Object.assign(new Error('token attributes unavailable (tokenURI unreadable)'), { status: 502 });
    const idx = traitIndices(c, meta.attributes);
    const body = Buffer.from(buildItemHtml({ p5Id: m.p5Id, rendererId: m.rendererId, name: c.name, tokenId: req.tokenId, idx }));
    return { contentType: HTML_TYPE, body, metadata: itemMetadata(c, req, idx), mode };
  }
  // Compact metadata (CBOR, tag 5): short keys only.
  const metadata = { n: meta.name || `#${req.tokenId}`, c: String(req.collection).toLowerCase(), t: String(req.tokenId), l: req.lockTxHash };
  if (mode === 'image' && meta.image) {
    try {
      const r = await fetchImpl(ipfs(meta.image));
      const body = Buffer.from(await r.arrayBuffer());
      const img = r.ok ? await shrinkImage(body) : null;
      if (img) return { contentType: img.contentType, body: img.body, metadata };
    } catch {}
  }
  return { contentType: 'application/json', body: Buffer.from(JSON.stringify({ ...metadata, i: meta.image })), metadata };
}

export function validateRequest(req) {
  if (!req || req.dest !== 'ordinals') throw Object.assign(new Error('dest must be ordinals'), { status: 400 });
  assertNetwork(req.network);
  assertTaprootRecipient(String(req.recipient || ''));
  if (!req.collection || req.tokenId === undefined || !req.lockTxHash) throw Object.assign(new Error('collection, tokenId, lockTxHash required'), { status: 400 });
  if (!CONFIG.mainnet && req.test !== true) throw Object.assign(new Error('signet test requests must set test:true'), { status: 400 });
}

let inFlight = new Set();
/** Verifies the Abstract lock (see lock.js); signet-only runs may skip it with ORDINALS_SKIP_LOCK_CHECK=1. */
export async function checkLock(req, deps = {}) {
  const isUsed = deps.isUsed || ((k) => inFlight.has(k) || store.isUsed(k));
  if (CONFIG.lock.skip) { if (isUsed(String(req.lockTxHash).toLowerCase())) throw Object.assign(new Error('lockTxHash already used for a delivery'), { status: 409 }); return { lockId: req.lockId || null, skipped: true }; }
  return verifyLock(req, { ...deps, isUsed });
}

export async function startDelivery(req) {
  validateRequest(req);
  const key = String(req.lockTxHash).toLowerCase();
  if (inFlight.has(key)) throw Object.assign(new Error('lockTxHash already being processed'), { status: 409 });
  if (CONFIG.mode === 'recursive') recursiveSetup(req.collection); // 503 'collection setup not inscribed' before anything else
  inFlight.add(key);
  let rec;
  try {
    const lock = await checkLock(req);
    rec = store.create({ recipient: req.recipient, collection: req.collection, tokenId: String(req.tokenId), lockTxHash: key, lockId: lock.lockId, lockOwner: lock.owner, lockVerified: !lock.skipped,
      req: { attributes: req.attributes, tokenURI: req.tokenURI || lock.tokenURI || '', image: req.image || '', name: req.name || '', collection: req.collection, tokenId: String(req.tokenId), lockTxHash: key } });
  } finally { inFlight.delete(key); }
  run(rec.id);
  return rec;
}

const running = new Set();
/** Inscribe one pending/queued delivery. Over the USD cap → stays 'queued' (nothing signed); retried by retryQueued(). */
export async function run(id, deps = {}) {
  if (running.has(id)) return store.get(id);
  running.add(id);
  try {
    const rec = store.get(id);
    if (!rec || !['pending', 'queued'].includes(rec.status)) return rec;
    const content = rec.content ? { ...rec.content, body: Buffer.from(rec.content.body, 'base64') } : await (deps.loadContent || loadContent)(rec.req);
    if (!rec.content) store.patch(id, { content: { contentType: content.contentType, body: content.body.toString('base64'), metadata: content.metadata } });
    const r = await (deps.inscribe || inscribe)({ key: (deps.loadKey || loadKey)(), recipient: rec.recipient, ...content, onCommit: (commitTxid) => store.patch(id, { commitTxid }) });
    return store.patch(id, { status: 'inscribed', ...r, waiting: undefined, contentType: content.contentType, bytes: content.body.length });
  } catch (e) {
    if (e.queued) return store.patch(id, { status: 'queued', waiting: e.message, estUsd: e.usd != null ? Math.round(e.usd * 100) / 100 : undefined, lastTry: new Date().toISOString() });
    return store.patch(id, { status: 'failed', error: e.message });
  } finally { running.delete(id); }
}
export async function retryQueued(deps) {
  for (const r of store.list().filter((x) => x.status === 'queued')) await run(r.id, deps);
}

/** inscribed → delivered once the reveal (which pays the recipient) confirms. */
export async function refresh(id) {
  const rec = store.get(id);
  if (rec?.status === 'inscribed' && rec.revealTxid) {
    try { if ((await txStatus(rec.revealTxid)).confirmed) return store.patch(id, { status: 'delivered' }); } catch {}
  }
  return rec;
}
