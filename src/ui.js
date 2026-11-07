// Елементи інтерфейсу: панель керування, вікно деталі, підписи розмірів, повідомлення.

/** Маленький хелпер для створення DOM: h('button', { class: 'btn', onclick: fn }, 'Текст') */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value);
  }
  el.append(...children);
  return el;
}

/** Кнопка-перемикач з текстом для двох станів. btn.set(on) міняє стан ззовні без виклику onChange. */
function toggleButton(onText, offText, initial, onChange) {
  let on = initial;
  const btn = h('button', { class: 'btn', type: 'button' });
  const paint = () => {
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? onText : offText;
  };
  btn.addEventListener('click', () => { on = !on; paint(); onChange(on); });
  btn.set = (v) => { on = v; paint(); };
  paint();
  return btn;
}

const button = (text, onclick, cls = 'btn') => h('button', { class: cls, type: 'button', onclick }, text);
const section = (title) => h('div', { class: 'section-title' }, title);
const row = (...items) => h('div', { class: 'row' }, ...items.filter(Boolean));

/**
 * Панель керування (внизу на телефоні, збоку на ПК).
 * handlers: onDims, onFacadesVisible, onRoomVisible|null, onClientView|null, onSpin,
 *           onExplode(0|1), onOpen(0|1)|null, onFacadeColor(hex|null), onReset
 * colors: [{ name, hex, swatch? }], перший уважається вибраним на старті.
 * opts: { facades: bool, openLabel: string }
 * Повертає { setSpin(on) } — щоб зняти позначку «Обертання», коли користувач сам крутнув модель.
 */
export function createPanel(container, handlers, colors, opts = {}) {
  const showFacades = opts.facades !== false;

  const dimsBtn = toggleButton('Розміри: показані', 'Показати розміри', false, handlers.onDims);
  const facadesBtn = showFacades && toggleButton('Фасади: показані', 'Фасади: приховані', true, handlers.onFacadesVisible);
  const roomBtn = handlers.onRoomVisible && toggleButton('Стіни: показані', 'Стіни: приховані', true, handlers.onRoomVisible);
  const clientBtn = handlers.onClientView && toggleButton('Як бачить клієнт: увімк.', 'Як бачить клієнт: вимк.', true, handlers.onClientView);
  const spinBtn = toggleButton('Обертання: увімк.', 'Обертання', false, handlers.onSpin);

  const openBtn = handlers.onOpen && toggleButton('Закрити', opts.openLabel || 'Відкрити двері й шухляди', false, (on) => handlers.onOpen(on ? 1 : 0));

  const colorName = h('div', { class: 'hint' }, colors[0]?.name ?? '');
  const swatches = colors.map((c, i) => h('button', {
    class: 'swatch',
    type: 'button',
    title: c.name,
    'aria-label': c.name,
    style: `background:${c.swatch || c.hex}`,
    onclick: () => { mark(i); handlers.onFacadeColor(colors[i].hex); },
  }));
  function mark(i) {
    swatches.forEach((s, j) => s.classList.toggle('active', i === j));
    colorName.textContent = colors[i].name;
  }
  mark(0);

  // Режими відображення (як у БАЗИСі): один вибраний
  let modeRow = null;
  if (handlers.onViewMode) {
    const modes = [
      ["real-lines", "Текстури з лініями"],
      ["real", "Текстури"],
      ["lines", "Контури"],
      ["xray", "Рентген"],
    ];
    const btns = modes.map(([id, label]) => {
      const b = button(label, () => {
        btns.forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        handlers.onViewMode(id);
      }, "btn btn-small");
      b.setAttribute("aria-pressed", String(id === (opts.viewMode || "real-lines")));
      return b;
    });
    modeRow = h("div", { class: "row modes" }, ...btns);
  }

  const blocks = [
    section('Вигляд'),
    modeRow,
    row(dimsBtn, facadesBtn),
    row(roomBtn, spinBtn),
    clientBtn && row(clientBtn),
    section('Анімація'),
    openBtn && row(openBtn),
    row(button('Розібрати', () => handlers.onExplode(1)), button('Зібрати', () => handlers.onExplode(0))),
  ];
  if (opts.materialSlots && opts.materialSlots.length && opts.materialOptions && opts.materialOptions.length) {
    // Матеріали з самої моделі: для кожної групи (фасади, корпус, стільниця) свій вибір
    blocks.push(section('Матеріали'));
    for (const slot of opts.materialSlots) {
      const label = h('div', { class: 'hint slot-label' }, `${slot.label}: як у проєкті`);
      const choices = [{ name: 'Як у проєкті', swatch: 'linear-gradient(135deg,#f6f4ef 0%,#d8d1c5 100%)', index: null },
        ...opts.materialOptions.map((o, i) => ({ ...o, index: i }))];
      const btns = choices.map((c) => h('button', {
        class: 'swatch', type: 'button', title: c.name, 'aria-label': `${slot.label}: ${c.name}`,
        style: `background:${c.swatch}`,
        onclick: () => {
          btns.forEach((b) => b.classList.toggle('active', b === btns[choices.indexOf(c)]));
          label.textContent = `${slot.label}: ${c.name.toLowerCase() === 'як у проєкті' ? 'як у проєкті' : c.name}`;
          handlers.onSlotMaterial(slot.id, c.index);
        },
      }));
      btns[0].classList.add('active');
      blocks.push(label, h('div', { class: 'swatches' }, ...btns));
    }
  } else if (showFacades) {
    blocks.push(section('Колір фасадів'), h('div', { class: 'swatches' }, ...swatches), colorName);
  }
  blocks.push(row(button('Скинути вид', () => handlers.onReset(), 'btn btn-wide')));
  container.replaceChildren(...blocks.filter(Boolean));

  return { setSpin: (on) => spinBtn.set(on) };
}

