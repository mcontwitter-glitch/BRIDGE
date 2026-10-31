// Pure cost model + USD cap. Used before ANY signing (deliver/inscribe) and by GET /api/ordinals/estimate.
import { CONFIG } from './config.js';

// Envelope overhead beyond body+metadata: pubkey push, opcodes, "ord", content-type, push opcodes per 520-byte chunk.
export const leafBytes = (bodyBytes, metaBytes, typeLen = 10) => 34 + 3 + 4 + 2 + 1 + typeLen + 1 + bodyBytes + metaBytes + 3 * Math.ceil(bodyBytes / 520) + 4 * Math.ceil(metaBytes / 520) + 1;
export const revealVsize = (leafLen) => Math.ceil((leafLen + 64 + 33 + 10) / 4) + 110;
export const commitVsize = (inputs = 1) => inputs * 58 + 43 * 2 + 11;

export function costSats({ bodyBytes, metaBytes = 120, typeLen = 10, rate, inputs = 1 }) {
  const revealFee = Math.ceil(revealVsize(leafBytes(bodyBytes, metaBytes, typeLen)) * rate) + 50;
  const commitFee = Math.ceil(commitVsize(inputs) * rate) + 20;
  return { revealFee, commitFee, postage: CONFIG.postageSats, total: revealFee + commitFee + CONFIG.postageSats };
}
export const toUsd = (sats, btcUsd) => Math.round((sats * btcUsd / 1e8) * 100) / 100;

/** Throws status 'queued' (HTTP 202 semantics) when the cost is not strictly under the cap/margin or the fee rate is above the ceiling. */
export function assertUnderCap({ sats, rate, btcUsd }, cap = CONFIG.cost) {
  const usd = sats * btcUsd / 1e8;
  const why = !(btcUsd > 0) ? 'BTC price unavailable'
    : cap.maxFeeRate && rate > cap.maxFeeRate ? `fee rate ${rate} sat/vB above ceiling ${cap.maxFeeRate}`
    : !(usd < cap.maxUsd) ? `cost $${usd.toFixed(2)} not under the $${cap.maxUsd} cap`
    : usd > cap.marginUsd ? `cost $${usd.toFixed(2)} above the $${cap.marginUsd} margin` : '';
  if (why) throw Object.assign(new Error(`Waiting for lower Bitcoin fees: ${why}`), { status: 202, queued: true, usd });
  return usd;
}
/** Highest whole sat/vB at which an inscription of this size stays ≤ limitUsd. */
export function breakEvenRate({ bodyBytes, metaBytes, typeLen }, btcUsd, limitUsd) {
  let r = 1; while (costSats({ bodyBytes, metaBytes, typeLen, rate: r + 1 }).total * btcUsd / 1e8 <= limitUsd) r++;
  return costSats({ bodyBytes, metaBytes, typeLen, rate: r }).total * btcUsd / 1e8 <= limitUsd ? r : 0;
}

/** Live estimate (mempool.space fee rate × BTC/USD) for metadata-only and a ≤ imageTargetBytes image. */
// Typical recursive LIL FOOT: ~400 B HTML (measured, all 10 traits) + ~330 B CBOR metadata (names of the traits).
export const RECURSIVE = { htmlBytes: 400, metaBytes: 330 };
/** Setup (layers + renderer) cost at a rate, from a plan.json written by setup-collection.js (dry run). */
export function setupCostFromPlan(plan, rate, usdPx) {
  const sats = Object.values(plan.files).reduce((s, f) => s + costSats({ bodyBytes: f.bytes, metaBytes: 0, typeLen: 10, rate }).total, 0) + costSats({ bodyBytes: plan.rendererBytes, metaBytes: 0, typeLen: 15, rate }).total;
  return { slug: plan.slug, inscriptions: Object.keys(plan.files).length + 1, bytes: plan.bytes + plan.rendererBytes, sats, usd: toUsd(sats, usdPx) };
}
export async function liveEstimate({ feeRate, btcUsd, setupEstimate }, cap = CONFIG.cost) {
  const [rate, usdPx] = await Promise.all([feeRate(), btcUsd()]);
  const one = (bodyBytes, typeLen) => {
    const s = costSats({ bodyBytes, metaBytes: 160, typeLen, rate });
    let ok = true; try { assertUnderCap({ sats: s.total, rate, btcUsd: usdPx }, cap); } catch { ok = false; }
    return { bytes: bodyBytes, sats: s.total, usd: toUsd(s.total, usdPx), underCap: ok, maxRateForMargin: breakEvenRate({ bodyBytes, metaBytes: 160, typeLen }, usdPx, cap.marginUsd) };
  };
  const one2 = (bodyBytes, metaBytes, typeLen) => {
    const s = costSats({ bodyBytes, metaBytes, typeLen, rate });
    let ok = true; try { assertUnderCap({ sats: s.total, rate, btcUsd: usdPx }, cap); } catch { ok = false; }
    return { bytes: bodyBytes, sats: s.total, usd: toUsd(s.total, usdPx), underCap: ok, maxRateForMargin: breakEvenRate({ bodyBytes, metaBytes, typeLen }, usdPx, cap.marginUsd) };
  };
  return { network: CONFIG.network, mode: CONFIG.mode, feeRate: rate, btcUsd: usdPx, postageSats: CONFIG.postageSats, maxUsd: cap.maxUsd, marginUsd: cap.marginUsd,
    recursive: one2(RECURSIVE.htmlBytes, RECURSIVE.metaBytes, 24), metadataOnly: one(220, 16), image: one(CONFIG.imageTargetBytes, 10),
    setup: setupEstimate ? setupEstimate(rate, usdPx) : null };
}
