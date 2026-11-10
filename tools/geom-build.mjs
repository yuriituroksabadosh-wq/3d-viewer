// Модель без .dae: збирає документ glTF з геометрії, яку пише скрипт БАЗИС «Експорт для 3D-перегляду» (1.6+),
// розділ geom у m3-viewer.json:
//   panels: [{ name, path[], mat, tex (0/1 гориз./2 верт.), t, o[3], ax[3], ay[3], az[3], c: [[x1,y1,x2,y2,елемент]…], b: [[елемент, матеріал крайки, товщина]…] }]
//   boxes:  [{ name, path[], min[3], max[3] }] — фурнітура, якої скрипт не бачить як сітку (ручки, петлі…): лише габарит
// Координати — глобальні мм БАЗИСу (Y — вгору), як і кріплення: перегляд кладе їх у ту саму систему.
// Текстури: БАЗИС не віддає скрипту зв'язок «матеріал → файл», тому беремо його з уже збережених колись .dae
// (кеш .cache/texmap.json) і з папки «Документи\Bazis\Текстури». Невідомий матеріал — колір за назвою.

import fs from 'node:fs';
import path from 'node:path';
import { Document } from '@gltf-transform/core';
import { ShapeUtils, Vector2 } from 'three';

const BAZIS_DIR = path.resolve(process.env.USERPROFILE || 'C:/Users/TUROK Y.V', 'Documents', 'Bazis');
const PROJECTS = path.join(BAZIS_DIR, 'Проекти');
const TEXTURES = path.join(BAZIS_DIR, 'Текстури');
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', bmp: 'image/bmp', gif: 'image/gif', webp: 'image/webp' };

// ---------- Матеріал → текстура / колір (з колись збережених .dae) ----------
function findDae(dir, out = [], depth = 0) {
  if (depth > 4) return out;
  let list = [];
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of list) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/_textures$/i.test(e.name)) findDae(p, out, depth + 1); } else if (/\.dae$/i.test(e.name)) out.push(p);
  }
  return out;
}

const attr = (s, name) => (new RegExp(`\\b${name}="([^"]*)"`).exec(s) || [])[1] ?? null;
const unxml = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Розбір одного .dae: назва матеріалу → { file } або { color } */
function daeMaterials(daePath) {
  const xml = fs.readFileSync(daePath, 'utf8');
  const dir = path.dirname(daePath);
  const head = xml.slice(0, xml.indexOf('<library_geometries') > 0 ? xml.indexOf('<library_geometries') : xml.length);
  const images = new Map();
  for (const m of head.matchAll(/<image\b([^>]*)>\s*<init_from>([^<]+)<\/init_from>/g)) images.set(attr(m[1], 'id'), decodeURIComponent(m[2].trim()));
  const effects = new Map();
  for (const m of head.matchAll(/<effect\b([^>]*)>([\s\S]*?)<\/effect>/g)) {
    const body = m[2];
    const e = {};
    const c = /<diffuse>\s*<color[^>]*>([^<]+)<\/color>/.exec(body);
    if (c) {
      const v = c[1].trim().split(/\s+/).map(Number);
      const sc = Math.max(v[0], v[1], v[2]) > 1 ? 255 : 1;
      e.color = [v[0] / sc, v[1] / sc, v[2] / sc];
    }
    const t = /<diffuse>\s*<texture\b([^>]*)\/?>/.exec(body);
    if (t) {
      const sampler = attr(t[1], 'texture');
      const src = new RegExp(`<newparam sid="${sampler}">[\\s\\S]*?<source>([^<]+)</source>`).exec(body);
      const surf = src && new RegExp(`<newparam sid="${src[1]}">[\\s\\S]*?<init_from>([^<]+)</init_from>`).exec(body);
      const rel = images.get(surf ? surf[1].trim() : sampler);
      if (rel && /\.(jpe?g|png|bmp|gif|webp)$/i.test(rel) && !/default\.bmp$/i.test(rel)) {
        const base = path.basename(rel.split('\\').join('/'));
        const cands = [path.join(TEXTURES, 'ByArticle', base), path.join(dir, rel.split('\\').join('/'))];
        const file = cands.find((f) => fs.existsSync(f));
        if (file) e.file = file;
      }
    }
    effects.set(attr(m[1], 'id'), e);
  }
  const out = {};
  for (const m of head.matchAll(/<material\b([^>]*)>\s*<instance_effect url="#([^"]+)"/g)) {
    const name = unxml(attr(m[1], 'name') ?? '').split('\r')[0].trim();
    const e = effects.get(m[2]);
    if (name && e && (e.file || e.color)) out[name] = e;
  }
  return out;
}

