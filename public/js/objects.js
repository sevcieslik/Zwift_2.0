import * as THREE from 'three';
import { addClip } from './clip.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// Objects standing on the ground, placed from LiDAR: nDSM = DSM (surface) - DTM (bare ground).
//  - trees: local maxima of the canopy height -> instanced trees with the real height and crown size
//  - hedges and dry-stone walls: low, narrow ridges running beside the road -> extruded strips

const ROAD_HALF = 3.6; // half width of the game road ribbon (world.js)

let _leaf = null, _stone = null, _crown = null;
/** Light grey leaf clumps: the per-tree instance colour gives the hue. */
function crownTexture() {
  if (_crown) return _crown;
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#9a9a9a'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 3000; i++) {
    const x = Math.random() * 256, y = Math.random() * 256, r = 2 + Math.random() * 7, l = 45 + Math.random() * 55;
    g.fillStyle = `hsl(0,0%,${l}%)`;
    for (const [dx, dy] of [[0, 0], [256, 0], [-256, 0], [0, 256], [0, -256]]) { g.beginPath(); g.ellipse(x + dx, y + dy, r, r * 0.75, Math.random() * 3, 0, 6.29); g.fill(); }
  }
  _crown = new THREE.CanvasTexture(c);
  _crown.wrapS = _crown.wrapT = THREE.RepeatWrapping; _crown.colorSpace = THREE.SRGBColorSpace; _crown.repeat.set(3, 2);
  return _crown;
}
function leafTexture() {
  if (_leaf) return _leaf;
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#24401c'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2600; i++) {
    const x = Math.random() * 256, y = Math.random() * 256, r = 2 + Math.random() * 6;
    const l = 14 + Math.random() * 22, h = 85 + Math.random() * 35, s = 35 + Math.random() * 25;
    g.fillStyle = `hsl(${h},${s}%,${l}%)`;
    for (const [dx, dy] of [[0, 0], [256, 0], [-256, 0], [0, 256], [0, -256]]) { g.beginPath(); g.ellipse(x + dx, y + dy, r, r * 0.7, Math.random() * 3, 0, 6.29); g.fill(); }
  }
  _leaf = new THREE.CanvasTexture(c);
  _leaf.wrapS = _leaf.wrapT = THREE.RepeatWrapping; _leaf.colorSpace = THREE.SRGBColorSpace; _leaf.anisotropy = 4;
  return _leaf;
}
function stoneTexture() {
  if (_stone) return _stone;
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#3b3a36'; g.fillRect(0, 0, 256, 256); // gaps between stones
  let y = 0;
  while (y < 256) {
    const rh = 14 + Math.random() * 16;
    let x = -Math.random() * 30;
    while (x < 256) {
      const w = 18 + Math.random() * 34;
      const l = 38 + Math.random() * 22, hue = 30 + Math.random() * 40, sat = 4 + Math.random() * 8;
      g.fillStyle = `hsl(${hue},${sat}%,${l}%)`;
      g.beginPath();
      g.roundRect(x + 1.5, y + 1.5, w - 3, rh - 3, 4);
      g.fill();
      // lichen / moss spots
      if (Math.random() < 0.35) { g.fillStyle = `hsla(${70 + Math.random() * 40},35%,${35 + Math.random() * 15}%,0.5)`; g.beginPath(); g.ellipse(x + w * Math.random(), y + rh * Math.random(), 4 + Math.random() * 6, 3, 0, 0, 6.29); g.fill(); }
      x += w;
    }
    y += rh;
  }
  _stone = new THREE.CanvasTexture(c);
  _stone.wrapS = _stone.wrapT = THREE.RepeatWrapping; _stone.colorSpace = THREE.SRGBColorSpace; _stone.anisotropy = 4;
  return _stone;
}

/**
 * Tree positions from the canopy height model.
 * obj(x,z) -> metres above ground (NaN = unknown). Returns [{x, z, h, r}].
 */
