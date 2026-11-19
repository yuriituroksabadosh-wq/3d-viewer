// Аркуші блоків для виробництва (лише менеджеру): A4 на блок — 4 види (закритий у текстурах, відкритий без фасадів
// з позиціями деталей, спереду рентгеном, збоку рентгеном), матеріали (від товстих до тонких), фурнітура з фото Віяра,
// штамп. Аркуші малюються на canvas і складаються в PDF (JPEG-сторінки) без сторонніх бібліотек.

import * as THREE from 'three';
import qrcode from 'qrcode-generator';
import logoUrl from './assets/logo-m3.png';
import { matchPanel, partSvg, edgesOf, cutsOf } from './drill.js';

const DPI = 150;
const A4 = [Math.round(210 / 25.4 * DPI), Math.round(297 / 25.4 * DPI)]; // 1240 × 1754
const FONT = 'Manrope, "Segoe UI", system-ui, sans-serif';
const INK = '#1d1d1f';
const LINE = '#7a7468';

const fmt = (n) => (Math.round(n * 10) / 10).toString();
const pathOf = (p) => (p.path || []).filter((x) => x && x !== 'Модель');
const blockOfPanel = (p) => pathOf(p)[0] || '';
// Блок або під-блок: «МВ_4» чи «МВ_4 / Фасад Двійний» — префікс шляху в моделі БАЗИСу
const SEP = ' / ';
const inBlock = (path, name) => name.split(SEP).every((v, i) => path[i] === v);
/** Під-блоки блоку (другий рівень шляху), у яких щонайменше дві плити. */
function subBlocksOf(panels, block) {
  const m = new Map();
  for (const p of panels) {
    const path = pathOf(p);
    if (path[0] !== block || path.length < 2 || !(p.t > 0 && p.t <= 60)) continue;
    m.set(path[1], (m.get(path[1]) || 0) + 1);
  }
  return [...m].filter(([, n]) => n >= 2).map(([s]) => block + SEP + s).sort((a, b) => a.localeCompare(b, 'uk', { numeric: true }));
}
const nameLines = (n) => String(n || '').split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);

// ---------------- Дані блоку ----------------
/** Крайка по сторонах: «Д 0.6/0.6 · Ш 0.6/—» (Д — по довжині, Ш — по ширині). */
const edgeTxt = (p) => {
  const s = edgesOf(p).sides;
  const v = (x) => (x ? fmt(x) : '—');
  return s.L || s.R || s.D || s.U ? `Д ${v(s.L)}/${v(s.R)} · Ш ${v(s.D)}/${v(s.U)}` : '';
};
/** Пази й вирізи з розмірами: «паз 5 / 10 · 7×10 пл. А». */
const cutTxt = (p) => [...new Set(cutsOf(p).map((c) => `${c.name} · ${fmt(c.width)}×${fmt(c.depth)} ${c.side === 'A' ? 'пл. А' : c.side === 'B' ? 'пл. Б' : 'наскрізь'}${c.inside ? '' : ' ⚠'}`))].join(', ');

/** Матеріали блоку: однакові деталі — одним рядком, від товстих до тонких; матеріал — заголовком групи. */
function materialRows(panels, block) {
  const m = new Map();
  for (const p of panels) {
    if (!inBlock(pathOf(p), block) || !(p.t > 0 && p.t <= 60)) continue;
    const edge = edgeTxt(p);
    const k = [p.mat, p.name, fmt(p.l), fmt(p.w), fmt(p.t), edge].join('|');
    if (!m.has(k)) m.set(k, { pos: [], mat: p.mat || '', name: p.name || '', n: 0, t: p.t, l: p.l, w: p.w, edge });
    const r = m.get(k);
    r.n++;
    if (p.art && !r.pos.includes(p.art)) r.pos.push(p.art);
  }
  const num = (r) => parseFloat(r.pos[0]) || 1e9;
  const sorted = [...m.values()].sort((a, b) => b.t - a.t || a.mat.localeCompare(b.mat, 'uk') || num(a) - num(b));
  const out = [];
  let cur = null;
  for (const r of sorted) {
    if (r.mat !== cur) { cur = r.mat; out.push({ section: r.mat || 'Без матеріалу' }); }
    out.push(r);
  }
  return out;
}
/** Фурнітура блоку: назва без рядка артикула, артикул(и), кількість. Службові об'єкти («6», «2x2») — геть. */
function hardwareRows(spec, block) {
  const m = new Map();
  for (const s of spec || []) {
    if (!inBlock(pathOf(s), block)) continue;
    const lines = nameLines(s.name);
    if (!lines.length || /^[\d\s.,xх×*]+$/i.test(lines.join(' '))) continue;
    const title = lines.length > 1 ? lines.slice(0, -1).join(' ') : lines[0];
    const art = lines.length > 1 ? lines[lines.length - 1] : '';
    const k = title + '|' + art;
    if (!m.has(k)) m.set(k, { title, art, codes: art.split(/\s*,\s*/).filter((c) => /^\d{1,9}$/.test(c)), n: 0 });
    m.get(k).n++;
  }
  return [...m.values()].sort((a, b) => a.title.localeCompare(b.title, 'uk'));
}

// ---------------- Види з 3D-моделі ----------------
// Блок з БАЗИСу (МН_1) ↔ група 3D-моделі — за деталями (габарит плит), бо в 3D назви блоків бувають без номерів («МН»)
let mapCache = null;
function blockGroups(model, panels) {
  if (mapCache && mapCache.model === model && mapCache.panels === panels) return mapCache;
  const votes = new Map();
  for (const p of model.parts) {
    if (!p.board || !p.group || p.key === 'room') continue;
    const dp = matchPanel(panels, p.box);
    const b = dp && blockOfPanel(dp);
    if (!b) continue;
    if (!votes.has(b)) votes.set(b, new Map());
    const v = votes.get(b);
    v.set(p.group, (v.get(p.group) || 0) + 1);
  }
  const byName = new Map(), byGroup = new Map();
  for (const [b, v] of votes) {
    const g = [...v].sort((x, y) => y[1] - x[1])[0][0];
    byName.set(b, g);
    byGroup.set(g, b);
  }
  return (mapCache = { model, panels, byName, byGroup });
}

function blockParts(model, name, panels) {
  // Під-блок: плити батьківського блоку з цим шляхом + фурнітура в їхньому габариті
  if (name.includes(SEP)) {
    const all = blockParts(model, name.split(SEP)[0], panels);
    const boards = all.filter((p) => { if (!p.board) return false; const dp = matchPanel(panels, p.box); return dp && inBlock(pathOf(dp), name); });
    if (!boards.length) return [];
    const bx = model.boxOf(boards).clone().expandByScalar(2);
    const c = new THREE.Vector3();
    return [...boards, ...all.filter((p) => !p.board && bx.containsPoint(p.box.getCenter(c)))];
  }
  const map = blockGroups(model, panels);
  const g = map.byName.get(name);
  const own = g ? model.parts.filter((p) => p.group === g) : [];
  if (!own.length) return [];
  const box = model.boxOf(own).clone().expandByScalar(2);
  const ownSet = new Set(own);
  const c = new THREE.Vector3();
  // Кріплення, що в моделі лежать окремою групою (шканти тощо), але всередині габариту блоку
  const extra = model.parts.filter((p) => !ownSet.has(p) && p.key !== 'room' && !map.byGroup.has(p.group) && box.containsPoint(p.box.getCenter(c)));
  return [...own, ...extra];
}

/** Камера на габарит: перспектива або ортографія з напрямку dir, вгору — Y. */
function camFor(box, dir, w, h, ortho) {
  const c = box.getCenter(new THREE.Vector3());
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(up, dir).normalize();
  const camUp = new THREE.Vector3().crossVectors(dir, right).normalize();
  // Півгабарити на площині екрана
  let hx = 0, hy = 0, hz = 0;
  const p = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(c);
    hx = Math.max(hx, Math.abs(p.dot(right)));
    hy = Math.max(hy, Math.abs(p.dot(camUp)));
    hz = Math.max(hz, Math.abs(p.dot(dir)));
  }
  const aspect = w / h, k = 1.08;
  if (ortho) {
    const halfH = Math.max(hy, hx / aspect) * k;
    const cam = new THREE.OrthographicCamera(-halfH * aspect, halfH * aspect, halfH, -halfH, 1, hz * 4 + 10000);
    cam.position.copy(c).addScaledVector(dir, hz * 2 + 1000);
    cam.up.copy(up);
    cam.lookAt(c);
    cam.updateProjectionMatrix();
    return cam;
  }
  const fov = 28, t = Math.tan(THREE.MathUtils.degToRad(fov / 2));
  const d = Math.max(hy / t, hx / (t * aspect)) * k + hz;
  const cam = new THREE.PerspectiveCamera(fov, aspect, d / 50, d * 10);
  cam.position.copy(c).addScaledVector(dir, d);
  cam.up.copy(up);
  cam.lookAt(c);
  cam.updateProjectionMatrix();
  return cam;
}

