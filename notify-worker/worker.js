// Cloudflare Worker: сайт 3D-перегляду повідомляє сюди, що клієнт відкрив модель / КП / натиснув «Замовити»,
// а воркер пише про це менеджеру в Telegram від імені бота. Токен бота — лише тут (секрет BOT_TOKEN),
// на сайт він не потрапляє. Секрети: BOT_TOKEN, CHAT_ID.
//
// «Замовити»: з міні-апки Telegram (iPhone) не пускає клієнта в особистий чат з людиною.
// Тому заявка йде через бота: менеджеру — повідомлення про заявку, клієнту (якщо дозволив боту писати) —
// повідомлення в чаті з ботом з кнопкою «Написати менеджеру» (кнопка-посилання в чаті відкриває чат завжди).
// Хто клієнт — беремо лише з підписаних Telegram даних (initData), щоб бота не можна було змусити писати чужим.

const ALLOWED_ORIGINS = ['https://yuriituroksabadosh-wq.github.io', 'http://localhost:5173'];
const MANAGER = 'turok_yura';
const EVENTS = {
  open: '👀 Відкрили 3D-модель',
  kp: '📄 Відкрили КП',
  order: '🛒 ЗАЯВКА: хоче замовити',
  decline: '❌ Відмовився від проєкту',
};

const cors = (origin) => ({
  'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
});

const clean = (s, n = 60) => String(s ?? '').replace(/[<>&\u0000-\u001f]/g, ' ').trim().slice(0, n);

