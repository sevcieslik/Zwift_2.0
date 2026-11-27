import * as THREE from 'three';
import { addClip } from './clip.js';

// Buildings from OpenStreetMap footprints, with the height measured by LiDAR (DSM - DTM).
// Rectangular houses get a pitched slate roof along the long side (typical Welsh cottage / terrace),
// other shapes a flat roof. Walls are textured in metres: a window every ~3.2 m on every floor.

const FLOOR = 2.9, BAY = 3.2;
let _tex = null;

function windowLayer(g, W, H) {
  // one bay: window centred, sill and lintel
  const ww = W * 0.36, wh = H * 0.42, wx = (W - ww) / 2, wy = H * 0.3;
  g.fillStyle = 'rgba(40,36,32,0.55)'; g.fillRect(wx - 5, wy - 6, ww + 10, wh + 14); // reveal shadow
  g.fillStyle = '#e9e7e2'; g.fillRect(wx - 3, wy - 3, ww + 6, wh + 6);              // frame
  const gr = g.createLinearGradient(wx, wy, wx + ww, wy + wh);
  gr.addColorStop(0, '#5d6f80'); gr.addColorStop(0.45, '#2a3540'); gr.addColorStop(1, '#3c4a57');
  g.fillStyle = gr; g.fillRect(wx, wy, ww, wh);
  g.fillStyle = '#e9e7e2'; g.fillRect(wx + ww / 2 - 2, wy, 4, wh); g.fillRect(wx, wy + wh * 0.4 - 2, ww, 4); // glazing bars
  g.fillStyle = 'rgba(255,255,255,0.18)'; g.beginPath(); g.moveTo(wx, wy + wh * 0.7); g.lineTo(wx + ww * 0.45, wy); g.lineTo(wx + ww * 0.6, wy); g.lineTo(wx, wy + wh); g.fill();
  g.fillStyle = '#cfcac0'; g.fillRect(wx - 8, wy + wh + 3, ww + 16, 7); // sill
}
function textures() {
  if (_tex) return _tex;
  const mk = (w, h, draw, rep) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
    if (rep) t.repeat.set(rep[0], rep[1]);
    return t;
  };
  const render = mk(256, 256, (g, W, H) => {
    g.fillStyle = '#d9d6cf'; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 2500; i++) { g.fillStyle = `rgba(${Math.random() < 0.5 ? '0,0,0' : '255,255,255'},${Math.random() * 0.06})`; g.fillRect(Math.random() * W, Math.random() * H, 2, 2); }
    g.fillStyle = 'rgba(60,55,45,0.12)'; g.fillRect(0, H - 10, W, 10); // damp line at the bottom of each floor
    windowLayer(g, W, H);
  });
  const stone = mk(256, 256, (g, W, H) => {
    g.fillStyle = '#4a4843'; g.fillRect(0, 0, W, H);
    let y = 0;
    while (y < H) {
      const rh = 12 + Math.random() * 14; let x = -Math.random() * 30;
      while (x < W) {
        const w = 16 + Math.random() * 30, l = 42 + Math.random() * 24;
        g.fillStyle = `hsl(${25 + Math.random() * 30},${5 + Math.random() * 8}%,${l}%)`;
        g.beginPath(); g.roundRect(x + 1.5, y + 1.5, w - 3, rh - 3, 4); g.fill();
        x += w;
      }
      y += rh;
    }
    windowLayer(g, W, H);
  });
  const slate = mk(256, 256, (g, W, H) => {
    g.fillStyle = '#2f343a'; g.fillRect(0, 0, W, H);
    const rows = 16, rh = H / rows;
    for (let r = 0; r < rows; r++) {
      let x = (r % 2) * 10 - 10;
      while (x < W) {
        const w = 18 + Math.random() * 6, l = 22 + Math.random() * 12;
        g.fillStyle = `hsl(210,${6 + Math.random() * 8}%,${l}%)`;
        g.fillRect(x + 1, r * rh + 1, w - 2, rh - 1);
        x += w;
      }
      g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, r * rh + rh - 1.5, W, 1.5);
    }
  });
  const flat = mk(128, 128, (g, W, H) => {
    g.fillStyle = '#55585a'; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(0,0,0,${Math.random() * 0.12})`; g.fillRect(Math.random() * W, Math.random() * H, 2, 2); }
  });
  _tex = { render, stone, slate, flat };
  return _tex;
}

const WALL_TINTS = [[0.98, 0.97, 0.93], [0.96, 0.9, 0.78], [0.9, 0.92, 0.94], [0.8, 0.78, 0.74], [0.97, 0.95, 0.88]];

class Builder {
  constructor() { this.pos = []; this.uv = []; this.col = []; this.idx = []; }
  tri(a, b, c, ua, ub, uc, k) {
    const i = this.pos.length / 3;
    for (const [p, u] of [[a, ua], [b, ub], [c, uc]]) { this.pos.push(p[0], p[1], p[2]); this.uv.push(u[0], u[1]); this.col.push(k[0], k[1], k[2]); }
    this.idx.push(i, i + 1, i + 2);
  }
  quad(a, b, c, d, ua, ub, uc, ud, k) { this.tri(a, b, c, ua, ub, uc, k); this.tri(a, c, d, ua, uc, ud, k); }
  mesh(map) {
    if (!this.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    const m = addClip(new THREE.MeshStandardMaterial({ map, vertexColors: true, roughness: 0.92, metalness: 0 }), false);
    const mesh = new THREE.Mesh(g, m);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData.keepMap = true;
    return mesh;
  }
}

/** Point-in-footprint test (with a margin) for keeping trees out of houses. */
export function footprintIndex(polys, margin = 1.5) {
  const cell = 50, grid = new Map();
  polys.forEach((p, k) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of p) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    p.bb = [x0 - margin, x1 + margin, z0 - margin, z1 + margin];
    for (let gx = Math.floor(p.bb[0] / cell); gx <= Math.floor(p.bb[1] / cell); gx++) for (let gz = Math.floor(p.bb[2] / cell); gz <= Math.floor(p.bb[3] / cell); gz++) {
      const key = gx + ',' + gz; if (!grid.has(key)) grid.set(key, []); grid.get(key).push(k);
    }
  });
  return (x, z) => {
    const list = grid.get(Math.floor(x / cell) + ',' + Math.floor(z / cell));
    if (!list) return false;
    for (const k of list) {
      const p = polys[k];
      if (x < p.bb[0] || x > p.bb[1] || z < p.bb[2] || z > p.bb[3]) continue;
      return true; // bbox + margin is enough here
    }
    return false;
  };
}

/**
 * items: [{pts: [[x,z],...] (closed or open), levels, h, kind}] in world metres
 * heightFn(x,z): ground; objH(x,z): height above ground from LiDAR (may be null)
 */
export function buildingMeshes(items, heightFn, objH) {
  const T = textures();
  const B = { render: new Builder(), stone: new Builder(), slate: new Builder(), flat: new Builder() };
  let count = 0;
  for (const it of items) {
    let pts = it.pts.map(([x, z]) => [x, z]);
    if (pts.length > 1 && Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]) < 0.01) pts.pop();
    if (pts.length < 3) continue;
    // counter-clockwise when looking down (+y) so wall normals face outwards
    let area = 0;
    for (let i = 0; i < pts.length; i++) { const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % pts.length]; area += x1 * z2 - x2 * z1; }
    if (Math.abs(area) < 12) continue; // < ~6 m² : bins, kiosks
    if (area > 0) pts.reverse();
    let gMin = Infinity, gMax = -Infinity, cx = 0, cz = 0;
    for (const [x, z] of pts) { const y = heightFn(x, z); if (!Number.isFinite(y)) { gMin = NaN; break; } gMin = Math.min(gMin, y); gMax = Math.max(gMax, y); cx += x; cz += z; }
    if (!Number.isFinite(gMin)) continue;
    cx /= pts.length; cz /= pts.length;
    const seed = Math.abs(Math.sin(cx * 12.9898 + cz * 78.233) * 43758.5453) % 1;

    // height: OSM tag > LiDAR (median of a few points inside the footprint) > guess
    let H = it.h || (it.levels ? it.levels * FLOOR + 1.5 : NaN);
    if (!Number.isFinite(H) && objH) {
      const hs = [];
      for (const f of [0, 0.35, 0.6]) for (const [x, z] of pts) { const v = objH(cx + (x - cx) * f, cz + (z - cz) * f); if (Number.isFinite(v)) hs.push(v); }
      hs.sort((a, b) => a - b);
      const top = hs.length ? hs[Math.floor(hs.length * 0.8)] : NaN; // ridge-ish
      if (top > 2.2) H = top;
    }
    const small = Math.abs(area) < 40 || /garage|shed|hut|carport/.test(it.kind || '');
    if (!Number.isFinite(H)) H = small ? 3 : 6.5 + seed * 1.5;
    H = Math.max(small ? 2.4 : 3.2, Math.min(28, H));

    const base = gMin - 0.4, top0 = gMax; // walls go into the slope on the low side
    const stoneWall = seed < 0.38;
    const wall = stoneWall ? B.stone : B.render;
    const tint = stoneWall ? [0.95 + seed * 0.1, 0.95 + seed * 0.08, 0.95] : WALL_TINTS[Math.floor(seed * 97) % WALL_TINTS.length];

    // gable roof for (near) rectangles
    let gable = null;
    if (pts.length === 4) {
      let ok = true;
      for (let i = 0; i < 4; i++) {
        const a = pts[(i + 3) % 4], b = pts[i], c = pts[(i + 1) % 4];
        const ux = a[0] - b[0], uz = a[1] - b[1], vx = c[0] - b[0], vz = c[1] - b[1];
        const cos = (ux * vx + uz * vz) / (Math.hypot(ux, uz) * Math.hypot(vx, vz));
        if (Math.abs(cos) > 0.26) ok = false;
      }
      if (ok && it.roof !== 'flat') {
        const e0 = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]), e1 = Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1]);
        const long0 = e0 >= e1; // edges 0-1 and 2-3 are the long (eave) sides
        const short = Math.min(e0, e1);
        const rh = Math.min(short * 0.42, Math.max(1.2, H * 0.45));
        gable = { long0, rh };
      }
    }
    const eave = top0 + (gable ? Math.max(2.3, H - gable.rh) : H);
    const ridge = gable ? eave + gable.rh : eave;

    // walls
    let u = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const u0 = u / BAY, u1 = (u + L) / BAY;
      const vb = (base - top0) / FLOOR, ve = (eave - top0) / FLOOR;
      wall.quad([a[0], base, a[1]], [b[0], base, b[1]], [b[0], eave, b[1]], [a[0], eave, a[1]], [u0, vb], [u1, vb], [u1, ve], [u0, ve], tint);
      // gable end triangle on the short sides
      if (gable && (gable.long0 ? i % 2 === 1 : i % 2 === 0)) {
        const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, vr = (ridge - top0) / FLOOR;
        wall.tri([a[0], eave, a[1]], [b[0], eave, b[1]], [mx, ridge, mz], [u0, ve], [u1, ve], [(u0 + u1) / 2, vr], tint);
      }
      u += L;
    }

    // roof
    const rt = 0.85 + seed * 0.25, rk = [rt, rt, rt * (1.02 + seed * 0.05)];
    if (gable) {
      // eave sides are edges (k, k+1) and (k+2, k+3); ridge runs between the midpoints of the gable edges
      const k = gable.long0 ? 0 : 1;
      const p0 = pts[k], p1 = pts[(k + 1) % 4], p2 = pts[(k + 2) % 4], p3 = pts[(k + 3) % 4];
      const r0 = [(p3[0] + p0[0]) / 2, (p3[1] + p0[1]) / 2], r1 = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
      const ov = 0.35; // overhang
      const ext = (p, r) => { const dx = p[0] - r[0], dz = p[1] - r[1], l = Math.hypot(dx, dz) || 1; return [p[0] + dx / l * ov, p[1] + dz / l * ov]; };
      const alongL = Math.hypot(r1[0] - r0[0], r1[1] - r0[1]);
      const ax = (r1[0] - r0[0]) / alongL, az = (r1[1] - r0[1]) / alongL;
      const endX = (p, s) => [p[0] + ax * ov * s, p[1] + az * ov * s];
      const sl = Math.hypot(gable.rh, Math.hypot(p0[0] - r0[0], p0[1] - r0[1]) + ov) / 2.2;
      const dropY = eave - gable.rh * ov / Math.max(0.5, Math.hypot(p0[0] - r0[0], p0[1] - r0[1]));
      const R0 = endX(r0, -1), R1 = endX(r1, 1);
      const A0 = endX(ext(p0, r0), -1), A1 = endX(ext(p1, r1), 1), C0 = endX(ext(p3, r0), -1), C1 = endX(ext(p2, r1), 1);
      const ua = alongL / 2.2 + 0.3;
      // side 1 (p0-p1) and side 2 (p2-p3), both outward-facing (CCW from outside)
      B.slate.quad([A0[0], dropY, A0[1]], [A1[0], dropY, A1[1]], [R1[0], ridge, R1[1]], [R0[0], ridge, R0[1]], [0, 0], [ua, 0], [ua, sl], [0, sl], rk);
      B.slate.quad([C1[0], dropY, C1[1]], [C0[0], dropY, C0[1]], [R0[0], ridge, R0[1]], [R1[0], ridge, R1[1]], [0, 0], [ua, 0], [ua, sl], [0, sl], rk);
      // underside so the overhang isn't see-through from below
      B.flat.quad([A1[0], dropY - 0.05, A1[1]], [A0[0], dropY - 0.05, A0[1]], [C0[0], dropY - 0.05, C0[1]], [C1[0], dropY - 0.05, C1[1]], [0, 0], [1, 0], [1, 1], [0, 1], [0.6, 0.6, 0.6]);
    } else {
      const shape = pts.map(([x, z]) => new THREE.Vector2(x, z));
      const tris = THREE.ShapeUtils.triangulateShape(shape, []);
      for (const [a, b, c] of tris) {
        const P = (q) => [pts[q][0], eave, pts[q][1]], U = (q) => [pts[q][0] / 4, pts[q][1] / 4];
        B.flat.tri(P(a), P(c), P(b), U(a), U(c), U(b), [1, 1, 1]);
      }
    }
    count++;
  }
  const g = new THREE.Group();
  for (const [key, map] of [['render', T.render], ['stone', T.stone], ['slate', T.slate], ['flat', T.flat]]) {
    const m = B[key].mesh(map);
    if (m) g.add(m);
  }
  g.userData.count = count;
  return g;
}
