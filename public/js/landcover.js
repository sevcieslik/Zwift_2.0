import * as THREE from 'three';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { addClip } from './clip.js';

// "Painted" ground: OpenStreetMap land cover (OpenMapTiles vector tiles from OpenFreeMap) is rasterised
// into soft weight maps, and the terrain shader blends sharp tiling textures per class — grass, fields,
// moorland, forest floor, rock, water, town, wetland, sand, tarmac, gravel. Steep slopes turn to rock.
// Lakes get a flat water surface. Satellite imagery is only the fallback.

export const CLASSES = ['grass', 'field', 'moor', 'forest', 'rock', 'water', 'urban', 'wet', 'sand', 'asphalt', 'dirt', 'garden'];
const C = Object.fromEntries(CLASSES.map((n, i) => [n, i]));
const NCLS = CLASSES.length; // 12 -> three RGBA weight textures

// ---------- OpenMapTiles -> class ----------
function landcoverClass(p) {
  const c = p.class, s = p.subclass || '';
  if (c === 'wood') return C.forest;
  if (c === 'rock' || c === 'ice') return C.rock;
  if (c === 'wetland') return C.wet;
  if (c === 'sand') return C.sand;
  if (c === 'farmland') return /orchard|vineyard|plant_nursery/.test(s) ? C.garden : C.field;
  if (c === 'grass') {
    if (/heath|fell|scrub|grassland|tundra/.test(s)) return C.moor;
    if (/garden|park|village_green|recreation_ground|allotments|golf/.test(s)) return C.garden;
    return C.grass; // meadow, grass
  }
  return -1;
}
function landuseClass(p) {
  const c = p.class;
  if (/residential|commercial|industrial|retail|railway|garages|school|university|college|hospital|playground|kindergarten|bus_station|military/.test(c)) return C.urban;
  if (/quarry/.test(c)) return C.rock;
  if (/cemetery|pitch|stadium|park/.test(c)) return C.garden;
  return -1;
}
const ROAD_W = { motorway: 12, trunk: 9, primary: 7.3, secondary: 6.5, tertiary: 5.8, minor: 4.8, service: 3.4, raceway: 6, busway: 6 };
const DIRT_W = { track: 3, path: 1.6, rail: 3.2, transit: 3 };
const RIVER_W = { river: 10, canal: 8, stream: 2.2, drain: 1.4, ditch: 1.2 };

// draw order: later classes win where they overlap
const PRIORITY = [C.urban, C.field, C.garden, C.grass, C.moor, C.wet, C.sand, C.forest, C.rock, C.dirt, C.asphalt, C.water];

const tileXY = (lat, lon, z) => {
  const n = 2 ** z;
  return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2) * n];
};
const tile2lat = (y, z) => { const n = Math.PI - (2 * Math.PI * y) / 2 ** z; return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };

const vtCache = new Map();
function fetchVT(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (!vtCache.has(key)) {
    if (vtCache.size > 200) vtCache.delete(vtCache.keys().next().value);
    vtCache.set(key, fetch(`/vt/${key}`).then((r) => {
      if (!r.ok) throw new Error('vt ' + r.status);
      return r.arrayBuffer();
    }).then((b) => (b.byteLength ? new VectorTile(new PbfReader(new Uint8Array(b))) : { layers: {} })).catch((e) => { vtCache.delete(key); throw e; }));
  }
  return vtCache.get(key);
}

/**
 * Build land-cover weight maps for the square [cx±size/2, cz±size/2].
 * frame: { lat0, lon0, kx, ky } (world x = (lon-lon0)*kx, z = -(lat-lat0)*ky)
 * Returns { textures:[3], water: {polys}, sampleWater(x,z), region:Vector4 } or null.
 */
