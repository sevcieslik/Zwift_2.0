import * as THREE from 'three';
import { KITS } from './kits.js';
import { RiderModel } from './rider.js';
import { Terrain } from './terrain.js';
import { CameraRig } from './camera.js';
import { WarpFX } from './warp.js';
import { CLIP } from './clip.js';
import { WIND } from './objects.js';
import { Atmosphere } from './atmosphere.js';

// ---------- Route helpers ----------
export class Track {
  constructor(route) {
    this.r = route;
    this.n = route.x.length;
    this.total = route.total;
    this.step = route.step;
    this.loop = route.loop;
    this.baseEle = route.minEle - 5;
    // Visual road height (world Y). Starts from GPX elevation; replaced by LiDAR heights when available.
    this.vis = Float32Array.from(route.ele, (e) => e - this.baseEle);
    // half width of the carriageway per point (from the OSM road class when the route is snapped)
    this.hw = Float32Array.from(route.hw || route.x, (v) => (route.hw ? v : 2.9));
  }
  halfWidthAt(d) { const [i, t] = this._idx(d); return this.hw[i] + t * (this.hw[i + 1] - this.hw[i]); }
  _idx(d) {
    d = Math.max(0, Math.min(this.total, d));
    let i = Math.min(this.n - 2, Math.floor(d / this.step));
    const dist = this.r.dist;
    while (i < this.n - 2 && dist[i + 1] < d) i++;
    while (i > 0 && dist[i] > d) i--;
    const seg = dist[i + 1] - dist[i] || 1;
    return [i, Math.max(0, Math.min(1, (d - dist[i]) / seg))];
  }
  /** World position at distance d (m). X=east, Z=-north, Y=up. */
  sample(d) {
    const [i, t] = this._idx(d);
    const r = this.r;
    const lerp = (a) => a[i] + t * (a[i + 1] - a[i]);
    const x = lerp(r.x), z = -lerp(r.y), y = lerp(this.vis);
    // heading from a window around the point (smoother than a single segment)
    const a = Math.max(0, i - 2), b = Math.min(this.n - 1, i + 3);
    let dx = r.x[b] - r.x[a], dz = -(r.y[b] - r.y[a]);
    const len = Math.hypot(dx, dz) || 1;
    return { x, y, z, dx: dx / len, dz: dz / len, grade: lerp(r.grade), ele: lerp(r.ele) };
  }
  gradeAt(d) { const [i, t] = this._idx(d); return this.r.grade[i] + t * (this.r.grade[i + 1] - this.r.grade[i]); }
}

