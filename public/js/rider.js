import * as THREE from 'three';
import { kitMaterials } from './kits.js';

// Detailed low-poly cyclist on a road bike. Units: metres. Forward = +Z, up = +Y, +X = rider's left.
// Legs are driven by 2-bone IK so the feet stay on the pedals.

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);
const _m = new THREE.Matrix4(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();

/** Tapered capsule along +Y from 0 to len (caps extend beyond), u=0 faces +Z. */
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
    const pelvisC = V(0, 1.06, -0.15), neck = V(0, 1.38, 0.29);
    const torso = new THREE.Mesh(torsoGeo(0.5), jersey);
    // local -Z (u = 0.5, the back of the jersey texture) must face up/back
    const tDir = new THREE.Vector3().subVectors(neck, pelvisC).normalize();
    const backN = new THREE.Vector3(0, tDir.z, -tDir.y); // perpendicular, pointing up-back
    place(torso, pelvisC, neck, backN.clone().negate(), 0.5);
    torso.scale.set(1.22, pelvisC.distanceTo(neck) / 0.5 * 0.97, 0.82);
    body.add(torso);
    const pelvis = new THREE.Mesh(new THREE.SphereGeometry(0.13, 18, 12), pelvisM);
    pelvis.position.copy(pelvisC).add(V(0, -0.02, -0.01)); pelvis.scale.set(1.15, 0.8, 1.05);
    body.add(pelvis);

    // head
    const headC = V(0, 1.5, 0.405);
    link(body, neck, V(0, 1.45, 0.38), 0.05, 0.048, skin, 10);
    const head = new THREE.Mesh(G.head, skin); head.position.copy(headC); head.scale.set(0.95, 1.05, 1.1); body.add(head);
    if (a.headwear === 'cap') {
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.106, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.42), headM);
      cap.position.copy(headC).add(V(0, 0.012, -0.005)); cap.rotation.x = -0.35; body.add(cap);
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.008, 18, 1, false, -Math.PI / 2, Math.PI), kit ? kit.brim : headM);
      brim.position.copy(headC).add(V(0, 0.075, 0.075)); brim.rotation.x = 0.35; brim.scale.set(1, 1, 0.7); body.add(brim);
    } else {
      const helmet = new THREE.Mesh(G.helmet, headM);
      helmet.position.copy(headC).add(V(0, 0.02, -0.025)); helmet.scale.set(0.95, 0.85, 1.3); helmet.rotation.x = -0.35;
      body.add(helmet);
      for (const sx of [-1, 1]) {
        const strap = tube(0.004, 0.004, black, 4); place(strap, headC.clone().add(V(sx * 0.095, 0.02, 0)), headC.clone().add(V(sx * 0.07, -0.09, 0.05)), UP); strap.scale.y = 0.12; body.add(strap);
      }
    }
    const glasses = new THREE.Mesh(G.glasses, lens);
    glasses.rotation.x = Math.PI / 2; // arc lies in the XZ plane, from +X towards +Z
    const glassesG = new THREE.Group();
    glassesG.position.copy(headC).add(V(0, 0.012, 0));
    glassesG.rotation.y = -Math.PI * 0.125; // centre the arc on the face (+Z)
    glassesG.scale.set(0.98, 1, 1.12);
    glassesG.add(glasses);
    body.add(glassesG);
    if (a.hair === 'ponytail') {
      const pt = new THREE.Mesh(limbGeo(0.03, 0.015, 0.16, 8), std(a.hairColor, 0.8));
      place(pt, headC.clone().add(V(0, -0.02, -0.1)), headC.clone().add(V(0, -0.1, -0.24)), UP);
      body.add(pt);
    }

    // arms (static IK: hands on the hoods)
    for (const sx of [-1, 1]) {
      const sh = V(sx * 0.18, 1.355, 0.26);
      const hand = V(sx * 0.2, 0.895, 0.58);
      const elbow = ik(sh, hand, 0.3, 0.3, sh.clone().add(V(sx * 0.35, -0.25, -0.05)));
      const shoulderBall = new THREE.Mesh(new THREE.SphereGeometry(0.062, 12, 10), sleeveM);
      shoulderBall.position.copy(sh); body.add(shoulderBall);
      const hem = sh.clone().lerp(elbow, 0.62);
      const upper = new THREE.Mesh(limbGeo(0.058, 0.05, 0.18), sleeveM);
      place(upper, sh, hem, V(0, 0, 1), 0.18); body.add(upper);
      const upperSkin = new THREE.Mesh(limbGeo(0.045, 0.042, 0.12), skin);
      place(upperSkin, hem, elbow, V(0, 0, 1), 0.12); body.add(upperSkin);
      const fore = new THREE.Mesh(limbGeo(0.046, 0.035, 0.3), skin);
      place(fore, elbow, hand, V(0, 1, 0), 0.3); body.add(fore);
      const glove = new THREE.Mesh(G.hand, black); glove.position.copy(hand); glove.scale.set(0.8, 0.9, 1.3); body.add(glove);
    }

    // legs (animated)
    this.legs = [];
    const T = 0.445, S = 0.44;
    for (const sx of [-1, 1]) {
      const hip = V(sx * 0.09, 1.04, -0.185);
      const thigh = new THREE.Mesh(limbGeo(0.082, 0.056, T, 16), shortsM);
      const knee = new THREE.Mesh(new THREE.SphereGeometry(0.054, 10, 8), skin);
      const shin = new THREE.Mesh(limbGeo(0.052, 0.036, S, 14), skin);
      const sock = new THREE.Mesh(limbGeo(0.04, 0.042, 0.14, 12), sockM);
      const shoe = new THREE.Mesh(limbGeo(0.042, 0.037, 0.19, 12), shoeM);
      shoe.scale.set(1.05, 1, 0.8);
      body.add(thigh, knee, shin, sock, shoe);
      this.legs.push({ sx, hip, thigh, knee, shin, sock, shoe, T, S });
    }

    this.group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    if (label && labelSprite) { this.label = labelSprite; this.label.position.y = 2.1; this.group.add(this.label); }
    this.crank = Math.random() * Math.PI * 2;
    this._k = new THREE.Vector3(); this._ank = new THREE.Vector3(); this._tmp = new THREE.Vector3();
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
      const pedal = this._tmp.set(leg.sx * 0.1, 0.27 - Math.cos(c) * L, -Math.sin(c) * L);
      const footAng = -0.22 + 0.2 * Math.sin(c + 0.6); // heel drop through the stroke
      const ankle = this._ank.set(leg.sx * 0.1, pedal.y + 0.07 * Math.cos(footAng) + 0.02, pedal.z - 0.07 * Math.cos(footAng) + 0.02);
      const knee = ik(leg.hip, ankle, leg.T, leg.S, leg.hip.clone().add(V(leg.sx * 0.03, 0.25, 1)), this._k);
      place(leg.thigh, leg.hip, knee, V(0, 1, 0), leg.T);
      leg.knee.position.copy(knee);
      place(leg.shin, knee, ankle, V(0, 0, 1), leg.S);
      place(leg.sock, ankle.clone().lerp(knee, 0.33), ankle, V(0, 0, 1), ankle.distanceTo(ankle.clone().lerp(knee, 0.33)));
      const heel = V(leg.sx * 0.1, ankle.y - 0.045, ankle.z - 0.045);
      const toe = V(leg.sx * 0.1, pedal.y + Math.sin(footAng) * 0.12 + 0.01, pedal.z + Math.cos(footAng) * 0.11);
      place(leg.shoe, heel, toe, V(0, 1, 0), 0.19);
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
