import * as THREE from 'three';

// Кубик орієнтації в кутку сцени: крутиться разом з камерою,
// натискання на грань плавно повертає вид до цієї сторони.

// Порядок граней BoxGeometry: +X, −X, +Y, −Y, +Z, −Z
const FACES = [
  { label: 'ПРАВО', dir: new THREE.Vector3(1, 0, 0) },
  { label: 'ЛІВО', dir: new THREE.Vector3(-1, 0, 0) },
  { label: 'ВЕРХ', dir: new THREE.Vector3(0, 1, 0) },
  { label: 'НИЗ', dir: new THREE.Vector3(0, -1, 0) },
  { label: 'ПЕРЕД', dir: new THREE.Vector3(0, 0, 1) },
  { label: 'ЗАД', dir: new THREE.Vector3(0, 0, -1) },
];

function faceTexture(label, hover = false) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = hover ? '#dce8f6' : '#f7f5f1';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = '#b9b2a6';
  g.lineWidth = 4;
  g.strokeRect(2, 2, 124, 124);
  g.fillStyle = '#3a3d42';
  g.font = '600 26px system-ui, -apple-system, "Segoe UI", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, 64, 66);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * container — абсолютний блок у кутку сцени; mainCamera/controls — основна камера;
 * onPick(dir) — що зробити при натисканні на грань (напрям від центру до камери).
 */
export function createViewCube(container, mainCamera, controls, onPick) {
  const size = 84;
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(size, size);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);

  const normal = FACES.map((f) => new THREE.MeshBasicMaterial({ map: faceTexture(f.label) }));
  const hover = FACES.map((f) => new THREE.MeshBasicMaterial({ map: faceTexture(f.label, true) }));
  const cube = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 1.5), normal.slice());
  scene.add(cube);
  cube.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(cube.geometry),
    new THREE.LineBasicMaterial({ color: 0x8f877a }),
  ));

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function faceAt(e) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(cube, false)[0];
    return hit ? hit.face.materialIndex : -1;
  }

  let hovered = -1;
  renderer.domElement.addEventListener('pointermove', (e) => {
    const i = faceAt(e);
    if (i === hovered) return;
    hovered = i;
    cube.material = normal.map((m, k) => (k === i ? hover[k] : m));
    renderer.domElement.style.cursor = i >= 0 ? 'pointer' : 'default';
  });
  renderer.domElement.addEventListener('pointerleave', () => {
    hovered = -1;
    cube.material = normal.slice();
  });
  renderer.domElement.addEventListener('click', (e) => {
    const i = faceAt(e);
    if (i >= 0) onPick(FACES[i].dir.clone());
  });

  return {
    /** Щокадру: кубик дивиться з того ж боку, що й основна камера. */
    render() {
      const dir = mainCamera.position.clone().sub(controls.target).normalize();
      camera.position.copy(dir.multiplyScalar(4.2));
      camera.up.copy(mainCamera.up);
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
    },
  };
}
