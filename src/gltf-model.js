import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Модель з БАЗИСу у форматі GLB (конвертується з .dae скриптом tools/convert-dae.mjs).
// Одиниці файлу — мм, вісь Y вгору (як і в JSON-моделях).
//
// БАЗИС ріже кожну деталь на кілька сіток (пласть, крайки, матеріали окремо),
// тому «деталь» тут — найближчий іменований вузол, а не окрема сітка.

// Розбирання дворівневе: блоки розходяться між собою (GROUP), деталі — всередині блоку (INNER)
const EXPLODE_FACTOR = 1;
const EXPLODE_GROUP = 1.4;  // блоки між собою (лише по X)
const EXPLODE_INNER = 0.5; // деталі всередині блоку: частка відстані до центру блоку
const EXPLODE_GAP = 110;     // мінімальний відступ кожної плити, мм
const HIGHLIGHT = new THREE.Color(0x2f6fd6);

// БАЗИС пише назву так: «Назва\rАртикул» (інколи ще дубль через табуляцію)
function splitName(raw) {
  const [head, ...rest] = String(raw || '').split('\r');
  let title = head.split('\t')[0].trim();
  // Хвости від assimp: «Фасад_4» (номер дубля), «Стиралка_Bosch_…» (пробіли замінені на _)
  title = title.replace(/_\d+$/, '');
  if (!title.includes(' ') && title.includes('_')) title = title.replace(/_/g, ' ');
  return { title, article: rest.join(' ').trim() };
}

// Технічні назви вузлів, які не варто показувати замовнику
function isMeaningful(name) {
  const n = splitName(name).title;
  return n !== ''
    && !/^\d+$/.test(n)
    && !/^\d+x\d+$/i.test(n)
    && !/^(node|mesh)([ _][0-9]+)?( instance)?$/i.test(n)
    && !/^(model|модель)$/i.test(n);
}

// Найближчий іменований вузол (сам обʼєкт або предок)
function partNode(obj) {
  for (let o = obj; o; o = o.parent) if (isMeaningful(o.name)) return o;
  return obj;
}

// Чи є серед предків вузол, назва якого підходить під правило
function hasAncestor(obj, test) {
  for (let o = obj; o; o = o.parent) if (test(splitName(o.name).title.toLowerCase())) return true;
  return false;
}

// Атрибут у Float32 (meshopt-квантизовані Int16/Int8 не можна трансформувати й зливати як є)
function toFloat(attr) {
  const n = attr.count;
  const s = attr.itemSize;
  const out = new Float32Array(n * s);
  const get = [attr.getX, attr.getY, attr.getZ, attr.getW];
  for (let i = 0; i < n; i++) for (let k = 0; k < s; k++) out[i * s + k] = get[k].call(attr, i);
  return new THREE.BufferAttribute(out, s);
}

// Зливає кілька сіток в одну геометрію у світових координатах
function mergeWorld(list) {
  const withUv = list.some((m) => m.geometry.attributes.uv);
  const geoms = list.map((m) => {
    const src = m.geometry;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', toFloat(src.attributes.position));
    if (src.attributes.normal) g.setAttribute('normal', toFloat(src.attributes.normal));
    else g.computeVertexNormals();
    if (withUv) {
      g.setAttribute('uv', src.attributes.uv ? toFloat(src.attributes.uv)
        : new THREE.BufferAttribute(new Float32Array(src.attributes.position.count * 2), 2));
    }
    const index = src.index
      ? Array.from(src.index.array)
      : Array.from({ length: src.attributes.position.count }, (_, i) => i);
    g.setIndex(index);
    g.applyMatrix4(m.matrixWorld);
    return g;
  });
  return geoms.length === 1 ? geoms[0] : mergeGeometries(geoms, false);
}

// Кріплення й обробки всередині деталей — у режимі «як бачить клієнт» ховаються
const TECHNICAL = /^(#[0-9]+ *)?(шкант|конфірмат|комформат|конфирмат|мініфікс|минификс|дюбель|отвір|отверстие|саморіз|саморез|шуруп|стяжк|полкотримач|ексцентрик|линия стыка|лінія стику)/i;

const isFacadeName = (n) => n.startsWith('фасад') || n === 'двері';
const isRoomName = (n) => n === 'стіна' || n === 'заміри';

// ---- Кріплення, яких немає в .dae: шканти, конфірмати, мініфікси, дюбелі ----
const FASTENER_TYPES = [
  { re: /шкант/i, color: 0xd9b98a, metal: 0, d: 8, l: 30 },
  { re: /конфірмат|конфирмат|комформат/i, color: 0x9aa0a6, metal: 0.8, d: 7, l: 50 },
  { re: /мініфікс|минификс/i, color: 0xb7bcc2, metal: 0.8, d: 15, l: 13 },
  { re: /дюбель/i, color: 0xe6e2da, metal: 0, d: 8, l: 30 },
  { re: /саморіз|саморез|шуруп/i, color: 0x8d9298, metal: 0.8, d: 4, l: 16 },
];

// Мініфікс (Hettich Rastex + болт Twister): у БАЗИСі є лише болт; ексцентрик домальовуємо самі.
// Перевірено на моделі: точка болта лежить у плиті, в торець якої він входить; болт іде вздовж −X на ~34 мм.
const MINIFIX_RE = /twister|rastex/i;

function boardBoxes(root) {
  const out = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const names = [].concat(o.material).map((m) => (m && m.name) || '').join(' ');
    if (!/дсп|хдф|мдф|двп|стільниц|столешн|крайка|kronospan|egger|swiss|cleaf/i.test(names)) return;
    out.push(new THREE.Box3().setFromObject(o));
  });
  return out;
}

