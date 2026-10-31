import { CONFIG, assertNetwork } from './config.js';
import { loadKey, assertTaprootRecipient, txStatus } from './btc.js';
import { inscribe } from './inscribe.js';
import * as store from './store.js';
import { verifyLock } from './lock.js';

const ipfs = (u) => (u || '').replace(/^ipfs:\/\//, 'https://ipfs.io/ipfs/');

/** Content to inscribe: the NFT image when small enough, else the metadata JSON (image linked). */
async function loadContent(req) {
  let meta = { name: req.name, collection: req.collection, tokenId: req.tokenId, image: req.image };
  if (req.tokenURI) {
    try { const r = await fetch(ipfs(req.tokenURI)); if (r.ok) meta = { ...meta, ...(await r.json()) }; } catch {}
  }
  const metadata = { name: meta.name || `#${req.tokenId}`, collection: req.collection, tokenId: String(req.tokenId), sourceChainId: req.srcChainId, lockTx: req.lockTxHash, image: meta.image, bridge: 'bridge.bigfoot404.biz' };
  if (meta.image) {
    try {
      const r = await fetch(ipfs(meta.image));
      const type = (r.headers.get('content-type') || '').split(';')[0];
      const body = Buffer.from(await r.arrayBuffer());
      if (r.ok && type.startsWith('image/') && body.length <= CONFIG.maxBodyBytes) return { contentType: type, body, metadata };
    } catch {}
  }
  return { contentType: 'application/json', body: Buffer.from(JSON.stringify(metadata)), metadata };
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
  inFlight.add(key);
  let rec;
  try {
    const lock = await checkLock(req);
    rec = store.create({ recipient: req.recipient, collection: req.collection, tokenId: String(req.tokenId), lockTxHash: key, lockId: lock.lockId, lockOwner: lock.owner, lockVerified: !lock.skipped });
  } finally { inFlight.delete(key); }
  (async () => {
    try {
      const content = await loadContent(req);
      const r = await inscribe({ key: loadKey(), recipient: req.recipient, ...content, onCommit: (commitTxid) => store.patch(rec.id, { commitTxid }) });
      store.patch(rec.id, { status: 'inscribed', ...r, contentType: content.contentType, bytes: content.body.length });
    } catch (e) {
      store.patch(rec.id, { status: 'failed', error: e.message });
    }
  })();
  return rec;
}

/** inscribed → delivered once the reveal (which pays the recipient) confirms. */
export async function refresh(id) {
  const rec = store.get(id);
  if (rec?.status === 'inscribed' && rec.revealTxid) {
    try { if ((await txStatus(rec.revealTxid)).confirmed) return store.patch(id, { status: 'delivered' }); } catch {}
  }
  return rec;
}
