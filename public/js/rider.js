import * as THREE from 'three';
import { kitMaterials } from './kits.js';

// Detailed low-poly cyclist on a road bike. Units: metres. Forward = +Z, up = +Y, +X = rider's left.
// Legs are driven by 2-bone IK so the feet stay on the pedals.

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);
const _m = new THREE.Matrix4(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();

/** Tapered capsule along +Y from 0 to len (caps extend beyond), u=0 faces +Z. */
/** Lathe along +Y from 0 to len with rounded ends; prof = [[t, radius], ...], t in 0..1. */
function shapeGeo(prof, len, seg = 14) {
  const pts = [];
  const r0 = prof[0][1], r1 = prof[prof.length - 1][1];
  for (let i = 0; i <= 4; i++) { const a = -Math.PI / 2 + (i / 4) * (Math.PI / 2); pts.push(new THREE.Vector2(Math.max(1e-4, r0 * Math.cos(a)), r0 * Math.sin(a) * 0.7 * len / Math.max(len, r0 * 3))); }
  for (let i = 1; i < prof.length - 1; i++) pts.push(new THREE.Vector2(prof[i][1], prof[i][0] * len));
  for (let i = 0; i <= 4; i++) { const a = (i / 4) * (Math.PI / 2); pts.push(new THREE.Vector2(Math.max(1e-4, r1 * Math.cos(a)), len + r1 * Math.sin(a) * 0.7 * len / Math.max(len, r1 * 3))); }
  return new THREE.LatheGeometry(pts, seg);
}

/** Torso: tapered (narrow waist, broad chest), uniform v along the length so the jersey print isn't distorted. */
function torsoGeo(len, seg = 28) {
  const pts = [];
  const N = 22;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const base = 0.118 + 0.034 * Math.min(1, Math.max(0, (t - 0.05) / 0.7));
    const r = i === 0 || i === N ? 0.0001 : base * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(t - 0.5) * 2, 6)), 0.5);
    pts.push(new THREE.Vector2(r, -0.06 + t * (len + 0.1)));
  }
  return new THREE.LatheGeometry(pts, seg);
}

function limbGeo(r1, r2, len, seg = 14) {
  const pts = [];
  for (let i = 0; i <= 5; i++) { const a = -Math.PI / 2 + (i / 5) * (Math.PI / 2); pts.push(new THREE.Vector2(r1 * Math.cos(a), r1 * Math.sin(a))); }
  for (let i = 0; i <= 5; i++) { const a = (i / 5) * (Math.PI / 2); pts.push(new THREE.Vector2(Math.max(0.0001, r2 * Math.cos(a)), len + r2 * Math.sin(a))); }
  pts[0].x = 0.0001;
  return new THREE.LatheGeometry(pts, seg);
}

/** Orient a +Y-aligned mesh from a to b; zHint chooses the roll (local +Z points towards it). */
function place(mesh, a, b, zHint = V(0, 1, 0), len = null) {
  _y.subVectors(b, a);
  const d = _y.length();
  _y.divideScalar(d || 1);
  _z.copy(zHint).addScaledVector(_y, -zHint.dot(_y));
  if (_z.lengthSq() < 1e-6) _z.set(1, 0, 0).addScaledVector(_y, -_y.x);
  _z.normalize();
  _x.crossVectors(_y, _z);
  _m.makeBasis(_x, _y, _z);
  mesh.quaternion.setFromRotationMatrix(_m);
  mesh.position.copy(a);
  if (len) mesh.scale.set(1, d / len, 1);
}

/** Two-bone IK: returns joint position. pole = point the joint bends towards. */
function ik(root, target, l1, l2, pole, out = new THREE.Vector3()) {
  const dir = new THREE.Vector3().subVectors(target, root);
  let d = dir.length();
  dir.divideScalar(d || 1);
  d = Math.min(d, (l1 + l2) * 0.999);
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const p = new THREE.Vector3().subVectors(pole, root);
  p.addScaledVector(dir, -p.dot(dir)).normalize();
  return out.copy(root).addScaledVector(dir, a).addScaledVector(p, h);
}

