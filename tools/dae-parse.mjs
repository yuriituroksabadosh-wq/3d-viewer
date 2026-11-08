// Швидкий розбір COLLADA (.dae) з БАЗИСу прямо в документ glTF-Transform — замість assimp (~в 10 разів швидше).
// БАЗИС пише .dae експортером assimp, тож структура проста й передбачувана:
//   library_images / effects / materials, library_geometries (polylist або triangles), один visual_scene.
// Результат повторює те, що давав assimp: вузли з id як назвою, по сітці на кожен instance_geometry,
// кореневий вузол «node» з поворотом Z-up → Y-up, UV з переворотом (t → 1 − t), шершавість 0,96.
// Якщо щось незрозуміле — кидаємо помилку, і конвертер відкочується на assimp.

import fs from 'node:fs';
import path from 'node:path';
import { Document } from '@gltf-transform/core';

const attr = (s, name) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(s);
  return m ? m[1] : null;
};
const unxml = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Числа з тексту — швидко, без split/regex на мільйонах значень. */
function parseNumbers(text, Out = Float32Array) {
  const out = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    let c = text.charCodeAt(i);
    while (i < n && (c === 32 || c === 10 || c === 13 || c === 9)) c = text.charCodeAt(++i);
    if (i >= n) break;
    const start = i;
    while (i < n && !(c === 32 || c === 10 || c === 13 || c === 9)) c = text.charCodeAt(++i);
    out.push(+text.slice(start, i));
  }
  return Out.from(out);
}

const between = (s, open, close, from = 0) => {
  const a = s.indexOf(open, from);
  if (a < 0) return null;
  const b = s.indexOf(close, a);
  if (b < 0) throw new Error(`Не закрито ${open}`);
  return { text: s.slice(a, b + close.length), end: b + close.length, start: a };
};

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', bmp: 'image/bmp', gif: 'image/gif', webp: 'image/webp', tga: 'image/x-tga' };

