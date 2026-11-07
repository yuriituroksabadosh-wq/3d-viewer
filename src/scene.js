import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

// Масштаб: 1 одиниця three.js = 1 мм (як у JSON-даних).

/**
 * Створює сцену, камеру, світло, підлогу і контроли.
 * Рендер-цикл не створює: його запускає main.js (один requestAnimationFrame).
 */
export function createViewer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  // Нейтральне тонування: світлі поверхні не «вигорають» у суцільний білий
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#e9e5de');

// М'яке «студійне» освітлення-середовище: білі фасади лишаються білими, текстури читаються.
  // Рахується один раз при старті, на кадри не впливає.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.6;
  pmrem.dispose();

  // Світло: м'яке загальне + одне напрямлене для обʼєму
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8178, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(3000, 5000, 4000);
  scene.add(sun);

  // Підлога під виробом (трохи нижче y=0, щоб не було мерехтіння)
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(40000, 40000),
    new THREE.MeshStandardMaterial({ color: 0xd6d0c7, roughness: 1 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -1;
  scene.add(floor);

  const camera = new THREE.PerspectiveCamera(35, 1, 10, 100000);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;               // для одного виробу панорамування не потрібне
  controls.minPolarAngle = 0.2;             // не дає піти на саму гору
  controls.maxPolarAngle = Math.PI / 2 - 0.05; // камера не опускається під підлогу

  // Початковий вигляд: спереду справа зверху (запам'ятовується для «Скинути вид»)
  const home = { pos: new THREE.Vector3(), target: new THREE.Vector3() };

  /** Підганяє камеру під габарити виробу. bounds = { center, size } у мм. */
  function frame(bounds) {
    const { center, size } = bounds;
    const maxDim = Math.max(size.x, size.y, size.z);
    // На вузькому (телефонному) екрані відходимо далі, щоб влізла ширина
    const fit = Math.max(1, 1 / camera.aspect);
    // 2.3 — з запасом, щоб влізав і розібраний виріб
    const dist = maxDim * 2.3 * fit;

    // Напрям погляду: модель може задати свій (кімната з БАЗИСу відкрита спереду)
    const dir = new THREE.Vector3(...(bounds.viewDir || [0.6, 0.35, 1])).normalize();
    home.target.copy(center);
    home.pos.copy(center).addScaledVector(dir, dist);

    // Підлога сцени — трохи нижче найнижчої точки моделі (у моделей з БАЗИСу є своя підлога)
    floor.position.y = (bounds.floorY ?? bounds.min.y) - 1;

    controls.minDistance = maxDim * 0.3;
    controls.maxDistance = maxDim * 5;
    camera.near = maxDim / 100;
    camera.far = maxDim * 50;
    camera.updateProjectionMatrix();
    resetView();
  }

  function resetView() {
    camera.position.copy(home.pos);
    controls.target.copy(home.target);
    controls.update();
  }

  /** Підганяє розмір рендера під розмір канвасу (телефон, поворот, зміна вікна). */
  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  resize();

  return {
    scene,
    camera,
    controls,
    renderer,
    frame,
    resetView,
    resize,
  };
}
