import * as THREE from 'three';

// Наскільки сильно розходяться деталі при «Розібрати» (0.3 = зсув на 30% відстані до центру)
const EXPLODE_FACTOR = 0.3;

/** Перевіряє JSON виробу. Кидає Error з текстом українською, якщо щось не так. */
export function validateModel(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Файл моделі порожній або має неправильний формат.');
  }
  if (data.unit && data.unit !== 'mm') {
    throw new Error('Підтримуються лише розміри в міліметрах (unit: "mm").');
  }
  if (!Array.isArray(data.parts) || data.parts.length === 0) {
    throw new Error('У файлі моделі немає списку деталей (parts).');
  }
  const numbers = ['w', 'h', 'd', 'x', 'y', 'z'];
  data.parts.forEach((p, i) => {
    const label = `Деталь №${i + 1} (${p?.id ?? 'без id'})`;
    for (const k of numbers) {
      if (typeof p?.[k] !== 'number' || !Number.isFinite(p[k])) {
        throw new Error(`${label}: поле «${k}» має бути числом.`);
      }
    }
    if (p.w <= 0 || p.h <= 0 || p.d <= 0) {
      throw new Error(`${label}: розміри w, h, d мають бути більші за нуль.`);
    }
  });
}

/**
 * Будує меблі з даних. Координати x, y, z — лівий нижній передній кут деталі.
 * Повертає групу, список деталей і керування (розбирання, колір, видимість, вибір).
 */
export function buildFurniture(data) {
  validateModel(data);

  const group = new THREE.Group();
  const raycaster = new THREE.Raycaster();

  // Габарити всього виробу (за даними, без зсувів)
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (const p of data.parts) {
    min.set(Math.min(min.x, p.x), Math.min(min.y, p.y), Math.min(min.z, p.z));
    max.set(Math.max(max.x, p.x + p.w), Math.max(max.y, p.y + p.h), Math.max(max.z, p.z + p.d));
  }
  const size = max.clone().sub(min);
  const center = min.clone().add(max).multiplyScalar(0.5);
  const bounds = { min, max, size, center };

  const parts = data.parts.map((p) => {
    const spec = data.materials?.[p.material] ?? {};
    const mat = new THREE.MeshStandardMaterial({
      color: spec.color || '#cccccc',
      roughness: 0.65,
    });
    const geom = new THREE.BoxGeometry(p.w, p.h, p.d);
    const mesh = new THREE.Mesh(geom, mat);

    // Центр деталі (BoxGeometry будується від центру)
    const home = new THREE.Vector3(p.x + p.w / 2, p.y + p.h / 2, p.z + p.d / 2);
    mesh.position.copy(home);

    // Тонкі контури ребер, щоб деталі читалися
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geom),
      new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.2 }),
    );
    mesh.add(edges);
    group.add(mesh);

    return {
      data: p,
      key: p.material,
      mesh,
      mat,
      home,
      outward: home.clone().sub(center), // напрям «від центру» для розбирання
    };
  });

  // Розбирання: плавно рухаємо деталі від центру
  let explodeTarget = 0;
  let explodeNow = 0;

  // Розбирання триває ~1,6 с незалежно від частоти кадрів, з м'яким стартом і зупинкою
  function update(dt = 1 / 60) {
    if (explodeNow === explodeTarget) return;
    const delta = dt / 1.6;
    explodeNow = explodeNow < explodeTarget ? Math.min(explodeTarget, explodeNow + delta) : Math.max(explodeTarget, explodeNow - delta);
    const t = explodeNow;
    const k = t * t * t * (t * (t * 6 - 15) + 10);
    for (const part of parts) {
      part.mesh.position.copy(part.home).addScaledVector(part.outward, EXPLODE_FACTOR * k);
    }
  }

  // Підсвітка вибраної деталі (через emissive, щоб не міняти колір)
  let selected = null;
  function highlight(part) {
    if (selected) selected.mat.emissive.set(0x000000);
    selected = part;
    if (part) part.mat.emissive.set(0x2f6fd6);
  }

  /** Знаходить деталь під пальцем/мишею. clientX/Y — координати події. */
  function pick(clientX, clientY, camera, canvas) {
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster
      .intersectObjects(parts.map((p) => p.mesh), false)
      .find((h) => h.object.visible);
    return hit ? parts.find((p) => p.mesh === hit.object) : null;
  }

  return {
    group,
    parts,
    bounds,
    update,
    highlight,
    pick,
    setExplode(t) {
      explodeTarget = Math.min(1, Math.max(0, t));
    },
    setMaterialColor(key, hex) {
      for (const p of parts) if (p.key === key) p.mat.color.set(hex);
    },
    setKeyVisible(key, visible) {
      for (const p of parts) if (p.key === key) p.mesh.visible = visible;
      if (!visible && selected && selected.key === key) highlight(null);
    },
    // Дані для вікна деталі
    describe(part) {
      const d = part.data;
      const mat = data.materials?.[part.key]?.name;
      return {
        title: d.name ?? d.id,
        dims: `${d.w} × ${d.h} × ${d.d} мм (ширина × висота × глибина)`,
        material: mat || (part.key === 'facade' ? 'фасад' : 'корпус'),
      };
    },
  };
}

/** Тонкий каркас габаритів виробу (показуємо разом з розмірами). */
export function makeBoundsBox(bounds) {
  const geom = new THREE.BoxGeometry(bounds.size.x, bounds.size.y, bounds.size.z);
  const box = new THREE.LineSegments(
    new THREE.EdgesGeometry(geom),
    new THREE.LineDashedMaterial({ color: 0x2f6fd6, dashSize: 40, gapSize: 20 }),
  );
  box.computeLineDistances();
  box.position.copy(bounds.center);
  box.visible = false;
  return box;
}

/** Точки для підписів розмірів (висота, ширина, глибина), винесені від виробу. */
export function dimensionAnchors(bounds) {
  const { min, max, size } = bounds;
  const off = Math.max(size.x, size.y, size.z) * 0.06;
  return [
    {
      text: `Висота ${Math.round(size.y)} мм`,
      position: new THREE.Vector3(min.x - off, min.y + size.y / 2, max.z),
    },
    {
      text: `Ширина ${Math.round(size.x)} мм`,
      position: new THREE.Vector3(min.x + size.x / 2, min.y - off, max.z),
    },
    {
      text: `Глибина ${Math.round(size.z)} мм`,
      position: new THREE.Vector3(max.x + off, min.y - off, min.z + size.z / 2),
    },
  ];
}
