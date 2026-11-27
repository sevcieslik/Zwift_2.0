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
      if (nearRoad && nearRoad(x, z) < 1.5) continue; // nearRoad = distance to the road edge
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
        const hw = track.hw[i];
        let best = -1, bo = 0;
        for (let o = Math.max(1.2, hw - 1); o <= hw + 5.5; o += 0.5) {
          const v = obj(x + nx * o, z + nz * o);
          if (v > best) { best = v; bo = o; }
        }
        const edge = obj(x + nx * Math.max(0.5, hw - 1.6), z + nz * Math.max(0.5, hw - 1.6));
        // a low, narrow ridge: higher than the verge, lower than a tree; the verge itself must be clear
        if (best > 0.6 && best < 4.2 && best - (Number.isFinite(edge) ? edge : 0) > 0.45) {
          const out = obj(x + nx * (bo + 2), z + nz * (bo + 2));
          if (!(out > best - 0.3)) hit = { i, o: bo, h: best, nx, nz, hw };
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
      const o = Math.max(p.hw + 1.1 + (type === 'wall' ? 0.35 : 0.75), sm(k, (q) => q.o)); // behind the verge
      const h = type === 'wall' ? Math.min(1.6, Math.max(0.8, sm(k, (q) => q.h))) : Math.min(3.5, Math.max(1.2, sm(k, (q) => q.h)));
      const x = r.x[p.i] + p.nx * o, z = -r.y[p.i] + p.nz * o;
      return { x, z, y: heightFn(x, z), h, nx: p.nx, nz: p.nz };
    });
    // never across a road (other passes, junctions, hairpins): split the strip there
    let seg = [];
    const flush = () => { if (seg.length >= 3) addStrip(builders[type], seg, type); seg = []; };
    for (const p of pts) {
      if (!Number.isFinite(p.y) || (nearRoad && nearRoad(p.x, p.z) < 0.9)) flush();
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

// ---------- trees: leaf-card crowns (like most games), alpha-tested, with a light wind sway ----------
export const WIND = { time: { value: 0 }, k: { value: 1 } };

let _leafCards = null, _firCards = null, _bark = null;
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
function leafCardTexture() {
  if (_leafCards) return _leafCards;
  _leafCards = canvasTex(256, 256, (g, W, H) => {
    // a few twigs
    g.strokeStyle = 'rgba(70,52,35,0.9)'; g.lineWidth = 2;
    for (let i = 0; i < 7; i++) { g.beginPath(); g.moveTo(W / 2, H / 2); g.lineTo(W / 2 + (Math.random() - 0.5) * W * 0.8, H / 2 + (Math.random() - 0.5) * H * 0.8); g.stroke(); }
    // leaves, denser in the middle, ragged edge
    for (let i = 0; i < 950; i++) {
      const a = Math.random() * 6.283, r = Math.pow(Math.random(), 0.6) * W * 0.46;
      const x = W / 2 + Math.cos(a) * r, y = H / 2 + Math.sin(a) * r;
      const len = 6 + Math.random() * 8, rot = Math.random() * 6.283;
      const shade = (H - y) / H; // lighter at the top (sky light)
      g.fillStyle = `hsl(${78 + Math.random() * 34},${38 + Math.random() * 22}%,${16 + Math.random() * 18 + shade * 14}%)`;
      g.beginPath(); g.ellipse(x, y, len, len * 0.45, rot, 0, 6.283); g.fill();
    }
  });
  return _leafCards;
}
function firCardTexture() {
  if (_firCards) return _firCards;
  _firCards = canvasTex(256, 128, (g, W, H) => {
    g.lineCap = 'round';
    const branch = (x0, y0, x1, y1, w, depth) => {
      g.strokeStyle = 'rgb(60,45,32)'; g.lineWidth = Math.max(1, w * 0.25);
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      const L = Math.hypot(x1 - x0, y1 - y0), ux = (x1 - x0) / L, uy = (y1 - y0) / L;
      for (let t = 0; t < L; t += 2.2) {
        const px = x0 + ux * t, py = y0 + uy * t, k = 1 - t / L, nl = w * (0.5 + 0.5 * k);
        for (const sgn of [-1, 1]) {
          const ang = Math.atan2(uy, ux) + sgn * (0.9 + Math.random() * 0.3);
          g.strokeStyle = `hsl(${120 + Math.random() * 30},${28 + Math.random() * 18}%,${10 + Math.random() * 16}%)`;
          g.lineWidth = 1.4;
          g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.cos(ang) * nl, py + Math.sin(ang) * nl); g.stroke();
        }
      }
      if (depth > 0) for (let t = L * 0.15; t < L * 0.85; t += L * 0.18) {
        const px = x0 + ux * t, py = y0 + uy * t, sgn = Math.random() < 0.5 ? -1 : 1;
        const ang = Math.atan2(uy, ux) + sgn * 0.7;
        branch(px, py, px + Math.cos(ang) * L * 0.3 * (1 - t / L), py + Math.sin(ang) * L * 0.3 * (1 - t / L), w * 0.7, depth - 1);
      }
    };
    branch(2, H / 2, W - 6, H / 2, 16, 1);
  });
  return _firCards;
}
function barkTexture() {
  if (_bark) return _bark;
  _bark = canvasTex(64, 128, (g, W, H) => {
    g.fillStyle = '#5a4a3c'; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 160; i++) { g.fillStyle = `hsla(30,15%,${18 + Math.random() * 30}%,0.6)`; g.fillRect(Math.random() * W, Math.random() * H, 1 + Math.random() * 2, 6 + Math.random() * 20); }
  });
  _bark.wrapS = _bark.wrapT = THREE.RepeatWrapping;
  return _bark;
}

