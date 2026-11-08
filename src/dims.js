// Розмірні лінії на моделі, як на кресленні: виносні лінії, засічки, число посередині.
// Два режими:
//   • загальний — ланцюжок ширин блоків по кожному фронту (і для повернутих шаф Г/П-кухні),
//     висоти блоків (кожна різна висота — один раз) і загальні габарити;
//   • вибране — ширина, висота й глибина вибраної деталі або блоку.
// Лінії ставляться з боку камери (переставляються, коли модель обертають).
import * as THREE from 'three';

const COLOR_MAIN = 0x1f5fbf;
const COLOR_CHAIN = 0xa8834c;

export function createDims(scene, labelsLayer) {
  const root = new THREE.Group();
  root.renderOrder = 20;
  root.visible = false;
  scene.add(root);

  const matMain = new THREE.LineBasicMaterial({ color: COLOR_MAIN, depthTest: false, transparent: true });
  const matChain = new THREE.LineBasicMaterial({ color: COLOR_CHAIN, depthTest: false, transparent: true });

  let specs = [];      // що показати: [{ a, b, n (напрям виносу), text, kind, prio }]
  let labels = [];     // DOM-підписи у тому ж порядку
  let builtKey = '';   // з якого боку камери побудовано
  let source = null;   // () => specs для поточного боку

  /** Одна розмірна лінія: від a до b, винесена на off уздовж n. */
  function addLine(pos, a, b, n, off) {
    const A = a.clone().addScaledVector(n, off);
    const B = b.clone().addScaledVector(n, off);
    const ext = off * 0.15 + 8;
    // Виносні лінії від предмета до розмірної
    pos.push(a.clone().addScaledVector(n, Math.min(off, 12)), A.clone().addScaledVector(n, ext));
    pos.push(b.clone().addScaledVector(n, Math.min(off, 12)), B.clone().addScaledVector(n, ext));
    // Сама лінія
    pos.push(A, B);
    // Засічки під 45° на кінцях
    const d = B.clone().sub(A).normalize();
    const tick = d.clone().add(n).normalize().multiplyScalar(14);
    for (const P of [A, B]) pos.push(P.clone().sub(tick), P.clone().add(tick));
    return A.clone().add(B).multiplyScalar(0.5);
  }

  function rebuild() {
    root.clear();
    const list = source ? source() : [];
    const main = [];
    const chain = [];
    specs = [];
    for (const s of list) {
      const mid = addLine(s.kind === 'chain' ? chain : main, s.a, s.b, s.n, s.off);
      specs.push({ ...s, mid });
    }
    for (const [arr, mat] of [[main, matMain], [chain, matChain]]) {
      if (!arr.length) continue;
      const g = new THREE.BufferGeometry().setFromPoints(arr);
      const l = new THREE.LineSegments(g, mat);
      l.renderOrder = 20;
      l.frustumCulled = false;
      root.add(l);
    }
    labels = specs.map((s) => {
      const el = document.createElement('div');
      el.className = `dim-label${s.kind === 'chain' ? ' dim-chain' : ''}`;
      el.textContent = s.text;
      return el;
    });
    labelsLayer.replaceChildren(...labels);
  }

  return {
    /** fn(side) → список ліній; side = { x: -1|1, z: -1|1 } — з якого боку камера. */
    show(fn) {
      source = fn;
      builtKey = '';
      root.visible = !!fn;
      labelsLayer.hidden = !fn;
      if (!fn) { root.clear(); labelsLayer.replaceChildren(); specs = []; labels = []; }
    },
    get active() { return !!source; },
    update(camera, target, width, height) {
      if (!source) return;
      const side = {
        x: camera.position.x >= target.x ? 1 : -1,
        z: camera.position.z >= target.z ? 1 : -1,
      };
      const key = `${side.x},${side.z}`;
      if (key !== builtKey) {
        builtKey = key;
        const fn = source;
        source = () => fn(side);
        rebuild();
        source = fn;
      }
      // Підписи: проєкція середини лінії; перекриті менш важливими — ховаємо
      const placed = [];
      for (let i = 0; i < specs.length; i++) {
        const el = labels[i];
        const p = specs[i].mid.clone().project(camera);
        if (p.z <= -1 || p.z >= 1) { el.style.display = 'none'; continue; }
        const x = ((p.x + 1) / 2) * width;
        const y = ((1 - p.y) / 2) * height;
        el.style.display = '';
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        const w = (el.offsetWidth || 50) / 2 + 2;
        const h = (el.offsetHeight || 20) / 2 + 2;
        const hit = placed.some((r) => Math.abs(r.x - x) < r.w + w && Math.abs(r.y - y) < r.h + h);
        if (hit) { el.style.display = 'none'; continue; }
        placed.push({ x, y, w, h });
      }
    },
  };
}

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const mm = (v) => `${Math.round(v)}`;

