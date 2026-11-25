import * as THREE from 'three';
import { kitMaterials } from './kits.js';

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

// ---------- Noise ----------
function hash2(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
}
function fbm(x, y) {
  return vnoise(x / 400, y / 400) * 0.6 + vnoise(x / 150, y / 150) * 0.3 + vnoise(x / 50, y / 50) * 0.1;
}
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

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
function grassTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#5f8a3a'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 9000; i++) {
    const r = 70 + Math.random() * 40, gg = 110 + Math.random() * 50, b = 40 + Math.random() * 25;
    g.fillStyle = `rgb(${r},${gg},${b})`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
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

const mat = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...opts });
function cyl(r1, r2, len, m) { return new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, len, 8), m); }

/** Low-poly cyclist. Forward = +Z. appearance: see profile.js */
export class RiderModel {
  constructor(appearance, name, { label = true, heightCm = 178 } = {}) {
    const a = appearance;
    this.group = new THREE.Group();
    const body = new THREE.Group(); // scaled by height
    this.group.add(body);
    const jersey = mat(a.jersey), shorts = mat(a.shorts), socks = mat(a.socks), skin = mat(a.skin, { roughness: 0.8 });
    const head = mat(a.headColor), frameM = mat(a.frame, { metalness: 0.5, roughness: 0.35 });
    const black = mat(0x1a1a1a, { roughness: 0.5 }), shoe = mat(0xf2f2f2);
    const kit = kitMaterials(a.kit);

    // Bike
    const wheelGeo = new THREE.TorusGeometry(0.34, 0.028, 8, 32);
    const rimGeo = new THREE.TorusGeometry(0.3, 0.012, 6, 32);
    this.wheels = [];
    for (const z of [-0.52, 0.52]) {
      const w = new THREE.Group();
      w.add(new THREE.Mesh(wheelGeo, black));
      w.add(new THREE.Mesh(rimGeo, frameM));
      w.rotation.y = Math.PI / 2; w.position.set(0, 0.34, z);
      this.group.add(w); this.wheels.push(w);
    }
    const tube = (len, x, y, z, rx, m = frameM, r = 0.022) => {
      const t = cyl(r, r, len, m); t.position.set(x, y, z); t.rotation.x = rx; this.group.add(t); return t;
    };
    tube(0.62, 0, 0.66, 0.08, 1.33);      // top tube
    tube(0.68, 0, 0.5, 0.1, 0.85);         // down tube
    tube(0.55, 0, 0.6, -0.2, -0.3);        // seat tube
    tube(0.48, 0, 0.36, -0.3, 1.45);       // chain stay
    tube(0.48, 0, 0.55, 0.48, -0.25);      // fork
    tube(0.36, 0, 0.88, 0.47, Math.PI / 2, black, 0.018); // bars
    const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.04, 0.26), black);
    saddle.position.set(0, 0.89, -0.28); this.group.add(saddle);

    // Rider (scaled by height relative to 178 cm)
    const s = Math.max(0.85, Math.min(1.15, heightCm / 178));
    this.bodyScale = 1;
    body.scale.setScalar(s);
    body.position.y = 0.9 * (1 - s); // keep hips on the saddle
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.22, 0.62), kit ? kit.torso : jersey);
    torso.position.set(0, 1.13, 0.02); torso.rotation.x = -0.45; body.add(torso);
    const hips = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.16, 0.2), kit ? kit.hips : shorts);
    hips.position.set(0, 0.97, -0.22); body.add(hips);
    const neck = cyl(0.05, 0.05, 0.1, skin); neck.position.set(0, 1.28, 0.33); body.add(neck);
    const headM = new THREE.Mesh(new THREE.SphereGeometry(0.115, 14, 12), skin);
    headM.position.set(0, 1.36, 0.42); body.add(headM);
    if (a.headwear === 'cap') {
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.12, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2.2), kit ? kit.cap : head);
      cap.position.copy(headM.position); cap.position.y += 0.015; body.add(cap);
      const brim = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.012, 0.09), kit ? kit.brim : head);
      brim.position.set(0, 1.405, 0.555); brim.rotation.x = -0.25; body.add(brim);
    } else {
      const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.14, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), kit ? kit.helmet : head);
      helmet.scale.set(1, 0.9, 1.3); helmet.position.copy(headM.position); helmet.position.y += 0.02; body.add(helmet);
    }
    if (a.hair === 'ponytail') {
      const pt = cyl(0.035, 0.02, 0.22, mat(a.hairColor));
      pt.position.set(0, 1.33, 0.27); pt.rotation.x = 1.1; body.add(pt);
    }
    for (const x of [-0.16, 0.16]) {
      const arm = new THREE.Group(); arm.position.set(x, 1.22, 0.3); arm.rotation.x = 0.75; body.add(arm);
      const sleeve = cyl(0.05, 0.045, 0.16, kit ? kit.sleeve : jersey); sleeve.position.y = -0.08; arm.add(sleeve);
      const fore = cyl(0.04, 0.035, 0.42, skin); fore.position.y = -0.36; arm.add(fore);
    }
    this.legs = [];
    for (const [x, ph] of [[-0.1, 0], [0.1, Math.PI]]) {
      const hip = new THREE.Group(); hip.position.set(x, 0.95, -0.22); body.add(hip);
      const thigh = cyl(0.07, 0.055, 0.44, kit ? kit.shorts : shorts); thigh.position.y = -0.22; hip.add(thigh);
      const knee = new THREE.Group(); knee.position.y = -0.44; hip.add(knee);
      const shin = cyl(0.05, 0.04, 0.3, skin); shin.position.y = -0.15; knee.add(shin);
      const sock = cyl(0.042, 0.038, 0.14, kit ? kit.socks : socks); sock.position.y = -0.36; knee.add(sock);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, 0.2), shoe); foot.position.set(0, -0.45, 0.05); knee.add(foot);
      this.legs.push({ hip, knee, ph });
    }
    this.group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    if (label) {
      this.label = labelSprite(name, kit ? kit.color : a.jersey, a.avatar);
      this.label.position.y = 2.1;
      this.group.add(this.label);
    }
    this.crank = 0;
  }
  animate(dt, speed, cadence) {
    for (const w of this.wheels) w.rotation.x -= (speed / 0.34) * dt;
    const rpm = cadence > 0 ? cadence : speed > 0.5 ? 85 : 0;
    this.crank += (rpm / 60) * Math.PI * 2 * dt;
    for (const { hip, knee, ph } of this.legs) {
      const c = this.crank + ph;
      hip.rotation.x = 0.55 + Math.sin(c) * 0.5;
      knee.rotation.x = -0.9 + Math.cos(c) * 0.55;
    }
  }
  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      for (const m of [].concat(o.material || [])) { if (m.map && !m.map.userData.shared) m.map.dispose(); m.dispose(); }
    });
  }
}

