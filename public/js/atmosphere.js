import * as THREE from 'three';

// Time of day, weather and wind.
// - sun position for Snowdonia (~53°N, summer-ish day: sunrise ~5:00, sunset ~21:15)
// - sky shader with moving clouds, fog, rain streaks around the camera, wet road
// - "auto" weather/wind is a smooth function of the shared server clock and the room name,
//   so everybody in a group ride gets the same weather and the same headwind.

export const TIMES = [
  ['real', 'Czas rzeczywisty'], ['7.5', 'Rano 7:30'], ['12.5', 'Południe'], ['16', 'Popołudnie'],
  ['19.6', 'Złota godzina'], ['20.9', 'Zmierzch'], ['cycle', 'Cykl dnia (1 h)'],
];
export const WEATHERS = [
  ['auto', 'Zmienna'], ['clear', 'Słonecznie'], ['cloudy', 'Pochmurno'], ['fog', 'Mgła'], ['rain', 'Deszcz'],
];
export const WINDS = [['auto', 'Zmienny'], ['0', 'Bez wiatru'], ['3', 'Lekki (3 m/s)'], ['7', 'Silny (7 m/s)']];

const PRESET = { // cloud cover, rain, fog visibility (m)
  clear: { cloud: 0.12, rain: 0, vis: 26000 },
  cloudy: { cloud: 0.75, rain: 0, vis: 9000 },
  fog: { cloud: 0.6, rain: 0, vis: 260 },
  rain: { cloud: 0.95, rain: 1, vis: 1600 },
};
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const mixC = (a, b, t) => a.clone().lerp(b, t);

export class Atmosphere {
  constructor(scene, { seed = 'gpx' } = {}) {
    this.scene = scene;
    let h = 0; for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) | 0;
    this.phase = (Math.abs(h) % 10000) / 10000 * 1000;
    this.settings = { time: '16', weather: 'auto', wind: 'auto' };
    this.clock = () => Date.now();
    this.sunDir = new THREE.Vector3(0.45, 0.62, 0.35).normalize();
    this.horizon = new THREE.Color(0xc9dcec);
    this.top = new THREE.Color(0x2f6fc0);
    this.sunColor = new THREE.Color(0xfff0d8);
    this.state = { hour: 16, cloud: 0.2, rain: 0, vis: 26000, wet: 0, windSpeed: 3, windFrom: 4.0 };
    this.t = 0;