/**
 * Точки для номерів позицій: рендер у текстуру, де кожна деталь — свій колір (фурнітура — чорна, закриває деталі),
 * далі карта відстаней до межі; для кожної деталі — найглибша видима точка і запас r (півширина місця під номер).
 */
function idMarks(r, scene, cam, vw, vh, recs, posOf, merge = false) {
  const list = [];
  const swapped = [];
  const ids = new Map(); // деталь → id
  const byKey = new Map(); // merge: однакова позиція (напр. назва блоку) — одна область
  for (const [m, p] of recs) {
    if (!m.visible) continue;
    let id = 0;
    if (ids.has(p)) id = ids.get(p);
    else {
      const pos = posOf(p);
      if (pos) {
        const k = merge ? pos : p;
        id = byKey.get(k) || 0;
        if (!id) { list.push({ p, pos }); id = list.length; byKey.set(k, id); }
      }
      ids.set(p, id);
    }
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB((id & 255) / 255, ((id >> 8) & 255) / 255, 0), toneMapped: false, side: THREE.DoubleSide });
    swapped.push([m, m.material]);
    m.material = mat;
    for (const ch of m.children) if (ch.isLineSegments && ch.visible) { ch.visible = false; swapped.push([ch, null]); }
  }
  const rt = new THREE.WebGLRenderTarget(vw, vh);
  const buf = new Uint8Array(vw * vh * 4);
  // Отвори присадки (окремі сітки поза деталями) на час проходу ховаємо
  const holes = scene.getObjectByName('drill-holes');
  const holesVis = holes?.visible;
  if (holes) holes.visible = false;
  try {
    r.setRenderTarget(rt);
    r.render(scene, cam);
    r.readRenderTargetPixels(rt, 0, 0, vw, vh, buf);
  } finally {
    if (holes) holes.visible = holesVis;
    r.setRenderTarget(null);
    rt.dispose();
    for (const [o, mat] of swapped) {
      if (mat) { o.material.dispose(); o.material = mat; } else o.visible = true;
    }
  }
  // id кожного пікселя (рядки знизу вгору → згори вниз); фон (синій канал) = -1
  const N = vw * vh, idx = new Int32Array(N);
  for (let y = 0; y < vh; y++) for (let x = 0; x < vw; x++) {
    const s = ((vh - 1 - y) * vw + x) * 4;
    // Наші id мають синій = 0; фон білий; усе інше (отвори присадки, підписи) — як фурнітура (0)
    const b = buf[s + 2];
    idx[y * vw + x] = b > 250 && buf[s] > 250 ? -1 : b !== 0 ? 0 : buf[s] + buf[s + 1] * 256;
  }
  // Карта відстаней до межі деталі (фаска 1 / 1.41, два проходи)
  const d = new Float32Array(N);
  for (let y = 0; y < vh; y++) for (let x = 0; x < vw; x++) {
    const i = y * vw + x, v = idx[i];
    const edge = x === 0 || y === 0 || x === vw - 1 || y === vh - 1 || idx[i - 1] !== v || idx[i + 1] !== v || idx[i - vw] !== v || idx[i + vw] !== v;
    d[i] = edge ? 0 : 1e9;
  }
  for (let y = 1; y < vh; y++) for (let x = 1; x < vw - 1; x++) {
    const i = y * vw + x;
    if (!d[i]) continue;
    d[i] = Math.min(d[i], d[i - 1] + 1, d[i - vw] + 1, d[i - vw - 1] + 1.41, d[i - vw + 1] + 1.41);
  }
  for (let y = vh - 2; y >= 0; y--) for (let x = vw - 2; x > 0; x--) {
    const i = y * vw + x;
    if (!d[i]) continue;
    d[i] = Math.min(d[i], d[i + 1] + 1, d[i + vw] + 1, d[i + vw + 1] + 1.41, d[i + vw - 1] + 1.41);
  }
  const best = new Map();
  for (let i = 0; i < N; i++) {
    const v = idx[i];
    if (v <= 0) continue;
    const b = best.get(v);
    if (!b || d[i] > b.r) best.set(v, { r: d[i], i });
  }
  const out = [];
  for (const [v, b] of best) if (list[v - 1]) out.push({ pos: list[v - 1].pos, x: b.i % vw, y: Math.floor(b.i / vw), r: b.r });
  return out;
}

/** Обрізати білі поля навколо зображення (з запасом 14 px); точки позицій зсуваються разом із ним. */
function cropContent(img, marks, rect) {
  const w = img.width, h = img.height;
  let x0, y0, x1, y1;
  if (rect) [x0, y0, x1, y1] = rect; // та сама рамка, що й для іншої картинки (текстури / рентген)
  else {
    const px = img.getContext('2d').getImageData(0, 0, w, h).data;
    x0 = w; y0 = h; x1 = -1; y1 = -1;
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
      const k = (y * w + x) * 4;
      if (px[k] < 246 || px[k + 1] < 246 || px[k + 2] < 246) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < x0 || y1 < y0) return [img, marks, [0, 0, w, h]];
    const pad = 14;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w, x1 + pad); y1 = Math.min(h, y1 + pad);
  }
  const c = document.createElement('canvas');
  c.width = x1 - x0; c.height = y1 - y0;
  c.getContext('2d').drawImage(img, -x0, -y0);
  return [c, (marks || []).map((m) => ({ ...m, x: m.x - x0, y: m.y - y0 })), [x0, y0, x1, y1]];
}

/** Мініатюри фурнітури з 3D-моделі (для тих, у кого немає фото з Віяра): кожна деталь окремо, на білому. */
function renderThumbs(viewer, model, list, size = 200) {
  const out = new Map();
  if (!list.length) return out;
  const recs = model.parts.flatMap((p) => p.meshes.map((rr) => [rr.mesh, p]));
  const savedVis = recs.map(([m]) => m.visible);
  const scene = viewer.scene;
  const savedBg = scene.background;
  const floor = scene.children.find((o) => o.isMesh && o.geometry?.type === 'PlaneGeometry');
  const savedFloor = floor?.visible;
  const savedMode = model.viewMode;
  const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  r.setPixelRatio(1);
  r.toneMapping = viewer.renderer.toneMapping;
  r.toneMappingExposure = viewer.renderer.toneMappingExposure;
  r.outputColorSpace = viewer.renderer.outputColorSpace;
  try {
    model.setFocus(null);
    model.select([]);
    model.setViewMode('real');
    scene.background = new THREE.Color('#ffffff');
    if (floor) floor.visible = false;
    const dir = new THREE.Vector3(0.6, 0.45, 1).normalize();
    for (const { key, part } of list) {
      for (const [m, p] of recs) m.visible = p === part;
      const b = new THREE.Box3();
      for (const rec of part.meshes) { rec.mesh.updateWorldMatrix(true, false); b.expandByObject(rec.mesh); }
      if (b.isEmpty()) continue;
      r.setSize(size, size, false);
      r.render(scene, camFor(b, dir, size, size, false));
      const c = document.createElement('canvas');
      c.width = size; c.height = size;
      c.getContext('2d').drawImage(r.domElement, 0, 0);
      out.set(key, cropContent(c, [])[0]);
    }
  } finally {
    r.dispose();
    model.setViewMode(savedMode);
    recs.forEach(([m], i) => { m.visible = savedVis[i]; });
    scene.background = savedBg;
    if (floor) floor.visible = savedFloor;
  }
  return out;
}

