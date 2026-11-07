// Елементи інтерфейсу: панель керування, вікно деталі, підписи розмірів.

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

/**
 * Панель керування (внизу на телефоні, збоку на ПК).
 * handlers: onDims(bool), onExplode(0|1), onFacadeColor(hex), onFacadesVisible(bool), onReset()
 * colors: [{ name, hex }], перший елемент уважається вибраним на старті.
 */
export function createPanel(container, handlers, colors) {
  let dimsOn = false;
  let facadesOn = true;

  const dimsBtn = h('button', {
    class: 'btn',
    type: 'button',
    'aria-pressed': 'false',
    onclick: () => {
      dimsOn = !dimsOn;
      dimsBtn.setAttribute('aria-pressed', String(dimsOn));
      handlers.onDims(dimsOn);
    },
  }, 'Показати розміри');

  const facadesBtn = h('button', {
    class: 'btn',
    type: 'button',
    'aria-pressed': 'true',
    onclick: () => {
      facadesOn = !facadesOn;
      facadesBtn.setAttribute('aria-pressed', String(facadesOn));
      facadesBtn.textContent = facadesOn ? 'Фасади: показані' : 'Фасади: приховані';
      handlers.onFacadesVisible(facadesOn);
    },
  }, 'Фасади: показані');

  const explodeBtn = h('button', { class: 'btn', type: 'button', onclick: () => handlers.onExplode(1) }, 'Розібрати');
  const assembleBtn = h('button', { class: 'btn', type: 'button', onclick: () => handlers.onExplode(0) }, 'Зібрати');

  const colorName = h('div', { class: 'hint' }, colors[0]?.name ?? '');
  const swatches = colors.map((c, i) => h('button', {
    class: 'swatch',
    type: 'button',
    title: c.name,
    'aria-label': c.name,
    style: `background:${c.hex}`,
    onclick: () => pickColor(i),
  }));

  // Позначає вибраний колір без виклику обробника (для старту)
  function markColor(i) {
    swatches.forEach((s, j) => s.classList.toggle('active', i === j));
    colorName.textContent = colors[i].name;
  }
  function pickColor(i) {
    markColor(i);
    handlers.onFacadeColor(colors[i].hex);
  }
  markColor(0);

  const resetBtn = h('button', { class: 'btn btn-wide', type: 'button', onclick: () => handlers.onReset() }, 'Скинути вид');

  container.replaceChildren(
    h('div', { class: 'section-title' }, 'Вигляд'),
    h('div', { class: 'row' }, dimsBtn, facadesBtn),
    h('div', { class: 'section-title' }, 'Розбирання'),
    h('div', { class: 'row' }, explodeBtn, assembleBtn),
    h('div', { class: 'section-title' }, 'Колір фасадів'),
    h('div', { class: 'swatches' }, ...swatches),
    colorName,
    h('div', { class: 'row' }, resetBtn),
  );
}

/** Вікно з назвою і розмірами вибраної деталі. */
export function createInfoBox(el) {
  return {
    show(part) {
      if (!part) {
        el.replaceChildren(h('div', { class: 'hint' }, 'Натисніть на деталь, щоб побачити її назву й розміри.'));
        return;
      }
      const d = part.data;
      el.replaceChildren(
        h('strong', {}, d.name ?? d.id),
        h('div', { class: 'hint' }, `Розміри: ${d.w} × ${d.h} × ${d.d} мм (ширина × висота × глибина)`),
        h('div', { class: 'hint' }, `Матеріал: ${part.key === 'facade' ? 'фасад' : 'корпус'}`),
      );
    },
  };
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
