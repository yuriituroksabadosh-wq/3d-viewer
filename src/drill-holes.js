// Отвори присадки прямо в 3D-моделі (лише менеджеру, лише в рентгені): циліндри на місці кожного отвору.
// Дані — присадка (координати від лівого нижнього кута деталі) + кут і осі деталі в глобальних координатах (o, ax, ay, az).
// Отвір їде разом зі своєю деталлю: відкриті двері, висунуті шухляди, розібраний виріб.

import * as THREE from 'three';
import { matchPanel } from './drill.js';

// Колір за діаметром: як звикли бачити в БАЗИСі — різні діаметри різним кольором
const COLOR_BY_D = [[5, 0xe0592a], [8, 0xe0b81f], [10, 0x1f9d55], [15, 0x2f6fd6], [20, 0x9b4dca], [35, 0x0c8599]];
const colorOf = (d) => (COLOR_BY_D.find(([x]) => Math.abs(x - d) < 0.6) || [0, 0xd6336c])[1];

/** Будує отвори; повертає { object, update(mode) } або null, якщо в даних немає осей деталей. */
export function createDrillHoles(model, panels) {
  const withAxes = panels.filter((p) => p.ax && p.ay && p.az && p.o && (p.h || []).length);
  if (!withAxes.length) return null;
  const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
  const holes = []; // { color, m0: Matrix4 (світ у спокої), rec: сітка деталі, inv0 }
  const tmp = new THREE.Vector3();
  for (const p of withAxes) {
    const part = model.parts.find((q) => q.board && matchPanel([p], q.box) === p);
    const rec = part && part.meshes[0];
    if (!rec) continue;
    rec.mesh.updateWorldMatrix(true, false);
    const inv0 = rec.mesh.matrixWorld.clone().invert();
    const O = v3(p.o), X = v3(p.ax), Y = v3(p.ay), Z = v3(p.az);
    const at = (x, y, z) => O.clone().addScaledVector(X, x).addScaledVector(Y, y).addScaledVector(Z, z);
    for (const h of p.h) {
      const depth = Math.max(1, h.h || 1);
      let start, dir;
      if (h.t === 'A') { start = at(h.x, h.y, 0); dir = Z.clone(); }
      else if (h.t === 'B') { start = at(h.x, h.y, p.t); dir = Z.clone().negate(); }
      else if (h.t === 'E') {
        start = at(h.x, h.y, h.z);
        dir = h.e === 'L' ? X.clone() : h.e === 'R' ? X.clone().negate() : h.e === 'D' ? Y.clone() : Y.clone().negate();
      } else continue;
      // Циліндр одиничний по Y → масштаб (Ø, глибина, Ø), поворот Y → dir, центр — посередині глибини
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      const c = tmp.copy(start).addScaledVector(dir, depth / 2);
      const m0 = new THREE.Matrix4().compose(c.clone(), q, new THREE.Vector3(h.d, depth, h.d));
      holes.push({ color: colorOf(h.d), m0, mesh: rec.mesh, inv0 });
    }
  }
  if (!holes.length) return null;

  const geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 14);
  const group = new THREE.Group();
  group.name = 'drill-holes';
  group.visible = false;
  const byColor = new Map();
  for (const h of holes) { if (!byColor.has(h.color)) byColor.set(h.color, []); byColor.get(h.color).push(h); }
  const sets = [...byColor].map(([color, list]) => {
    const mat = new THREE.MeshBasicMaterial({ color });
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    im.frustumCulled = false;
    im.raycast = () => {}; // не заважають вибору деталей
    group.add(im);
    return { im, list };
  });
  model.group.add(group);
  // model.group може мати свій масштаб/зсув — отвори рахуємо у світі, тож компенсуємо
  const shown = (o) => { for (let x = o; x; x = x.parent) if (!x.visible) return false; return true; };
  const m = new THREE.Matrix4(), zero = new THREE.Matrix4().makeScale(0, 0, 0), groupInv = new THREE.Matrix4();

  return {
    object: group,
    count: holes.length,
    /** Щокадру: показати лише в рентгені, пересунути за деталями, сховати отвори прихованих деталей. */
    update(on) {
      group.visible = on;
      if (!on) return;
      group.updateWorldMatrix(true, false);
      groupInv.copy(group.matrixWorld).invert();
      for (const { im, list } of sets) {
        list.forEach((h, i) => {
          if (!shown(h.mesh)) { im.setMatrixAt(i, zero); return; }
          // світ зараз = сітка зараз × (сітка в спокої)⁻¹ × отвір у спокої
          m.multiplyMatrices(h.mesh.matrixWorld, h.inv0).multiply(h.m0);
          im.setMatrixAt(i, m.premultiply(groupInv));
        });
        im.instanceMatrix.needsUpdate = true;
      }
    },
  };
}
