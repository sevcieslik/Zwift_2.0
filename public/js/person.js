import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

// Rigged characters from "Low Poly People" by David Jalbert (CC BY 4.0), dressed as cyclists and posed on the bike.
// At load time the mesh is adapted: longer legs and arms (the pack has cartoon proportions), smaller head,
// clothes replaced by a cycling kit (new UVs so jersey prints work), skin and hair recoloured.

export const BODIES = [
  ['classic', 'Klasyczny (gładki, bez twarzy)'],
  ['normal-man-a', 'Mężczyzna szczupły A'], ['normal-man-b', 'Mężczyzna szczupły B'], ['normal-man-c', 'Mężczyzna szczupły C'],
  ['strong-man-a', 'Mężczyzna wysportowany A'], ['strong-man-b', 'Mężczyzna wysportowany B'], ['strong-man-c', 'Mężczyzna wysportowany C'],
  ['fat-man-a', 'Mężczyzna masywny A'], ['fat-man-b', 'Mężczyzna masywny B'], ['fat-man-c', 'Mężczyzna masywny C'],
  ['normal-woman-a', 'Kobieta szczupła A'], ['normal-woman-b', 'Kobieta szczupła B'], ['normal-woman-c', 'Kobieta szczupła C'],
  ['strong-woman-a', 'Kobieta wysportowana A'], ['strong-woman-b', 'Kobieta wysportowana B'], ['strong-woman-c', 'Kobieta wysportowana C'],
  ['fat-woman-a', 'Kobieta masywna A'], ['fat-woman-b', 'Kobieta masywna B'], ['fat-woman-c', 'Kobieta masywna C'],
];

// Regions = material slots (geometry groups)
const R = { SKIN: 0, JERSEY: 1, SLEEVE: 2, THIGH: 3, HIPS: 4, SOCK: 5, SHOE: 6, SOLE: 7, GLOVE: 8, HAIR: 9, FACE: 10 };
const NREG = 11;

const cache = new Map(); // name -> Promise<base>
const ready = new Map(); // name -> base (once loaded)
const loader = new GLTFLoader();
export const DEFAULT_BODY = 'normal-man-a';

export function loadBody(name) {
  if (name === 'classic') return Promise.resolve(null);
  if (!BODIES.some(([n]) => n === name)) name = DEFAULT_BODY;
  if (!cache.has(name)) {
    cache.set(name, loader.loadAsync(`/models/people/${name}.glb`)
      .then((g) => { const b = prepare(g.scene); ready.set(name, b); return b; })
      .catch((e) => { console.warn('Model', name, e); return null; }));
  }
  return cache.get(name);
}
/** The prepared body if it has finished loading, else null. */
export function bodyReady(name) { if (name === 'classic') return null; return ready.get(BODIES.some(([n]) => n === name) ? name : DEFAULT_BODY) || null; }
export const preloadBodies = (names = BODIES.map(([n]) => n).filter((n) => n !== 'classic')) => Promise.all(names.map(loadBody));

