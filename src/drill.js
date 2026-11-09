// Присадка (лише для менеджера): креслення деталі з розмірами (від бази / ланцюжком) і 3D-вигляд деталі з отворами.
// Дані: data/<назва>.drill.bin — зашифровано (tools/convert-dae.mjs). Ключ видає воркер лише менеджеру
// (перевіряє підписані Telegram дані), тож у клієнта немає ні кнопки, ні можливості розшифрувати файл.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { NOTIFY_URL } from './notify.js';
import { openSheet } from './extras.js';

const SIDE = { A: 'Пласть А', B: 'Пласть Б', E: 'Торець' };
const EDGE = { L: 'лівий', R: 'правий', D: 'нижній', U: 'верхній' };
const COLORS = ['#e0592a', '#2f6fd6', '#1f9d55', '#c9a227', '#9b4dca', '#d6336c', '#0c8599', '#6b4f24'];

const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** Завантажити присадку моделі, якщо глядач — менеджер. Інакше null (тихо). */
export async function loadDrill(name, tg) {
  try {
    if (!NOTIFY_URL || !tg || !tg.initData) return null;
    const r = await fetch(`${NOTIFY_URL}/drillkey`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ initData: tg.initData }),
    }).then((x) => x.json()).catch(() => null);
    if (!r || !r.ok || !r.key) return null;
    const res = await fetch(`data/${name}.drill.bin`, { cache: 'no-cache' });
    if (!res.ok) return null;
    const blob = new Uint8Array(await res.arrayBuffer());
    const key = await crypto.subtle.importKey('raw', fromB64url(r.key), 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.subarray(0, 12) }, key, blob.subarray(12));
    const data = JSON.parse(new TextDecoder().decode(plain));
    return Array.isArray(data.panels) ? data.panels : null;
  } catch (err) {
    console.warn('Присадка:', err);
    return null;
  }
}

/** Знайти деталь присадки для деталі моделі — за габаритом у глобальних координатах (±1,5 мм). */
export function matchPanel(panels, box) {
  if (!panels || !box) return null;
  const v = [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z];
  let best = null, bestErr = 1e9;
  for (const p of panels) {
    if (!p.g) continue;
    const err = Math.max(...p.g.map((g, i) => Math.abs(g - v[i])));
    if (err < bestErr) { bestErr = err; best = p; }
  }
  return bestErr <= 1.5 ? best : null;
}

const fmt = (n) => (Math.round(n * 10) / 10).toString();
const holeTitle = (g) => `Ø${fmt(g.d)}${g.th ? '' : `×${fmt(g.h)}`}`;
const groupKey = (h) => `${h.t}|${h.e || ''}|${h.d}|${h.th ? 'th' : h.h}|${h.n || ''}`;
const isSideEdge = (h) => h.t === 'E' && (h.e === 'L' || h.e === 'R'); // лівий/правий торець — лише Y
const isEndEdge = (h) => h.t === 'E' && (h.e === 'D' || h.e === 'U'); // нижній/верхній торець — лише X

/** Групи однакових отворів: діаметр, глибина, пласть/торець, кріплення. */
function groupsOf(panel) {
  const map = new Map();
  for (const h of panel.h || []) {
    const k = groupKey(h);
    if (!map.has(k)) map.set(k, { key: k, t: h.t, e: h.e, d: h.d, h: h.h, th: h.th, n: h.n || '', items: [] });
    map.get(k).items.push(h);
  }
  const list = [...map.values()].sort((a, b) => (a.t > b.t ? 1 : a.t < b.t ? -1 : b.d - a.d));
  list.forEach((g, i) => { g.color = COLORS[i % COLORS.length]; });
  return list;
}

// ---------------- Креслення ----------------
const NS = 'http://www.w3.org/2000/svg';
function el(tag, attrs, text) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

/**
 * Креслення (вид з пласті А): контур, отвори, розмірні лінії з виносними від кожного отвору.
 * mode: 'base' — від бази (лівий нижній кут), 'chain' — ланцюжком.
 */