/** Чотири види блоку: canvas-и + точки позицій деталей на відкритому виді. */
function renderViews(viewer, model, panels, name, sz) {
  const parts = blockParts(model, name, panels);
  if (!parts.length) return null;
  const set = new Set(parts);
  const recs = model.parts.flatMap((p) => p.meshes.map((r) => [r.mesh, p]));
  const savedVis = recs.map(([m]) => m.visible);
  const scene = viewer.scene;
  const savedBg = scene.background;
  const floor = scene.children.find((o) => o.isMesh && o.geometry?.type === 'PlaneGeometry');
  const savedFloor = floor?.visible;
  const savedMode = model.viewMode;
  const ops = model.openerList || [];
  const savedOps = ops.map((o) => [o.now, o.target]);
  const doorParts = new Set(ops.filter((o) => o.kind === 'door').flatMap((o) => o.parts));

  const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  r.setPixelRatio(1);
  r.toneMapping = viewer.renderer.toneMapping;
  r.toneMappingExposure = viewer.renderer.toneMappingExposure;
  r.outputColorSpace = viewer.renderer.outputColorSpace;
  const out = {};
  try {
    model.setFocus(null);
    model.select([]);
    for (const o of ops) { o.now = 0; o.target = 0; }
    model.update(0.0001);
    scene.background = new THREE.Color('#ffffff');
    if (floor) floor.visible = false;
    const box = model.boxOf(parts.filter((p) => p.board || p.key === 'facade').length ? parts.filter((p) => p.board || p.key === 'facade') : parts);
    const g = blockGroups(model, panels).byName.get(name.split(SEP)[0]);
    const gc = box.getCenter(new THREE.Vector3());
    const bl = model.blocks.filter((b) => b.name === g?.name).sort((a, b2) => a.box.distanceToPoint(gc) - b2.box.distanceToPoint(gc))[0];
    const front = (bl?.facing || new THREE.Vector3(0, 0, 1)).clone().setY(0).normalize();
    const side = new THREE.Vector3(front.z, 0, -front.x); // праворуч від блоку
    const iso = front.clone().multiplyScalar(1).addScaledVector(side, 0.62).add(new THREE.Vector3(0, 0.42, 0)).normalize();
    const show = (fn) => { for (const [m, p] of recs) m.visible = set.has(p) && fn(p); };
    const shot = (cam, vw, vh) => {
      r.setSize(vw, vh, false);
      r.render(scene, cam);
      const c = document.createElement('canvas');
      c.width = vw; c.height = vh;
      c.getContext('2d').drawImage(r.domElement, 0, 0);
      return c;
    };

    model.setViewMode('real-lines');
    show(() => true);
    out.closed = shot(camFor(box, iso, ...sz.closed, false), ...sz.closed);

    // Фасади ховаємо, лише якщо в блоці є корпус (під-блок «Фасад Двійний» — самі фасади, їх лишаємо)
    const isFront = (p) => p.key === 'facade' || doorParts.has(p);
    const hideFronts = parts.some((p) => p.board && !isFront(p));
    show((p) => !hideFronts || !isFront(p));
    const [vw, vh] = sz.open;
    const camOpen = camFor(box, iso, vw, vh, false);
    out.open = shot(camOpen, vw, vh);
    // Позиції деталей (ArtPos з БАЗИСу): ID-рендер — кожна деталь своїм кольором, номер ставимо
    // в найглибшу ВИДИМУ точку деталі (максимум відстані до її межі на картинці). Невидимі — без номера на виді.
    out.marks = idMarks(r, scene, camOpen, vw, vh, recs, (p) => {
      if (!p.board || (hideFronts && isFront(p))) return null;
      const dp = matchPanel(panels, p.box);
      return dp && dp.art ? String(dp.art) : null;
    });
    [out.open, out.marks] = cropContent(out.open, out.marks);
    [out.closed] = cropContent(out.closed, []);

    model.setViewMode('xray');
    show(() => true);
    const camFront = camFor(box, front, ...sz.front, true), camSide = camFor(box, side, ...sz.side, true);
    out.front = shot(camFront, ...sz.front);
    out.side = shot(camSide, ...sz.side);
    out.size = box.getSize(new THREE.Vector3());
    // Розміри для ортовидів: рівні горизонтальних плит (полиці, дно, кришка) і вертикальних (боковини, стійки)
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), front).normalize();
    const hAxis = Math.abs(right.x) >= Math.abs(right.z) ? 'x' : 'z';
    const dAxis = hAxis === 'x' ? 'z' : 'x';
    const ys = [box.min.y, box.max.y], hs = [box.min[hAxis], box.max[hAxis]];
    const ds = [box.min[dAxis], box.max[dAxis]];
    for (const p of parts) {
      if (!p.board || p.key === 'facade') continue;
      const sz3 = p.box.getSize(new THREE.Vector3());
      if (sz3.y <= 40 && Math.max(sz3[hAxis], sz3[dAxis]) > 80) ys.push(p.box.min.y, p.box.max.y);
      if (sz3[hAxis] <= 40 && sz3.y > 100) hs.push(p.box.min[hAxis], p.box.max[hAxis]);
    }
    const uniq = (a) => [...new Set(a.map((v) => Math.round(v * 2) / 2))].sort((p, q) => p - q);
    const c0 = box.getCenter(new THREE.Vector3());
    // Точка світу → піксель картинки виду
    const proj = (cam, w2, h2) => (pt) => { const v = pt.clone().project(cam); return [(v.x + 1) / 2 * w2, (1 - v.y) / 2 * h2]; };
    const at = (h, yv, axis) => { const p = c0.clone(); p.y = yv; p[axis] = h; return p; };
    out.frontDims = { proj: proj(camFront, ...sz.front), at: (h, yv) => at(h, yv, hAxis), ys: uniq(ys), hs: uniq(hs) };
    out.sideDims = { proj: proj(camSide, ...sz.side), at: (h, yv) => at(h, yv, dAxis), ys: [box.min.y, box.max.y], hs: uniq(ds) };

    // Схема складання: блок розібраний (як кнопка «Розібрати»), номери позицій на всіх плитах разом із фасадами
    if (sz.exploded) {
      model.setViewMode('real-lines');
      show(() => true);
      // Власне розбирання блоку: кожна деталь відсувається від центру блоку (×0.7 відстані до центру),
      // кріплення — так само за своїм центром, тож лишаються між деталями, які з'єднують
      const bc = box.getCenter(new THREE.Vector3());
      const moved = [];
      const wp = new THREE.Vector3(), lp = new THREE.Vector3();
      for (const p of parts) {
        const off = p.box.getCenter(new THREE.Vector3()).sub(bc).multiplyScalar(0.7);
        for (const rec of p.meshes) {
          const m = rec.mesh;
          m.updateWorldMatrix(true, false);
          m.getWorldPosition(wp);
          lp.copy(wp).add(off);
          if (m.parent) { m.parent.updateWorldMatrix(true, false); m.parent.worldToLocal(lp); }
          moved.push([m, m.position.clone()]);
          m.position.copy(lp);
          m.updateMatrixWorld(true);
        }
      }
      try {
        const eb = new THREE.Box3();
        for (const p of parts) if (p.board || p.key === 'facade') for (const rec of p.meshes) eb.expandByObject(rec.mesh);
        const [ew, eh] = sz.exploded;
        const camEx = camFor(eb, iso, ew, eh, false);
        out.exploded = shot(camEx, ew, eh);
        out.explodedMarks = idMarks(r, scene, camEx, ew, eh, recs, (p) => {
          if (!p.board) return null;
          const dp = matchPanel(panels, p.box);
          return dp && dp.art ? String(dp.art) : null;
        });
        // Другий варіант — рентгеном (той самий ракурс, ті самі номери)
        model.setViewMode('xray');
        show(() => true); // зміна режиму повертає видимість усій моделі — знову лише цей блок
        const xr = shot(camEx, ew, eh);
        model.setViewMode('real-lines');
        show(() => true);
        let rect;
        [out.exploded, out.explodedMarks, rect] = cropContent(out.exploded, out.explodedMarks);
        [out.explodedXray] = cropContent(xr, [], rect);
      } finally {
        for (const [m, pos] of moved) { m.position.copy(pos); m.updateMatrixWorld(true); }
      }
    }
  } finally {
    r.dispose();
    model.setViewMode(savedMode);
    recs.forEach(([m], i) => { m.visible = savedVis[i]; });
    scene.background = savedBg;
    if (floor) floor.visible = savedFloor;
    ops.forEach((o, i) => { o.now = savedOps[i][0]; o.target = savedOps[i][1]; });
    model.update(0.0001);
  }
  return out;
}

// ---------------- Малювання аркуша ----------------
const loadImg = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });

function fit(ctx, text, w) {
  text = String(text ?? '');
  if (ctx.measureText(text).width <= w) return text;
  while (text.length > 1 && ctx.measureText(text + '…').width > w) text = text.slice(0, -1);
  return text + '…';
}

