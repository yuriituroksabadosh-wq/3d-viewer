import * as THREE from 'three';

// Меню в шапці, список деталей, лінійка (замір) та інструкція.

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  el.append(...children);
  return el;
}

// ---------- Аркуш (модальне вікно знизу на телефоні, по центру на ПК) ----------
export function openSheet(title, body) {
  const close = () => wrap.remove();
  const wrap = h('div', { class: 'sheet-wrap', onclick: (e) => { if (e.target === wrap) close(); } },
    h('div', { class: 'sheet', role: 'dialog', 'aria-label': title },
      h('div', { class: 'sheet-head' },
        h('strong', {}, title),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Закрити', onclick: close }, '✕'),
      ),
      body,
    ),
  );
  document.body.append(wrap);
  return close;
}

// ---------- Меню ----------
/** items: [{ label, icon, onClick }] */
export function createMenu(button, items) {
  let menu = null;
  const close = () => { if (menu) { menu.remove(); menu = null; } };
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu) { close(); return; }
    menu = h('div', { class: 'menu', role: 'menu' },
      ...items.filter(Boolean).map((it) => h('button', {
        class: 'menu-item', type: 'button', role: 'menuitem',
        onclick: () => { close(); it.onClick(); },
      }, h('span', { class: 'menu-icon' }, it.icon || ''), it.label)),
    );
    document.body.append(menu);
    const r = button.getBoundingClientRect();
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  });
  document.addEventListener('click', (e) => { if (menu && !menu.contains(e.target)) close(); });
}

// ---------- Список деталей ----------
/** parts — деталі моделі; describe(part) — опис; onPick(part) — вибір у сцені. */
export function showPartsList(parts, describe, onPick) {
  const visible = parts.filter((p) => p.key !== 'room');
  const groups = new Map();
  for (const p of visible) {
    const g = p.group?.name || 'Інше';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }

  const search = h('input', { class: 'search', type: 'search', placeholder: 'Пошук за назвою або артикулом…', 'aria-label': 'Пошук деталі' });
  const list = h('div', { class: 'parts-list' });
  const count = h('div', { class: 'hint' });

  function render() {
    const q = search.value.trim().toLowerCase();
    list.replaceChildren();
    let shown = 0;
    for (const [name, items] of groups) {
      const match = items.filter((p) => !q || `${p.name.title} ${p.name.article} ${name}`.toLowerCase().includes(q));
      if (!match.length) continue;
      // Однакові деталі (шканти, конфірмати) згортаємо в один рядок з кількістю
      const same = new Map();
      for (const p of match) {
        const d = describe(p);
        const key = `${d.title}|${d.dims}`;
        if (!same.has(key)) same.set(key, { part: p, d, n: 0 });
        same.get(key).n++;
      }
      list.append(h('div', { class: 'parts-group' }, `${name} · ${match.length}`));
      for (const { part, d, n } of same.values()) {
        shown += n;
        list.append(h('button', { class: 'parts-item', type: 'button', onclick: () => { close(); onPick(part); } },
          h('span', { class: 'parts-name' }, n > 1 ? `${d.title} × ${n}` : d.title),
          h('span', { class: 'hint' }, d.dims.replace(/ мм.*/, ' мм')),
        ));
      }
    }
    count.textContent = `Деталей: ${shown}`;
  }
  search.addEventListener('input', render);
  render();
  const close = openSheet('Список деталей', h('div', {}, search, count, list));
  setTimeout(() => search.focus(), 50);
}

// ---------- Лінійка ----------
/**
 * Замір між двома точками з прилипанням до кутів і ребер деталей та лупою.
 * Палець: тримаєте й наводите — над пальцем лупа з перехрестям; відпускаєте — точка ставиться.
 * Миша: наводите — маркер і лупа; натискаєте — точка ставиться.
 * Поки лінійка увімкнена, обертання моделі вимкнене (щоб наведення не збивалось).
 */
