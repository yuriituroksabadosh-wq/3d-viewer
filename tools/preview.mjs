// Прев'ю моделі для Telegram: відкриває сайт у режимі знімка (?shot=1) у фоновому Edge/Chrome
// і зберігає кадр у data/<назва>.jpg.
// Використання:  npm run shot -- назва-моделі [адреса-сайту]
// За замовчуванням бере локальний dev-сервер (npm run dev): http://localhost:5173/

import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const [slug, siteArg] = process.argv.slice(2);
if (!slug || !/^[a-zA-Z0-9-]{1,64}$/.test(slug)) {
  console.error('Використання: npm run shot -- назва-моделі [адреса-сайту]');
  process.exit(1);
}
const site = (siteArg || 'http://localhost:5173/').replace(/\/?$/, '/');

// Браузер, який уже є на комп'ютері (окремо нічого не завантажуємо)
const candidates = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const executablePath = candidates.find((p) => fs.existsSync(p));
if (!executablePath) {
  console.error('Не знайдено Edge або Chrome для знімка.');
  process.exit(1);
}

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage();
  // 1280×800 — Telegram показує фото до ~1280 px; пропорція як у прев'ю каналів
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('Помилка сторінки:', e.message));
  await page.goto(`${site}?model=${slug}&shot=1`, { waitUntil: 'networkidle0', timeout: 120000 });
  await page.waitForFunction(() => window.__shot || !document.getElementById('error').hidden, { timeout: 120000 });
  const err = await page.evaluate(() => (document.getElementById('error').hidden ? '' : document.getElementById('error').textContent));
  if (err) throw new Error(err);
  const dataUrl = await page.evaluate(() => window.__shot);
  const out = path.resolve('data', `${slug}.jpg`);
  fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('Прев\'ю збережено:', out, `(${(fs.statSync(out).size / 1024).toFixed(0)} КБ)`);
} finally {
  await browser.close();
}
