// Комерційна пропозиція (КП): зашифрований PDF на сайті + ключ у посиланні після «#».
// Без ключа файл не розшифрувати; ключ на сервер не потрапляє.

import { openSheet } from './extras.js';

/** Ключ з адреси: …#kp=<ключ> або …?kp=<ключ> */
export function kpKey() {
  // 1) після # (звичайне посилання); 2) параметр ?kp= — для кнопки в Telegram-боті,
  //    бо Telegram дописує свої дані після # і може затерти ключ
  const m = /(?:^|[#&])kp=([A-Za-z0-9_-]{43})/.exec(window.location.hash);
  if (m) return m[1];
  const q = new URLSearchParams(window.location.search).get("kp");
  return q && /^[A-Za-z0-9_-]{43}$/.test(q) ? q : null;
}

const fromB64url = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

/** Чи є КП для моделі (файл існує і є ключ). Повертає функцію відкриття або null. */
export async function prepareKp(name) {
  const keyText = kpKey();
  if (!keyText || !window.crypto?.subtle) return null;
  let res;
  try {
    res = await fetch(`data/${name}.kp.bin`, { cache: 'no-cache' });
  } catch {
    return null;
  }
  // dev-сервер на відсутній файл віддає index.html — відсіюємо за типом
  if (!res.ok || /text\/html/.test(res.headers.get('content-type') || '')) return null;
  const blob = new Uint8Array(await res.arrayBuffer());

  let pdf = null;
  async function decrypt() {
    if (pdf) return pdf;
    const key = await crypto.subtle.importKey('raw', fromB64url(keyText), 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.subarray(0, 12) }, key, blob.subarray(12));
    pdf = new Uint8Array(plain);
    return pdf;
  }

  return async function openKp(title) {
    const body = document.createElement('div');
    body.className = 'kp';
    const status = document.createElement('div');
    status.className = 'hint';
    status.textContent = 'Відкриваю КП…';
    const pages = document.createElement('div');
    pages.className = 'kp-pages';
    const download = document.createElement('button');
    download.className = 'btn btn-wide';
    download.type = 'button';
    download.textContent = 'Завантажити PDF';
    body.append(status, pages, download);
    openSheet('Комерційна пропозиція', body);

    let bytes;
    try {
      bytes = await decrypt();
    } catch {
      status.textContent = 'Не вдалося відкрити КП: посилання пошкоджене або застаріле. Попросіть нове посилання.';
      download.remove();
      return;
    }

    download.addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `КП — ${title}.pdf`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    });

    // pdf.js вантажимо лише тепер, щоб не важчав основний застосунок
    try {
      const pdfjs = await import('pdfjs-dist/build/pdf.min.mjs');
      const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
      status.textContent = `Сторінок: ${doc.numPages}`;
      const width = Math.min(pages.clientWidth || 480, 900);
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: (width / base.width) * ratio });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = '100%';
        pages.append(canvas);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      }
    } catch (err) {
      console.error(err);
      status.textContent = 'Не вдалося показати сторінки. Натисніть «Завантажити PDF».';
    }
  };
}
