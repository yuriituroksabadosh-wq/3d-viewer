// Повна автоматична публікація замовлення — без участі людини.
// Використання:  node tools/publish-order.mjs "шлях\до\папки замовлення"
//   (або перетягнути папку на «M3-publish.bat»; або скрипт БАЗИС запускає сам)
//
// Кроки: знайти .dae → конвертувати (+ КП) → git push → дочекатися оновлення сайту →
//        зробити прев'ю → надіслати картку в Telegram-бот.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://yuriituroksabadosh-wq.github.io/3d-viewer/';
const LOG = path.join(ROOT, 'publish-log.txt');
process.chdir(ROOT);

const log = (s) => {
  const line = `[${new Date().toLocaleTimeString('uk-UA')}] ${s}`;
  console.log(line);
  fs.appendFileSync(LOG, line + '\n');
};
const fail = (s) => {
  log('ПОМИЛКА: ' + s);
  process.exit(1);
};
const node = (args) => execFileSync(process.execPath, args, { stdio: 'inherit', cwd: ROOT });

// git: з PATH або зі стандартного місця
const GIT = ['C:/Program Files/Git/cmd/git.exe', 'C:/Program Files/Git/bin/git.exe'].find((p) => fs.existsSync(p)) || 'git';
const git = (args) => execFileSync(GIT, args, { cwd: ROOT, encoding: 'utf8' });

// ---- 1. Папка замовлення і модель ----
let dir = (process.argv[2] || '').replace(/^"|"$/g, '').trim();
if (dir && fs.existsSync(dir) && fs.statSync(dir).isFile()) dir = path.dirname(dir);
if (!dir || !fs.existsSync(dir)) fail('Не вказано папку замовлення або її не існує: ' + dir);
log('Папка замовлення: ' + dir);

const daes = fs.readdirSync(dir).filter((f) => /[.]dae$/i.test(f))
  .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
if (!daes.length) fail('У папці немає .dae — збережіть модель у БАЗИСі як COLLADA (*.dae) у цю папку.');
const dae = path.join(dir, daes[0].f);
log('Модель: ' + daes[0].f);

// ---- 2. Назва для посилання: назва виробу латиницею + номер папки ----
let meta = {};
const infoPath = path.join(dir, 'm3-viewer.json');
if (fs.existsSync(infoPath)) {
  const raw = fs.readFileSync(infoPath);
  let text = new TextDecoder('utf-8').decode(raw);
  if (text.includes('\uFFFD')) text = new TextDecoder('windows-1251').decode(raw);
  meta = JSON.parse(text.replace(/^\uFEFF/, ''));
} else {
  log('Увага: немає m3-viewer.json (скрипт «Експорт для 3D-перегляду» не запускався) — без назви, префікса й кріплень');
}
const TR = { а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia', ы: 'y', э: 'e', ъ: '', ё: 'io' };
const translit = (s) => String(s || '').toLowerCase().split('').map((c) => (c in TR ? TR[c] : c)).join('')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const num = (/^([0-9]+)/.exec(path.basename(dir)) || /([0-9]+)/.exec(meta.prefix || '') || [])[1] || '';
const base = translit(meta.name || path.basename(dae, path.extname(dae))).slice(0, 40) || 'model';
const slug = [base, num].filter(Boolean).join('-');
log('Назва в посиланні: ' + slug);

// ---- 3. Конвертація (+ шифрування КП з папки) ----
log('Конвертую модель…');
node([path.join('tools', 'convert-dae.mjs'), dae, slug]);
const glb = path.join(ROOT, 'data', `${slug}.glb`);
if (!fs.existsSync(glb)) fail('Конвертація не створила ' + glb);

// ---- 4. Публікація: лише файли цього замовлення ----
log('Викладаю на сайт…');
const files = [`data/${slug}.glb`, `data/${slug}.kp.bin`].filter((f) => fs.existsSync(path.join(ROOT, f)));
git(['add', ...files]);
const staged = git(['diff', '--cached', '--name-only']).trim();
if (staged) {
  git(['-c', 'user.name=Yurii Turok', '-c', 'user.email=yurii.turok.sabadosh@gmail.com',
    'commit', '-q', '-m', `Замовлення ${slug}: модель${files.length > 1 ? ' і КП' : ''}`]);
  git(['push', '-q', 'origin', 'main']);
  log('Викладено: ' + files.join(', '));
} else {
  log('Файли не змінились — викладати нічого');
}

// ---- 5. Чекаємо, поки сайт віддасть САМЕ ЦІ файли (звіряємо вміст, а не розмір) ----
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const wanted = files.map((f) => ({ f, hash: sha(fs.readFileSync(path.join(ROOT, f))) }));
log('Чекаю оновлення сайту (зазвичай 1–2 хв)…');
let ok = false;
for (let i = 0; i < 60 && !ok; i++) {
  try {
    ok = true;
    for (const { f, hash } of wanted) {
      const r = await fetch(`${SITE}${f}?t=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok || sha(Buffer.from(await r.arrayBuffer())) !== hash) { ok = false; break; }
    }
  } catch { ok = false; /* мережа — пробуємо ще */ }
  if (!ok) await sleep(10000);
}
if (!ok) fail('Сайт не оновився за 10 хв. Перевірте інтернет і запустіть ще раз.');
log('Сайт оновлено');

// ---- 6. Прев'ю з живого сайту (до трьох спроб) ----
log('Роблю прев\'ю…');
let shot = false;
for (let i = 1; i <= 3 && !shot; i++) {
  try {
    node([path.join('tools', 'preview.mjs'), slug, SITE]);
    shot = true;
  } catch {
    log(`Прев'ю: спроба ${i} не вдалась${i < 3 ? ', повторюю…' : ''}`);
    if (i < 3) await sleep(15000);
  }
}
if (!shot) log('Прев\'ю не вийшло — картка піде без фото');

// ---- 7. Картка в Telegram ----
log('Надсилаю картку в бот…');
node([path.join('tools', 'send-tg.mjs'), slug]);
log(`Готово: ${slug}. Перешліть картку з бота замовнику.`);
