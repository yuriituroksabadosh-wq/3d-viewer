// Сповіщення менеджеру: клієнт відкрив модель / КП / натиснув «Замовити».
// Адреса воркера (notify-worker/) — після його розгортання; порожня — нічого не надсилаємо.
export const NOTIFY_URL = 'https://m3-notify.yurii-turok-sabadosh.workers.dev';

/** event: 'open' | 'kp' | 'order'. Тихо ігнорує будь-які помилки. */
export function notify(event, model, title, tg) {
  if (!NOTIFY_URL) return;
  const u = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
  const body = {
    event,
    model,
    title,
    telegram: !!(tg && tg.platform && tg.platform !== 'unknown'),
    user: u ? { id: u.id, name: [u.first_name, u.last_name].filter(Boolean).join(' '), username: u.username || '' } : null,
  };
  try {
    fetch(NOTIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {});
  } catch { /* без сповіщення */ }
}
