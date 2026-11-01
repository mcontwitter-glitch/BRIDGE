// POST /api/ordinals/deliveries   GET /api/ordinals/deliveries/:id   GET /api/ordinals/health
import http from 'node:http';
import { CONFIG } from './config.js';
import { startDelivery, refresh, retryQueued, findByLock } from './deliver.js';
import { liveEstimate, setupCostFromPlan } from './cost.js';
import { loadCollections, loadManifest, loadPlan } from './recursive.js';
const setupStatus = () => Object.fromEntries(Object.values(loadCollections()).map((c) => [c.slug, loadManifest(c.slug) ? 'inscribed' : 'collection setup not inscribed']));
import { feeRate, btcUsd } from './btc.js';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', ...cors }); res.end(JSON.stringify(body)); };
const pub = (r) => r && { id: r.id, lockTxHash: r.lockTxHash, tokenId: r.tokenId, createdAt: r.createdAt, updatedAt: r.updatedAt, lastError: r.lastError, sweepTxid: r.sweepTxid, status: r.status, waiting: r.waiting, estUsd: r.estUsd, costUsd: r.costUsd, network: r.network, recipient: r.recipient, commitTxid: r.commitTxid, revealTxid: r.revealTxid, inscriptionId: r.inscriptionId, error: r.error };

http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/ordinals/health') return send(res, 200, { ok: true, network: CONFIG.network, mainnet: CONFIG.mainnet, mode: CONFIG.mode, setup: setupStatus() });
    if (u.pathname === '/api/ordinals/estimate') return send(res, 200, await liveEstimate({ feeRate, btcUsd, setupEstimate: (r, px) => { const p = loadPlan('lil-foots'); return p && { ...setupCostFromPlan(p, r, px), inscribed: !!loadManifest('lil-foots') }; } }));
    if (req.method === 'POST' && u.pathname === '/api/ordinals/deliveries') {
      let raw = ''; for await (const c of req) { raw += c; if (raw.length > 20000) throw Object.assign(new Error('too large'), { status: 413 }); }
      return send(res, 202, pub(await startDelivery(JSON.parse(raw || '{}'))));
    }
    const m = /^\/api\/ordinals\/deliveries\/(ord_[0-9a-f]{16})$/.exec(u.pathname);
    if (req.method === 'GET' && m) { const r = await refresh(m[1]); return r ? send(res, 200, pub(r)) : send(res, 404, { error: 'not found' }); }
    const bl = /^\/api\/ordinals\/deliveries\/by-lock\/(0x[0-9a-fA-F]{64})$/.exec(u.pathname);
    if (req.method === 'GET' && bl) { const f = findByLock(bl[1]); const r = f && await refresh(f.id); return r ? send(res, 200, pub(r)) : send(res, 404, { error: 'not found' }); }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, e.status || 500, { error: e.message }); }
}).listen(CONFIG.port, '127.0.0.1', () => console.log(`ordinals-delivery (${CONFIG.network}, mainnet:${CONFIG.mainnet}) on 127.0.0.1:${CONFIG.port}`));
retryQueued().catch(() => {}); // finish any reveal/sweep left from a previous run on startup
setInterval(() => retryQueued().catch(() => {}), CONFIG.retryMs).unref?.();
