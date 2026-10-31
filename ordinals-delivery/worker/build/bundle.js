// Bundles the Node service for workerd: store/recursive/image are swapped for Worker shims; everything else is shared code.
import * as esbuild from 'esbuild'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const shim = { './store.js': 'store.worker.js', './recursive.js': 'recursive.worker.js', './image.js': 'image.worker.js' };
await esbuild.build({
  entryPoints: [path.join(here, '..', 'src', 'index.js')], outfile: path.join(here, '..', 'dist', 'index.js'),
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', mainFields: ['module', 'main'], conditions: ['workerd', 'worker', 'import'],
  external: ['node:*', 'cloudflare:*'], logLevel: 'warning',
  // CommonJS deps (safe-buffer, randombytes…) call require('buffer'/'crypto'): give them the nodejs_compat modules.
  banner: { js: "import * as __nb from 'node:buffer'; import * as __nc from 'node:crypto'; const require = (m) => { const r = { 'node:buffer': __nb, 'node:crypto': __nc }[m]; if (!r) throw new Error('require ' + m); return r; };" },
  plugins: [{ name: 'worker-shims', setup(b) {
    b.onResolve({ filter: /^\.\/(store|recursive|image)\.js$/ }, (a) => a.importer.includes(`${path.sep}src${path.sep}`) && !a.importer.includes(`worker${path.sep}src`) ? { path: path.join(here, '..', 'src', shim[a.path]) } : undefined);
    // No filesystem in Workers: btc.js only reads a key file when ORDINALS_INSCRIBER_WIF is unset → fail loudly instead.
    b.onResolve({ filter: /^(node:)?fs$/ }, () => ({ path: 'fs-stub', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: "const no = () => { throw new Error('no filesystem in the Worker: set the ORDINALS_INSCRIBER_WIF secret'); }; export const readFileSync = no, existsSync = () => false, writeFileSync = no, mkdirSync = no, readdirSync = () => []; export default { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync };", loader: 'js' }));
    // Node built-ins used by bitcoinjs deps without the node: prefix.
    b.onResolve({ filter: /^(buffer|crypto|stream|events|util|assert|path|url)$/ }, (a) => ({ path: 'node:' + a.path, external: true }));
  } }],
});
console.log('bundled → dist/index.js');
