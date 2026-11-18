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
// Контакти M3 для штампа (поки не задані — порожньо)
const CONTACTS = ['М3 Меблі'];

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
function renderViews(viewer, model, panels, name, vw, vh) {
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
    const shot = (cam) => {
      r.setSize(vw, vh, false);
      r.render(scene, cam);
      const c = document.createElement('canvas');
      c.width = vw; c.height = vh;
      c.getContext('2d').drawImage(r.domElement, 0, 0);
      return c;
    };

    model.setViewMode('real-lines');
    show(() => true);
    out.closed = shot(camFor(box, iso, vw, vh, false));

    show((p) => p.key !== 'facade' && !doorParts.has(p));
    const camOpen = camFor(box, iso, vw, vh, false);
    out.open = shot(camOpen);
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
    out.front = shot(camFor(box, front, vw, vh, true));
    out.side = shot(camFor(box, side, vw, vh, true));
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

/** Таблиця з рядка start; повертає індекс першого рядка, що не вліз. */
function table(ctx, x, y, w, maxY, title, cols, rows, start, rowH, cell) {
  ctx.fillStyle = INK;
  ctx.font = `700 22px ${FONT}`;
  ctx.fillText(title + (start ? ' (продовження)' : ''), x, y + 22);
  y += 34;
  const xs = [];
  let cx = x;
  for (const c of cols) { xs.push(cx); cx += c.w * w; }
  const headH = 34;
  ctx.fillStyle = '#efe9df';
  ctx.fillRect(x, y, w, headH);
  ctx.font = `700 16px ${FONT}`;
  ctx.fillStyle = INK;
  cols.forEach((c, i) => ctx.fillText(fit(ctx, c.t, c.w * w - 10), xs[i] + 5, y + 22));
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, headH);
  y += headH;
  let i = start;
  for (; i < rows.length; i++) {
    if (y + rowH > maxY) break;
    ctx.strokeRect(x, y, w, rowH);
    cols.forEach((c, k) => { if (k) { ctx.beginPath(); ctx.moveTo(xs[k], y); ctx.lineTo(xs[k], y + rowH); ctx.stroke(); } });
    cell(rows[i], xs, y, rowH);
    y += rowH;
  }
  return i;
}

function stamp(ctx, W, H, M, logo, info, block, page, pages) {
  const h = 120, y = H - M - h, x = M, w = W - 2 * M;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
  const c1 = x + 230, c3 = x + w - 230;
  ctx.beginPath();
  ctx.moveTo(c1, y); ctx.lineTo(c1, y + h);
  ctx.moveTo(c3, y); ctx.lineTo(c3, y + h);
  ctx.moveTo(c1, y + h / 2); ctx.lineTo(c3, y + h / 2);
  ctx.moveTo(c3, y + h / 2); ctx.lineTo(x + w, y + h / 2);
  ctx.stroke();
  if (logo) {
    const s = Math.min(150 / logo.width, (h - 20) / logo.height);
    ctx.drawImage(logo, x + 12, y + (h - logo.height * s) / 2, logo.width * s, logo.height * s);
  }
  ctx.fillStyle = INK;
  ctx.font = `600 15px ${FONT}`;
  CONTACTS.slice(1).forEach((t, i) => ctx.fillText(fit(ctx, t, 60), x + 165, y + 30 + i * 20));
  const label = (t, v, lx, ly, lw) => {
    ctx.fillStyle = '#6f685c';
    ctx.font = `600 14px ${FONT}`;
    ctx.fillText(t, lx + 10, ly + 20);
    ctx.fillStyle = INK;
    ctx.font = `800 24px ${FONT}`;
    ctx.fillText(fit(ctx, v, lw - 20), lx + 10, ly + 48);
  };
  label('Блок', block, c1, y, c3 - c1);
  label('Виріб · замовлення', [info.name, (info.prefix || '').trim()].filter(Boolean).join(' · '), c1, y + h / 2, c3 - c1);
  label('Аркуш', `${page} з ${pages}`, c3, y, 230);
  label('Дата', new Date().toLocaleDateString('uk-UA'), c3, y + h / 2, 230);
}

