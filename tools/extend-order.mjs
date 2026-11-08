// Продовжити термін дії пропозиції (або зняти обмеження).
// Використання:  node tools/extend-order.mjs 46 14    — ще 14 днів від сьогодні
//                node tools/extend-order.mjs 46 0     — без терміну
//   або «M3-extend.bat» — спитає номер і кількість днів.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
const LOG = path.join(ROOT, 'publish-log.txt');
const log = (s) => {
  const line = `[${new Date().toLocaleTimeString('uk-UA')}] ТЕРМІН: ${s}`;
  console.log(line);
  fs.appendFileSync(LOG, line + '\n');
};
const GIT = ['C:/Program Files/Git/cmd/git.exe', 'C:/Program Files/Git/bin/git.exe'].find((p) => fs.existsSync(p)) || 'git';
const git = (args) => execFileSync(GIT, args, { cwd: ROOT, encoding: 'utf8' });

const ask = async (q) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((r) => rl.question(q, r));
  rl.close();
  return a.trim();
};
let arg = (process.argv[2] || '').trim() || await ask('Номер замовлення (або назва з посилання): ');
let daysArg = (process.argv[3] || '').trim() || await ask('На скільки днів продовжити (0 — без терміну) [14]: ') || '14';
const days = Number(daysArg);
if (!Number.isFinite(days) || days < 0) { log(`некоректна кількість днів: ${daysArg}`); process.exit(1); }

const models = fs.readdirSync('data').filter((f) => f.endsWith('.glb')).map((f) => f.slice(0, -4));
let slug = models.includes(arg) ? arg : null;
if (!slug && /^[0-9]+$/.test(arg)) {
  const found = models.filter((m) => m.endsWith(`-${arg}`));
  if (found.length > 1) { log(`номер ${arg} підходить до кількох моделей: ${found.join(', ')} — вкажіть назву`); process.exit(1); }
  slug = found[0] || null;
}
if (!slug) { log(`модель «${arg}» не знайдено серед опублікованих`); process.exit(1); }

const file = path.join('data', 'expiry.json');
const map = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
if (days === 0) {
  delete map[slug];
} else {
  const d = new Date(Date.now() + days * 86400e3);
  map[slug] = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
fs.writeFileSync(file, JSON.stringify(map, null, 2) + '\n');
git(['add', file]);
git(['commit', '-q', '-m', `Термін пропозиції ${slug}: ${days ? map[slug] : 'без терміну'}`]);
git(['push', '-q']);
log(`${slug}: ${days ? `дійсна до ${map[slug].split('-').reverse().join('.')}` : 'без терміну'} (на сайті за 1–2 хв)`);
