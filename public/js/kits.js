import * as THREE from 'three';

// Club kits: textures drawn from the club's kit designs.
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
  t.userData.shared = true;
  return t;
}

// Body gradient: white shoulders -> feathers -> red -> black waist. y=0 is shoulders.
function bodyGradient(g, w, h) {
  const gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, '#ffffff');
  gr.addColorStop(0.28, '#ffffff');
  gr.addColorStop(0.5, RED);
  gr.addColorStop(0.74, RED);
  gr.addColorStop(0.84, '#2a0508');
  gr.addColorStop(0.9, '#050505');
  gr.addColorStop(1, '#050505');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
  // feathers
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 160; i++) {
    const x = rnd() * w, y = h * (0.2 + rnd() * 0.32);
    const len = 26 + rnd() * 30;
    const alpha = 0.25 + rnd() * 0.45;
    const tone = y < h * 0.33 ? `rgba(240,200,205,${alpha})` : `rgba(225,80,95,${alpha})`;
    g.save(); g.translate(x, y); g.rotate((x < w / 2 ? -1 : 1) * (0.25 + rnd() * 0.35));
    g.fillStyle = tone;
    g.beginPath(); g.ellipse(0, len / 2, 6 + rnd() * 4, len / 2, 0, 0, Math.PI * 2); g.fill();
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
  g.textBaseline = 'middle';
  g.fillText(text, 0, 0);
  g.restore();
}

const cache = {};
function textures() {
  if (cache.uect) return cache.uect;
  const back = canvas(256, 512, (g, w, h) => {
    bodyGradient(g, w, h);
    if (images.back) g.drawImage(images.back, 18, 40, 220, 105);
    g.fillStyle = 'rgba(200,16,46,.85)';
    g.font = '600 16px system-ui'; g.textAlign = 'center';
    g.fillText('I N Φ N I', w / 2, h * 0.95);
  });
  const front = canvas(256, 512, (g, w, h) => {
    bodyGradient(g, w, h);
    g.fillStyle = '#111'; g.fillRect(w / 2 - 2, 0, 4, h); // zip
    g.fillStyle = '#111'; g.font = '900 46px Impact, "Arial Black", sans-serif'; g.textAlign = 'left';
    g.fillText('UE', w / 2 + 22, 70); g.fillText('CT', w / 2 + 22, 116);
  });
  const side = canvas(128, 512, bodyGradient);
  const sleeve = canvas(128, 128, (g, w, h) => {
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    g.fillStyle = RED; g.fillRect(0, h * 0.62, w, h * 0.38);
  });
  const shorts = canvas(256, 256, (g, w, h) => {
    g.fillStyle = '#0a0a0a'; g.fillRect(0, 0, w, h);
    verticalText(g, 'UECT', w * 0.22, h * 0.18, 54, '#fff');
    verticalText(g, 'UECT', w * 0.72, h * 0.18, 54, '#fff');
    if (images.eagle) g.drawImage(images.eagle, w * 0.06, h * 0.72, 46, 44);
  });
  const socks = canvas(256, 256, (g, w, h) => {
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    g.fillStyle = RED; g.fillRect(0, h * 0.06, w, h * 0.12);
    verticalText(g, 'UECT', w * 0.3, h * 0.26, 40, '#111');
    verticalText(g, 'UECT', w * 0.8, h * 0.26, 40, '#111');
  });
  const cap = canvas(256, 128, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, '#e0102a'); gr.addColorStop(0.55, '#c8102e'); gr.addColorStop(0.85, '#111'); gr.addColorStop(1, '#050505');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  });
  return (cache.uect = { back, front, side, sleeve, shorts, socks, cap });
}

/** Materials for the given kit, or null. */
export function kitMaterials(kit) {
  if (kit !== 'uect') return null;
  const t = textures();
  const m = (map, opts = {}) => new THREE.MeshStandardMaterial({ map, roughness: 0.6, ...opts });
  const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
  const black = new THREE.MeshStandardMaterial({ color: 0x080808, roughness: 0.6 });
  return {
    // BoxGeometry face order: +x, -x, +y (back, rider leans forward), -y (chest), +z (shoulders), -z (waist)
    torso: [m(t.side), m(t.side), m(t.back), m(t.front), white, black],
    sleeve: m(t.sleeve),
    shorts: m(t.shorts),
    hips: black,
    socks: m(t.socks),
    cap: m(t.cap),
    brim: black,
    helmet: new THREE.MeshStandardMaterial({ color: 0xc8102e, roughness: 0.4 }),
    color: KITS.uect.color,
  };
}
