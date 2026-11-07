// Шифрування КП (PDF) для публічного сайту.
// Використання:  npm run kp -- "шлях\до\КП.pdf" назва-моделі
// Результат:     data/<назва>.kp.bin  — зашифрований файл (його можна викладати)
//                keys/<назва>.txt     — ключ і готове посилання для клієнта (НЕ в git)
//
// AES-256-GCM: [12 байт IV][шифротекст + тег]. Ключ — 32 випадкові байти, у посиланні після «#»
// (частину після # браузер не надсилає на сервер). Повторний запуск бере той самий ключ,
// тож уже надіслані клієнту посилання не ламаються.

import fs from 'node:fs';
import path from 'node:path';
import { webcrypto as crypto } from 'node:crypto';

const SITE = 'https://yuriituroksabadosh-wq.github.io/3d-viewer/';
const TG_APP = 'https://t.me/m3_prodject_bot/view';
const [pdfArg, slug] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!pdfArg || !slug || !/^[a-zA-Z0-9-]{1,64}$/.test(slug)) {
  console.error('Використання: npm run kp -- "шлях\\до\\КП.pdf" назва-моделі');
  process.exit(1);
}

const pdf = fs.readFileSync(path.resolve(pdfArg));
if (pdf.subarray(0, 4).toString() !== '%PDF') {
  console.error('Це не PDF-файл:', pdfArg);
  process.exit(1);
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// Ключ: беремо збережений (щоб посилання клієнта не змінилось) або створюємо новий
fs.mkdirSync('keys', { recursive: true });
const keyFile = path.join('keys', `${slug}.txt`);
let keyText = '';
if (fs.existsSync(keyFile)) {
  const m = /kp=([A-Za-z0-9_-]{43})/.exec(fs.readFileSync(keyFile, 'utf8'));
  if (m) keyText = m[1];
}
if (process.argv.includes('--new-key') || !keyText) keyText = b64url(crypto.getRandomValues(new Uint8Array(32)));

const key = await crypto.subtle.importKey('raw', fromB64url(keyText), 'AES-GCM', false, ['encrypt']);
const iv = crypto.getRandomValues(new Uint8Array(12));
const enc = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pdf));

const out = path.resolve('data', `${slug}.kp.bin`);
fs.writeFileSync(out, Buffer.concat([Buffer.from(iv), Buffer.from(enc)]));

const link = `${SITE}?model=${slug}#kp=${keyText}`;
// Пряме посилання на міні-застосунок бота: Telegram відкриває модель одразу, без «Запустити» в боті.
// Міні-застосунок створюється один раз у @BotFather (/newapp, коротка назва «view»).
const tgLink = `${TG_APP}?startapp=${slug}__${keyText}`;
fs.writeFileSync(keyFile,
  `Модель: ${slug}\n\nДля клієнта в Telegram (відкриває одразу в Telegram, з КП):\n${tgLink}\n\nДля браузера (з КП):\n${link}\n`,
  'utf8');

console.log('Зашифровано:', out, `(${(pdf.length / 1024).toFixed(0)} КБ)`);
console.log('Ключ збережено:', path.resolve(keyFile), '(у git не потрапляє)');
console.log('Посилання для клієнта в Telegram:\n' + tgLink);
console.log('Посилання для браузера:\n' + link);
