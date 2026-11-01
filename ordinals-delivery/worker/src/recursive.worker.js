// Worker replacement for ../../src/recursive.js: same exports, data baked at build time (no fs).
export * from '../../src/recursive-core.js';
import data from './collections.gen.js';
export const collectionsDir = () => '(bundled)';
export const loadCollections = () => data.collections;
export function loadManifest(slug) { const m = data.manifests[slug]; return m && m.complete && m.rendererId && m.p5Id ? m : null; }
export const loadTraits = (slug) => data.traits?.[slug] || null;
export const loadPlan = (slug) => data.plans[slug] || null;
