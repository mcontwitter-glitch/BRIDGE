import { CONFIG, assertNetwork } from './config.js';
import { loadKey, assertTaprootRecipient, txStatus, broadcast, feeRate } from './btc.js';
import { inscribe, broadcastWithRetry, buildSweep } from './inscribe.js';
import * as store from './store.js';
import { verifyLock } from './lock.js';
import { shrinkImage } from './image.js';
import { loadCollections, loadManifest, loadTraits, notInscribed, traitIndices, buildItemHtml, itemMetadata, HTML_TYPE } from './recursive.js';

// ipfs.io / dweb.link / w3s.link now answer 429 "switching to a service worker gateway only" → try several gateways.
export const IPFS_GATEWAYS = (process.env.ORDINALS_IPFS_GATEWAYS || 'https://gateway.pinata.cloud/ipfs/,https://ipfs.io/ipfs/,https://dweb.link/ipfs/').split(',').map((g) => g.trim()).filter(Boolean);
const ipfsUrls = (u) => /^ipfs:\/\//.test(u || '') ? IPFS_GATEWAYS.map((g) => g + u.replace(/^ipfs:\/\/(ipfs\/)?/, '')) : [u];
const ipfs = (u) => ipfsUrls(u)[0] || '';
/** First OK response across gateways (with a per-try timeout). */
export async function fetchIpfs(u, fetchImpl = fetch) {
  let last;
  for (const url of ipfsUrls(u)) {
    try { const r = await fetchImpl(url, { signal: AbortSignal.timeout?.(15000) }); if (r.ok) return r; last = new Error(`${r.status} ${url}`); } catch (e) { last = e; }
  }
  throw last || new Error('no gateway');
}

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
  let fetchErr = '';
  const pinned = mode === 'recursive' && (() => { const c = loadCollections(dir)[String(req.collection || '').toLowerCase()]; return c && loadTraits(c.slug, dir)[String(Number(req.tokenId))]; })();
  if (pinned) meta.attributes = pinned;
  else if (req.tokenURI) {
    try { const r = await fetchIpfs(req.tokenURI, fetchImpl); { const j = await r.json(); meta = { name: j.name || meta.name, image: j.image || meta.image, attributes: j.attributes || meta.attributes }; } } catch (e) { fetchErr = e.message; }
  }
  if (mode === 'recursive') {
    const { c, m } = recursiveSetup(req.collection, { dir });
    if (!meta.attributes) throw Object.assign(new Error(`token attributes unavailable (tokenURI ${req.tokenURI ? 'unreadable: ' + req.tokenURI + (fetchErr ? ' — ' + fetchErr : '') : 'missing'})`), { status: 502 });
    const idx = traitIndices(c, meta.attributes);
    const body = Buffer.from(buildItemHtml({ p5Id: m.p5Id, rendererId: m.rendererId, name: c.name, tokenId: req.tokenId, idx }));
    return { contentType: HTML_TYPE, body, metadata: itemMetadata(c, req, idx), mode };
  }
  // Compact metadata (CBOR, tag 5): short keys only.
  const metadata = { n: meta.name || `#${req.tokenId}`, c: String(req.collection).toLowerCase(), t: String(req.tokenId), l: req.lockTxHash };
  if (mode === 'image' && meta.image) {
    try {
      const r = await fetchIpfs(meta.image, fetchImpl);
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
  const isUsed = deps.isUsed || ((k) => store.isUsed(k)) // NOT inFlight: startDelivery adds the key before checkLock, which made every new lock 409;
  if (CONFIG.lock.skip) { if (isUsed(String(req.lockTxHash).toLowerCase())) throw Object.assign(new Error('lockTxHash already used for a delivery'), { status: 409 }); return { lockId: req.lockId || null, skipped: true }; }
  return verifyLock(req, { ...deps, isUsed });
}

/** Newest record for a lock tx hash (or lockId), or null. */
export const findByLock = (k) => { k = String(k || '').toLowerCase(); return store.list().filter((r) => r.lockTxHash?.toLowerCase() === k || r.lockId?.toLowerCase() === k).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null; };

/**
 * Same lock POSTed again: return the existing record. A 'failed' record that never got a commit signed is re-queued
 * (lock re-verified, tokenURI refreshed). Anything with a commitTxid is left to the reveal/sweep recovery path → never double-inscribes.
 */
export async function resumeExisting(rec, req, deps = {}) {
  if (rec.status !== 'failed' || rec.commitTxid || rec.commitHex || rec.revealHex) return rec;
  if (String(req.recipient || '') !== rec.recipient || String(req.tokenId) !== String(rec.tokenId) || String(req.collection || '').toLowerCase() !== String(rec.collection || '').toLowerCase())
    throw Object.assign(new Error('lockTxHash already used for a delivery to a different recipient/token'), { status: 409 });
  const lock = CONFIG.lock.skip ? { tokenURI: '' } : await verifyLock(req, { ...deps, isUsed: () => false }); // still active + commits to this recipient
  const r = rec.req || {};
  const tokenURI = r.tokenURI || req.tokenURI || lock.tokenURI || '';
  return store.patch(rec.id, { status: 'queued', waiting: 'Retrying after: ' + (rec.error || 'failure'), lastError: rec.error, error: undefined, content: undefined, retries: (rec.retries || 0) + 1,
    req: { ...r, tokenURI, attributes: r.attributes || req.attributes } });
}

export async function startDelivery(req, deps = {}) {
  validateRequest(req);
  const key = String(req.lockTxHash).toLowerCase();
  const existing = findByLock(key);
  if (existing) {
    if (inFlight.has(key)) throw Object.assign(new Error('lockTxHash already being processed'), { status: 409 });
    inFlight.add(key);
    let rec; try { rec = await resumeExisting(existing, req, deps); } finally { inFlight.delete(key); }
    if (RETRYABLE.includes(rec.status)) run(rec.id);
    return rec;
  }
  if (inFlight.has(key)) throw Object.assign(new Error('lockTxHash already being processed'), { status: 409 });
  if (CONFIG.mode === 'recursive') recursiveSetup(req.collection); // 503 'collection setup not inscribed' before anything else
  inFlight.add(key);
  let rec;
  try {
    const lock = await checkLock(req, deps);
    rec = store.create({ recipient: req.recipient, collection: req.collection, tokenId: String(req.tokenId), lockTxHash: key, lockId: lock.lockId, lockOwner: lock.owner, lockVerified: !lock.skipped,
      req: { attributes: req.attributes, tokenURI: req.tokenURI || lock.tokenURI || '', image: req.image || '', name: req.name || '', collection: req.collection, tokenId: String(req.tokenId), lockTxHash: key } });
  } finally { inFlight.delete(key); }
  run(rec.id);
  return rec;
}

const running = new Set();
export const MAX_REVEAL_ATTEMPTS = Number(process.env.ORDINALS_MAX_REVEAL_ATTEMPTS || 6); // × retry loop (10 min) ≈ 1 h
const RETRYABLE = ['pending', 'queued', 'revealing'];

/** Inscribe one pending/queued delivery, or finish a 'revealing' one. Over the USD cap or unfunded → 'queued' (nothing signed). */
export async function run(id, deps = {}) {
  if (running.has(id)) return store.get(id);
  running.add(id);
  try {
    const rec = store.get(id);
    if (!rec || !RETRYABLE.includes(rec.status)) return rec;
    if (rec.status === 'revealing') return await recoverReveal(rec, deps);
    const content = rec.content ? { ...rec.content, body: Buffer.from(rec.content.body, 'base64') } : await (deps.loadContent || loadContent)(rec.req);
    if (!rec.content) store.patch(id, { content: { contentType: content.contentType, body: content.body.toString('base64'), metadata: content.metadata } });
    // onCommit fires BEFORE the commit is broadcast: both signed txs are on disk, status 'revealing' until the reveal lands.
    const r = await (deps.inscribe || inscribe)({ key: (deps.loadKey || loadKey)(), recipient: rec.recipient, ...content,
      onCommit: (c) => store.patch(id, { status: 'revealing', ...c, revealAttempts: 0, waiting: undefined }) });
    return store.patch(id, { status: 'inscribed', ...r, waiting: undefined, contentType: content.contentType, bytes: content.body.length });
  } catch (e) {
    const cur = store.get(id);
    if (e.revealPending || cur?.status === 'revealing') return store.patch(id, { status: 'revealing', revealAttempts: (cur?.revealAttempts || 0) + 1, waiting: `Reveal broadcast pending (commit ${cur?.commitTxid || e.commitTxid}); retrying: ${e.message}`, lastTry: new Date().toISOString() });
    if (e.needsFunding) return store.patch(id, { status: 'queued', waiting: 'Inscriber wallet needs funding', detail: e.message, lastTry: new Date().toISOString() });
    if (e.queued) return store.patch(id, { status: 'queued', waiting: e.message, estUsd: e.usd != null ? Math.round(e.usd * 100) / 100 : undefined, lastTry: new Date().toISOString() });
    return store.patch(id, { status: 'failed', error: e.message });
  } finally { running.delete(id); }
}

/**
 * Recovery for a commit whose reveal did not land: re-broadcast the stored commit (no-op if known) and reveal.
 * After MAX_REVEAL_ATTEMPTS with a confirmed commit, sweep the commit output back to the inscriber wallet
 * (status 'swept', sweepTxid recorded, then re-queued so a fresh inscription is attempted). Funds are never dropped.
 */
export async function recoverReveal(rec, deps = {}) {
  const bc = deps.broadcast || broadcast;
  const st = deps.txStatus || txStatus;
  const attempts = (rec.revealAttempts || 0) + 1;
  try {
    if (rec.commitHex) await broadcastWithRetry(rec.commitHex, { bcast: bc, tries: 1 });
    await broadcastWithRetry(rec.revealHex, { bcast: bc, tries: deps.revealTries ?? 2, waitMs: deps.waitMs ?? 1500 });
    return store.patch(rec.id, { status: 'inscribed', inscriptionId: `${rec.revealTxid}i0`, revealAttempts: attempts, waiting: undefined, recovered: true });
  } catch (e) {
    let commitConfirmed = false; try { commitConfirmed = !!(await st(rec.commitTxid)).confirmed; } catch {}
    if (attempts >= MAX_REVEAL_ATTEMPTS && commitConfirmed && rec.leafHex) {
      const sw = buildSweep({ key: (deps.loadKey || loadKey)(), commitTxid: rec.commitTxid, commitValue: rec.commitValue, leafHex: rec.leafHex, rate: await (deps.feeRate || feeRate)() });
      store.patch(rec.id, { status: 'sweeping', sweepHex: sw.hex, sweepTxid: sw.txid, revealAttempts: attempts, revealError: e.message });
      await broadcastWithRetry(sw.hex, { bcast: bc, tries: 2, waitMs: deps.waitMs ?? 1500 }); // throws → stays 'sweeping' (hex on disk), see refresh/retry
      // Funds are back in the wallet; queue a fresh inscription attempt (new commit/reveal) on the next loop.
      return store.patch(rec.id, { status: 'queued', waiting: `Reveal failed ${attempts}×; commit swept back to the inscriber wallet (${sw.txid}). Retrying inscription.`,
        swept: [...(rec.swept || []), { commitTxid: rec.commitTxid, sweepTxid: sw.txid }], commitTxid: undefined, commitHex: undefined, revealTxid: undefined, revealHex: undefined, leafHex: undefined, revealAttempts: 0 });
    }
    return store.patch(rec.id, { status: 'revealing', revealAttempts: attempts, waiting: `Reveal broadcast pending (commit ${rec.commitTxid}); retrying: ${e.message}`, lastTry: new Date().toISOString() });
  }
}
/** Broadcast a stored sweep that did not go out yet. */
export async function retrySweep(rec, deps = {}) {
  try { await broadcastWithRetry(rec.sweepHex, { bcast: deps.broadcast || broadcast, tries: 1 }); }
  catch (e) { return store.patch(rec.id, { waiting: `Sweep ${rec.sweepTxid} broadcast pending: ${e.message}`, lastTry: new Date().toISOString() }); }
  return store.patch(rec.id, { status: 'queued', waiting: `Commit swept back to the inscriber wallet (${rec.sweepTxid}). Retrying inscription.`,
    swept: [...(rec.swept || []), { commitTxid: rec.commitTxid, sweepTxid: rec.sweepTxid }], commitTxid: undefined, commitHex: undefined, revealTxid: undefined, revealHex: undefined, leafHex: undefined, revealAttempts: 0 });
}
export async function retryQueued(deps) {
  for (const r of store.list()) {
    if (r.status === 'sweeping') await retrySweep(r, deps);
    else if (['queued', 'revealing'].includes(r.status)) await run(r.id, deps);
  }
}

/** inscribed → delivered once the reveal (which pays the recipient) confirms. */
export async function refresh(id) {
  const rec = store.get(id);
  if (rec?.status === 'inscribed' && rec.revealTxid) {
    try { if ((await txStatus(rec.revealTxid)).confirmed) return store.patch(id, { status: 'delivered' }); } catch {}
  }
  return rec;
}