export async function buildLandcover(frame, cx, cz, size, { z = 14, res = 1024 } = {}) {
  const h = size / 2;
  const lat0 = frame.lat0 - (cz + h) / frame.ky, lat1 = frame.lat0 - (cz - h) / frame.ky;
  const lon0 = frame.lon0 + (cx - h) / frame.kx, lon1 = frame.lon0 + (cx + h) / frame.kx;
  const [tx0, ty0] = tileXY(lat1, lon0, z), [tx1, ty1] = tileXY(lat0, lon1, z);
  const jobs = [];
  for (let ty = Math.floor(ty0); ty <= Math.floor(ty1); ty++) for (let tx = Math.floor(tx0); tx <= Math.floor(tx1); tx++) jobs.push(fetchVT(z, tx, ty).then((t) => [tx, ty, t]));
  const tiles = (await Promise.allSettled(jobs)).filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!tiles.length) return null;

  const pxPerM = res / size;
  const toCanvas = (tx, ty, ext, p) => {
    const gx = tx + p.x / ext, gy = ty + p.y / ext;
    const lon = (gx / 2 ** z) * 360 - 180, lat = tile2lat(gy, z);
    const wx = (lon - frame.lon0) * frame.kx, wz = -(lat - frame.lat0) * frame.ky;
    return [(wx - (cx - h)) * pxPerM, (wz - (cz - h)) * pxPerM, wx, wz];
  };
  // one canvas per class (white = covered); antialiased edges give soft weights
  const cans = CLASSES.map(() => { const c = document.createElement('canvas'); c.width = c.height = res; const g = c.getContext('2d', { willReadFrequently: true }); g.fillStyle = '#fff'; g.strokeStyle = '#fff'; g.lineCap = 'round'; g.lineJoin = 'round'; return g; });
  const waterPolys = [];
  const polyPath = (g, tx, ty, ext, rings, keep) => {
    g.beginPath();
    for (const ring of rings) {
      const pts = ring.map((p) => toCanvas(tx, ty, ext, p));
      pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      if (keep) keep.push(pts.map(([, , wx, wz]) => [wx, wz]));
    }
  };
  for (const [tx, ty, t] of tiles) {
    const L = t.layers;
    const each = (name, fn) => { const l = L[name]; if (!l) return; for (let i = 0; i < l.length; i++) fn(l.feature(i), l.extent); };
    each('landuse', (f, ext) => { const k = landuseClass(f.properties); if (k >= 0 && f.type === 3) { polyPath(cans[k], tx, ty, ext, f.loadGeometry()); cans[k].fill(); } });
    each('landcover', (f, ext) => { const k = landcoverClass(f.properties); if (k >= 0 && f.type === 3) { polyPath(cans[k], tx, ty, ext, f.loadGeometry()); cans[k].fill(); } });
    each('water', (f, ext) => {
      if (f.type !== 3 || f.properties.class === 'swimming_pool' || f.properties.brunnel === 'tunnel') return;
      const rings = [];
      polyPath(cans[C.water], tx, ty, ext, f.loadGeometry(), rings);
      cans[C.water].fill();
      waterPolys.push({ cls: f.properties.class, rings });
    });
    each('waterway', (f, ext) => {
      if (f.type !== 2 || f.properties.brunnel === 'tunnel') return;
      // narrow streams and ditches: damp, darker ground rather than open water
      const g = cans[/river|canal/.test(f.properties.class) ? C.water : C.wet];
      g.lineWidth = Math.max(1, (RIVER_W[f.properties.class] || 2) * pxPerM);
      polyPath(g, tx, ty, ext, f.loadGeometry()); g.stroke();
    });
    each('transportation', (f, ext) => {
      if (f.type !== 2 || f.properties.brunnel === 'tunnel') return;
      const c = f.properties.class;
      const dirt = DIRT_W[c] !== undefined || (c === 'service' && f.properties.surface === 'unpaved') || f.properties.surface === 'unpaved';
      const w = DIRT_W[c] || ROAD_W[c];
      if (!w) return;
      const g = cans[dirt ? C.dirt : C.asphalt];
      g.lineWidth = Math.max(1, w * pxPerM);
      g.beginPath();
      for (const line of f.loadGeometry()) line.forEach((p, i) => { const [x, y] = toCanvas(tx, ty, ext, p); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.stroke();
    });
  }
  await new Promise((r) => setTimeout(r, 0));
  // combine: priority classes cover lower ones; leftover becomes grass
  const N = res * res, masks = cans.map((g) => g.getImageData(0, 0, res, res).data);
  const out = [new Uint8Array(N * 4), new Uint8Array(N * 4), new Uint8Array(N * 4)];
  const waterMask = new Uint8Array(N);
  let t0 = performance.now();
  for (let i = 0; i < N; i++) {
    if ((i & 65535) === 0 && performance.now() - t0 > 10) { await new Promise((r) => setTimeout(r, 0)); t0 = performance.now(); }
    let left = 1;
    for (let k = PRIORITY.length - 1; k >= 0 && left > 0.003; k--) {
      const c = PRIORITY[k];
      const a = masks[c][i * 4 + 3] / 255;
      if (!a) continue;
      const w = a * left;
      out[c >> 2][i * 4 + (c & 3)] = Math.round(w * 255);
      left -= w;
      if (c === C.water) waterMask[i] = masks[c][i * 4 + 3];
    }
    if (left > 0.003) out[C.grass >> 2][i * 4 + (C.grass & 3)] += Math.round(left * 255);
  }
  const textures = out.map((d) => {
    const t = new THREE.DataTexture(d, res, res, THREE.RGBAFormat);
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    return t;
  });
  const sampleWater = (x, zz) => {
    const px = Math.floor((x - (cx - h)) * pxPerM), py = Math.floor((zz - (cz - h)) * pxPerM);
    if (px < 0 || py < 0 || px >= res || py >= res) return 0;
    return waterMask[py * res + px] / 255;
  };
  return { textures, waterPolys, sampleWater, region: new THREE.Vector4(cx - h, cz - h, size, size), res };
}

// ---------- tiling ground textures (procedural, seamless) ----------
let _arr = null;
function groundTextures() {
  if (_arr) return _arr;
  const S = 256;
  const data = new Uint8Array(S * S * 4 * NCLS);
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d', { willReadFrequently: true });
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const wrap = (fn) => { for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) fn(dx, dy); };
  const dots = (n, rmin, rmax, colorFn, shape = 'ellipse') => {
    for (let i = 0; i < n; i++) {
      const x = rnd() * S, y = rnd() * S, r = rmin + rnd() * (rmax - rmin), rot = rnd() * 3.14, col = colorFn();
      wrap((dx, dy) => {
        g.fillStyle = col;
        g.beginPath();
        if (shape === 'blade') { g.ellipse(x + dx, y + dy, r * 0.25, r, rot * 0.3 - 0.15, 0, 6.283); } else g.ellipse(x + dx, y + dy, r, r * (0.6 + rnd() * 0.4), rot, 0, 6.283);
        g.fill();
      });
    }
  };
  const hsl = (h, s, l, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;
  const R = (a, b) => a + rnd() * (b - a);
  const painters = {
    grass: () => { g.fillStyle = '#4f7a30'; g.fillRect(0, 0, S, S); dots(900, 5, 14, () => hsl(R(82, 100), R(40, 55), R(24, 36), 0.35)); dots(4000, 2, 5, () => hsl(R(75, 105), R(40, 60), R(20, 45), 0.8), 'blade'); },
    field: () => { g.fillStyle = '#7d9a3c'; g.fillRect(0, 0, S, S); for (let y = 0; y < S; y += 16) { g.fillStyle = `rgba(255,255,200,${0.05 + (y / 16 % 2) * 0.05})`; g.fillRect(0, y, S, 8); } dots(3000, 1.5, 4, () => hsl(R(70, 95), R(40, 60), R(30, 50), 0.7), 'blade'); },
    moor: () => { g.fillStyle = '#6b6a38'; g.fillRect(0, 0, S, S); dots(700, 5, 16, () => (rnd() < 0.35 ? hsl(R(290, 330), R(15, 30), R(28, 40), 0.45) : hsl(R(45, 70), R(30, 45), R(22, 38), 0.5))); dots(2200, 1.5, 4, () => hsl(R(55, 90), R(25, 45), R(20, 40), 0.8), 'blade'); },
    forest: () => { g.fillStyle = '#3a3a24'; g.fillRect(0, 0, S, S); dots(1500, 2, 7, () => hsl(R(25, 45), R(30, 50), R(15, 28), 0.7)); dots(600, 3, 9, () => hsl(R(85, 120), R(30, 45), R(15, 25), 0.6)); },
    rock: () => { g.fillStyle = '#7b7974'; g.fillRect(0, 0, S, S); dots(500, 6, 22, () => hsl(R(30, 50), R(3, 10), R(35, 60), 0.6)); g.strokeStyle = 'rgba(40,38,36,0.5)'; g.lineWidth = 1.2; for (let i = 0; i < 40; i++) { let x = rnd() * S, y = rnd() * S; g.beginPath(); g.moveTo(x, y); for (let k = 0; k < 5; k++) { x += R(-14, 14); y += R(-14, 14); g.lineTo(x, y); } g.stroke(); } dots(150, 2, 6, () => hsl(R(60, 90), 30, R(40, 55), 0.5)); },
    water: () => { g.fillStyle = '#33443a'; g.fillRect(0, 0, S, S); dots(400, 4, 14, () => hsl(R(70, 110), R(10, 25), R(16, 28), 0.4)); dots(200, 2, 6, () => hsl(30, 10, R(35, 50), 0.5)); }, // riverbed: under lake planes / in streams
    urban: () => { g.fillStyle = '#7f7f78'; g.fillRect(0, 0, S, S); for (let i = 0; i < 18; i++) { g.fillStyle = hsl(R(30, 60), R(3, 10), R(40, 60), 0.6); const x = rnd() * S, y = rnd() * S; g.fillRect(x, y, R(20, 70), R(20, 70)); } dots(400, 3, 10, () => hsl(R(85, 110), R(30, 45), R(25, 38), 0.6)); },
    wet: () => { g.fillStyle = '#5a6438'; g.fillRect(0, 0, S, S); dots(400, 6, 18, () => hsl(R(70, 100), R(15, 30), R(15, 25), 0.4)); dots(2500, 2, 6, () => hsl(R(55, 85), R(30, 50), R(30, 50), 0.7), 'blade'); },
    sand: () => { g.fillStyle = '#cdb98e'; g.fillRect(0, 0, S, S); dots(3000, 0.8, 2, () => hsl(R(35, 45), R(25, 40), R(55, 80), 0.6)); },
    asphalt: () => { g.fillStyle = '#4a4b4e'; g.fillRect(0, 0, S, S); dots(5000, 0.6, 1.6, () => hsl(220, 3, R(20, 50), 0.8)); },
    dirt: () => { g.fillStyle = '#7d6a4e'; g.fillRect(0, 0, S, S); dots(2500, 1, 3.5, () => hsl(R(25, 40), R(10, 25), R(30, 60), 0.75)); },
    garden: () => { g.fillStyle = '#5c8c38'; g.fillRect(0, 0, S, S); dots(3500, 2, 4.5, () => hsl(R(85, 105), R(45, 60), R(28, 48), 0.8), 'blade'); },
  };
  CLASSES.forEach((name, k) => {
    g.clearRect(0, 0, S, S);
    painters[name]();
    data.set(g.getImageData(0, 0, S, S).data, k * S * S * 4);
  });
  const t = new THREE.DataArrayTexture(data, S, S, NCLS);
  t.format = THREE.RGBAFormat;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return (_arr = t);
}

/** Terrain material that paints the ground from land-cover weights. */
export function landMaterial(lc, detail) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
  const arr = groundTextures();
  m.onBeforeCompile = (sh) => {
    sh.uniforms.lcW0 = { value: lc.textures[0] }; sh.uniforms.lcW1 = { value: lc.textures[1] }; sh.uniforms.lcW2 = { value: lc.textures[2] };
    sh.uniforms.lcRegion = { value: lc.region };
    sh.uniforms.lcTex = { value: arr };
    sh.uniforms.detailMap = { value: detail };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWN;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWN = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        precision highp sampler2DArray;
        varying vec3 vWPos; varying vec3 vWN;
        uniform sampler2D lcW0, lcW1, lcW2, detailMap; uniform sampler2DArray lcTex; uniform vec4 lcRegion;
        vec3 lcLayer(float k, vec2 p, float far) {
          vec3 a = texture(lcTex, vec3(p * 0.16, k)).rgb;            // ~6 m repeat
          vec3 b = texture(lcTex, vec3(p * 0.021 + 0.37, k)).rgb;    // ~48 m repeat breaks tiling
          return mix(mix(a, b, 0.4), b, far);
        }`)
      .replace('#include <map_fragment>', `
        float camD = length(vWPos - cameraPosition);
        float far = smoothstep(60.0, 700.0, camD);
        // organic borders: jitter the weight lookup with noise (a few metres)
        float n1 = texture2D(detailMap, vWPos.xz * 0.013).r, n2 = texture2D(detailMap, vWPos.xz * 0.013 + 0.5).r;
        vec2 luv = (vWPos.xz - lcRegion.xy) / lcRegion.zw + (vec2(n1, n2) - 0.5) * (6.0 / lcRegion.z);
        vec4 w0 = texture2D(lcW0, luv), w1 = texture2D(lcW1, luv), w2 = texture2D(lcW2, luv);
        float ws[12] = float[12](w0.r, w0.g, w0.b, w0.a, w1.r, w1.g, w1.b, w1.a, w2.r, w2.g, w2.b, w2.a);
        // steep ground shows rock (not under water or tarmac)
        float steep = smoothstep(0.42, 0.62, 1.0 - vWN.y) * (1.0 - ws[5] - ws[9]);
        vec3 col = vec3(0.0); float tot = 0.0;
        for (int k = 0; k < 12; k++) {
          float w = ws[k] * (1.0 - steep);
          if (k == 4) w += steep;
          if (w > 0.01) { col += lcLayer(float(k), vWPos.xz, far) * w; tot += w; }
        }
        col /= max(tot, 0.001);
        // patchwork of pastures: neighbouring fields differ a little in tone (only on open grass/fields)
        float open_ = ws[0] + ws[1];
        float parcel = texture2D(detailMap, floor(vWPos.xz / 70.0 + vec2(n1, n2) * 0.6) * 0.173).r;
        col *= mix(vec3(1.0), mix(vec3(0.9, 0.97, 0.82), vec3(1.08, 1.04, 0.92), parcel), open_ * (1.0 - steep));
        // large-scale variation so wide areas aren't flat
        float d2 = texture2D(detailMap, vWPos.xz * 0.004).r;
        float d1 = texture2D(detailMap, vWPos.xz * 0.05).r;
        col *= 0.82 + d2 * 0.3 + (d1 - 0.5) * 0.12 * (1.0 - far);
        diffuseColor.rgb *= col;`);
  };
  return addClip(m, false);
}

/** Flat water surfaces for lakes and ponds, with a sky reflection. */
export function waterMeshes(lc, heightFn, skyColor) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x1d3a44, roughness: 0.06, metalness: 0.0, transparent: true, opacity: 0.94 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.skyCol = { value: skyColor };
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 skyCol;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float fres = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 4.0);
        totalEmissiveRadiance += skyCol * (0.08 + fres * 0.75);`);
  };
  addClip(mat, false);
  const lowered = [];
  for (const wp of lc.waterPolys) {
    if (!['lake', 'pond', 'river', 'dock', 'basin', 'reservoir'].includes(wp.cls) && wp.cls) continue;
    const outer = wp.rings[0];
    if (!outer || outer.length < 4) continue;
    let area = 0;
    for (let i = 0; i < outer.length; i++) { const [a, b] = outer[i], [c2, d] = outer[(i + 1) % outer.length]; area += a * d - c2 * b; }
    if (Math.abs(area) / 2 < 300) continue;
    // water level: low percentile of the shore heights; skip sloping river polygons
    const hs = [];
    for (const ring of wp.rings) for (const [x, z] of ring) { const y = heightFn(x, z); if (Number.isFinite(y)) hs.push(y); }
    if (hs.length < 4) continue;
    hs.sort((a, b) => a - b);
    const lo = hs[Math.floor(hs.length * 0.1)], hi = hs[Math.floor(hs.length * 0.9)];
    if (hi - lo > 6) continue;
    const level = lo + 0.05;
    for (const ring of wp.rings) {
      // ring orientation decides outer/hole after the y-flip; let ShapeUtils sort it out per ring
      const pts = ring.map(([x, z]) => new THREE.Vector2(x, -z));
      if (pts.length < 3) continue;
      const shape = new THREE.Shape(pts);
      const geo = new THREE.ShapeGeometry(shape);
      geo.rotateX(-Math.PI / 2); // (x, -z) -> (x, 0, z), facing up
      geo.translate(0, level, 0);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      g.add(mesh);
      break; // outer ring only (islands are rare at this scale)
    }
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of outer) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    lowered.push({ level, bb: [x0, x1, z0, z1] });
  }
  g.userData.lowered = lowered;
  return g;
}

/** Push the terrain under lake surfaces down so the water plane shows (never next to the road). */
export function lowerUnderWater(geo, lc, lowered, roadEdge) {
  if (!lowered.length) return;
  const p = geo.attributes.position;
  let changed = false;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    if (lc.sampleWater(x, z) < 0.35) continue;
    const y = p.getY(i);
    for (const L of lowered) {
      const [x0, x1, z0, z1] = L.bb;
      if (x < x0 || x > x1 || z < z0 || z > z1 || y > L.level + 1.5) continue;
      if (roadEdge && roadEdge(x, z) < 2) break;
      p.setY(i, Math.min(y, L.level - 0.9));
      changed = true;
      break;
    }
  }
  if (changed) { p.needsUpdate = true; geo.computeVertexNormals(); }
}
