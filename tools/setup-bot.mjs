// Одноразове налаштування бота: команди «стат» і пересилання повідомлень клієнтів менеджеру.
// Запуск: M3-bot-setup.bat (один раз; повторний запуск безпечний).
//  1. Каже Telegram надсилати повідомлення боту на воркер (setWebhook). Секрет вебхука — HMAC від токена бота,
//     воркер рахує його так само, тож у Cloudflare нічого записувати не треба.
//  2. Додає команду /stat у меню бота (лише в чаті менеджера).

import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
const WORKER = 'https://m3-notify.yurii-turok-sabadosh.workers.dev';

const token = JSON.parse(fs.readFileSync('bot.config.json', 'utf8')).botToken;
const secret = createHmac('sha256', token).update('m3-webhook').digest('hex');
const tg = (method, body) => fetch(`https://api.telegram.org/bot${token}/${method}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then((x) => x.json());

console.log('1/2 Підключаю бота до воркера…');
const w = await tg('setWebhook', { url: `${WORKER}/tg`, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: true });
if (!w.ok) { console.error('Telegram: ' + w.description); process.exit(1); }

console.log('2/2 Додаю команду в меню бота…');
const chatId = JSON.parse(fs.readFileSync(path.join('keys', 'telegram.json'), 'utf8')).chatId;
await tg('setMyCommands', {
  commands: [{ command: 'stat', description: 'Статистика: /stat або /stat 46' }],
  scope: { type: 'chat', chat_id: chatId },
});

console.log('\nГотово! Напишіть боту «стат» — він покаже, хто що відкривав.');
