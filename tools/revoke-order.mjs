// Відміна проєкту: замовник більше не має доступу до 3D-моделі й КП, повідомлення бота прибираються.
// Використання:  node tools/revoke-order.mjs 46        (номер замовлення)
//                node tools/revoke-order.mjs sanvuzol-46 (або назва з посилання)
//   або «M3-відміна.bat» — спитає номер.
//
// Кроки:
//  1. Картки, які бот надсилав тобі (keys/<назва>.msg.json): видалити, а старші за 48 год — переписати
//     на «не актуальна» без кнопки (Telegram не дає боту видаляти старіші).
//  2. Повідомлення бота клієнтам (після «Замовити») — те саме, через воркер (там збережено, кому що надіслано).
//  3. Сайт: видалити модель, КП і прев'ю, додати назву в data/revoked.json (сторінка покаже «Доступ закрито»),
//     git push.
//  4. Ключі КП і список карток — у keys/revoked/ (на випадок, якщо доведеться відновити).
// Переслану тобою картку видалити не можна (це вже твоє повідомлення), але кнопка в ній відкриє «Доступ закрито».

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Повний шлях (realpath): батник із БАЗИСу запускає нас коротким 8.3 (3D-VIE~1), і Vite з ним не знаходить бібліотеки
const ROOT = fs.realpathSync.native(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
process.chdir(ROOT);
const WORKER = 'https://m3-notify.yurii-turok-sabadosh.workers.dev';
const LOG = path.join(ROOT, 'publish-log.txt');
const log = (s) => {
  const line = `[${new Date().toLocaleTimeString('uk-UA')}] ВІДМІНА: ${s}`;
  console.log(line);
  fs.appendFileSync(LOG, line + '\n');
};
const GIT = ['C:/Program Files/Git/cmd/git.exe', 'C:/Program Files/Git/bin/git.exe'].find((p) => fs.existsSync(p)) || 'git';
const git = (args) => execFileSync(GIT, args, { cwd: ROOT, encoding: 'utf8' });

// ---- Яке замовлення ----
let arg = (process.argv[2] || '').trim();
if (!arg) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  arg = (await new Promise((r) => rl.question('Номер замовлення (або назва з посилання): ', r))).trim();
  rl.close();
}
const models = fs.readdirSync('data').filter((f) => f.endsWith('.glb')).map((f) => f.slice(0, -4));
let slug = models.includes(arg) ? arg : null;
if (!slug && /^[0-9]+$/.test(arg)) {
  const found = models.filter((m) => m.endsWith(`-${arg}`));
  if (found.length > 1) { log(`номер ${arg} підходить до кількох моделей: ${found.join(', ')} — вкажіть назву`); process.exit(1); }
  slug = found[0] || null;
}
if (!slug) { log(`модель «${arg}» не знайдено серед опублікованих (${models.join(', ') || 'немає'})`); process.exit(1); }
log(`замовлення ${slug}`);

const token = JSON.parse(fs.readFileSync('bot.config.json', 'utf8')).botToken;
const tg = (method, body) => fetch(`https://api.telegram.org/bot${token}/${method}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json()).catch(() => ({ ok: false }));
const STALE = 'Ця пропозиція від М3 Меблі більше не актуальна.';

// ---- 1. Картки в твоєму чаті ----
const msgFile = path.join('keys', `${slug}.msg.json`);
const cards = fs.existsSync(msgFile) ? JSON.parse(fs.readFileSync(msgFile, 'utf8')) : [];
for (const m of cards) {
  let r = await tg('deleteMessage', { chat_id: m.chat, message_id: m.id });
  let how = 'видалено';
  if (!r.ok) {
    r = await tg('editMessageCaption', { chat_id: m.chat, message_id: m.id, caption: STALE, reply_markup: { inline_keyboard: [] } });
    if (!r.ok) r = await tg('editMessageText', { chat_id: m.chat, message_id: m.id, text: STALE, reply_markup: { inline_keyboard: [] } });
    how = r.ok ? 'переписано на «не актуальна»' : `не вдалося (${r.description || ''})`;
  }
  log(`картка ${m.id}: ${how}`);
}
if (!cards.length) log('збережених карток немає (надіслані до появи відміни бот не запам\'ятовував)');

// ---- 2. Повідомлення бота клієнтам ----
try {
  const key = fs.readFileSync(path.join('keys', 'revoke.txt'), 'utf8').trim();
  const r = await (await fetch(`${WORKER}/revoke`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-M3-Key': key }, body: JSON.stringify({ slug }),
  })).json();
  log(`повідомлень клієнтам: ${r.results.length}${r.results.length ? ' — ' + r.results.map((x) => x.result).join(', ') : ''}`);
} catch (err) {
  log(`повідомлення клієнтам прибрати не вдалося: ${err.message}`);
}

// ---- 3. Сайт: прибрати файли, позначити як закриту ----
const revokedFile = path.join('data', 'revoked.json');
const revoked = fs.existsSync(revokedFile) ? JSON.parse(fs.readFileSync(revokedFile, 'utf8')) : [];
if (!revoked.includes(slug)) revoked.push(slug);
fs.writeFileSync(revokedFile, JSON.stringify(revoked, null, 2) + '\n');
// Сховище воркера: видалити файли насправді
try {
  const key = fs.readFileSync(path.join('keys', 'revoke.txt'), 'utf8').trim();
  for (const e of ['glb', 'kp.bin', 'drill.bin']) await fetch(`${WORKER}/f/${slug}.${e}`, { method: 'DELETE', headers: { 'X-M3-Key': key } });
  log('зі сховища воркера видалено');
} catch (err) {
  log(`зі сховища воркера видалити не вдалося: ${err.message}`);
}
const files = ['glb', 'kp.bin', 'drill.bin', 'jpg'].map((e) => `data/${slug}.${e}`).filter((f) => fs.existsSync(f));
// У git — лише ті, що там є (нові моделі в git не потрапляють); решта — просто з диска
const tracked = git(['ls-files', '--', ...files]).split(/\r?\n/).filter(Boolean);
if (tracked.length) git(['rm', '-q', '--', ...tracked]);
for (const f of files) if (!tracked.includes(f)) fs.rmSync(f, { force: true });
git(['add', revokedFile]);
git(['commit', '-q', '-m', `Відміна замовлення ${slug}: доступ закрито`]);
git(['push', '-q']);
log(`з сайту прибрано: ${files.join(', ')}; доступ закриється за 1–2 хв`);

// ---- 4. Ключі — в архів ----
fs.mkdirSync(path.join('keys', 'revoked'), { recursive: true });
for (const f of [`${slug}.txt`, `${slug}.msg.json`]) {
  const p = path.join('keys', f);
  if (fs.existsSync(p)) fs.renameSync(p, path.join('keys', 'revoked', f));
}
log('готово');
