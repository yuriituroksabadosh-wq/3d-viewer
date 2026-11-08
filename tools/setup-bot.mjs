// Одноразове налаштування бота: команди «стат» і пересилання повідомлень клієнтів менеджеру.
// Запуск: M3-bot-setup.bat (один раз). Повторний запуск безпечний — просто згенерує новий секрет.
//  1. Генерує секрет вебхука (keys/webhook.txt, поза git).
//  2. Записує його у воркер Cloudflare (wrangler secret put WEBHOOK_SECRET).
//  3. Каже Telegram надсилати повідомлення боту на воркер (setWebhook) і додає команду /stat у меню бота.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
const WORKER = 'https://m3-notify.yurii-turok-sabadosh.workers.dev';

const secret = randomBytes(24).toString('hex');
fs.mkdirSync('keys', { recursive: true });
fs.writeFileSync(path.join('keys', 'webhook.txt'), secret);

console.log('1/3 Записую секрет у воркер Cloudflare…');
const npx = path.join(path.dirname(process.execPath), 'npx.cmd');
const r = spawnSync(`"${npx}" wrangler@3.114.0 secret put WEBHOOK_SECRET`, {
  cwd: path.join(ROOT, 'notify-worker'), input: secret, shell: true, encoding: 'utf8',
});
if (r.status !== 0) {
  console.error('Не вдалося записати секрет:\n' + (r.stderr || r.stdout));
  process.exit(1);
}

const token = JSON.parse(fs.readFileSync('bot.config.json', 'utf8')).botToken;
const tg = (method, body) => fetch(`https://api.telegram.org/bot${token}/${method}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then((x) => x.json());

console.log('2/3 Підключаю бота до воркера…');
const w = await tg('setWebhook', { url: `${WORKER}/tg`, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: true });
if (!w.ok) { console.error('Telegram: ' + w.description); process.exit(1); }

console.log('3/3 Додаю команду в меню бота…');
await tg('setMyCommands', {
  commands: [{ command: 'stat', description: 'Статистика: /stat або /stat 46' }],
  scope: { type: 'chat', chat_id: JSON.parse(fs.readFileSync(path.join('keys', 'telegram.json'), 'utf8')).chatId },
});

console.log('\nГотово! Напишіть боту «стат» — він покаже, хто що відкривав.');