/** Таблиця з рядка start; повертає індекс першого рядка, що не вліз. f — розмір шрифту рядків. */
function table(ctx, x, y, w, maxY, title, cols, rows, start, rowH, cell, f = 15) {
  if (title) {
    ctx.fillStyle = INK;
    ctx.font = `700 20px ${FONT}`;
    ctx.fillText(title + (start ? ' (продовження)' : ''), x, y + 20);
    y += 30;
  }
  const xs = [];
  let cx = x;
  for (const c of cols) { xs.push(cx); cx += c.w * w; }
  const headH = 28;
  ctx.fillStyle = '#efe9df';
  ctx.fillRect(x, y, w, headH);
  ctx.font = `700 ${Math.min(15, f + 1)}px ${FONT}`;
  ctx.fillStyle = INK;
  cols.forEach((c, i) => ctx.fillText(fit(ctx, c.t, c.w * w - 8), xs[i] + 4, y + 19));
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, headH);
  cols.forEach((c, k) => { if (k) { ctx.beginPath(); ctx.moveTo(xs[k], y); ctx.lineTo(xs[k], y + headH); ctx.stroke(); } });
  y += headH;
  let i = start;
  for (; i < rows.length; i++) {
    if (y + rowH > maxY) break;
    if (rows[i].section) {
      // Заголовок групи (матеріал) — на всю ширину
      ctx.fillStyle = '#f6f1e8';
      ctx.fillRect(x, y, w, rowH);
      ctx.strokeStyle = LINE;
      ctx.strokeRect(x, y, w, rowH);
      ctx.fillStyle = INK;
      ctx.font = `700 ${f}px ${FONT}`;
      ctx.fillText(fit(ctx, rows[i].section, w - 12), x + 6, y + rowH / 2 + f * 0.36);
      y += rowH;
      continue;
    }
    ctx.strokeStyle = LINE;
    ctx.strokeRect(x, y, w, rowH);
    cols.forEach((c, k) => { if (k) { ctx.beginPath(); ctx.moveTo(xs[k], y); ctx.lineTo(xs[k], y + rowH); ctx.stroke(); } });
    cell(rows[i], xs, y, rowH, f, x + w);
    y += rowH;
  }
  table.lastY = y;
  return i;
}
/** Текстові клітинки рядка: vals по колонках. */
const textCells = (ctx, vals, bold = []) => (r, xs, y, rh, f, right) => {
  ctx.fillStyle = INK;
  vals(r).forEach((v, k) => {
    ctx.font = `${bold.includes(k) ? 700 : 500} ${f}px ${FONT}`;
    const end = k < xs.length - 1 ? xs[k + 1] : right;
    ctx.fillText(fit(ctx, v, end - xs[k] - 8), xs[k] + 4, y + rh / 2 + f * 0.36);
  });
};

/** QR-код посилання (чорні квадрати на білому). */
function drawQr(ctx, url, x, y, size) {
  const q = qrcode(0, 'M');
  q.addData(url);
  q.make();
  const n = q.getModuleCount(), cell = size / (n + 2);
  ctx.fillStyle = '#fff';
  ctx.fillRect(x, y, size, size);
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) ctx.fillRect(x + (c + 1) * cell, y + (r + 1) * cell, cell + 0.3, cell + 0.3);
}

function stamp(ctx, W, H, M, logo, info, block, page, pages, url) {
  const h = STAMP_H, y = H - M - h, x = M, w = W - 2 * M;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
  const c1 = x + 200, c3 = x + w - 210 - (url ? h : 0);
  ctx.beginPath();
  ctx.moveTo(c1, y); ctx.lineTo(c1, y + h);
  ctx.moveTo(c3, y); ctx.lineTo(c3, y + h);
  ctx.moveTo(c1, y + h / 2); ctx.lineTo(c3, y + h / 2);
  ctx.moveTo(c3, y + h / 2); ctx.lineTo(c3 + 210, y + h / 2);
  if (url) { ctx.moveTo(c3 + 210, y); ctx.lineTo(c3 + 210, y + h); }
  ctx.stroke();
  // QR: відкриває цей блок у 3D на телефоні
  if (url) drawQr(ctx, url, c3 + 210 + 4, y + 4, h - 8);
  if (logo) {
    const s = Math.min(130 / logo.width, (h - 16) / logo.height);
    ctx.drawImage(logo, x + 10, y + (h - logo.height * s) / 2, logo.width * s, logo.height * s);
  }
  const label = (t, v, lx, ly, lw) => {
    ctx.fillStyle = '#6f685c';
    ctx.font = `600 13px ${FONT}`;
    ctx.fillText(t, lx + 10, ly + 17);
    ctx.fillStyle = INK;
    ctx.font = `800 21px ${FONT}`;
    ctx.fillText(fit(ctx, v, lw - 20), lx + 10, ly + 41);
  };
  label(block === GENERAL || block === TITLE ? 'Документ' : 'Блок', block, c1, y, c3 - c1);
  label('Виріб · замовлення', [info.name, (info.prefix || '').trim()].filter(Boolean).join(' · '), c1, y + h / 2, c3 - c1);
  label('Аркуш', `${page} з ${pages}`, c3, y, 210);
  label('Дата', new Date().toLocaleDateString('uk-UA'), c3, y + h / 2, 210);
}

/**
 * Розмірні лінії на ортовиді: ліворуч — ланцюжок висот (дно, полиці, кришка) і загальна висота,
 * знизу — ланцюжок по ширині (боковини, стійки) і загальна ширина. Цифра там, де влазить.
 */
