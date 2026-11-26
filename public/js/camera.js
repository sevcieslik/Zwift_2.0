import * as THREE from 'three';

// Camera rig: preset views + free orbit with the mouse (drag = rotate, wheel = zoom, double-click = reset, C = next view).

export const VIEWS = [
  { name: 'Za kolarzem', dist: 5.5, pitch: 0.3, yaw: 0, fov: 58, look: 10 },
  { name: 'Z bliska', dist: 3.0, pitch: 0.2, yaw: 0, fov: 62, look: 8 },
  { name: 'Z boku', dist: 6, pitch: 0.14, yaw: 1.4, fov: 50, look: 1 },
  { name: 'Z przodu', dist: 7, pitch: 0.16, yaw: Math.PI, fov: 50, look: 0 },
  { name: 'Dron', dist: 70, pitch: 0.7, yaw: 0.35, fov: 55, look: 25 },
  { name: 'Z góry (mapa)', dist: 900, pitch: 1.45, yaw: 0, fov: 50, look: 0 },
  { name: 'Pierwsza osoba', fpv: true, fov: 72 },
];

const lerp = (a, b, t) => a + (b - a) * t;
const UP = new THREE.Vector3(0, 1, 0);

export class CameraRig extends EventTarget {
  constructor(camera, dom) {
    super();
    this.camera = camera;
    this.view = 0;
    this.uYaw = 0; this.uPitch = 0; this.uZoom = 1;
    this.pos = null;
    this.look = new THREE.Vector3();
    this._t = new THREE.Vector3(); this._b = new THREE.Vector3(); this._l = new THREE.Vector3();

    let drag = null;
    dom.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
      dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener('pointermove', (e) => {
      if (!drag || drag.id !== e.pointerId) return;
      this.uYaw -= (e.clientX - drag.x) * 0.005;
      this.uPitch = Math.max(-0.6, Math.min(1.3, this.uPitch + (e.clientY - drag.y) * 0.004));
      drag.x = e.clientX; drag.y = e.clientY;
    });
    const end = () => { drag = null; };
    dom.addEventListener('pointerup', end);
    dom.addEventListener('pointercancel', end);
    dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.uZoom = Math.max(0.3, Math.min(400, this.uZoom * Math.exp(e.deltaY * 0.0012)));
    }, { passive: false });
    dom.addEventListener('dblclick', () => this.reset());
  }

  get viewName() { return VIEWS[this.view].name; }
  reset() { this.uYaw = 0; this.uPitch = 0; this.uZoom = 1; }
  next() { this.setView((this.view + 1) % VIEWS.length); }
  setView(i) {
    this.view = i; this.reset();
    this.dispatchEvent(new CustomEvent('view', { detail: VIEWS[i].name }));
  }
  get fpv() { return !!VIEWS[this.view].fpv; }

  /**
   * p: rider position, dir: unit heading (XZ), heightAt(x,z): terrain height, warp: 0..1
   */
  update(dt, p, dir, heightAt, warp = 0) {
    const v = VIEWS[this.view];
    const cam = this.camera;
    let fov = v.fov;
    if (v.fpv) {
      const yaw = this.uYaw, pitch = this.uPitch * 0.8;
      const d = this._b.copy(dir).applyAxisAngle(UP, yaw);
      this._t.copy(p).addScaledVector(UP, 1.55).addScaledVector(dir, 0.42);
      this._l.copy(this._t).addScaledVector(d, 20).addScaledVector(UP, -1.2 + Math.tan(pitch) * 20);
      this.pos = this._t.clone();
      this.look.copy(this._l);
      fov = lerp(fov, 90, warp);
    } else {
      const chase = this.view <= 1;
      const w = chase ? warp : warp * 0.4;
      const dist = lerp(v.dist * this.uZoom, 2.4, w);
      const pitch = Math.max(-0.15, Math.min(1.5, lerp(v.pitch + this.uPitch, 0.1, w)));
      const yaw = v.yaw + this.uYaw * (1 - w);
      const back = this._b.copy(dir).negate().applyAxisAngle(UP, yaw);
      const t = this._t.copy(p)
        .addScaledVector(back, Math.cos(pitch) * dist)
        .addScaledVector(UP, Math.sin(pitch) * dist + 1.2);
      const ground = heightAt(t.x, t.z);
      if (Number.isFinite(ground) && t.y < ground + 1.0) t.y = ground + 1.0;
      const k = 1 - Math.exp(-dt * (dist > 100 ? 3 : lerp(6, 18, w)));
      if (!this.pos || this.pos.distanceTo(t) > 300 + dist) this.pos = t.clone();
      else this.pos.lerp(t, k);
      const lookAhead = lerp(dist < 30 ? v.look : v.look * 0.2, 40, warp);
      this._l.copy(p).addScaledVector(dir, lookAhead).addScaledVector(UP, lerp(1.0, 1.3, warp));
      if (this.look.lengthSq() === 0 || this.look.distanceTo(this._l) > 200) this.look.copy(this._l);
      else this.look.lerp(this._l, 1 - Math.exp(-dt * 8));
      fov = lerp(fov, 80, w);
    }
    cam.position.copy(this.pos);
    cam.lookAt(this.look);
    if (Math.abs(cam.fov - fov) > 0.05) { cam.fov = fov; cam.updateProjectionMatrix(); }
  }
}