// ---------- World ----------
export class World {
  constructor(canvas, route) {
    this.track = new Track(route);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    const sky = new THREE.Color(0x9cc8ec);
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(sky, 150, 900);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.3, 2000);

    this.scene.add(new THREE.HemisphereLight(0xdfefff, 0x4a6a2a, 1.4));
    this.sun = new THREE.DirectionalLight(0xfff1d6, 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 200 });
    this.scene.add(this.sun, this.sun.target);

    this._buildIndex();
    this._buildRoad();
    this.grassTex = grassTexture();
    this.terrainCenter = null;
    this.riders = new Map();
    this.camPos = null;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const c = this.renderer.domElement;
    const w = c.clientWidth || window.innerWidth, h = c.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
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
  nearest(x, z) {
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
    }
    if (bi < 0) {
      for (const k of this.coarse) {
        const d = (r.x[k] - x) ** 2 + (-r.y[k] - z) ** 2;
        if (d < best) { best = d; bi = k; }
      }
    }
    return [Math.sqrt(best), r.ele[bi] - this.track.baseEle];
  }

  terrainHeight(x, z) {
    const [d, e] = this.nearest(x, z);
    const flat = e - 0.8;
    const k = smooth(16, 120, d);
    return flat + k * (fbm(x, z) * Math.min(45, 6 + d * 0.12) + d * 0.04);
  }

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

  _buildTerrain(cx, cz) {
    const SIZE = 2400, SEG = 200;
    if (this.terrain) {
      this.scene.remove(this.terrain, this.trunks, this.crowns);
      this.terrain.geometry.dispose(); this.trunks.geometry.dispose(); this.crowns.geometry.dispose();
    }
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
    geo.rotateX(-Math.PI / 2);
    const p = geo.attributes.position;
    const uv = geo.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i) + cx, z = p.getZ(i) + cz;
      p.setXYZ(i, x, this.terrainHeight(x, z), z);
      uv.setXY(i, x / 20, z / 20);
    }
    geo.computeVertexNormals();
    this.terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: this.grassTex, roughness: 1 }));
    this.terrain.receiveShadow = true;
    this.scene.add(this.terrain);

    // Trees
    const N = 1400;
    const trunkGeo = new THREE.CylinderGeometry(0.2, 0.3, 3, 6); trunkGeo.translate(0, 1.5, 0);
    const crownGeo = new THREE.ConeGeometry(2.2, 7, 7); crownGeo.translate(0, 6, 0);
    this.trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x5b3b22 }), N);
    this.crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardMaterial({ color: 0x2f5d2a, roughness: 0.9 }), N);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), v = new THREE.Vector3();
    const col = new THREE.Color();
    let count = 0, tries = 0;
    let seed = Math.floor(cx * 13 + cz * 7);
    const rnd = () => { seed = (seed * 1664525 + 1013904223) | 0; return ((seed >>> 0) % 100000) / 100000; };
    while (count < N && tries < N * 4) {
      tries++;
      const x = cx + (rnd() - 0.5) * SIZE, z = cz + (rnd() - 0.5) * SIZE;
      if (fbm(x * 2.3, z * 2.3) < -0.05) continue; // clusters / forests
      const [d] = this.nearest(x, z);
      if (d < 14) continue;
      const s = 0.7 + rnd() * 0.8;
      m.compose(v.set(x, this.terrainHeight(x, z) - 0.2, z), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6), sc.set(s, s, s));
      this.trunks.setMatrixAt(count, m);
      this.crowns.setMatrixAt(count, m);
      this.crowns.setColorAt(count, col.setHSL(0.27 + rnd() * 0.08, 0.45, 0.22 + rnd() * 0.1));
      count++;
    }
    this.trunks.count = this.crowns.count = count;
    this.crowns.castShadow = true;
    this.scene.add(this.trunks, this.crowns);
    this.terrainCenter = { x: cx, z: cz };
  }

  _ensureTerrain(x, z) {
    const snap = 500;
    const cx = Math.round(x / snap) * snap, cz = Math.round(z / snap) * snap;
    if (!this.terrainCenter || this.terrainCenter.x !== cx || this.terrainCenter.z !== cz) this._buildTerrain(cx, cz);
  }

  resetCamera() { this.camPos = null; }

  _laneOffset(id) {
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
    return ((Math.abs(h) % 5) - 2) * 0.9;
  }

  /**
   * riders: [{ id, name, color, dist, speed, cadence, me }]
   */
  render(dt, riders) {
    const seen = new Set();
    let me = null;
    for (const rd of riders) {
      seen.add(rd.id);
      let m = this.riders.get(rd.id);
      const key = rd.name + '|' + rd.height + '|' + JSON.stringify(rd.appearance);
      if (m && m.key !== key) { this.scene.remove(m.group); m.dispose(); m = null; }
      if (!m) {
        m = new RiderModel(rd.appearance, rd.name, { label: !rd.me, heightCm: rd.height });
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
      if (rd.me) me = { s, m };
    }
    for (const [id, m] of this.riders) {
      if (!seen.has(id)) { this.scene.remove(m.group); m.dispose(); this.riders.delete(id); }
    }

    if (me) {
      const { s, m } = me;
      const p = m.group.position;
      this._ensureTerrain(p.x, p.z);
      const back = this.track.sample(Math.max(0, (riders.find((r) => r.me).dist) - 7));
      const target = new THREE.Vector3(back.x - s.dz * 0.3, Math.max(back.y, s.y) + 2.6, back.z + s.dx * 0.3);
      const th = this.terrainHeight(target.x, target.z);
      if (target.y < th + 1.5) target.y = th + 1.5;
      if (!this.camPos) this.camPos = target.clone();
      this.camPos.lerp(target, 1 - Math.exp(-dt * 4));
      this.camera.position.copy(this.camPos);
      const ahead = this.track.sample(riders.find((r) => r.me).dist + 12);
      this.camera.lookAt(ahead.x, ahead.y + 1.2, ahead.z);
      this.sun.position.set(p.x + 40, p.y + 80, p.z + 25);
      this.sun.target.position.copy(p);
    }
    this.renderer.render(this.scene, this.camera);
  }
}