function paletteData(tex) {
  const img = tex && tex.image;
  if (!img) return null;
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  return (u, v) => {
    const x = Math.min(c.width - 1, Math.max(0, Math.floor(u * c.width)));
    const y = Math.min(c.height - 1, Math.max(0, Math.floor(v * c.height))); // glTF uv: v=0 top
    const i = (y * c.width + x) * 4;
    return [d[i], d[i + 1], d[i + 2]];
  };
}
const cdist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function prepare(scene) {
  let mesh = null;
  scene.traverse((o) => { if (o.isSkinnedMesh && !mesh) mesh = o; });
  if (!mesh) return null;
  scene.updateMatrixWorld(true);
  const bones = mesh.skeleton.bones;
  const B = Object.fromEntries(bones.map((b) => [b.name.replace(/\./g, ''), b]));
  const wp = (b) => new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
  const J = {};
  for (const k of ['Stomach', 'Chest', 'Head', 'UpperArmL', 'LowerArmL', 'HandL', 'FingersL', 'UpperArmR', 'LowerArmR', 'HandR', 'FingersR', 'UpperLegL', 'LowerLegL', 'FootL', 'UpperLegR', 'LowerLegR', 'FootR']) J[k] = wp(B[k]);

  // ---- geometry: non-indexed copy so every triangle can get its own region / UVs ----
  const src = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
  const pos = src.attributes.position, uv = src.attributes.uv, si = src.attributes.skinIndex, sw = src.attributes.skinWeight, nrm = src.attributes.normal;
  const nV = pos.count, nT = nV / 3;
  const pal = paletteData(mesh.material.map);
  const boneName = (i) => bones[i].name.replace(/\./g, '');
  const domBone = (v) => {
    let best = 0, bi = 0;
    for (let k = 0; k < 4; k++) { const w = sw.getComponent(v, k); if (w > best) { best = w; bi = si.getComponent(v, k); } }
    return boneName(bi);
  };

  const hipY = J.UpperLegL.y, kneeY = J.LowerLegL.y, ankleY = J.FootL.y;
  const shX = J.UpperArmL.x, elbX = J.LowerArmL.x, wrX = J.HandL.x;
  const waistY = J.Stomach.y + (J.Chest.y - J.Stomach.y) * 0.25;
  const shoulderY = J.UpperArmL.y + 0.1;

  // reference colours from the palette: skin (lower arms) and hair (head, non-skin, most common)
  const triColor = (t) => { if (!pal) return [0, 0, 0]; let u = 0, v = 0; for (let k = 0; k < 3; k++) { u += uv.getX(t * 3 + k); v += uv.getY(t * 3 + k); } return pal(u / 3, v / 3); };
  const triBone = (t) => { const cnt = {}; for (let k = 0; k < 3; k++) { const b = domBone(t * 3 + k); cnt[b] = (cnt[b] || 0) + 1; } return Object.entries(cnt).sort((a, b) => b[1] - a[1])[0][0]; };
  const freq = (filter) => {
    const m = new Map();
    for (let t = 0; t < nT; t++) if (filter(t)) { const c = triColor(t).join(','); m.set(c, (m.get(c) || 0) + 1); }
    const top = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    return top ? top[0].split(',').map(Number) : [200, 160, 120];
  };
  const skinRef = freq((t) => /LowerArm/.test(triBone(t)));
  const hairRef = freq((t) => triBone(t) === 'Head' && cdist(triColor(t), skinRef) > 30 && Math.max(...triColor(t)) < 200);

  const region = new Uint8Array(nT);
  const newUV = new Float32Array(nV * 2);
  const ang = (a, b) => ((Math.atan2(a, b) / (Math.PI * 2)) + 1) % 1;
  for (let t = 0; t < nT; t++) {
    const b = triBone(t);
    let cy = 0, cx = 0;
    for (let k = 0; k < 3; k++) { cy += pos.getY(t * 3 + k); cx += pos.getX(t * 3 + k); }
    cy /= 3; cx /= 3;
    const ax = Math.abs(cx);
    let r;
    if (b === 'Head') {
      const c = triColor(t);
      r = cdist(c, skinRef) < 28 ? R.SKIN : cdist(c, hairRef) < 40 ? R.HAIR : R.FACE;
    } else if (/Hand|Fingers/.test(b)) r = R.GLOVE;
    else if (/LowerArm/.test(b)) r = R.SKIN;
    else if (/UpperArm/.test(b)) r = (ax - shX) / (elbX - shX) < 0.55 ? R.SLEEVE : R.SKIN;
    else if (/Shoulder|Chest/.test(b)) r = R.JERSEY;
    else if (b === 'Stomach') r = cy > waistY ? R.JERSEY : R.HIPS;
    else if (/Hip/.test(b)) r = R.HIPS;
    else if (/UpperLeg/.test(b)) r = (hipY - cy) / (hipY - kneeY) < 0.8 ? R.THIGH : R.SKIN;
    else if (/LowerLeg/.test(b)) r = (kneeY - cy) / (kneeY - ankleY) < 0.45 ? R.SKIN : R.SOCK;
    else if (/Foot/.test(b)) r = cy < J.FootL.y * 0.25 ? R.SOLE : R.SHOE;
    else r = R.SKIN;
    region[t] = r;
    // UVs for printed garments (bind pose = T-pose, facing +Z)
    for (let k = 0; k < 3; k++) {
      const v = t * 3 + k, x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
      let U = uv.getX(v), Vv = uv.getY(v);
      // kit textures are canvas textures (flipY): v = 1 is the top of the canvas
      if (r === R.JERSEY) { U = ang(x, z); Vv = Math.min(1, Math.max(0, (y - waistY) / (shoulderY - waistY))); } // top = shoulders
      else if (r === R.SLEEVE) { U = ang(y - J.UpperArmL.y, z); Vv = Math.min(1, Math.max(0, (Math.abs(x) - shX) / ((elbX - shX) * 0.55))); } // top = hem
      else if (r === R.THIGH) { const c = Math.sign(x) * Math.abs(J.UpperLegL.x); U = ang(x - c, z); Vv = Math.min(1, Math.max(0, (hipY - y) / ((hipY - kneeY) * 0.8))); } // top = leg gripper
      else if (r === R.SOCK) { const c = Math.sign(x) * Math.abs(J.LowerLegL.x); U = ang(x - c, z); Vv = Math.min(1, Math.max(0, ((kneeY - y) / (kneeY - ankleY) - 0.45) / 0.55)); } // 0 = top of the sock
      newUV[v * 2] = U; newUV[v * 2 + 1] = Vv;
    }
  }

  // ---- proportions: stretch legs and arms in the bind pose ----
  const fT = 1.55, fS = 1.75, fU = 1.1, fF = 1.3;
  const nKnee = hipY - (hipY - kneeY) * fT, nAnkle = nKnee - (kneeY - ankleY) * fS;
  const nElb = shX + (elbX - shX) * fU, nWr = nElb + (wrX - elbX) * fF;
  const P = new Float32Array(nV * 3);
  for (let v = 0; v < nV; v++) {
    let x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
    const b = domBone(v);
    if (y < hipY && /Leg|Foot|Hip/.test(b)) {
      if (y >= kneeY) y = hipY - (hipY - y) * fT;
      else if (y >= ankleY) y = nKnee - (kneeY - y) * fS;
      else y = y + (nAnkle - ankleY);
    }
    const ax = Math.abs(x);
    if (ax > shX && /Arm|Hand|Fingers/.test(b)) {
      let nx;
      if (ax <= elbX) nx = shX + (ax - shX) * fU;
      else if (ax <= wrX) nx = nElb + (ax - elbX) * fF;
      else nx = ax + (nWr - wrX);
      x = Math.sign(x) * nx;
    }
    P[v * 3] = x; P[v * 3 + 1] = y; P[v * 3 + 2] = z;
  }

  // sort triangles by region -> groups
  const order = [...Array(nT).keys()].sort((a, b) => region[a] - region[b]);
  const out = new THREE.BufferGeometry();
  const mk = (n) => new Float32Array(nV * n);
  const P2 = mk(3), N2 = mk(3), U2 = mk(2), W2 = mk(4), I2 = new Uint16Array(nV * 4);
  order.forEach((t, i) => {
    for (let k = 0; k < 3; k++) {
      const s = t * 3 + k, d = i * 3 + k;
      P2.set(P.subarray(s * 3, s * 3 + 3), d * 3);
      N2.set([nrm.getX(s), nrm.getY(s), nrm.getZ(s)], d * 3);
      U2.set(newUV.subarray(s * 2, s * 2 + 2), d * 2);
      for (let c = 0; c < 4; c++) { W2[d * 4 + c] = sw.getComponent(s, c); I2[d * 4 + c] = si.getComponent(s, c); }
    }
  });
  out.setAttribute('position', new THREE.BufferAttribute(P2, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(N2, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(U2, 2));
  out.setAttribute('skinIndex', new THREE.BufferAttribute(I2, 4));
  out.setAttribute('skinWeight', new THREE.BufferAttribute(W2, 4));
  let start = 0;
  for (let r = 0; r < NREG; r++) {
    let n = 0; for (const t of order) if (region[t] === r) n++;
    if (n) out.addGroup(start * 3, n * 3, r);
    start += n;
  }
  mesh.geometry = out; // keep the artist's normals

  // move the bones to the stretched joints, rebind
  const setW = (b, p) => { b.parent.updateMatrixWorld(true); b.position.copy(b.parent.worldToLocal(p.clone())); b.updateMatrixWorld(true); };
  for (const s of ['L', 'R']) {
    const sg = s === 'L' ? Math.sign(J.UpperLegL.x) || 1 : Math.sign(J.UpperLegR.x) || -1;
    setW(B['LowerLeg' + s], new THREE.Vector3(J['LowerLeg' + s].x, nKnee, J['LowerLeg' + s].z));
    setW(B['Foot' + s], new THREE.Vector3(J['Foot' + s].x, nAnkle, J['Foot' + s].z));
    const as = Math.sign(J['UpperArm' + s].x);
    setW(B['LowerArm' + s], new THREE.Vector3(as * nElb, J['LowerArm' + s].y, J['LowerArm' + s].z));
    setW(B['Hand' + s], new THREE.Vector3(as * nWr, J['Hand' + s].y, J['Hand' + s].z));
    setW(B['Fingers' + s], new THREE.Vector3(as * (Math.abs(J['Fingers' + s].x) + (nWr - wrX)), J['Fingers' + s].y, J['Fingers' + s].z));
    void sg;
  }
  scene.updateMatrixWorld(true);
  mesh.bind(mesh.skeleton);

  // measurements (bind, model units) used for posing
  const foot = { minY: Infinity, maxZ: -Infinity };
  for (let v = 0; v < nV; v++) if (/Foot/.test(domBone(v))) { foot.minY = Math.min(foot.minY, P[v * 3 + 1]); foot.maxZ = Math.max(foot.maxZ, P[v * 3 + 2]); }
  let head = new THREE.Box3();
  for (let v = 0; v < nV; v++) if (domBone(v) === 'Head') head.expandByPoint(new THREE.Vector3(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]));
  const m = {
    thigh: hipY - nKnee, shin: nKnee - nAnkle,
    upper: nElb - shX, fore: nWr - nElb,
    ankleToSole: nAnkle - foot.minY, toeZ: foot.maxZ - J.FootL.z,
    headBox: head, headBone: J.Head.clone(), stomach: J.Stomach.clone(), chest: J.Chest.clone(),
  };
  const palMat = mesh.material;
  palMat.map.colorSpace = THREE.SRGBColorSpace;
  return { scene, mesh, m, palMat, skinRef, hairRef };
}

// ---------------- posing ----------------
const _o = new THREE.Vector3(), _t = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();
const _q = new THREE.Quaternion(), _bq = new THREE.Quaternion(), _pq = new THREE.Quaternion();

function aim(bone, tipLocal, target) {
  bone.updateWorldMatrix(true, false);
  _o.setFromMatrixPosition(bone.matrixWorld);
  _t.copy(tipLocal).applyMatrix4(bone.matrixWorld);
  _a.subVectors(_t, _o).normalize();
  _b.subVectors(target, _o).normalize();
  _q.setFromUnitVectors(_a, _b);
  bone.getWorldQuaternion(_bq).premultiply(_q);
  bone.parent.getWorldQuaternion(_pq).invert();
  bone.quaternion.copy(_pq.multiply(_bq));
}

/**
 * A dressed, posable character instance.
 */
export class Person {
  constructor(base, mats) {
    this.root = cloneSkinned(base.scene);
    this.m = base.m;
    this.root.traverse((o) => {
      if (o.isSkinnedMesh) {
        this.mesh = o;
        o.material = mats;
        o.castShadow = true;
        o.frustumCulled = false;
      }
    });
    const bones = this.mesh.skeleton.bones;
    this.B = Object.fromEntries(bones.map((b) => [b.name.replace(/\./g, ''), b]));
    this.bind = new Map(bones.map((b) => [b, b.quaternion.clone()]));
    // tip offsets (child joint in each bone's local frame, bind pose)
    this.root.updateMatrixWorld(true);
    const tip = (b, c) => b.worldToLocal(new THREE.Vector3().setFromMatrixPosition(c.matrixWorld));
    const B = this.B;
    this.tips = {
      Stomach: tip(B.Stomach, B.Chest), Chest: tip(B.Chest, B.Head),
      UpperArmL: tip(B.UpperArmL, B.LowerArmL), LowerArmL: tip(B.LowerArmL, B.HandL), HandL: tip(B.HandL, B.FingersL),
      UpperArmR: tip(B.UpperArmR, B.LowerArmR), LowerArmR: tip(B.LowerArmR, B.HandR), HandR: tip(B.HandR, B.FingersR),
      UpperLegL: tip(B.UpperLegL, B.LowerLegL), LowerLegL: tip(B.LowerLegL, B.FootL),
      UpperLegR: tip(B.UpperLegR, B.LowerLegR), LowerLegR: tip(B.LowerLegR, B.FootR),
      FootL: B.FootL.worldToLocal(new THREE.Vector3().setFromMatrixPosition(B.FootL.matrixWorld).add(new THREE.Vector3(0, 0, this.m.toeZ))),
      FootR: B.FootR.worldToLocal(new THREE.Vector3().setFromMatrixPosition(B.FootR.matrixWorld).add(new THREE.Vector3(0, 0, this.m.toeZ))),
    };
  }
  reset() { for (const [b, q] of this.bind) b.quaternion.copy(q); }
  bonePos(name, out) { return out.setFromMatrixPosition(this.B[name].matrixWorld); }
  aim(name, target) { aim(this.B[name], this.tips[name], target); }
  /** Orient a bone in world space (e.g. keep the head looking up the road). */
  setWorldQuat(name, q) {
    const b = this.B[name];
    b.parent.updateWorldMatrix(true, false);
    b.parent.getWorldQuaternion(_pq).invert();
    b.quaternion.copy(_pq.multiply(q));
  }
}

/** Material slots for a rider, matching the region order above. */
export function personMaterials(base, a, kit, std) {
  const skin = std(a.skin, 0.75);
  const hair = std(a.hairColor, 0.85);
  const face = base.palMat;
  const m = [];
  m[R.SKIN] = skin;
  m[R.JERSEY] = kit ? kit.torso : std(a.jersey, 0.6);
  m[R.SLEEVE] = kit ? kit.sleeve : std(a.jersey, 0.6);
  m[R.THIGH] = kit ? kit.thigh : std(a.shorts, 0.6);
  m[R.HIPS] = kit ? kit.hips : std(a.shorts, 0.6);
  m[R.SOCK] = kit ? kit.sock : std(a.socks, 0.8);
  m[R.SHOE] = std(0xf4f4f4, 0.4);
  m[R.SOLE] = std(0x161616, 0.6);
  m[R.GLOVE] = std(0x1a1a1a, 0.6);
  m[R.HAIR] = hair;
  m[R.FACE] = face;
  const own = m.filter((x, i) => x && x !== face && !(kit && [R.JERSEY, R.SLEEVE, R.THIGH, R.HIPS, R.SOCK].includes(i)));
  return { mats: m, own };
}