/**
 * Вікно вибраної деталі.
 * info = { title, dims, material, article, group, groupCount }
 * actions = { isolated: bool, onIsolate(), onFocus() } — кнопки для деталі (лише для моделей з БАЗИСу)
 */
export function createInfoBox(el) {
  return {
    message(text) {
      el.replaceChildren(h('div', { class: 'hint' }, text));
    },
    show(info, actions) {
      if (!info) {
        el.replaceChildren(h('div', { class: 'hint' }, 'Натисніть на деталь, щоб побачити її назву й розміри.'));
        if (actions && actions.isolated) {
          el.append(row(button('Показати все', actions.onIsolate)));
        }
        return;
      }
      const rows = [];
      if (info.group && info.group !== info.title) {
        rows.push(h('div', { class: 'group-tag' }, info.group));
      }
      rows.push(h('strong', {}, info.title));
      rows.push(h('div', { class: 'hint' }, `Розміри: ${info.dims}`));
      if (info.material) rows.push(h('div', { class: 'hint' }, `Матеріал: ${info.material}`));
      if (info.article) rows.push(h('div', { class: 'hint' }, `Артикул: ${info.article}`));
      if (info.groupCount > 1) rows.push(h('div', { class: 'hint' }, `У групі «${info.group}»: ${info.groupCount} деталей`));
      if (actions) {
        rows.push(row(
          button(actions.isolated ? 'Показати все' : 'Ізолювати групу', actions.onIsolate, 'btn btn-small'),
          button('Наблизити', actions.onFocus, 'btn btn-small'),
        ));
      }
      el.replaceChildren(...rows);
    },
  };
}

/** Коротке повідомлення поверх сцени (зникає саме). */
export function toast(el, text, ms = 2200) {
  el.textContent = text;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, ms);
}

/** Підписи розмірів, які слідують за 3D-точками при обертанні камери. */
export function createLabels(container) {
  let items = [];

  return {
    setItems(list) {
      items = list.map((it) => ({
        position: it.position,
        el: h('div', { class: 'dim-label' }, it.text),
      }));
      container.replaceChildren(...items.map((it) => it.el));
    },
    setVisible(visible) {
      container.hidden = !visible;
    },
    update(camera, width, height) {
      if (container.hidden) return;
      for (const it of items) {
        const p = it.position.clone().project(camera);
        const onScreen = p.z > -1 && p.z < 1;
        it.el.style.display = onScreen ? '' : 'none';
        it.el.style.left = `${((p.x + 1) / 2) * width}px`;
        it.el.style.top = `${((1 - p.y) / 2) * height}px`;
      }
    },
  };
}