function tube(r1, r2, mat, seg = 10) {
  const g = new THREE.CylinderGeometry(r2, r1, 1, seg, 1);
  g.translate(0, 0.5, 0);
  return new THREE.Mesh(g, mat);
}
function link(parent, a, b, r1, r2, mat, seg) {
  const m = tube(r1, r2 ?? r1, mat, seg);
  place(m, a, b, UP);
  m.scale.y = a.distanceTo(b);
  parent.add(m);
  return m;
}

const std = (color, rough = 0.55, metal = 0) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });

// Shared geometries
const G = {
  tire: new THREE.TorusGeometry(0.322, 0.0135, 10, 48),
  rim: new THREE.RingGeometry(0.262, 0.31, 48, 1),
  rimEdge: new THREE.TorusGeometry(0.262, 0.005, 6, 48),
  hub: new THREE.CylinderGeometry(0.018, 0.018, 0.1, 12),
  spoke: new THREE.CylinderGeometry(0.0012, 0.0012, 0.245, 3),
  chainring: new THREE.CylinderGeometry(0.105, 0.105, 0.006, 32),
  pedal: new THREE.BoxGeometry(0.09, 0.015, 0.07),
  head: new THREE.SphereGeometry(0.1, 20, 16),
  helmet: new THREE.SphereGeometry(0.128, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55),
  glasses: new THREE.TorusGeometry(0.104, 0.017, 6, 24, Math.PI * 0.75),
  hand: new THREE.SphereGeometry(0.042, 10, 8),
  bottle: new THREE.CylinderGeometry(0.035, 0.035, 0.2, 14),
};

