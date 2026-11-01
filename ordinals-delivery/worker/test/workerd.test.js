// Boots the bundled Worker in local workerd (wrangler dev --local) — no deploy, no secrets, no BTC; mempool reads only.
import test from 'node:test'; import assert from 'node:assert'; import { spawn } from 'node:child_process';
const PORT = 8811; // 8791 / 8797 are reserved for other services
async function boot(vars) {
  const args = ['wrangler', 'dev', '--local', '--port', String(PORT), '--test-scheduled', ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])];
  const p = spawn('npx', args, { cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore', detached: true });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/api/ordinals/health`)).ok) return p; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  process.kill(-p.pid); throw new Error('wrangler dev did not start');
}
const stop = (p) => { try { process.kill(-p.pid, 'SIGTERM'); } catch {} return new Promise((r) => setTimeout(r, 1500)); };
const U = (p) => `http://127.0.0.1:${PORT}${p}`;
const post = (b) => fetch(U('/api/ordinals/deliveries'), { method: 'POST', body: JSON.stringify(b) });

test('workerd: gated until the sink is configured; health/estimate/cron; Schnorr signing works', async () => {
  const p = await boot({ ORDINALS_SELFTEST: '1', ORDINALS_SINK_ADDRESS: '' }); // override the wrangler.toml sink → gated
  try {
    const h = await (await fetch(U('/api/ordinals/health'))).json();
    assert.deepStrictEqual([h.runtime, h.mainnet, h.mode, h.sink, h.destEid, h.keyConfigured], ['cloudflare-worker', true, 'recursive', null, null, false]);
    assert.strictEqual(h.setup['lil-foots'], 'inscribed');
    const r = await post({ dest: 'ordinals' }); assert.strictEqual(r.status, 503); assert.match((await r.json()).error, /not live/);
    const st = await (await fetch(U('/__selftest'))).json(); assert.strictEqual(st.ok, true); assert.strictEqual(st.fundingAddressPrefix, 'bc1p');
    assert.strictEqual((await fetch(U('/__cron'))).status, 404, 'cron path not reachable from outside');
    assert.strictEqual(await (await fetch(U('/cdn-cgi/handler/scheduled?cron=*/10+*+*+*+*'))).text(), 'ok');
    const e = await fetch(U('/api/ordinals/estimate')); if (e.ok) { const j = await e.json(); assert.strictEqual(j.maxUsd, 20); assert.ok(j.recursive.bytes < 600); }
  } finally { await stop(p); }
});

test('workerd: with a sink set, bad requests are rejected and recursive needs the setup manifest (nothing signed)', async () => {
  const p = await boot({ ORDINALS_SINK_ADDRESS: '0x' + '11'.repeat(20) });
  try {
    const h = await (await fetch(U('/api/ordinals/health'))).json(); assert.strictEqual(h.destEid, 30110);
    assert.strictEqual((await fetch(U('/__selftest'))).status, 404, 'selftest off by default');
    let r = await post({ dest: 'ordinals', network: 'mainnet', recipient: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', collection: 'x', tokenId: 1, lockTxHash: '0x' + '22'.repeat(32) });
    assert.strictEqual(r.status, 400);
    r = await post({ dest: 'ordinals', network: 'mainnet', recipient: 'bc1pua8xnvy6cx7g632g3rx8gy5z9qg5s446d267gkzgenmsd6ewkwasrsmmg9', collection: 'lil-foots', tokenId: 1, lockTxHash: '0x' + '22'.repeat(32) });
    assert.strictEqual(r.status, 503); assert.match((await r.json()).error, /collection setup not inscribed/);
    assert.strictEqual((await fetch(U('/api/ordinals/deliveries/ord_0000000000000000'))).status, 404);
  } finally { await stop(p); }
});
