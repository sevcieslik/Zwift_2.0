import * as THREE from 'three';

// Club kits: textures drawn from the club's kit designs (UECT – United Eagles Cycling Team).
export const KITS = {
  uect: { name: 'UECT – United Eagles Cycling Team', color: '#c8102e' },
};

const RED = '#c8102e';
const images = {};
function loadImg(key, src) {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => { images[key] = im; resolve(); };
    im.onerror = () => resolve();
    im.src = src;
  });
}
export const kitsReady = Promise.all([
  loadImg('eagle', '/kits/uect-eagle.png'),
  loadImg('back', '/kits/uect-back.png'),
]);

function canvas(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.wrapS = THREE.RepeatWrapping;
  t.userData.shared = true;
  return t;
}

// White shoulders -> feathers -> red -> black waist. Canvas top = shoulders.
function bodyGradient(g, w, h) {
  const gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, '#ffffff');
  gr.addColorStop(0.3, '#ffffff');
  gr.addColorStop(0.52, RED);
  gr.addColorStop(0.74, RED);
  gr.addColorStop(0.84, '#2a0508');
  gr.addColorStop(0.9, '#050505');
  gr.addColorStop(1, '#050505');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < w * 0.6; i++) {
    const x = rnd() * w, y = h * (0.22 + rnd() * 0.32);
    const len = h * (0.05 + rnd() * 0.06);
    const alpha = 0.25 + rnd() * 0.45;
    const tone = y < h * 0.34 ? `rgba(240,200,205,${alpha})` : `rgba(225,80,95,${alpha})`;
    g.save(); g.translate(x, y); g.rotate((rnd() - 0.5) * 0.9);
    g.fillStyle = tone;
    g.beginPath(); g.ellipse(0, len / 2, len * 0.22, len / 2, 0, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(150,20,35,0.35)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, 0); g.lineTo(0, len); g.stroke();
    g.restore();
  }
}

function verticalText(g, text, x, y, size, color) {
  g.save();
  g.translate(x, y); g.rotate(Math.PI / 2);
  g.fillStyle = color;
  g.font = `900 ${size}px Impact, "Arial Black", system-ui, sans-serif`;
  g.textBaseline = 'middle'; g.textAlign = 'center';
  g.fillText(text, 0, 0);
  g.restore();
}

let cache = null;
function textures() {
  if (cache) return cache;
  // Jersey wrapped around the torso: u = 0 chest (zip), u = 0.5 middle of the back.
  const jersey = canvas(1024, 512, (g, w, h) => {
    bodyGradient(g, w, h);
    if (images.back) g.drawImage(images.back, w / 2 - 165, 18, 330, 158);
    g.fillStyle = '#111'; g.fillRect(0, 0, 4, h); g.fillRect(w - 4, 0, 4, h); // zip
    g.font = '900 40px Impact, "Arial Black", sans-serif'; g.textAlign = 'left';
    g.fillText('UE', 26, 120); g.fillText('CT', 26, 160);
    g.fillStyle = 'rgba(200,16,46,.9)'; g.font = '600 18px system-ui'; g.textAlign = 'center';
    g.fillText('I N Φ N I', w / 2, h * 0.95);
  });
  const sleeve = canvas(256, 128, (g, w, h) => {
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    g.fillStyle = RED; g.fillRect(0, 0, w, h * 0.42); // hem (elbow end) at the top
  });
  const thigh = canvas(512, 256, (g, w, h) => {
    g.fillStyle = '#0a0a0a'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#1c1c1c'; g.fillRect(0, 0, w, h * 0.08); // leg gripper
    verticalText(g, 'UECT', w * 0.25, h * 0.45, 64, '#fff');
    verticalText(g, 'UECT', w * 0.75, h * 0.45, 64, '#fff');
    if (images.eagle) { g.drawImage(images.eagle, w * 0.25 - 22, h * 0.78, 44, 42); g.drawImage(images.eagle, w * 0.75 - 22, h * 0.78, 44, 42); }
  });
  const sock = canvas(256, 256, (g, w, h) => {
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    g.fillStyle = RED; g.fillRect(0, h * 0.74, w, h * 0.12); // band near the top of the sock
    verticalText(g, 'UECT', w * 0.25, h * 0.42, 44, '#111');
    verticalText(g, 'UECT', w * 0.75, h * 0.42, 44, '#111');
  });
  const cap = canvas(256, 128, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, '#e0102a'); gr.addColorStop(0.55, '#c8102e'); gr.addColorStop(0.85, '#111'); gr.addColorStop(1, '#050505');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  });
  const helmet = canvas(256, 128, (g, w, h) => {
    g.fillStyle = '#f4f4f4'; g.fillRect(0, 0, w, h);
    g.fillStyle = RED; g.fillRect(0, 0, w, h * 0.35);
    g.fillStyle = '#111'; g.fillRect(0, h * 0.35, w, h * 0.06);
  });
  return (cache = { jersey, sleeve, thigh, sock, cap, helmet });
}

/** Shared materials for the given kit, or null for own colours. */
export function kitMaterials(kit) {
  if (kit !== 'uect') return null;
  const t = textures();
  if (t.mats) return t.mats;
  const m = (map, rough = 0.6) => new THREE.MeshStandardMaterial({ map, roughness: rough });
  t.mats = {
    torso: m(t.jersey),
    sleeve: m(t.sleeve),
    thigh: m(t.thigh),
    hips: new THREE.MeshStandardMaterial({ color: 0x080808, roughness: 0.6 }),
    sock: m(t.sock, 0.8),
    cap: m(t.cap),
    brim: new THREE.MeshStandardMaterial({ color: 0x080808, roughness: 0.5 }),
    helmet: m(t.helmet, 0.35),
    color: KITS.uect.color,
  };
  return t.mats;
}