export function daeToDocument(daePath) {
  const xml = fs.readFileSync(daePath, 'utf8');
  const dir = path.dirname(daePath);
  const up = (/<up_axis>\s*([A-Z_]+)\s*<\/up_axis>/.exec(xml) || [])[1] || 'Y_UP';
  if (up !== 'Z_UP' && up !== 'Y_UP') throw new Error(`Непідтримувана вісь ${up}`);

  const doc = new Document();
  const buffer = doc.createBuffer();

  // ---- Зображення → текстури ----
  const images = new Map(); // id → { rel, bytes, mime }
  for (const m of xml.matchAll(/<image\b([^>]*)>\s*<init_from>([^<]+)<\/init_from>/g)) {
    const rel = decodeURIComponent(m[2].trim());
    const file = path.join(dir, rel.split('\\').join('/'));
    const ext = path.extname(rel).slice(1).toLowerCase();
    images.set(attr(m[1], 'id'), { rel, bytes: fs.existsSync(file) ? fs.readFileSync(file) : null, mime: MIME[ext] || 'image/jpeg' });
  }
  const textures = new Map();
  const textureFor = (imageId) => {
    if (textures.has(imageId)) return textures.get(imageId);
    const im = images.get(imageId);
    let tex = null;
    if (im && im.bytes) tex = doc.createTexture(path.basename(im.rel)).setImage(new Uint8Array(im.bytes)).setMimeType(im.mime).setURI(im.rel);
    textures.set(imageId, tex);
    return tex;
  };

  // ---- Ефекти: колір або текстура ----
  const effects = new Map(); // id → { color, imageId }
  for (const m of xml.matchAll(/<effect\b([^>]*)>([\s\S]*?)<\/effect>/g)) {
    const body = m[2];
    const e = { color: [1, 1, 1, 1], imageId: null };
    const c = /<diffuse>\s*<color[^>]*>([^<]+)<\/color>/.exec(body);
    if (c) {
      const v = c[1].trim().split(/\s+/).map(Number);
      e.color = [v[0], v[1], v[2], v.length > 3 ? v[3] : 1];
    }
    const t = /<diffuse>\s*<texture\b([^>]*)\/?>/.exec(body);
    if (t) {
      // texture → sampler → surface → image
      const sampler = attr(t[1], 'texture');
      const src = new RegExp(`<newparam sid="${sampler}">[\\s\\S]*?<source>([^<]+)</source>`).exec(body);
      const surf = src && new RegExp(`<newparam sid="${src[1]}">[\\s\\S]*?<init_from>([^<]+)</init_from>`).exec(body);
      e.imageId = surf ? surf[1].trim() : sampler;
    }
    effects.set(attr(m[1], 'id'), e);
  }

  // ---- Матеріали ----
  const materials = new Map(); // id → Material
  for (const m of xml.matchAll(/<material\b([^>]*)>\s*<instance_effect url="#([^"]+)"/g)) {
    const id = attr(m[1], 'id');
    const name = unxml(attr(m[1], 'name') ?? id);
    const e = effects.get(m[2]) || { color: [1, 1, 1, 1] };
    const mat = doc.createMaterial(name).setRoughnessFactor(0.96).setMetallicFactor(0);
    const tex = e.imageId ? textureFor(e.imageId) : null;
    if (tex) mat.setBaseColorTexture(tex).setBaseColorFactor([1, 1, 1, 1]);
    else mat.setBaseColorFactor(e.color);
    materials.set(id, mat);
  }
  let fallbackMat = null;
  const getMat = (id) => materials.get(id) || (fallbackMat ||= doc.createMaterial('DefaultMaterial').setRoughnessFactor(0.96).setMetallicFactor(0));

  // ---- Геометрія: розбираємо ліниво, коли знадобиться ----
  const geomAt = new Map(); // id → [start, end] у тексті
  for (const m of xml.matchAll(/<geometry\b([^>]*)>/g)) geomAt.set(attr(m[1], 'id'), m.index);

  function buildPrimitive(geomId, bindings) {
    const at = geomAt.get(geomId);
    if (at === undefined) throw new Error(`Немає геометрії ${geomId}`);
    const g = between(xml, '<geometry', '</geometry>', at).text;
    const sources = new Map();
    for (const s of g.matchAll(/<source\b([^>]*)>\s*<float_array[^>]*>([^<]*)<\/float_array>[\s\S]*?<accessor\b([^>]*)>/g)) {
      sources.set(attr(s[1], 'id'), { data: parseNumbers(s[2]), stride: Number(attr(s[3], 'stride') || 3) });
    }
    const vertsInputs = new Map(); // semantic → source id (з <vertices>)
    const v = /<vertices\b([^>]*)>([\s\S]*?)<\/vertices>/.exec(g);
    const vertsId = v ? attr(v[1], 'id') : null;
    if (v) for (const i of v[2].matchAll(/<input\b([^>]*)\/>/g)) vertsInputs.set(attr(i[1], 'semantic'), attr(i[1], 'source').slice(1));

    const polys = [...g.matchAll(/<(polylist|triangles|polygons)\b([^>]*)>([\s\S]*?)<\/\1>/g)];
    if (!polys.length) return [];
    const prims = [];
    for (const [, kind, head, body] of polys) {
      if (kind === 'polygons') throw new Error('polygons не підтримується');
      const inputs = [...body.matchAll(/<input\b([^>]*)\/>/g)].map((i) => ({
        semantic: attr(i[1], 'semantic'), source: attr(i[1], 'source').slice(1), offset: Number(attr(i[1], 'offset') || 0), set: Number(attr(i[1], 'set') || 0),
      }));
      const stride = Math.max(...inputs.map((i) => i.offset)) + 1;
      const p = parseNumbers((/<p>([^<]*)<\/p>/.exec(body) || [, ''])[1], Uint32Array);
      const vc = kind === 'polylist' ? parseNumbers((/<vcount>([^<]*)<\/vcount>/.exec(body) || [, ''])[1], Uint32Array) : null;

      // Канали: позиція, нормаль, UV0 → (джерело, зсув у <p>)
      const ch = {};
      for (const i of inputs) {
        if (i.semantic === 'VERTEX' && i.source === vertsId) {
          for (const [sem, src] of vertsInputs) ch[sem === 'POSITION' ? 'POSITION' : sem] = { src, offset: i.offset };
        } else if (i.semantic === 'NORMAL') ch.NORMAL = { src: i.source, offset: i.offset };
        else if (i.semantic === 'TEXCOORD' && i.set === 0 && !ch.TEXCOORD) ch.TEXCOORD = { src: i.source, offset: i.offset };
      }
      if (!ch.POSITION) throw new Error(`Без позицій: ${geomId}`);

      // Кути полігонів → трикутники (віялом), кожен кут — окрема вершина, як у assimp
      const corners = [];
      if (vc) {
        let k = 0;
        for (const n of vc) {
          for (let t = 1; t + 1 < n; t++) corners.push(k, k + t, k + t + 1);
          k += n;
        }
      } else {
        for (let k = 0; k < p.length / stride; k++) corners.push(k);
      }
      const count = corners.length;
      const take = (c, size, flipT) => {
        if (!c) return null;
        const s = sources.get(c.src);
        if (!s) throw new Error(`Немає джерела ${c.src}`);
        const out = new Float32Array(count * size);
        for (let k = 0; k < count; k++) {
          const idx = p[corners[k] * stride + c.offset] * s.stride;
          for (let j = 0; j < size; j++) out[k * size + j] = s.data[idx + j] || 0;
          if (flipT) out[k * size + 1] = 1 - out[k * size + 1];
        }
        return out;
      };
      const symbol = attr(head, 'material');
      const prim = doc.createPrimitive().setMaterial(getMat(bindings.get(symbol) ?? [...bindings.values()][0]));
      prim.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(take(ch.POSITION, 3)).setBuffer(buffer));
      const nrm = take(ch.NORMAL, 3);
      if (nrm) prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(nrm).setBuffer(buffer));
      const uv = take(ch.TEXCOORD, 2, true);
      if (uv) prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(uv).setBuffer(buffer));
      const idx = new Uint32Array(count);
      for (let k = 0; k < count; k++) idx[k] = k;
      prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(idx).setBuffer(buffer));
      prims.push(prim);
    }
    return prims;
  }

  // ---- Сцена: обхід вузлів ----
  const vs = between(xml, '<visual_scene', '</visual_scene>');
  if (!vs) throw new Error('Немає visual_scene');
  const sceneHead = /<visual_scene\b([^>]*)>/.exec(vs.text)[1];
  const scene = doc.createScene();
  // Корінь, як у assimp: id сцени, поворот Z-up → Y-up
  const top = doc.createNode(attr(sceneHead, 'id') || 'node');
  if (up === 'Z_UP') top.setMatrix([1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
  scene.addChild(top);

  const stack = [top];
  let pendingGeom = null;
  let meshCount = 0;
  const tagRe = /<(\/?)(node|matrix|instance_geometry|instance_material|translate|rotate|scale|lookat|skew|instance_node)\b([^>]*?)(\/?)>/g;
  tagRe.lastIndex = 0;
  const text = vs.text;
  let m;
  while ((m = tagRe.exec(text))) {
    const [, close, tag, head, selfClose] = m;
    const cur = stack[stack.length - 1];
    if (tag === 'node') {
      if (close) { stack.pop(); continue; }
      const node = doc.createNode(attr(head, 'id') || unxml(attr(head, 'name') || ''));
      cur.addChild(node);
      if (!selfClose) stack.push(node);
    } else if (tag === 'matrix' && !close) {
      const end = text.indexOf('</matrix>', tagRe.lastIndex);
      const v = parseNumbers(text.slice(tagRe.lastIndex, end), Float64Array);
      if (v.length !== 16) throw new Error('Погана матриця');
      // COLLADA — по рядках, glTF — по стовпцях
      cur.setMatrix([v[0], v[4], v[8], v[12], v[1], v[5], v[9], v[13], v[2], v[6], v[10], v[14], v[3], v[7], v[11], v[15]]);
      tagRe.lastIndex = end;
    } else if (['translate', 'rotate', 'scale', 'lookat', 'skew', 'instance_node'].includes(tag) && !close) {
      throw new Error(`Непідтримуваний елемент <${tag}>`);
    } else if (tag === 'instance_geometry') {
      if (!close) pendingGeom = { url: attr(head, 'url').slice(1), mats: new Map() };
      if (close || selfClose) {
        // Кожен instance_geometry — свій вузол-сітка (як у assimp)
        const prims = buildPrimitive(pendingGeom.url, pendingGeom.mats);
        if (prims.length) {
          const mesh = doc.createMesh(pendingGeom.url);
          prims.forEach((p) => mesh.addPrimitive(p));
          if (cur.getMesh()) {
            const holder = doc.createNode(pendingGeom.url);
            holder.setMesh(mesh);
            cur.addChild(holder);
          } else cur.setMesh(mesh);
          meshCount++;
        }
        pendingGeom = null;
      }
    } else if (tag === 'instance_material' && !close && pendingGeom) {
      pendingGeom.mats.set(attr(head, 'symbol'), attr(head, 'target').slice(1));
    }
  }
  if (!meshCount) throw new Error('Жодної сітки');
  return doc;
}