export function createRuler({ scene, camera, canvas, layer, controls, getMeshes }) {
  const raycaster = new THREE.Raycaster();
  const group = new THREE.Group();
  group.renderOrder = 10;
  scene.add(group);
  const dotMat = new THREE.MeshBasicMaterial({ color: 0xd9480f, depthTest: false });
  const lineMat = new THREE.LineBasicMaterial({ color: 0xd9480f, depthTest: false });

  const label = h('div', { class: 'ruler-label' });
  label.hidden = true;
  const marker = h('div', { class: 'snap-marker' });
  marker.hidden = true;
  const loupeCanvas = h('canvas', { width: '280', height: '280' });
  const loupe = h('div', { class: 'loupe' }, loupeCanvas, h('div', { class: 'loupe-cross' }));
  loupe.hidden = true;
  layer.append(label, marker, loupe);

  // Окремий маленький рендер для лупи: та сама сцена, вузький кут огляду → збільшення ×5
  const loupeRenderer = new THREE.WebGLRenderer({ canvas: loupeCanvas, antialias: true });
  loupeRenderer.setPixelRatio(1);
  loupeRenderer.setSize(280, 280, false);
  loupeRenderer.toneMapping = THREE.NeutralToneMapping;
  const loupeCam = new THREE.PerspectiveCamera(10, 1, 1, 200000);

  let active = false;
  let points = [];
  let aim = null;        // поточна точка наведення { point, kind, sx, sy }
  let pressId = null;    // палець/кнопка, яким зараз наводять

  const isShown = (o) => { for (let x = o; x; x = x.parent) if (!x.visible) return false; return true; };
  const toScreen = (v, r) => {
    const p = v.clone().project(camera);
    return { x: ((p.x + 1) / 2) * r.width, y: ((1 - p.y) / 2) * r.height, z: p.z };
  };

  /** Точка під курсором: кут (vertex) → ребро (edge) → поверхня. touch — більші допуски. */
  function snapAt(clientX, clientY, touch) {
    const r = canvas.getBoundingClientRect();
    const mx = clientX - r.left;
    const my = clientY - r.top;
    const ndc = new THREE.Vector2((mx / r.width) * 2 - 1, -(my / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(getMeshes(), false).find((x) => isShown(x.object));
    if (!hit) return null;

    const VERTEX_PX = touch ? 28 : 16;
    const EDGE_PX = touch ? 18 : 10;
    let best = { point: hit.point.clone(), kind: 'surface', d: Infinity };
    let bestEdge = null;

    const lines = hit.object.children.find((c) => c.isLineSegments);
    if (lines) {
      const pos = lines.geometry.attributes.position;
      const m = hit.object.matrixWorld;
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      for (let i = 0; i + 1 < pos.count; i += 2) {
        a.fromBufferAttribute(pos, i).applyMatrix4(m);
        b.fromBufferAttribute(pos, i + 1).applyMatrix4(m);
        const sa = toScreen(a, r);
        const sb = toScreen(b, r);
        if (sa.z > 1 || sb.z > 1) continue;
        // кути
        for (const [s, w] of [[sa, a], [sb, b]]) {
          const d = Math.hypot(s.x - mx, s.y - my);
          if (d < VERTEX_PX && (best.kind !== 'vertex' || d < best.d)) best = { point: w.clone(), kind: 'vertex', d };
        }
        // ребра (найближча точка відрізка на екрані → та сама частка в просторі)
        const vx = sb.x - sa.x;
        const vy = sb.y - sa.y;
        const len2 = vx * vx + vy * vy;
        if (len2 < 1) continue;
        const t = Math.min(1, Math.max(0, ((mx - sa.x) * vx + (my - sa.y) * vy) / len2));
        const d = Math.hypot(sa.x + vx * t - mx, sa.y + vy * t - my);
        if (d < EDGE_PX && (!bestEdge || d < bestEdge.d)) bestEdge = { point: a.clone().lerp(b, t), kind: 'edge', d };
      }
    }
    if (best.kind !== 'vertex' && bestEdge) best = bestEdge;
    const s = toScreen(best.point, r);
    return { point: best.point, kind: best.kind, sx: s.x, sy: s.y };
  }

  function showAim(clientX, clientY, touch) {
    aim = snapAt(clientX, clientY, touch);
    if (!aim) { marker.hidden = true; loupe.hidden = true; return; }
    marker.hidden = false;
    marker.className = `snap-marker ${aim.kind}`;
    marker.style.left = `${aim.sx}px`;
    marker.style.top = `${aim.sy}px`;

    // Лупа: над пальцем (щоб він не закривав), для миші — поруч із курсором
    const r = canvas.getBoundingClientRect();
    loupe.hidden = false;
    loupe.className = `loupe ${aim.kind}`;
    const size = 140;
    let lx = aim.sx - size / 2;
    let ly = aim.sy - size - (touch ? 70 : 30);
    if (ly < 4) ly = aim.sy + (touch ? 70 : 30);
    lx = Math.max(4, Math.min(r.width - size - 4, lx));
    loupe.style.left = `${lx}px`;
    loupe.style.top = `${ly}px`;
    loupeCam.position.copy(camera.position);
    loupeCam.up.copy(camera.up);
    loupeCam.fov = camera.fov / 5;
    loupeCam.near = camera.near;
    loupeCam.far = camera.far;
    loupeCam.lookAt(aim.point);
    loupeCam.updateProjectionMatrix();
    loupeRenderer.render(scene, loupeCam);
  }

  function hideAim() {
    marker.hidden = true;
    loupe.hidden = true;
  }

  function clear() {
    points = [];
    group.clear();
    label.hidden = true;
  }

  function place(p) {
    if (points.length === 2) clear();
    points.push(p.clone());
    const size = Math.max(3, camera.position.distanceTo(p) / 300);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(size, 14, 10), dotMat);
    dot.position.copy(p);
    dot.renderOrder = 10;
    group.add(dot);
    if (points.length === 2) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), lineMat);
      line.renderOrder = 10;
      group.add(line);
      const [a, b] = points;
      label.innerHTML = `<b>${Math.round(a.distanceTo(b))} мм</b><span>Ш ${Math.round(Math.abs(a.x - b.x))} · В ${Math.round(Math.abs(a.y - b.y))} · Г ${Math.round(Math.abs(a.z - b.z))}</span>`;
      label.hidden = false;
    }
  }

  // Події лінійки — у фазі захоплення, щоб вони не доходили до обертання й вибору деталі
  canvas.addEventListener('pointerdown', (e) => {
    if (!active) return;
    e.preventDefault();
    e.stopPropagation();
    pressId = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ок */ }
    showAim(e.clientX, e.clientY, e.pointerType !== 'mouse');
  }, true);
  canvas.addEventListener('pointermove', (e) => {
    if (!active) return;
    if (pressId === e.pointerId || e.pointerType === 'mouse') showAim(e.clientX, e.clientY, e.pointerType !== 'mouse');
  }, true);
  canvas.addEventListener('pointerup', (e) => {
    if (!active || e.pointerId !== pressId) return;
    e.stopPropagation();
    pressId = null;
    if (aim) place(aim.point);
    if (e.pointerType !== 'mouse') hideAim();
  }, true);
  canvas.addEventListener('pointerleave', () => { if (active && pressId === null) hideAim(); });

  return {
    get active() { return active; },
    setActive(on) {
      active = on;
      controls.enabled = !on;
      canvas.style.cursor = on ? 'crosshair' : '';
      if (!on) { clear(); hideAim(); }
    },
    /** Щокадру: підпис тримається посередині лінії. */
    update(width, height) {
      if (label.hidden || points.length < 2) return;
      const mid = points[0].clone().add(points[1]).multiplyScalar(0.5).project(camera);
      label.style.left = `${((mid.x + 1) / 2) * width}px`;
      label.style.top = `${((1 - mid.y) / 2) * height}px`;
    },
  };
}

