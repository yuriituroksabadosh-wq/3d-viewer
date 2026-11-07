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

    controls.minDistance = Math.max(80, maxDim * 0.03);
    controls.maxDistance = maxDim * 5;
    camera.near = maxDim / 100;
    camera.far = maxDim * 50;
    camera.updateProjectionMatrix();
    resetView(false);
  }

  // ---- Анімації камери ----
  // fly: плавний переліт у нову точку (скинути вид, кубик орієнтації, виліт на старті)
  let fly = null;
  // spin: повільне обертання навколо меблів (для кімнати — гойдання в межах відкритої сторони)
  let spin = null;
  let onSpinStop = null;
  const Y = new THREE.Vector3(0, 1, 0);

  function flyTo(pos, target = controls.target, duration = 0.8) {
    fly = {
      fromPos: camera.position.clone(), toPos: pos.clone(),
      fromTarget: controls.target.clone(), toTarget: target.clone(),
      t: 0, duration,
    };
  }

  /** Переліт до виду з заданого напрямку (від центру), зберігаючи поточну відстань. */
  function viewFrom(dir) {
    const d = camera.position.distanceTo(controls.target);
    const n = dir.clone().normalize();
    // Не даємо стати рівно зверху/знизу (обмеження кута камери)
    const minY = Math.cos(controls.minPolarAngle + 0.01);
    const maxDown = Math.cos(controls.maxPolarAngle - 0.01);
    n.y = Math.min(minY, Math.max(maxDown, n.y));
    if (Math.abs(n.x) < 1e-3 && Math.abs(n.z) < 1e-3) n.z = 1e-3;
    const flat = Math.sqrt(Math.max(0, 1 - n.y * n.y));
    const h = Math.hypot(n.x, n.z);
    n.x = (n.x / h) * flat; n.z = (n.z / h) * flat;
    setSpin(false);
    flyTo(controls.target.clone().addScaledVector(n, d), controls.target);
  }

  function setSpin(on, range = Infinity) {
    if (on) {
      spin = { offset: camera.position.clone().sub(controls.target), phase: 0, range };
    } else if (spin) {
      spin = null;
      if (onSpinStop) onSpinStop();
    }
  }

  // Користувач узявся крутити сам — зупиняємо автоматику
  controls.addEventListener("start", () => { fly = null; setSpin(false); });

  /** Викликається щокадру з main.js (dt у секундах). */
  function tick(dt) {
    if (fly) {
      fly.t = Math.min(1, fly.t + dt / fly.duration);
      const k = fly.t * fly.t * (3 - 2 * fly.t);
      // Рух по дузі: інтерполюємо напрям і відстань окремо, щоб камера не пролітала крізь меблі
      const tgt = fly.fromTarget.clone().lerp(fly.toTarget, k);
      const a = fly.fromPos.clone().sub(fly.fromTarget);
      const b = fly.toPos.clone().sub(fly.toTarget);
      const len = THREE.MathUtils.lerp(a.length(), b.length(), k);
      const dir = a.normalize().lerp(b.normalize(), k).normalize();
      camera.position.copy(tgt).addScaledVector(dir, len);
      controls.target.copy(tgt);
      if (fly.t >= 1) fly = null;
    } else if (spin) {
      spin.phase += dt * 0.35;
      const angle = Number.isFinite(spin.range) ? spin.range * Math.sin(spin.phase) : spin.phase;
      camera.position.copy(controls.target).add(spin.offset.clone().applyAxisAngle(Y, angle));
    }
  }

  /** Наблизити до набору деталей: центр — їхній габарит, відстань — щоб влізли, напрям — поточний. */
  function focusBox(box, viewDir) {
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const r = box.getSize(new THREE.Vector3()).length() / 2;
    const fov = THREE.MathUtils.degToRad(camera.fov);
    const fit = Math.max(1, 1 / camera.aspect);
    const d = Math.max(controls.minDistance, (r / Math.sin(fov / 2)) * 1.15 * fit);
    // Напрям: заданий (наприклад, спереду згори для розбирання) або поточний
    const dir = viewDir ? new THREE.Vector3(...viewDir).normalize() : camera.position.clone().sub(controls.target).normalize();
    setSpin(false);
    flyTo(c.clone().addScaledVector(dir, d), c, viewDir ? 1.2 : 0.8);
  }

  function resetView(animate = true) {
    setSpin(false);
    if (animate) flyTo(home.pos, home.target);
    else {
      camera.position.copy(home.pos);
      controls.target.copy(home.target);
      controls.update();
    }
  }

  /** Виліт на старті: камера стартує здалеку й трохи збоку, плавно підлітає до початкового виду. */
  function intro() {
    const off = home.pos.clone().sub(home.target);
    camera.position.copy(home.target).add(off.multiplyScalar(1.7).applyAxisAngle(Y, -0.6));
    controls.target.copy(home.target);
    flyTo(home.pos, home.target, 1.6);
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
    tick,
    intro,
    viewFrom,
    focusBox,
    setSpin,
    set onSpinStop(fn) { onSpinStop = fn; },
  };
}
