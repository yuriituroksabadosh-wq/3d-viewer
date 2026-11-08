// Сповіщення менеджеру: клієнт відкрив модель / КП / натиснув «Замовити».
// Адреса воркера (notify-worker/) — після його розгортання; порожня — нічого не надсилаємо.
// Мітка версії сторінки: у журналі воркера видно, чи в клієнта свіжа версія, а не закешована Telegram-ом
export const BUILD = '2026-11-08g';
export const NOTIFY_URL = 'https://m3-notify.yurii-turok-sabadosh.workers.dev';

/**
 * event: 'open' | 'kp' | 'order'. Повертає Promise з відповіддю воркера ({ ok, client }) або null.
 * initData — підписані Telegram дані: за ними воркер точно знає, хто клієнт (і може написати йому).
 */
export function notify(event, model, title, tg) {
  if (!NOTIFY_URL) return Promise.resolve(null);
  const u = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
  const body = {
    event,
    v: BUILD,
    p: tg ? `${tg.platform || '?'} ${tg.version || '?'}` : '',
    model,
    title,
    telegram: !!(tg && tg.platform && tg.platform !== 'unknown'),
    initData: (tg && tg.initData) || '',
    user: u ? { id: u.id, name: [u.first_name, u.last_name].filter(Boolean).join(' '), username: u.username || '' } : null,
  };
  try {
    return fetch(NOTIFY_URL, {
      method: 'POST',
      // text/plain — «простий» запит без попередньої перевірки CORS: у вбудованих браузерах Telegram надійніше
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(body),
      keepalive: true,
    }).then((r) => r.json()).catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}
