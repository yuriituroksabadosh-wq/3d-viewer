// Cloudflare Worker: сайт 3D-перегляду повідомляє сюди, що клієнт відкрив модель / КП / натиснув «Замовити»,
// а воркер пише про це менеджеру в Telegram від імені бота. Токен бота — лише тут (секрет BOT_TOKEN),
// на сайт він не потрапляє. Секрети: BOT_TOKEN, CHAT_ID.

const ALLOWED_ORIGINS = ['https://yuriituroksabadosh-wq.github.io', 'http://localhost:5173'];
const EVENTS = {
  open: '👀 Відкрили 3D-модель',
  kp: '📄 Відкрили КП',
  order: '🛒 Натиснули «Замовити»',
};

const cors = (origin) => ({
  'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
});

const clean = (s, n = 60) => String(s ?? '').replace(/[<>&\u0000-\u001f]/g, ' ').trim().slice(0, n);

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });
    if (request.method !== 'POST' || !ALLOWED_ORIGINS.includes(origin)) {
      return new Response('Forbidden', { status: 403 });
    }
    let data;
    try {
      data = await request.json();
    } catch {
      return new Response('Bad request', { status: 400, headers: cors(origin) });
    }
    const event = EVENTS[data.event];
    const model = clean(data.model, 64);
    if (!event || !/^[a-zA-Z0-9-]{1,64}$/.test(model)) {
      return new Response('Bad request', { status: 400, headers: cors(origin) });
    }

    // Свої відкриття (менеджер дивиться сам) — не повідомляємо
    if (data.user && String(data.user.id) === String(env.CHAT_ID)) return new Response('ok', { headers: cors(origin) });

    // Не частіше одного однакового сповіщення на 10 хв (від одного клієнта)
    const who = request.headers.get('CF-Connecting-IP') || '';
    const cache = caches.default;
    const key = new Request(`https://notify.local/${data.event}/${model}/${encodeURIComponent(who)}`);
    if (await cache.match(key)) return new Response('ok', { headers: cors(origin) });
    await cache.put(key, new Response('1', { headers: { 'Cache-Control': 'max-age=600' } }));

    const title = clean(data.title, 80);
    const user = data.user ? clean([data.user.name, data.user.username ? `@${clean(data.user.username, 40)}` : ''].filter(Boolean).join(' '), 80) : '';
    const where = data.telegram ? 'у Telegram' : 'у браузері';
    const text = [
      `${event}`,
      title ? `«${title}»` : model,
      `https://yuriituroksabadosh-wq.github.io/3d-viewer/?model=${model}`,
      user ? `Хто: ${user}` : `Хто: невідомо (${where})`,
    ].join('\n');

    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.CHAT_ID, text, link_preview_options: { is_disabled: true }, disable_notification: data.event === 'open' }),
    });
    return new Response('ok', { headers: cors(origin) });
  },
};
