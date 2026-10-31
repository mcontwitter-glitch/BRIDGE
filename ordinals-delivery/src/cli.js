// node src/cli.js <taproot-recipient> <collection 0x…> <tokenId> <lockTxHash>  — one delivery, prints txids.
// Mainnet requires a verified Abstract lock. Signet tests may set ORDINALS_SKIP_LOCK_CHECK=1.
import { CONFIG } from './config.js';
import { startDelivery, refresh } from './deliver.js';
const [recipient, collection = '0x0000000000000000000000000000000000000001', tokenId = '1', lockTxHash = '0x' + Date.now().toString(16).padStart(64, '0')] = process.argv.slice(2);
try {
  const rec = await startDelivery({ dest: 'ordinals', network: CONFIG.network, recipient, collection, tokenId, tokenURI: '', name: `Bigfoot bridge #${tokenId}`, lockTxHash, srcChainId: 2741, test: !CONFIG.mainnet });
  for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 2000)); const r = await refresh(rec.id); if (r.status !== 'pending') { console.log(JSON.stringify({ id: r.id, status: r.status, commitTxid: r.commitTxid, revealTxid: r.revealTxid, inscriptionId: r.inscriptionId, error: r.error }, null, 2)); process.exit(r.status === 'failed' ? 1 : 0); } }
} catch (e) { console.error(`rejected (${e.status || 500}): ${e.message}`); process.exit(1); }
