import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Модель з БАЗИСу у форматі GLB (конвертується з .dae скриптом tools/convert-dae.mjs).
// Одиниці файлу — мм, вісь Y вгору (як і в JSON-моделях).
//
// БАЗИС ріже кожну деталь на кілька сіток (пласть, крайки, матеріали окремо),
// тому «деталь» тут — найближчий іменований вузол, а не окрема сітка.

const EXPLODE_FACTOR = 0.5;
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
    && !/^(node|mesh)(_\d+)?$/i.test(n)
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

const isFacadeName = (n) => n.startsWith('фасад') || n === 'двері';
const isRoomName = (n) => n === 'стіна' || n === 'заміри';

/** Завантажує GLB з ArrayBuffer і повертає модель з тим самим інтерфейсом, що й buildFurniture. */
export async function loadGltfModel(buffer, title) {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.parseAsync(buffer, '');
  gltf.scene.updateMatrixWorld(true);

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
  for (const rec of meshes) rec.outward = rec.part.center.clone().sub(bounds.center);

  // Матеріали з assimp інколи приходять «металевими» — для меблів це зайве
  for (const rec of meshes) {
    for (const m of [].concat(rec.mesh.material)) {
      if ('metalness' in m && m.metalness > 0.5 && !/хром|нікел|метал|сталь/i.test(m.name)) m.metalness = 0;
    }
  }

  let explodeTarget = 0;
  let explodeNow = 0;
  function update() {
    if (explodeNow === explodeTarget) return;
    explodeNow += (explodeTarget - explodeNow) * 0.12;
    if (Math.abs(explodeTarget - explodeNow) < 0.001) explodeNow = explodeTarget;
    for (const rec of meshes) {
      if (rec.part.key === 'room') continue; // стіни не рухаємо
      rec.mesh.position.copy(rec.home).addScaledVector(rec.outward, EXPLODE_FACTOR * explodeNow);
    }
  }

  // Колір фасадів: спільний матеріал-заміна; оригінали лишаються для «Як у проєкті»
  let facadeOverride = null;
  const baseMaterial = (rec) => (rec.part.key === 'facade' && facadeOverride ? facadeOverride : rec.original);

  function setMaterialColor(key, hex) {
    if (key !== 'facade') return;
    if (hex === null) {
      facadeOverride = null;
    } else {
      facadeOverride = facadeOverride || new THREE.MeshStandardMaterial({ roughness: 0.6 });
      facadeOverride.color.set(hex);
    }
    for (const rec of meshes) if (rec.part.key === 'facade') rec.mesh.material = baseMaterial(rec);
    if (selected && selected.key === 'facade') applyHighlight(selected);
  }

  // Підсвітка: окремі копії матеріалів лише для сіток вибраної деталі
  let selected = null;
  function applyHighlight(part) {
    for (const rec of part.meshes) {
      const tint = (m) => {
        const c = m.clone();
        if (c.emissive) { c.emissive.copy(HIGHLIGHT); c.emissiveIntensity = 0.45; }
        return c;
      };
      const base = baseMaterial(rec);
      rec.mesh.material = Array.isArray(base) ? base.map(tint) : tint(base);
    }
  }
  function highlight(part) {
    if (selected) for (const rec of selected.meshes) rec.mesh.material = baseMaterial(rec);
    selected = part;
    if (part) applyHighlight(part);
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
    const hit = raycaster.intersectObjects(meshList, false).find((h) => isShown(h.object));
    return hit ? recByMesh.get(hit.object).part : null;
  }

  function setKeyVisible(key, visible) {
    for (const rec of meshes) if (rec.part.key === key) rec.mesh.visible = visible;
    if (!visible && selected && selected.key === key) highlight(null);
  }

  const count = (key) => parts.filter((p) => p.key === key).length;

  return {
    kind: 'glb',
    name: title,
    group,
    parts,
    bounds,
    update,
    highlight,
    pick,
    setExplode(t) { explodeTarget = Math.min(1, Math.max(0, t)); },
    setMaterialColor,
    setKeyVisible,
    hasFacades: count('facade') > 0,
    hasRoom: count('room') > 0,
    // Дані для вікна деталі
    describe(part) {
      const s = part.size;
      const mats = new Set();
      for (const rec of part.meshes) for (const m of [].concat(rec.original)) if (m.name) mats.add(splitName(m.name).title);
      return {
        title: part.name.title || 'Деталь',
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
