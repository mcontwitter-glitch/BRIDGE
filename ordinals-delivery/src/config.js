// Ordinals delivery config. mainnet:false HARD-BLOCKS mainnet everywhere in this service.
import os from 'node:os';
import path from 'node:path';

export const CONFIG = Object.freeze({
  mainnet: false,
  network: 'signet',
  mempool: 'https://mempool.space/signet/api',
  postageSats: 10_000,
  maxBodyBytes: 60_000,
  dataDir: process.env.ORDINALS_DATA_DIR || path.join(os.homedir(), '.bridge-ordinals'),
  port: Number(process.env.ORDINALS_PORT || 8790),
});

export function assertNetwork(net) {
  if (net === 'mainnet' || net === 'bitcoin') {
    if (!CONFIG.mainnet) throw Object.assign(new Error('Mainnet Ordinals delivery is disabled (mainnet:false).'), { status: 403 });
  }
  if (net !== CONFIG.network) throw Object.assign(new Error(`Only ${CONFIG.network} is supported.`), { status: 400 });
}