/** Кеш «матеріал → текстура/колір» з усіх .dae у папці «Проекти» (перечитує лише змінені файли). */
export function textureMap(cacheFile) {
  let cache = { files: {}, map: {} };
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { }
  let changed = false;
  for (const f of findDae(PROJECTS)) {
    const t = fs.statSync(f).mtimeMs;
    if (cache.files[f] === t) continue;
    try {
      const mats = daeMaterials(f);
      for (const [name, e] of Object.entries(mats)) if (e.file || !cache.map[name]) cache.map[name] = e;
    } catch { }
    cache.files[f] = t;
    changed = true;
  }
  if (changed) {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 1));
  }
  // Головне джерело — база матеріалів самого БАЗИСу (%APPDATA%\Bazis): там і для нових матеріалів є текстура.
  // .dae-кеш лишається запасним.
  return { ...cache.map, ...bazisMaterials() };
}

const APPDATA_BAZIS = path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming'), 'Bazis');
const byArticle = (a) => { const f = a && path.join(TEXTURES, 'ByArticle', `${a}.jpg`); return f && fs.existsSync(f) ? f : null; };

/**
 * Materials.xml: <Material><Name>назва\nартикул</Name>…<Color>COLORREF</Color><Texture>ByArticle\N.jpg</Texture>
 * FurnMaterials.xml (крайки тощо): <Name>назва</Name><Article>N</Article> → Текстури\ByArticle\N.jpg
 * Однакова назва трапляється кілька разів — беремо запис, для якого файл текстури справді є.
 */
function bazisMaterials() {
  const out = {};
  const put = (name, e) => {
    if (!name || (!e.file && !e.color)) return;
    const old = out[name];
    if (!old || (e.file && !old.file)) out[name] = e;
  };
  const read = (f) => { try { return fs.readFileSync(path.join(APPDATA_BAZIS, f), 'utf8'); } catch { return ''; } };
  const tag = (s, t) => (new RegExp(`<${t}>([^<]*)</${t}>`).exec(s) || [])[1];
  for (const m of read('Materials.xml').matchAll(/<Material><Name>([\s\S]*?)<\/Name>([\s\S]*?)<\/Material>/g)) {
    const [name, art] = unxml(m[1]).split(/\r?\n|\r/).map((x) => x.trim());
    const rel = tag(m[2], 'Texture');
    let file = byArticle(art);
    if (!file && rel) { const f = path.join(TEXTURES, ...rel.split(/\\+/)); if (fs.existsSync(f)) file = f; }
    const c = Number(tag(m[2], 'Color'));
    // COLORREF = 0x00BBGGRR; 65280 (чистий зелений) — заглушка БАЗИСу, не колір
    const color = Number.isFinite(c) && c !== 65280 && tag(m[2], 'Color') !== undefined ? [(c & 255) / 255, ((c >> 8) & 255) / 255, ((c >> 16) & 255) / 255] : null;
    put(name, file ? { file } : color ? { color } : {});
  }
  for (const m of read('FurnMaterials.xml').matchAll(/<Material>([\s\S]*?)<\/Material>/g)) {
    const name = unxml(tag(m[1], 'Name') || '').trim();
    const file = byArticle(tag(m[1], 'Article'));
    if (file) put(name, { file });
  }
  return out;
}

// Колір за назвою матеріалу, якщо текстури немає
function colorByName(name) {
  const n = name.toLowerCase();
  const table = [
    [/біл|бел|white|0101|w980|w1000/, [0.93, 0.93, 0.91]],
    [/чорн|черн|black|антрацит/, [0.12, 0.12, 0.13]],
    [/сір|сер|grey|gray|кашемір|кашемир/, [0.62, 0.6, 0.57]],
    [/беж|крем|ваніл|капучин/, [0.85, 0.79, 0.68]],
    [/горіх|орех|венге|коричн/, [0.38, 0.26, 0.18]],
    [/дуб|бук|ясен|сосн|клен|вільх|wood|крафт/, [0.72, 0.56, 0.38]],
    [/хдф|двп/, [0.78, 0.74, 0.68]],
    [/сталь|метал|хром|нікел|алюм/, [0.7, 0.71, 0.72]],
    [/скло|стекл|дзеркал/, [0.75, 0.85, 0.88]],
  ];
  for (const [re, c] of table) if (re.test(n)) return c;
  return [0.8, 0.78, 0.74];
}

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

