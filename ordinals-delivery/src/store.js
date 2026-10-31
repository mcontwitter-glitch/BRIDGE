// Delivery records (JSON file outside the repo). Status: pending → inscribed → delivered (or failed).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG } from './config.js';

const file = () => path.join(CONFIG.dataDir, `deliveries-${CONFIG.network}.json`);
const readAll = () => { try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return {}; } };
const writeAll = (d) => { fs.mkdirSync(CONFIG.dataDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(file(), JSON.stringify(d, null, 2)); };
export const get = (id) => readAll()[id] || null;
export const list = () => Object.values(readAll());
export function create(fields) {
  const id = 'ord_' + crypto.randomBytes(8).toString('hex');
  const rec = { id, status: 'pending', network: CONFIG.network, createdAt: new Date().toISOString(), ...fields };
  const all = readAll(); all[id] = rec; writeAll(all); return rec;
}
export function patch(id, fields) { const all = readAll(); all[id] = { ...all[id], ...fields, updatedAt: new Date().toISOString() }; writeAll(all); return all[id]; }