function drawing(panel, groups, only, mode) {
  const W = panel.w, Lh = panel.l;
  const fs = Math.max(W, Lh) / 22; // розмір цифр (у мм креслення)
  const shown = groups.filter((g) => !only || g.key === only);
  const holes = shown.flatMap((g) => g.items.map((h) => ({ ...h, color: g.color })));
  const uniq = (a) => [...new Set(a.map(fmt))].map(Number).sort((p, q) => p - q);
  const xs = uniq(holes.filter((h) => !isSideEdge(h)).map((h) => h.x));
  const ys = uniq(holes.filter((h) => !isEndEdge(h)).map((h) => h.y));
  // Поля під розміри: зверху X, зліва Y; у режимі «від бази» цифри повернуті, тож потрібно більше місця
  const txt = (v) => fmt(v).length * fs * 0.62;
  const longX = Math.max(fs, ...xs.map(txt)), longY = Math.max(fs, ...ys.map(txt));
  const dimX = -fs * 1.2; // розмірна лінія X (над деталлю)
  const dimY = -fs * 1.2; // розмірна лінія Y (ліворуч)
  const top = fs * 1.6 + (mode === 'base' ? longX : fs * 1.4) + fs;
  const left = fs * 1.6 + (mode === 'base' ? longY : fs * 2.4) + fs;
  const right = fs * 1.2, bottom = fs * 3.2;
  const vb0 = { x: -left, y: -top, w: W + left + right, h: Lh + top + bottom };
  const svg = el('svg', { viewBox: `${vb0.x} ${vb0.y} ${vb0.w} ${vb0.h}`, class: 'drill-svg', preserveAspectRatio: 'xMidYMid meet' });
  svg._vb0 = vb0;
  const Y = (y) => Lh - y; // у кресленні Y угору
  const g = el('g', { 'font-size': fs, 'font-family': 'system-ui, sans-serif', 'font-weight': 600 });
  svg.append(g);
  const thin = fs * 0.05;

  // Контур
  const d = (panel.c || []).map((s) => `M${s[0]},${Y(s[1])}L${s[2]},${Y(s[3])}`).join('');
  g.append(el('path', { d, fill: '#f6f2e9', stroke: '#2b2b2b', 'stroke-width': fs * 0.1, 'stroke-linejoin': 'round' }));

  // Виносні лінії від кожного отвору до розмірних ліній (пунктир кольору групи)
  for (const h of holes) {
    const dash = `${fs * 0.25} ${fs * 0.2}`;
    if (!isSideEdge(h)) g.append(el('line', { x1: h.x, y1: Y(h.y), x2: h.x, y2: dimX, stroke: h.color, 'stroke-width': thin, 'stroke-dasharray': dash, opacity: 0.7 }));
    if (!isEndEdge(h)) g.append(el('line', { x1: h.x, y1: Y(h.y), x2: dimY, y2: Y(h.y), stroke: h.color, 'stroke-width': thin, 'stroke-dasharray': dash, opacity: 0.7 }));
  }

  // Розмірні лінії із засічками
  const dimLine = { stroke: '#555', 'stroke-width': thin * 1.6 };
  const tick = (x1, y1, x2, y2) => g.append(el('line', { x1, y1, x2, y2, stroke: '#222', 'stroke-width': thin * 3 }));
  const tl = fs * 0.35;
  if (xs.length) {
    const stops = mode === 'chain' ? [0, ...xs, W] : [0, ...xs];
    g.append(el('line', { x1: 0, y1: dimX, x2: Math.max(...stops), y2: dimX, ...dimLine }));
    for (const x of stops) tick(x - tl * 0.7, dimX + tl * 0.7, x + tl * 0.7, dimX - tl * 0.7);
    if (mode === 'chain') {
      for (let i = 1; i < stops.length; i++) {
        const v = stops[i] - stops[i - 1];
        if (v < 0.05) continue;
        const cx = (stops[i] + stops[i - 1]) / 2;
        if (txt(v) < v * 0.95) g.append(el('text', { x: cx, y: dimX - fs * 0.35, 'text-anchor': 'middle', fill: '#222' }, fmt(v)));
        else g.append(el('text', { x: cx, y: dimX - fs * 0.35, 'text-anchor': 'start', 'dominant-baseline': 'middle', fill: '#222', transform: `rotate(-90 ${cx} ${dimX - fs * 0.35})` }, fmt(v)));
      }
    } else {
      for (const x of xs) g.append(el('text', { x, y: dimX - fs * 0.4, 'text-anchor': 'start', 'dominant-baseline': 'middle', fill: '#222', transform: `rotate(-90 ${x} ${dimX - fs * 0.4})` }, fmt(x)));
    }
  }
  if (ys.length) {
    const stops = mode === 'chain' ? [0, ...ys, Lh] : [0, ...ys];
    g.append(el('line', { x1: dimY, y1: Y(0), x2: dimY, y2: Y(Math.max(...stops)), ...dimLine }));
    for (const y of stops) tick(dimY - tl * 0.7, Y(y) + tl * 0.7, dimY + tl * 0.7, Y(y) - tl * 0.7);
    if (mode === 'chain') {
      for (let i = 1; i < stops.length; i++) {
        const v = stops[i] - stops[i - 1];
        if (v < 0.05) continue;
        const cy = Y((stops[i] + stops[i - 1]) / 2);
        if (txt(v) < v * 0.95) g.append(el('text', { x: dimY - fs * 0.35, y: cy, 'text-anchor': 'middle', fill: '#222', transform: `rotate(-90 ${dimY - fs * 0.35} ${cy})` }, fmt(v)));
        else g.append(el('text', { x: dimY - fs * 0.4, y: cy, 'text-anchor': 'end', 'dominant-baseline': 'middle', fill: '#222' }, fmt(v)));
      }
    } else {
      for (const y of ys) g.append(el('text', { x: dimY - fs * 0.4, y: Y(y), 'text-anchor': 'end', 'dominant-baseline': 'middle', fill: '#222' }, fmt(y)));
    }
  }

  // Габарити
  g.append(el('line', { x1: 0, y1: Lh + fs * 1.1, x2: W, y2: Lh + fs * 1.1, stroke: '#a8834c', 'stroke-width': thin * 1.6 }));
  tick(-tl * 0.7, Lh + fs * 1.1 + tl * 0.7, tl * 0.7, Lh + fs * 1.1 - tl * 0.7);
  tick(W - tl * 0.7, Lh + fs * 1.1 + tl * 0.7, W + tl * 0.7, Lh + fs * 1.1 - tl * 0.7);
  g.append(el('text', { x: W / 2, y: Lh + fs * 2.4, 'text-anchor': 'middle', fill: '#a8834c', 'font-weight': 800 }, fmt(W)));
  g.append(el('text', { x: W + fs * 0.5, y: Lh / 2, 'text-anchor': 'middle', fill: '#a8834c', 'font-weight': 800, transform: `rotate(90 ${W + fs * 0.5} ${Lh / 2})` }, fmt(Lh)));

  // Отвори
  const minR = fs * 0.25;
  for (const h of holes) {
    const r = Math.max(h.d / 2, minR);
    if (h.t === 'E') {
      // Торець: смужка від краю всередину на глибину
      const len = h.h || 10;
      let x = h.x, y = h.y, w2, h2;
      if (h.e === 'L') { w2 = len; h2 = h.d; y -= h.d / 2; }
      else if (h.e === 'R') { w2 = len; h2 = h.d; x -= len; y -= h.d / 2; }
      else if (h.e === 'D') { w2 = h.d; h2 = len; x -= h.d / 2; }
      else { w2 = h.d; h2 = len; x -= h.d / 2; y -= len; }
      g.append(el('rect', { x, y: Y(y + h2), width: w2, height: h2, fill: h.color, 'fill-opacity': 0.4, stroke: h.color, 'stroke-width': fs * 0.08 }));
    } else {
      const attrs = { cx: h.x, cy: Y(h.y), r, stroke: h.color, 'stroke-width': fs * 0.1 };
      if (h.t === 'B') Object.assign(attrs, { fill: '#fff', 'stroke-dasharray': `${fs * 0.25} ${fs * 0.15}` }); // зі зворотного боку
      else Object.assign(attrs, { fill: h.color, 'fill-opacity': h.th ? 1 : 0.6 });
      g.append(el('circle', attrs));
    }
  }
  // База
  g.append(el('circle', { cx: 0, cy: Lh, r: fs * 0.35, fill: '#e0592a' }));
  g.append(el('text', { x: fs * 0.55, y: Lh - fs * 0.45, fill: '#e0592a', 'font-weight': 800 }, '0'));
  return svg;
}