/** Вид у рамці з підписом; для відкритого — виноски з позиціями ліворуч і праворуч. */
function viewBox(ctx, img, x, y, w, h, title, marks) {
  ctx.strokeStyle = '#d9d2c5';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = '#6f685c';
  ctx.font = `700 16px ${FONT}`;
  ctx.fillText(title, x + 8, y + 22);
  const pad = marks ? 44 : 10, top = 30;
  const s = Math.min((w - 2 * pad) / img.width, (h - top - 10) / img.height);
  const ix = x + (w - img.width * s) / 2, iy = y + top + (h - top - 10 - img.height * s) / 2;
  ctx.drawImage(img, ix, iy, img.width * s, img.height * s);
  if (!marks || !marks.length) return;
  // Виноски: ліва половина — до лівого краю, права — до правого; підписи розсунуті по висоті
  const cxm = ix + img.width * s / 2;
  const sides = [marks.filter((m) => ix + m.x * s < cxm), marks.filter((m) => ix + m.x * s >= cxm)];
  sides.forEach((list, si) => {
    list = list.map((m) => ({ ...m, px: ix + m.x * s, py: iy + m.y * s })).sort((a, b) => a.py - b.py);
    const gap = 26;
    let last = y + top;
    for (const m of list) { m.ly = Math.max(m.py, last + gap); last = m.ly; }
    const over = last - (y + h - 14);
    if (over > 0) for (const m of list) m.ly -= over;
    const lx = si ? x + w - 22 : x + 22;
    for (const m of list) {
      ctx.strokeStyle = '#3b3a36';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(m.px, m.py);
      ctx.lineTo(lx + (si ? -14 : 14), m.ly);
      ctx.lineTo(lx, m.ly);
      ctx.stroke();
      ctx.fillStyle = '#3b3a36';
      ctx.beginPath(); ctx.arc(m.px, m.py, 3, 0, Math.PI * 2); ctx.fill();
      ctx.font = `700 17px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(m.pos, lx, m.ly - 5);
      ctx.textAlign = 'left';
    }
  });
}

/** Розкладка аркуша: розмір сторінки й комірок видів. Висока шафа — книжковий, інакше альбомний. */
function layout(size) {
  const portrait = size.y > Math.max(size.x, size.z) * 1.25;
  const [W, H] = portrait ? A4 : [A4[1], A4[0]];
  const M = 40, vw = W - 2 * M, stampTop = H - M - 120 - 16;
  // Чотири види в один ряд: для високого блоку — вузькі й високі комірки
  const cw = (vw - 3 * 12) / 4;
  const ch = portrait ? Math.min(cw * 2.6, (stampTop - M) * 0.5) : Math.min(cw * 1.15, (stampTop - M) * 0.55);
  return { portrait, W, H, M, vw, stampTop, cw, ch };
}

/** Аркуші одного блоку (canvas-и). */
async function blockPages(views, block, mats, hws, info, assets) {
  const { portrait, W, H, M, vw, stampTop, cw, ch } = views.layout;
  const pages = [];
  const newPage = () => {
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
  let ctx = newPage();
  // Види
  let y = M;
  const list = [[views.closed, 'Загальний вигляд', null], [views.open, 'Без фасадів · позиції', views.marks], [views.front, 'Спереду · рентген', null], [views.side, 'Збоку · рентген', null]];
  list.forEach(([img, t, mk], i) => viewBox(ctx, img, M + i * (cw + 12), y, cw, ch, t, mk));
  y += ch + 18;
  // Таблиці
  const matCols = [{ t: 'Поз.', w: 0.09 }, { t: 'Матеріал', w: 0.41 }, { t: 'Деталь', w: 0.2 }, { t: 'К-сть', w: 0.07 }, { t: 'Т', w: 0.07 }, { t: 'Довж.', w: 0.08 }, { t: 'Шир.', w: 0.08 }];
  const hwCols = [{ t: '', w: 0.12 }, { t: 'Артикул', w: 0.17 }, { t: 'Найменування', w: 0.6 }, { t: 'К-сть', w: 0.11 }];
  const matCell = (ctx2) => (r, xs, yy, rh) => {
    ctx2.fillStyle = INK;
    ctx2.font = `500 15px ${FONT}`;
    const vals = [r.pos.join(', '), r.mat, r.name, r.n, fmt(r.t), fmt(r.l), fmt(r.w)];
    vals.forEach((v, k) => ctx2.fillText(fit(ctx2, v, (k < xs.length - 1 ? xs[k + 1] : xs[k] + 200) - xs[k] - 10), xs[k] + 5, yy + rh / 2 + 5));
  };
  const hwCell = (ctx2) => (r, xs, yy, rh) => {
    const imgs = r.codes.map((c) => assets.hw.get(c)).filter(Boolean).slice(0, 2);
    const cw = xs[1] - xs[0] - 6;
    imgs.forEach((im, k) => { const sz = Math.min(rh - 6, cw / imgs.length - 2); ctx2.drawImage(im, xs[0] + 3 + k * (sz + 2), yy + 3, sz, sz); });
    ctx2.fillStyle = INK;
    ctx2.font = `500 15px ${FONT}`;
    ctx2.fillText(fit(ctx2, r.art, xs[2] - xs[1] - 10), xs[1] + 5, yy + rh / 2 + 5);
    ctx2.fillText(fit(ctx2, r.title, xs[3] - xs[2] - 10), xs[2] + 5, yy + rh / 2 + 5);
    ctx2.font = `700 16px ${FONT}`;
    ctx2.fillText(String(r.n), xs[3] + 5, yy + rh / 2 + 5);
  };
  let mi = 0, hi = 0;
  const twoCol = !portrait;
  const fill = (ctx2, yTop) => {
    if (twoCol) {
      const lw = (vw - 16) * 0.56, rw = vw - 16 - lw;
      if (mi < mats.length) mi = table(ctx2, M, yTop, lw, stampTop, 'Матеріали', matCols, mats, mi, 30, matCell(ctx2));
      if (hi < hws.length) hi = table(ctx2, M + lw + 16, yTop, rw, stampTop, 'Фурнітура', hwCols, hws, hi, 52, hwCell(ctx2));
    } else {
      let yy = yTop;
      if (mi < mats.length) {
        const before = mi;
        mi = table(ctx2, M, yy, vw, stampTop, 'Матеріали', matCols, mats, mi, 30, matCell(ctx2));
        yy += 34 + 34 + (mi - before) * 30 + 20;
      }
      if (mi >= mats.length && hi < hws.length && yy + 34 + 34 + 52 < stampTop) hi = table(ctx2, M, yy, vw, stampTop, 'Фурнітура', hwCols, hws, hi, 52, hwCell(ctx2));
    }
  };
  fill(ctx, y);
  while (mi < mats.length || hi < hws.length) {
    const before = mi + hi;
    ctx = newPage();
    fill(ctx, M);
    if (mi + hi === before) break; // не влазить навіть один рядок
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

/** PDF аркушів для блоків names. onStep(i, всього) — для показу прогресу. */
export async function makeBlockPdf({ viewer, model, panels, names, onStep }) {
  const info = panels.info || {};
  const logo = await loadImg(logoUrl);
  const codes = [...new Set(names.flatMap((n) => hardwareRows(panels.spec, n).flatMap((r) => r.codes)))];
  const hw = new Map();
  await Promise.all(codes.map(async (c) => { const im = await loadImg(`${import.meta.env.BASE_URL}data/hw/${c}.jpg`); if (im) hw.set(c, im); }));
  const blocks = [];
  for (let i = 0; i < names.length; i++) {
    onStep?.(i, names.length);
    await new Promise((r) => setTimeout(r, 30)); // дати кнопці перемалюватись
    const bp = blockParts(model, names[i]);
    if (!bp.length) continue;
    const L = layout(model.boxOf(bp).getSize(new THREE.Vector3()));
    // Рендер у пропорціях комірки (мінус підпис), з запасом різкості ×1.5
    const views = renderViews(viewer, model, panels, names[i], Math.round((L.cw - 20) * 1.5), Math.round((L.ch - 40) * 1.5));
    if (!views) continue;
    views.layout = L;
    const pages = await blockPages(views, names[i], materialRows(panels, names[i]), hardwareRows(panels.spec, names[i]), info, { hw });
    blocks.push({ name: names[i], pages });
  }
  const all = blocks.flatMap((b) => b.pages);
  // Штамп — після того, як відомо, скільки аркушів
  let k = 0;
  for (const b of blocks) for (const c of b.pages) {
    k++;
    stamp(c.getContext('2d'), c.width, c.height, 40, logo, info, b.name, k, all.length);
  }
  if (import.meta.env.DEV) window.__sheets = all; // лише для перевірки локально
  return pdfFromCanvases(all);
}
