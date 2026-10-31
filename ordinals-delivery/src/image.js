// Shrink an NFT image for inscription: smallest of WebP / AVIF / palette PNG, aiming for ≤ targetBytes.
import sharp from 'sharp';
import { CONFIG } from './config.js';

export async function shrinkImage(buf, { target = CONFIG.imageTargetBytes, max = CONFIG.maxBodyBytes } = {}) {
  const meta = await sharp(buf).metadata();
  const w0 = meta.width || 512;
  const pixelArt = w0 <= 128; // tiny sources: keep pixels crisp (nearest-neighbour, lossless palette PNG wins)
  const cands = [{ contentType: meta.format === 'png' ? 'image/png' : `image/${meta.format}`, body: buf }];
  const widths = [...new Set([w0, 512, 384, 320, 256].filter((w) => w <= w0))];
  for (const w of widths) {
    const base = () => sharp(buf).resize({ width: w, kernel: pixelArt ? 'nearest' : 'lanczos3', withoutEnlargement: true });
    cands.push({ contentType: 'image/png', body: await base().png({ palette: true, compressionLevel: 9, effort: 7 }).toBuffer() });
    for (const q of [70, 50]) {
      cands.push({ contentType: 'image/webp', body: await base().webp({ quality: q, effort: 4 }).toBuffer() });
      cands.push({ contentType: 'image/avif', body: await base().avif({ quality: q - 15, effort: 2 }).toBuffer() });
    }
    // Prefer the largest width that fits the target (best quality ≤ target).
    const fit = cands.filter((c) => c.body.length <= target).sort((a, b) => a.body.length - b.body.length);
    if (fit.length) { const best = fit.sort((a, b) => b.body.length - a.body.length)[0]; return { ...best, width: w }; }
  }
  const smallest = cands.sort((a, b) => a.body.length - b.body.length)[0];
  return smallest.body.length <= max ? smallest : null;
}