/** Масштаб і зсув креслення: колесо / два пальці — масштаб, перетягування — зсув. */
function zoomable(svg) {
  const vb0 = svg._vb0;
  let vb = { ...vb0 };
  const apply = () => svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  const toSvg = (cx, cy) => {
    const r = svg.getBoundingClientRect();
    const s = Math.max(vb.w / r.width, vb.h / r.height); // preserveAspectRatio meet
    return { x: vb.x + (cx - r.left - (r.width - vb.w / s) / 2) * s, y: vb.y + (cy - r.top - (r.height - vb.h / s) / 2) * s, s };
  };
  const zoom = (k, cx, cy) => {
    const nw = Math.min(vb0.w * 1.5, Math.max(vb0.w / 25, vb.w / k));
    k = vb.w / nw;
    const p = cx == null ? { x: vb.x + vb.w / 2, y: vb.y + vb.h / 2 } : toSvg(cx, cy);
    vb = { x: p.x - (p.x - vb.x) / k, y: p.y - (p.y - vb.y) / k, w: vb.w / k, h: vb.h / k };
    apply();
  };
  svg.addEventListener('wheel', (e) => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX, e.clientY); }, { passive: false });
  const pts = new Map();
  let last = null;
  svg.addEventListener('pointerdown', (e) => { svg.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); last = null; });
  svg.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      const { s } = toSvg(e.clientX, e.clientY);
      vb.x -= (e.clientX - prev.x) * s; vb.y -= (e.clientY - prev.y) * s; apply();
    } else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (last) zoom(dist / last, (a.x + b.x) / 2, (a.y + b.y) / 2);
      last = dist;
    }
  });
  const up = (e) => { pts.delete(e.pointerId); last = null; };
  svg.addEventListener('pointerup', up);
  svg.addEventListener('pointercancel', up);
  svg.style.touchAction = 'none';
  return { zoomIn: () => zoom(1.4), zoomOut: () => zoom(1 / 1.4), reset: () => { vb = { ...vb0 }; apply(); } };
}