function addMinifix(root, f, boxes, cache) {
  const axis = new THREE.Vector3(...f.ax).negate().normalize(); // болт: від точки вздовж −X
  const p = new THREE.Vector3(...f.p);
  const up = new THREE.Vector3(0, 1, 0);
  const main = [Math.abs(axis.x), Math.abs(axis.y), Math.abs(axis.z)];
  const boltIdx = main.indexOf(Math.max(...main));
  // Плита з ексцентриком: містить точку, і її товщина — не вздовж болта
  let camAxis = null;
  for (const b of boxes) {
    if (!b.clone().expandByScalar(0.5).containsPoint(p)) continue;
    const s = b.getSize(new THREE.Vector3());
    const thinIdx = s.x <= s.y && s.x <= s.z ? 0 : s.y <= s.z ? 1 : 2;
    if (thinIdx === boltIdx) continue;
    camAxis = new THREE.Vector3(thinIdx === 0 ? 1 : 0, thinIdx === 1 ? 1 : 0, thinIdx === 2 ? 1 : 0);
    break;
  }
  if (!cache.boltGeo) {
    cache.boltGeo = new THREE.CylinderGeometry(3, 3, 34, 12);
    cache.camGeo = new THREE.CylinderGeometry(7.5, 7.5, 12, 24);
    cache.metal = new THREE.MeshStandardMaterial({ color: 0xb7bcc2, metalness: 0.8, roughness: 0.4, name: 'Мініфікс' });
  }
  const bolt = new THREE.Object3D();
  bolt.name = f.name;
  const bm = new THREE.Mesh(cache.boltGeo, cache.metal);
  bm.quaternion.setFromUnitVectors(up, axis);
  bm.position.copy(p).addScaledVector(axis, 17);
  bolt.add(bm);
  root.add(bolt);
  if (camAxis) {
    const cam = new THREE.Object3D();
    cam.name = 'Мініфікс Rastex 15 (ексцентрик)';
    const cm = new THREE.Mesh(cache.camGeo, cache.metal);
    cm.quaternion.setFromUnitVectors(up, camAxis);
    cm.position.copy(p);
    cam.add(cm);
    root.add(cam);
  }
}

function addFasteners(root, list) {
  const cache = new Map();
  const mfCache = {};
  let boxes = null;
  const up = new THREE.Vector3(0, 1, 0);
  for (const f of list) {
    if (MINIFIX_RE.test(f.name || '') && Array.isArray(f.p) && Array.isArray(f.ax)) {
      boxes = boxes || boardBoxes(root);
      addMinifix(root, f, boxes, mfCache);
      continue;
    }
    const type = FASTENER_TYPES.find((t) => t.re.test(f.name || ''));
    if (!type || !Array.isArray(f.p) || !Array.isArray(f.ax)) continue; // решта (ручки, ніжки) вже має геометрію
    // Розмір з назви: «8х30 мм», «6,4х50 мм»
    const m = /([0-9]+(?:[.,][0-9]+)?) *[хx×] *([0-9]+(?:[.,][0-9]+)?)/i.exec(f.name);
    const d = m ? parseFloat(m[1].replace(',', '.')) : type.d;
    const l = m ? parseFloat(m[2].replace(',', '.')) : type.l;
    const key = `${type.color}|${d}|${l}`;
    if (!cache.has(key)) {
      cache.set(key, {
        geo: new THREE.CylinderGeometry(d / 2, d / 2, l, 14),
        mat: new THREE.MeshStandardMaterial({ color: type.color, metalness: type.metal, roughness: 0.5, name: f.name }),
      });
    }
    const { geo, mat } = cache.get(key);
    // Вісь кріплення в БАЗИСі — локальна X (перевірено: так усі шканти й конфірмати перетинають стик плит)
    const axis = new THREE.Vector3(...f.ax).normalize();
    const node = new THREE.Object3D();
    node.name = f.name;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.quaternion.setFromUnitVectors(up, axis);
    mesh.position.set(...f.p).addScaledVector(axis, l / 2); // від точки кріплення вздовж осі
    node.add(mesh);
    root.add(node);
  }
  root.updateMatrixWorld(true);
}

/** «ДСП лам. Kronospan 0101 PE Білий фасадний 18мм … 2800х2070х18 мм» → «ДСП лам. Kronospan 0101 PE Білий фасадний» */
function shortMaterial(name) {
  const cut = name.search(/ [0-9]+([.,][0-9]+)? ?мм| [0-9]{3,4} ?[хx×] ?[0-9]| [+] | (вологост|ВОЛОГОСТ)/);
  return (cut > 0 ? name.slice(0, cut) : name).trim();
}

