import * as THREE from 'three';
import { KITS } from './kits.js';
import { RiderModel } from './rider.js';
import { Terrain } from './terrain.js';
import { CameraRig } from './camera.js';
import { WarpFX } from './warp.js';

// ---------- Route helpers ----------
export class Track {
  constructor(route) {
    this.r = route;
    this.n = route.x.length;
    this.total = route.total;
    this.step = route.step;
    this.loop = route.loop;
    this.baseEle = route.minEle - 5;
  }
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
    const x = lerp(r.x), z = -lerp(r.y), y = lerp(r.ele) - this.baseEle;
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
  const c = document.createElement('canvas');
  c.width = 128; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#3a3c40'; g.fillRect(0, 0, 128, 512);
  for (let i = 0; i < 4000; i++) {
    const v = 40 + Math.random() * 40;
    g.fillStyle = `rgb(${v},${v},${v + 3})`;
    g.fillRect(Math.random() * 128, Math.random() * 512, 1.5, 1.5);
  }
  g.fillStyle = '#e8e8e8';
  g.fillRect(6, 0, 4, 512); g.fillRect(118, 0, 4, 512);
  g.fillStyle = '#f0f0f0';
  g.fillRect(62, 0, 4, 220);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8; t.colorSpace = THREE.SRGBColorSpace;
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
    const horizon = new THREE.Color(0xc9dcec);
    this.scene.background = horizon;
    this.scene.fog = new THREE.Fog(horizon, 500, 26000);
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.25, 60000);

    this.sunDir = new THREE.Vector3(0.45, 0.62, 0.35).normalize();
    this.scene.add(this._sky(horizon));
    this.scene.add(new THREE.HemisphereLight(0xd8e8ff, 0x4f5a3a, 1.5));
    this.sun = new THREE.DirectionalLight(0xfff0d8, 3.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0005;
    Object.assign(this.sun.shadow.camera, { left: -35, right: 35, top: 35, bottom: -35, near: 1, far: 300 });
    this.scene.add(this.sun, this.sun.target);

    this._buildIndex();
    this._buildRoad();
    this.terrain = new Terrain(this.scene, this.track, (x, z, lim) => this.nearest(x, z, lim), { lidar: opts.lidar });
    this.riders = new Map();
    this.camPos = null;
    this.scene.add(this.camera); // camera children (warp streaks) must be in the scene
    this.rig = new CameraRig(this.camera, canvas);
    this.fx = new WarpFX(this.renderer, this.scene, this.camera);
    this._dir = new THREE.Vector3(); this._focus = new THREE.Vector3();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  _sky(horizon) {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
      uniforms: { top: { value: new THREE.Color(0x2f6fc0) }, horizon: { value: horizon }, sunDir: { value: this.sunDir } },
      vertexShader: `varying vec3 vDir;
        void main() { vDir = position; vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0); gl_Position = p.xyww; }`,
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float h = max(d.y, 0.0);
          vec3 c = mix(horizon, top, pow(h, 0.45));
          float s = max(dot(d, sunDir), 0.0);
          c += vec3(1.0, 0.95, 0.85) * (pow(s, 600.0) * 3.0 + pow(s, 12.0) * 0.12);
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), mat);
    m.frustumCulled = false;
    m.renderOrder = -1000;
    return m;
  }

  resize() {
    const c = this.renderer.domElement;
    const w = c.clientWidth || window.innerWidth, h = c.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.fx) this.fx.setSize(w, h);
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
    return [Math.sqrt(best), r.ele[bi] - this.track.baseEle, bi];
  }

  terrainHeight(x, z) { return this.terrain.heightAt(x, z); }

  _buildRoad() {
    const r = this.track.r, n = r.x.length, W = 3.6;
    const pos = new Float32Array(n * 2 * 3), uv = new Float32Array(n * 2 * 2);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      let tx = r.x[b] - r.x[a], tz = -(r.y[b] - r.y[a]);
      const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
      const nx = -tz, nz = tx;
      const x = r.x[i], z = -r.y[i], y = r.ele[i] - this.track.baseEle + 0.05;
      pos.set([x + nx * W, y, z + nz * W, x - nx * W, y, z - nz * W], i * 6);
      const v = r.dist[i] / 12;
      uv.set([0, v, 1, v], i * 4);
    }
    const idx = [];
    for (let i = 0; i < n - 1; i++) {
      const p = i * 2;
      idx.push(p, p + 2, p + 1, p + 1, p + 2, p + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      map: roadTexture(), roughness: 0.9, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const road = new THREE.Mesh(geo, mat);
    road.receiveShadow = true;
    this.scene.add(road);

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

  _laneOffset(id) {
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
    return ((Math.abs(h) % 5) - 2) * 0.9;
  }

  /**
   * riders: [{ id, name, color, dist, speed, cadence, me }]
   */
  render(dt, riders, opts = {}) {
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
      const lane = rd.me ? 0.6 : this._laneOffset(rd.id);
      const nx = -s.dz, nz = s.dx; // right-hand normal
      m.group.position.set(s.x + nx * lane, s.y, s.z + nz * lane);
      m.group.rotation.set(0, 0, 0);
      m.group.rotateY(Math.atan2(s.dx, s.dz));
      m.group.rotateX(-Math.atan(s.grade));
      m.animate(dt, rd.speed, rd.cadence);
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
      const dir = this._dir.set(s.dx, 0, s.dz).normalize();
      m.group.visible = !this.rig.fpv;
      const warp = opts.warp || 0;
      this.rig.update(dt, p, dir, (x, z) => this.terrainHeight(x, z), warp);
      this.camPos = this.camera.position;
      const f = this.track.sample(me.dist + 35);
      this.fx.update(dt, warp, this._focus.set(f.x, f.y + 1.0, f.z));
      this.sun.position.copy(p).addScaledVector(this.sunDir, 120);
      this.sun.target.position.copy(p);
    }
    this.fx.render();
  }
}