export async function findTrees(obj, cx, cz, size, { step = 3, max = 12000, nearRoad, isRoof } = {}) {
  const out = [];
  const h2 = size / 2;
  const nx = Math.floor(size / step), ny = nx;
  // sample once into a grid
  let t0 = performance.now();
  let G;
  if (obj.grid) G = obj.grid(cx - h2, cz - h2, step, nx, ny);
  else {
    G = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      if (performance.now() - t0 > 8) { await new Promise((r) => setTimeout(r, 0)); t0 = performance.now(); }
      for (let i = 0; i < nx; i++) G[j * nx + i] = obj(cx - h2 + i * step, cz - h2 + j * step);
    }
  }
  const at = (i, j) => (i < 0 || j < 0 || i >= nx || j >= ny ? NaN : G[j * nx + i]);
  for (let j = 2; j < ny - 2 && out.length < max; j++) {
    if (performance.now() - t0 > 8) { await new Promise((r) => setTimeout(r, 0)); t0 = performance.now(); }
    for (let i = 2; i < nx - 2; i++) {
      const v = G[j * nx + i];
      if (!(v > 2.5) || v > 45) continue;
      // local maximum among the 8 neighbours (one crown = one tree)
      let isMax = true, lo = Infinity;
      for (let dj = -1; dj <= 1 && isMax; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const w = at(i + di, j + dj);
        if (w > v || (w === v && (dj < 0 || (dj === 0 && di < 0)))) { isMax = false; break; }
      }
      if (!isMax) continue;
      for (const [di, dj] of [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2], [2, -2], [-2, 2]]) lo = Math.min(lo, at(i + di, j + dj));
      // flat roofs, lakes and smooth slopes have no crown shape
      if (!(v - lo > 1.2)) continue;
      const x = cx - h2 + i * step, z = cz - h2 + j * step;
      if (nearRoad && nearRoad(x, z) < ROAD_HALF + 1.5) continue;
      if (isRoof && isRoof(x, z)) continue;
      // crown radius: how far the canopy stays above ~half the tree height
      let r = 1;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        let k = 1;
        while (k < 4 && at(i + di * k, j + dj * k) > v * 0.55) k++;
        r += k * step * 0.25;
      }
      out.push({ x, z, h: v, r: Math.max(1.3, Math.min(7, r * 0.8)) });
    }
  }
  return out;
}

/**
 * Hedges and stone walls along the road.
 * track: Track; obj: fine nDSM sampler; heightFn: ground height; inside(x,z): point within the patch.
 */
