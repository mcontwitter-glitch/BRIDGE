// p5.js recursive inscriptions: layers + one renderer inscribed once (setup), then a tiny HTML per item.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.js';

// Canonical p5.js v1.11.2 on mainnet (text/javascript, brotli, 197,762 B, block 877101). Verified 2026-10-31 via
// https://static.unisat.io/content/<id> → "/*! p5.js v1.11.2 November 28, 2024 */" (ordinals.com sat behind a 403 challenge).
export const P5_INSCRIPTION_ID = '13a5c8e41dfc110514b450b2f15317988c0aaf276d3dbdcca9aa3c7d0b2188a7i0';
export const HTML_TYPE = 'text/html;charset=utf-8';
export const MAX_ITEM_HTML = 600;

const here = path.dirname(fileURLToPath(import.meta.url));
export const collectionsDir = () => process.env.ORDINALS_COLLECTIONS_DIR || path.join(here, '..', 'collections');
export function loadCollections(dir = collectionsDir()) {
  const out = {};
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!/^[a-z0-9-]+\.json$/.test(f) || /\.(manifest|plan)\.json$/.test(f)) continue;
    const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    out[c.collection.toLowerCase()] = c;
  }
  return out;
}
/** Manifest written by `npm run setup:collection -- --broadcast` once every layer + the renderer are inscribed. */
export function loadManifest(slug, dir = collectionsDir()) {
  const p = path.join(dir, `${slug}.manifest.json`);
  if (!fs.existsSync(p)) return null;
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  return m.complete && m.rendererId && m.p5Id ? m : null;
}
export function notInscribed(slug) {
  return Object.assign(new Error(`collection setup not inscribed (${slug}): run setup:collection first`), { status: 503, code: 'collection_setup_not_inscribed' });
}

export const layerKey = (type, value) => `${type}/${value}`;
export const layerFile = (c, type, value) => `${c.dirs[type]}/${c.fileFix?.[value] ?? value}.png`;

/** Token attributes ([{trait_type, value}] or {type: value}) → value index per type (metadata order). */
export function traitIndices(c, attrs) {
  const map = Array.isArray(attrs) ? Object.fromEntries(attrs.map((a) => [a.trait_type, String(a.value)])) : attrs || {};
  return c.types.map((t, k) => {
    const v = map[t] ?? c.none; const i = c.vals[k].indexOf(v);
    if (i < 0) throw Object.assign(new Error(`unknown trait ${t}=${v}`), { status: 422 });
    return i;
  });
}

/** Shared renderer (inscribed once, text/javascript): L[type][valueIndex] = layer inscription id ('' = none). */
export function buildRenderer(c, ids) {
  const L = c.types.map((t, k) => c.vals[k].map((v) => (v === c.none ? '' : ids[layerKey(t, v)] || '')));
  const D = c.drawOrder.map((t) => c.types.indexOf(t));
  return `var L=${JSON.stringify(L)},D=${JSON.stringify(D)};function go(t,v){new p5(function(p){var m=[];p.preload=function(){D.forEach(function(k){var i=L[k][v[k]];i&&m.push(p.loadImage('/content/'+i))})};p.setup=function(){var s=Math.min(innerWidth,innerHeight);p.createCanvas(s,s);p.pixelDensity(1);p.noLoop()};p.draw=function(){m.forEach(function(i){p.image(i,0,0,p.width,p.height)})}})}`;
}

/** Per-item HTML (< 600 B): loads p5 + renderer by /content/<id>, embeds tokenId and the trait indices. */
export function buildItemHtml({ p5Id, rendererId, name, tokenId, idx }) {
  const t = String(Number(tokenId));
  const html = `<!doctype html><meta charset=utf-8><title>${name}${t}</title><style>body{margin:0;background:#000;display:grid;place-items:center;height:100vh}</style><script src=/content/${p5Id}></script><script src=/content/${rendererId}></script><script>go(${t},[${idx.join(',')}])</script>`;
  if (Buffer.byteLength(html) >= MAX_ITEM_HTML) throw new Error(`item HTML ${Buffer.byteLength(html)} B ≥ ${MAX_ITEM_HTML}`);
  return html;
}
/** Compact CBOR metadata for a recursive item: readable trait names live on-chain next to the HTML. */
export const itemMetadata = (c, req, idx) => ({ n: `${c.name}${req.tokenId}`, c: c.collection, t: String(req.tokenId), l: req.lockTxHash,
  a: Object.fromEntries(c.types.map((t, k) => [t, c.vals[k][idx[k]]]).filter(([, v]) => v !== c.none)) });
export function loadPlan(slug, dir = collectionsDir()) {
  const p = path.join(dir, `${slug}.plan.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}
