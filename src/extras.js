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
 * Замір між двома точками на поверхнях моделі.
 * Перше натискання — початок, друге — кінець; третє починає новий замір.
 */
export function createRuler(scene, camera, canvas, labelsLayer, getMeshes) {
  const raycaster = new THREE.Raycaster();
  const group = new THREE.Group();
  group.renderOrder = 10;
  scene.add(group);
  const dotMat = new THREE.MeshBasicMaterial({ color: 0xd9480f, depthTest: false });
  const lineMat = new THREE.LineBasicMaterial({ color: 0xd9480f, depthTest: false });
  const label = h('div', { class: 'ruler-label' });
  label.hidden = true;
  labelsLayer.append(label);

  let active = false;
  let points = [];

  function clear() {
    points = [];
    group.clear();
    label.hidden = true;
  }

  function addDot(p, size) {
    const dot = new THREE.Mesh(new THREE.SphereGeometry(size, 12, 8), dotMat);
    dot.position.copy(p);
    dot.renderOrder = 10;
    group.add(dot);
  }

  function hitPoint(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(getMeshes(), false).find((x) => {
      for (let o = x.object; o; o = o.parent) if (!o.visible) return false;
      return true;
    });
    return hit ? hit.point.clone() : null;
  }

  return {
    get active() { return active; },
    setActive(on) { active = on; if (!on) clear(); },
    /** Повертає true, якщо натискання «з'їла» лінійка (тоді вибір деталі не робимо). */
    click(clientX, clientY) {
      if (!active) return false;
      const p = hitPoint(clientX, clientY);
      if (!p) return true;
      if (points.length === 2) clear();
      points.push(p);
      const size = Math.max(4, camera.position.distanceTo(p) / 250);
      addDot(p, size);
      if (points.length === 2) {
        const geo = new THREE.BufferGeometry().setFromPoints(points);
        const line = new THREE.Line(geo, lineMat);
        line.renderOrder = 10;
        group.add(line);
        const d = points[0].distanceTo(points[1]);
        const dx = Math.abs(points[0].x - points[1].x);
        const dy = Math.abs(points[0].y - points[1].y);
        const dz = Math.abs(points[0].z - points[1].z);
        label.innerHTML = `<b>${Math.round(d)} мм</b><span>Ш ${Math.round(dx)} · В ${Math.round(dy)} · Г ${Math.round(dz)}</span>`;
        label.hidden = false;
      }
      return true;
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
    item('Лінійка', 'У меню «Лінійка»: натисніть дві точки на моделі — побачите відстань у мм.'),
    item('Кубик у куті', 'Натисніть на грань кубика — вид повернеться до цієї сторони.'),
    item('Режими', '«Текстури з лініями», «Текстури», «Контури» (як креслення) і «Рентген» (видно кріплення).'),
  ));
}
