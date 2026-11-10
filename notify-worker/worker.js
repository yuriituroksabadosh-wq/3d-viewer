// Cloudflare Worker: сайт 3D-перегляду повідомляє сюди, що клієнт відкрив модель / КП / натиснув «Замовити»
// чи «Відмовитись», а воркер пише про це менеджеру в Telegram від імені бота. Токен бота — лише тут
// (секрет BOT_TOKEN), на сайт він не потрапляє. Секрети: BOT_TOKEN, CHAT_ID, REVOKE_KEY.
//
// «Замовити»: з міні-апки Telegram (iPhone) не пускає клієнта в особистий чат з людиною.
// Тому заявка йде через бота: менеджеру — повідомлення про заявку, клієнту (якщо дозволив боту писати) —
// повідомлення в чаті з ботом з кнопкою «Написати менеджеру» (кнопка-посилання в чаті відкриває чат завжди).
// Хто клієнт — беремо лише з підписаних Telegram даних (initData), щоб бота не можна було змусити писати чужим.
//
// Також:
//  • статистика по кожній моделі в KV (stat:<назва>) — відкриття, КП, заявка, відмова;
//  • щодня о 10:00 (Київ) — нагадування «клієнт мовчить», якщо 3 дні тому відкрив і нічого не натиснув;
//  • вебхук бота (/tg): менеджер пише «стат 46» або /stat — бот відповідає статистикою;
//    повідомлення клієнтів боту пересилаються менеджеру.

const ALLOWED_ORIGINS = ['https://yuriituroksabadosh-wq.github.io', 'http://localhost:5173'];
const MANAGER = 'turok_yura';
const SILENT_DAYS = 3;
const EVENTS = {
  open: '👀 Відкрили 3D-модель',
  kp: '📄 Відкрили КП',
  order: '🛒 ЗАЯВКА: хоче замовити',
  decline: '❌ Відмовився від проєкту',
  expired: '⌛ Відкрили прострочену пропозицію — клієнт повернувся!',
};
const managerBtn = { inline_keyboard: [[{ text: '✉️ Написати менеджеру', url: `https://t.me/${MANAGER}` }]] };

const cors = (origin) => ({
  'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
});
const json = (obj, headers = {}) => new Response(JSON.stringify(obj), { headers: { ...headers, 'Content-Type': 'application/json' } });

const clean = (s, n = 60) => String(s ?? '').replace(/[<>&\u0000-\u001f]/g, ' ').trim().slice(0, n);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const when = (ms) => new Date(ms).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

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
const toManager = (env, text, quiet = false) => tgApi(env, 'sendMessage', { chat_id: env.CHAT_ID, text, parse_mode: 'HTML', disable_notification: quiet, disable_web_page_preview: true });

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

/** Запам'ятати повідомлення бота клієнту — щоб відміна проєкту могла його прибрати. */
async function rememberMsg(env, model, chat, id) {
  if (!env.M3) return;
  const k = `msg:${model}`;
  const list = JSON.parse((await env.M3.get(k)) || '[]');
  list.push({ chat, id });
  await env.M3.put(k, JSON.stringify(list.slice(-200)));
}

// ---------- Статистика ----------
async function getStat(env, model) {
  return env.M3 ? JSON.parse((await env.M3.get(`stat:${model}`)) || 'null') : null;
}
async function bumpStat(env, model, what, event, reason, uid) {
  if (!env.M3) return null;
  const now = Date.now();
  const s = (await getStat(env, model)) || { title: what, opens: 0, kp: 0, orders: 0, declines: 0, expired: 0, first: now, last: now, viewers: [] };
  if (what && what !== model) s.title = what;
  if (event === 'open') s.opens++;
  if (event === 'kp') s.kp++;
  if (event === 'order') s.orders++;
  if (event === 'decline') { s.declines++; s.reason = reason || ''; }
  if (event === 'expired') s.expired++;
  if (event === 'open' || event === 'kp') s.last = now;
  if (uid && !s.viewers.includes(uid)) s.viewers = [...s.viewers, uid].slice(-20);
  await env.M3.put(`stat:${model}`, JSON.stringify(s));
  return s;
}
const statText = (model, s) => [
  `📊 <b>${esc(s.title || model)}</b>`,
  `Відкриття: ${s.opens} · КП: ${s.kp} · людей: ${s.viewers.length || '?'}`,
  `Заявка: ${s.orders ? 'так ✅' : 'ні'}${s.declines ? ` · Відмова ❌ ${esc(s.reason || '')}` : ''}${s.expired ? ` · після терміну: ${s.expired}` : ''}`,
  `Вперше: ${when(s.first)} · востаннє: ${when(s.last)}`,
].join('\n');

