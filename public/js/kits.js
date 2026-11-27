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

// Kit design "Koszulka 282 + spodenki 555 na szelkach":
// white shoulders -> white/pink feather points running down into red -> solid red -> black at the waist.
// Canvas top = collar/shoulders.
function bodyGradient(g, w, h, back) {
  const gr = g.createLinearGradient(0, 0, 0, h);
  const d = back ? 0.14 : 0; // the back stays white lower down: room for the club logo
  gr.addColorStop(0, '#ffffff');
  gr.addColorStop(0.24 + d, '#ffffff');
  gr.addColorStop(0.34 + d, '#f3c9cf');
  gr.addColorStop(0.5 + d * 0.8, RED);
  gr.addColorStop(back ? 0.72 : 0.8, RED);
  gr.addColorStop(back ? 0.8 : 0.9, '#3a060c');
  gr.addColorStop(back ? 0.84 : 0.96, '#070707');
  gr.addColorStop(1, '#070707');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
}
// rows of pointed feathers hanging down; the higher rows are white, lower ones pink then red
function feathers(g, x0, x1, h, y0 = 0.2) {
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const rows = 9;
  for (let r = 0; r < rows; r++) {
    const t = r / (rows - 1);
    const y = h * (y0 + t * 0.3);
    const step = 22 + rnd() * 6;
    for (let x = x0 - step * rnd(); x < x1 + step; x += step * (0.7 + rnd() * 0.5)) {
      const len = h * (0.1 + rnd() * 0.08) * (1.1 - t * 0.35), wd = step * (0.45 + rnd() * 0.25);
      const lift = (rnd() - 0.5) * h * 0.03;
      // colour: white near the top, through pink to a lighter red near the bottom
      const c0 = [255, 255, 255], c1 = [240, 150, 160], c2 = [214, 40, 62];
      const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
      const col = t < 0.5 ? mix(c0, c1, t * 2) : mix(c1, c2, (t - 0.5) * 2);
      const a = 0.55 + rnd() * 0.35;
      g.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${a})`;
      g.beginPath();
      g.moveTo(x - wd / 2, y + lift);
      g.quadraticCurveTo(x - wd * 0.35, y + lift + len * 0.6, x + (rnd() - 0.5) * wd * 0.3, y + lift + len);
      g.quadraticCurveTo(x + wd * 0.35, y + lift + len * 0.6, x + wd / 2, y + lift);
      g.closePath(); g.fill();
      g.strokeStyle = `rgba(160,15,35,${0.25 + t * 0.2})`; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, y + lift + 2); g.lineTo(x, y + lift + len * 0.85); g.stroke();
    }
  }
}

function verticalText(g, text, x, y, size, color, weight = 900, spacing = 0) {
  g.save();
  g.translate(x, y); g.rotate(Math.PI / 2);
  g.fillStyle = color;
  g.font = `${weight} ${size}px Impact, "Arial Black", system-ui, sans-serif`;
  if (spacing && 'letterSpacing' in g) g.letterSpacing = spacing + 'px';
  g.textBaseline = 'middle'; g.textAlign = 'center';
  g.fillText(text, 0, 0);
  g.restore();
}

let cache = null;
function textures() {
  if (cache) return cache;
  // Jersey wrapped around the torso: u = 0 / 1 chest (zip), u = 0.5 middle of the back.
  const jersey = canvas(1024, 512, (g, w, h) => {
    // front half and back half differ at the bottom: the back has a black pocket band
    bodyGradient(g, w, h, false);
    const back = document.createElement('canvas'); back.width = w / 2; back.height = h;
    bodyGradient(back.getContext('2d'), w / 2, h, true);
    g.drawImage(back, w / 4, 0);
    const clip = (x0, x1, y0) => { g.save(); g.beginPath(); g.rect(x0, 0, x1 - x0, h); g.clip(); feathers(g, x0 - 40, x1 + 40, h, y0); g.restore(); };
    clip(0, w / 4, 0.2); clip((3 * w) / 4, w, 0.2); clip(w / 4, (3 * w) / 4, 0.33);
    // back: club logo on the white upper back, pockets in the black band
    if (images.back) g.drawImage(images.back, w / 2 - 180, 58, 360, 160);
    g.strokeStyle = 'rgba(70,70,70,0.9)'; g.lineWidth = 2;
    for (const k of [-1, 0, 1]) g.strokeRect(w / 2 + k * 64 - 30, h * 0.845, 60, h * 0.13);
    g.fillStyle = 'rgba(120,120,120,0.9)'; g.font = '600 13px system-ui'; g.textAlign = 'center';
    g.fillText('I N Φ N I', w / 2, h * 0.83);
    // front: black zip, "UE / CT" logo on the chest, small vertical INONI on the other side
    g.fillStyle = '#111'; g.fillRect(0, 0, 3, h); g.fillRect(w - 3, 0, 3, h);
    g.fillStyle = '#111'; g.font = '900 46px Impact, "Arial Black", sans-serif'; g.textAlign = 'center';
    g.fillText('UE', 62, 96); g.fillText('CT', 62, 140);
    verticalText(g, 'I N Φ N I', w - 26, 92, 13, '#333', 600);
  });
  // sleeve: canvas top = cuff (elbow end). White, red band just above the cuff
  const sleeve = canvas(256, 128, (g, w, h) => {
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    g.fillStyle = RED; g.fillRect(0, h * 0.06, w, h * 0.3);
    g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(0, h * 0.06, w, 2);
  });
  // shorts: canvas top = leg hem. Black, red side panels widening towards the hem with "UECT", white gripper
  const thigh = canvas(512, 340, (g, w, h) => { // ~ circumference : length of the shorts leg
    g.fillStyle = '#0b0b0b'; g.fillRect(0, 0, w, h);
    for (const cx of [w * 0.25, w * 0.75]) {
      g.fillStyle = RED;
      g.beginPath();
      g.moveTo(cx - w * 0.11, 0); g.lineTo(cx + w * 0.09, 0);
      g.quadraticCurveTo(cx + w * 0.05, h * 0.6, cx + w * 0.01, h * 0.98);
      g.quadraticCurveTo(cx - w * 0.06, h * 0.5, cx - w * 0.11, 0);
      g.fill();
      verticalText(g, 'UECT', cx - w * 0.025, h * 0.36, 44, '#fff');
    }
    g.fillStyle = '#f4f4f4'; g.fillRect(0, 0, w, h * 0.09); // white leg gripper
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, h * 0.09, w, 2);
  });
  // socks: canvas bottom = top of the sock. White with a red stripe and a thin black line at the cuff
  const sock = canvas(256, 256, (g, w, h) => {
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    g.fillStyle = RED; g.fillRect(0, h * 0.84, w, h * 0.07);
    g.fillStyle = '#111'; g.fillRect(0, h * 0.8, w, h * 0.022);
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
    shoe: new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.35 }),
    sole: new THREE.MeshStandardMaterial({ color: 0xc8102e, roughness: 0.5 }),
    shoulder: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }),
    color: KITS.uect.color,
  };
  return t.mats;
}