/** Перевірка підпису Telegram WebApp initData. Повертає користувача або null. */
async function verifiedUser(initData, botToken) {
  if (!initData || typeof initData !== 'string' || initData.length > 4096) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const enc = new TextEncoder();
  const hmac = async (key, msg) => {
    const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
  };
  const secret = await hmac(enc.encode('WebAppData'), botToken);
  const sig = await hmac(secret, check);
  const hex = [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (hex !== hash) return null;
  // Не старіше доби
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;
  try { return JSON.parse(params.get('user') || 'null'); } catch { return null; }
}

const tgApi = (env, method, body) => fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then((r) => r.json()).catch(() => ({ ok: false }));

const STALE = 'Ця пропозиція від М3 Меблі більше не актуальна. З питаннями — звертайтеся до менеджера.';

/** Прибрати повідомлення бота: видалити (до 48 год), інакше — переписати на «не актуальна» без кнопок. */
async function retract(env, chat, id) {
  const del = await tgApi(env, 'deleteMessage', { chat_id: chat, message_id: id });
  if (del.ok) return 'deleted';
  const t = await tgApi(env, 'editMessageText', { chat_id: chat, message_id: id, text: STALE, reply_markup: { inline_keyboard: [] } });
  if (t.ok) return 'edited';
  const c = await tgApi(env, 'editMessageCaption', { chat_id: chat, message_id: id, caption: STALE, reply_markup: { inline_keyboard: [] } });
  return c.ok ? 'edited' : `fail: ${c.description || t.description || del.description || ''}`;
}

/** Відміна проєкту (з комп'ютера менеджера, з ключем): прибрати всі повідомлення бота клієнтам по цій моделі. */
async function revoke(request, env) {
  if (!env.REVOKE_KEY || request.headers.get('X-M3-Key') !== env.REVOKE_KEY) return new Response('Forbidden', { status: 403 });
  let data;
  try { data = await request.json(); } catch { return new Response('Bad request', { status: 400 }); }
  const slug = String(data.slug || '');
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(slug)) return new Response('Bad request', { status: 400 });
  const list = JSON.parse((await env.M3.get(`msg:${slug}`)) || '[]');
  const results = [];
  for (const m of list) results.push({ ...m, result: await retract(env, m.chat, m.id) });
  await env.M3.delete(`msg:${slug}`);
  await env.M3.put(`revoked:${slug}`, new Date().toISOString());
  console.log(JSON.stringify({ revoke: slug, results }));
  return new Response(JSON.stringify({ ok: true, results }), { headers: { 'Content-Type': 'application/json' } });
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/revoke' && request.method === 'POST') return revoke(request, env);
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

    // Клієнт: перевірений підписом Telegram (якщо є initData), інакше — як надіслала сторінка (лише для тексту)
    const tgUser = await verifiedUser(data.initData, env.BOT_TOKEN);
    const u = tgUser
      ? { id: tgUser.id, name: [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' '), username: tgUser.username || '' }
      : (data.user || null);
    const log = (result) => console.log(JSON.stringify({ event: data.event, model, v: clean(data.v, 20), p: clean(data.p, 30), tg: !!data.telegram, uid: u && u.id, signed: !!tgUser, result }));

    // Свої відкриття (менеджер дивиться сам) — не повідомляємо
    if (u && String(u.id) === String(env.CHAT_ID)) { log('own'); return new Response('{"ok":true,"client":"own"}', { headers: { ...cors(origin), 'Content-Type': 'application/json' } }); }

    // Повтори того самого (оновив сторінку) — не частіше разу на 2 хв від одного клієнта.
    // Ключ — Telegram-користувач, а не IP: інакше вся сім'я на одному Wi-Fi «зливається» в одного.
    const who = (u && u.id) || request.headers.get('CF-Connecting-IP') || '';
    const cache = caches.default;
    const key = new Request(`https://notify.local/${data.event}/${model}/${encodeURIComponent(who)}`);
    if (await cache.match(key)) { log('repeat'); return new Response('{"ok":true,"client":"repeat"}', { headers: { ...cors(origin), 'Content-Type': 'application/json' } }); }
    await cache.put(key, new Response('1', { headers: { 'Cache-Control': 'max-age=120' } }));

    // «Санвузол · №460» → «№460 · Санвузол»: спершу номер замовлення
    const parts = clean(data.title, 80).split(' · ').filter(Boolean);
    const what = parts.length > 1 ? `${parts.slice(1).join(' · ')} · ${parts[0]}` : (parts[0] || model);
    const uid = u && /^[0-9]{1,15}$/.test(String(u.id)) ? String(u.id) : '';
    const uname = u ? clean(u.name, 60) : '';
    const unick = u && u.username ? `@${clean(u.username, 40)}` : '';
    const whoLine = !u ? `невідомо (${data.telegram ? 'у Telegram' : 'у браузері'})`
      : [uid ? `<a href="tg://user?id=${uid}">${uname || 'клієнт'}</a>` : uname, unick].filter(Boolean).join(' ');

    const api = (method, body) => fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json()).catch(() => ({ ok: false }));
    const toManager = (text) => api('sendMessage', { chat_id: env.CHAT_ID, text, parse_mode: 'HTML', disable_notification: data.event === 'open' });

    // Клікабельне ім'я Telegram приймає не для кожного клієнта — тоді шлемо без посилання
    const reason = data.event === 'decline' && data.reason ? `Причина: ${clean(data.reason, 60)}` : '';
    let res = await toManager([event, `<b>${what}</b>`, `Хто: ${whoLine}`, reason].filter(Boolean).join('\n'));
    if (!res.ok) {
      const plain = !u ? whoLine : [uname, unick, uid ? `(id ${uid})` : ''].filter(Boolean).join(' ');
      res = await toManager([event, `<b>${what}</b>`, `Хто: ${plain}`, reason].filter(Boolean).join('\n'));
    }

    // Заявка: клієнту — повідомлення з кнопкою в чат менеджера (лише перевіреному клієнту)
    let toClient = null;
    if (data.event === 'order' && tgUser && uid) {
      const r = await api('sendMessage', {
        chat_id: uid,
        text: `Дякуємо! Вашу заявку на «${what}» передано менеджеру.\n\nМенеджер напише вам найближчим часом. Або напишіть самі — натисніть кнопку нижче.`,
        reply_markup: { inline_keyboard: [[{ text: '✉️ Написати менеджеру', url: `https://t.me/${MANAGER}` }]] },
      });
      toClient = r.ok ? 'sent' : `fail: ${r.description || ''}`;
      // Запам'ятовуємо, щоб при відміні проєкту прибрати це повідомлення в клієнта
      if (r.ok && env.M3) {
        const k = `msg:${model}`;
        const list = JSON.parse((await env.M3.get(k)) || '[]');
        list.push({ chat: uid, id: r.result.message_id });
        await env.M3.put(k, JSON.stringify(list.slice(-200)));
      }
    }

    log(`${res.ok ? 'sent' : `fail: ${res.description || ''}`}${toClient ? ` / client: ${toClient}` : ''}`);
    return new Response(JSON.stringify({ ok: !!res.ok, client: toClient }), { headers: { ...cors(origin), 'Content-Type': 'application/json' } });
  },
};