export async function buildBoundaries(track, obj, heightFn, inside, nearRoad) {
  const r = track.r, n = track.n;
  const runs = [];
  let t0 = performance.now();
  for (const side of [-1, 1]) {
    let cur = null, gap = 0;
    for (let i = 1; i < n - 1; i++) {
      if (performance.now() - t0 > 8) { await new Promise((res) => setTimeout(res, 0)); t0 = performance.now(); }
      const x = r.x[i], z = -r.y[i];
      let hit = null;
      if (inside(x, z)) {
        let tx = r.x[i + 1] - r.x[i - 1], tz = -(r.y[i + 1] - r.y[i - 1]);
        const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
        const nx = -tz * side, nz = tx * side;
        let best = -1, bo = 0;
        for (let o = 2.5; o <= 9; o += 0.5) {
          const v = obj(x + nx * o, z + nz * o);
          if (v > best) { best = v; bo = o; }
        }
        const edge = obj(x + nx * 1.5, z + nz * 1.5);
        // a low, narrow ridge: higher than the verge, lower than a tree; the verge itself must be clear
        if (best > 0.6 && best < 4.2 && best - (Number.isFinite(edge) ? edge : 0) > 0.45) {
          const out = obj(x + nx * (bo + 2), z + nz * (bo + 2));
          if (!(out > best - 0.3)) hit = { i, o: bo, h: best, nx, nz };
        }
      }
      if (hit) {
        if (!cur) cur = [];
        cur.push(hit); gap = 0;
      } else if (cur) {
        if (++gap > 1) { if (cur.length >= 3) runs.push(cur); cur = null; gap = 0; }
      }
    }
    if (cur && cur.length >= 3) runs.push(cur);
  }
  if (!runs.length) return null;

  const builders = { hedge: newStrip(), wall: newStrip() };
  for (const run of runs) {
    const hs = run.map((p) => p.h).sort((a, b) => a - b);
    const type = hs[hs.length >> 1] < 1.35 ? 'wall' : 'hedge';
    const sm = (k, f) => { let s = 0, c = 0; for (let q = Math.max(0, k - 2); q <= Math.min(run.length - 1, k + 2); q++) { s += f(run[q]); c++; } return s / c; };
    const pts = run.map((p, k) => {
      const o = Math.max(ROAD_HALF + (type === 'wall' ? 0.5 : 0.8), sm(k, (q) => q.o));
      const h = type === 'wall' ? Math.min(1.6, Math.max(0.8, sm(k, (q) => q.h))) : Math.min(3.5, Math.max(1.2, sm(k, (q) => q.h)));
      const x = r.x[p.i] + p.nx * o, z = -r.y[p.i] + p.nz * o;
      return { x, z, y: heightFn(x, z), h, nx: p.nx, nz: p.nz };
    });
    // never across a road (other passes, junctions, hairpins): split the strip there
    let seg = [];
    const flush = () => { if (seg.length >= 3) addStrip(builders[type], seg, type); seg = []; };
    for (const p of pts) {
      if (!Number.isFinite(p.y) || (nearRoad && nearRoad(p.x, p.z) < ROAD_HALF + 0.4)) flush();
      else seg.push(p);
    }
    flush();
  }
  const g = new THREE.Group();
  for (const type of ['hedge', 'wall']) {
    const b = builders[type];
    if (!b.idx.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
    geo.setIndex(b.idx);
    geo.computeVertexNormals();
    const mat = addClip(new THREE.MeshStandardMaterial({
      map: type === 'hedge' ? leafTexture() : stoneTexture(), vertexColors: true, roughness: type === 'hedge' ? 0.9 : 0.95, metalness: 0,
    }), false);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData.keepMap = true; // shared texture: don't dispose with the patch
    g.add(mesh);
  }
  g.userData.count = runs.length;
  return g;
}

function newStrip() { return { pos: [], uv: [], col: [], idx: [] }; }

/** Cross-section: 6 vertices (bottom, shoulder, top on each side), extruded along the points. */
function addStrip(b, pts, type) {
  const base = b.pos.length / 3;
  const W = type === 'hedge' ? 0.75 : 0.35; // half width at the bottom
  let along = 0;
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k];
    if (k) along += Math.hypot(p.x - pts[k - 1].x, p.z - pts[k - 1].z);
    // side vector = road normal (points away from the road)
    const sx = p.nx, sz = p.nz;
    const bump = type === 'hedge' ? (Math.sin(along * 1.7) * 0.12 + Math.sin(along * 4.1 + k) * 0.08) : 0;
    const top = p.y + p.h + bump, sh = p.y + p.h * (type === 'hedge' ? 0.75 : 0.92);
    const topW = type === 'hedge' ? W * 0.55 : W * 0.7, shW = type === 'hedge' ? W * 1.05 : W * 0.85;
    const y0 = p.y - 0.4;
    const vs = [
      [-W, y0], [-shW, sh], [-topW, top], [topW, top], [shW, sh], [W, y0],
    ];
    const vv = [0, sh - y0, p.h + 0.4 + topW, p.h + 0.4 + topW * 3, 2 * (p.h + 0.4) + topW * 4, 2 * (p.h + 0.4) + topW * 4 + (sh - y0)];
    const shade = type === 'hedge' ? 0.8 + Math.random() * 0.35 : 0.85 + Math.random() * 0.25;
    for (let q = 0; q < 6; q++) {
      b.pos.push(p.x + sx * vs[q][0], vs[q][1], p.z + sz * vs[q][0]);
      b.uv.push(along / 2, vv[q] / 2);
      const s = q === 0 || q === 5 ? shade * 0.6 : shade;
      b.col.push(s, s, s);
    }
  }
  for (let k = 0; k + 1 < pts.length; k++) {
    for (let q = 0; q < 5; q++) {
      const a = base + k * 6 + q, c = base + (k + 1) * 6 + q;
      b.idx.push(a, c, a + 1, a + 1, c, c + 1);
    }
  }
  // end caps
  const cap = (k, flip) => {
    const o = base + k * 6;
    const tris = [[0, 1, 5], [1, 4, 5], [1, 2, 4], [2, 3, 4]];
    for (const [a, c, d] of tris) flip ? b.idx.push(o + a, o + d, o + c) : b.idx.push(o + a, o + c, o + d);
  };
  cap(0, false); cap(pts.length - 1, true);
}