export class RiderModel {
  constructor(appearance, name, { label = true, heightCm = 178, labelSprite = null } = {}) {
    const a = appearance;
    const kit = kitMaterials(a.kit, 'wrap');
    this.group = new THREE.Group();
    const root = new THREE.Group(); // scaled with rider height
    this.group.add(root);
    const s = Math.max(0.86, Math.min(1.14, heightCm / 178));
    root.scale.setScalar(s);
    this.root = root;

    // ---------- materials ----------
    const frameM = std(a.frame, 0.32, 0.35);
    const carbon = std(0x1b1d21, 0.4, 0.2);
    const black = std(0x141414, 0.6);
    const rubber = std(0x111111, 0.85);
    const silver = std(0xb8bcc2, 0.3, 0.8);
    const skin = std(a.skin, 0.75);
    const jersey = kit ? kit.torso : std(a.jersey, 0.6);
    const sleeveM = kit ? kit.sleeve : std(a.jersey, 0.6);
    const shortsM = kit ? kit.thigh : std(a.shorts, 0.6);
    const pelvisM = kit ? kit.hips : std(a.shorts, 0.6);
    const sockM = kit ? kit.sock : std(a.socks, 0.8);
    const shoeM = std(0xf4f4f4, 0.4);
    const headM = kit ? (a.headwear === 'cap' ? kit.cap : kit.helmet) : std(a.headColor, 0.35);
    const lens = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.1, metalness: 0.9 });
    this._mats = [frameM, carbon, black, rubber, silver, skin, shoeM, lens];
    if (!kit) this._mats.push(jersey, sleeveM, shortsM, pelvisM, sockM, headM);

    // ---------- bike geometry ----------
    const P = {
      bb: V(0, 0.27, 0),
      seatCluster: V(0, 0.80, -0.165),
      headTop: V(0, 0.82, 0.405),
      headBot: V(0, 0.66, 0.445),
      rear: V(0, 0.335, -0.408),
      front: V(0, 0.335, 0.585),
      saddle: V(0, 0.975, -0.215),
      stem: V(0, 0.855, 0.5),
    };
    this.P = P;
    const bike = new THREE.Group();
    root.add(bike);
    link(bike, P.seatCluster, P.headTop, 0.021, 0.019, frameM);
    link(bike, P.bb, P.headBot, 0.03, 0.026, frameM);
    link(bike, P.bb, P.seatCluster, 0.023, 0.02, frameM);
    link(bike, P.headBot, P.headTop, 0.027, 0.027, frameM);
    for (const sx of [-1, 1]) {
      link(bike, V(sx * 0.035, 0.27, -0.02), V(sx * 0.065, 0.335, -0.408), 0.013, 0.009, frameM);
      link(bike, V(sx * 0.02, 0.79, -0.175), V(sx * 0.065, 0.335, -0.408), 0.011, 0.008, frameM);
      link(bike, V(sx * 0.03, 0.66, 0.445), V(sx * 0.05, 0.335, 0.585), 0.016, 0.01, carbon);
    }
    link(bike, P.seatCluster, V(0, 0.955, -0.205), 0.014, 0.014, carbon);
    const saddle = new THREE.Mesh(limbGeo(0.045, 0.018, 0.2, 12), black);
    place(saddle, V(0, 0.975, -0.31), V(0, 0.965, -0.08), UP);
    saddle.scale.set(1.25, 1, 0.35);
    bike.add(saddle);
    link(bike, P.headTop, P.stem, 0.016, 0.016, carbon);
    // handlebar: tops + hoods/drops on each side
    const tops = tube(0.0125, 0.0125, black); place(tops, V(0.21, 0.855, 0.5), V(-0.21, 0.855, 0.5), V(0, 1, 0)); tops.scale.y = 0.42; bike.add(tops);
    for (const sx of [-1, 1]) {
      const x = sx * 0.21;
      const curve = new THREE.CatmullRomCurve3([V(x, 0.855, 0.5), V(x, 0.87, 0.56), V(x, 0.86, 0.615), V(x, 0.8, 0.625), V(x, 0.75, 0.58), V(x, 0.745, 0.53)]);
      bike.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.0125, 8), black));
      const hood = new THREE.Mesh(limbGeo(0.017, 0.014, 0.06, 10), black);
      place(hood, V(x, 0.865, 0.555), V(x, 0.885, 0.61), V(0, 0, 1)); bike.add(hood);
    }
    const bottle = new THREE.Mesh(G.bottle, std(0xffffff, 0.4));
    bottle.position.set(0, 0.5, 0.17); bottle.rotation.x = 0.85; bike.add(bottle);

    // wheels
    this.wheels = [];
    for (const c of [P.rear, P.front]) {
      const w = new THREE.Group();
      w.position.copy(c);
      const inner = new THREE.Group(); inner.rotation.y = Math.PI / 2; w.add(inner);
      inner.add(new THREE.Mesh(G.tire, rubber));
      const rim = new THREE.Mesh(G.rim, carbon); rim.material.side = THREE.DoubleSide; inner.add(rim);
      inner.add(new THREE.Mesh(G.rimEdge, silver));
      const hub = new THREE.Mesh(G.hub, silver); hub.rotation.x = Math.PI / 2; inner.add(hub);
      for (let i = 0; i < 20; i++) {
        const sp = new THREE.Mesh(G.spoke, silver);
        const ang = (i / 20) * Math.PI * 2;
        sp.position.set(Math.cos(ang) * 0.14, Math.sin(ang) * 0.14, (i % 2 ? 1 : -1) * 0.012);
        sp.rotation.z = ang - Math.PI / 2;
        inner.add(sp);
      }
      bike.add(w);
      this.wheels.push(w);
    }
    carbon.side = THREE.DoubleSide;

    // drivetrain
    const ring = new THREE.Mesh(G.chainring, std(0x2a2a2a, 0.35, 0.6));
    ring.rotation.z = Math.PI / 2; ring.position.set(-0.065, 0.27, 0); bike.add(ring);
    const cassette = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.03, 20), silver);
    cassette.rotation.z = Math.PI / 2; cassette.position.set(-0.05, 0.335, -0.408); bike.add(cassette);
    for (const y of [0.37, 0.165]) link(bike, V(-0.065, 0.27 + (y > 0.3 ? 0.105 : -0.105), 0), V(-0.05, 0.335 + (y > 0.3 ? 0.05 : -0.05), -0.408), 0.004, 0.004, std(0x333333, 0.5, 0.5), 5);
    this.cranks = [];
    for (const sx of [-1, 1]) {
      const crank = new THREE.Group();
      crank.position.set(sx * 0.075, 0.27, 0);
      const arm = tube(0.012, 0.009, silver); arm.rotation.x = Math.PI; arm.scale.y = 0.172; crank.add(arm);
      bike.add(crank);
      const pedal = new THREE.Mesh(G.pedal, black);
      bike.add(pedal);
      this.cranks.push({ crank, pedal, sx });
    }

    // ---------- rider ----------
    const body = new THREE.Group();
    root.add(body);
    this.body = body;
    const pelvisC = V(0, 1.03, -0.17), neck = V(0, 1.32, 0.3);

    // torso (jersey print: u = 0 chest, u = 0.5 back)
    const torso = new THREE.Mesh(torsoGeo(0.5), jersey);
    const tDir = new THREE.Vector3().subVectors(neck, pelvisC).normalize();
    const backN = new THREE.Vector3(0, tDir.z, -tDir.y);
    place(torso, pelvisC, neck, backN.clone().negate(), 0.5);
    torso.scale.set(1.3, pelvisC.distanceTo(neck) / 0.5 * 1.0, 0.86);
    body.add(torso);
    const pelvis = new THREE.Mesh(new THREE.SphereGeometry(0.125, 20, 14), pelvisM);
    pelvis.position.copy(pelvisC).add(V(0, -0.025, -0.01)); pelvis.scale.set(1.22, 0.85, 1.15);
    body.add(pelvis);

    // neck + head (looking up the road)
    const headC = V(0, 1.43, 0.455);
    const neckM = new THREE.Mesh(shapeGeo([[0, 0.056], [1, 0.05]], 0.1, 12), skin);
    place(neckM, neck.clone().add(V(0, -0.02, -0.02)), headC.clone().add(V(0, -0.06, -0.04)), UP, 0.1);
    body.add(neckM);
    const head = new THREE.Mesh(G.head, skin); head.position.copy(headC); head.scale.set(0.9, 1.04, 1.08); body.add(head);
    const jaw = new THREE.Mesh(new THREE.SphereGeometry(0.072, 14, 10), skin);
    jaw.position.copy(headC).add(V(0, -0.05, 0.035)); jaw.scale.set(1, 0.8, 1); body.add(jaw);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.014, 0.04, 8), skin);
    nose.rotation.x = Math.PI / 2; nose.position.copy(headC).add(V(0, -0.012, 0.118)); body.add(nose);
    for (const sx of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 6), skin);
      ear.position.copy(headC).add(V(sx * 0.092, -0.005, -0.005)); ear.scale.set(0.45, 1, 0.75); body.add(ear);
    }
    const hairM = std(a.hairColor, 0.85);
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.104, 18, 10, 0, Math.PI * 2, Math.PI * 0.32, Math.PI * 0.3), hairM);
    hair.position.copy(headC); hair.scale.set(0.92, 1.04, 1.06); hair.rotation.x = -0.9; // short hair below the helmet, at the back
    body.add(hair);
    this._mats.push(hairM);
    if (a.headwear === 'cap') {
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.106, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.42), headM);
      cap.position.copy(headC).add(V(0, 0.012, -0.004)); cap.scale.set(0.93, 1.0, 1.08); cap.rotation.x = 0.15; body.add(cap);
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.068, 0.068, 0.007, 20, 1, false, -Math.PI / 2, Math.PI), kit ? kit.brim : headM);
      brim.position.copy(headC).add(V(0, 0.07, 0.085)); brim.rotation.x = -0.45; brim.scale.set(0.95, 1, 0.55); body.add(brim);
    } else {
      // road helmet: long dome sitting low on the forehead, tail over the back of the head
      const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.115, 26, 14, 0, Math.PI * 2, 0, Math.PI * 0.56), headM);
      helmet.position.copy(headC).add(V(0, 0.008, -0.012)); helmet.scale.set(1.0, 0.98, 1.2); helmet.rotation.x = 0.12;
      body.add(helmet);
      const vents = std(0x111111, 0.6);
      this._mats.push(vents);
      for (const vx of [-0.035, 0, 0.035]) {
        const v = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.006, 0.14), vents);
        v.position.copy(headC).add(V(vx, 0.118 - Math.abs(vx) * 0.7, -0.01)); v.rotation.x = 0.12; body.add(v);
      }
      for (const sx of [-1, 1]) {
        const strap = tube(0.0035, 0.0035, black, 4);
        place(strap, headC.clone().add(V(sx * 0.088, 0.03, -0.005)), headC.clone().add(V(sx * 0.06, -0.085, 0.05)), UP);
        strap.scale.y = 0.13; body.add(strap);
      }
    }
    // wrap-around sunglasses following the face
    const lensM = new THREE.MeshStandardMaterial({ color: 0x1a1d22, roughness: 0.08, metalness: 0.95, side: THREE.DoubleSide, emissive: 0x1b2a3a, emissiveIntensity: 0.25 });
    this._mats.push(lensM);
    const lensG = new THREE.Mesh(new THREE.SphereGeometry(0.106, 24, 3, Math.PI / 2 - 1.05, 2.1, Math.PI * 0.42, Math.PI * 0.1), lensM);
    lensG.position.copy(headC).add(V(0, 0.004, 0.006)); lensG.scale.set(0.97, 1.06, 1.13);
    body.add(lensG);
    if (a.hair === 'ponytail') {
      const pt = new THREE.Mesh(shapeGeo([[0, 0.028], [0.5, 0.03], [1, 0.012]], 0.17, 10), hairM);
      place(pt, headC.clone().add(V(0, -0.01, -0.11)), headC.clone().add(V(0, -0.06, -0.27)), UP, 0.17);
      body.add(pt);
    }

    // arms: elbows bent and slightly out, hands on the hoods
    for (const sx of [-1, 1]) {
      const sh = V(sx * 0.165, 1.285, 0.27);
      const hand = V(sx * 0.2, 0.9, 0.585);
      const elbow = ik(sh, hand, 0.29, 0.29, sh.clone().add(V(sx * 0.5, -0.35, -0.15)));
      const hem = sh.clone().lerp(elbow, 0.55);
      const upper = new THREE.Mesh(shapeGeo([[0, 0.062], [0.6, 0.056], [1, 0.05]], 0.16, 14), sleeveM);
      place(upper, sh.clone().add(V(-sx * 0.02, 0.01, -0.01)), hem, V(0, 0, 1), 0.16); body.add(upper);
      const upperSkin = new THREE.Mesh(shapeGeo([[0, 0.046], [0.5, 0.044], [1, 0.038]], 0.13, 12), skin);
      place(upperSkin, hem, elbow, V(0, 0, 1), 0.13); body.add(upperSkin);
      const fore = new THREE.Mesh(shapeGeo([[0, 0.038], [0.3, 0.044], [1, 0.029]], 0.27, 12), skin);
      place(fore, elbow, hand.clone().add(V(0, 0.015, -0.02)), V(0, 1, 0), 0.27); body.add(fore);
      const glove = new THREE.Mesh(G.hand, black); glove.position.copy(hand).add(V(0, 0.01, 0.01)); glove.scale.set(0.85, 0.8, 1.35); body.add(glove);
    }

    // legs (animated, IK to the pedals)
    this.legs = [];
    const T = 0.45, S = 0.44;
    for (const sx of [-1, 1]) {
      const hip = V(sx * 0.088, 1.0, -0.17);
      const thigh = new THREE.Mesh(shapeGeo([[0, 0.09], [0.35, 0.086], [0.75, 0.07], [1, 0.064]], 1, 16), shortsM);
      const thighSkin = new THREE.Mesh(shapeGeo([[0, 0.06], [1, 0.054]], 1, 12), skin);
      const knee = new THREE.Mesh(new THREE.SphereGeometry(0.052, 12, 10), skin);
      const calf = new THREE.Mesh(shapeGeo([[0, 0.05], [0.25, 0.058], [0.55, 0.046], [1, 0.033]], 1, 14), skin);
      const sock = new THREE.Mesh(shapeGeo([[0, 0.048], [0.5, 0.042], [1, 0.037]], 1, 12), sockM);
      const shoe = new THREE.Mesh(shapeGeo([[0, 0.042], [0.35, 0.05], [0.8, 0.044], [1, 0.026]], 1, 14), shoeM);
      const sole = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.012, 0.26), black);
      body.add(thigh, thighSkin, knee, calf, sock, shoe, sole);
      this.legs.push({ sx, hip, thigh, thighSkin, knee, calf, sock, shoe, sole, T, S });
    }

    this.group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    if (label && labelSprite) { this.label = labelSprite; this.label.position.y = 2.0; this.group.add(this.label); }
    this.crank = Math.random() * Math.PI * 2;
    this._k = new THREE.Vector3(); this._ank = new THREE.Vector3(); this._tmp = new THREE.Vector3();
    this._fd = new THREE.Vector3(); this._a = new THREE.Vector3(); this._b = new THREE.Vector3();
    this.animate(0, 0, 0);
  }

  animate(dt, speed, cadence) {
    for (const w of this.wheels) w.rotation.x += (speed / 0.335) * dt;
    const rpm = cadence > 0 ? cadence : speed > 0.5 ? 85 : 0;
    this.crank += (rpm / 60) * Math.PI * 2 * dt;
    const L = 0.172;
    for (const { crank, pedal, sx } of this.cranks) {
      const c = this.crank + (sx > 0 ? Math.PI : 0);
      crank.rotation.x = c; // arm points down (-Y) when c = 0, rotates forward
      pedal.position.set(sx * 0.115, 0.27 - Math.cos(c) * L, -Math.sin(c) * L);
    }
    for (const leg of this.legs) {
      const c = this.crank + (leg.sx > 0 ? Math.PI : 0);
      const x = leg.sx * 0.1;
      const pedal = this._tmp.set(x, 0.27 - Math.cos(c) * L, -Math.sin(c) * L);
      // foot pitch: toes slightly down, heel drops on the down stroke
      const pitch = -0.18 + 0.16 * Math.sin(c + 0.6);
      const fd = this._fd.set(0, Math.sin(pitch), Math.cos(pitch)); // heel -> toe
      const ankle = this._ank.copy(pedal).addScaledVector(fd, -0.12).add(V(0, 0.085, 0));
      const knee = ik(leg.hip, ankle, leg.T, leg.S, leg.hip.clone().add(V(leg.sx * 0.04, 0.3, 1)), this._k);
      const shortsEnd = this._a.copy(leg.hip).lerp(knee, 0.8);
      place(leg.thigh, leg.hip, shortsEnd, V(0, 1, 0), 1);
      place(leg.thighSkin, shortsEnd, knee, V(0, 1, 0), 1);
      leg.knee.position.copy(knee);
      place(leg.calf, knee, ankle, V(0, 0, 1), 1);
      const sockTop = this._b.copy(knee).lerp(ankle, 0.5);
      place(leg.sock, sockTop, ankle, V(0, 0, 1), 1);
      // road shoe: cleat (pedal) under the ball of the foot
      const heel = pedal.clone().addScaledVector(fd, -0.17).add(V(0, 0.035, 0));
      const toe = pedal.clone().addScaledVector(fd, 0.1).add(V(0, 0.022, 0));
      place(leg.shoe, heel, toe, V(0, 1, 0), 1);
      leg.shoe.scale.set(0.88, heel.distanceTo(toe), 0.72);
      leg.sole.position.copy(heel).lerp(toe, 0.5).add(V(0, -0.028, 0));
      leg.sole.rotation.set(-pitch, 0, 0);
    }
    // subtle upper-body rock with the pedal stroke
    this.body.rotation.z = rpm > 0 ? Math.sin(this.crank) * 0.012 : 0;
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry && !Object.values(G).includes(o.geometry)) o.geometry.dispose();
    });
    for (const m of this._mats) m.dispose();
    if (this.label) { this.label.material.map.dispose(); this.label.material.dispose(); }
  }
}
