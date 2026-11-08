// Надсилає модель у Telegram: прев'ю (data/<назва>.jpg) + підпис + кнопка «Відкрити 3D-модель».
// Використання:  npm run send -- назва-моделі [chat_id]
//
// Токен — з bot.config.json, ключ КП — з keys/<назва>.txt (якщо є, у кнопку йде посилання з КП).
// Чат: з аргументу, або збережений у keys/telegram.json, або останній, хто писав боту.
// Усі ці файли поза git.

import fs from 'node:fs';
import path from 'node:path';

const [slug, chatArg] = process.argv.slice(2);
if (!slug || !/^[a-zA-Z0-9-]{1,64}$/.test(slug)) {
  console.error('Використання: npm run send -- назва-моделі [chat_id]');
  process.exit(1);
}

const token = JSON.parse(fs.readFileSync('bot.config.json', 'utf8')).botToken;
const api = (method) => `https://api.telegram.org/bot${token}/${method}`;

// ---- Чат ----
const chatFile = path.join('keys', 'telegram.json');
let chatId = chatArg || (fs.existsSync(chatFile) ? JSON.parse(fs.readFileSync(chatFile, 'utf8')).chatId : '');
if (!chatId) {
  const up = await (await fetch(api('getUpdates'))).json();
  const last = (up.result || []).map((u) => u.message || u.edited_message).filter((m) => m && m.chat.type === 'private').pop();
  if (!last) {
    console.error('Немає чату: напишіть боту /start і повторіть, або вкажіть chat_id.');
    process.exit(1);
  }
  chatId = last.chat.id;
}
fs.mkdirSync('keys', { recursive: true });
fs.writeFileSync(chatFile, JSON.stringify({ chatId }, null, 2));

// ---- Назва й префікс з моделі (GLB extras) ----
let title = slug;
const glbPath = path.join('data', `${slug}.glb`);
if (fs.existsSync(glbPath)) {
  const b = fs.readFileSync(glbPath);
  const json = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8'));
  const m3 = json.scenes?.[json.scene || 0]?.extras?.m3;
  if (m3?.name) title = [m3.name, m3.prefix].filter(Boolean).join(' · ');
}

// ---- Посилання: пряме посилання на міні-застосунок (з ключем КП, якщо він є) ----
// Кнопка — звичайне посилання (url), а не web_app: такі кнопки Telegram зберігає при пересиланні,
// тож це повідомлення можна просто переслати замовнику.
const TG_APP = 'https://t.me/m3_prodject_bot/view';
let url = `${TG_APP}?startapp=${slug}`;
let withKp = false;
const keyFile = path.join('keys', `${slug}.txt`);
if (fs.existsSync(keyFile) && fs.existsSync(path.join('data', `${slug}.kp.bin`))) {
  const m = /kp=([A-Za-z0-9_-]{43})/.exec(fs.readFileSync(keyFile, 'utf8'));
  if (m) { url += `__${m[1]}`; withKp = true; }
}

const caption = `${title}\n3D-модель${withKp ? ' і комерційна пропозиція' : ''} від М3 Меблі.\n\nНатисніть «Відкрити 3D-модель».`;
const reply_markup = JSON.stringify({ inline_keyboard: [[{ text: 'Відкрити 3D-модель', url }]] });

// ---- Відправка: фото з кнопкою, а якщо прев'ю немає — просто повідомлення ----
const photoPath = path.join('data', `${slug}.jpg`);
let res;
if (fs.existsSync(photoPath)) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', caption);
  form.append('reply_markup', reply_markup);
  form.append('photo', new Blob([fs.readFileSync(photoPath)], { type: 'image/jpeg' }), `${slug}.jpg`);
  res = await (await fetch(api('sendPhoto'), { method: 'POST', body: form })).json();
} else {
  console.log('Прев\'ю немає (npm run shot -- ' + slug + ') — надсилаю без фото');
  res = await (await fetch(api('sendMessage'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: caption, reply_markup: JSON.parse(reply_markup) }),
  })).json();
}
console.log(res.ok ? `Надіслано в чат ${chatId}: «${title}»${withKp ? ' (з КП)' : ''}` : `Помилка Telegram: ${res.description}`);

// Запам'ятовуємо картку — щоб «Відміна проєкту» могла її прибрати
if (res.ok) {
  const msgFile = path.join('keys', `${slug}.msg.json`);
  const list = fs.existsSync(msgFile) ? JSON.parse(fs.readFileSync(msgFile, 'utf8')) : [];
  list.push({ chat: chatId, id: res.result.message_id });
  fs.writeFileSync(msgFile, JSON.stringify(list, null, 2));
}