function drawDims(ctx, d, ix, iy, s) {
  const P = (h, yv) => { const [px, py] = d.proj(d.at(h, yv)); return [ix + px * s, iy + py * s]; };
  const ys = d.ys, hs = d.hs;
  if (ys.length < 2 || hs.length < 2) return;
  const a = P(hs[0], ys[0]), b = P(hs[hs.length - 1], ys[0]);
  const hLeft = a[0] <= b[0] ? hs[0] : hs[hs.length - 1];
  const xEdge = Math.min(a[0], b[0]), yEdge = Math.max(a[1], b[1]);
  ctx.save();
  ctx.strokeStyle = '#2b2b2b';
  ctx.fillStyle = '#1d1d1f';
  ctx.lineWidth = 1;
  const tick = (px, py) => { ctx.beginPath(); ctx.moveTo(px - 4, py + 4); ctx.lineTo(px + 4, py - 4); ctx.stroke(); };
  const line = (x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
  // Вертикальний ланцюжок: pts — екранні y, vals — мм
  const vChain = (lx, pts, vals, bold) => {
    line(lx, Math.min(...pts), lx, Math.max(...pts));
    ctx.font = `${bold ? 800 : 600} ${bold ? 16 : 13}px ${FONT}`;
    for (let i = 0; i < pts.length; i++) {
      tick(lx, pts[i]);
      ctx.save(); ctx.strokeStyle = '#9a948a'; line(xEdge - 2, pts[i], lx - 3, pts[i]); ctx.restore();
      if (i) {
        const t = fmt(Math.abs(vals[i] - vals[i - 1])), len = Math.abs(pts[i] - pts[i - 1]);
        if (len < ctx.measureText(t).width + 4) continue;
        ctx.save(); ctx.translate(lx - 4, (pts[i] + pts[i - 1]) / 2); ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center'; ctx.fillText(t, 0, 0); ctx.restore();
      }
    }
  };
  const hChain = (ly, pts, vals, bold) => {
    line(Math.min(...pts), ly, Math.max(...pts), ly);
    ctx.font = `${bold ? 800 : 600} ${bold ? 16 : 13}px ${FONT}`;
    for (let i = 0; i < pts.length; i++) {
      tick(pts[i], ly);
      ctx.save(); ctx.strokeStyle = '#9a948a'; line(pts[i], yEdge + 2, pts[i], ly + 3); ctx.restore();
      if (i) {
        const t = fmt(Math.abs(vals[i] - vals[i - 1])), len = Math.abs(pts[i] - pts[i - 1]);
        if (len < ctx.measureText(t).width + 4) continue;
        ctx.textAlign = 'center'; ctx.fillText(t, (pts[i] + pts[i - 1]) / 2, ly + 14); ctx.textAlign = 'left';
      }
    }
  };
  const vy = ys.map((v) => P(hLeft, v)[1]);
  if (ys.length > 2) vChain(xEdge - 18, vy, ys, false);
  vChain(xEdge - 46, [vy[0], vy[vy.length - 1]], [ys[0], ys[ys.length - 1]], true);
  const hx = hs.map((v) => P(v, ys[0])[0]);
  if (hs.length > 2) hChain(yEdge + 14, hx, hs, false);
  hChain(yEdge + 36, [hx[0], hx[hx.length - 1]], [hs[0], hs[hs.length - 1]], true);
  ctx.restore();
}

/**
 * Вид у рамці з підписом. Для виду з позиціями — виноски по всьому периметру рамки:
 * кожна позиція йде до найближчої сторони, однакові позиції — один номер, кілька ліній.
 */
function viewBox(ctx, img, x, y, w, h, title, marks, dims) {
  ctx.strokeStyle = '#d9d2c5';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = '#6f685c';
  ctx.font = `700 15px ${FONT}`;
  ctx.fillText(title, x + 8, y + 20);
  const hasM = marks && marks.length;
  const padL = dims ? 66 : hasM ? 46 : 8, padR = hasM ? 46 : 8, padB = dims ? 54 : hasM ? 46 : 8, top = hasM ? 46 : 28;
  const s = Math.min((w - padL - padR) / img.width, (h - top - padB) / img.height);
  const iw = img.width * s, ih = img.height * s;
  const ix = x + padL + (w - padL - padR - iw) / 2, iy = y + top + (h - top - padB - ih) / 2;
  ctx.drawImage(img, ix, iy, iw, ih);
  if (dims) drawDims(ctx, dims, ix, iy, s);
  if (!hasM) return;
  // Номер прямо на деталі, якщо місця вистачає; дрібні деталі — виноскою до краю рамки
  const R = 13;
  const onPart = marks.filter((m) => m.r == null || m.r * s >= R * 0.75);
  const badges = () => {
    for (const m of onPart) {
      const rr = Math.min(R, m.r == null ? R : m.r * s);
      const bx = ix + m.x * s, by = iy + m.y * s;
      ctx.beginPath();
      ctx.arc(bx, by, rr, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = '#1d1d1f';
      ctx.stroke();
      ctx.fillStyle = '#1d1d1f';
      ctx.font = `800 ${Math.round(rr * (String(m.pos).length > 2 ? 0.8 : 1.05))}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(m.pos, bx, by + 0.5);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }
  };
  marks = marks.filter((m) => !onPart.includes(m));
  if (!marks.length) { badges(); return; }
  // Групи однакових позицій
  const groups = new Map();
  for (const m of marks) {
    if (!groups.has(m.pos)) groups.set(m.pos, []);
    groups.get(m.pos).push({ px: ix + m.x * s, py: iy + m.y * s });
  }
  const cx = ix + iw / 2, cy = iy + ih / 2;
  const L = { left: [], right: [], top: [], bottom: [] };
  for (const [pos, pts] of groups) {
    const ax = pts.reduce((a, p) => a + p.px, 0) / pts.length, ay = pts.reduce((a, p) => a + p.py, 0) / pts.length;
    const dx = (ax - cx) / (iw / 2 || 1), dy = (ay - cy) / (ih / 2 || 1);
    const side = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'top' : 'bottom');
    L[side].push({ pos, pts, ax, ay });
  }
  // Ліва/права: якщо на стороні тісно — частину віддаємо верху/низу
  const cap = { left: Math.floor((h - top) / 24), right: Math.floor((h - top) / 24), top: Math.floor(w / 30), bottom: Math.floor(w / 30) };
  const spill = (from, a, b, key) => {
    L[from].sort((p, q) => p[key] - q[key]);
    while (L[from].length > cap[from]) {
      const m = L[from][0][key] - (key === 'ay' ? cy : cx) < 0 ? L[from].shift() : L[from].pop();
      (m[key] < (key === 'ay' ? cy : cx) ? L[a] : L[b]).push(m);
    }
  };
  spill('left', 'top', 'bottom', 'ay');
  spill('right', 'top', 'bottom', 'ay');
  spill('top', 'left', 'right', 'ax');
  spill('bottom', 'left', 'right', 'ax');
  // Розсунути підписи вздовж сторони, не виходячи за рамку
  const spread = (list, key, lo, hi, gap) => {
    list.sort((p, q) => p[key] - q[key]);
    let last = lo - gap;
    for (const m of list) { m.at = Math.max(m[key], last + gap); last = m.at; }
    const over = last - hi;
    if (over > 0) for (const m of list) m.at -= over;
    for (let i = 0; i < list.length; i++) if (list[i].at < lo) list[i].at = lo + i * gap;
  };
  spread(L.left, 'ay', y + top, y + h - 12, 24);
  spread(L.right, 'ay', y + top, y + h - 12, 24);
  spread(L.top, 'ax', x + 40, x + w - 40, 30);
  spread(L.bottom, 'ax', x + 40, x + w - 40, 30);
  ctx.strokeStyle = '#3b3a36';
  ctx.fillStyle = '#3b3a36';
  ctx.lineWidth = 1;
  ctx.font = `700 16px ${FONT}`;
  ctx.textAlign = 'center';
  const draw = (m, lx, ly, ex, ey) => {
    for (const p of m.pts) {
      ctx.beginPath(); ctx.moveTo(p.px, p.py); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.beginPath(); ctx.arc(p.px, p.py, 2.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillText(m.pos, lx, ly);
  };
  for (const m of L.left) { const lx = x + 20, ly = m.at; draw(m, lx, ly + 5, lx + 16, ly); ctx.beginPath(); ctx.moveTo(x + 6, ly + 8); ctx.lineTo(lx + 16, ly + 8); ctx.stroke(); }
  for (const m of L.right) { const lx = x + w - 20, ly = m.at; draw(m, lx, ly + 5, lx - 16, ly); ctx.beginPath(); ctx.moveTo(lx - 16, ly + 8); ctx.lineTo(x + w - 6, ly + 8); ctx.stroke(); }
  for (const m of L.top) { const ly = y + top - 14; draw(m, m.at, ly, m.at, ly + 6); }
  for (const m of L.bottom) { const ly = y + h - 6; draw(m, m.at, ly, m.at, ly - 18); }
  ctx.textAlign = 'left';
  badges();
}

const STAMP_H = 100;
const GENERAL = 'Загальна специфікація';
const TITLE = 'Титульний аркуш';

/** Титульний аркуш: загальний вид усього виробу (без стін) і назва кожного блоку прямо на ньому. */
function titlePage(viewer, model, names, info, panels) {
  const [W, H] = [A4[1], A4[0]];
  const M = 40, stampTop = H - M - STAMP_H - 12;
  const head = 70;
  const vw = W - 2 * M, vh = stampTop - M - head - 10;
  const RW = Math.round(vw * 1.4), RH = Math.round(vh * 1.4);
  const blockSet = new Set(names);
  const recs = model.parts.flatMap((p) => p.meshes.map((rr) => [rr.mesh, p]));
  const savedVis = recs.map(([m]) => m.visible);
  const scene = viewer.scene;
  const savedBg = scene.background;
  const floor = scene.children.find((o) => o.isMesh && o.geometry?.type === 'PlaneGeometry');
  const savedFloor = floor?.visible;
  const savedMode = model.viewMode;
  const ops = model.openerList || [];
  const savedOps = ops.map((o) => [o.now, o.target]);
  const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  r.setPixelRatio(1);
  r.toneMapping = viewer.renderer.toneMapping;
  r.toneMappingExposure = viewer.renderer.toneMappingExposure;
  r.outputColorSpace = viewer.renderer.outputColorSpace;
  let img, marks, frameBox = [0, 0, RW, RH], dimsTxt = '';
  try {
    model.setFocus(null);
    model.select([]);
    for (const o of ops) { o.now = 0; o.target = 0; }
    model.update(0.0001);
    scene.background = new THREE.Color('#ffffff');
    if (floor) floor.visible = false;
    model.setViewMode('real-lines');
    // Разом із приміщенням (стіни, підлога); кадр — за меблями, стіни довкола обрізаються
    for (const [m] of recs) m.visible = true;
    const box = model.boxOf(model.parts.filter((p) => p.key !== 'room'));
    { const gs = box.getSize(new THREE.Vector3()); dimsTxt = `${Math.round(gs.x)} × ${Math.round(gs.y)} × ${Math.round(gs.z)} мм`; }
    const dir = new THREE.Vector3(...(model.bounds?.viewDir || [0.6, 0.35, 1])).normalize();
    const cam = camFor(box, dir, RW, RH, false);
    // Межі меблів на картинці — для обрізання
    let fx0 = RW, fy0 = RH, fx1 = 0, fy1 = 0;
    for (let i = 0; i < 8; i++) {
      const v = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(cam);
      const px2 = (v.x + 1) / 2 * RW, py2 = (1 - v.y) / 2 * RH;
      fx0 = Math.min(fx0, px2); fx1 = Math.max(fx1, px2); fy0 = Math.min(fy0, py2); fy1 = Math.max(fy1, py2);
    }
    frameBox = [fx0, fy0, fx1, fy1];
    r.setSize(RW, RH, false);
    // Спершу без приміщення — знайти, де на картинці меблі (не-білі пікселі)
    for (const [m, p] of recs) m.visible = p.key !== 'room';
    r.render(scene, cam);
    {
      const scan = document.createElement('canvas');
      scan.width = RW; scan.height = RH;
      const sc = scan.getContext('2d');
      sc.drawImage(r.domElement, 0, 0);
      const px = sc.getImageData(0, 0, RW, RH).data;
      let x0 = RW, y0 = RH, x1 = 0, y1 = 0;
      for (let yy = 0; yy < RH; yy += 2) for (let xx = 0; xx < RW; xx += 2) {
        const k = (yy * RW + xx) * 4;
        if (px[k] < 245 || px[k + 1] < 245 || px[k + 2] < 245) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy; }
      }
      if (x1 > x0 && y1 > y0) frameBox = [x0, y0, x1, y1];
    }
    for (const [m] of recs) m.visible = true;
    r.render(scene, cam);
    img = document.createElement('canvas');
    img.width = RW; img.height = RH;
    img.getContext('2d').drawImage(r.domElement, 0, 0);
    marks = idMarks(r, scene, cam, RW, RH, recs, (p) => { const b = blockGroups(model, panels).byGroup.get(p.group); return b && blockSet.has(b) ? b : null; }, true);
  } finally {
    r.dispose();
    model.setViewMode(savedMode);
    recs.forEach(([m], i) => { m.visible = savedVis[i]; });
    scene.background = savedBg;
    if (floor) floor.visible = savedFloor;
    ops.forEach((o, i) => { o.now = savedOps[i][0]; o.target = savedOps[i][1]; });
    model.update(0.0001);
  }
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.strokeRect(M - 14, M - 14, W - 2 * M + 28, H - 2 * M + 28);
  ctx.fillStyle = INK;
  ctx.font = `800 34px ${FONT}`;
  ctx.fillText([info.name, (info.prefix || '').trim()].filter(Boolean).join(' · ') || 'Виріб', M, M + 36);
  ctx.fillStyle = '#6f685c';
  ctx.font = `600 18px ${FONT}`;
  ctx.fillText(`Блоків: ${names.length}${dimsTxt ? ' · габарит ' + dimsTxt : ''}`, M, M + 62);
  // Обрізати до меблів (+ запас, щоб було видно приміщення довкола)
  let [x0, y0, x1, y1] = frameBox;
  const padX = (x1 - x0) * 0.08, padY = (y1 - y0) * 0.08;
  x0 = Math.max(0, Math.floor(x0 - padX)); y0 = Math.max(0, Math.floor(y0 - padY));
  x1 = Math.min(RW, Math.ceil(x1 + padX)); y1 = Math.min(RH, Math.ceil(y1 + padY));
  if (x1 <= x0 || y1 <= y0) { x0 = 0; y0 = 0; x1 = RW; y1 = RH; }
  const cw = x1 - x0, ch = y1 - y0;
  const s = Math.min(vw / cw, vh / ch);
  const ix = M + (vw - cw * s) / 2 - x0 * s, iy = M + head + (vh - ch * s) / 2 - y0 * s;
  ctx.drawImage(img, x0, y0, cw, ch, ix + x0 * s, iy + y0 * s, cw * s, ch * s);
  // Назви блоків: табличка в найбільшій видимій частині блоку; якщо налазить на сусідню — зсуваємо нижче
  const placed = [];
  ctx.font = `800 26px ${FONT}`;
  for (const m of marks.sort((a, b) => b.r - a.r)) {
    const tw = ctx.measureText(m.pos).width, bw = tw + 28, bh = 42;
    let bx = Math.max(M, Math.min(W - M - bw, ix + m.x * s - bw / 2)), by = iy + m.y * s - bh / 2;
    for (let k = 0; k < 12 && placed.some((q) => bx < q.x + q.w + 4 && bx + bw + 4 > q.x && by < q.y + q.h + 4 && by + bh + 4 > q.y); k++) by += bh + 6;
    placed.push({ x: bx, y: by, w: bw, h: bh });
    ctx.fillStyle = 'rgba(255,255,255,0.94)';
    ctx.strokeStyle = '#e0592a';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = INK;
    ctx.fillText(m.pos, bx + 14, by + 30);
  }
  return c;
}

/**
 * Розкладка аркуша блоку: високий блок — книжковий, інакше альбомний. Види — основне (≈65% висоти),
 * вид з позиціями найбільший. tableRows — скільки рядків таблиць має влізти (для висоти видів).
 */
function layout(size, tableRows) {
  const portrait = size.y > Math.max(size.x, size.z) * 1.25;
  const [W, H] = portrait ? A4 : [A4[1], A4[0]];
  const M = 40, vw = W - 2 * M, stampTop = H - M - STAMP_H - 12;
  // Таблиці під видами: мінімум місця під потрібну кількість рядків (рядок ≥ 20 px), але не більше 45% аркуша
  const need = 30 + 28 + Math.max(4, tableRows) * 21;
  const vh = Math.max((stampTop - M) * 0.55, Math.min((stampTop - M) * 0.68, stampTop - M - need - 14));
  const big = portrait ? 0.34 : 0.4; // частка ширини під вид з позиціями
  const gap = 10;
  const bw = vw * big, sw = (vw - bw - 3 * gap) / 3;
  // Книжковий (високий блок): усі чотири в ряд — вузькі й високі.
  // Альбомний (широкий): ліворуч великий з позиціями; праворуч угорі загальний і збоку, під ними широкий вид спереду.
  const rx = M + bw + gap, rw = vw - bw - gap, rh = (vh - gap) / 2, hw = (rw - gap) / 2;
  const cells = portrait ? {
    open: { x: M, y: M, w: bw, h: vh },
    closed: { x: M + bw + gap, y: M, w: sw, h: vh },
    front: { x: M + bw + gap + (sw + gap), y: M, w: sw, h: vh },
    side: { x: M + bw + gap + 2 * (sw + gap), y: M, w: sw, h: vh },
  } : {
    open: { x: M, y: M, w: bw, h: vh },
    closed: { x: rx, y: M, w: hw, h: rh },
    side: { x: rx + hw + gap, y: M, w: hw, h: rh },
    front: { x: rx, y: M + rh + gap, w: rw, h: rh },
  };
  return { portrait, W, H, M, vw, stampTop, cells, tablesY: M + vh + 14 };
}

function newPageFn(pages, W, H, M) {
  return () => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.strokeRect(M - 14, M - 14, W - 2 * M + 28, H - 2 * M + 28);
    pages.push(c);
    return ctx;
  };
}

/** Клітинка фурнітури: фото (до двох), артикул, назва, кількість. */
const hwCell = (ctx, assets, cols) => (r, xs, y, rh, f, right) => {
  const imgs = r.codes.map((c) => assets.hw.get(c)).filter(Boolean).slice(0, 2);
  if (!imgs.length && assets.thumbs?.get(r.title)) imgs.push(assets.thumbs.get(r.title)); // з 3D-моделі
  const cw = xs[1] - xs[0] - 4;
  imgs.forEach((im, k) => {
    const sz = Math.min(rh - 4, cw / imgs.length - 2);
    const s2 = Math.min(sz / im.width, sz / im.height), dw = im.width * s2, dh = im.height * s2;
    ctx.drawImage(im, xs[0] + 2 + k * (sz + 2) + (sz - dw) / 2, y + (rh - dh) / 2, dw, dh);
  });
  textCells(ctx, (q) => ['', ...cols.map((fn) => fn(q))], [cols.length])(r, xs, y, rh, f, right);
};

/** Аркуш одного блоку: види зверху, під ними матеріали й фурнітура поруч; рядки стискаються, щоб усе влізло. */
function blockPages(views, block, mats, hws, assets) {
  const { W, H, M, vw, stampTop, cells, tablesY } = views.layout;
  const pages = [];
  const newPage = newPageFn(pages, W, H, M);
  let ctx = newPage();
  viewBox(ctx, views.open, cells.open.x, cells.open.y, cells.open.w, cells.open.h, 'Без фасадів · позиції', views.marks);
  viewBox(ctx, views.closed, cells.closed.x, cells.closed.y, cells.closed.w, cells.closed.h, 'Загальний вигляд');
  viewBox(ctx, views.front, cells.front.x, cells.front.y, cells.front.w, cells.front.h, 'Спереду · рентген', null, views.frontDims);
  viewBox(ctx, views.side, cells.side.x, cells.side.y, cells.side.w, cells.side.h, 'Збоку · рентген', null, views.sideDims);

  const matCols = [{ t: 'Поз.', w: 0.08 }, { t: 'Деталь', w: 0.3 }, { t: 'К-сть', w: 0.07 }, { t: 'Т', w: 0.06 }, { t: 'Довж.', w: 0.1 }, { t: 'Шир.', w: 0.1 }, { t: 'Крайка', w: 0.29 }];
  const hwCols = [{ t: '', w: 0.11 }, { t: 'Артикул', w: 0.2 }, { t: 'Найменування', w: 0.58 }, { t: 'К-сть', w: 0.11 }];
  const avail = stampTop - tablesY - 30 - 28;
  const rowOf = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(avail / Math.max(1, n))));
  const mh = rowOf(mats.length, 19, 28), hh = rowOf(hws.length, 22, 44);
  const fm = Math.max(11, Math.min(16, Math.round(mh * 0.55))), fh = Math.max(11, Math.min(15, Math.round(hh * 0.4)));
  const lw = (vw - 14) * 0.56, rw = vw - 14 - lw;
  const matText = textCells(ctx, (r) => [r.pos.join(', '), r.name, r.n, fmt(r.t), fmt(r.l), fmt(r.w), r.edge], [0, 2]);
  let mi = table(ctx, M, tablesY, lw, stampTop, 'Матеріали', matCols, mats, 0, mh, matText, fm);
  let hi = table(ctx, M + lw + 14, tablesY, rw, stampTop, 'Фурнітура', hwCols, hws, 0, hh, hwCell(ctx, assets, [(r) => r.art, (r) => r.title, (r) => r.n]), fh);
  // Якщо зовсім не влізло (дуже великий блок) — продовження на наступному аркуші
  while (mi < mats.length || hi < hws.length) {
    const before = mi + hi;
    ctx = newPage();
    if (mi < mats.length) mi = table(ctx, M, M, lw, stampTop, 'Матеріали', matCols, mats, mi, mh, textCells(ctx, (r) => [r.pos.join(', '), r.name, r.n, fmt(r.t), fmt(r.l), fmt(r.w), r.edge], [0, 2]), fm);
    if (hi < hws.length) hi = table(ctx, M + lw + 14, M, rw, stampTop, 'Фурнітура', hwCols, hws, hi, hh, hwCell(ctx, assets, [(r) => r.art, (r) => r.title, (r) => r.n]), fh);
    if (mi + hi === before) break;
  }
  return pages;
}

/**
 * Загальна специфікація (як у таблиці Excel): складальні одиниці (блоки), далі деталі окремо по кожному матеріалу
 * (від товстих до тонких), далі фурнітура разом. Альбомний A4, скільки треба аркушів.
 */
function generalPages(panels, names, info, assets) {
  const [W, H] = [A4[1], A4[0]];
  const M = 40, vw = W - 2 * M, stampTop = H - M - STAMP_H - 12;
  const pages = [];
  const newPage = newPageFn(pages, W, H, M);
  const sections = [];
  sections.push({
    title: 'Складальні одиниці',
    cols: [{ t: 'Поз.', w: 0.08 }, { t: 'Блок', w: 0.8 }, { t: 'К-сть', w: 0.12 }],
    rows: names.map((n, i) => [i + 1, n, 1]),
  });
  // Деталі по матеріалах
  const byMat = new Map();
  for (const p of panels) {
    const b = blockOfPanel(p);
    if (!names.includes(b) || !(p.t > 0 && p.t <= 60)) continue;
    const key = p.mat || 'Без матеріалу';
    if (!byMat.has(key)) byMat.set(key, { t: p.t, list: [] });
    byMat.get(key).list.push(p);
  }
  for (const [mat, g] of [...byMat].sort((a, b) => b[1].t - a[1].t || a[0].localeCompare(b[0], 'uk'))) {
    const m = new Map();
    for (const p of g.list) {
      const k = [blockOfPanel(p), p.name, fmt(p.l), fmt(p.w), fmt(p.t), p.art].join('|');
      if (!m.has(k)) m.set(k, { p, n: 0 });
      m.get(k).n++;
    }
    const rows = [...m.values()].sort((a, b) => (parseFloat(a.p.art) || 1e9) - (parseFloat(b.p.art) || 1e9))
      .map(({ p, n }) => [p.art || '', `${blockOfPanel(p)}_${p.name}`, fmt(p.t), n, fmt(p.l), fmt(p.w), edgeTxt(p), cutTxt(p)]);
    sections.push({
      title: `Специфікація для ${mat}`,
      cols: [{ t: 'Поз.', w: 0.05 }, { t: 'Найменування', w: 0.4 }, { t: 'Т', w: 0.05 }, { t: 'К-сть', w: 0.06 }, { t: 'Довжина', w: 0.08 }, { t: 'Ширина', w: 0.08 }, { t: 'Крайка', w: 0.13 }, { t: 'Дод. обробка (пази)', w: 0.15 }],
      rows,
    });
  }
  // Фурнітура разом по всіх блоках
  const hw = new Map();
  for (const n of names) for (const r of hardwareRows(panels.spec, n)) {
    const k = r.title + '|' + r.art;
    if (!hw.has(k)) hw.set(k, { ...r, n: 0 });
    hw.get(k).n += r.n;
  }
  const hwRows = [...hw.values()].sort((a, b) => a.title.localeCompare(b.title, 'uk'));
  let ctx = newPage();
  let y = M;
  ctx.fillStyle = INK;
  ctx.font = `800 26px ${FONT}`;
  ctx.fillText(GENERAL, M, y + 26);
  y += 44;
  const rowH = 24;
  for (const sec of sections) {
    let i = 0;
    while (i < sec.rows.length) {
      if (y + 30 + 28 + rowH > stampTop) { ctx = newPage(); y = M; }
      const before = i;
      i = table(ctx, M, y, vw, stampTop, sec.title, sec.cols, sec.rows, i, rowH, textCells(ctx, (r) => r, [0]), 13);
      y = table.lastY + 16;
      if (i === before) { ctx = newPage(); y = M; }
    }
  }
  if (hwRows.length) {
    const cols = [{ t: '', w: 0.07 }, { t: 'Артикул', w: 0.17 }, { t: 'Найменування', w: 0.66 }, { t: 'К-сть', w: 0.1 }];
    let i = 0;
    while (i < hwRows.length) {
      if (y + 30 + 28 + 40 > stampTop) { ctx = newPage(); y = M; }
      const before = i;
      i = table(ctx, M, y, vw, stampTop, 'Фурнітура, придбана продукція', cols, hwRows, i, 40, hwCell(ctx, assets, [(r) => r.art, (r) => r.title, (r) => r.n]), 13);
      y = table.lastY + 16;
      if (i === before) { ctx = newPage(); y = M; }
    }
  }
  return pages;
}

// ---------------- PDF з JPEG-сторінок ----------------
async function pdfFromCanvases(canvases) {
  const enc = new TextEncoder();
  const parts = [];
  let len = 0;
  const offsets = [];
  const push = (b) => { const u = typeof b === 'string' ? enc.encode(b) : b; parts.push(u); len += u.length; };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const n = canvases.length;
  // Об'єкти: 1 каталог, 2 сторінки, далі на кожну сторінку: сторінка, вміст, зображення
  const obj = (id, body) => { offsets[id] = len; push(`${id} 0 obj\n`); for (const b of [].concat(body)) push(b); push('\nendobj\n'); };
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const kids = canvases.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  for (let i = 0; i < n; i++) {
    const c = canvases[i];
    const jpg = new Uint8Array(await (await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9))).arrayBuffer());
    const pw = (c.width / DPI * 72).toFixed(2), ph = (c.height / DPI * 72).toFixed(2);
    const pid = 3 + i * 3, cid = pid + 1, iid = pid + 2;
    obj(pid, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im${i} ${iid} 0 R >> >> /Contents ${cid} 0 R >>`);
    const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im${i} Do Q`;
    obj(cid, [`<< /Length ${content.length} >>\nstream\n`, content, '\nendstream']);
    obj(iid, [`<< /Type /XObject /Subtype /Image /Width ${c.width} /Height ${c.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`, jpg, '\nendstream']);
  }
  const xref = len;
  const total = 3 + n * 3;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) x += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  push(x + `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

/** Блоки, для яких можна зробити аркуш: є в моделі й мають плити. */
export function sheetBlocks(model, panels) {
  const withPanels = new Set(panels.filter((p) => p.t > 0 && p.t <= 60).map(blockOfPanel));
  return [...blockGroups(model, panels).byName.keys()].filter((n) => withPanels.has(n))
    .sort((a, b) => a.localeCompare(b, 'uk', { numeric: true }));
}


// ---------------- Схема складання і деталювання ----------------
/** Схема складання: розібраний блок двічі поруч — у текстурах і рентгеном, номери позицій на обох. */
function assemblyPage(views) {
  const [W, H] = [A4[1], A4[0]];
  const M = 40, stampTop = H - M - STAMP_H - 12, gap = 12;
  const pages = [];
  const ctx = newPageFn(pages, W, H, M)();
  const half = (W - 2 * M - gap) / 2;
  viewBox(ctx, views.exploded, M, M, half, stampTop - M, 'Схема складання · текстури', views.explodedMarks);
  if (views.explodedXray) viewBox(ctx, views.explodedXray, M + half + gap, M, half, stampTop - M, 'Схема складання · рентген (видно кріплення)', views.explodedMarks);
  return pages[0];
}

/** SVG → картинка заданої ширини (для креслення деталі на аркуші). */
async function svgImage(svg, w) {
  const vb = (svg.getAttribute('viewBox') || '0 0 100 100').split(/[\s,]+/).map(Number);
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(Math.round(w * vb[3] / vb[2])));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
  const im = await loadImg(url);
  URL.revokeObjectURL(url);
  return im;
}

/** Деталі блоку для деталювання: однакові — одним кресленням з кількістю; деталі під-блоків — у під-блоці. */
function detailList(panels, name, subs) {
  const subSet = new Set(subs.map((s) => s.split(SEP)[1]));
  const m = new Map();
  for (const p of panels) {
    const path = pathOf(p);
    if (!inBlock(path, name) || !(p.t > 0 && p.t <= 60)) continue;
    if (!name.includes(SEP) && path.length >= 2 && subSet.has(path[1])) continue;
    const k = [p.art, p.name, p.mat, fmt(p.l), fmt(p.w), fmt(p.t)].join('|');
    if (!m.has(k)) m.set(k, { p, n: 0 });
    m.get(k).n++;
  }
  return [...m.values()].sort((a, b) => (parseFloat(a.p.art) || 1e9) - (parseFloat(b.p.art) || 1e9));
}

/** Деталювання: 4 деталі на альбомному аркуші — креслення з розмірами, крайкою, отворами, пазами; легенда під ним. */
async function detailPages(list) {
  const [W, H] = [A4[1], A4[0]];
  const M = 40, stampTop = H - M - STAMP_H - 12, gap = 12;
  const cw = (W - 2 * M - gap) / 2, chh = (stampTop - M - gap) / 2;
  const pages = [];
  const newPage = newPageFn(pages, W, H, M);
  let ctx = null;
  for (let i = 0; i < list.length; i++) {
    const { p, n } = list[i];
    if (i % 4 === 0) ctx = newPage();
    const x = M + (i % 2) * (cw + gap), y = M + (Math.floor(i / 2) % 2) * (chh + gap);
    ctx.strokeStyle = '#d9d2c5';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, cw, chh);
    ctx.fillStyle = INK;
    ctx.font = `800 19px ${FONT}`;
    ctx.fillText(fit(ctx, `Поз. ${p.art || '—'} · ${p.name || 'Деталь'}`, cw - 120), x + 10, y + 24);
    ctx.textAlign = 'right';
    ctx.fillText(`К-сть ${n}`, x + cw - 10, y + 24);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#6f685c';
    ctx.font = `600 13px ${FONT}`;
    ctx.fillText(fit(ctx, `${fmt(p.l)} × ${fmt(p.w)} × ${fmt(p.t)} мм · ${p.mat || ''}`, cw - 20), x + 10, y + 44);
    // Легенда: крайка, отвори, пази, текстура
    const { svg, groups } = partSvg(p);
    const ed = edgesOf(p), cuts = cutsOf(p);
    const items = [];
    for (const k of ed.kinds) items.push({ color: k.color, bar: true, t: `крайка ${fmt(k.t)}` });
    for (const g of groups) items.push({ color: g.color, t: `${g.title} ${g.th ? 'наскрізь' : g.where} ×${g.n}` });
    const seenC = new Set();
    for (const c of cuts) {
      const t = `${c.name} ${fmt(c.width)}×${fmt(c.depth)} ${c.side === 'A' ? 'пл. А' : c.side === 'B' ? 'пл. Б' : 'наскрізь'}${c.inside ? '' : ' ⚠'}`;
      if (!seenC.has(t)) { seenC.add(t); items.push({ color: '#8a6d3b', t }); }
    }
    if (p.tex === 1 || p.tex === 2) items.push({ color: '#6b4f24', t: p.tex === 1 ? 'текстура ↔' : 'текстура ↕' });
    ctx.font = `600 12px ${FONT}`;
    const rows = [];
    let line = [], lw = 0;
    for (const it of items) {
      const iw = ctx.measureText(it.t).width + 30;
      if (lw + iw > cw - 20 && line.length) { rows.push(line); line = []; lw = 0; }
      line.push({ ...it, iw });
      lw += iw;
    }
    if (line.length) rows.push(line);
    const legendH = rows.length * 18 + 6;
    rows.forEach((row, ri) => {
      let lx = x + 10;
      const ly = y + chh - legendH + ri * 18 + 12;
      for (const it of row) {
        ctx.fillStyle = it.color;
        if (it.bar) ctx.fillRect(lx, ly - 4, 18, 6);
        else { ctx.beginPath(); ctx.arc(lx + 8, ly - 1, 5, 0, Math.PI * 2); ctx.fill(); }
        ctx.fillStyle = INK;
        ctx.fillText(it.t, lx + 24, ly + 3);
        lx += it.iw;
      }
    });
    // Креслення
    const top = y + 54, area = { w: cw - 16, h: chh - 54 - legendH - 8 };
    const im = await svgImage(svg, Math.round(area.w * 1.6));
    if (im) {
      const s = Math.min(area.w / im.width, area.h / im.height);
      ctx.drawImage(im, x + 8 + (area.w - im.width * s) / 2, top + (area.h - im.height * s) / 2, im.width * s, im.height * s);
    }
  }
  return pages;
}

/**
 * PDF: титульний і загальна специфікація (якщо блоків кілька або general), далі на кожен блок —
 * аркуш блоку, схема складання, деталювання; одразу за блоком — так само кожен його під-блок.
 * onStep(i, всього) — для показу прогресу.
 */
export async function makeBlockPdf({ viewer, model, panels, names, onStep, general = names.length > 1 }) {
  const info = panels.info || {};
  const logo = await loadImg(logoUrl);
  const codes = [...new Set(names.flatMap((n) => hardwareRows(panels.spec, n).flatMap((r) => r.codes)))];
  const hw = new Map();
  await Promise.all(codes.map(async (c) => { const im = await loadImg(`${import.meta.env.BASE_URL}data/hw/${c}.jpg`); if (im) hw.set(c, im); }));
  // Без фото з Віяра (петлі Blum, ручки тощо) — мініатюра цієї фурнітури з 3D-моделі
  const norm = (t) => String(t || '').toLowerCase().replace(/[^a-zа-яіїєґ0-9]+/gi, '');
  const allNames = names.flatMap((n) => [n, ...subBlocksOf(panels, n)]);
  const missing = [...new Map(allNames.flatMap((n) => hardwareRows(panels.spec, n)).filter((r) => !r.codes.some((c) => hw.has(c))).map((r) => [r.title, r])).values()];
  const hwParts = model.parts.filter((p) => !p.board && p.key !== 'room' && p.meshes?.length);
  const thumbList = [];
  for (const r of missing) {
    const t = norm(r.title).slice(0, 18);
    if (t.length < 6) continue;
    const part = hwParts.find((p) => { const n = norm(p.name?.title); return n.length >= 6 && (n.startsWith(t) || t.startsWith(n.slice(0, 18))); });
    if (part) thumbList.push({ key: r.title, part });
  }
  const assets = { hw, thumbs: renderThumbs(viewer, model, thumbList) };
  // Посилання для QR: ця модель на сайті; для блоку — ще точка його центру (відкриється саме він)
  const slug = new URLSearchParams(location.search).get('model');
  const base = slug ? `${location.origin}${location.pathname}?model=${encodeURIComponent(slug)}` : null;
  const docs = [];
  if (general) {
    docs.push({ name: TITLE, pages: [titlePage(viewer, model, names, info, panels)], url: base });
    docs.push({ name: GENERAL, pages: generalPages(panels, names, info, assets), url: base });
  }
  const list = names.flatMap((n) => { const subs = subBlocksOf(panels, n); return [{ name: n, subs }, ...subs.map((s) => ({ name: s, subs: [] }))]; });
  const [LW, LH] = [A4[1], A4[0]];
  for (let i = 0; i < list.length; i++) {
    const { name, subs } = list[i];
    onStep?.(i, list.length);
    await new Promise((r) => setTimeout(r, 30)); // дати кнопці перемалюватись
    const bp = blockParts(model, name, panels);
    if (!bp.length) continue;
    const mats = materialRows(panels, name);
    const hws = hardwareRows(panels.spec, name);
    const L = layout(model.boxOf(bp).getSize(new THREE.Vector3()), Math.max(mats.length, Math.ceil(hws.length * 1.4)));
    // Рендер у пропорціях комірки з запасом різкості ×1.4 (вид з позиціями — мінус поля під виноски)
    const px = (c, padX, padY) => [Math.round((c.w - padX) * 1.4), Math.round((c.h - padY) * 1.4)];
    const sz = {
      open: px(L.cells.open, 92, 92), closed: px(L.cells.closed, 16, 34), front: px(L.cells.front, 74, 82), side: px(L.cells.side, 74, 82),
      exploded: [Math.round(((LW - 80 - 12) / 2 - 92) * 1.4), Math.round((LH - 40 - STAMP_H - 12 - 40 - 92) * 1.4)],
    };
    const views = renderViews(viewer, model, panels, name, sz);
    if (!views) continue;
    views.layout = L;
    const pages = blockPages(views, name, mats, hws, assets);
    if (views.exploded) pages.push(assemblyPage(views));
    pages.push(...await detailPages(detailList(panels, name, subs)));
    const boards = bp.filter((p) => p.board);
    const bc = model.boxOf(boards.length ? boards : bp).getCenter(new THREE.Vector3());
    docs.push({ name, pages, url: base ? `${base}&at=${[bc.x, bc.y, bc.z].map(Math.round).join(',')}` : null });
  }
  const all = docs.flatMap((d) => d.pages);
  // Штамп — після того, як відомо, скільки аркушів
  let k = 0;
  for (const d of docs) for (const c of d.pages) {
    k++;
    stamp(c.getContext('2d'), c.width, c.height, 40, logo, info, d.name, k, all.length, d.url);
  }
  if (import.meta.env.DEV) window.__sheets = all; // лише для перевірки локально
  return pdfFromCanvases(all);
}
