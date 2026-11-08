import { createViewer } from './scene.js';
import { buildFurniture, makeBoundsBox, dimensionAnchors, validateModel } from './furniture.js';
import { loadGltfModel } from './gltf-model.js';
import { createPanel, createInfoBox, createLabels, toast } from './ui.js';
import { createViewCube } from './viewcube.js';
import { initTelegram, startParam } from './telegram.js';
import { ICONS } from './icons.js';
import { createMenu, showPartsList, createRuler, showHelp, openSheet } from './extras.js';
import { prepareKp } from './kp.js';
import { createDims, boxDims, overallDims } from './dims.js';
import { MANAGER_TELEGRAM } from './contact.js';
import { notify } from './notify.js';

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

/** Назва моделі з адреси ?model=... Лише латиниця, цифри й дефіс (щоб не було ../). */
function getModelName() {
  // Пряме посилання з Telegram (?startapp=<назва>__<ключ>) має перевагу над ?model=
  const sp = startParam();
  const raw = (sp && sp.model) || new URLSearchParams(window.location.search).get('model') || DEFAULT_MODEL;
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

// Режим знімка для прев'ю в боті: ?shot=1 — лише сцена без інтерфейсу, кадр у window.__shot
const SHOT = new URLSearchParams(window.location.search).get('shot') === '1';

async function main() {
  if (SHOT) document.body.classList.add('shot');
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

  // Модель могли щойно надіслати, а сайт ще оновлюється (~1 хв): не показуємо помилку одразу,
  // а чекаємо до 3 хв і пробуємо знову
  let model;
  for (let attempt = 0; ; attempt++) {
    try {
      model = await loadModel(name, onProgress);
      break;
    } catch (err) {
      const notYet = /\(помилка 404\)|не знайдено/i.test(err.message || '');
      if (!notYet || attempt >= 18) {
        console.error(err);
        return showError(err.message || 'Не вдалося відкрити модель.');
      }
      $('loader-text').textContent = 'Модель ще публікується, зачекайте хвилинку…';
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
  const isGlbModel = model.kind === 'glb';

  viewer.scene.add(model.group);
  if (import.meta.env.DEV) window.__viewer = { viewer, model }; // лише для налагодження локально
  const boundsBox = makeBoundsBox(model.bounds);
  viewer.scene.add(boundsBox);

  viewer.resize();
  viewer.frame(model.bounds);
  // Шапка: назва виробу і префікс позначення (номер замовлення) з БАЗИСу
  const subtitle = [model.info?.prefix, model.info?.order && model.info.order !== model.info.prefix ? model.info.order : ""].filter(Boolean).join(" · ");
  $('title').textContent = subtitle ? `${model.name} · ${subtitle}` : model.name;
  $('loader-name').textContent = model.name;
  document.title = `${model.name} — М3 Меблі`;
  $('loader-fill').style.width = '100%';
  $('loader').classList.add('done');
  if (!SHOT) viewer.intro();
  if (!SHOT) notify('open', name, $('title').textContent, tg);

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
    refreshDims();
  }

  // ---- Розміри (плитка «Розміри»): вибране — його розміри; нічого не вибрано — ланцюжки й габарити ----
  const dims = isGlbModel ? createDims(viewer.scene, $('labels')) : null;
  let dimsOn = false;
  function refreshDims() {
    if (!dims) return;
    if (!dimsOn) { dims.show(null); return; }
    dims.show(current ? boxDims(model.boxOf(selectedParts())) : overallDims(model.blocks, model.bounds));
  }

  function showAll() {
    model.showAll();
    refreshTools();
    refreshInfo();
  }

  // Лінійка: дві точки на моделі → відстань у мм
  const meshesForRuler = [];
  model.group.traverse((o) => { if (o.isMesh) meshesForRuler.push(o); });
  const ruler = createRuler({
    scene: viewer.scene,
    camera: viewer.camera,
    canvas,
    layer: $('rulers'),
    controls: viewer.controls,
    getMeshes: () => meshesForRuler,
  });
  function toggleRuler() {
    ruler.setActive(!ruler.active);
    toast($('toast'), ruler.active
      ? 'Лінійка: тримайте палець і наводьте — точка прилипає до кутів і ребер; відпустіть, щоб поставити'
      : 'Лінійку вимкнено');
    refreshTools();
  }

  let downAt = null;
  canvas.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    downAt = null;
    if (moved > 6) return;
    if (ruler.active) return; // натискання забирає лінійка
    const hit = model.pick(e.clientX, e.clientY, viewer.camera, canvas);
    if (animMode) {
      const op = hit && model.openerOf ? model.openerOf(hit) : null;
      if (op) model.toggleOpener(op);
      else if (hit) toast($('toast'), 'Це не двері й не шухляда');
      return;
    }
    selectPart(hit);
  });
  info.show(null);

  // ---- Панель іконок над сценою (лише для моделей з БАЗИСу) ----
  // Сканувати · Блок · Анімація · Підсвітка (лампочка, якщо є LED) · Сховати.
  // «Розібрати» й «Лінійка» — у меню ☰; КП — кнопкою вгорі (у шапці).
  const toolbar = $('toolbar');
  const tools = {};
  let animMode = false;   // режим анімації: натискання на фасад відкриває/закриває саме його
  let explodeOn = false;
  let ledOn = false;
  function tool(id, title, icon, onClick, caption) {
    const b = document.createElement('button');
    b.className = 'tool';
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = icon + `<span class="tool-cap">${caption}</span>`;
    b.addEventListener('click', onClick);
    toolbar.append(b);
    tools[id] = b;
    return b;
  }

  // Вибір тону підсвітки: три кружечки під панеллю, видно лише коли лампочка увімкнена
  const tonePicker = document.createElement('div');
  tonePicker.className = 'tone-picker';
  tonePicker.hidden = true;
  const TONES = [['warm', 'Теплий', '#ffc27a'], ['neutral', 'Нейтральний', '#fff2dc'], ['cold', 'Холодний', '#e2ecff']];
  for (const [id, label, color] of TONES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tone';
    b.dataset.tone = id;
    b.title = label;
    b.setAttribute('aria-label', `Підсвітка: ${label.toLowerCase()}`);
    b.style.background = color;
    b.innerHTML = `<span>${label}</span>`;
    b.addEventListener('click', () => { model.setLed(true, id); refreshTools(); });
    tonePicker.append(b);
  }

  function refreshTools() {
    if (!isGlbModel) return;
    tools.block.setAttribute('aria-pressed', String(blockMode));
    tools.anim.setAttribute('aria-pressed', String(animMode));
    if (tools.led) {
      tools.led.setAttribute('aria-pressed', String(ledOn));
      tonePicker.hidden = !ledOn;
      for (const b of tonePicker.children) b.classList.toggle('active', b.dataset.tone === model.ledTone);
    }
    const canShow = !current && model.hasHidden;
    tools.hide.innerHTML = (canShow ? ICONS.show : ICONS.hide) + `<span class="tool-cap">${canShow ? 'Показати' : 'Сховати'}</span>`;
    tools.hide.title = canShow ? 'Показати все' : 'Сховати виділене';
    tools.hide.disabled = !current && !model.hasHidden;
  }

  if (isGlbModel) {
    toolbar.hidden = false;

    tool('scan', 'Сканувати QR-код деталі', ICONS.scan, () => scanPart(), 'Сканувати');
    tool('block', 'Вибір цілим блоком', ICONS.block, () => {
      blockMode = !blockMode;
      if (current) selectPart(current); else refreshTools();
      toast($('toast'), blockMode ? 'Вибір блоком: натисніть на будь-яку деталь блоку' : 'Вибір окремої деталі');
    }, 'Блок');
    tool('anim', 'Анімація: натисніть на фасад, щоб відкрити', ICONS.open, () => {
      const { doors, drawers } = model.openers;
      if (!doors && !drawers) { toast($('toast'), 'У моделі не знайдено дверей на петлях чи шухляд'); return; }
      animMode = !animMode;
      if (animMode) {
        selectPart(null);
        toast($('toast'), 'Анімація: натисніть на фасад — він відкриється, ще раз — закриється');
      } else {
        model.setOpen(0); // виходячи з режиму, зачиняємо все
      }
      refreshTools();
    }, 'Анімація');
    if (model.hasLed) {
      tool('led', 'Підсвітка', ICONS.bulb, () => {
        ledOn = !ledOn;
        model.setLed(ledOn);
        viewer.setDim(ledOn);
        refreshTools();
      }, 'Підсвітка');
      toolbar.after(tonePicker);
    }
    tool('hide', 'Сховати виділене', ICONS.hide, () => {
      if (current) {
        model.hide(selectedParts());
        current = null;
        refreshInfo();
        refreshTools();
      } else if (model.hasHidden) {
        showAll();
      }
    }, 'Сховати');
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
    refreshDims();
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
  const roomSpin = model.hasRoom ? 0.55 : Infinity;
  let roomShown = true;
  let roomBeforeExplode = false; // кімната відкрита лише спереду — гойдаємо, а не крутимо по колу

  // КП: зашифрований файл data/<назва>.kp.bin + ключ у посиланні (#kp=…)
  const openKp = await prepareKp(name);

  const panel = createPanel($('panel'), {
    onViewMode: isGlbModel ? (m) => model.setViewMode(m) : null,
    onDims(on) {
      if (dims) {
        dimsOn = on;
        refreshDims();
        if (on) toast($('toast'), 'Натисніть на деталь — покаже її розміри; на порожнє місце — загальні');
        return;
      }
      boundsBox.visible = on;
      labels.setItems(on ? dimensionAnchors(model.bounds) : []);
      labels.setVisible(on);
    },
    onFacadesVisible: (on) => model.setKeyVisible('facade', on),
    onRoomVisible: model.hasRoom ? (on) => { roomShown = on; model.setKeyVisible('room', on); } : null,
    onKp: null, // КП — кнопкою вгорі в шапці
    onSpin: (on) => viewer.setSpin(on, roomSpin),
    // Для моделей з БАЗИСу «Розібрати» — на панелі іконок над моделлю; у панелі лише для простих JSON-моделей
    onExplode: isGlbModel ? null : (t) => model.setExplode(t),
    onFacadeColor: (hex) => model.setMaterialColor('facade', hex),
    onSlotMaterial: (slot, index) => model.setSlotMaterial(slot, index),
    onReset: () => viewer.resetView(),
  }, colorOptions, { facades: model.hasFacades, viewMode: isGlbModel ? model.viewMode : undefined, materialSlots: model.materialSlots, materialOptions: model.materialOptions });
  viewer.onSpinStop = () => panel.setSpin(false);

  /** Розібрати / зібрати (кнопка на панелі іконок). */
  function doExplode(on) {
    explodeOn = on;
    model.setExplode(on ? 1 : 0);
    if (on) {
      // Стіни заважають бачити розібрані деталі — ховаємо, а камера відходить, щоб влізло все
      roomBeforeExplode = model.hasRoom && roomShown;
      if (roomBeforeExplode) { model.setKeyVisible('room', false); panel.setRoom(false); }
      // Схему розбирання найкраще видно спереду трохи згори й зліва
      viewer.focusBox(model.explodedBox(), [-0.2, 0.55, 1]);
    } else {
      if (roomBeforeExplode) { model.setKeyVisible('room', true); panel.setRoom(true); roomBeforeExplode = false; }
      viewer.resetView();
    }
    refreshTools();
  }

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

  // ---- КП — кнопкою вгорі (у шапці), лише якщо КП є і посилання з ключем ----
  if (openKp) {
    const kpBtn = $('kpbtn');
    kpBtn.hidden = false;
    kpBtn.addEventListener('click', () => { notify('kp', name, $('title').textContent, tg); openKp(model.name); });
  }

  // ---- Шторка панелі на телефоні: тап або свайп по смужці — розгорнути/згорнути ----
  {
    const sidebar = $('sidebar');
    const handle = document.createElement('div');
    handle.className = 'sheet-handle';
    handle.setAttribute('role', 'button');
    handle.setAttribute('aria-label', 'Розгорнути або згорнути панель');
    sidebar.prepend(handle);
    const setOpen = (on) => {
      document.body.classList.toggle('sheet-open', on);
      if (!on) sidebar.scrollTop = 0;
    };
    let y0 = null;
    handle.addEventListener('pointerdown', (e) => { y0 = e.clientY; handle.setPointerCapture(e.pointerId); });
    handle.addEventListener('pointerup', (e) => {
      if (y0 === null) return;
      const dy = e.clientY - y0;
      y0 = null;
      if (dy < -25) setOpen(true);
      else if (dy > 25) setOpen(false);
      else setOpen(!document.body.classList.contains('sheet-open'));
    });
    // Свайп униз по самій панелі, коли вона прокручена до верху, — теж згортає
    let t0 = null;
    sidebar.addEventListener('touchstart', (e) => { t0 = sidebar.scrollTop === 0 ? e.touches[0].clientY : null; }, { passive: true });
    sidebar.addEventListener('touchend', (e) => {
      if (t0 !== null && e.changedTouches[0].clientY - t0 > 60) setOpen(false);
      t0 = null;
    });
    // Натиснули на модель — шторку ховаємо, щоб не заважала
    canvas.addEventListener('pointerdown', () => setOpen(false));
  }

  // ---- «Замовити»: чат з менеджером у Telegram, повідомлення вже з назвою і номером ----
  if (MANAGER_TELEGRAM && !SHOT) {
    const orderBtn = $('order');
    orderBtn.hidden = false;
    orderBtn.innerHTML = ICONS.chat + '<span>Замовити</span>';
    // Натискання одразу відкриває чат з менеджером. Готовий текст Telegram у чат з людиною
    // з Mini App не підставляє (посилання з ?text= він відхиляє — лише вібрує), тому текст
    // спершу копіюємо в буфер: клієнту лишається вставити й надіслати.
    // Якщо відкрити чат не вдалося (немає Telegram, заблоковано) — показуємо віконце з кнопками.
    const chatUrl = `https://t.me/${MANAGER_TELEGRAM}`;
    function openChat() {
      try {
        if (inTelegram && tg.openTelegramLink && (!tg.isVersionAtLeast || tg.isVersionAtLeast('6.1'))) {
          // З Bot API 7.0 Telegram відкриває чат ПІД міні-апкою і не закриває її — клієнт чату не бачить.
          // Тому після переходу закриваємо міні-апку (без підтвердження): клієнт одразу в чаті з менеджером.
          try { tg.disableClosingConfirmation && tg.disableClosingConfirmation(); } catch { /* немає */ }
          tg.openTelegramLink(chatUrl);
          setTimeout(() => { try { tg.close(); } catch { /* немає */ } }, 600);
          return true;
        }
        if (inTelegram && tg.openLink) { tg.openLink(chatUrl); return true; }
      } catch { /* далі — звичайне посилання */ }
      const w = window.open(chatUrl, '_blank', 'noopener');
      return !!w;
    }
    const orderText = () => `Доброго дня! Ознайомився з 3D-моделлю «${$('title').textContent}», хочу замовити і обговорити деталі.`;
    async function copyText(text) {
      try { await navigator.clipboard.writeText(text); return true; } catch { /* нижче — запасний спосіб */ }
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.append(ta); ta.select();
        const ok = document.execCommand('copy'); ta.remove(); return ok;
      } catch { return false; }
    }
    orderBtn.addEventListener('click', () => {
      notify('order', name, $('title').textContent, tg);
      const text = orderText();
      // Спершу — копіювання і відкриття чату (поки діє натискання), потім віконце-підстраховка:
      // якщо Telegram чат не відкрив, клієнт бачить кнопку, а не «нічого»
      const copying = copyText(text);
      // Чат — після копіювання: міні-апка одразу закривається, текст має встигнути потрапити в буфер
      copying.finally(() => openChat());
      const body = document.createElement('div');
      body.className = 'order-sheet';
      body.innerHTML = `<p>Відкриваємо чат з менеджером. Вставте текст (він уже скопійований) і надішліть — ми одразу відповімо.</p>
        <div class="order-msg"></div>`;
      copying.then((ok) => { if (!ok) body.querySelector('p').textContent = 'Відкриваємо чат з менеджером. Напишіть, що готові замовити, — ми одразу відповімо.'; });
      body.querySelector('.order-msg').textContent = text;
      // Звичайне посилання: Telegram сам перехоплює натискання на t.me — надійніше за виклик із коду
      const go = document.createElement('a');
      go.className = 'btn order-go';
      go.href = chatUrl;
      go.target = '_blank';
      go.rel = 'noopener';
      go.addEventListener('click', (e) => { if (inTelegram) { e.preventDefault(); openChat(); } });
      go.innerHTML = ICONS.chat + `<span>Не відкрився? Написати @${MANAGER_TELEGRAM}</span>`;
      // Останній варіант: через браузер (сторінка t.me з кнопкою «Send Message» веде в чат)
      const viaBrowser = document.createElement('button');
      viaBrowser.type = 'button';
      viaBrowser.className = 'btn';
      viaBrowser.textContent = 'Відкрити чат через браузер';
      viaBrowser.addEventListener('click', () => {
        try { if (inTelegram && tg.openLink) { tg.openLink(chatUrl, { try_instant_view: false }); return; } } catch { /* нижче */ }
        window.open(chatUrl, '_blank', 'noopener');
      });
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'btn';
      copy.textContent = 'Скопіювати повідомлення';
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(text); copy.textContent = 'Скопійовано — вставте в чат'; }
        catch { window.prompt('Скопіюйте повідомлення:', text); }
      });
      body.append(go, viaBrowser, copy);
      openSheet('Замовити', body);
    });
  }

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
    isGlbModel && { label: 'Розібрати / зібрати', icon: '⤧', onClick: () => doExplode(!explodeOn) },
    {
      label: 'Лінійка (замір)',
      icon: '📏',
      onClick: () => toggleRuler(),
    },
    isGlbModel && { label: 'Показати все', icon: '👁', onClick: () => showAll() },
    { label: 'Інструкція', icon: '?', onClick: () => showHelp() },
  ]);
  const isVisiblePart = (part) => part.meshes ? part.meshes.some((r) => r.mesh.visible) : true;

  window.addEventListener('resize', () => viewer.resize());
  // Telegram змінює висоту вікна застосунку (розгортання, клавіатура) своєю подією
  if (inTelegram && tg.onEvent) tg.onEvent('viewportChanged', () => viewer.resize());

  // Один рендер-цикл на всю сторінку
  let last = performance.now();
  let shotFrames = 0;
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    viewer.tick(dt);
    model.update(dt);
    viewer.controls.update();
    viewer.renderer.render(viewer.scene, viewer.camera);
    cube.render();
    if (dims) dims.update(viewer.camera, viewer.controls.target, canvas.clientWidth, canvas.clientHeight);
    else labels.update(viewer.camera, canvas.clientWidth, canvas.clientHeight);
    ruler.update(canvas.clientWidth, canvas.clientHeight);
    // Знімок: кілька кадрів на підвантаження текстур, далі зберігаємо JPEG одразу після рендеру
    if (SHOT && !window.__shot && ++shotFrames > 20) {
      viewer.renderer.render(viewer.scene, viewer.camera);
      window.__shot = canvas.toDataURL('image/jpeg', 0.9);
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

main().catch((err) => {
  console.error(err);
  showError('Щось пішло не так під час запуску. Оновіть сторінку.');
});
