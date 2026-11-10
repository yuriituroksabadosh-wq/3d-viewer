// Файли моделі (GLB, КП, присадка): нові — у сховищі воркера (KV), старі — у data/ на сайті.
// Локально (dev, прев'ю) спершу data/: там свіжі файли, ще не викладені.
import { NOTIFY_URL } from './notify.js';

const sources = (file) => {
  const remote = NOTIFY_URL ? `${NOTIFY_URL}/f/${file}` : null;
  const local = `data/${file}`;
  return (import.meta.env.DEV ? [local, remote] : [remote, local]).filter(Boolean);
};

/** Response першого джерела, де файл є, або null. (dev-сервер на відсутній файл віддає index.html — відсіюємо) */
export async function fetchFile(file) {
  for (const url of sources(file)) {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (res.ok && !/text\/html/.test(res.headers.get('content-type') || '')) return res;
    } catch { /* наступне джерело */ }
  }
  return null;
}