// ---------- Інструкція ----------
export function showHelp() {
  const item = (title, text) => h('div', { class: 'help-item' }, h('strong', {}, title), h('div', { class: 'hint' }, text));
  openSheet('Інструкція', h('div', { class: 'help' },
    item('Обертання', 'Ведіть пальцем або мишею по моделі.'),
    item('Наближення', 'Розведіть два пальці або крутіть коліщатко миші.'),
    item('Зсув', 'Ведіть двома пальцями вгору, вниз, ліворуч чи праворуч; на комп’ютері — права кнопка миші.'),
    item('Деталь', 'Натисніть на деталь — унизу з’являться її назва, розміри й матеріал.'),
    item('Вибір блоком', 'Кнопка з чотирма квадратами: натискання виділяє весь блок (шафу, тумбу).'),
    item('Ізолювати й наблизити', 'Кнопки у вікні деталі: показати лише її блок або підлетіти до неї.'),
    item('Сховати виділене', 'Кнопка з перекресленим оком. Коли нічого не вибрано, вона показує все назад.'),
    item('Анімація', 'Кнопка «▶» відчиняє двері й висуває шухляди, ще раз — зачиняє.'),
    item('Сканування', 'Кнопка з рамкою: у Telegram відкриває сканер QR-коду деталі, у браузері — пошук за текстом.'),
    item('Лінійка', 'Кнопка «Лінійка» на панелі: тримайте палець і наводьте — точка прилипає до кутів (зелений) і ребер (синій), над пальцем лупа; відпустіть, щоб поставити. Дві точки — відстань у мм.'),
    item('Розібрати', 'Кнопка «Розібрати» на панелі: монтажна схема, ще раз — зібрати.'),
    item('Кубик у куті', 'Натисніть на грань кубика — вид повернеться до цієї сторони.'),
    item('Режими', '«Текстури з лініями», «Текстури», «Контури» (як креслення) і «Рентген» (видно кріплення).'),
  ));
}
