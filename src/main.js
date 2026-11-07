import { createViewer } from './scene.js';
import { buildFurniture, makeBoundsBox, dimensionAnchors, validateModel } from './furniture.js';
import { loadGltfModel } from './gltf-model.js';
import { createPanel, createInfoBox, createLabels } from './ui.js';
import { initTelegram } from './telegram.js';

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

/** Спершу шукаємо data/<назва>.glb (модель з БАЗИСу), потім data/<назва>.json. */
async function loadModel(name) {
  try {
    const res = await fetch(`data/${name}.glb`, { cache: 'no-cache' });
    if (res.ok) {
      const buffer = await res.arrayBuffer();
      if (isGlb(buffer)) return loadGltfModel(buffer, name);
    }
  } catch {
    // мережа впала або файлу немає — пробуємо JSON
  }

  const res = await fetch(`data/${name}.json`, { cache: 'no-cache' });
  if (!res.ok) {
    throw new Error(`Не вдалося знайти модель «${name}» (помилка ${res.status}).`);
  }
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
  document.getElementById('title').textContent = 'Помилка';
  const box = document.getElementById('error');
  box.textContent = message;
  box.hidden = false;
}

async function main() {
  initTelegram();
  const canvas = document.getElementById('canvas');
  const viewer = createViewer(canvas);
  const info = createInfoBox(document.getElementById('info'));
  const labels = createLabels(document.getElementById('labels'));

  const name = getModelName();
  if (!name) {
    return showError('Некоректна назва моделі в адресі. Використовуйте лише латинські літери, цифри й дефіс.');
  }

  info.message('Завантаження моделі…');
  let model;
  try {
    model = await loadModel(name);
  } catch (err) {
    console.error(err);
    return showError(err.message || 'Не вдалося відкрити модель.');
  }

  viewer.scene.add(model.group);
  if (import.meta.env.DEV) window.__viewer = { viewer, model }; // лише для налагодження локально
  const boundsBox = makeBoundsBox(model.bounds);
  viewer.scene.add(boundsBox);

  viewer.resize();
  viewer.frame(model.bounds);
  document.getElementById('title').textContent = model.name;

  // Вибір деталі: натискання без руху (щоб не конфліктувати з обертанням камери)
  let downAt = null;
  canvas.addEventListener('pointerdown', (e) => {
    downAt = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    downAt = null;
    if (moved > 6) return;
    const part = model.pick(e.clientX, e.clientY, viewer.camera, canvas);
    model.highlight(part);
    info.show(part ? model.describe(part) : null);
  });
  info.show(null);

  // Для GLB «Як у проєкті» повертає оригінальні матеріали з текстурами (hex = null)
  const colorOptions = [
    model.kind === 'glb'
      ? { name: 'Як у проєкті', hex: null, swatch: 'linear-gradient(135deg,#f6f4ef 0%,#d8d1c5 100%)' }
      : { name: 'Як у проєкті', hex: model.defaultFacadeColor },
    ...FACADE_COLORS,
  ];

  createPanel(document.getElementById('panel'), {
    onDims(on) {
      boundsBox.visible = on;
      labels.setItems(on ? dimensionAnchors(model.bounds) : []);
      labels.setVisible(on);
    },
    onExplode: (t) => model.setExplode(t),
    onFacadeColor: (hex) => model.setMaterialColor('facade', hex),
    onFacadesVisible: (on) => model.setKeyVisible('facade', on),
    onRoomVisible: model.hasRoom ? (on) => model.setKeyVisible('room', on) : null,
    onReset: () => viewer.resetView(),
  }, colorOptions, { facades: model.hasFacades });

  window.addEventListener('resize', () => viewer.resize());

  // Один рендер-цикл на всю сторінку
  function loop() {
    model.update();
    viewer.controls.update();
    viewer.renderer.render(viewer.scene, viewer.camera);
    labels.update(viewer.camera, canvas.clientWidth, canvas.clientHeight);
    requestAnimationFrame(loop);
  }
  loop();
}

main().catch((err) => {
  console.error(err);
  showError('Щось пішло не так під час запуску. Оновіть сторінку.');
});