    scene.background = this.horizon;
    scene.fog = new THREE.Fog(this.horizon.clone(), 500, 26000);
    this.sky = this._sky();
    scene.add(this.sky);
    this.hemi = new THREE.HemisphereLight(0xd8e8ff, 0x4f5a3a, 1.5);
    scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff0d8, 3.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.02;
    Object.assign(this.sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 400 });
    scene.add(this.sun, this.sun.target);
    this.rainFx = this._rain();
    scene.add(this.rainFx);
    this._first = true;
  }

  _sky() {
    this.skyU = {
      top: { value: this.top }, horizon: { value: this.horizon }, sunDir: { value: this.sunDir },
      sunCol: { value: this.sunColor }, cloud: { value: 0.2 }, time: { value: 0 }, night: { value: 0 },
      wind: { value: new THREE.Vector2(1, 0) },
    };
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false, uniforms: this.skyU,
      vertexShader: `varying vec3 vDir;
        void main() { vDir = position; vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0); gl_Position = p.xyww; }`,
      fragmentShader: `uniform vec3 top, horizon, sunDir, sunCol; uniform float cloud, time, night; uniform vec2 wind; varying vec3 vDir;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
        float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int k = 0; k < 5; k++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; } return v; }
        void main() {
          vec3 d = normalize(vDir);
          float h = max(d.y, 0.0);
          vec3 c = mix(horizon, top, pow(h, 0.45));
          float s = max(dot(d, sunDir), 0.0);
          float sunVis = smoothstep(-0.05, 0.02, sunDir.y);
          c += sunCol * (pow(s, 900.0) * 4.0 + pow(s, 14.0) * 0.18 + pow(s, 3.0) * 0.06 * (1.0 - h)) * sunVis * (1.0 - cloud * 0.8);
          // stars
          if (night > 0.01 && d.y > 0.0) { vec2 st = d.xz / (d.y + 0.3) * 160.0; float n = hash(floor(st)); c += vec3(step(0.9975, n)) * night * smoothstep(0.0, 0.2, d.y); }
          // clouds on a plane above the camera
          if (d.y > 0.01) {
            vec2 uv = d.xz / (d.y + 0.08) * 1.6 + wind * time * 0.004;
            float n = fbm(uv) * 0.75 + fbm(uv * 3.1 + 5.0) * 0.25;
            float cov = smoothstep(1.0 - cloud * 0.95 - 0.12, 1.0 - cloud * 0.95 + 0.22, n);
            float lit = 0.75 + 0.35 * pow(s, 4.0);
            vec3 cc = mix(vec3(0.95, 0.96, 0.98), vec3(0.55, 0.58, 0.62), cloud * 0.85) * lit;
            cc = mix(cc, sunCol * 0.9 + horizon * 0.3, smoothstep(0.35, 0.0, sunDir.y) * 0.5) * (1.0 - night * 0.85);
            c = mix(c, cc, cov * smoothstep(0.01, 0.12, d.y) * 0.95);
          }
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), mat);
    m.frustumCulled = false;
    m.renderOrder = -1000;
    return m;
  }

  _rain() {
    const N = 9000, pos = new Float32Array(N * 2 * 3), seed = new Float32Array(N * 2), end = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      const x = Math.random(), y = Math.random(), z = Math.random(), sd = Math.random();
      for (let k = 0; k < 2; k++) { pos.set([x, y, z], (i * 2 + k) * 3); seed[i * 2 + k] = sd; end[i * 2 + k] = k; }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    g.setAttribute('tip', new THREE.BufferAttribute(end, 1));
    this.rainU = { time: { value: 0 }, center: { value: new THREE.Vector3() }, amount: { value: 0 }, drift: { value: new THREE.Vector2() }, color: { value: new THREE.Color(0xaab4c0) } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.rainU, transparent: true, depthWrite: false, fog: false,
      vertexShader: `uniform float time, amount; uniform vec3 center; uniform vec2 drift; attribute float seed, tip; varying float vA;
        void main() {
          const vec3 box = vec3(60.0, 30.0, 60.0);
          float fall = 9.0 + seed * 3.0;
          vec3 p = position * box;
          p.y = mod(p.y - time * fall, box.y);
          p.xz += drift * (box.y - p.y) * 0.08;
          // wrap around the camera so the rain box always surrounds it
          p.x = mod(p.x - center.x, box.x) + center.x - box.x * 0.5;
          p.z = mod(p.z - center.z, box.z) + center.z - box.z * 0.5;
          p.y += center.y - box.y * 0.4;
          p.y += tip * 0.55; p.xz -= tip * drift * 0.05;
          vA = step(seed, amount) * (0.25 + 0.3 * tip);
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `uniform vec3 color; varying float vA; void main() { if (vA < 0.01) discard; gl_FragColor = vec4(color, vA); }`,
    });
    const l = new THREE.LineSegments(g, mat);
    l.frustumCulled = false;
    l.visible = false;
    return l;
  }

  /** Hour (0-24) chosen in the settings. */
  _hour() {
    const t = this.settings.time;
    if (t === 'real') { const d = new Date(this.clock()); return d.getHours() + d.getMinutes() / 60; }
    if (t === 'cycle') return 5 + ((this.clock() / 1000 / 3600) % 1) * 17; // dawn..dusk in an hour
    return parseFloat(t) || 16;
  }
  /** Weather targets: preset or a slow, shared random walk. */
  _weather() {
    const w = this.settings.weather;
    if (PRESET[w]) return PRESET[w];
    const t = this.clock() / 1000 / 60 + this.phase; // minutes
    const n = 0.5 + 0.28 * Math.sin(t / 23) + 0.15 * Math.sin(t / 9.7 + 1.3) + 0.07 * Math.sin(t / 4.1 + 0.4);
    const cloud = Math.max(0.05, Math.min(1, n * 1.25 - 0.1));
    const rain = smooth(0.78, 0.95, n);
    const fogB = smooth(0.85, 1, 0.5 + 0.5 * Math.sin(t / 31 + 2.2)) * (1 - rain);
    const vis = 26000 * (1 - cloud * 0.55) * (1 - rain * 0.9) * (1 - fogB * 0.97);
    return { cloud, rain, vis: Math.max(300, vis) };
  }
  _wind() {
    const w = this.settings.wind;
    const t = this.clock() / 1000 / 60 + this.phase;
    const from = 3.9 + 0.9 * Math.sin(t / 37) + 0.3 * Math.sin(t / 11); // prevailing south-westerly in Wales
    if (w !== 'auto') return { speed: parseFloat(w) || 0, from };
    const gust = 0.25 * Math.sin(t * 2.1) + 0.15 * Math.sin(t * 5.3 + 1);
    return { speed: Math.max(0, 3.2 + 2.6 * Math.sin(t / 17 + 0.7) + gust * 2), from };
  }

  /** Headwind (m/s, positive = into the rider) for a direction of travel (world dx, dz). */
  headwind(dx, dz) {
    const { windSpeed, windFrom } = this.state;
    // windFrom: compass bearing the wind blows FROM (rad, 0 = north). World: north = -Z, east = +X
    const fx = Math.sin(windFrom), fz = -Math.cos(windFrom);
    return windSpeed * (dx * fx + dz * fz);
  }

  update(dt, camPos, focus) {
    this.t += dt;
    const S = this.state;
    const hour = this._hour();
    // weather/wind change smoothly (also when the user switches presets)
    const k = this._first ? 1 : 1 - Math.exp(-dt / 6);
    const W = this._weather(), WI = this._wind();
    S.cloud += (W.cloud - S.cloud) * k;
    S.rain += (W.rain - S.rain) * k;
    S.vis += (W.vis - S.vis) * k;
    S.windSpeed += (WI.speed - S.windSpeed) * k;
    let dA = WI.from - S.windFrom; dA = Math.atan2(Math.sin(dA), Math.cos(dA)); S.windFrom += dA * k;
    S.wet = Math.max(S.rain, S.wet - dt / 240); // roads dry out over a few minutes
    S.hour = hour;
    this._first = false;

    // sun: elevation and azimuth from the hour (approximation for 53°N in summer)
    const dayT = (hour - 5.1) / (21.3 - 5.1);
    const el = (Math.sin(Math.PI * dayT) * 58 - 4) * Math.PI / 180;
    const az = (55 + dayT * 250) * Math.PI / 180; // NE -> S -> NW
    this.sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
    const elev = this.sunDir.y;
    const day = smooth(-0.12, 0.12, elev);
    const golden = (1 - smooth(0.05, 0.35, elev)) * day;
    const night = 1 - smooth(-0.2, 0.02, elev);
    const cloud = S.cloud, rain = S.rain;

    // colours
    const C = (h) => new THREE.Color(h);
    let hor = mixC(C(0xc9dcec), C(0xf0c08e), golden);
    let top = mixC(C(0x2f6fc0), C(0x3d6aa8), golden);
    hor = mixC(hor, C(0x1a2234), night); top = mixC(top, C(0x04070f), night);
    const grey = mixC(C(0xb8bec6), C(0x7f8a96), rain);
    hor = mixC(hor, grey.clone().multiplyScalar(0.25 + 0.75 * day), cloud * 0.85);
    top = mixC(top, grey.clone().multiplyScalar(0.7 * (0.25 + 0.75 * day)), cloud * 0.9);
    this.horizon.copy(hor); this.top.copy(top);
    this.sunColor.copy(mixC(C(0xfff2dc), C(0xff8a3c), golden));
    this.skyU.cloud.value = cloud;
    this.skyU.time.value = this.t;
    this.skyU.night.value = night * (1 - cloud);
    this.skyU.wind.value.set(Math.sin(S.windFrom + Math.PI), -Math.cos(S.windFrom + Math.PI)).multiplyScalar(0.5 + S.windSpeed * 0.15);

    // lights
    const direct = day * (1 - cloud * 0.8) * (1 - rain * 0.3);
    this.sun.intensity = 3.4 * direct * (1 + golden * 0.35);
    this.sun.color.copy(this.sunColor);
    this.sun.castShadow = direct > 0.15;
    this.hemi.intensity = 0.25 + 1.35 * day * (1 - cloud * 0.25);
    this.hemi.color.copy(mixC(C(0xd8e8ff), C(0xdfe3e8), cloud)).lerp(C(0xffc890), golden * 0.45 * (1 - cloud)).lerp(C(0x4a5a80), night);
    this.hemi.groundColor.copy(mixC(C(0x4f5a3a), C(0x5a4a38), golden)).multiplyScalar(0.4 + 0.6 * day);

    // fog: fog distance from visibility, colour = horizon
    const fog = this.scene.fog;
    fog.color.copy(this.horizon);
    fog.far = Math.min(26000, S.vis);
    fog.near = Math.min(400, S.vis * 0.03);
    this.scene.background = this.horizon;

    // rain around the camera
    this.rainFx.visible = rain > 0.02;
    this.rainU.amount.value = rain;
    this.rainU.time.value = this.t;
    this.rainU.center.value.copy(camPos);
    const wx = Math.sin(S.windFrom + Math.PI) * S.windSpeed, wz = -Math.cos(S.windFrom + Math.PI) * S.windSpeed;
    this.rainU.drift.value.set(wx, wz);
    this.rainU.color.value.copy(this.horizon).lerp(C(0xffffff), 0.3);

    // sun light follows the rider for crisp shadows
    if (focus) {
      this.sun.position.copy(focus).addScaledVector(this.sunDir, 150);
      this.sun.target.position.copy(focus);
    }
    return { day, night, cloud, rain, wet: S.wet, golden };
  }
}