/** Щоденно: хто відкрив ≥3 дні тому і мовчить — нагадати менеджеру (один раз на модель). */
async function remindSilent(env) {
  if (!env.M3) return;
  const keys = await env.M3.list({ prefix: 'stat:' });
  for (const { name } of keys.keys) {
    const model = name.slice(5);
    const s = await getStat(env, model);
    if (!s || s.reminded || s.orders || s.declines) continue;
    if (Date.now() - s.first < SILENT_DAYS * 86400e3) continue;
    if (await env.M3.get(`revoked:${model}`)) continue;
    const r = await toManager(env, [`🤔 <b>Клієнт мовчить</b> вже ${Math.floor((Date.now() - s.first) / 86400e3)} дн.`, statText(model, s), '', 'Час дзвонити!'].join('\n'));
    if (r.ok) { s.reminded = Date.now(); await env.M3.put(name, JSON.stringify(s)); }
    console.log(JSON.stringify({ remind: model, ok: r.ok }));
  }
}

// ---------- Відміна проєкту ----------
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
  return json({ ok: true, results });
}

// ---------- Бот: команди менеджера і повідомлення клієнтів ----------
/** Секрет вебхука: HMAC від токена бота — однаково рахують воркер і tools/setup-bot.mjs, окремо зберігати не треба. */
async function webhookSecret(env) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(env.BOT_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode('m3-webhook')));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function onUpdate(request, env) {
  if (!env.BOT_TOKEN || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== await webhookSecret(env)) {
    return new Response('Forbidden', { status: 403 });
  }
  let upd;
  try { upd = await request.json(); } catch { return new Response('ok'); }
  const m = upd.message;
  if (!m || !m.chat || m.chat.type !== 'private') return new Response('ok');
  const text = (m.text || '').trim();
  const reply = (t, extra = {}) => tgApi(env, 'sendMessage', { chat_id: m.chat.id, text: t, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

  // Менеджер
  if (String(m.from.id) === String(env.CHAT_ID)) {
    const cmd = /^\/?(stat|стат|статистика)(?:@\w+)?\s*([a-zA-Z0-9-]*)/i.exec(text);
    if (cmd) {
      const q = cmd[2];
      const keys = (await env.M3.list({ prefix: 'stat:' })).keys.map((k) => k.name.slice(5));
      if (q) {
        const found = keys.filter((k) => k === q || k.endsWith(`-${q}`));
        if (!found.length) { await reply(`Статистики по «${esc(q)}» немає — модель ще ніхто не відкривав.`); return new Response('ok'); }
        for (const k of found) await reply(statText(k, await getStat(env, k)));
      } else {
        const all = (await Promise.all(keys.map(async (k) => [k, await getStat(env, k)]))).filter(([, s]) => s)
          .sort((a, b) => b[1].last - a[1].last).slice(0, 10);
        await reply(all.length
          ? all.map(([k, s]) => `<b>${esc(s.title || k)}</b> — 👀 ${s.opens} · 📄 ${s.kp}${s.orders ? ' · ✅ заявка' : ''}${s.declines ? ' · ❌ відмова' : ''} · ${when(s.last)}`).join('\n')
            + '\n\nДетально: «стат 46»'
          : 'Поки що ніхто нічого не відкривав.');
      }
      return new Response('ok');
    }
    await reply('Команди:\n• <b>стат</b> — останні 10 проєктів\n• <b>стат 46</b> — детально по замовленню №46');
    return new Response('ok');
  }

  // Клієнт: /start — привітання; інше — передаємо менеджеру
  if (/^\/start\b/.test(text)) {
    await reply('Вітаємо! Це бот М3 Меблі 🙂\nТут з\'являтимуться ваші 3D-проєкти. З будь-яким питанням — пишіть менеджеру.', { reply_markup: managerBtn });
    return new Response('ok');
  }
  const f = m.from;
  const who = [`<a href="tg://user?id=${f.id}">${esc([f.first_name, f.last_name].filter(Boolean).join(' ') || 'клієнт')}</a>`, f.username ? `@${esc(f.username)}` : ''].filter(Boolean).join(' ');
  let r = await toManager(env, `💬 Клієнт написав боту\nХто: ${who}\n\n${text ? esc(text.slice(0, 3000)) : '(фото/файл — пересилаю нижче)'}`);
  if (!r.ok) r = await toManager(env, `💬 Клієнт написав боту\nХто: ${esc(f.first_name || '')} ${f.username ? '@' + esc(f.username) : ''} (id ${f.id})\n\n${text ? esc(text.slice(0, 3000)) : '(фото/файл — пересилаю нижче)'}`);
  if (!text) await tgApi(env, 'forwardMessage', { chat_id: env.CHAT_ID, from_chat_id: m.chat.id, message_id: m.message_id });
  await reply('Дякуємо! Передали ваше повідомлення менеджеру — він відповість найближчим часом.', { reply_markup: managerBtn });
  return new Response('ok');
}

// ---------- Події з сайту ----------
async function onEvent(request, env) {
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
  const ok = (client) => json({ ok: true, client }, cors(origin));

  // Свої відкриття (менеджер дивиться сам) — не повідомляємо і не рахуємо
  if (u && String(u.id) === String(env.CHAT_ID)) { log('own'); return ok('own'); }

  // Повтори того самого (оновив сторінку) — не частіше разу на 2 хв від одного клієнта.
  // Ключ — Telegram-користувач, а не IP: інакше вся сім'я на одному Wi-Fi «зливається» в одного.
  const who = (u && u.id) || request.headers.get('CF-Connecting-IP') || '';
  const cache = caches.default;
  const key = new Request(`https://notify.local/${data.event}/${model}/${encodeURIComponent(who)}`);
  if (await cache.match(key)) { log('repeat'); return ok('repeat'); }
  await cache.put(key, new Response('1', { headers: { 'Cache-Control': 'max-age=120' } }));

  // «Санвузол · №460» → «№460 · Санвузол»: спершу номер замовлення
  const parts = clean(data.title, 80).split(' · ').filter(Boolean);
  let what = parts.length > 1 ? `${parts.slice(1).join(' · ')} · ${parts[0]}` : (parts[0] || model);
  const uid = u && /^[0-9]{1,15}$/.test(String(u.id)) ? String(u.id) : '';
  const reasonText = data.event === 'decline' ? clean(data.reason, 300) : '';

  const stat = await bumpStat(env, model, what === model ? '' : what, data.event, reasonText, uid);
  if (what === model && stat && stat.title) what = stat.title; // прострочена: назви на сторінці немає — беремо зі статистики

  const uname = u ? clean(u.name, 60) : '';
  const unick = u && u.username ? `@${clean(u.username, 40)}` : '';
  const whoLine = !u ? `невідомо (${data.telegram ? 'у Telegram' : 'у браузері'})`
    : [uid ? `<a href="tg://user?id=${uid}">${uname || 'клієнт'}</a>` : uname, unick].filter(Boolean).join(' ');
  const reason = reasonText ? `Причина: ${reasonText}` : '';
  const counts = stat && data.event !== 'open' ? `👀 ${stat.opens} · 📄 ${stat.kp}` : '';

  // Клікабельне ім'я Telegram приймає не для кожного клієнта — тоді шлемо без посилання
  const quiet = data.event === 'open';
  let res = await toManager(env, [event, `<b>${what}</b>`, `Хто: ${whoLine}`, reason, counts].filter(Boolean).join('\n'), quiet);
  if (!res.ok) {
    const plain = !u ? whoLine : [uname, unick, uid ? `(id ${uid})` : ''].filter(Boolean).join(' ');
    res = await toManager(env, [event, `<b>${what}</b>`, `Хто: ${plain}`, reason, counts].filter(Boolean).join('\n'), quiet);
  }

  // Клієнту в чат з ботом (лише перевіреному): після «Замовити» і після відмови «Дорого»
  let clientText = '';
  if (data.event === 'order') {
    clientText = `Дякуємо! Вашу заявку на «${what}» передано менеджеру.\n\nМенеджер напише вам найближчим часом. Або напишіть самі — натисніть кнопку нижче.`;
  } else if (data.event === 'decline' && reasonText === 'Дорого') {
    clientText = `Дякуємо, що переглянули «${what}»!\n\nМи можемо підібрати дешевші матеріали чи фурнітуру — вигляд майже не зміниться, а ціна стане приємнішою. Напишіть менеджеру — порахуємо варіант під ваш бюджет.`;
  }
  let toClient = null;
  if (clientText && tgUser && uid) {
    const r = await tgApi(env, 'sendMessage', { chat_id: uid, text: clientText, reply_markup: managerBtn });
    toClient = r.ok ? 'sent' : `fail: ${r.description || ''}`;
    if (r.ok) await rememberMsg(env, model, uid, r.result.message_id);
  }

  log(`${res.ok ? 'sent' : `fail: ${res.description || ''}`}${toClient ? ` / client: ${toClient}` : ''}`);
  return json({ ok: !!res.ok, client: toClient }, cors(origin));
}

// ---------- Присадка: ключ лише менеджеру ----------
// Файл data/<назва>.drill.bin зашифровано ключем HMAC-SHA256(токен бота, "m3-drill") (tools/convert-dae.mjs).
// Віддаємо ключ, лише якщо підписані Telegram дані (initData) належать менеджеру (CHAT_ID).
async function drillKey(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!ALLOWED_ORIGINS.includes(origin)) return new Response('Forbidden', { status: 403 });
  let data;
  try { data = await request.json(); } catch { return new Response('Bad request', { status: 400, headers: cors(origin) }); }
  const u = await verifiedUser(data.initData, env.BOT_TOKEN);
  if (!u || String(u.id) !== String(env.CHAT_ID)) return json({ ok: false }, cors(origin));
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(env.BOT_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const raw = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode('m3-drill')));
  const key = btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return json({ ok: true, key }, { ...cors(origin), 'Cache-Control': 'no-store' });
}