// ---------------- 3D ----------------
/** Контур з відрізків → замкнені контури (найбільший — зовнішній, решта — вирізи всередині). */
function loopsOf(segs) {
  const left = segs.map((s) => [s[0], s[1], s[2], s[3]]);
  const loops = [];
  const near = (a, b) => Math.abs(a[0] - b[0]) < 0.2 && Math.abs(a[1] - b[1]) < 0.2;
  while (left.length) {
    const s = left.shift();
    const loop = [[s[0], s[1]], [s[2], s[3]]];
    let grown = true;
    while (grown && !near(loop[0], loop[loop.length - 1])) {
      grown = false;
      const end = loop[loop.length - 1];
      for (let i = 0; i < left.length; i++) {
        const t = left[i];
        if (near([t[0], t[1]], end)) { loop.push([t[2], t[3]]); left.splice(i, 1); grown = true; break; }
        if (near([t[2], t[3]], end)) { loop.push([t[0], t[1]]); left.splice(i, 1); grown = true; break; }
      }
    }
    if (loop.length > 3 && near(loop[0], loop[loop.length - 1])) loops.push(loop.slice(0, -1));
  }
  const area = (l) => Math.abs(l.reduce((s, p, i) => { const q = l[(i + 1) % l.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
  return loops.sort((a, b) => area(b) - area(a));
}

function textSprite(text, color, size) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = color;
  x.beginPath(); x.arc(64, 64, 56, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#fff'; x.font = 'bold 72px system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(text, 64, 70);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
  s.scale.set(size, size, 1);
  s.renderOrder = 10;
  return s;
}

/**
 * 3D-вигляд деталі: напівпрозора плита, отвори кольорами груп на справжню глибину. Пласть А дивиться на нас (+Z),
 * пласть Б — назад (z = −T). Повертає { dispose }.
 */
function drill3d(host, panel, groups, only) {
  const W = panel.w, Lh = panel.l, T = panel.t || 18;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 1, 100000);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(1, 1.5, 2);
  scene.add(sun);

  // Плита
  const loops = loopsOf(panel.c || []);
  const shape = new THREE.Shape((loops[0] || [[0, 0], [W, 0], [W, Lh], [0, Lh]]).map((p) => new THREE.Vector2(p[0], p[1])));
  for (const l of loops.slice(1)) shape.holes.push(new THREE.Path(l.map((p) => new THREE.Vector2(p[0], p[1]))));
  const slab = new THREE.ExtrudeGeometry(shape, { depth: T, bevelEnabled: false, curveSegments: 24 }).translate(0, 0, -T);
  const board = new THREE.Mesh(slab, new THREE.MeshStandardMaterial({ color: 0xeee4cf, roughness: 0.8, transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide }));
  board.renderOrder = 2;
  scene.add(board);
  scene.add(new THREE.LineSegments(new THREE.EdgesGeometry(slab, 20), new THREE.LineBasicMaterial({ color: 0x3a3a3a })));

  // Отвори (дрібні — не менше ~1/90 деталі, щоб їх було видно на великій плиті; глибина — справжня)
  const up = new THREE.Vector3(0, 1, 0);
  const minR = Math.max(W, Lh) / 180;
  for (const gr of groups) {
    const active = !only || gr.key === only;
    const mat = new THREE.MeshStandardMaterial({ color: active ? gr.color : '#b9bcc0', roughness: 0.5, transparent: !active, opacity: active ? 1 : 0.35 });
    for (const h of gr.items) {
      const len = h.th ? T : Math.max(0.5, h.h || 10);
      const r = Math.max(h.d / 2, minR);
      const geo = new THREE.CylinderGeometry(r, r, len + 0.4, 20);
      const m = new THREE.Mesh(geo, mat);
      if (h.t === 'A' || h.t === 'B') {
        m.quaternion.setFromUnitVectors(up, new THREE.Vector3(0, 0, 1));
        const zc = h.th ? -T / 2 : h.t === 'A' ? -len / 2 + 0.2 : -T + len / 2 - 0.2;
        m.position.set(h.x, h.y, zc);
      } else {
        const z = -(h.z ?? T / 2);
        if (h.e === 'L') { m.quaternion.setFromUnitVectors(up, new THREE.Vector3(1, 0, 0)); m.position.set(h.x + len / 2 - 0.2, h.y, z); }
        else if (h.e === 'R') { m.quaternion.setFromUnitVectors(up, new THREE.Vector3(1, 0, 0)); m.position.set(h.x - len / 2 + 0.2, h.y, z); }
        else if (h.e === 'D') { m.position.set(h.x, h.y + len / 2 - 0.2, z); }
        else { m.position.set(h.x, h.y - len / 2 + 0.2, z); }
      }
      m.renderOrder = 1;
      scene.add(m);
    }
  }
  // Позначки: база «0», пласті А і Б
  const big = Math.max(W, Lh);
  const tag = big / 16;
  const zero = textSprite('0', '#e0592a', tag * 0.8); zero.position.set(0, 0, 0); scene.add(zero);
  // «А» — на пласті А ближче до верхнього лівого кута, «Б» — на пласті Б ближче до нижнього правого (не налазять)
  const a = textSprite('А', '#2b2b2b', tag); a.position.set(W * 0.3, Lh * 0.7, tag * 0.4); scene.add(a);
  const b = textSprite('Б', '#8a8f96', tag); b.position.set(W * 0.7, Lh * 0.3, -T - tag * 0.4); scene.add(b);

  // Камера: збоку й згори, щоб одразу було видно товщину і торці
  const center = new THREE.Vector3(W / 2, Lh / 2, -T / 2);
  // Відстань — щоб уся деталь влізла в кадр (сфера навколо габариту, з запасом)
  const radius = 0.5 * Math.hypot(W, Lh, T);
  const dist = (radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 0.82;
  const view0 = new THREE.Vector3(0.55, 0.3, 1).normalize().multiplyScalar(dist);
  camera.position.copy(center).add(view0);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(center);
  controls.enableDamping = true;
  controls.update();
  renderer.domElement.className = 'drill-3d';
  host.replaceChildren(renderer.domElement);

  let raf = 0;
  const loop = () => {
    if (!renderer.domElement.isConnected) { dispose(); return; }
    const w = host.clientWidth, h2 = host.clientHeight;
    if (w && h2 && (renderer.domElement.width !== Math.round(w * renderer.getPixelRatio()) || renderer.domElement.height !== Math.round(h2 * renderer.getPixelRatio()))) {
      renderer.setSize(w, h2, false);
      camera.aspect = w / h2;
      camera.updateProjectionMatrix();
    }
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  };
  const dispose = () => {
    cancelAnimationFrame(raf);
    controls.dispose();
    scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
    renderer.dispose();
  };
  raf = requestAnimationFrame(loop);
  return {
    dispose,
    reset: () => { camera.position.copy(center).add(view0); controls.target.copy(center); },
    flip: () => { // глянути з пласті Б
      const off = camera.position.clone().sub(controls.target);
      off.z = -off.z; off.x = -off.x;
      camera.position.copy(controls.target).add(off);
    },
  };
}

// ---------------- Вікно ----------------
const seg = (items, value, onPick) => {
  const box = document.createElement('div');
  box.className = 'drill-seg';
  for (const [v, label] of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (v === value) b.classList.add('on');
    b.addEventListener('click', () => onPick(v));
    box.append(b);
  }
  return box;
};
const tool = (label, title, fn) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'drill-tool';
  b.textContent = label;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', fn);
  return b;
};

/** Вікно «Присадка» для деталі. */
export function showDrill(panel) {
  const groups = groupsOf(panel);
  let only = null;
  let view = '2d';
  let mode = 'base';
  let v3 = null;
  const wrap = document.createElement('div');
  wrap.className = 'drill';
  const head = document.createElement('div');
  head.className = 'drill-head';
  head.textContent = `${fmt(panel.l)} × ${fmt(panel.w)} × ${fmt(panel.t)} мм${panel.mat ? ' · ' + panel.mat : ''}`;
  const bar = document.createElement('div');
  bar.className = 'drill-bar';
  const pic = document.createElement('div');
  pic.className = 'drill-pic';
  const legend = document.createElement('div');
  legend.className = 'drill-hint';
  const list = document.createElement('div');
  list.className = 'drill-list';

  const renderView = () => {
    if (v3) { v3.dispose(); v3 = null; }
    if (view === '3d') {
      pic.classList.add('is-3d');
      v3 = drill3d(pic, panel, groups, only);
      legend.textContent = 'Крутіть деталь пальцем, двома — збільшити. «А» — пласть А, «Б» — пласть Б, «0» — база. Сірі — інші групи.';
      bar.replaceChildren(
        seg([['2d', 'Креслення'], ['3d', '3D']], view, (v) => { view = v; renderView(); }),
        tool('А/Б', 'Перевернути', () => v3 && v3.flip()),
        tool('⟲', 'Скинути вид', () => v3 && v3.reset()),
      );
    } else {
      pic.classList.remove('is-3d');
      const svg = drawing(panel, groups, only, mode);
      pic.replaceChildren(svg);
      const z = zoomable(svg);
      legend.textContent = 'Вид з пласті А. Суцільні — пласть А, пунктир — пласть Б, смужки — торець. «0» — база. Двома пальцями — збільшити.';
      bar.replaceChildren(
        seg([['2d', 'Креслення'], ['3d', '3D']], view, (v) => { view = v; renderView(); }),
        seg([['base', 'Від бази'], ['chain', 'Ланцюжком']], mode, (v) => { mode = v; renderView(); }),
        tool('+', 'Збільшити', z.zoomIn),
        tool('−', 'Зменшити', z.zoomOut),
        tool('⟲', 'Скинути масштаб', z.reset),
      );
    }
  };

  const renderList = () => {
    list.replaceChildren(...groups.map((g) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'drill-row' + (only === g.key ? ' active' : '');
      const where = g.t === 'E' ? `${SIDE.E} ${EDGE[g.e] || ''}` : SIDE[g.t];
      row.innerHTML = `<span class="dot" style="background:${g.color}"></span><b>${holeTitle(g)}</b>`
        + `<span class="tag">${g.th ? 'наскрізн. · ' : ''}${where}</span><span class="nm"></span><span class="cnt">${g.items.length}</span>`;
      row.querySelector('.nm').textContent = g.n.replace(/\s+(Muller|Hettich|Blum|MULLER)\b.*$/i, '');
      row.addEventListener('click', () => { only = only === g.key ? null : g.key; renderList(); renderView(); });
      const out = [row];
      if (only === g.key) {
        const coords = document.createElement('div');
        coords.className = 'drill-coords';
        coords.replaceChildren(...g.items.map((h, i) => {
          const c = document.createElement('div');
          const pos = h.t === 'E'
            ? (h.e === 'L' || h.e === 'R' ? `Y ${fmt(h.y)}` : `X ${fmt(h.x)}`) + `  Z ${fmt(h.z)}`
            : `X ${fmt(h.x)}  Y ${fmt(h.y)}`;
          c.innerHTML = `<span>${i + 1}</span><span>${pos}</span>`;
          return c;
        }));
        out.push(coords);
      }
      return out;
    }).flat());
    if (!groups.length) list.textContent = 'Отворів у цій деталі немає.';
  };

  wrap.append(head, bar, pic, legend, list);
  openSheet(`Присадка · ${panel.name || 'деталь'}`, wrap);
  renderView();
  renderList();
}
