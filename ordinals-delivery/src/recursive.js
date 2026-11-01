// fs loaders for the Node service/CLI; the Worker build swaps this file for worker/src/recursive.worker.js.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export * from './recursive-core.js';
import { notInscribed } from './recursive-core.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const collectionsDir = () => process.env.ORDINALS_COLLECTIONS_DIR || path.join(here, '..', 'collections');
export function loadCollections(dir = collectionsDir()) {
  const out = {};
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!/^[a-z0-9-]+\.json$/.test(f) || /\.(manifest|plan|traits)\.json$/.test(f)) continue;
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
export function loadTraits(slug, dir = collectionsDir()) {
  const p = path.join(dir, `${slug}.traits.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}
export function loadPlan(slug, dir = collectionsDir()) {
  const p = path.join(dir, `${slug}.plan.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}