/** Мініатюра для кнопки вибору матеріалу: шматок текстури (dataURL) або CSS-колір. */
function swatchOf(m) {
  try {
    const img = m.map && m.map.image;
    if (img && img.width) {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const side = Math.min(img.width, img.height, 512);
      c.getContext('2d').drawImage(img, 0, 0, side, side, 0, 0, 64, 64);
      return `center/cover url(${c.toDataURL('image/jpeg', 0.8)})`;
    }
  } catch { /* текстура недоступна — беремо колір */ }
  return m.color ? `#${m.color.getHexString()}` : '#ccc';
}

/**
 * Шукає, що відкривається. Двері — фасад, біля якого стоять петлі (сторона петель = вісь повороту).
 * Шухляда — фасад без петель, за яким стоять деталі ящика (боки, дно). Ручки й петлі рухаються з фасадом.
 */
function findOpeners(parts) {
  const by = (re) => parts.filter((p) => p.key !== 'room' && re.test(p.name.title));
  const hinges = by(/петл/i);
  const handles = by(/ручк/i);
  const boxBits = parts.filter((p) => p.key !== 'facade' && p.key !== 'room' && /ящик|яшик|шухляд/i.test(p.name.title));
  const used = new Set();
  const inside = (c, b, pad) => c.x > b.min.x - pad && c.x < b.max.x + pad && c.y > b.min.y - pad && c.y < b.max.y + pad;
  const openers = [];

  // Кожна петля належить лише одному фасаду — найближчому до неї (петля біля стику двох фасадів
  // інакше «чіплялась» би до обох). Відстань — від центру петлі до габариту фасаду.
  const facadesList = parts.filter((p) => p.key === 'facade');
  const hingeOwner = new Map();
  for (const hg of hinges) {
    let best = null;
    let bestD = Infinity;
    for (const f of facadesList) {
      const d = f.box.distanceToPoint(hg.center);
      if (d < bestD) { bestD = d; best = f; }
    }
    if (best && bestD < 160) hingeOwner.set(hg, best);
  }

  for (const f of facadesList) {
    const b = f.box;
    // Петлі: у межах фасаду по X/Y, по глибині — трохи за фасадом
    const near = hinges.filter((h) => !used.has(h) && hingeOwner.get(h) === f);
    // Ручки: на фасаді, спереду
    const hs = handles.filter((h) => !used.has(h) && inside(h.center, b, 10) && h.center.z > b.max.z - 20 && h.center.z < b.max.z + 80);

    if (near.length) {
      // Де стоять петлі — та сторона й є віссю повороту:
      //  збоку (ліворуч/праворуч) — звичайні двері, вісь вертикальна;
      //  внизу — відкидна дверка (вниз на себе), вгорі — підйомна (вгору), вісь горизонтальна
      const avgX = near.reduce((s, h) => s + h.center.x, 0) / near.length;
      const avgY = near.reduce((s, h) => s + h.center.y, 0) / near.length;
      const xs = near.map((h) => h.center.x);
      const ys = near.map((h) => h.center.y);
      const spreadX = Math.max(...xs) - Math.min(...xs);
      const spreadY = Math.max(...ys) - Math.min(...ys);
      // Відстань від петель до найближчого краю — у частках розміру фасаду
      const toSide = Math.min(avgX - b.min.x, b.max.x - avgX) / Math.max(1, f.size.x);
      const toEdgeY = Math.min(avgY - b.min.y, b.max.y - avgY) / Math.max(1, f.size.y);
      const horizontal = near.length > 1 ? spreadX > spreadY : toEdgeY < toSide;
      let op;
      if (horizontal) {
        const bottom = avgY < f.center.y;
        op = {
          kind: 'door',
          axis: new THREE.Vector3(1, 0, 0),
          pivot: new THREE.Vector3(0, bottom ? b.min.y : b.max.y, b.min.z),
          // нижній край — верх іде на нас і вниз (+кут), верхній край — низ іде на нас і вгору (−кут)
          sign: bottom ? 1 : -1,
          maxAngle: THREE.MathUtils.degToRad(bottom ? 88 : 95),
        };
      } else {
        const left = avgX < f.center.x;
        op = {
          kind: 'door',
          axis: new THREE.Vector3(0, 1, 0),
          pivot: new THREE.Vector3(left ? b.min.x : b.max.x, 0, b.min.z),
          sign: left ? -1 : 1, // лівий край — вільний правий край іде на нас (−кут), і навпаки
          maxAngle: THREE.MathUtils.degToRad(95),
        };
      }
      openers.push({ ...op, facade: f, parts: [f, ...near, ...hs] });
      near.concat(hs).forEach((p) => used.add(p));
      continue;
    }

    // Деталі ящика: перекриваються з фасадом по X, центр по Y — у межах фасаду, стоять позаду
    const box = boxBits.filter((p) => !used.has(p)
      && p.box.max.x > b.min.x + 10 && p.box.min.x < b.max.x - 10
      && p.center.y > b.min.y - 20 && p.center.y < b.max.y + 20
      && p.center.z < b.min.z);
    if (box.length) {
      const depth = Math.max(...box.map((p) => p.size.z));
      openers.push({ kind: 'drawer', facade: f, parts: [f, ...box, ...hs], slide: Math.max(150, depth * 0.75) });
      box.concat(hs).forEach((p) => used.add(p));
    }
  }
  return openers;
}