/** Розміри вибраного: ширина, висота, глибина габариту з боку камери. */
export function boxDims(box) {
  const s = box.getSize(new THREE.Vector3());
  const off = THREE.MathUtils.clamp(Math.max(s.x, s.y, s.z) * 0.12, 40, 160);
  return (side) => {
    const zF = side.z > 0 ? box.max.z : box.min.z;
    const xF = side.x > 0 ? box.max.x : box.min.x;
    const xB = side.x > 0 ? box.min.x : box.max.x;
    const out = [];
    if (s.x > 1) out.push({ a: V(box.min.x, box.min.y, zF), b: V(box.max.x, box.min.y, zF), n: V(0, -1, 0), off, text: mm(s.x) });
    if (s.y > 1) out.push({ a: V(xB, box.min.y, zF), b: V(xB, box.max.y, zF), n: V(-side.x, 0, 0), off, text: mm(s.y) });
    if (s.z > 1) out.push({ a: V(xF, box.min.y, box.min.z), b: V(xF, box.min.y, box.max.z), n: V(0, -1, 0), off, text: mm(s.z) });
    return out;
  };
}

/**
 * Загальні розміри: blocks = [{ box, facing: Vector3 (куди дивиться фронт) }], bounds = габарит меблів.
 * Для кожного фронту — ланцюжок ширин блоків, висоти (без повторів), і загальні габарити.
 */
export function overallDims(blocks, bounds) {
  // Габарит — за блоками (без кріплень, що можуть стирчати); якщо блоків немає — загальний
  const B = new THREE.Box3();
  for (const bl of blocks) B.union(bl.box);
  if (B.isEmpty()) B.set(bounds.min.clone(), bounds.max.clone());
  const size = B.getSize(new THREE.Vector3());
  const step = THREE.MathUtils.clamp(Math.max(size.x, size.z) * 0.06, 60, 180);

  // Ряди за напрямком фронту: +Z, −Z, +X, −X
  const runs = new Map();
  for (const bl of blocks) {
    const k = Math.abs(bl.facing.z) >= Math.abs(bl.facing.x) ? (bl.facing.z >= 0 ? 'z+' : 'z-') : (bl.facing.x >= 0 ? 'x+' : 'x-');
    if (!runs.has(k)) runs.set(k, []);
    runs.get(k).push(bl);
  }

  return (side) => {
    const out = [];
    const y0 = B.min.y;
    for (const [k, list] of runs) {
      const alongX = k[0] === 'z';
      const sgn = k[1] === '+' ? 1 : -1;
      const ax = alongX ? 'x' : 'z';
      const n = alongX ? V(0, 0, sgn) : V(sgn, 0, 0);
      // Площина фронту ряду
      const front = Math.max(...list.map((bl) => sgn * (alongX ? (sgn > 0 ? bl.box.max.z : bl.box.min.z) : (sgn > 0 ? bl.box.max.x : bl.box.min.x)))) * sgn;
      const at = (u) => (alongX ? V(u, y0, front) : V(front, y0, u));
      const sorted = [...list].sort((a, b) => a.box.min[ax] - b.box.min[ax]);
      const lo = sorted[0].box.min[ax];
      const hi = Math.max(...sorted.map((bl) => bl.box.max[ax]));
      // Ланцюжок: кожен блок своєю ділянкою (блоки, що перекривають майже весь ряд, — пропускаємо)
      if (sorted.length > 1) {
        for (const bl of sorted) {
          const w = bl.box.max[ax] - bl.box.min[ax];
          if (w > (hi - lo) * 0.9) continue;
          out.push({ a: at(bl.box.min[ax]), b: at(bl.box.max[ax]), n, off: step, text: mm(w), kind: 'chain' });
        }
      }
      // Загальна довжина ряду
      out.push({ a: at(lo), b: at(hi), n, off: sorted.length > 1 ? step * 2 : step, text: mm(hi - lo), prio: 1 });

      // Висоти: кожна різна висота — один раз, на блоці з краю, ближчого до камери
      const seen = new Set();
      const byEdge = [...sorted].sort((a, b) => (alongX ? side.x : -side.z * sgn) * (b.box.max[ax] - a.box.max[ax]));
      for (const bl of byEdge) {
        const h = Math.round(bl.box.max.y - bl.box.min.y);
        if (h < 150 || [...seen].some((s) => Math.abs(s - h) < 15)) continue;
        seen.add(h);
        const edge = (alongX ? side.x : side.z) > 0 ? bl.box.max[ax] : bl.box.min[ax];
        const p = alongX ? V(edge, bl.box.min.y, front) : V(front, bl.box.min.y, edge);
        const q = p.clone(); q.y = bl.box.max.y;
        const outward = alongX ? V((side.x > 0 ? 1 : -1), 0, 0) : V(0, 0, side.z > 0 ? 1 : -1);
        out.push({ a: p, b: q, n: outward, off: step * (seen.size), text: mm(h), kind: 'chain' });
      }
    }
    // Загальна глибина по боку, ближчому до камери (якщо ряд один — з нього вона зрозуміла не завжди)
    const xF = side.x > 0 ? B.max.x : B.min.x;
    out.push({ a: V(xF, B.min.y, B.min.z), b: V(xF, B.min.y, B.max.z), n: V(side.x, 0, 0), off: step, text: mm(size.z), prio: 1 });
    // Загальна висота — на дальньому куті, щоб не плутатись з висотами блоків
    const xB = side.x > 0 ? B.min.x : B.max.x;
    const zF = side.z > 0 ? B.max.z : B.min.z;
    out.push({ a: V(xB, B.min.y, zF), b: V(xB, B.max.y, zF), n: V(-side.x, 0, 0), off: step * 2.5, text: mm(size.y), prio: 1 });
    // Важливі (загальні) — першими, щоб при перекритті лишались вони
    return out.sort((a, b) => (b.prio || 0) - (a.prio || 0));
  };
}
