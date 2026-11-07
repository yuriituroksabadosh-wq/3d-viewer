import { createViewer } from './scene.js';
import { buildFurniture, makeBoundsBox, dimensionAnchors, validateModel } from './furniture.js';
import { loadGltfModel } from './gltf-model.js';
import { createPanel, createInfoBox, createLabels, toast } from './ui.js';
import { createViewCube } from './viewcube.js';
import { initTelegram } from './telegram.js';
import { createMenu, showPartsList, createRuler, showHelp } from './extras.js';

// Готові варіанти кольору фасадів (перший пункт — колір/текстура з самого проєкту)
const FACADE_COLORS = [
  { name: 'Дуб натуральний', hex: '#c8a66f' },
  { name: 'Горіх', hex: '#6b4a2f' },
  { name: 'Білий', hex: '#f3f1ec' },
  { name: 'Графіт', hex: '#3c4046' },
  { name: 'Мокко', hex: '#a57c62' },
  { name: 'Сірий', hex: '#9da3a8' },
];

const DEFAULT_MODEL = 'sample-cabinet';
const $ = (id) => document.getElementById(id);

// Іконки панелі інструментів (свої, прості контури 24×24)
const ICONS = {
  scan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M7 12h10"/></svg>',
  block: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  hide: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.7 10.7 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17.4 17.4 0 0 0 2.5 12S6 19 12 19a9.7 9.7 0 0 0 4.3-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
  show: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z"/><circle cx="12" cy="12" r="3"/></svg>',
};

/** Назва моделі з адреси ?model=... Лише латиниця, цифри й дефіс (щоб не було ../). */
function getModelName() {
  const raw = new URLSearchParams(window.location.search).get('model') || DEFAULT_MODEL;
  return /^[a-zA-Z0-9-]{1,64}$/.test(raw) ? raw : null;
}

// Перевірка «магічних» байтів GLB: dev-сервер на відсутній файл віддає index.html з кодом 200
function isGlb(buffer) {
  if (buffer.byteLength < 12) return false;
  const b = new Uint8Array(buffer, 0, 4);
  return b[0] === 0x67 && b[1] === 0x6c && b[2] === 0x54 && b[3] === 0x46; // "glTF"
}

const mb = (n) => (n / 1024 / 1024).toFixed(1);

/** Завантаження з прогресом (для екрана з логотипом). */
async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok || !res.body) return res.ok ? res.arrayBuffer() : null;
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(got, total);
  }
  const out = new Uint8Array(got);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out.buffer;
}