// ---------- Textures ----------
function roadTexture() {
  // across = u (0 left edge .. 1 right edge), along = v (12 m per repeat)
  const c = document.createElement('canvas');
  c.width = 256; c.height = 1024;
  const g = c.getContext('2d');
  g.fillStyle = '#404246'; g.fillRect(0, 0, 256, 1024);
  // worn wheel tracks are smoother/darker, the middle and edges lighter and dustier
  const grad = g.createLinearGradient(0, 0, 256, 0);
  for (const [t, a] of [[0, 0.1], [0.08, 0.06], [0.25, -0.05], [0.38, 0.02], [0.5, 0.06], [0.62, 0.02], [0.75, -0.05], [0.92, 0.06], [1, 0.1]]) grad.addColorStop(t, a > 0 ? `rgba(160,155,145,${a})` : `rgba(0,0,0,${-a})`);
  g.fillStyle = grad; g.fillRect(0, 0, 256, 1024);
  for (let i = 0; i < 26000; i++) { // aggregate
    const v = 35 + Math.random() * 60;
    g.fillStyle = `rgba(${v},${v},${v + 4},${0.35 + Math.random() * 0.5})`;
    const r = Math.random() < 0.9 ? 1 : 2;
    g.fillRect(Math.random() * 256, Math.random() * 1024, r, r);
  }
  for (let i = 0; i < 3; i++) { // a couple of old repairs: straight-edged, only slightly darker
    g.fillStyle = `rgba(25,25,28,${0.08 + Math.random() * 0.08})`;
    const x = 20 + Math.random() * 180, y = Math.random() * 900, w = 25 + Math.random() * 60, h = 40 + Math.random() * 100;
    g.fillRect(x, y, w, h);
  }
  g.strokeStyle = 'rgba(15,15,15,0.5)'; g.lineWidth = 1.2; // cracks
  for (let i = 0; i < 14; i++) { let x = Math.random() * 256, y = Math.random() * 1024; g.beginPath(); g.moveTo(x, y); for (let k = 0; k < 6; k++) { x += (Math.random() - 0.5) * 18; y += Math.random() * 14; g.lineTo(x, y); } g.stroke(); }
  // white edge lines (slightly worn) and dashed centre line
  const worn = (x, y, w, h) => { g.fillStyle = '#e6e6e2'; g.fillRect(x, y, w, h); g.fillStyle = 'rgba(64,66,70,0.35)'; for (let k = 0; k < h / 3; k++) g.fillRect(x + Math.random() * w, y + Math.random() * h, 2, 2); };
  worn(10, 0, 6, 1024); worn(240, 0, 6, 1024);
  worn(125, 0, 6, 440);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 16; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function roadBumpTexture() {
  const c = document.createElement('canvas'); c.width = 128; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#808080'; g.fillRect(0, 0, 128, 512);
  for (let i = 0; i < 9000; i++) { const v = 90 + Math.random() * 120; g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(Math.random() * 128, Math.random() * 512, 1, 1); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.RepeatWrapping;
  return t;
}
function vergeTexture() {
  // u: 0 = road edge (crumbled tarmac, grit) .. 1 = grass
  const c = document.createElement('canvas'); c.width = 64; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 64, 0);
  grad.addColorStop(0, '#3e3d39'); grad.addColorStop(0.25, '#5a5546'); grad.addColorStop(0.55, '#5d6a3a'); grad.addColorStop(1, '#4f6b2c');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 256);
  for (let i = 0; i < 2600; i++) {
    const x = Math.random() * 64, y = Math.random() * 256, k = x / 64;
    g.fillStyle = k < 0.35 ? `rgba(${70 + Math.random() * 60},${68 + Math.random() * 50},${60 + Math.random() * 40},0.7)` : `hsla(${75 + Math.random() * 35},${35 + Math.random() * 25}%,${18 + Math.random() * 22}%,0.85)`;
    g.fillRect(x, y, k < 0.35 ? 1.5 : 1, k < 0.35 ? 1.5 : 3 + Math.random() * 3);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
// ---------- Rider model ----------
function labelSprite(text, color, avatar) {
  const c = document.createElement('canvas');
  c.width = 384; c.height = 80;
  const g = c.getContext('2d');
  g.font = 'bold 34px system-ui, sans-serif';
  const label = `${avatar || ''} ${text.slice(0, 14)}`.trim();
  const w = Math.min(376, g.measureText(label).width + 48);
  const x0 = (384 - w) / 2;
  g.fillStyle = 'rgba(0,0,0,0.6)';
  g.beginPath(); g.roundRect(x0, 8, w, 60, 14); g.fill();
  g.fillStyle = color; g.fillRect(x0, 62, w, 6);
  g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.textAlign = 'center';
  g.fillText(label, 192, 38);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  s.renderOrder = 10;
  return s;
}

export { RiderModel };

// ---------- World ----------
export class World {
  constructor(canvas, route, opts = {}) {
    this.track = new Track(route);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.25, 60000);
    this.atmo = new Atmosphere(this.scene, { seed: opts.seed || route.id || 'gpx' });
    this.sunDir = this.atmo.sunDir;
    this.sun = this.atmo.sun;

    this._buildIndex();
    this.roadWet = { value: 0 };
    this._buildRoad();
    this.terrain = new Terrain(this.scene, this.track, (x, z, lim) => this.nearest(x, z, lim), { lidar: opts.lidar, onRoad: (a, b) => this.updateRoad(a, b) });
    this.riders = new Map();
    this.camPos = null;
    this.scene.add(this.camera); // camera children (warp streaks) must be in the scene
    this.rig = new CameraRig(this.camera, canvas);
    this.fx = new WarpFX(this.renderer, this.scene, this.camera);
    this._dir = new THREE.Vector3(); this._focus = new THREE.Vector3();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const c = this.renderer.domElement;
    const w = c.clientWidth || window.innerWidth, h = c.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.fx) this.fx.setSize(w, h);
    if (this.google) this.google.resize();
  }

  _buildIndex() {
    const r = this.track.r;
    this.cell = 50;
    this.grid = new Map();
    for (let i = 0; i < r.x.length; i++) {
      const k = `${Math.floor(r.x[i] / this.cell)},${Math.floor(-r.y[i] / this.cell)}`;
      let a = this.grid.get(k);
      if (!a) this.grid.set(k, (a = []));
      a.push(i);
    }
    this.coarse = [];
    for (let i = 0; i < r.x.length; i += 10) this.coarse.push(i);
  }

  /** Nearest route point to world (x,z) -> [distance, elevation (world Y)] */
  nearest(x, z, limited = false) {
    const r = this.track.r;
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    let best = Infinity, bi = -1;
    for (let ring = 0; ring <= 4; ring++) {
      for (let i = -ring; i <= ring; i++) for (let j = -ring; j <= ring; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
        const a = this.grid.get(`${cx + i},${cz + j}`);
        if (!a) continue;
        for (const k of a) {
          const d = (r.x[k] - x) ** 2 + (-r.y[k] - z) ** 2;
          if (d < best) { best = d; bi = k; }
        }
      }
      if (bi >= 0 && Math.sqrt(best) < ring * this.cell) break;
      if (limited && ring >= 2 && bi < 0) return [Infinity, NaN, -1];
    }
    if (bi < 0) {
      for (const k of this.coarse) {
        const d = (r.x[k] - x) ** 2 + (-r.y[k] - z) ** 2;
        if (d < best) { best = d; bi = k; }
      }
    }
    return [Math.sqrt(best), this.track.vis[bi], bi];
  }

  terrainHeight(x, z) { return this.terrain.heightAt(x, z); }

  // later parts of the route sit a hair higher, so overlapping passes (start = finish) don't z-fight
  _roadY(i) { return this.track.vis[i] + 0.05 + 0.03 * (i / this.track.n); }

  /** Refresh road vertex heights after the visual elevation changed. */
  updateRoad(i0, i1) {
    const p = this.roadGeo.attributes.position;
    const vp = this.vergeGeo.attributes.position;
    for (let i = Math.max(0, i0); i <= Math.min(this.track.n - 1, i1); i++) {
      const y = this._roadY(i);
      p.setY(i * 2, y); p.setY(i * 2 + 1, y);
      vp.setY(i * 4, y - 0.18); vp.setY(i * 4 + 1, y - 0.03); vp.setY(i * 4 + 2, y - 0.03); vp.setY(i * 4 + 3, y - 0.18);
    }
    p.needsUpdate = true; vp.needsUpdate = true;
    this.vergeGeo.computeVertexNormals(); this.vergeGeo.computeBoundingSphere();
    this.roadGeo.computeVertexNormals();
    this.roadGeo.computeBoundingSphere();
  }

  _buildRoad() {
    const r = this.track.r, n = r.x.length, hw = this.track.hw, VERGE = 1.1;
    const pos = new Float32Array(n * 2 * 3), uv = new Float32Array(n * 2 * 2), lane = new Float32Array(n * 2);
    const vpos = new Float32Array(n * 4 * 3), vuv = new Float32Array(n * 4 * 2);
    this._roadN = [];
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      let tx = r.x[b] - r.x[a], tz = -(r.y[b] - r.y[a]);
      const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
      const nx = -tz, nz = tx, W = hw[i];
      this._roadN.push([nx, nz]);
      const x = r.x[i], z = -r.y[i], y = this._roadY(i);
      pos.set([x + nx * W, y, z + nz * W, x - nx * W, y, z - nz * W], i * 6);
      const v = r.dist[i] / 12;
      uv.set([0, v, 1, v], i * 4);
      lane[i * 2] = lane[i * 2 + 1] = W >= 2.4 ? 1 : 0; // single-track lanes: no centre line
      // verges: [outer L, inner L, inner R, outer R]
      const vy = y - 0.03, ov = y - 0.18;
      vpos.set([x + nx * (W + VERGE), ov, z + nz * (W + VERGE), x + nx * W, vy, z + nz * W,
        x - nx * W, vy, z - nz * W, x - nx * (W + VERGE), ov, z - nz * (W + VERGE)], i * 12);
      const vv = r.dist[i] / 4;
      vuv.set([1, vv, 0, vv, 0, vv, 1, vv], i * 8);
    }
    const idx = [], vidx = [];
    for (let i = 0; i < n - 1; i++) {
      const p = i * 2;
      idx.push(p, p + 2, p + 1, p + 1, p + 2, p + 3);
      const q = i * 4;
      vidx.push(q, q + 4, q + 1, q + 1, q + 4, q + 5, q + 2, q + 6, q + 3, q + 3, q + 6, q + 7);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('lane', new THREE.BufferAttribute(lane, 1));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    this.roadGeo = geo;
    const mat = new THREE.MeshStandardMaterial({
      map: roadTexture(), bumpMap: roadBumpTexture(), bumpScale: 0.6, roughness: 0.88, metalness: 0, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.wet = this.roadWet;
      sh.uniforms.skyCol = { value: this.atmo.horizon };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float lane;\nvarying float vLane;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvLane = lane;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vLane;\nuniform float wet;\nuniform vec3 skyCol;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          // wet tarmac mirrors the sky at grazing angles
          float fres = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 5.0);
          totalEmissiveRadiance += skyCol * fres * wet * 0.55;`)
        .replace('#include <map_fragment>', `
          vec2 ruv = vMapUv;
          if (vLane < 0.5 && abs(ruv.x - 0.5) < 0.03) ruv.x += 0.17;
          diffuseColor *= texture2D(map, ruv);
          diffuseColor.rgb *= 1.0 - wet * 0.45;`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.22, wet);`);
    };
    this.roadMat = mat;
    const road = new THREE.Mesh(geo, mat);
    road.receiveShadow = true;
    this.scene.add(road);

    const vgeo = new THREE.BufferGeometry();
    vgeo.setAttribute('position', new THREE.BufferAttribute(vpos, 3));
    vgeo.setAttribute('uv', new THREE.BufferAttribute(vuv, 2));
    vgeo.setIndex(vidx);
    vgeo.computeVertexNormals();
    this.vergeGeo = vgeo;
    const verge = new THREE.Mesh(vgeo, new THREE.MeshStandardMaterial({ map: vergeTexture(), roughness: 1, metalness: 0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
    verge.receiveShadow = true;
    this.scene.add(verge);

    // Start / finish banner
    const s = this.track.sample(0.5);
    const arch = new THREE.Group();
    const postM = new THREE.MeshStandardMaterial({ color: 0x222222 });
    for (const side of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.25, 5, 0.25), postM);
      p.position.set(side * 4.6, 2.5, 0); arch.add(p);
    }
    const c = document.createElement('canvas'); c.width = 512; c.height = 64;
    const g = c.getContext('2d');
    for (let i = 0; i < 32; i++) for (let j = 0; j < 4; j++) { g.fillStyle = (i + j) % 2 ? '#fff' : '#111'; g.fillRect(i * 16, j * 16, 16, 16); }
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(9.4, 1.1), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), side: THREE.DoubleSide }));
    banner.position.y = 4.6; arch.add(banner);
    arch.position.set(s.x, s.y, s.z);
    arch.rotation.y = Math.atan2(s.dx, s.dz);
    this.scene.add(arch);
  }

  resetCamera() { this.rig.pos = null; }

  /** 'lidar' (own terrain), 'mix' (own terrain near + Google far) or 'google' (Photorealistic 3D Tiles only). */
  async setTerrainMode(mode, key) {
    this.terrainMode = mode;
    const wantG = mode === 'google' || mode === 'mix';
    if (wantG && key && !this.google) {
      // loaded only when needed: a missing 3D Tiles library must never break the rest of the game
      try {
        const { GoogleTerrain } = await import('./google3d.js');
        if (!this.google) this.google = new GoogleTerrain({ key, scene: this.scene, camera: this.camera, renderer: this.renderer, track: this.track });
      } catch (e) {
        console.warn('Google 3D Tiles library failed to load', e);
        this.googleLoadError = e.message || String(e);
      }
    }
    const g = wantG && !!this.google;
    if (this.google) {
      this.google.visible = g;
      if (!this.google._worldHook) {
        this.google._worldHook = true;
        this.google.addEventListener('ready', () => { if (this.terrainMode === 'google') this.terrain.hidden = true; });
      }
    }
    CLIP.on.value = mode === 'mix' && g ? 1 : 0;
    // keep our own ground until Google tiles have actually arrived
    this.terrain.hidden = mode === 'google' && g && this.google.loaded;
    return this.google;
  }

  _laneOffset(id) {
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
    return ((Math.abs(h) % 5) - 2) * 0.9;
  }

  /**
   * riders: [{ id, name, color, dist, speed, cadence, me }]
   */
  render(dt, riders, opts = {}) {
    WIND.time.value += Math.min(dt, 0.1);
    const seen = new Set();
    let me = null;
    for (const rd of riders) {
      seen.add(rd.id);
      let m = this.riders.get(rd.id);
      const key = rd.name + '|' + rd.height + '|' + JSON.stringify(rd.appearance);
      if (m && m.key !== key) { this.scene.remove(m.group); m.dispose(); m = null; }
      if (!m) {
        const kitColor = rd.appearance.kit && KITS[rd.appearance.kit] ? KITS[rd.appearance.kit].color : rd.appearance.jersey;
        m = new RiderModel(rd.appearance, rd.name, {
          label: !rd.me, heightCm: rd.height,
          labelSprite: rd.me ? null : labelSprite(rd.name, kitColor, rd.appearance.avatar),
        });
        m.key = key;
        this.riders.set(rd.id, m);
        this.scene.add(m.group);
      }
      const s = this.track.sample(rd.dist);
      const hwHere = this.track.halfWidthAt(rd.dist);
      const lane = Math.max(-hwHere + 0.6, Math.min(hwHere - 0.6, rd.me ? Math.min(0.6, hwHere * 0.3) : this._laneOffset(rd.id) * Math.min(1, hwHere / 3)));
      const nx = -s.dz, nz = s.dx; // right-hand normal
      m.group.position.set(s.x + nx * lane, s.y, s.z + nz * lane);
      m.group.rotation.set(0, 0, 0);
      m.group.rotateY(Math.atan2(s.dx, s.dz));
      m.group.rotateX(-Math.atan(s.grade));
      m.animate(dt, rd.speed, rd.cadence, { wkg: rd.wkg || 0, grade: s.grade });
      if (m.label) {
        const d = this.camPos ? this.camPos.distanceTo(m.group.position) : 99;
        m.label.visible = d > 9;
        m.label.position.y = 2.1 + (Math.round(lane / 0.9 + 2) % 2) * 0.7 * Math.max(1, d / 25) / (m.bodyScale || 1);
        const k = Math.max(1, d / 25);
        m.label.scale.set(2.9 * k, 0.6 * k, 1);
      }
      if (rd.me) me = { s, m, dist: rd.dist };
    }
    for (const [id, m] of this.riders) {
      if (!seen.has(id)) { this.scene.remove(m.group); m.dispose(); this.riders.delete(id); }
    }

    if (me) {
      const { s, m } = me;
      const p = m.group.position;
      this.terrain.update(p.x, p.z);
      // Camera heading from a long baseline, low-pass filtered: GPS wiggles must not swing the camera.
      const a = this.track.sample(Math.max(0, me.dist - 15)), b = this.track.sample(Math.min(this.track.total, me.dist + 15));
      let ang = Math.atan2(b.x - a.x, b.z - a.z);
      if (!Number.isFinite(ang) || (b.x === a.x && b.z === a.z)) ang = Math.atan2(s.dx, s.dz);
      if (this.camAng === undefined || this.rig.pos === null) this.camAng = ang;
      let dA = ang - this.camAng;
      dA = Math.atan2(Math.sin(dA), Math.cos(dA));
      this.camAng += dA * (1 - Math.exp(-dt * 2.5));
      const turn = dt > 0 ? (dA * (1 - Math.exp(-dt * 2.5))) / dt : 0; // rad/s
      const dir = this._dir.set(Math.sin(this.camAng), 0, Math.cos(this.camAng));
      m.group.visible = !this.rig.fpv;
      const warp = opts.warp || 0;
      this.rig.update(dt, p, dir, (x, z) => this.terrainHeight(x, z), warp, { speed: opts.speed || 0, turn, rough: this.track.halfWidthAt(me.dist) < 2.2 ? 1 : 0 });
      if (this.google && (this.terrainMode === 'google' || this.terrainMode === 'mix')) {
        CLIP.center.value.set(p.x, p.z);
        this.google.update(p.x, p.z, me.dist);
      }
      this.camPos = this.camera.position;
      const f = this.track.sample(me.dist + 35);
      this.fx.update(dt, warp, this._focus.set(f.x, f.y + 1.0, f.z));
      this.env = this.atmo.update(dt, this.camera.position, p);
      this.roadWet.value = this.env.wet;
      WIND.k.value = 0.4 + this.atmo.state.windSpeed * 0.25;
    }
    this.fx.render();
  }
}
