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

    const log = (result) => console.log(JSON.stringify({ event: data.event, model, v: clean(data.v, 20), p: clean(data.p, 30), tg: !!data.telegram, uid: data.user && data.user.id, result }));

    // Свої відкриття (менеджер дивиться сам) — не повідомляємо
    if (data.user && String(data.user.id) === String(env.CHAT_ID)) { log('own'); return new Response('own', { headers: cors(origin) }); }

    // Повтори того самого (оновив сторінку) — не частіше разу на 2 хв від одного клієнта.
    // Ключ — Telegram-користувач, а не IP: інакше вся сім'я на одному Wi-Fi «зливається» в одного.
    const who = (data.user && data.user.id) || request.headers.get('CF-Connecting-IP') || '';
    const cache = caches.default;
    const key = new Request(`https://notify.local/${data.event}/${model}/${encodeURIComponent(who)}`);
    if (await cache.match(key)) { log('repeat'); return new Response('repeat', { headers: cors(origin) }); }
    await cache.put(key, new Response('1', { headers: { 'Cache-Control': 'max-age=120' } }));

    // «Санвузол · №460» → «№460 · Санвузол»: спершу номер замовлення
    const parts = clean(data.title, 80).split(' · ').filter(Boolean);
    const what = parts.length > 1 ? `${parts.slice(1).join(' · ')} · ${parts[0]}` : (parts[0] || model);
    // Хто: ім'я — клікабельне (відкриває чат з клієнтом навіть без @ніка), плюс @нік
    const u = data.user || null;
    const uid = u && /^[0-9]{1,15}$/.test(String(u.id)) ? String(u.id) : '';
    const uname = u ? clean(u.name, 60) : '';
    const unick = u && u.username ? `@${clean(u.username, 40)}` : '';
    const whoLine = !u ? `невідомо (${data.telegram ? 'у Telegram' : 'у браузері'})`
      : [uid ? `<a href="tg://user?id=${uid}">${uname || 'клієнт'}</a>` : uname, unick].filter(Boolean).join(' ');
    const send = (text) => fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.CHAT_ID, text, parse_mode: 'HTML', disable_notification: data.event === 'open' }),
    }).then((r) => r.json()).catch(() => ({ ok: false }));

    // Клікабельне ім'я Telegram приймає не для кожного клієнта — тоді шлемо без посилання
    let res = await send([event, `<b>${what}</b>`, `Хто: ${whoLine}`].join('\n'));
    if (!res.ok) {
      const plain = !u ? whoLine : [uname, unick, uid ? `(id ${uid})` : ''].filter(Boolean).join(' ');
      res = await send([event, `<b>${what}</b>`, `Хто: ${plain}`].join('\n'));
    }
    log(res.ok ? 'sent' : `fail: ${res.description || ''}`);
    return new Response(res.ok ? 'ok' : 'fail', { headers: cors(origin) });
  },
};
