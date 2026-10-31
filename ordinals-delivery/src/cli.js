// node src/cli.js <tb1p-recipient> [collection] [tokenId]  — one signet test delivery, prints txids.
import { startDelivery, refresh } from './deliver.js';
const [recipient, collection = '0xtest', tokenId = '1'] = process.argv.slice(2);
const rec = await startDelivery({ dest: 'ordinals', network: 'signet', recipient, collection, tokenId, tokenURI: '', name: `Bigfoot bridge signet test #${tokenId}`, lockTxHash: '0xsignettest', lockId: 'cli', srcChainId: 2741, test: true });
for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 2000)); const r = await refresh(rec.id); if (r.status !== 'pending') { console.log(JSON.stringify({ id: r.id, status: r.status, commitTxid: r.commitTxid, revealTxid: r.revealTxid, inscriptionId: r.inscriptionId, error: r.error }, null, 2)); process.exit(0); } }
