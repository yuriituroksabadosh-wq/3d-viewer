// Креслення онлайн (лише менеджеру): аркуші блоків прямо на екрані — гортати, тапнути для збільшення.
// За потреби — зібрати показане в PDF: у Telegram бот надсилає його в чат, у браузері файл завантажується.

import { makeSheets, pdfFromCanvases, sheetBlocks } from './block-sheet.js';
import { NOTIFY_URL } from './notify.js';

const tgApp = () => window.Telegram?.WebApp;
const say = (msg) => { const tg = tgApp(); if (tg?.showAlert) tg.showAlert(msg); else alert(msg); };

/** Віддати PDF: у Telegram — документом у чат бота (завантаження там не працює), у браузері — файлом. */
export async function deliverPdf(blob, fileName) {
  const tg = tgApp();
  if (tg?.initData) {
    const head = new TextEncoder().encode(JSON.stringify({ initData: tg.initData, name: fileName }) + '\n');
    const r = await fetch(`${NOTIFY_URL}/sheetpdf`, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: new Blob([head, blob]) })
      .then((x) => x.json()).catch(() => null);
    say(r?.ok ? 'PDF надіслано в чат бота.' : 'Не вдалося надіслати PDF у чат.');
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

/** Відкрити креслення: start — назва блоку або 'all' (титульний, специфікація, усі блоки). */
export function showSheetsView({ viewer, model, panels, start = 'all' }) {
  const blocks = sheetBlocks(model, panels);
  const info = panels.info || {};
  const product = [info.name, (info.prefix || '').trim()].filter(Boolean).join(' ') || 'виріб';
  const cache = new Map(); // вибір → canvas-и аркушів
  let current = start;
  let busy = false;

  const wrap = el('div', 'sv');
  const bar = el('div', 'sv-bar');
  const close = el('button', 'sv-btn sv-close', '✕');
  close.type = 'button';
  close.setAttribute('aria-label', 'Закрити');
  const pick = el('select', 'sv-pick');
  pick.append(new Option(`Весь виріб · ${blocks.length} бл.`, 'all'), ...blocks.map((b) => new Option(b, b)));
  pick.value = current;
  const pdfBtn = el('button', 'sv-btn sv-pdf', tgApp()?.initData ? 'PDF у бот' : 'Завантажити PDF');
  pdfBtn.type = 'button';
  bar.append(close, pick, pdfBtn);
  const status = el('div', 'sv-status');
  const pages = el('div', 'sv-pages');
  wrap.append(bar, status, pages);
  document.body.append(wrap);

  const render = async () => {
    const key = current;
    pages.replaceChildren();
    if (!cache.has(key)) {
      busy = true;
      status.textContent = 'Готую креслення…';
      try {
        const sheets = await makeSheets({
          viewer, model, panels,
          names: key === 'all' ? blocks : [key],
          general: key === 'all',
          onStep: (i, n) => { status.textContent = `Готую креслення: блок ${i + 1} з ${n}…`; },
        });
        cache.set(key, sheets);
      } catch (err) {
        console.error('Креслення:', err);
        status.textContent = 'Не вдалося підготувати креслення: ' + (err.message || err);
        busy = false;
        return;
      }
      busy = false;
    }
    if (key !== current) return; // поки готувалось, вибрали інше
    const sheets = cache.get(key);
    status.textContent = `${sheets.length} арк. · тапніть аркуш, щоб збільшити`;
    sheets.forEach((c, i) => {
      const box = el('div', 'sv-page');
      const img = new Image();
      img.alt = `Аркуш ${i + 1}`;
      img.src = c.toDataURL('image/jpeg', 0.85);
      img.addEventListener('click', () => box.classList.toggle('zoom'));
      box.append(img);
      pages.append(box);
    });
  };

  pick.addEventListener('change', () => { current = pick.value; render(); });
  close.addEventListener('click', () => wrap.remove());
  pdfBtn.addEventListener('click', async () => {
    const sheets = cache.get(current);
    if (busy || !sheets) return;
    busy = true;
    const label = pdfBtn.textContent;
    pdfBtn.textContent = 'Складаю PDF…';
    try {
      const blob = await pdfFromCanvases(sheets);
      if (tgApp()?.initData) pdfBtn.textContent = 'Надсилаю…';
      await deliverPdf(blob, `Аркуші — ${current === 'all' ? product : current}.pdf`);
    } catch (err) {
      say('Не вдалося зробити PDF: ' + (err.message || err));
    } finally { busy = false; pdfBtn.textContent = label; }
  });
  render();
}
