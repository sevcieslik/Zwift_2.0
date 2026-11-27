import * as THREE from 'three';
import { addClip } from './clip.js';
import { findTrees, buildBoundaries, treeMeshes } from './objects.js';
import { buildingMeshes, footprintIndex } from './buildings.js';

// Real terrain from elevation tiles (Terrarium encoding) + satellite imagery, streamed around the rider.
// Near patch: ~3 km, ~12 m grid, z13 elevation + z14 imagery, trees where the imagery shows forest.
// Far ring: ~40 km, ~200 m grid, z10 elevation + z11 imagery — mountains on the horizon.
// Falls back to procedural hills when tiles are unavailable.

const R = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

const NEAR = { size: 3000, seg: 240, elevZ: 13, satZ: 14, snap: 500 };
const FAR = { size: 40000, seg: 200, elevZ: 10, satZ: 11, snap: 5000 };

function hash2(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
}
export const fbm = (x, y) => vnoise(x / 400, y / 400) * 0.6 + vnoise(x / 150, y / 150) * 0.3 + vnoise(x / 50, y / 50) * 0.1;

function detailTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const img = g.createImageData(256, 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    // tileable noise
    let v = 0, amp = 0.5, f = 8;
    for (let o = 0; o < 4; o++) {
      const nx = (x / 256) * f, ny = (y / 256) * f;
      const xi = Math.floor(nx), yi = Math.floor(ny), xf = nx - xi, yf = ny - yi;
      const h = (a, b) => hash2(((a % f) + f) % f + o * 97, ((b % f) + f) % f);
      const u = xf * xf * (3 - 2 * xf), w = yf * yf * (3 - 2 * yf);
      const n = h(xi, yi) * (1 - u) * (1 - w) + h(xi + 1, yi) * u * (1 - w) + h(xi, yi + 1) * (1 - u) * w + h(xi + 1, yi + 1) * u * w;
      v += n * amp; amp *= 0.5; f *= 2;
    }
    const k = Math.max(0, Math.min(255, v * 255 + (Math.random() - 0.5) * 30));
    const i = (y * 256 + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = k; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function terrainMaterial(map, detail) {
  const m = new THREE.MeshStandardMaterial({ map: map || null, vertexColors: !map, roughness: 0.95, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.detailMap = { value: detail };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nuniform sampler2D detailMap;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        float camD = length(vWPos - cameraPosition);
        float d1 = texture2D(detailMap, vWPos.xz * 0.07).r;
        float d2 = texture2D(detailMap, vWPos.xz * 0.009).r;
        float det = mix(d1 * 0.55 + d2 * 0.45, d2, smoothstep(80.0, 600.0, camD));
        diffuseColor.rgb *= mix(1.0, 0.6 + det * 0.8, 0.8);`);
  };
  return addClip(m, false);
}

export class Terrain {
  constructor(scene, track, nearestFn, opts = {}) {
    this.cand = [];
    this.lidar = !!opts.lidar;
    this.onRoad = opts.onRoad || (() => {});
    this.visLidar = new Uint8Array(track.n); // 1 = road height already taken from LiDAR
    this.visShifted = false;
    this.nearSrc = this.lidar ? 'lidar' : 'elev';
    this.nearZ = this.lidar ? 15 : NEAR.elevZ;
    this.nearSeg = this.lidar ? 340 : NEAR.seg;
    this.scene = scene;
    this.track = track;
    this.nearest = nearestFn;
    const o = track.r.origin;
    this.lat0 = o.lat; this.lon0 = o.lon;
    this.kx = toRad(1) * R * Math.cos(toRad(o.lat));
    this.ky = toRad(1) * R;
    this.base = track.baseEle;
    this.elevCache = new Map();
    this.satCache = new Map();
    this.detail = detailTexture();
    this.near = null; this.far = null;
    this.nearCenter = null; this.farCenter = null;
    this.building = false;
    this.online = true; // set false after repeated tile failures
    this.fails = 0;
    this.sampler = null; // last near-patch height sampler
    // Per route point: DEM height minus GPX height (GPS/barometric elevation rarely matches the map).
    this.offset = new Float32Array(track.n).fill(NaN);
    this.farOffset = 0;
  }

  /** Measure DEM - GPX along the route inside an area and smooth it (~1.5 km window). */
  _updateOffsets(sampler, cx, cz, size) {
    const r = this.track.r, n = this.track.n, h = size / 2;
    const raw = new Float32Array(n).fill(NaN);
    let any = false;
    for (let i = 0; i < n; i += 2) {
      const x = r.x[i], z = -r.y[i];
      if (Math.abs(x - cx) > h || Math.abs(z - cz) > h) continue;
      const dem = sampler(x, z);
      if (Number.isFinite(dem)) { raw[i] = dem - (r.ele[i] - this.base); any = true; }
    }
    if (!any) return;
    // LiDAR is accurate, so follow it closely; with 30 m data only correct the overall level
    const W = Math.max(2, Math.round((this.lidar && this.nearSampler === sampler ? 200 : 750) / this.track.step));
    // prefix sums over finite values
    const sum = new Float64Array(n + 1), cnt = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const ok = Number.isFinite(raw[i]);
      sum[i + 1] = sum[i] + (ok ? raw[i] : 0);
      cnt[i + 1] = cnt[i] + (ok ? 1 : 0);
    }
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - W), b = Math.min(n, i + W + 1);
      const c = cnt[b] - cnt[a];
      if (c >= 3) this.offset[i] = (sum[b] - sum[a]) / c;
    }
    // fill the rest of the route with the nearest known value
    let last = NaN;
    const fill = (i) => { if (Number.isFinite(this.offset[i])) last = this.offset[i]; else if (Number.isFinite(last)) this.offset[i] = last; };
    for (let i = 0; i < n; i++) fill(i);
    last = NaN;
    for (let i = n - 1; i >= 0; i--) fill(i);
  }
  /**
   * Put the visual road on the LiDAR surface: both passes over the same place (start = finish,
   * out-and-back) get the same height, and the terrain fits the road everywhere.
   */
  _roadFromDem(sampler, cx, cz) {
    const r = this.track.r, n = this.track.n, vis = Float32Array.from(this.track.vis), h = NEAR.size / 2 - 120;
    const raw = new Float32Array(n).fill(NaN);
    let i0 = n, i1 = -1;
    for (let i = 0; i < n; i++) {
      const x = r.x[i], z = -r.y[i];
      if (Math.abs(x - cx) > h || Math.abs(z - cz) > h) continue;
      const v = sampler(x, z);
      if (Number.isFinite(v)) { raw[i] = v; if (i < i0) i0 = i; if (i > i1) i1 = i; }
    }
    if (i1 < 0) return null;
    // median (±3 pts) then gaussian (±~25 m): hedges, walls and pixel noise don't make the road bumpy
    const med = new Float32Array(n).fill(NaN);
    for (let i = i0; i <= i1; i++) {
      if (!Number.isFinite(raw[i])) continue;
      const w = [];
      for (let k = i - 3; k <= i + 3; k++) if (k >= 0 && k < n && Number.isFinite(raw[k])) w.push(raw[k]);
      w.sort((a, b) => a - b);
      med[i] = w[w.length >> 1];
    }
    const sig = Math.max(1, 12 / this.track.step);
    let firstShift = false;
    // first LiDAR patch: shift the whole road by the measured GPX->LiDAR offset so it stays continuous
    if (!this.visShifted) {
      for (let i = 0; i < n; i++) vis[i] = r.ele[i] - this.base + this._off(i);
      this.visShifted = true;
      firstShift = true;
      i0 = 0; i1 = n - 1;
    }
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(med[i])) continue;
      let s = 0, ws = 0;
      for (let k = Math.round(i - sig * 2); k <= i + sig * 2; k++) {
        if (k < 0 || k >= n || !Number.isFinite(med[k])) continue;
        const wk = Math.exp(-((k - i) ** 2) / (2 * sig * sig));
        s += med[k] * wk; ws += wk;
      }
      vis[i] = s / ws;
      this.visLidar[i] = 1;
    }
    return { vis, i0, i1, firstShift }; // applied together with the new terrain mesh
  }

  _off(idx) { const o = this.offset[idx]; return Number.isFinite(o) ? o : 0; }

  // ---------- coordinates ----------
  latLon(x, z) { return [this.lat0 + -z / this.ky, this.lon0 + x / this.kx]; }
  tileXY(lat, lon, z) {
    const n = 2 ** z;
    const tx = ((lon + 180) / 360) * n;
    const lr = toRad(lat);
    const ty = ((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2) * n;
    return [tx, ty];
  }

  // ---------- tiles ----------
  async _img(url) {
    this.pending = (this.pending || 0) + 1;
    try { return await this._img2(url); } finally { this.pending--; this.loaded = (this.loaded || 0) + 1; }
  }
  async _img2(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return createImageBitmap(await res.blob());
  }
  _elevTile(src, z, x, y) {
    const key = `${src}/${z}/${x}/${y}`;
    if (!this.elevCache.has(key)) {
      this.elevCache.set(key, this._img(`/tiles/${key}`).then((bmp) => {
        const c = document.createElement('canvas'); c.width = c.height = 256;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(bmp, 0, 0);
        const d = g.getImageData(0, 0, 256, 256).data;
        const h = new Float32Array(256 * 256);
        for (let i = 0; i < h.length; i++) h[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
        this.fails = 0;
        return h;
      }).catch(() => { if (++this.fails > 6) this.online = false; return null; }));
    }
    return this.elevCache.get(key);
  }
  /** Height of objects above the ground (LiDAR DSM - DTM), Terrarium encoded. Missing = null, never marks us offline. */
  _objTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    this.objCache = this.objCache || new Map();
    if (!this.objCache.has(key)) {
      if (this.objCache.size > 600) this.objCache.delete(this.objCache.keys().next().value);
      this.objCache.set(key, this._img(`/tiles/ndsm/${key}`).then((bmp) => {
        const c = document.createElement('canvas'); c.width = c.height = 256;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(bmp, 0, 0);
        const d = g.getImageData(0, 0, 256, 256).data;
        const h = new Float32Array(256 * 256);
        for (let i = 0; i < h.length; i++) h[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
        return h;
      }).catch(() => null));
    }
    return this.objCache.get(key);
  }
  /** Sampler over the given tiles (keys "x,y") at zoom z. */
  async _objSampler(z, keys) {
    const tiles = new Map();
    await Promise.all([...keys].map((k) => { const [tx, ty] = k.split(',').map(Number); return this._objTile(z, tx, ty).then((d) => tiles.set(k, d)); }));
    if ([...tiles.values()].every((t) => !t)) return null;
    const px = (gx, gy) => {
      const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256);
      const t = tiles.get(tx + ',' + ty);
      if (!t) return NaN;
      return t[(gy - ty * 256) * 256 + (gx - tx * 256)];
    };
    const bil = (gx, gy) => {
      const ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
      const a = px(ix, iy), b = px(ix + 1, iy), c = px(ix, iy + 1), d = px(ix + 1, iy + 1);
      return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
    };
    const f = (x, zz) => {
      const [lat, lon] = this.latLon(x, zz);
      const [tx, ty] = this.tileXY(lat, lon, z);
      return bil(tx * 256 - 0.5, ty * 256 - 0.5);
    };
    // fast regular grid: tile x is linear in our x, tile y depends on the row only
    f.grid = (x0, z0, step, nx, ny) => {
      const out = new Float32Array(nx * ny);
      const [, gx0] = (() => { const [la, lo] = this.latLon(x0, z0); return [0, this.tileXY(la, lo, z)[0] * 256 - 0.5]; })();
      const [la1, lo1] = this.latLon(x0 + step, z0);
      const dgx = (this.tileXY(la1, lo1, z)[0] * 256 - 0.5) - gx0;
      for (let j = 0; j < ny; j++) {
        const [la, lo] = this.latLon(x0, z0 + j * step);
        const gy = this.tileXY(la, lo, z)[1] * 256 - 0.5;
        for (let i = 0; i < nx; i++) out[j * nx + i] = bil(gx0 + i * dgx, gy);
      }
      return out;
    };
    return f;
  }
  _tileKeysForArea(cx, cz, size, z) {
    const r = this._tileRange(cx, cz, size, z), keys = new Set();
    for (let ty = r.y0; ty <= r.y1; ty++) for (let tx = r.x0; tx <= r.x1; tx++) keys.add(tx + ',' + ty);
    return keys;
  }
  _tileKeysForRoad(cx, cz, size, z) {
    const r = this.track.r, h = size / 2, keys = new Set();
    for (let i = 0; i < this.track.n; i++) {
      const x = r.x[i], zz = -r.y[i];
      if (Math.abs(x - cx) > h || Math.abs(zz - cz) > h) continue;
      for (const [dx, dz] of [[0, 0], [10, 0], [-10, 0], [0, 10], [0, -10]]) {
        const [lat, lon] = this.latLon(x + dx, zz + dz);
        const [tx, ty] = this.tileXY(lat, lon, z);
        keys.add(Math.floor(tx) + ',' + Math.floor(ty));
      }
    }
    return keys;
  }

  /** OSM building footprints along the route, in world metres: [{pts:[[x,z]..], c:[x,z], levels, h, kind, roof}] */
  _buildingList() {
    if (!this._buildingsP) {
      this._buildingsP = fetch(`/api/routes/${encodeURIComponent(this.track.r.id)}/buildings`)
        .then((r) => (r.ok ? r.json() : []))
        .then((list) => list.map((b) => {
          const pts = b.pts.map(([lat, lon]) => [(lon - this.lon0) * this.kx, -(lat - this.lat0) * this.ky]);
          let cx = 0, cz = 0; for (const [x, z] of pts) { cx += x; cz += z; }
          return { ...b, pts, c: [cx / pts.length, cz / pts.length] };
        }))
        .catch(() => []);
    }
    return this._buildingsP;
  }

  /** Trees, hedges and walls from LiDAR, added to a near patch once their data arrives. */
  async _addObjects(group, cx, cz, heightFn, sat) {
    try { await this._addObjectsInner(group, cx, cz, heightFn, sat); } finally { if (this.near === group) this.objectsFor = group; }
  }
  async _addObjectsInner(group, cx, cz, heightFn, sat) {
    const size = NEAR.size - 100;
    this.objStage = 'trees';
    const objT = await this._objSampler(15, this._tileKeysForArea(cx, cz, size, 15));
    if (this.near !== group) return;
    if (!objT) { // no LiDAR surface model here (outside Wales): trees guessed from the imagery
      group.add(await this._trees(cx, cz, size, heightFn, sat));
      return;
    }
    const data = sat ? sat.ctx.getImageData(0, 0, sat.W, sat.H).data : null;
    const satRGB = (x, z) => {
      if (!data) return null;
      const [u, v] = sat.uv(x, z);
      const px = Math.floor(u * sat.W), py = Math.floor((1 - v) * sat.H);
      if (px < 0 || py < 0 || px >= sat.W || py >= sat.H) return null;
      const i = (py * sat.W + px) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    };
    // buildings (OpenStreetMap footprints + LiDAR height) first, so no tree grows out of a roof
    this.objStage = 'buildings';
    const h2 = size / 2;
    const all = await this._buildingList();
    const mine = all.filter((b) => { const [x, z] = b.c; return Math.abs(x - cx) < h2 && Math.abs(z - cz) < h2; });
    const inHouse = mine.length ? footprintIndex(mine.map((b) => b.pts)) : null;
    if (this.near !== group) return;
    if (mine.length) { const bg = buildingMeshes(mine, heightFn, objT); group.add(bg); this.buildingCount = bg.userData.count; }
    this.objStage = 'trees';
    const trees = await findTrees(objT, cx, cz, size, {
      nearRoad: (x, z) => this.nearest(x, z, true)[0],
      isRoof: (x, z) => (inHouse && inHouse(x, z)) || (() => { const c = satRGB(x, z); return !!c && c[0] > c[1] + 8 && c[0] + c[1] + c[2] > 200; })(),
    });
    for (const t of trees) { // darker, bluer canopy in the imagery = conifer plantation
      const c = satRGB(t.x, t.z);
      if (c) t.conifer = (c[0] + c[1] + c[2]) / 3 < 55 && c[2] >= c[0] * 0.85;
    }
    if (this.near !== group) return;
    group.add(treeMeshes(trees, heightFn));
    this.treeCount = trees.length;

    this.objStage = 'hedges';
    const objF = await this._objSampler(17, this._tileKeysForRoad(cx, cz, size, 17));
    if (this.near !== group || !objF) return;
    const h = size / 2;
    const b = await buildBoundaries(this.track, objF, heightFn, (x, z) => Math.abs(x - cx) < h && Math.abs(z - cz) < h, (x, z) => this.nearest(x, z, true)[0]);
    if (this.near !== group || !b) return;
    group.add(b);
    this.boundaryCount = b.userData.count;
  }

  _satTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (!this.satCache.has(key)) this.satCache.set(key, this._img(`/tiles/sat/${key}`).catch(() => null));
    return this.satCache.get(key);
  }
  _tileRange(cx, cz, size, z) {
    const h = size / 2;
    const [la1, lo1] = this.latLon(cx - h, cz + h); // SW
    const [la2, lo2] = this.latLon(cx + h, cz - h); // NE
    const [x1, y1] = this.tileXY(la1, lo1, z), [x2, y2] = this.tileXY(la2, lo2, z);
    return { x0: Math.floor(x1), x1: Math.floor(x2), y0: Math.floor(y2), y1: Math.floor(y1) };
  }

  /** Load elevation for an area; returns sampler(x, z) -> world height or NaN. */
  async _elevSampler(cx, cz, size, z, src = 'elev') {
    const r = this._tileRange(cx, cz, size + 200, z);
    const tiles = new Map();
    const jobs = [];
    for (let ty = r.y0; ty <= r.y1; ty++) for (let tx = r.x0; tx <= r.x1; tx++) {
      jobs.push(this._elevTile(src, z, tx, ty).then((d) => tiles.set(tx * 100000 + ty, d)));
    }
    await Promise.all(jobs);
    if ([...tiles.values()].every((t) => !t)) return null;
    const px = (gx, gy) => {
      const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256);
      const t = tiles.get(tx * 100000 + ty);
      if (!t) return NaN;
      return t[(gy - ty * 256) * 256 + (gx - tx * 256)];
    };
    return (x, zz) => {
      const [lat, lon] = this.latLon(x, zz);
      const [tx, ty] = this.tileXY(lat, lon, z);
      const gx = tx * 256 - 0.5, gy = ty * 256 - 0.5;
      const ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
      const a = px(ix, iy), b = px(ix + 1, iy), c = px(ix, iy + 1), d = px(ix + 1, iy + 1);
      const h = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
      return h - this.base;
    };
  }

  /** Stitch satellite tiles into a canvas; returns { canvas, uv(x,z) } or null. */
  async _satCanvas(cx, cz, size, z) {
    const r = this._tileRange(cx, cz, size, z);
    const W = (r.x1 - r.x0 + 1) * 256, H = (r.y1 - r.y0 + 1) * 256;
    if (W > 4096 || H > 4096) return null;
    const imgs = [];
    for (let ty = r.y0; ty <= r.y1; ty++) for (let tx = r.x0; tx <= r.x1; tx++) imgs.push(this._satTile(z, tx, ty).then((im) => [tx, ty, im]));
    const loaded = await Promise.all(imgs);
    if (loaded.every(([, , im]) => !im)) return null;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#5d7a43'; g.fillRect(0, 0, W, H);
    for (const [tx, ty, im] of loaded) if (im) g.drawImage(im, (tx - r.x0) * 256, (ty - r.y0) * 256);
    const uv = (x, zz) => {
      const [lat, lon] = this.latLon(x, zz);
      const [tx, ty] = this.tileXY(lat, lon, z);
      return [((tx - r.x0) * 256) / W, 1 - ((ty - r.y0) * 256) / H];
    };
    return { canvas: c, ctx: g, uv, W, H };
  }

  // ---------- height used for the near patch ----------
  _blend(x, z, dem, vis = this.track.vis) {
    let [d, e, idx] = this.nearest(x, z, true);
    if (idx >= 0) e = vis[idx];
    if (idx < 0) {
      // far from the road: only the elevation offset matters -> nearest of a few candidate points
      let best = Infinity;
      const r = this.track.r;
      for (const i of this.cand) { const dd = (r.x[i] - x) ** 2 + (-r.y[i] - z) ** 2; if (dd < best) { best = dd; idx = i; } }
      if (idx < 0) [d, e, idx] = this.nearest(x, z);
      else if (Number.isFinite(dem)) return this.lidar ? dem : dem - this._off(idx);
      else return this.sampler ? vis[idx] : this._blend2(x, z, 1e9, vis[idx]);
    }
    if (!Number.isFinite(dem)) return this.sampler ? e - 0.4 : this._blend2(x, z, d, e);
    const road = e - 0.4;
    if (!this.lidar) dem -= this._off(idx); // with LiDAR the road itself follows the terrain
    // flat shoulder wider than half the road + one grid cell, so steep slopes never cover the road edge
    return road + (dem - road) * smooth(17, 75, d);
  }
  _blend2(x, z, d, e) { // procedural hills when no elevation data
    const k = smooth(16, 120, d);
    return e - 0.35 + k * (fbm(x, z) * Math.min(45, 6 + Math.min(d, 400) * 0.12) + Math.min(d, 400) * 0.04);
  }
  _setCandidates(cx, cz, size) {
    const r = this.track.r, h = size / 2 + 1500;
    this.cand = [];
    for (let i = 0; i < this.track.n; i += 6) if (Math.abs(r.x[i] - cx) < h && Math.abs(-r.y[i] - cz) < h) this.cand.push(i);
    if (!this.cand.length) for (let i = 0; i < this.track.n; i += 40) this.cand.push(i);
  }

  heightAt(x, z) {
    return this.sampler ? this._blend(x, z, this.sampler(x, z)) : this._blend(x, z, NaN);
  }

  // ---------- builders ----------
  async _grid(cx, cz, size, seg, heightFn, satInfo, colorFn, sync = false) {
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const p = geo.attributes.position, uv = geo.attributes.uv;
    const colors = satInfo ? null : new Float32Array(p.count * 3);
    let t0 = performance.now();
    for (let i = 0; i < p.count; i++) {
      if (!sync && (i & 255) === 0 && performance.now() - t0 > 8) { await new Promise((r) => setTimeout(r, 0)); t0 = performance.now(); }
      const x = p.getX(i) + cx, z = p.getZ(i) + cz;
      p.setXYZ(i, x, heightFn(x, z), z);
      if (satInfo) { const [u, v] = satInfo.uv(x, z); uv.setXY(i, u, v); }
    }
    geo.computeVertexNormals();
    if (colors) {
      const n = geo.attributes.normal;
      for (let i = 0; i < p.count; i++) {
        const c = colorFn(p.getY(i) + this.base, n.getY(i));
        colors.set(c, i * 3);
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
    return geo;
  }

  _fallbackColor(ele, ny) {
    const steep = 1 - ny;
    const g = [0.33, 0.45, 0.2], moor = [0.45, 0.42, 0.28], rock = [0.42, 0.41, 0.39];
    const k1 = smooth(250, 600, ele), k2 = smooth(0.25, 0.5, steep);
    const c = g.map((v, i) => v + (moor[i] - v) * k1);
    return c.map((v, i) => v + (rock[i] - v) * k2);
  }

  async _trees(cx, cz, size, heightFn, sat) {
    const N = 7000;
    const trunkGeo = new THREE.CylinderGeometry(0.18, 0.28, 3, 5); trunkGeo.translate(0, 1.5, 0);
    const conGeo = new THREE.ConeGeometry(2.3, 8, 7); conGeo.translate(0, 6.5, 0);
    const decGeo = new THREE.IcosahedronGeometry(3, 1); decGeo.translate(0, 5.5, 0);
    const trunks = new THREE.InstancedMesh(trunkGeo, addClip(new THREE.MeshStandardMaterial({ color: 0x4a3322, roughness: 1 }), false), N);
    const conifers = new THREE.InstancedMesh(conGeo, addClip(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 }), false), N);
    const decid = new THREE.InstancedMesh(decGeo, addClip(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true }), false), N);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3(), col = new THREE.Color();
    const up = new THREE.Vector3(0, 1, 0);
    let nt = 0, nc = 0, nd = 0;
    let seed = Math.floor(cx * 13 + cz * 7) | 0;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) | 0; return ((seed >>> 0) % 100000) / 100000; };
    const data = sat ? sat.ctx.getImageData(0, 0, sat.W, sat.H).data : null;
    const step = 9;
    let tStart = performance.now();
    for (let gz = -size / 2; gz < size / 2 && nt < N; gz += step) {
      if (performance.now() - tStart > 8) { await new Promise((r) => setTimeout(r, 0)); tStart = performance.now(); }
      for (let gx = -size / 2; gx < size / 2 && nt < N; gx += step) {
        const x = cx + gx + (rnd() - 0.5) * step, z = cz + gz + (rnd() - 0.5) * step;
        let forest;
        if (data) {
          const [u, vv] = sat.uv(x, z);
          const px = Math.floor(u * sat.W), py = Math.floor((1 - vv) * sat.H);
          if (px < 0 || py < 0 || px >= sat.W || py >= sat.H) continue;
          const i = (py * sat.W + px) * 4;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          const lum = (r + g + b) / 3;
          forest = g >= r && g > b * 1.05 && lum < 75 && lum > 18; // dark green = woodland
          if (!forest && g > r && lum < 110 && rnd() < 0.015) forest = true; // scattered trees in fields
          if (forest && rnd() < 0.35) forest = false;
        } else {
          forest = fbm(x * 2.3, z * 2.3) > 0.05 && rnd() < 0.25;
        }
        if (!forest) continue;
        const [d] = this.nearest(x, z, true);
        if (d < 12) continue;
        const h = heightFn(x, z);
        if (!Number.isFinite(h)) continue;
        const sc = 0.7 + rnd() * 0.8;
        m.compose(v.set(x, h - 0.3, z), q.setFromAxisAngle(up, rnd() * 6.28), s.set(sc, sc * (0.85 + rnd() * 0.4), sc));
        trunks.setMatrixAt(nt++, m);
        if (rnd() < 0.55) {
          conifers.setMatrixAt(nc, m);
          conifers.setColorAt(nc++, col.setHSL(0.3 + rnd() * 0.06, 0.4, 0.17 + rnd() * 0.07));
        } else {
          decid.setMatrixAt(nd, m);
          decid.setColorAt(nd++, col.setHSL(0.22 + rnd() * 0.08, 0.45, 0.22 + rnd() * 0.1));
        }
      }
    }
    trunks.count = nt; conifers.count = nc; decid.count = nd;
    conifers.castShadow = decid.castShadow = true;
    const g = new THREE.Group();
    g.add(trunks, conifers, decid);
    return g;
  }

  _swap(slot, obj) {
    const old = this[slot];
    if (old) {
      this.scene.remove(old);
      old.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) { if (o.material.map && !o.userData.keepMap) o.material.map.dispose(); o.material.dispose(); }
      });
    }
    this[slot] = obj;
    if (obj) this.scene.add(obj);
  }

  async _buildNear(cx, cz) {
    const sampler = this.online ? await this._elevSampler(cx, cz, NEAR.size, this.nearZ, this.nearSrc) : null;
    this.nearSampler = sampler;
    if (sampler) this._updateOffsets(sampler, cx, cz, NEAR.size);
    const road = sampler && this.lidar ? this._roadFromDem(sampler, cx, cz) : null;
    const vis = road ? road.vis : this.track.vis;
    const sat = this.online && sampler ? await this._satCanvas(cx, cz, NEAR.size, NEAR.satZ) : null;
    this._setCandidates(cx, cz, NEAR.size);
    const heightFn = (x, z) => this._blend(x, z, sampler ? sampler(x, z) : NaN, vis);
    const geo = await this._grid(cx, cz, NEAR.size, this.nearSeg, heightFn, sat, (e, ny) => this._fallbackColor(e, ny));
    let tex = null;
    if (sat) {
      tex = new THREE.CanvasTexture(sat.canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
    }
    const mesh = new THREE.Mesh(geo, terrainMaterial(tex, this.detail));
    mesh.receiveShadow = true;
    const group = new THREE.Group();
    group.add(mesh);
    if (!(this.lidar && this.online)) group.add(await this._trees(cx, cz, NEAR.size - 100, heightFn, sat));
    if (this.pos && !this._covers({ x: cx, z: cz }, this.pos.x, this.pos.z, 50)) {
      group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map && !o.userData.keepMap) o.material.map.dispose(); o.material.dispose(); } });
      this.nearCenter = null; // rider teleported meanwhile - build again at the new place
      if (road && road.firstShift) this.visShifted = false;
      return false;
    }
    this.sampler = sampler;
    this.nearCenter = { x: cx, z: cz };
    this.shownCenter = { x: cx, z: cz };
    if (road) { this.track.vis.set(road.vis); this.onRoad(road.i0, road.i1); } // road, riders and terrain change in the same frame
    this._swap('near', group);
    if (this.far) this._lowerFar();
    if (this.lidar && this.online) this._addObjects(group, cx, cz, heightFn, sat).catch((e) => console.warn('LiDAR objects failed', e));
    else this.objectsFor = group;
    return !!sampler;
  }

  async _buildFar(cx, cz) {
    const sampler = await this._elevSampler(cx, cz, FAR.size, FAR.elevZ);
    if (!sampler) return;
    if (!this.offset.some(Number.isFinite)) this._updateOffsets(sampler, cx, cz, FAR.size);
    { // one offset for the whole far ring: median along the route near the rider
      const vals = [];
      for (let i = 0; i < this.track.n; i += 10) {
        const x = this.track.r.x[i], z = -this.track.r.y[i];
        if (Math.abs(x - cx) < 6000 && Math.abs(z - cz) < 6000 && Number.isFinite(this.offset[i])) vals.push(this.offset[i]);
      }
      vals.sort((a, b) => a - b);
      this.farOffset = this.lidar ? 0 : (vals.length ? vals[vals.length >> 1] : 0);
    }
    const sat = await this._satCanvas(cx, cz, FAR.size, FAR.satZ);
    const geo = await this._grid(cx, cz, FAR.size, FAR.seg, (x, z) => {
      let h = sampler(x, z);
      h = Number.isFinite(h) ? h - this.farOffset : -50;
      // carve the valley the road runs in: the coarse grid must never rise above the road
      const [d, e] = this.nearest(x, z, true);
      if (Number.isFinite(d)) h = Math.min(h, e - 4 + d * 0.35);
      return h;
    }, sat, (e, ny) => this._fallbackColor(e, ny));
    geo.userData.baseY = Float32Array.from(geo.attributes.position.array.filter((_, i) => i % 3 === 1));
    let tex = null;
    if (sat) { tex = new THREE.CanvasTexture(sat.canvas); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; }
    const mesh = new THREE.Mesh(geo, terrainMaterial(tex, this.detail));
    mesh.receiveShadow = false;
    this.farCenter = { x: cx, z: cz };
    this._swap('far', mesh);
    this._lowerFar();
  }

  /** Sink the far mesh under the near patch so they don't intersect. */
  _lowerFar() {
    if (!this.far || !this.nearCenter) return;
    const geo = this.far.geometry, p = geo.attributes.position, base = geo.userData.baseY;
    const h = NEAR.size / 2;
    for (let i = 0; i < p.count; i++) {
      const dx = Math.abs(p.getX(i) - this.nearCenter.x), dz = Math.abs(p.getZ(i) - this.nearCenter.z);
      const inside = 1 - smooth(h - 250, h, Math.max(dx, dz));
      p.setY(i, base[i] - 3 - inside * 60);
    }
    p.needsUpdate = true;
    geo.computeVertexNormals();
  }

  /** Loading progress at a place: { ground, objects, pending, loaded } */
  status(x, z) {
    const ground = !!this.near && (this._covers(this.nearCenter, x, z, 250) || (!this.online && this._covers(this.shownCenter, x, z, 50)));
    return { ground, objects: ground && this.objectsFor === this.near, stage: this.objStage, pending: this.pending || 0, loaded: this.loaded || 0, online: this.online };
  }
  _covers(c, x, z, margin) {
    return c && Math.abs(x - c.x) < NEAR.size / 2 - margin && Math.abs(z - c.z) < NEAR.size / 2 - margin;
  }

  /** Call every frame with the rider position. */
  update(x, z) {
    this.pos = { x, z };
    if (this.near) this.near.visible = !this.hidden;
    if (this.hidden) { if (this.far) this.far.visible = false; return; } // Google 3D Tiles mode
    // After a teleport there may be no ground under the rider yet: put a quick procedural patch down.
    if (!this._covers(this.shownCenter, x, z, 50)) this.bootstrap(x, z);
    if (this.far) this.far.visible = this._covers(this.nearCenter, x, z, 300);
    if (this.near) this.near.visible = true;

    const ncx = Math.round(x / NEAR.snap) * NEAR.snap, ncz = Math.round(z / NEAR.snap) * NEAR.snap;
    if (!this.nearBusy && (!this.nearCenter || this.nearCenter.x !== ncx || this.nearCenter.z !== ncz)) {
      this.nearBusy = true;
      this._buildNear(ncx, ncz).catch((e) => console.warn('Terrain near build failed', e)).finally(() => { this.nearBusy = false; });
    }
    const fcx = Math.round(x / FAR.snap) * FAR.snap, fcz = Math.round(z / FAR.snap) * FAR.snap;
    if (this.online && !this.farBusy && (!this.farCenter || this.farCenter.x !== fcx || this.farCenter.z !== fcz)) {
      this.farBusy = true;
      this._buildFar(fcx, fcz).catch((e) => console.warn('Terrain far build failed', e)).finally(() => { this.farBusy = false; });
    }
  }

  /** Build the first near patch synchronously with procedural heights, so there is ground immediately. */
  bootstrap(x, z) {
    const cx = Math.round(x / NEAR.snap) * NEAR.snap, cz = Math.round(z / NEAR.snap) * NEAR.snap;
    this._setCandidates(cx, cz, NEAR.size);
    const heightFn = (xx, zz) => this._blend(xx, zz, NaN);
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), terrainMaterial(null, this.detail));
    this._grid(cx, cz, NEAR.size, 120, heightFn, null, (e, ny) => this._fallbackColor(e, ny), true).then((geo) => { mesh.geometry.dispose(); mesh.geometry = geo; });
    mesh.receiveShadow = true;
    const g = new THREE.Group(); g.add(mesh);
    this._swap('near', g);
    this.shownCenter = { x: cx, z: cz };
    this.nearCenter = null; // force the real build
    if (this.far) this.far.visible = false;
  }
}
