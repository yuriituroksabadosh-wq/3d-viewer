// Конвертер моделі з БАЗИСу (COLLADA .dae + папка текстур) у стиснутий GLB для сайту.
// Використання:  npm run convert -- "шлях\до\Модель.dae" назва-латиницею
// Результат:     data/<назва>.glb
//
// Кроки: assimp (той самий рушій, яким БАЗИС пише .dae) -> GLB,
// потім glTF-Transform: дедуплікація, інстансинг, стиснення сіток (meshopt) і текстур (webp, до 1024 px).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, instance, prune, weld, textureCompress, meshopt, getBounds } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import { daeToDocument } from './dae-parse.mjs';

const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const [daeArg, slug] = args.filter((a) => !a.startsWith("--"));
// Повне замовлення з БАЗИСу часто містить ім'я клієнта, а сайт публічний — додаємо лише на явний запит
const withOrder = args.includes("--with-order");
if (!daeArg || !slug || !/^[a-zA-Z0-9-]{1,64}$/.test(slug)) {
  console.error('Використання: npm run convert -- "шлях\\до\\Модель.dae" назва-латиницею');
  process.exit(1);
}

const daePath = path.resolve(daeArg);
const daeDir = path.dirname(daePath);
const outPath = path.resolve('data', `${slug}.glb`);
const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' МБ';

// Збирає всі файли, на які посилається .dae (текстури), з розкодованими шляхами
function referencedFiles(daeText) {
  const refs = new Set();
  for (const m of daeText.matchAll(/<init_from>([^<]+)<\/init_from>/g)) {
    const raw = m[1].trim();
    if (!/\.(jpe?g|png|bmp|tga|gif|webp)$/i.test(raw)) continue;
    refs.add(decodeURIComponent(raw).replace(/\\/g, '/'));
  }
  return [...refs];
}

// Назва ефекту/матеріалу → дифузний колір [r, g, b] (як записав БАЗИС, без масштабування)
function effectColors(daeText) {
  const map = new Map();
  for (const m of daeText.matchAll(/<effect\b[^>]*\bname="([^"]*)"[^>]*>([\s\S]*?)<\/effect>/g)) {
    const c = /<diffuse>\s*<color[^>]*>([^<]+)<\/color>/.exec(m[2]);
    if (!c) continue;
    const rgb = c[1].trim().split(/\s+/).slice(0, 3).map(Number);
    if (rgb.length === 3 && rgb.every(Number.isFinite)) map.set(m[1], rgb);
  }
  return map;
}

// id вузла → назва з атрибута name (з розкодуванням XML-сутностей)
function nodeNamesById(daeText) {
  const unxml = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const map = new Map();
  for (const m of daeText.matchAll(/<node\b([^>]*)>/g)) {
    const id = /\bid="([^"]*)"/.exec(m[1]);
    const name = /\bname="([^"]*)"/.exec(m[1]);
    if (id && name) map.set(id[1], unxml(name[1]));
  }
  return map;
}

console.log('1/3 Читаю', daePath, mb(fs.statSync(daePath).size));
const daeBytes = fs.readFileSync(daePath);
const refs = referencedFiles(daeBytes.toString('utf8'));

// ---- 2. glTF-Transform: оптимізація ----
await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });

// ---- 1. DAE -> документ glTF: свій швидкий розбір; якщо не впорався — assimp ----
let doc;
let tmp = null;
const t0 = Date.now();
if (!args.includes('--assimp')) {
  try {
    doc = daeToDocument(daePath);
    console.log(`2/3 розібрано за ${((Date.now() - t0) / 1000).toFixed(1)} с (без assimp)`);
  } catch (err) {
    console.warn('   швидкий розбір не впорався (' + err.message + ') — пробую assimp');
  }
}
if (!doc) doc = await viaAssimp();

async function viaAssimp() {
  // ---- 1. assimp: DAE -> GLB (текстури поки зовнішні) ----
  const ajs = await require('assimpjs')();
  const files = new ajs.FileList();
  files.AddFile(path.basename(daePath), new Uint8Array(daeBytes));

  // Тимчасова папка: туди кладемо GLB і копії текстур під тими самими відносними шляхами
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dae2glb-'));
  let missing = 0;
  for (const rel of refs) {
    const src = path.join(daeDir, rel);
    if (!fs.existsSync(src)) { console.warn('   немає текстури:', rel); missing++; continue; }
    const bytes = fs.readFileSync(src);
    files.AddFile(rel, new Uint8Array(bytes));
    files.AddFile(path.basename(rel), new Uint8Array(bytes));
    fs.mkdirSync(path.join(tmp, path.dirname(rel)), { recursive: true });
    fs.copyFileSync(src, path.join(tmp, rel));
  }
  console.log(`   текстур: ${refs.length}, не знайдено: ${missing}`);

  const result = ajs.ConvertFileList(files, 'glb2');
  if (!result.IsSuccess() || result.FileCount() === 0) {
    console.error('assimp не зміг конвертувати файл:', result.GetErrorCode());
    process.exit(1);
  }
  const rawGlb = path.join(tmp, 'raw.glb');
  fs.writeFileSync(rawGlb, result.GetFile(0).GetContent());
  console.log('2/3 assimp → GLB', mb(fs.statSync(rawGlb).size));


  return io.read(rawGlb);
}