/** Merge quads: each {c: centre, u: half-size axis 1, v: half-size axis 2, n: normal for every vertex (fn)} */
function cardsGeometry(cards, shade) {
  const pos = [], nor = [], uv = [], idx = [], col = [];
  for (const q of cards) {
    const b = pos.length / 3;
    const corners = [[-1, -1, 0, 0], [1, -1, 1, 0], [1, 1, 1, 1], [-1, 1, 0, 1]];
    for (const [a, c, tu, tv] of corners) {
      const p = q.c.clone().addScaledVector(q.u, a).addScaledVector(q.v, c);
      pos.push(p.x, p.y, p.z);
      const n = q.n(p); nor.push(n.x, n.y, n.z);
      uv.push(tu, tv);
      const k = shade ? shade(p) : 1; col.push(k, k, k);
    }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}
const rnd = (() => { let s = 12345; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();

/** Broadleaf crown: leaf cards spread over a unit ellipsoid, normals pointing out of the crown (soft, round shading). */
function broadleafCrown(seedShift) {
  for (let i = 0; i < seedShift; i++) rnd();
  const cards = [], V = THREE.Vector3;
  const lumps = []; // 4-6 sub-clumps make an irregular outline instead of a ball
  const nl = 4 + Math.floor(rnd() * 3);
  for (let k = 0; k < nl; k++) lumps.push(new V((rnd() - 0.5) * 0.9, (rnd() - 0.3) * 0.7, (rnd() - 0.5) * 0.9));
  for (let i = 0; i < 64; i++) {
    const L = lumps[i % nl];
    const d = new V(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize();
    const c = L.clone().addScaledVector(d, 0.35 + rnd() * 0.3);
    c.y *= 0.85;
    const n0 = c.clone().normalize();
    const t = new V(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).cross(n0).normalize();
    const b = n0.clone().cross(t).normalize();
    const sz = 0.42 + rnd() * 0.18;
    cards.push({ c, u: t.multiplyScalar(sz), v: b.multiplyScalar(sz), n: (p) => p.clone().multiplyScalar(0.7).add(n0).normalize() });
  }
  return cardsGeometry(cards, (p) => Math.min(1.15, 0.45 + 0.45 * Math.min(1, p.length()) + 0.25 * p.y));
}
/** Conifer: tiers of crossed, drooping branch cards around the trunk; unit height (0..1), unit base radius. */
function coniferCrown() {
  const cards = [], V = THREE.Vector3;
  const tiers = 14;
  for (let t = 0; t < tiers; t++) {
    const y = 0.06 + (t / tiers) * 0.88, rr = 0.08 + (1 - y) * 0.95;
    for (let k = 0; k < 5; k++) {
      const a = t * 0.9 + (k / 5) * 6.283 + rnd() * 0.4;
      const dir = new V(Math.cos(a), -0.28 - rnd() * 0.12, Math.sin(a)).normalize();
      const c = new V(0, y, 0).addScaledVector(dir, rr * 0.5);
      const u = dir.clone().multiplyScalar(rr * 0.52);
      const side = new V(-Math.sin(a), 0, Math.cos(a));
      const nOut = (p) => new V(p.x, 0.45, p.z).normalize();
      cards.push({ c, u, v: side.clone().multiplyScalar(rr * 0.26 + 0.03), n: nOut });          // flat spray
      cards.push({ c, u, v: new V(0, rr * 0.2 + 0.03, 0).applyAxisAngle(dir, 0.3), n: nOut }); // crossed
    }
  }
  return cardsGeometry(cards, (p) => Math.min(1.1, 0.5 + 0.5 * Math.hypot(p.x, p.z) / (0.1 + (1 - p.y)) + 0.15 * p.y));
}
function addWind(m, amp, base) {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    if (prev) prev.call(m, sh, r);
    sh.uniforms.windT = WIND.time;
    sh.uniforms.windK = WIND.k;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float windT, windK;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          float wph = instanceMatrix[3].x * 0.13 + instanceMatrix[3].z * 0.17;
        #else
          float wph = 0.0;
        #endif
        float wk = max(0.0, position.y - (${base.toFixed(2)})) * windK;
        transformed.x += (sin(windT * 1.3 + wph) * 0.6 + sin(windT * 3.1 + wph * 2.0) * 0.25) * ${amp.toFixed(3)} * wk;
        transformed.z += sin(windT * 1.7 + wph * 1.3) * ${(amp * 0.6).toFixed(3)} * wk;`)
      .replace('#include <project_vertex>', '#include <project_vertex>\n  vCamD = -mvPosition.z;')
      .replace('#include <common>', '#include <common>\nvarying float vCamD;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vCamD;')
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (vCamD < 4.0 && fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453) > (vCamD - 1.5) / 2.5) discard;`);
  };
  return m;
}

/** Instanced trees with the measured height and crown size. */
export function treeMeshes(trees, heightFn, { addClip: clip = true } = {}) {
  const N = Math.max(1, trees.length);
  let trunkGeo = new THREE.CylinderGeometry(0.1, 0.17, 1, 7, 1, true); trunkGeo.translate(0, 0.5, 0);
  const crowns = [broadleafCrown(0), broadleafCrown(7), broadleafCrown(19)];
  const fir = coniferCrown();
  const leafMat = (tex, amp, base) => {
    const m = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.9, metalness: 0, vertexColors: true });
    addWind(m, amp, base);
    return clip ? addClip(m, false) : m;
  };
  const decMat = leafMat(leafCardTexture(), 0.025, -0.6);
  const firMat = leafMat(firCardTexture(), 0.02, 0.2);
  const barkMat = new THREE.MeshStandardMaterial({ map: barkTexture(), roughness: 1, metalness: 0 });
  const mk = (geo, mat) => { const im = new THREE.InstancedMesh(geo, clip && mat === barkMat ? addClip(mat, false) : mat, N); im.userData.keepMap = true; return im; };
  const trunks = mk(trunkGeo, barkMat);
  const decs = crowns.map((g) => mk(g, decMat));
  const firs = mk(fir, firMat);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3(), col = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);
  let nt = 0, nf = 0; const nd = [0, 0, 0];
  for (const t of trees) {
    const y = heightFn(t.x, t.z);
    if (!Number.isFinite(y)) continue;
    const seed = Math.abs(Math.sin(t.x * 12.9898 + t.z * 78.233) * 43758.5453) % 1;
    const conifer = t.conifer !== undefined ? t.conifer : (t.h > 14 && t.r < t.h * 0.22) || seed < 0.2;
    q.setFromAxisAngle(up, seed * 6.28);
    if (conifer) {
      const trunkH = t.h * 0.9;
      m.compose(v.set(t.x, y - 0.2, t.z), q, s.set(1 + t.h / 30, trunkH, 1 + t.h / 30)); trunks.setMatrixAt(nt++, m);
      const rad = Math.max(1.1, Math.min(t.r, t.h * 0.24));
      const y0 = t.h * (0.12 + seed * 0.12);
      m.compose(v.set(t.x, y + y0, t.z), q, s.set(rad, t.h - y0, rad)); firs.setMatrixAt(nf, m);
      firs.setColorAt(nf++, col.setRGB(0.82 + seed * 0.2, 0.9 + seed * 0.15, 0.85 + seed * 0.12));
    } else {
      const rad = Math.max(1.4, Math.min(t.r * 1.05, t.h * 0.5));
      const cy = Math.max(rad * 0.75, t.h - rad * 0.8);
      m.compose(v.set(t.x, y - 0.2, t.z), q, s.set(1 + t.h / 22, cy, 1 + t.h / 22)); trunks.setMatrixAt(nt++, m);
      const k = Math.floor(seed * 3) % 3;
      m.compose(v.set(t.x, y + cy, t.z), q, s.set(rad, rad * (0.85 + seed * 0.3), rad)); decs[k].setMatrixAt(nd[k], m);
      decs[k].setColorAt(nd[k]++, col.setRGB(0.85 + seed * 0.3, 0.92 + seed * 0.18, 0.7 + seed * 0.2));
    }
  }
  trunks.count = nt; firs.count = nf; decs.forEach((d, k) => { d.count = nd[k]; });
  const g = new THREE.Group();
  g.add(trunks, firs, ...decs);
  for (const o of [firs, ...decs]) { o.castShadow = true; o.receiveShadow = true; }
  trunks.castShadow = true;
  return g;
}

