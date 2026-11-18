// Аркуші блоків для виробництва (лише менеджеру): A4 на блок — 4 види (закритий у текстурах, відкритий без фасадів
// з позиціями деталей, спереду рентгеном, збоку рентгеном), матеріали (від товстих до тонких), фурнітура з фото Віяра,
// штамп. Аркуші малюються на canvas і складаються в PDF (JPEG-сторінки) без сторонніх бібліотек.

import * as THREE from 'three';
import logoUrl from './assets/logo-m3.png';
import { matchPanel } from './drill.js';

const DPI = 150;
const A4 = [Math.round(210 / 25.4 * DPI), Math.round(297 / 25.4 * DPI)]; // 1240 × 1754
const FONT = 'Manrope, "Segoe UI", system-ui, sans-serif';
const INK = '#1d1d1f';
const LINE = '#7a7468';

const fmt = (n) => (Math.round(n * 10) / 10).toString();
const blockOfPanel = (p) => (p.path || []).filter((x) => x && x !== 'Модель')[0] || '';
const nameLines = (n) => String(n || '').split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);

// ---------------- Дані блоку ----------------
/** Матеріали блоку: однакові деталі — одним рядком, від товстих до тонких. */
function materialRows(panels, block) {
  const m = new Map();
  for (const p of panels) {
    if (blockOfPanel(p) !== block || !(p.t > 0 && p.t <= 60)) continue;
    const k = [p.mat, p.name, fmt(p.l), fmt(p.w), fmt(p.t)].join('|');
    if (!m.has(k)) m.set(k, { pos: [], mat: p.mat || '', name: p.name || '', n: 0, t: p.t, l: p.l, w: p.w });
    const r = m.get(k);
    r.n++;
    if (p.art && !r.pos.includes(p.art)) r.pos.push(p.art);
  }
  const num = (r) => parseFloat(r.pos[0]) || 1e9;
  return [...m.values()].sort((a, b) => b.t - a.t || a.mat.localeCompare(b.mat, 'uk') || num(a) - num(b));
}
/** Фурнітура блоку: назва без рядка артикула, артикул(и), кількість. Службові об'єкти («6», «2x2») — геть. */
function hardwareRows(spec, block) {
  const m = new Map();
  for (const s of spec || []) {
    if ((s.path || []).filter((x) => x && x !== 'Модель')[0] !== block) continue;
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
function blockParts(model, name) {
  const own = model.parts.filter((p) => p.group?.name === name);
  if (!own.length) return [];
  const box = model.boxOf(own).clone().expandByScalar(2);
  const blockNames = new Set(model.blocks.map((b) => b.name));
  const ownSet = new Set(own);
  const c = new THREE.Vector3();
  // Кріплення, що в моделі лежать окремою групою (шканти тощо), але всередині габариту блоку
  const extra = model.parts.filter((p) => !ownSet.has(p) && p.key !== 'room' && !blockNames.has(p.group?.name) && box.containsPoint(p.box.getCenter(c)));
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

/** Чотири види блоку: canvas-и + точки позицій деталей на відкритому виді. */
function renderViews(viewer, model, panels, name, sz) {
  const parts = blockParts(model, name);
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
    const bl = model.blocks.find((b) => b.name === name);
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

    show((p) => p.key !== 'facade' && !doorParts.has(p));
    const [vw, vh] = sz.open;
    const camOpen = camFor(box, iso, vw, vh, false);
    out.open = shot(camOpen, vw, vh);
    // Позиції деталей (ArtPos з БАЗИСу) — точки на відкритому виді
    out.marks = [];
    const seen = new Set();
    for (const p of parts) {
      if (!p.board || p.key === 'facade' || doorParts.has(p)) continue;
      const dp = matchPanel(panels, p.box);
      if (!dp || !dp.art || seen.has(dp.art + '|' + p.box.min.toArray().join())) continue;
      seen.add(dp.art + '|' + p.box.min.toArray().join());
      const v = p.box.getCenter(new THREE.Vector3()).project(camOpen);
      out.marks.push({ pos: String(dp.art), x: (v.x + 1) / 2 * vw, y: (1 - v.y) / 2 * vh });
    }

    model.setViewMode('xray');
    show(() => true);
    out.front = shot(camFor(box, front, ...sz.front, true), ...sz.front);
    out.side = shot(camFor(box, side, ...sz.side, true), ...sz.side);
    out.size = box.getSize(new THREE.Vector3());
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

function stamp(ctx, W, H, M, logo, info, block, page, pages) {
  const h = STAMP_H, y = H - M - h, x = M, w = W - 2 * M;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
  const c1 = x + 200, c3 = x + w - 210;
  ctx.beginPath();
  ctx.moveTo(c1, y); ctx.lineTo(c1, y + h);
  ctx.moveTo(c3, y); ctx.lineTo(c3, y + h);
  ctx.moveTo(c1, y + h / 2); ctx.lineTo(c3, y + h / 2);
  ctx.moveTo(c3, y + h / 2); ctx.lineTo(x + w, y + h / 2);
  ctx.stroke();
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
  label(block === GENERAL ? 'Документ' : 'Блок', block, c1, y, c3 - c1);
  label('Виріб · замовлення', [info.name, (info.prefix || '').trim()].filter(Boolean).join(' · '), c1, y + h / 2, c3 - c1);
  label('Аркуш', `${page} з ${pages}`, c3, y, 210);
  label('Дата', new Date().toLocaleDateString('uk-UA'), c3, y + h / 2, 210);
}

/**
 * Вид у рамці з підписом. Для виду з позиціями — виноски по всьому периметру рамки:
 * кожна позиція йде до найближчої сторони, однакові позиції — один номер, кілька ліній.
 */
function viewBox(ctx, img, x, y, w, h, title, marks) {
  ctx.strokeStyle = '#d9d2c5';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = '#6f685c';
  ctx.font = `700 15px ${FONT}`;
  ctx.fillText(title, x + 8, y + 20);
  const pad = marks && marks.length ? 46 : 8, top = marks && marks.length ? 46 : 26;
  const s = Math.min((w - 2 * pad) / img.width, (h - top - pad) / img.height);
  const iw = img.width * s, ih = img.height * s;
  const ix = x + (w - iw) / 2, iy = y + top + (h - top - pad - ih) / 2;
  ctx.drawImage(img, ix, iy, iw, ih);
  if (!marks || !marks.length) return;
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
}

const STAMP_H = 100;
const GENERAL = 'Загальна специфікація';

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
  const cells = {
    open: { x: M, y: M, w: bw, h: vh },
    closed: { x: M + bw + gap, y: M, w: sw, h: vh },
    front: { x: M + bw + gap + (sw + gap), y: M, w: sw, h: vh },
    side: { x: M + bw + gap + 2 * (sw + gap), y: M, w: sw, h: vh },
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
  const cw = xs[1] - xs[0] - 4;
  imgs.forEach((im, k) => { const sz = Math.min(rh - 4, cw / imgs.length - 2); ctx.drawImage(im, xs[0] + 2 + k * (sz + 2), y + (rh - sz) / 2, sz, sz); });
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
  viewBox(ctx, views.front, cells.front.x, cells.front.y, cells.front.w, cells.front.h, 'Спереду · рентген');
  viewBox(ctx, views.side, cells.side.x, cells.side.y, cells.side.w, cells.side.h, 'Збоку · рентген');

  const matCols = [{ t: 'Поз.', w: 0.08 }, { t: 'Матеріал', w: 0.4 }, { t: 'Деталь', w: 0.22 }, { t: 'К-сть', w: 0.07 }, { t: 'Т', w: 0.06 }, { t: 'Довж.', w: 0.085 }, { t: 'Шир.', w: 0.085 }];
  const hwCols = [{ t: '', w: 0.11 }, { t: 'Артикул', w: 0.2 }, { t: 'Найменування', w: 0.58 }, { t: 'К-сть', w: 0.11 }];
  const avail = stampTop - tablesY - 30 - 28;
  const rowOf = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(avail / Math.max(1, n))));
  const mh = rowOf(mats.length, 19, 28), hh = rowOf(hws.length, 22, 44);
  const fm = Math.max(11, Math.min(15, Math.round(mh * 0.52))), fh = Math.max(11, Math.min(15, Math.round(hh * 0.4)));
  const lw = (vw - 14) * 0.56, rw = vw - 14 - lw;
  const matText = textCells(ctx, (r) => [r.pos.join(', '), r.mat, r.name, r.n, fmt(r.t), fmt(r.l), fmt(r.w)], [0, 3]);
  let mi = table(ctx, M, tablesY, lw, stampTop, 'Матеріали', matCols, mats, 0, mh, matText, fm);
  let hi = table(ctx, M + lw + 14, tablesY, rw, stampTop, 'Фурнітура', hwCols, hws, 0, hh, hwCell(ctx, assets, [(r) => r.art, (r) => r.title, (r) => r.n]), fh);
  // Якщо зовсім не влізло (дуже великий блок) — продовження на наступному аркуші
  while (mi < mats.length || hi < hws.length) {
    const before = mi + hi;
    ctx = newPage();
    if (mi < mats.length) mi = table(ctx, M, M, lw, stampTop, 'Матеріали', matCols, mats, mi, mh, textCells(ctx, (r) => [r.pos.join(', '), r.mat, r.name, r.n, fmt(r.t), fmt(r.l), fmt(r.w)], [0, 3]), fm);
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
  const ord = String(info.prefix || '').replace(/[^\d/.-]+/g, '').trim();
  const mark = (art) => (ord ? `${ord}.${art}` : String(art || ''));
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
  const edge = (p) => {
    const sd = { L: 0, R: 0, D: 0, U: 0 };
    const by = new Map((p.b || []).map(([i, , t]) => [i, +t || 0]));
    for (const sg of p.c || []) {
      const t = sg.length > 4 ? by.get(sg[4]) : 0;
      if (!t) continue;
      const e = 0.6;
      if (Math.abs(sg[0] - sg[2]) < e) sd[Math.abs(sg[0]) < e ? 'L' : 'R'] = Math.max(sd[Math.abs(sg[0]) < e ? 'L' : 'R'], t);
      else if (Math.abs(sg[1] - sg[3]) < e) sd[Math.abs(sg[1]) < e ? 'D' : 'U'] = Math.max(sd[Math.abs(sg[1]) < e ? 'D' : 'U'], t);
    }
    const v = (x) => (x ? fmt(x) : '—');
    return sd.L || sd.R || sd.D || sd.U ? `${v(sd.L)} ${v(sd.R)} | ${v(sd.D)} ${v(sd.U)}` : '';
  };
  const cutsTxt = (p) => [...new Set((p.cut || []).map((c) => String(c.n || '').trim()).filter(Boolean))].join(', ');
  for (const [mat, g] of [...byMat].sort((a, b) => b[1].t - a[1].t || a[0].localeCompare(b[0], 'uk'))) {
    const m = new Map();
    for (const p of g.list) {
      const k = [blockOfPanel(p), p.name, fmt(p.l), fmt(p.w), fmt(p.t), p.art].join('|');
      if (!m.has(k)) m.set(k, { p, n: 0 });
      m.get(k).n++;
    }
    const rows = [...m.values()].sort((a, b) => (parseFloat(a.p.art) || 1e9) - (parseFloat(b.p.art) || 1e9))
      .map(({ p, n }) => [p.art || '', mark(p.art), `${blockOfPanel(p)}_${p.name}`, fmt(p.t), n, fmt(p.l), fmt(p.w), edge(p), cutsTxt(p)]);
    sections.push({
      title: `Специфікація для ${mat}`,
      cols: [{ t: 'Поз.', w: 0.05 }, { t: 'Позначення', w: 0.1 }, { t: 'Найменування', w: 0.3 }, { t: 'Т', w: 0.05 }, { t: 'К-сть', w: 0.06 }, { t: 'Довжина', w: 0.08 }, { t: 'Ширина', w: 0.08 }, { t: 'Крайка Д1 Д2 | Ш1 Ш2', w: 0.13 }, { t: 'Дод. обробка', w: 0.15 }],
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
  return model.blocks.map((b) => b.name).filter((n) => withPanels.has(n));
}

/**
 * PDF: спершу загальна специфікація (якщо блоків кілька або general), далі по аркушу на блок.
 * onStep(i, всього) — для показу прогресу.
 */
export async function makeBlockPdf({ viewer, model, panels, names, onStep, general = names.length > 1 }) {
  const info = panels.info || {};
  const logo = await loadImg(logoUrl);
  const codes = [...new Set(names.flatMap((n) => hardwareRows(panels.spec, n).flatMap((r) => r.codes)))];
  const hw = new Map();
  await Promise.all(codes.map(async (c) => { const im = await loadImg(`${import.meta.env.BASE_URL}data/hw/${c}.jpg`); if (im) hw.set(c, im); }));
  const assets = { hw };
  const docs = [];
  if (general) docs.push({ name: GENERAL, pages: generalPages(panels, names, info, assets) });
  for (let i = 0; i < names.length; i++) {
    onStep?.(i, names.length);
    await new Promise((r) => setTimeout(r, 30)); // дати кнопці перемалюватись
    const bp = blockParts(model, names[i]);
    if (!bp.length) continue;
    const mats = materialRows(panels, names[i]);
    const hws = hardwareRows(panels.spec, names[i]);
    const L = layout(model.boxOf(bp).getSize(new THREE.Vector3()), Math.max(mats.length, Math.ceil(hws.length * 1.4)));
    // Рендер у пропорціях комірки з запасом різкості ×1.4 (вид з позиціями — мінус поля під виноски)
    const px = (c, padX, padY) => [Math.round((c.w - padX) * 1.4), Math.round((c.h - padY) * 1.4)];
    const sz = { open: px(L.cells.open, 92, 92), closed: px(L.cells.closed, 16, 34), front: px(L.cells.front, 16, 34), side: px(L.cells.side, 16, 34) };
    const views = renderViews(viewer, model, panels, names[i], sz);
    if (!views) continue;
    views.layout = L;
    docs.push({ name: names[i], pages: blockPages(views, names[i], mats, hws, assets) });
  }
  const all = docs.flatMap((d) => d.pages);
  // Штамп — після того, як відомо, скільки аркушів
  let k = 0;
  for (const d of docs) for (const c of d.pages) {
    k++;
    stamp(c.getContext('2d'), c.width, c.height, 40, logo, info, d.name, k, all.length);
  }
  if (import.meta.env.DEV) window.__sheets = all; // лише для перевірки локально
  return pdfFromCanvases(all);
}