const root = doc.getRoot();

// assimp називає вузли за id з .dae (латинська «каша»), а людські назви лежать в атрибуті name.
// Відновлюємо їх: «Фасад», «Стіна», назви фурнітури тощо.
const names = nodeNamesById(daeBytes.toString('utf8'));
let renamed = 0;
for (const node of root.listNodes()) {
  const id = node.getName();
  const human = names.get(id) ?? names.get(id.replace(/_\d+$/, ''));
  if (human !== undefined && human !== id) { node.setName(human); renamed++; }
}
console.log(`   відновлено назв вузлів: ${renamed}`);

// БАЗИС пише кольори в .dae у діапазоні 0–255 замість 0–1, і assimp обрізає їх до білого.
// Беремо колір із .dae, переводимо в лінійний простір (як вимагає glTF) і ставимо матеріалу без текстури.
const colors = effectColors(daeBytes.toString('utf8'));
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
let recolored = 0;
for (const mat of root.listMaterials()) {
  const name = mat.getName();
  const rgb = colors.get(name) ?? colors.get(name.split('\r')[0]);
  const title = name.split('\r')[0].toLowerCase();
  if (rgb && !mat.getBaseColorTexture()) {
    const scale = Math.max(...rgb) > 1 ? 255 : 1;
    mat.setBaseColorFactor([...rgb.map((c) => toLinear(c / scale)), 1]);
    recolored++;
  }
  if (/хром|сталь|нікел|металл|метал/.test(title)) { mat.setMetallicFactor(1); mat.setRoughnessFactor(0.35); }
  else if (/скло|стекло/.test(title)) { mat.setMetallicFactor(0); mat.setRoughnessFactor(0.1); }
  else { mat.setMetallicFactor(0); }
}
console.log(`   відновлено кольорів матеріалів: ${recolored}`);
console.log(`   до: вузлів ${root.listNodes().length}, сіток ${root.listMeshes().length}, матеріалів ${root.listMaterials().length}, текстур ${root.listTextures().length}`);

await doc.transform(
  dedup(),
  instance({ min: 5 }),
  weld(),
  prune({ keepLeaves: true }),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024] }),
  meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
);

const scene = root.getDefaultScene() || root.listScenes()[0];

// Параметри виробу з БАЗИСу (скрипт «Експорт для 3D-перегляду» пише m3-viewer.json поруч із моделлю)
const infoPath = path.join(daeDir, "m3-viewer.json");
if (fs.existsSync(infoPath)) {
  // UTF-8 (через fs) або cp1251 (запасний запис скрипта через system.writeTextFile)
  const rawInfo = fs.readFileSync(infoPath);
  let infoText = new TextDecoder("utf-8").decode(rawInfo).replace(/^﻿/, "");
  if (infoText.includes("�")) infoText = new TextDecoder("windows-1251").decode(rawInfo);
  const meta = JSON.parse(infoText);
  const m3 = {
    name: String(meta.name || "").trim(),
    prefix: String(meta.prefix || "").trim(),
    article: String(meta.article || "").trim(),
    order: withOrder ? meta.order || "" : "",
    // Кріплення без геометрії в .dae (шканти, конфірмати…): точка й осі з БАЗИСу
    fasteners: Array.isArray(meta.fasteners) ? meta.fasteners : [],
    probes: Array.isArray(meta.probes) ? meta.probes : [],
  };
  scene.setExtras({ ...scene.getExtras(), m3 });
  console.log(`   кріплень з БАЗИСу: ${m3.fasteners.length}`);
  console.log(`   параметри виробу: «${m3.name}» ${m3.prefix}${withOrder ? ", замовлення: " + m3.order : " (замовлення не додано: --with-order)"}`);
} else {
  console.log("   m3-viewer.json не знайдено — назва виробу буде з адреси (запустіть у БАЗИСі «Експорт для 3D-перегляду»)");
}
const b = getBounds(scene);
const size = b.max.map((v, i) => v - b.min[i]);
console.log(`   після: вузлів ${root.listNodes().length}, сіток ${root.listMeshes().length}, текстур ${root.listTextures().length}`);
console.log('   габарити (одиниці файлу):', size.map((v) => v.toFixed(3)).join(' × '));

fs.mkdirSync(path.dirname(outPath), { recursive: true });
await io.write(outPath, doc);
if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
console.log('3/3 Готово:', outPath, mb(fs.statSync(outPath).size));

// КП з папки замовлення: PDF, назва якого починається на «КП» (наприклад, КП_48.pdf), шифруємо автоматично
const kpFiles = fs.readdirSync(daeDir).filter((f) => /^кп.*[.]pdf$/i.test(f));
if (kpFiles.length) {
  // Якщо КП кілька — беремо найновіший
  const kp = kpFiles
    .map((f) => ({ f, t: fs.statSync(path.join(daeDir, f)).mtimeMs }))
    .sort((x, y) => y.t - x.t)[0].f;
  console.log('КП знайдено:', kp);
  execFileSync(process.execPath, [path.resolve('tools', 'encrypt-kp.mjs'), path.join(daeDir, kp), slug], { stdio: 'inherit' });
} else {
  console.log('КП у папці не знайдено (файл має починатися на «КП» і бути .pdf) — модель буде без КП');
}