/** Спершу шукаємо data/<назва>.glb (модель з БАЗИСу), потім data/<назва>.json. */
async function loadModel(name, onProgress) {
  try {
    const buffer = await fetchWithProgress(`data/${name}.glb`, onProgress);
    if (buffer && isGlb(buffer)) return loadGltfModel(buffer, name);
  } catch (err) {
    console.warn('GLB не завантажився, пробуємо JSON', err);
  }

  const res = await fetch(`data/${name}.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Не вдалося знайти модель «${name}» (помилка ${res.status}).`);
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Модель «${name}» не знайдено або файл пошкоджено.`);
  }
  validateModel(data);
  const model = buildFurniture(data);
  model.kind = 'json';
  model.name = data.name ?? name;
  model.defaultFacadeColor = data.materials?.facade?.color ?? '#8b6f4e';
  model.hasFacades = model.parts.some((p) => p.key === 'facade');
  model.hasRoom = false;
  return model;
}

function showError(message) {
  $('title').textContent = 'Помилка';
  $('loader').classList.add('done');
  const box = $('error');
  box.textContent = message;
  box.hidden = false;
}

async function main() {
  const tg = initTelegram();
  const inTelegram = !!(tg && tg.platform && tg.platform !== 'unknown');
  const canvas = $('canvas');
  const viewer = createViewer(canvas);
  const info = createInfoBox($('info'));
  const labels = createLabels($('labels'));

  const name = getModelName();
  if (!name) {
    return showError('Некоректна назва моделі в адресі. Використовуйте лише латинські літери, цифри й дефіс.');
  }

  // ---- Екран завантаження: логотип, назва, прогрес у МБ ----
  $('loader-name').textContent = name;
  info.message('Завантаження моделі…');
  const onProgress = (got, total) => {
    $('loader-fill').style.width = total ? `${Math.min(100, (got / total) * 100)}%` : '60%';
    $('loader-text').textContent = total ? `${mb(got)} / ${mb(total)} МБ` : `${mb(got)} МБ`;
  };

  let model;
  try {
    model = await loadModel(name, onProgress);
  } catch (err) {
    console.error(err);
    return showError(err.message || 'Не вдалося відкрити модель.');
  }
  const isGlbModel = model.kind === 'glb';

  viewer.scene.add(model.group);
  if (import.meta.env.DEV) window.__viewer = { viewer, model }; // лише для налагодження локально
  const boundsBox = makeBoundsBox(model.bounds);
  viewer.scene.add(boundsBox);

  viewer.resize();
  viewer.frame(model.bounds);
  $('title').textContent = model.name;
  $('loader-fill').style.width = '100%';
  $('loader').classList.add('done');
  viewer.intro();

  // ---- Вибір деталі або цілого блоку ----
  let blockMode = false;
  let current = null; // вибрана деталь (для блоку — будь-яка деталь блоку)

  function refreshInfo() {
    if (!current) {
      info.show(null, isGlbModel && model.hasHidden ? { isolated: true, onIsolate: showAll } : null);
      return;
    }
    const d = model.describe(current);
    if (blockMode && isGlbModel) {
      const box = model.boxOf(current.group.parts);
      const s = box.getSize(box.min.clone());
      d.title = current.group.name;
      d.dims = `${Math.round(s.x)} × ${Math.round(s.y)} × ${Math.round(s.z)} мм (габарит блоку)`;
      d.material = '';
      d.article = '';
      d.group = '';
    }
    const actions = isGlbModel ? {
      isolated: !!model.isolated,
      onIsolate: () => {
        if (model.isolated) showAll();
        else { model.isolate(current.group); refreshTools(); refreshInfo(); viewer.focusBox(model.boxOf(current.group.parts)); }
      },
      onFocus: () => viewer.focusBox(model.boxOf(selectedParts())),
    } : null;
    info.show(d, actions);
  }

  const selectedParts = () => (!current ? [] : blockMode && isGlbModel ? current.group.parts : [current]);

  function selectPart(part) {
    current = part;
    if (isGlbModel) model.select(selectedParts());
    else model.highlight(part);
    refreshInfo();
    refreshTools();
  }

  function showAll() {
    model.showAll();
    refreshTools();
    refreshInfo();
  }

  // Лінійка: дві точки на моделі → відстань у мм
  const meshesForRuler = [];
  model.group.traverse((o) => { if (o.isMesh) meshesForRuler.push(o); });
  const ruler = createRuler(viewer.scene, viewer.camera, canvas, $('rulers'), () => meshesForRuler);

  let downAt = null;
  canvas.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    downAt = null;
    if (moved > 6) return;
    if (ruler.click(e.clientX, e.clientY)) return; // лінійка забирає натискання собі
    selectPart(model.pick(e.clientX, e.clientY, viewer.camera, canvas));
  });
  info.show(null);

  // ---- Панель іконок над сценою (лише для моделей з БАЗИСу) ----
  const toolbar = $('toolbar');
  const tools = {};
  let openOn = false;
  function tool(id, title, icon, onClick) {
    const b = document.createElement('button');
    b.className = 'tool';
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = icon;
    b.addEventListener('click', onClick);
    toolbar.append(b);
    tools[id] = b;
    return b;
  }

  function refreshTools() {
    if (!isGlbModel) return;
    tools.block.setAttribute('aria-pressed', String(blockMode));
    tools.play.setAttribute('aria-pressed', String(openOn));
    tools.play.innerHTML = openOn ? ICONS.stop : ICONS.play;
    tools.play.title = openOn ? 'Закрити двері й шухляди' : 'Відкрити двері й шухляди';
    const canShow = !current && model.hasHidden;
    tools.hide.innerHTML = canShow ? ICONS.show : ICONS.hide;
    tools.hide.title = canShow ? 'Показати все' : 'Сховати виділене';
    tools.hide.disabled = !current && !model.hasHidden;
  }

  if (isGlbModel) {
    toolbar.hidden = false;

    tool('scan', 'Сканувати QR-код деталі', ICONS.scan, () => scanPart());
    tool('block', 'Вибір цілим блоком', ICONS.block, () => {
      blockMode = !blockMode;
      if (current) selectPart(current); else refreshTools();
      toast($('toast'), blockMode ? 'Вибір блоком: натисніть на будь-яку деталь блоку' : 'Вибір окремої деталі');
    });
    tool('play', 'Відкрити двері й шухляди', ICONS.play, () => {
      const { doors, drawers } = model.openers;
      if (!doors && !drawers) { toast($('toast'), 'У моделі не знайдено дверей на петлях чи шухляд'); return; }
      openOn = !openOn;
      model.setOpen(openOn ? 1 : 0);
      refreshTools();
    });
    tool('hide', 'Сховати виділене', ICONS.hide, () => {
      if (current) {
        model.hide(selectedParts());
        current = null;
        refreshInfo();
        refreshTools();
      } else if (model.hasHidden) {
        showAll();
      }
    });
    refreshTools();
  }

  /** Пошук деталі за QR-кодом: у Telegram — вбудований сканер, у браузері — камера або введення тексту. */
  function applySearch(text) {
    const found = model.find(text);
    if (!found.length) {
      toast($('toast'), `Не знайдено: «${String(text).slice(0, 40)}»`);
      return;
    }
    current = found[0];
    model.select(blockMode ? current.group.parts : found);
    refreshInfo();
    refreshTools();
    viewer.focusBox(model.boxOf(found));
    toast($('toast'), found.length > 1 ? `Знайдено деталей: ${found.length}` : `Знайдено: ${found[0].name.title}`);
  }

  function scanPart() {
    if (inTelegram && tg.showScanQrPopup) {
      tg.showScanQrPopup({ text: 'Наведіть камеру на QR-код деталі' }, (text) => {
        applySearch(text);
        return true; // закрити сканер після першого коду
      });
      return;
    }
    // У браузері: назва або артикул з етикетки
    const text = window.prompt('Введіть назву, артикул або текст з QR-коду деталі:');
    if (text) applySearch(text);
  }

  // ---- Панель керування ----
  const colorOptions = [
    isGlbModel
      ? { name: 'Як у проєкті', hex: null, swatch: 'linear-gradient(135deg,#f6f4ef 0%,#d8d1c5 100%)' }
      : { name: 'Як у проєкті', hex: model.defaultFacadeColor },
    ...FACADE_COLORS,
  ];
  const roomSpin = model.hasRoom ? 0.55 : Infinity; // кімната відкрита лише спереду — гойдаємо, а не крутимо по колу

  const panel = createPanel($('panel'), {
    onViewMode: isGlbModel ? (m) => model.setViewMode(m) : null,
    onDims(on) {
      boundsBox.visible = on;
      labels.setItems(on ? dimensionAnchors(model.bounds) : []);
      labels.setVisible(on);
    },
    onFacadesVisible: (on) => model.setKeyVisible('facade', on),
    onRoomVisible: model.hasRoom ? (on) => model.setKeyVisible('room', on) : null,
    onClientView: isGlbModel && model.technicalCount ? (on) => { model.setClientView(on); refreshInfo(); } : null,
    onSpin: (on) => viewer.setSpin(on, roomSpin),
    onExplode: (t) => model.setExplode(t),
    onFacadeColor: (hex) => model.setMaterialColor('facade', hex),
    onReset: () => viewer.resetView(),
  }, colorOptions, { facades: model.hasFacades, viewMode: isGlbModel ? model.viewMode : undefined });
  viewer.onSpinStop = () => panel.setSpin(false);

  // ---- Кубик орієнтації ----
  const cube = createViewCube($('viewcube'), viewer.camera, viewer.controls, (dir) => viewer.viewFrom(dir));

  // ---- Поділитися посиланням ----
  const share = $('share');
  share.hidden = false;
  share.addEventListener('click', async () => {
    const url = window.location.href;
    if (inTelegram && tg.openTelegramLink) {
      tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent('3D-модель від М3 Меблі')}`);
    } else if (navigator.share) {
      try { await navigator.share({ title: `${model.name} — М3 Меблі`, url }); } catch { /* скасовано */ }
    } else {
      try { await navigator.clipboard.writeText(url); toast($('toast'), 'Посилання скопійовано'); }
      catch { window.prompt('Скопіюйте посилання:', url); }
    }
  });

  // ---- Меню в шапці ----
  const menuBtn = $('menu');
  menuBtn.hidden = false;
  createMenu(menuBtn, [
    { label: 'В центр', icon: '⌖', onClick: () => viewer.resetView() },
    isGlbModel && {
      label: 'Список деталей',
      icon: '☰',
      onClick: () => showPartsList(model.parts, (p) => model.describe(p), (part) => {
        if (!isVisiblePart(part)) model.showAll();
        selectPart(part);
        viewer.focusBox(model.boxOf(selectedParts()));
      }),
    },
    {
      label: 'Лінійка (замір)',
      icon: '📏',
      onClick: () => {
        ruler.setActive(!ruler.active);
        toast($('toast'), ruler.active ? 'Лінійка: натисніть дві точки на моделі' : 'Лінійку вимкнено');
      },
    },
    isGlbModel && { label: 'Показати все', icon: '👁', onClick: () => showAll() },
    { label: 'Інструкція', icon: '?', onClick: () => showHelp() },
  ]);
  const isVisiblePart = (part) => part.meshes ? part.meshes.some((r) => r.mesh.visible) : true;

  window.addEventListener('resize', () => viewer.resize());

  // Один рендер-цикл на всю сторінку
  let last = performance.now();
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    viewer.tick(dt);
    model.update();
    viewer.controls.update();
    viewer.renderer.render(viewer.scene, viewer.camera);
    cube.render();
    labels.update(viewer.camera, canvas.clientWidth, canvas.clientHeight);
    ruler.update(canvas.clientWidth, canvas.clientHeight);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

main().catch((err) => {
  console.error(err);
  showError('Щось пішло не так під час запуску. Оновіть сторінку.');
});
