import { createViewer } from './scene.js';
import { buildFurniture, makeBoundsBox, dimensionAnchors, validateModel } from './furniture.js';
import { createPanel, createInfoBox, createLabels } from './ui.js';
import { initTelegram } from './telegram.js';

// Готові варіанти кольору фасадів (перший пункт — колір з самого JSON)
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

async function loadModel(name) {
  const res = await fetch(`data/${name}.json`, { cache: 'no-cache' });
  if (!res.ok) {
    throw new Error(`Не вдалося знайти модель «${name}» (помилка ${res.status}).`);
  }
  try {
    return await res.json();
  } catch {
    throw new Error(`Файл моделі «${name}» не є коректним JSON. Перевірте файл у папці data/.`);
  }
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

  let data;
  try {
    data = await loadModel(name);
    validateModel(data);
  } catch (err) {
    return showError(err.message);
  }

  const model = buildFurniture(data);
  viewer.scene.add(model.group);

  const boundsBox = makeBoundsBox(model.bounds);
  viewer.scene.add(boundsBox);

  viewer.resize();
  viewer.frame(model.bounds);
  document.getElementById('title').textContent = data.name ?? name;

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
    info.show(part);
  });
  info.show(null);

  const colorOptions = [
    { name: 'Як у проєкті', hex: data.materials?.facade?.color ?? '#8b6f4e' },
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
    onReset: () => viewer.resetView(),
  }, colorOptions);

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