// ---------- Файли моделей (GLB, КП, присадка) — у KV замість git ----------
// Так репозиторій не розростається, а відміна видаляє файли насправді. Ключ KV: f:<файл>.
// Читати — будь-кому (як і сайт); записувати й видаляти — лише з ключем менеджера (REVOKE_KEY).
const FILE_RE = /^\/f\/([a-zA-Z0-9-]{1,64}\.(glb|kp\.bin|drill\.bin))$/;
const FILE_TYPES = { glb: 'model/gltf-binary', 'kp.bin': 'application/octet-stream', 'drill.bin': 'application/octet-stream' };
async function files(request, env, file, ext) {
  const key = `f:${file}`;
  if (request.method === 'GET' || request.method === 'HEAD') {
    const cache = caches.default;
    const hit = await cache.match(request);
    if (hit) return hit;
    const body = await env.M3.get(key, 'arrayBuffer');
    if (!body) return new Response('Not found', { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } });
    const res = new Response(body, {
      headers: { 'Content-Type': FILE_TYPES[ext], 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' },
    });
    await cache.put(request, res.clone());
    return res;
  }
  if (!env.REVOKE_KEY || request.headers.get('X-M3-Key') !== env.REVOKE_KEY) return new Response('Forbidden', { status: 403 });
  if (request.method === 'PUT') {
    const body = await request.arrayBuffer();
    if (!body.byteLength || body.byteLength > 25 * 1024 * 1024) return new Response('Bad size', { status: 413 });
    await env.M3.put(key, body);
    await caches.default.delete(new Request(request.url));
    return json({ ok: true, size: body.byteLength });
  }
  if (request.method === 'DELETE') {
    await env.M3.delete(key);
    await caches.default.delete(new Request(request.url));
    return json({ ok: true });
  }
  return new Response('Method not allowed', { status: 405 });
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const fm = FILE_RE.exec(path);
    if (fm) return files(request, env, fm[1], fm[2]);
    if (path === '/revoke' && request.method === 'POST') return revoke(request, env);
    if (path === '/tg' && request.method === 'POST') return onUpdate(request, env);
    if (path === '/drillkey' && request.method === 'POST') return drillKey(request, env);
    return onEvent(request, env);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(remindSilent(env));
  },
};
