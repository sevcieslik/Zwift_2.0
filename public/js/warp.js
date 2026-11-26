import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// "Hyper focus" sprint effect: radial (warp-speed) blur, tunnel vision, chromatic aberration,
// light streaks flying past and a glowing focus point on the road ahead.

const WarpShader = {
  uniforms: { tDiffuse: { value: null }, amount: { value: 0 }, center: { value: new THREE.Vector2(0.5, 0.5) }, aspect: { value: 1 } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float amount; uniform vec2 center; uniform float aspect;
    varying vec2 vUv;
    void main() {
      vec2 dir = vUv - center;
      float dist = length(vec2(dir.x * aspect, dir.y));
      float strength = amount * 0.16 * smoothstep(0.04, 0.55, dist);
      vec3 col = vec3(0.0);
      for (int i = 0; i < 14; i++) {
        float t = float(i) / 13.0;
        col += texture2D(tDiffuse, vUv - dir * strength * t).rgb;
      }
      col /= 14.0;
      float ca = amount * 0.012 * dist;
      col.r = mix(col.r, texture2D(tDiffuse, vUv - dir * (strength * 0.5 + ca)).r, 0.6);
      col.b = mix(col.b, texture2D(tDiffuse, vUv - dir * (strength * 0.5 - ca)).b, 0.6);
      float vig = smoothstep(0.12, 0.8, dist);
      float gray = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, vec3(gray), vig * amount * 0.75);
      col *= 1.0 - vig * amount * 0.8;
      col += vec3(0.12, 0.3, 0.85) * pow(vig, 2.5) * amount * 0.3;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.15, 'rgba(255,250,230,0.95)');
  gr.addColorStop(0.35, 'rgba(120,200,255,0.5)');
  gr.addColorStop(1, 'rgba(60,120,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

export class WarpFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer; this.scene = scene; this.camera = camera;
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    this.pass = new ShaderPass(WarpShader);
    this.composer.addPass(this.pass);
    this.composer.addPass(new OutputPass());
    this.amount = 0;
    this.time = 0;

    // light streaks in camera space
    const N = 420;
    this.N = N;
    this.stars = Array.from({ length: N }, () => this._spawn({}, true));
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 6), 3));
    this.lines = new THREE.LineSegments(this.geo, new THREE.LineBasicMaterial({
      color: 0xcfe6ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, fog: false, toneMapped: false,
    }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 999;
    camera.add(this.lines);

    this.focus = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, fog: false, toneMapped: false }));
    this.focus.renderOrder = 1000;
    this.focus.visible = false;
    scene.add(this.focus);
    this._v = new THREE.Vector3();
  }

  _spawn(s, anyZ = false) {
    const a = Math.random() * Math.PI * 2;
    const r = 1.6 + Math.pow(Math.random(), 0.7) * 16;
    s.x = Math.cos(a) * r; s.y = Math.sin(a) * r * 0.7;
    s.z = anyZ ? -3 - Math.random() * 160 : -140 - Math.random() * 30;
    s.v = 0.7 + Math.random() * 0.6;
    return s;
  }

  setSize(w, h) {
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.pass.uniforms.aspect.value = w / h;
  }

  /** amount 0..1, focusPos: world position the rider should fixate on */
  update(dt, amount, focusPos) {
    this.amount = amount;
    this.time += dt;
    this.pass.uniforms.amount.value = amount;
    const on = amount > 0.01;
    this.lines.visible = on;
    this.focus.visible = on;
    if (!on) return;
    // streaks
    const pos = this.geo.attributes.position.array;
    const speed = 160 * (0.4 + amount);
    const len = 3 + 30 * amount;
    for (let i = 0; i < this.N; i++) {
      const s = this.stars[i];
      s.z += speed * s.v * dt;
      if (s.z > -2) this._spawn(s);
      pos.set([s.x, s.y, s.z, s.x, s.y, s.z - len * s.v], i * 6);
    }
    this.geo.attributes.position.needsUpdate = true;
    this.lines.material.opacity = 0.75 * amount;
    // focus point
    this.focus.position.copy(focusPos);
    const pulse = 1 + Math.sin(this.time * 9) * 0.12;
    const sz = (0.9 + 1.4 * amount) * pulse;
    this.focus.scale.set(sz, sz, 1);
    this.focus.material.opacity = amount;
    // centre the blur on the focus point
    this._v.copy(focusPos).project(this.camera);
    this.pass.uniforms.center.value.set(this._v.x * 0.5 + 0.5, this._v.y * 0.5 + 0.5);
  }

  render() {
    if (this.amount > 0.01) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
