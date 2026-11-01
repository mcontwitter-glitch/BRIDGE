// Ordinals delivery config. ORDINALS_NETWORK (default "mainnet") is the single switch; "signet" for tests.
import path from 'node:path';

const network = process.env.ORDINALS_NETWORK || 'mainnet';
if (!['mainnet', 'signet', 'regtest'].includes(network)) throw new Error('ORDINALS_NETWORK must be mainnet, signet or regtest');
const mainnet = network === 'mainnet';
const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);

export const CONFIG = Object.freeze({
  mainnet, // approved by BIG on 2026-10-31 ("Wire it for main net")
  network,
  mempool: mainnet ? 'https://mempool.space/api' : network === 'signet' ? 'https://mempool.space/signet/api' : env('ORDINALS_REGTEST_API', 'http://127.0.0.1:0'),
  explorer: mainnet ? 'https://mempool.space' : 'https://mempool.space/signet',
  // Delivery mode: 'recursive' (default; tiny p5.js HTML referencing layers inscribed once), 'image' (fallback), 'metadata'.
  mode: env('ORDINALS_MODE', 'recursive'),
  // Value carried with each inscription. 330 = P2TR dust limit (every recipient is asserted to be Taproot). Override: ORDINALS_POSTAGE_SATS.
  postageSats: Math.max(330, Number(env('ORDINALS_POSTAGE_SATS', 330))),
  // Fee rate (sat/vB, fractional allowed). ORDINALS_FEE_RATE pins it; otherwise the mempool.space rate is floored at
  // ORDINALS_MIN_FEE_RATE (default 1 = previous behaviour; never below 0.1, the Bitcoin Core ≥29 min relay fee).
  fixedFeeRate: Number(env('ORDINALS_FEE_RATE', 0)) > 0 ? Math.max(0.1, Number(process.env.ORDINALS_FEE_RATE)) : 0,
  minFeeRate: Math.max(0.1, Number(env('ORDINALS_MIN_FEE_RATE', 1)) || 1),
  // Batched setup: max vsize of one reveal tx (standard limit is 100,000 vB); larger batches split into more reveals.
  maxRevealVsize: Number(env('ORDINALS_MAX_REVEAL_VSIZE', 98_000)),
  maxBodyBytes: 60_000,
  imageTargetBytes: Number(env('ORDINALS_IMAGE_TARGET_BYTES', 20_000)),
  // Hard cost cap, checked before signing: cost must be < maxUsd AND ≤ marginUsd, else the delivery stays queued.
  cost: {
    maxUsd: 20,
    marginUsd: Math.min(Number(env('ORDINALS_MARGIN_USD', 18)), 20),
    maxFeeRate: Number(env('ORDINALS_MAX_FEE_RATE', 0)) || 0, // optional sat/vB ceiling (0 = off)
  },
  retryMs: Number(env('ORDINALS_RETRY_MS', 10 * 60_000)),
  dataDir: env('ORDINALS_DATA_DIR', path.join(process.env.HOME || process.env.USERPROFILE || '.', '.bridge-ordinals')),
  port: Number(env('ORDINALS_PORT', 8790)),
  // ---- Abstract lock verification (keyless RPC reads) ----
  lock: {
    chainId: 2741,
    rpc: env('ABSTRACT_RPC', 'https://api.mainnet.abs.xyz'),
    // NftLockVault proxy used by the live site (docs bundle) — 0xe81D…99e5.
    vault: env('ORDINALS_LOCK_VAULT', '0xe81DdAB112137112B8FeeB853e22BC4c38F999e5'),
    // Ordinals destination = OrdinalsSink on Arbitrum One (LayerZero eid 30110), a receive-only OApp that mints nothing.
    // Disabled (null) until the sink is deployed AND the vault owner has run setPeer(30110, sink):
    // set ORDINALS_SINK_ADDRESS to the deployed sink. ORDINALS_LOCK_DEST_EID still overrides the eid (tests).
    sinkEid: 30110,
    sinkAddress: /^0x[0-9a-fA-F]{40}$/.test(env('ORDINALS_SINK_ADDRESS', '')) ? process.env.ORDINALS_SINK_ADDRESS.toLowerCase() : null,
    destEid: env('ORDINALS_LOCK_DEST_EID', '') !== '' ? Number(process.env.ORDINALS_LOCK_DEST_EID)
      : (/^0x[0-9a-fA-F]{40}$/.test(env('ORDINALS_SINK_ADDRESS', '')) ? 30110 : null),
    // The lock's EVM recipient must be ordinalsCommitment(bc1p) (binds the Taproot address on-chain).
    requireCommitment: true,
    minConfirmations: Number(env('ORDINALS_LOCK_MIN_CONF', 12)),
    skip: !mainnet && env('ORDINALS_SKIP_LOCK_CHECK', '') === '1', // signet test runs only; ignored on mainnet
  },
});

if (!['recursive', 'image', 'metadata'].includes(CONFIG.mode)) throw new Error('ORDINALS_MODE must be recursive, image or metadata');

export function assertNetwork(net) {
  if (net !== CONFIG.network) throw Object.assign(new Error(`Only ${CONFIG.network} is supported by this service.`), { status: 400 });
}
