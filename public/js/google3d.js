import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { GoogleCloudAuthPlugin, GLTFExtensionsPlugin, ReorientationPlugin, TileCompressionPlugin, TilesFadePlugin } from '3d-tiles-renderer/plugins';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// Google Photorealistic 3D Tiles placed in the game's local coordinates (X east, Y up, Z south).
// The tiles live on the globe; we re-centre a local tangent frame under the rider every ~1.5 km
// (the game map is flat, the Earth is not: 20 km away the difference is ~30 m) and calibrate
// the height so the photogrammetry surface meets the road.

const R = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;
const GEOID_UK = 52; // ellipsoid - mean sea level in North Wales (m); refined by calibration

export class GoogleTerrain extends EventTarget {
  constructor({ key, scene, camera, renderer, track }) {
    super();
    this.camera = camera; this.renderer = renderer; this.track = track;
    const o = track.r.origin;
    this.lat0 = o.lat; this.lon0 = o.lon;
    this.kx = toRad(1) * R * Math.cos(toRad(o.lat));
    this.ky = toRad(1) * R;

    const tiles = new TilesRenderer();
    tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: key, autoRefreshToken: true }));
    const draco = new DRACOLoader().setDecoderPath('/vendor/three/examples/jsm/libs/draco/gltf/');
    tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));
    tiles.registerPlugin(new TileCompressionPlugin());
    tiles.registerPlugin(new TilesFadePlugin());
    this.reorient = new ReorientationPlugin({ lat: toRad(o.lat), lon: toRad(o.lon), height: track.baseEle + GEOID_UK, recenter: true });
    tiles.registerPlugin(this.reorient);
    tiles.errorTarget = 12;
    tiles.setCamera(camera);
    tiles.setResolutionFromRenderer(camera, renderer);
    this.tiles = tiles;

    // ENU "object frame" has X west / Z north; the game has X east / Z south -> turn 180° about Y
    this.wrap = new THREE.Group();
    const inner = new THREE.Group();
    inner.rotation.y = Math.PI;
    inner.add(tiles.group);
    this.wrap.add(inner);
    scene.add(this.wrap);

    this.center = { x: 0, z: 0 };
    this.yOffset = 0;
    this.calibrated = false;
    this.lastCal = 0;
    this.errors = 0;
    this.loaded = false;
    tiles.addEventListener('load-error', (e) => {
      this.errors++;
      if (this.errors === 1) {
        console.warn('Google 3D Tiles error', e.error || e);
        this.dispatchEvent(new CustomEvent('error', { detail: String((e.error && e.error.message) || e.error || 'błąd wczytywania') }));
      }
    });
    tiles.addEventListener('load-tile-set', () => { if (!this.loaded) { this.loaded = true; this.dispatchEvent(new Event('ready')); } });
    tiles.addEventListener('tiles-load-end', () => { if (!this.loaded) { this.loaded = true; this.dispatchEvent(new Event('ready')); } });
    tiles.addEventListener('load-model', ({ scene: model }) => {
      model.traverse((c) => {
        const m = c.material;
        if (!m) return;
        for (const mm of Array.isArray(m) ? m : [m]) {
          mm.toneMapped = false;
          if (mm.isMeshStandardMaterial && mm.map) {
            mm.emissiveMap = mm.map; mm.emissive.setRGB(1, 1, 1);
            mm.color.setRGB(0, 0, 0); mm.metalness = 0; mm.roughness = 1; mm.envMapIntensity = 0;
            mm.needsUpdate = true;
          }
        }
      });
    });
    this._ray = new THREE.Raycaster();
    this._down = new THREE.Vector3(0, -1, 0);
  }

  set visible(v) { this.wrap.visible = v; this._visible = v; }
  get visible() { return this._visible !== false; }

  resize() { this.tiles.setResolutionFromRenderer(this.camera, this.renderer); }

  _recenter(x, z) {
    const lat = this.lat0 - z / this.ky, lon = this.lon0 + x / this.kx;
    this.reorient.transformLatLonHeightToOrigin(toRad(lat), toRad(lon), this.track.baseEle + GEOID_UK);
    this.center = { x, z };
    this.wrap.position.set(x, this.yOffset, z);
    this.calibrated = false;
  }

  /** Measure where the Google surface is under the road near the rider and shift the tiles to match.
   *  Photogrammetry has trees, walls and houses next to (and over) the road, so for every road point we
   *  cast a small fan of rays across the carriageway and keep the LOWEST hit (open tarmac), then take a
   *  robust median over ~±250 m of road. */
  _calibrate(dist) {
    const tr = this.track, diffs = [];
    const o = new THREE.Vector3();
    for (let k = -10; k <= 10; k++) {
      const d = Math.max(0, Math.min(tr.total - 2, dist + k * 25));
      const s = tr.sample(d), s2 = tr.sample(d + 2);
      let nx = -(s2.z - s.z), nz = s2.x - s.x; const L = Math.hypot(nx, nz) || 1; nx /= L; nz /= L;
      let low = null;
      for (const off of [-2.5, -1, 0, 1, 2.5]) {
        o.set(s.x + nx * off, s.y + 400, s.z + nz * off);
        this._ray.set(o, this._down);
        this._ray.far = 900;
        const hit = this._ray.intersectObject(this.tiles.group, true)[0];
        if (hit && (low === null || hit.point.y < low)) low = hit.point.y;
      }
      if (low !== null) diffs.push(s.y - low);
    }
    if (diffs.length < 5) return;
    diffs.sort((a, b) => a - b);
    // drop the upper/lower quarter (bridges, cuttings, canopy) and average the rest
    const q = diffs.slice(diffs.length >> 2, diffs.length - (diffs.length >> 2));
    const diff = q.reduce((a, b) => a + b, 0) / q.length;
    const target = this.yOffset + diff - 0.15; // road ribbon sits just above the real road
    const jump = !this.calibrated || Math.abs(target - this.yOffset) > 2.5;
    this.yOffset = jump ? target : this.yOffset + (target - this.yOffset) * 0.4;
    this.calibrated = true;
    this.wrap.position.y = this.yOffset;
    this.lastDiff = diff;
    if (jump) console.info(`[Google 3D] wysokość: przesunięcie ${this.yOffset.toFixed(1)} m (próbek ${diffs.length})`);
  }

  update(x, z, dist) {
    if (!this.visible) return;
    if (Math.hypot(x - this.center.x, z - this.center.z) > 1500 || !this.started) {
      this.started = true;
      this._recenter(x, z);
    }
    this.camera.updateMatrixWorld();
    this.tiles.update();
    const now = performance.now();
    if (now - this.lastCal > (this.calibrated ? 3000 : 800)) {
      this.lastCal = now;
      this._calibrate(dist);
    }
  }

  attributions() {
    try {
      return this.tiles.getAttributions().filter((a) => a.type === 'string').map((a) => a.value).join(', ');
    } catch { return ''; }
  }

  dispose() {
    this.wrap.removeFromParent();
    this.tiles.dispose();
  }
}