/** Завантажує GLB з ArrayBuffer і повертає модель з тим самим інтерфейсом, що й buildFurniture. */
export async function loadGltfModel(buffer, title) {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.parseAsync(buffer, '');
  gltf.scene.updateMatrixWorld(true);
  // Параметри виробу з БАЗИСу (назва, префікс, артикул, замовлення), якщо конвертер їх додав
  const info = gltf.scene.userData?.m3 || gltf.userData?.m3 || null;
  // Кріплення з БАЗИСу (скрипт «Експорт для 3D-перегляду»): у .dae їх немає, тому малюємо самі.
  // Розмір беремо з назви («8х30», «6,4х50»), вісь — локальна X кріплення, точка — його початок.
  if (info && Array.isArray(info.fasteners)) addFasteners(gltf.scene, info.fasteners);


  // Сітки → деталі (поки що оригінальні сітки файлу)
  const byNode = new Map();
  gltf.scene.traverse((obj) => {
    if (!obj.isMesh) return;
    const node = partNode(obj);
    let part = byNode.get(node);
    if (!part) {
      part = {
        node,
        name: splitName(node.name),
        key: hasAncestor(node, isRoomName) ? 'room' : hasAncestor(node, isFacadeName) ? 'facade' : 'corpus',
        source: [],
        meshes: [],
        box: new THREE.Box3(),
      };
      byNode.set(node, part);
    }
    part.source.push(obj);
  });
  const parts = [...byNode.values()];
  if (parts.length === 0) throw new Error('У файлі моделі немає жодної деталі.');

  // Групи: блок верхнього рівня з БАЗИСу («Шафа», «МН - 1 Фасад L», «Стіна»…), до якого належить деталь
  const isContainer = (n) => !n || /^(node|model|модель|заміри)$/i.test(splitName(n.name).title) || n.isScene;
  const groups = new Map();
  for (const part of parts) {
    let g = part.node;
    while (g.parent && !isContainer(g.parent)) g = g.parent;
    if (!groups.has(g)) groups.set(g, { name: splitName(g.name).title || part.name.title, parts: [] });
    part.group = groups.get(g);
    part.group.parts.push(part);
    // Технічні деталі, яких клієнт зовні не бачить
    part.technical = TECHNICAL.test(part.name.title);
  }

  // Злиття: у межах деталі всі сітки з однаковим матеріалом стають однією сіткою у світових координатах.
  // Було ~2400 викликів малювання на кадр, стає кілька сотень — телефон це тягне.
  const group = new THREE.Group();
  const meshes = [];
  for (const part of parts) {
    const byMat = new Map();
    for (const m of part.source) {
      if (!byMat.has(m.material)) byMat.set(m.material, []);
      byMat.get(m.material).push(m);
    }
    for (const [material, list] of byMat) {
      const geometry = mergeWorld(list);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = part.node.name;
      group.add(mesh);
      const rec = { mesh, part, home: new THREE.Vector3(), original: material };
      part.meshes.push(rec);
      geometry.computeBoundingBox();
      part.box.union(geometry.boundingBox);
      meshes.push(rec);
    }
    delete part.source;
  }

  // Габарити меблів (без стін і замірів), а якщо меблів немає — усього файлу
  const furnBox = new THREE.Box3();
  const allBox = new THREE.Box3();
  for (const p of parts) {
    p.size = p.box.getSize(new THREE.Vector3());
    p.center = p.box.getCenter(new THREE.Vector3());
    allBox.union(p.box);
    if (p.key !== 'room') furnBox.union(p.box);
  }
  const box = furnBox.isEmpty() ? allBox : furnBox;
  const bounds = {
    min: box.min.clone(),
    max: box.max.clone(),
    size: box.getSize(new THREE.Vector3()),
    center: box.getCenter(new THREE.Vector3()),
    floorY: allBox.min.y,
    // Кімната відкрита спереду: дивимось спереду трохи зліва, щоб бокова стіна не закривала меблі
    viewDir: [-0.25, 0.3, 1],
  };

  // Розбирання: уся деталь зсувається від центру меблів (сітки вже у світових координатах)
  // Центр кожного блоку (без стін) — щоб розводити блоки між собою, а деталі — від центру свого блоку
  const groupCenter = new Map();
  for (const p of parts) {
    if (p.key === 'room') continue;
    if (!groupCenter.has(p.group)) groupCenter.set(p.group, new THREE.Box3());
    groupCenter.get(p.group).union(p.box);
  }
  for (const [grp, box] of groupCenter) groupCenter.set(grp, box.getCenter(new THREE.Vector3()));
  // Розбирання як монтажна схема:
  //  - блоки (тумба, пенал, техніка) розходяться між собою лише в боки (по X);
  //  - кожна плита рухається вздовж своєї товщини назовні від центру свого блоку
  //    (боковини — вліво/вправо, кришка/дно — вгору/вниз, задня стінка — назад, полиці — по висоті);
  //  - решта (техніка, раковина) — від центру блоку.
  const AX = ['x', 'y', 'z'];
  const outwardOf = (part) => {
    const gc = groupCenter.get(part.group) || bounds.center;
    const off = new THREE.Vector3((gc.x - bounds.center.x) * EXPLODE_GROUP, 0, 0);
    if (part.board && part.key !== 'room') {
      const sz = part.size;
      const i = sz.x <= sz.y && sz.x <= sz.z ? 0 : sz.y <= sz.z ? 1 : 2; // вісь товщини
      const k = AX[i];
      const d = part.center[k] - gc[k];
      const sign = Math.abs(d) > 1 ? Math.sign(d) : (k === 'z' ? 1 : -1);
      off[k] += sign * (EXPLODE_GAP + Math.abs(d) * EXPLODE_INNER);
    } else {
      off.add(part.center.clone().sub(gc).multiplyScalar(EXPLODE_INNER));
    }
    return off;
  };
  // Дрібна фурнітура (тримачі, петлі, профілі) рухається разом із деталлю, на якій стоїть:
  // шукаємо плиту, габарит якої (з запасом 25 мм) містить центр фурнітури, — найменшу з таких
  // (у БАЗИСі фурнітура часто лежить окремими блоками верхнього рівня, тому шукаємо серед усіх плит)
  // Ознака «плита» (ДСП, ХДФ, стільниця, стіни…) потрібна вже тут, тому рахуємо заздалегідь
  for (const part of parts) {
    const names = part.meshes.map((r) => [].concat(r.original).map((m) => m.name || '').join(' ')).join(' ');
    part.board = part.key === 'room' || /дсп|хдф|мдф|двп|стільниц|столешн|крайка|kronospan|egger|swiss|скло|стекло|стіна|підлога/i.test(names);
  }
  const boards = parts.filter((p) => p.board && p.key !== 'room');
  for (const p of parts) {
    if (p.board || p.key === 'room') continue;
    let host = null;
    let best = Infinity;
    for (const b of boards) {
      if (!b.box.clone().expandByScalar(25).containsPoint(p.center)) continue;
      const vol = b.size.x * b.size.y * b.size.z;
      if (vol < best) { best = vol; host = b; }
    }
    // Велика окрема річ (техніка, раковина, ніжки) лишається сама по собі
    const big = Math.max(p.size.x, p.size.y, p.size.z) > 250;
    p.host = big ? null : host;
  }
  for (const rec of meshes) rec.outward = outwardOf(rec.part.host || rec.part);

  // Матеріали з assimp інколи приходять «металевими» — для меблів це зайве
  for (const rec of meshes) {
    for (const m of [].concat(rec.mesh.material)) {
      if ('metalness' in m && m.metalness > 0.5 && !/хром|нікел|метал|сталь/i.test(m.name)) m.metalness = 0;
    }
  }

  // ---- Відкривання: двері обертаються на петлях, шухляди висуваються ----
  const openers = findOpeners(parts);
  for (const op of openers) {
    // Усе, що рухається разом із фасадом, і розбирається разом з ним
    // Шухляда чи двері рухаються цілими: зсув фасаду + додатково вперед, щоб ящик повністю вийшов із корпусу
    const shared = outwardOf(op.facade).add(new THREE.Vector3(0, 0, op.kind === 'drawer' ? op.slide : 120));
    op.box = new THREE.Box3();
    for (const p of op.parts) op.box.union(p.box);
    for (const p of op.parts) for (const rec of p.meshes) { rec.outward = shared; rec.opener = op; }
  }

  // Розбирання не опускає деталі нижче найнижчої точки меблів (інакше вони «провалюються» в підлогу)
  for (const rec of meshes) {
    const box = rec.opener ? rec.opener.box : rec.part.box;
    const lowest = (bounds.min.y - box.min.y) / EXPLODE_FACTOR; // на скільки максимум можна вниз
    if (rec.outward.y < lowest) rec.outward = rec.outward.clone().setY(Math.min(0, lowest));
  }

  // Тривалість анімацій у секундах (залежить від часу, а не від частоти кадрів)
  const OPEN_TIME = 1.3;      // одні двері чи шухляда
  const OPEN_STAGGER = 0.7;   // наступні стартують, коли попередні майже відкрились: по черзі, а не всі разом
  const EXPLODE_TIME = 1.0;   // одна деталь
  const EXPLODE_SPREAD = 1.6; // за цей час «хвиля» розбирання проходить згори донизу
  // Порядок відкривання: зліва направо, згори вниз
  openers.sort((a, b) => (a.facade.center.x - b.facade.center.x) || (b.facade.center.y - a.facade.center.y));
  openers.forEach((op, i) => { op.delay = i * OPEN_STAGGER; });
  const OPEN_TOTAL = OPEN_TIME + Math.max(0, openers.length - 1) * OPEN_STAGGER;

  // Розбирання хвилею: згори вниз; деталі, що відкриваються разом з фасадом, рухаються з ним
  const ys = parts.filter((p) => p.key !== 'room').map((p) => p.center.y);
  const topY = Math.max(...ys);
  const bottomY = Math.min(...ys);
  for (const p of parts) p.explodeDelay = topY > bottomY ? ((topY - p.center.y) / (topY - bottomY)) * EXPLODE_SPREAD : 0;
  for (const op of openers) for (const p of op.parts) p.explodeDelay = op.facade.explodeDelay;
  const EXPLODE_TOTAL = EXPLODE_TIME + EXPLODE_SPREAD;

  let explodeTarget = 0;
  let explodeNow = 0; // 0 … EXPLODE_TOTAL
  let openTarget = 0;
  let openClock = 0; // 0 … OPEN_TOTAL
  const Y = new THREE.Vector3(0, 1, 0);
  const smooth = (t) => t * t * t * (t * (t * 6 - 15) + 10); // м'який старт і м'яка зупинка
  const towards = (now, target, delta) => (now < target ? Math.min(target, now + delta) : Math.max(target, now - delta));

  function update(dt = 1 / 60) {
    const openGoal = openTarget * OPEN_TOTAL;
    const explodeGoal = explodeTarget * EXPLODE_TOTAL;
    if (explodeNow === explodeGoal && openClock === openGoal) return;
    explodeNow = towards(explodeNow, explodeGoal, dt);
    openClock = towards(openClock, openGoal, dt);
    for (const rec of meshes) {
      if (rec.part.key === 'room') continue; // стіни не рухаємо
      const ex = smooth(Math.min(1, Math.max(0, (explodeNow - rec.part.explodeDelay) / EXPLODE_TIME)));
      const e = rec.outward.clone().multiplyScalar(EXPLODE_FACTOR * ex);
      const op = rec.opener;
      // При закриванні порядок зворотний: останні відкриті зачиняються першими
      const ease = op ? smooth(Math.min(1, Math.max(0, (openClock - op.delay) / OPEN_TIME))) : 0;
      if (op && op.kind === 'door') {
        // Поворот навколо осі петель (вертикальної чи горизонтальної): позиція = pivot + e − R·pivot
        const angle = op.sign * op.maxAngle * ease;
        rec.mesh.quaternion.setFromAxisAngle(op.axis, angle);
        rec.mesh.position.copy(op.pivot).add(e).sub(op.pivot.clone().applyAxisAngle(op.axis, angle));
      } else if (op && op.kind === 'drawer') {
        rec.mesh.position.copy(rec.home).add(e).add(new THREE.Vector3(0, 0, op.slide * ease));
      } else {
        rec.mesh.position.copy(rec.home).add(e);
      }
    }
  }

  // ---- Матеріали: колір фасадів, рентген, підсвітка ----
  // Колір фасадів: спільний матеріал-заміна; оригінали лишаються для «Як у проєкті»
  let facadeOverride = null;

  // Режими відображення, як у БАЗИСі:
  //  real-lines — текстури з чорними контурами (як БАЗИС за замовчуванням);
  //  real  — реалістичний (текстури без ліній);
  //  lines — «без невидимих»: білі поверхні з чорними контурами, задні лінії сховані;
  //  xray  — рентген: плити майже невидимі, видно всі тонкі лінії, фурнітура суцільна (шканти жовті, конфірмати рожеві)
  let mode = "real-lines";
  const LINES_FILL = new THREE.MeshBasicMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const XRAY_PANEL = new THREE.MeshBasicMaterial({ color: 0xbfc8d2, transparent: true, opacity: 0.07, depthWrite: false });
  const XRAY_DOWEL = new THREE.MeshStandardMaterial({ color: 0xf2d652, roughness: 0.6 });
  const XRAY_SCREW = new THREE.MeshStandardMaterial({ color: 0xe86fd0, roughness: 0.5 });
  const EDGE_MAT = new THREE.LineBasicMaterial({ color: 0x1f2328, transparent: true, opacity: 0.55 });
  const EDGE_BLACK = new THREE.LineBasicMaterial({ color: 0x111111 });
  const isBoard = (part) => part.board;
  for (const rec of meshes) {
    for (const m of [].concat(rec.original)) { m.polygonOffset = true; m.polygonOffsetFactor = 1; m.polygonOffsetUnits = 1; }
  }
  for (const part of parts) {
    const names = part.meshes.map((r) => [].concat(r.original).map((m) => m.name || '').join(' ')).join(' ');
    // Плита/поверхня: ДСП, ХДФ, МДФ, стільниця, крайка, стіни й підлога кімнати
    part.board = part.key === 'room' || /дсп|хдф|мдф|двп|стільниц|столешн|крайка|kronospan|egger|swiss|скло|стекло|стіна|підлога/i.test(names);
    part.xrayMat = /шкант/i.test(part.name.title) ? XRAY_DOWEL
      : /конфірмат|комформат|конфирмат|саморіз|саморез|шуруп|стяжк|мініфікс|минификс|дюбель/i.test(part.name.title) ? XRAY_SCREW
      : null;
  }

  function baseMaterial(rec) {
    if (mode === "lines") return LINES_FILL;
    if (mode === "xray") {
      if (isBoard(rec.part)) return XRAY_PANEL;
      if (rec.part.xrayMat) return rec.part.xrayMat;
      return rec.original;
    }
    // Заміна матеріалу для групи (фасади/корпус/стільниця): лише плити й крайки, фурнітура не змінюється
    const ov = rec.part.slot && slotOverride.get(rec.part.slot);
    if (ov && rec.swappable) return ov;
    return rec.part.key === 'facade' && facadeOverride ? facadeOverride : rec.original;
  }

  // Контури всіх деталей — рахуються один раз, коли вперше вмикають «Контури» або «Рентген»
  let edgesReady = false;
  function ensureEdges() {
    if (edgesReady) return;
    edgesReady = true;
    for (const rec of meshes) {
      const lines = new THREE.LineSegments(new THREE.EdgesGeometry(rec.mesh.geometry, 25), EDGE_MAT);
      lines.visible = false;
      lines.raycast = () => {}; // контури не заважають вибору
      rec.mesh.add(lines);
      rec.edges = lines;
    }
  }

  // Підсвітка: окремі копії матеріалів лише для сіток вибраних деталей
  let selection = [];
  function applyHighlight(part) {
    for (const rec of part.meshes) {
      const tint = (m) => {
        const c = m.clone();
        if (c.emissive) { c.emissive.copy(HIGHLIGHT); c.emissiveIntensity = 0.45; }
        else if (c.color) { c.color.copy(HIGHLIGHT); c.opacity = Math.max(c.opacity, 0.35); }
        return c;
      };
      const base = baseMaterial(rec);
      rec.mesh.material = Array.isArray(base) ? base.map(tint) : tint(base);
    }
  }
  function repaint() {
    for (const rec of meshes) rec.mesh.material = baseMaterial(rec);
    for (const p of selection) applyHighlight(p);
  }
  function select(list) {
    for (const p of selection) for (const rec of p.meshes) rec.mesh.material = baseMaterial(rec);
    selection = list.filter(Boolean);
    for (const p of selection) applyHighlight(p);
  }
  const highlight = (part) => select(part ? [part] : []);

  // ---- Матеріали моделі: заміна для фасадів, корпусу, стільниці (лише ті матеріали, що є в моделі) ----
  const matName = (m) => splitName(m?.name || '').title;
  const slotOverride = new Map();
  for (const part of parts) {
    if (part.key === 'room' || !part.board) { part.slot = null; continue; }
    const names = part.meshes.map((r) => matName(r.original)).join(' ');
    part.slot = part.key === 'facade' ? 'facade' : /хдф|двп/i.test(names) || /^(зс|задня)/i.test(part.name.title) ? 'back' : /стільниц|столешн/i.test(names) ? 'top' : 'corpus';
  }
  for (const rec of meshes) {
    const n = matName(rec.original);
    rec.swappable = /дсп|мдф|хдф|двп|стільниц|столешн|крайка|kronospan|egger|swiss|cleaf|agt|шпон|акрил|пластик hpl/i.test(n) && !/скло|стекло/i.test(n);
  }
  // Варіанти: різні плитні матеріали моделі (без крайок, ХДФ, стін і скла)
  const options = [];
  const seen = new Set();
  for (const rec of meshes) {
    const n = matName(rec.original);
    if (!rec.swappable || /крайка/i.test(n) || seen.has(n) || rec.part.key === 'room') continue;
    seen.add(n);
    options.push({ name: n, short: shortMaterial(n), material: rec.original, swatch: swatchOf(rec.original) });
  }
  const SLOT_LABELS = { facade: 'Фасади', corpus: 'Корпус', back: 'Задня стінка', top: 'Стільниця' };
  // Для кожної групи — який матеріал стоїть у проєкті (найчастіший серед її плит, без крайок)
  const slots = Object.keys(SLOT_LABELS)
    .filter((id) => parts.some((p) => p.slot === id))
    .map((id) => {
      const counts = new Map();
      for (const p of parts) {
        if (p.slot !== id) continue;
        for (const rec of p.meshes) {
          const i = options.findIndex((o) => o.name === matName(rec.original));
          if (i >= 0) counts.set(i, (counts.get(i) || 0) + 1);
        }
      }
      const current = [...counts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 0;
      return { id, label: SLOT_LABELS[id], current };
    });

  function setSlotMaterial(slot, index) {
    if (index === null || index === undefined) slotOverride.delete(slot);
    else slotOverride.set(slot, options[index].material);
    repaint();
  }

  function setMaterialColor(key, hex) {
    if (key !== 'facade') return;
    if (hex === null) {
      facadeOverride = null;
    } else {
      facadeOverride = facadeOverride || new THREE.MeshStandardMaterial({ roughness: 0.6 });
      facadeOverride.color.set(hex);
    }
    repaint();
  }

  function setViewMode(next) {
    mode = next;
    if (mode !== "real") ensureEdges();
    for (const rec of meshes) {
      if (!rec.edges) continue;
      rec.edges.visible = mode !== "real";
      rec.edges.material = mode === "xray" ? EDGE_MAT : EDGE_BLACK;
    }
    repaint();
    refreshVisibility();
  }

  // Видимість з урахуванням батьків
  function isShown(obj) {
    for (let o = obj; o; o = o.parent) if (!o.visible) return false;
    return true;
  }

  const raycaster = new THREE.Raycaster();
  const meshList = meshes.map((r) => r.mesh);
  const recByMesh = new Map(meshes.map((r) => [r.mesh, r]));
  function pick(clientX, clientY, camera, canvas) {
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(meshList, false).filter((h) => isShown(h.object));
    if (!hits.length) return null;
    // У рентгені спершу беремо фурнітуру — заради неї рентген і вмикають
    const hit = mode === "xray" ? (hits.find((h) => !isBoard(recByMesh.get(h.object).part)) || hits[0]) : hits[0];
    return recByMesh.get(hit.object).part;
  }

  // ---- Видимість: сховані типи (фасади, стіни), «як бачить клієнт», ізоляція групи, сховані вручну ----
  const hiddenKeys = new Set();
  const hiddenParts = new Set();
  let clientView = true;
  let isolated = null;
  const isVisible = (part) => !hiddenKeys.has(part.key)
    && !hiddenParts.has(part)
    && !(clientView && mode !== "xray" && part.technical)
    && (!isolated || part.group === isolated);
  function refreshVisibility() {
    for (const rec of meshes) rec.mesh.visible = isVisible(rec.part);
    if (selection.some((p) => !isVisible(p))) select(selection.filter(isVisible));
  }
  function setKeyVisible(key, visible) {
    if (visible) hiddenKeys.delete(key); else hiddenKeys.add(key);
    refreshVisibility();
  }
  function setClientView(on) { clientView = on; refreshVisibility(); }
  function isolate(groupOrNull) { isolated = groupOrNull; refreshVisibility(); }
  function hide(list) { for (const p of list) hiddenParts.add(p); select([]); refreshVisibility(); }
  function showAll() { hiddenParts.clear(); isolated = null; refreshVisibility(); }
  setViewMode(mode);

  /** Пошук деталі за текстом (QR-код, назва, артикул). Повертає список знайдених деталей. */
  function find(text) {
    const q = String(text || '').trim().toLowerCase();
    if (!q) return [];
    const words = q.split(/[\s,;|/]+/).filter((w) => w.length >= 2);
    const score = (p) => {
      const hay = `${p.name.title} ${p.name.article} ${p.group.name}`.toLowerCase();
      if (hay.includes(q)) return 100;
      return words.filter((w) => hay.includes(w)).length;
    };
    const ranked = parts.filter((p) => p.key !== 'room').map((p) => [p, score(p)]).filter(([, s]) => s > 0);
    if (!ranked.length) return [];
    const best = Math.max(...ranked.map(([, s]) => s));
    return ranked.filter(([, s]) => s === best).map(([p]) => p);
  }

  /** Габарит набору деталей (для «Наблизити»). */
  function boxOf(list) {
    const b = new THREE.Box3();
    for (const p of list) b.union(p.box);
    return b;
  }

  const count = (key) => parts.filter((p) => p.key === key).length;

  return {
    kind: 'glb',
    name: info?.name || title,
    info,
    group,
    parts,
    bounds,
    update,
    highlight,
    select,
    get selection() { return selection; },
    pick,
    find,
    boxOf,
    hide,
    showAll,
    setViewMode,
    get viewMode() { return mode; },
    get hasHidden() { return hiddenParts.size > 0 || !!isolated; },
    setExplode(t) { explodeTarget = Math.min(1, Math.max(0, t)); },
    /** Габарит меблів у повністю розібраному стані — щоб камера відійшла й усе влізло. */
    explodedBox() {
      const b = new THREE.Box3();
      for (const rec of meshes) {
        if (rec.part.key === 'room' || !rec.mesh.visible || rec.part.host) continue;
        if (!rec.part.board && Math.max(rec.part.size.x, rec.part.size.y, rec.part.size.z) < 120) continue;
        const pb = (rec.opener ? rec.opener.box : rec.part.box).clone().translate(rec.outward.clone().multiplyScalar(EXPLODE_FACTOR));
        b.union(pb);
      }
      return b;
    },
    setOpen(t) { openTarget = Math.min(1, Math.max(0, t)); },
    openers: { doors: openers.filter((o) => o.kind === 'door').length, drawers: openers.filter((o) => o.kind === 'drawer').length },
    setMaterialColor,
    materialSlots: slots,
    materialOptions: options.map((o) => ({ name: o.name, short: o.short, swatch: o.swatch })),
    setSlotMaterial,
    setKeyVisible,
    setClientView,
    isolate,
    get isolated() { return isolated; },
    technicalCount: parts.filter((p) => p.technical).length,
    hasFacades: count('facade') > 0,
    hasRoom: count('room') > 0,
    // Дані для вікна деталі
    describe(part) {
      const s = part.size;
      const mats = new Set();
      for (const rec of part.meshes) for (const m of [].concat(rec.original)) if (m.name) mats.add(splitName(m.name).title);
      return {
        title: part.name.title || 'Деталь',
        group: part.group.name,
        groupCount: part.group.parts.filter((p) => !p.technical || !clientView).length,
        article: part.name.article,
        dims: `${Math.round(s.x)} × ${Math.round(s.y)} × ${Math.round(s.z)} мм (ширина × висота × глибина)`,
        // Основний матеріал першим, крайки — в кінці
        material: [...mats]
          .filter((n) => !/^noname$/i.test(n))
          .sort((a, b) => /крайка/i.test(a) - /крайка/i.test(b))
          .slice(0, 2)
          .join('; '),
      };
    },
  };
}