// ---------- far forests: cheap crossed billboards, from coarse LiDAR canopy heights ----------
let _farTex = null;
function farTreeTextures() {
  if (_farTex) return _farTex;
  const mk = (draw) => {
    const t = canvasTex(128, 256, draw);
    t.anisotropy = 2;
    return t;
  };
  const broad = mk((g, W, H) => {
    g.fillStyle = '#3b2e22'; g.fillRect(W / 2 - 4, H * 0.55, 8, H * 0.45);
    for (let i = 0; i < 700; i++) {
      const a = Math.random() * 6.283, r = Math.pow(Math.random(), 0.55);
      const x = W / 2 + Math.cos(a) * r * W * 0.46, y = H * 0.36 + Math.sin(a) * r * H * 0.3;
      const sh = 1 - (y / H) * 0.9;
      g.fillStyle = `hsl(${80 + Math.random() * 30},${35 + Math.random() * 20}%,${12 + Math.random() * 14 + sh * 14}%)`;
      g.beginPath(); g.arc(x, y, 3 + Math.random() * 5, 0, 6.283); g.fill();
    }
  });
  const conifer = mk((g, W, H) => {
    g.fillStyle = '#33281e'; g.fillRect(W / 2 - 3, H * 0.8, 6, H * 0.2);
    for (let i = 0; i < 900; i++) {
      const y = H * 0.03 + Math.random() * H * 0.82, half = (y / H) * W * 0.48;
      const x = W / 2 + (Math.random() * 2 - 1) * half;
      g.fillStyle = `hsl(${125 + Math.random() * 25},${25 + Math.random() * 20}%,${9 + Math.random() * 13}%)`;
      g.fillRect(x - 2, y, 4, 3);
    }
  });
  _farTex = { broad, conifer };
  return _farTex;
}
function crossGeometry() {
  const a = new THREE.PlaneGeometry(1, 1); a.translate(0, 0.5, 0);
  const b = a.clone(); b.rotateY(Math.PI / 2);
  const g = new THREE.BufferGeometry();
  const pos = [...a.attributes.position.array, ...b.attributes.position.array];
  const uv = [...a.attributes.uv.array, ...b.attributes.uv.array];
  const nor = []; for (let i = 0; i < pos.length; i += 3) nor.push(0, 1, 0); // lit like a canopy from above
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex([0, 2, 1, 2, 3, 1, 4, 6, 5, 6, 7, 5]);
  return g;
}
/** Sample forest positions from a coarse canopy-height sampler. Returns [{x, z, h, conifer, seed}]. */
export function farForest(obj, cx, cz, size, { step = 30, max = 40000 } = {}) {
  const n = Math.floor(size / step), h2 = size / 2, out = [];
  const G = obj.grid ? obj.grid(cx - h2, cz - h2, step, n, n) : null;
  for (let j = 0; j < n && out.length < max; j++) for (let i = 0; i < n; i++) {
    const v = G ? G[j * n + i] : obj(cx - h2 + i * step, cz - h2 + j * step);
    if (!(v > 2.5) || v > 45) continue;
    const r1 = Math.abs(Math.sin((i * 12.9898 + j * 78.233)) * 43758.5453) % 1;
    const r2 = Math.abs(Math.sin((i * 39.346 + j * 11.135)) * 24634.6345) % 1;
    if (r1 > Math.min(1, (v - 2) / 6)) continue; // sparse where the canopy is low (scattered trees)
    out.push({ x: cx - h2 + (i + r1) * step, z: cz - h2 + (j + r2) * step, h: Math.min(28, Math.max(6, v * 1.25)), conifer: v > 13 && r2 < 0.6, seed: r2 });
  }
  return out;
}
export function farForestMeshes(N) {
  const T = farTreeTextures(), geo = crossGeometry();
  const mk = (tex) => {
    const m = addClip(new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 1, metalness: 0 }), false);
    const im = new THREE.InstancedMesh(geo, m, Math.max(1, N));
    im.userData.keepMap = true; im.count = 0; im.frustumCulled = false;
    return im;
  };
  return { broad: mk(T.broad), conifer: mk(T.conifer) };
}
export function placeFarForest(meshes, trees, heightFn, skip) {
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3(), col = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);
  let nb = 0, nc = 0;
  for (const t of trees) {
    if (skip(t.x, t.z)) continue;
    const y = heightFn(t.x, t.z);
    if (!Number.isFinite(y)) continue;
    const w = t.conifer ? t.h * 0.45 : t.h * 0.75;
    q.setFromAxisAngle(up, t.seed * 6.28);
    m.compose(v.set(t.x, y - 0.5, t.z), q, s.set(w, t.h, w));
    col.setRGB(0.85 + t.seed * 0.3, 0.9 + t.seed * 0.2, 0.8 + t.seed * 0.15);
    if (t.conifer) { meshes.conifer.setMatrixAt(nc, m); meshes.conifer.setColorAt(nc++, col); }
    else { meshes.broad.setMatrixAt(nb, m); meshes.broad.setColorAt(nb++, col); }
  }
  meshes.broad.count = nb; meshes.conifer.count = nc;
  for (const im of [meshes.broad, meshes.conifer]) { im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true; }
  return nb + nc;
}