/** Instanced trees with the measured height and crown size. */
export function treeMeshes(trees, heightFn, { addClip: clip = true, colorAt } = {}) {
  const N = trees.length;
  const trunkGeo = new THREE.CylinderGeometry(0.12, 0.2, 1, 6); trunkGeo.translate(0, 0.5, 0);
  // unit crowns: conifer (height 1, radius 1) and broadleaf (lumpy sphere, radius 1)
  const conGeo = new THREE.ConeGeometry(1, 1, 8, 3); conGeo.translate(0, 0.5, 0);
  { // a bit of irregularity on the cone
    const p = conGeo.attributes.position;
    for (let i = 0; i < p.count; i++) { const y = p.getY(i); if (y > 0.02 && y < 0.98) { const s = 1 + (Math.sin(i * 12.9898) * 0.5) * 0.25; p.setX(i, p.getX(i) * s); p.setZ(i, p.getZ(i) * s); } }
    conGeo.computeVertexNormals();
  }
  let decGeo = new THREE.IcosahedronGeometry(1, 3);
  decGeo.deleteAttribute('normal'); decGeo = mergeVertices(decGeo); // shared vertices -> smooth crown
  {
    const p = decGeo.attributes.position, v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const k = 1 + 0.16 * Math.sin(v.x * 5.1 + v.y * 3.3) * Math.cos(v.z * 4.7 - v.y * 2.1) + 0.08 * Math.sin(v.x * 11 + v.z * 9);
      v.multiplyScalar(k); v.y *= 0.85;
      p.setXYZ(i, v.x, v.y, v.z);
    }
    decGeo.computeVertexNormals();
  }
  const mk = (geo, color, map) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.95, metalness: 0, map: map || null });
    const im = new THREE.InstancedMesh(geo, clip ? addClip(m, false) : m, Math.max(1, N));
    if (map) im.userData.keepMap = true;
    return im;
  };
  const trunks = mk(trunkGeo, 0x4a3a2c), conifers = mk(conGeo, 0xffffff, crownTexture()), decid = mk(decGeo, 0xffffff, crownTexture());
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3(), col = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);
  let nt = 0, nc = 0, nd = 0;
  for (const t of trees) {
    const y = heightFn(t.x, t.z);
    if (!Number.isFinite(y)) continue;
    const seed = Math.abs(Math.sin(t.x * 12.9898 + t.z * 78.233) * 43758.5453) % 1;
    const conifer = t.conifer !== undefined ? t.conifer : (t.h > 14 && t.r < t.h * 0.22) || seed < 0.25;
    const rot = q.setFromAxisAngle(up, seed * 6.28);
    if (conifer) {
      const trunkH = t.h * 0.25;
      m.compose(v.set(t.x, y - 0.2, t.z), rot, s.set(1 + t.h / 25, trunkH + 0.2, 1 + t.h / 25)); trunks.setMatrixAt(nt++, m);
      const rad = Math.max(1.2, Math.min(t.r, t.h * 0.28));
      m.compose(v.set(t.x, y + trunkH * 0.6, t.z), rot, s.set(rad, t.h - trunkH * 0.6, rad)); conifers.setMatrixAt(nc, m);
      conifers.setColorAt(nc++, colorAt ? colorAt(t, true, col) : col.setHSL(0.3 + seed * 0.06, 0.4, 0.2 + seed * 0.07));
    } else {
      const rad = Math.max(1.3, Math.min(t.r, t.h * 0.55));
      const cy = t.h - rad * 0.85; // crown centre so the top is at the measured height
      m.compose(v.set(t.x, y - 0.2, t.z), rot, s.set(1 + t.h / 20, Math.max(0.8, cy) + 0.2, 1 + t.h / 20)); trunks.setMatrixAt(nt++, m);
      m.compose(v.set(t.x, y + Math.max(rad * 0.6, cy), t.z), rot, s.set(rad, rad, rad)); decid.setMatrixAt(nd, m);
      decid.setColorAt(nd++, colorAt ? colorAt(t, false, col) : col.setHSL(0.21 + seed * 0.08, 0.45, 0.28 + seed * 0.1));
    }
  }
  trunks.count = nt; conifers.count = nc; decid.count = nd;
  conifers.castShadow = decid.castShadow = true;
  const g = new THREE.Group();
  g.add(trunks, conifers, decid);
  return g;
}
