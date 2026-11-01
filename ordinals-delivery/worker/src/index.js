// Cloudflare Worker: HTTP API (same routes as src/server.js) + cron every 10 min → one Durable Object that owns all state.
import { DurableObject } from 'cloudflare:workers';
import * as store from './store.worker.js';
import { listInscriptions, COLLECTION_ROUTE } from '../../src/public.js';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
const json = (status, body) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors } });
const pub = (r) => r && { id: r.id, lockTxHash: r.lockTxHash, tokenId: r.tokenId, createdAt: r.createdAt, updatedAt: r.updatedAt, lastError: r.lastError, sweepTxid: r.sweepTxid, status: r.status, waiting: r.waiting, estUsd: r.estUsd, costUsd: r.costUsd, network: r.network, recipient: r.recipient, commitTxid: r.commitTxid, revealTxid: r.revealTxid, inscriptionId: r.inscriptionId, error: r.error };
const SECRET_KEYS = new Set(['ORDINALS_INSCRIBER_WIF']);

export class Deliveries extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Config modules read process.env at import time: copy string vars/secrets in before the first dynamic import.
    for (const [k, v] of Object.entries(env)) if (typeof v === 'string') process.env[k] = v;
    store.bind(ctx.storage.kv);
    this.mods = null;
  }
  async load() {
    if (!this.mods) {
      const [cfg, deliver, cost, rec, btc] = await Promise.all([import('../../src/config.js'), import('../../src/deliver.js'), import('../../src/cost.js'), import('./recursive.worker.js'), import('../../src/btc.js')]);
      this.mods = { cfg, deliver, cost, rec, btc };
    }
    return this.mods;
  }
  async fetch(req) {
    const { cfg: { CONFIG }, deliver, cost, rec, btc } = await this.load();
    const u = new URL(req.url);
    try {
      if (u.pathname === '/__cron') { await deliver.retryQueued(); return json(200, { ok: true }); }
      if (u.pathname === '/api/ordinals/health') {
        const setup = Object.fromEntries(Object.values(rec.loadCollections()).map((c) => [c.slug, rec.loadManifest(c.slug) ? 'inscribed' : 'collection setup not inscribed']));
        return json(200, { ok: true, runtime: 'cloudflare-worker', network: CONFIG.network, mainnet: CONFIG.mainnet, mode: CONFIG.mode, setup,
          sink: CONFIG.lock.sinkAddress, destEid: CONFIG.lock.destEid, keyConfigured: !!process.env.ORDINALS_INSCRIBER_WIF });
      }
      if (u.pathname === '/api/ordinals/estimate') {
        return json(200, await cost.liveEstimate({ feeRate: btc.feeRate, btcUsd: btc.btcUsd, setupEstimate: (r, px) => { const p = rec.loadPlan('lil-foots'); return p && { ...cost.setupCostFromPlan(p, r, px), inscribed: !!rec.loadManifest('lil-foots') }; } }));
      }
      if (u.pathname === '/api/ordinals/deliveries' && req.method === 'POST') {
        const raw = await req.text(); if (raw.length > 20000) return json(413, { error: 'too large' });
        if (CONFIG.lock.destEid == null) return json(503, { error: 'Ordinals destination not live yet (sink not configured)' });
        const r = await deliver.startDelivery(JSON.parse(raw || '{}'));
        if (['pending', 'queued', 'revealing'].includes(r.status)) this.ctx.waitUntil(deliver.run(r.id)); // startDelivery already kicked it off; keep the DO alive until it settles
        return json(202, pub(store.get(r.id) || r)); // same lock again → existing record (failed+no commit → re-queued)
      }
      const m = /^\/api\/ordinals\/deliveries\/(ord_[0-9a-f]{16})$/.exec(u.pathname);
      if (req.method === 'GET' && m) { const r = await deliver.refresh(m[1]); return r ? json(200, pub(r)) : json(404, { error: 'not found' }); }
      const bl = /^\/api\/ordinals\/deliveries\/by-lock\/(0x[0-9a-fA-F]{64})$/.exec(u.pathname);
      if (req.method === 'GET' && bl) { const f = deliver.findByLock(bl[1]); const r = f && await deliver.refresh(f.id); return r ? json(200, pub(r)) : json(404, { error: 'not found' }); }
      const cr = COLLECTION_ROUTE.exec(u.pathname);
      if (req.method === 'GET' && cr) { const out = listInscriptions(store.list(), cr[1], rec.loadCollections()); return out ? new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60', ...cors } }) : json(404, { error: 'unknown collection' }); }
      if (u.pathname === '/__selftest' && this.env.ORDINALS_SELFTEST === '1') return json(200, await selftest(btc));
      return json(404, { error: 'not found' });
    } catch (e) { return json(e.status || 500, { error: e.message }); }
  }
}

/** Dev-only (ORDINALS_SELFTEST=1, never set in production): proves Taproot key derivation + Schnorr signing run in workerd. Random throwaway key. */
async function selftest(btc) {
  const { buildSweep } = await import('../../src/inscribe.js');
  const key = btc.ECPair.makeRandom({ network: btc.NETWORK });
  const leaf = btc.bitcoin.script.compile([btc.xonly(key.publicKey), btc.bitcoin.opcodes.OP_CHECKSIG]);
  const sw = buildSweep({ key, commitTxid: 'ab'.repeat(32), commitValue: 10_000, leafHex: leaf.toString('hex'), rate: 2 });
  const tx = btc.bitcoin.Transaction.fromHex(sw.hex);
  return { ok: tx.ins[0].witness[0].length === 64, txid: sw.txid, fundingAddressPrefix: btc.fundingAddress(key).slice(0, 4) };
}

const stub = (env) => env.DELIVERIES.get(env.DELIVERIES.idFromName('ordinals-mainnet'));
export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const u = new URL(req.url);
    if (u.pathname.startsWith('/__cron')) return json(404, { error: 'not found' }); // cron path is internal only
    if (!u.pathname.startsWith('/api/ordinals/') && u.pathname !== '/__selftest') return json(404, { error: 'not found' });
    return stub(env).fetch(req);
  },
  async scheduled(_ev, env, ctx) { ctx.waitUntil(stub(env).fetch('https://do/__cron')); },
};
