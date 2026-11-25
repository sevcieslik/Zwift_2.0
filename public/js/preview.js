import * as THREE from 'three';
import { RiderModel } from './world.js';

/** Small rotating 3D preview of a rider (lobby + in-ride wardrobe). */
export class RiderPreview {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
    this.camera.position.set(1.9, 1.25, 1.9);
    this.camera.lookAt(0, 0.78, 0);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445533, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2);
    sun.position.set(3, 5, 2);
    this.scene.add(sun);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(1.3, 40), new THREE.MeshStandardMaterial({ color: 0x2c3442 }));
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);
    this.model = null;
    this.angle = 0;
    this.running = true;
    let last = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      if (this.canvas.offsetParent !== null) {
        this._resize();
        this.angle += dt * 0.6;
        if (this.model) { this.model.group.rotation.y = this.angle; this.model.animate(dt, 0, 70); }
        this.renderer.render(this.scene, this.camera);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  _resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const c = this.renderer.domElement;
    if (c.width !== Math.round(w * this.renderer.getPixelRatio())) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
  }
  set(appearance, heightCm = 178) {
    if (this.model) { this.scene.remove(this.model.group); this.model.dispose(); }
    this.model = new RiderModel(appearance, '', { label: false, heightCm });
    this.model.group.position.set(0, 0, 0);
    this.scene.add(this.model.group);
  }
  dispose() { this.running = false; this.renderer.dispose(); }
}