// ---------- Контур → петлі ----------
// Відрізки [x1,y1,x2,y2,елемент] → замкнені петлі { pts: [[x,y]…] }, найбільша — перша
function loopsOf(segs) {
  const left = segs.slice();
  const loops = [];
  const near = (a, b) => Math.abs(a[0] - b[0]) < 0.2 && Math.abs(a[1] - b[1]) < 0.2;
  while (left.length) {
    const s = left.shift();
    const pts = [[s[0], s[1]], [s[2], s[3]]];
    const el = [s[4]];
    let grown = true;
    while (grown && !near(pts[0], pts[pts.length - 1])) {
      grown = false;
      const end = pts[pts.length - 1];
      for (let i = 0; i < left.length; i++) {
        const t = left[i];
        if (near([t[0], t[1]], end)) { pts.push([t[2], t[3]]); el.push(t[4]); left.splice(i, 1); grown = true; break; }
        if (near([t[2], t[3]], end)) { pts.push([t[0], t[1]]); el.push(t[4]); left.splice(i, 1); grown = true; break; }
      }
    }
    if (pts.length > 3 && near(pts[0], pts[pts.length - 1])) { pts.pop(); loops.push({ pts, el }); }
  }
  const area = (l) => l.pts.reduce((s, p, i) => { const q = l.pts[(i + 1) % l.pts.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
  for (const l of loops) l.area = area(l);
  loops.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
  // Зовнішня — проти годинникової, отвори — за годинниковою: тоді зовнішня нормаль ребра (dy, −dx) скрізь «з матеріалу»
  // (елемент контуру для ребра після цього береться з геометрії — найближчий відрізок)
  loops.forEach((l, i) => { if ((l.area > 0) !== (i === 0)) l.pts.reverse(); });
  return loops;
}

// ---------- Збірка ----------
export function geomToDocument(geom, texMap = {}) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene();
  const top = doc.createNode('node');
  scene.addChild(top);

  // Групи: шлях блоків → вузол
  const groups = new Map();
  const groupNode = (p) => {
    let parent = top, key = '';
    for (const name of p || []) {
      key += '\u0001' + name;
      if (!groups.has(key)) { const n = doc.createNode(name); parent.addChild(n); groups.set(key, n); }
      parent = groups.get(key);
    }
    return parent;
  };

  // Матеріали
  const mats = new Map();
  const textures = new Map();
  let stat = { tex: 0, color: 0 };
  const material = (name) => {
    name = name || 'Матеріал';
    if (mats.has(name)) return mats.get(name);
    const m = doc.createMaterial(name).setRoughnessFactor(0.9).setMetallicFactor(0);
    const e = texMap[name];
    if (e && e.file && fs.existsSync(e.file)) {
      if (!textures.has(e.file)) {
        const ext = path.extname(e.file).slice(1).toLowerCase();
        textures.set(e.file, doc.createTexture(path.basename(e.file)).setImage(new Uint8Array(fs.readFileSync(e.file))).setMimeType(MIME[ext] || 'image/jpeg'));
      }
      m.setBaseColorTexture(textures.get(e.file)).setBaseColorFactor([1, 1, 1, 1]);
      stat.tex++;
    } else {
      const c = (e && e.color) || colorByName(name);
      m.setBaseColorFactor([...c.map(toLinear), 1]);
      stat.color++;
    }
    mats.set(name, m);
    return m;
  };

  // Накопичувач трикутників по матеріалу для однієї деталі
  function builder() {
    const by = new Map();
    const get = (mat) => { if (!by.has(mat)) by.set(mat, { p: [], n: [], uv: [] }); return by.get(mat); };
    return {
      // Трикутник у світових координатах; порядок обходу — під нормаль
      tri(mat, a, b, c, n, ua, ub, uc) {
        const g = get(mat);
        const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        if (cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] < 0) { [b, c] = [c, b]; [ub, uc] = [uc, ub]; }
        g.p.push(...a, ...b, ...c);
        g.n.push(...n, ...n, ...n);
        g.uv.push(...ua, ...ub, ...uc);
      },
      mesh(name) {
        const mesh = doc.createMesh(name);
        for (const [mat, g] of by) {
          if (!g.p.length) continue;
          const prim = doc.createPrimitive().setMaterial(mat);
          prim.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(g.p)).setBuffer(buffer));
          prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(g.n)).setBuffer(buffer));
          prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(g.uv)).setBuffer(buffer));
          mesh.addPrimitive(prim);
        }
        return mesh.listPrimitives().length ? mesh : null;
      },
    };
  }

  let panels = 0, skipped = 0;
  for (const p of geom.panels || []) {
    const loops = loopsOf(p.c || []);
    if (!loops.length) { skipped++; continue; }
    // Елемент ребра: з найближчого відрізка контуру (після розвороту петель)
    const segs = p.c;
    const edgeEl = (a, b) => {
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      let best = null, bd = 1e9;
      for (const s of segs) {
        const d = Math.abs((s[0] + s[2]) / 2 - mx) + Math.abs((s[1] + s[3]) / 2 - my);
        if (d < bd) { bd = d; best = s[4]; }
      }
      return best;
    };
    const T = p.t;
    const W = (x, y, z) => [
      p.o[0] + x * p.ax[0] + y * p.ay[0] + z * p.az[0],
      p.o[1] + x * p.ax[1] + y * p.ay[1] + z * p.az[1],
      p.o[2] + x * p.ax[2] + y * p.ay[2] + z * p.az[2],
    ];
    const N = (x, y, z) => [x * p.ax[0] + y * p.ay[0] + z * p.az[0], x * p.ax[1] + y * p.ay[1] + z * p.az[1], x * p.ax[2] + y * p.ay[2] + z * p.az[2]];
    const vert = p.tex === 2;
    const uvF = (x, y) => (vert ? [y / 1000, x / 1000] : [x / 1000, y / 1000]);
    const face = material(p.mat);
    const butt = new Map((p.b || []).map((b) => [b[0], material(b[1])]));
    const B = builder();

    // Пласті: тріангуляція контуру з отворами
    const outer = loops[0].pts.map(([x, y]) => new Vector2(x, y));
    const holes = loops.slice(1).map((l) => l.pts.map(([x, y]) => new Vector2(x, y)));
    const all = [outer, ...holes].flat();
    const tris = ShapeUtils.triangulateShape(outer, holes);
    const nTop = N(0, 0, 1), nBot = N(0, 0, -1);
    for (const [i, j, k] of tris) {
      const a = all[i], b = all[j], c = all[k];
      B.tri(face, W(a.x, a.y, T), W(b.x, b.y, T), W(c.x, c.y, T), nTop, uvF(a.x, a.y), uvF(b.x, b.y), uvF(c.x, c.y));
      B.tri(face, W(a.x, a.y, 0), W(b.x, b.y, 0), W(c.x, c.y, 0), nBot, uvF(a.x, a.y), uvF(b.x, b.y), uvF(c.x, c.y));
    }
    // Торці: по ребрах кожної петлі, матеріал — крайка цього елемента контуру або сама плита
    for (const l of loops) {
      let run = 0;
      for (let i = 0; i < l.pts.length; i++) {
        const a = l.pts[i], b = l.pts[(i + 1) % l.pts.length];
        const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
        if (len < 1e-6) continue;
        const n = N(dy / len, -dx / len, 0);
        const mat = butt.get(edgeEl(a, b)) || face;
        const u0 = run / 1000, u1 = (run + len) / 1000;
        run += len;
        B.tri(mat, W(a[0], a[1], 0), W(b[0], b[1], 0), W(b[0], b[1], T), n, [u0, 0], [u1, 0], [u1, T / 1000]);
        B.tri(mat, W(a[0], a[1], 0), W(b[0], b[1], T), W(a[0], a[1], T), n, [u0, 0], [u1, T / 1000], [u0, T / 1000]);
      }
    }
    const mesh = B.mesh(p.name);
    if (!mesh) { skipped++; continue; }
    const node = doc.createNode(p.name).setMesh(mesh);
    groupNode(p.path).addChild(node);
    panels++;
  }

  // Фурнітура без сітки: габаритна коробка
  let boxes = 0;
  const metal = doc.createMaterial('Сталь сіра (габарит фурнітури)').setBaseColorFactor([...[0.55, 0.56, 0.58].map(toLinear), 1]).setMetallicFactor(0.6).setRoughnessFactor(0.4);
  for (const b of geom.boxes || []) {
    const lo = b.min, hi = b.max;
    if (![0, 1, 2].every((i) => hi[i] - lo[i] > 0.5)) continue;
    const B = builder();
    const P = (i, j, k) => [i ? hi[0] : lo[0], j ? hi[1] : lo[1], k ? hi[2] : lo[2]];
    const quad = (n, a, b2, c, d) => { B.tri(metal, a, b2, c, n, [0, 0], [1, 0], [1, 1]); B.tri(metal, a, c, d, n, [0, 0], [1, 1], [0, 1]); };
    quad([1, 0, 0], P(1, 0, 0), P(1, 1, 0), P(1, 1, 1), P(1, 0, 1));
    quad([-1, 0, 0], P(0, 0, 0), P(0, 0, 1), P(0, 1, 1), P(0, 1, 0));
    quad([0, 1, 0], P(0, 1, 0), P(0, 1, 1), P(1, 1, 1), P(1, 1, 0));
    quad([0, -1, 0], P(0, 0, 0), P(1, 0, 0), P(1, 0, 1), P(0, 0, 1));
    quad([0, 0, 1], P(0, 0, 1), P(1, 0, 1), P(1, 1, 1), P(0, 1, 1));
    quad([0, 0, -1], P(0, 0, 0), P(0, 1, 0), P(1, 1, 0), P(1, 0, 0));
    groupNode(b.path).addChild(doc.createNode(b.name).setMesh(B.mesh(b.name)));
    boxes++;
  }
  return { doc, panels, boxes, skipped, textured: stat.tex, colored: stat.color };
}
