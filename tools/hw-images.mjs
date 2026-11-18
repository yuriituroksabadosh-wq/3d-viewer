// Фото фурнітури для специфікації аркушів блоків: артикули з назв кріплень (останній рядок назви в БАЗИСі,
// кілька — через кому) → viyar.ua/apiNew → data/hw/<артикул>.jpg (240 px, білий фон). Наявні не перекачує.
// Використання: node tools/hw-images.mjs <m3-viewer.json>   або   import { fetchHwImages } from './hw-images.mjs'
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'hw');
const HOSTS = ['viyarua-www-prod.s3.eu-central-1.amazonaws.com', 'viyar.ua', 'files.viyar.ua'];

/** Артикули з назви кріплення: останній рядок, коди через кому. */
export function articlesOf(name) {
  const lines = String(name || '').split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  return lines[lines.length - 1].split(/\s*,\s*/).filter(Boolean);
}

export async function fetchHwImages(spec) {
  fs.mkdirSync(OUT, { recursive: true });
  const codes = [...new Set((spec || []).flatMap((s) => articlesOf(s.name)))].filter((c) => /^\d{1,9}$/.test(c));
  const need = codes.filter((c) => !fs.existsSync(path.join(OUT, `${c}.jpg`)));
  let got = 0;
  for (let i = 0; i < need.length; i += 40) {
    const part = need.slice(i, i + 40);
    try {
      const q = encodeURIComponent(JSON.stringify({ product_code: { $in: part } }));
      const j = await fetch(`https://viyar.ua/apiNew/products?filter_query=${q}&lang=uk&limit=200&extend_additional=true&view=short`, { signal: AbortSignal.timeout(25000) }).then((r) => r.json());
      for (const it of j.items || []) {
        const code = String(it.product_code);
        if (!part.includes(code) || !it.preview_path) continue;
        try {
          const u = new URL(it.preview_path);
          if (u.protocol !== 'https:' || !HOSTS.includes(u.hostname)) continue;
          const buf = Buffer.from(await fetch(u, { signal: AbortSignal.timeout(15000) }).then((r) => r.arrayBuffer()));
          await sharp(buf).resize(240, 240, { fit: 'contain', background: '#ffffff' }).flatten({ background: '#ffffff' }).jpeg({ quality: 82 }).toFile(path.join(OUT, `${code}.jpg`));
          got++;
        } catch (e) { console.log(`   фото ${code}: ${e.message}`); }
      }
    } catch (e) { console.log(`   Віяр недоступний: ${e.message}`); }
  }
  console.log(`   фото фурнітури: артикулів ${codes.length}, нових ${got}, уже були ${codes.length - need.length}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const meta = JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^﻿/, ''));
  await fetchHwImages(meta.spec);
}
