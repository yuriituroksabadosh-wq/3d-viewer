// Виробництво (лише для менеджера, дані — ті самі, що й присадка): деталі по блоках —
// назва, матеріал, розмір (готовий або розкрій), крайка по сторонах, пази, кількість. Тап на рядок — креслення деталі.

import { openSheet } from './extras.js';
import { edgesOf, cutsOf, showDrill } from './drill.js';
import { makeBlockPdf, sheetBlocks } from './block-sheet.js';
import { NOTIFY_URL } from './notify.js';

const fmt = (n) => (Math.round(n * 10) / 10).toString();

/** Блок деталі: перший рівень під моделлю (МН_1, МВ_5, Пенал_2…). */
const blockOf = (p) => {
  const path = (p.path || []).filter((x) => x && x !== 'Модель');
  return path[0] || 'Без блоку';
};

/** Розміри деталі: довжина (Y) × ширина (X) × товщина; розкрій — мінус крайка з обох боків. */
function sizeOf(p, cut) {
  let L = p.l, W = p.w;
  if (cut) {
    const s = edgesOf(p).sides;
    L -= s.D + s.U;
    W -= s.L + s.R;
  }
  return `${fmt(L)} × ${fmt(W)} × ${fmt(p.t)}`;
}
const edgeText = (p) => {
  const s = edgesOf(p).sides;
  const v = (x) => (x ? fmt(x) : '—');
  return s.L || s.R || s.D || s.U ? `${v(s.L)} ${v(s.R)} | ${v(s.D)} ${v(s.U)}` : '—';
};
const cutText = (p) => {
  const m = new Map();
  for (const c of cutsOf(p)) {
    const k = `${c.name} ${fmt(c.width)}×${fmt(c.depth)}${c.inside ? '' : ' ⚠'}`;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(', ');
};

/** panels — дані присадки моделі. */
export function showProduction(panels, ctx) {
  // Без кімнати: стіни, підлога (товсті «плити»)
  const list = panels.filter((p) => p.t > 0 && p.t <= 60);
  const blocks = new Map();
  for (const p of list) {
    const b = blockOf(p);
    if (!blocks.has(b)) blocks.set(b, []);
    blocks.get(b).push(p);
  }
  const names = [...blocks.keys()].sort((a, b) => a.localeCompare(b, 'uk', { numeric: true }));
  let cutMode = false;
  const open = new Set();

  const wrap = document.createElement('div');
  wrap.className = 'prod';
  const bar = document.createElement('div');
  bar.className = 'drill-bar';
  const body = document.createElement('div');

  // Однакові деталі в блоці — одним рядком з кількістю
  const rowsOf = (ps) => {
    const m = new Map();
    for (const p of ps) {
      const k = [p.name, p.mat, fmt(p.l), fmt(p.w), fmt(p.t), edgeText(p), cutText(p)].join('|');
      if (!m.has(k)) m.set(k, { p, n: 0 });
      m.get(k).n++;
    }
    return [...m.values()];
  };

  const table = (ps) => {
    const t = document.createElement('table');
    t.className = 'prod-table';
    t.innerHTML = `<thead><tr><th>Деталь</th><th>${cutMode ? 'Розкрій' : 'Готовий'}, мм<br><small>Д × Ш × Т</small></th><th>Крайка<br><small>Д1 Д2 | Ш1 Ш2</small></th><th>К-сть</th></tr></thead>`;
    const tb = document.createElement('tbody');
    for (const { p, n } of rowsOf(ps)) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td><b></b><div class="mat"></div><div class="cut"></div></td><td class="num"></td><td class="num"></td><td class="num"></td>';
      tr.querySelector('b').textContent = p.name || 'Деталь';
      tr.querySelector('.mat').textContent = p.mat || '';
      tr.querySelector('.cut').textContent = cutText(p);
      const td = tr.querySelectorAll('td.num');
      td[0].textContent = sizeOf(p, cutMode);
      td[1].textContent = edgeText(p);
      td[2].textContent = n;
      tr.addEventListener('click', () => showDrill(p));
      tb.append(tr);
    }
    t.append(tb);
    return t;
  };

  const render = () => {
    bar.replaceChildren(
      seg([[false, 'Готовий розмір'], [true, 'Розкрій']], cutMode, (v) => { cutMode = v; render(); }),
      btn('Друк', () => printAll()),
      ...(ctx ? [btn('Аркуші блоків PDF', (e) => pdf(sheetBlocks(ctx.model, panels), e.currentTarget))] : []),
    );
    body.replaceChildren(...names.flatMap((b) => {
      const ps = blocks.get(b);
      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'parts-group' + (open.has(b) ? ' open' : '');
      head.innerHTML = '<span class="parts-caret">›</span><span class="parts-gname"></span><span class="parts-count"></span>';
      head.querySelector('.parts-gname').textContent = b;
      head.querySelector('.parts-count').textContent = ps.length;
      head.addEventListener('click', () => { if (open.has(b)) open.delete(b); else open.add(b); render(); });
      if (!open.has(b)) return [head];
      const can = ctx && sheetBlocks(ctx.model, panels).includes(b);
      return can ? [head, btn('PDF блоку', (e) => pdf([b], e.currentTarget)), table(ps)] : [head, table(ps)];
    }));
  };

  // Друк: усі блоки розгорнуті, лише таблиці (креслення деталей — з вікна деталі)
  const printAll = () => {
    const sheet = document.createElement('div');
    sheet.className = 'prod-print';
    const h1 = document.createElement('h1');
    h1.textContent = document.title;
    sheet.append(h1);
    for (const b of names) {
      const h2 = document.createElement('h2');
      h2.textContent = b;
      sheet.append(h2, table(blocks.get(b)));
    }
    document.body.append(sheet);
    document.body.classList.add('printing');
    const done = () => { sheet.remove(); document.body.classList.remove('printing'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();

  };

  // PDF аркушів: штамп, 4 види, матеріали, фурнітура
  let busy = false;
  const pdf = async (names, b) => {
    if (busy || !names.length) return;
    busy = true;
    const label = b.textContent;
    try {
      const blob = await makeBlockPdf({ ...ctx, panels, names, onStep: (i, n) => { b.textContent = `Аркуш ${i + 1} з ${n}…`; } });
      const fileName = `Аркуші — ${names.length === 1 ? names[0] : [panels.info?.name, (panels.info?.prefix || '').trim()].filter(Boolean).join(' ') || 'виріб'}.pdf`;
      const tg = window.Telegram?.WebApp;
      if (tg?.initData) {
        // У Telegram завантаження з сайту не працює — бот надсилає PDF у чат менеджеру
        b.textContent = 'Надсилаю в чат…';
        const head = new TextEncoder().encode(JSON.stringify({ initData: tg.initData, name: fileName }) + '\n');
        const r = await fetch(`${NOTIFY_URL}/sheetpdf`, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: new Blob([head, blob]) })
          .then((x) => x.json()).catch(() => null);
        const msg = r?.ok ? 'PDF надіслано в чат бота.' : 'Не вдалося надіслати PDF у чат.';
        if (tg.showAlert) tg.showAlert(msg); else alert(msg);
        return;
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fileName;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    } catch (err) {
      console.error('Аркуші:', err);
      const msg = 'Не вдалося зробити PDF: ' + (err.message || err);
      if (window.Telegram?.WebApp?.showAlert) window.Telegram.WebApp.showAlert(msg); else alert(msg);
    } finally { busy = false; b.textContent = label; }
  };

  const hint = document.createElement('div');
  hint.className = 'drill-hint';
  hint.textContent = 'Тапніть деталь — креслення з крайкою, пазами, перерізами й отворами. Крайка: Д — по довжині, Ш — по ширині.';
  wrap.append(bar, hint, body);
  openSheet(`Виробництво · ${list.length} дет.`, wrap);
  render();
}

function seg(items, value, onPick) {
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
}
function btn(label, fn) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'drill-tool prod-print-btn';
  b.textContent = label;
  b.addEventListener('click', fn);
  return b;
}
