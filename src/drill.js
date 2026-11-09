// Присадка (лише для менеджера): креслення деталі з отворами й розмірами від бази + список отворів.
// Дані: data/<назва>.drill.bin — зашифровано (tools/convert-dae.mjs). Ключ видає воркер лише менеджеру
// (перевіряє підписані Telegram дані), тож у клієнта немає ні кнопки, ні можливості розшифрувати файл.

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

const NS = 'http://www.w3.org/2000/svg';
function el(tag, attrs, text) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

/** Креслення деталі (вид з пласті А): контур, отвори, розміри від бази (лівий нижній кут). */
function drawing(panel, groups, only) {
  const W = panel.w, Lh = panel.l;
  const fs = Math.max(W, Lh) / 26; // розмір шрифту в мм креслення
  const gap = fs * 0.6;
  const shown = groups.filter((g) => !only || g.key === only);
  const holes = shown.flatMap((g) => g.items.map((h) => ({ ...h, color: g.color })));
  // Розміри: унікальні X (зверху) і Y (зліва) отворів
  // (торцеві отвори на лівому/правому торці мають лише Y, на нижньому/верхньому — лише X)
  const uniq = (a) => [...new Set(a.map(fmt))].map(Number).sort((p, q) => p - q);
  const xs = uniq(holes.filter((h) => !(h.t === 'E' && (h.e === 'L' || h.e === 'R'))).map((h) => h.x));
  const ys = uniq(holes.filter((h) => !(h.t === 'E' && (h.e === 'D' || h.e === 'U'))).map((h) => h.y));
  const top = fs * 4.2, left = fs * 4.2, right = fs * 2, bottom = fs * 2.6;
  const svg = el('svg', {
    viewBox: `${-left} ${-top} ${W + left + right} ${Lh + top + bottom}`,
    class: 'drill-svg', preserveAspectRatio: 'xMidYMid meet',
  });
  const Y = (y) => Lh - y; // у кресленні Y угору
  const g = el('g', { 'font-size': fs, 'font-family': 'system-ui, sans-serif' });
  svg.append(g);
  // Контур
  const d = (panel.c || []).map((s) => `M${s[0]},${Y(s[1])}L${s[2]},${Y(s[3])}`).join('');
  g.append(el('path', { d, fill: '#f4f1ea', stroke: '#2b2b2b', 'stroke-width': fs * 0.12, 'stroke-linejoin': 'round' }));
  // Габарит
  g.append(el('text', { x: W / 2, y: Lh + fs * 2.1, 'text-anchor': 'middle', fill: '#a8834c', 'font-weight': 700 }, fmt(W)));
  g.append(el('text', { x: -fs * 3.4, y: Lh / 2, 'text-anchor': 'middle', fill: '#a8834c', 'font-weight': 700, transform: `rotate(-90 ${-fs * 3.4} ${Lh / 2})` }, fmt(Lh)));
  // Розміри від бази: зверху — X, зліва — Y
  const lead = { stroke: '#9aa0a6', 'stroke-width': fs * 0.05 };
  for (const x of xs) {
    g.append(el('line', { x1: x, y1: -gap * 0.5, x2: x, y2: -gap, ...lead }));
    g.append(el('text', { x, y: -gap * 1.3, 'text-anchor': 'start', 'dominant-baseline': 'middle', fill: '#444', transform: `rotate(-90 ${x} ${-gap * 1.3})` }, fmt(x)));
  }
  for (const y of ys) {
    g.append(el('line', { x1: -gap * 0.5, y1: Y(y), x2: -gap, y2: Y(y), ...lead }));
    g.append(el('text', { x: -gap * 1.3, y: Y(y), 'text-anchor': 'end', 'dominant-baseline': 'middle', fill: '#444' }, fmt(y)));
  }
  // Отвори
  const minR = fs * 0.28;
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
      g.append(el('rect', { x, y: Y(y + h2), width: w2, height: h2, fill: h.color, 'fill-opacity': 0.35, stroke: h.color, 'stroke-width': fs * 0.08, 'stroke-dasharray': `${fs * 0.3} ${fs * 0.2}` }));
    } else {
      const attrs = { cx: h.x, cy: Y(h.y), r, stroke: h.color, 'stroke-width': fs * 0.1 };
      if (h.t === 'B') Object.assign(attrs, { fill: '#fff', 'stroke-dasharray': `${fs * 0.25} ${fs * 0.15}` }); // зі зворотного боку
      else Object.assign(attrs, { fill: h.color, 'fill-opacity': h.th ? 1 : 0.55 });
      g.append(el('circle', attrs));
    }
  }
  // База
  g.append(el('circle', { cx: 0, cy: Lh, r: fs * 0.35, fill: '#e0592a' }));
  g.append(el('text', { x: fs * 0.6, y: Lh - fs * 0.5, fill: '#e0592a', 'font-weight': 700 }, '0'));
  return svg;
}

/** Вікно «Присадка» для деталі. */
export function showDrill(panel) {
  const groups = groupsOf(panel);
  let only = null;
  const wrap = document.createElement('div');
  wrap.className = 'drill';
  const head = document.createElement('div');
  head.className = 'drill-head';
  head.textContent = `${fmt(panel.l)} × ${fmt(panel.w)} × ${fmt(panel.t)} мм${panel.mat ? ' · ' + panel.mat : ''}`;
  const pic = document.createElement('div');
  pic.className = 'drill-pic';
  const legend = document.createElement('div');
  legend.className = 'drill-hint';
  legend.textContent = 'Вид з пласті А. Суцільні — пласть А, пунктир — пласть Б, смужки — торець. «0» — база.';
  const list = document.createElement('div');
  list.className = 'drill-list';

  const render = () => {
    pic.replaceChildren(drawing(panel, groups, only));
    list.replaceChildren(...groups.map((g) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'drill-row' + (only === g.key ? ' active' : '');
      const where = g.t === 'E' ? `${SIDE.E} ${EDGE[g.e] || ''}` : SIDE[g.t];
      row.innerHTML = `<span class="dot" style="background:${g.color}"></span><b>${holeTitle(g)}</b>`
        + `<span class="tag">${g.th ? 'наскрізн. · ' : ''}${where}</span><span class="nm"></span><span class="cnt">${g.items.length}</span>`;
      row.querySelector('.nm').textContent = g.n.replace(/\s+(Muller|Hettich|Blum|MULLER)\b.*$/i, '');
      row.addEventListener('click', () => { only = only === g.key ? null : g.key; render(); });
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
  render();
  wrap.append(head, pic, legend, list);
  openSheet(`Присадка · ${panel.name || 'деталь'}`, wrap);
}
