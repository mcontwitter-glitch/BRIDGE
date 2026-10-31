// Generates the signet inscriber key OUTSIDE the repo (chmod 600). Prints only the public funding address.
import fs from 'node:fs';
import path from 'node:path';
import { ECPair, NETWORK, keyFile, fundingAddress, loadKey } from './btc.js';
import { CONFIG } from './config.js';

if (CONFIG.mainnet) throw new Error('keygen is signet-only');
const file = keyFile();
if (!process.argv.includes('--show') && !fs.existsSync(file)) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, ECPair.makeRandom({ network: NETWORK }).toWIF() + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
console.log(`${CONFIG.network} inscriber funding address: ${fundingAddress(loadKey())}`);
