'use strict';
// Map tile proxy with disk cache: elevation (Terrarium PNG) and satellite imagery.
// Players' browsers load tiles from our own server (same origin, cached), not from third parties.

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const SOURCES = {
  elev: {
    url: process.env.ELEV_TILES_URL || 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    maxZ: 15, type: 'image/png',
  },
  sat: {
    url: process.env.SAT_TILES_URL || 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/g/{z}/{y}/{x}.jpg',
    maxZ: 16, type: 'image/jpeg',
  },
};
const CACHE_DIR = process.env.TILE_CACHE_DIR || path.join(os.tmpdir(), process.env.TILE_MOCK === '1' ? 'gpxride-tiles-mock' : 'gpxride-tiles');
const MOCK = process.env.TILE_MOCK === '1';
const lidar = require('./lidar');
SOURCES.lidar = { maxZ: 17, type: 'image/png' };
SOURCES.ndsm = { maxZ: 17, type: 'image/png' }; // object heights above ground (LiDAR DSM - DTM)
const inflight = new Map();

async function fetchTile(src, z, x, y) {
  const s = SOURCES[src];
  const file = path.join(CACHE_DIR, src, String(z), String(x), `${y}`);
  try { return await fs.promises.readFile(file); } catch { /* not cached */ }
  const key = `${src}/${z}/${x}/${y}`;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    let buf;
    if (src === 'lidar') {
      const h = await lidar.lidarHeights(z, x, y).catch(() => null);
      if (!h) { // outside Wales / LiDAR unavailable: global 30 m data instead (not cached as LiDAR)
        if (z > SOURCES.elev.maxZ) throw new Error('no LiDAR here');
        return fetchTile('elev', z, x, y);
      }
      buf = lidar.terrarium(h, null, png);
    } else if (src === 'ndsm' && !MOCK) {
      const h = await lidar.objectHeights(z, x, y).catch(() => null);
      if (!h) throw new Error('no LiDAR DSM here');
      buf = lidar.terrarium(h, null, png);
    } else if (MOCK) buf = mockTile(src, z, x, y);
    else {
      const url = s.url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      try {
        const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'GPXRide/1.0 (club group-ride app)' } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        buf = Buffer.from(await res.arrayBuffer());
      } finally { clearTimeout(timer); }
    }
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, buf).catch(() => {});
    return buf;
  })();
  inflight.set(key, p);
  try { return await p; } finally { inflight.delete(key); }
}

function handler(req, res) {
  const { src } = req.params;
  const z = Number(req.params.z), x = Number(req.params.x), y = Number(req.params.y);
  const s = SOURCES[src];
  if (!s || ![z, x, y].every(Number.isInteger) || z < 0 || z > s.maxZ || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
    return res.status(400).send('bad tile');
  }
  fetchTile(src, z, x, y)
    .then((buf) => {
      res.set('Cache-Control', 'public, max-age=2592000, immutable');
      res.type(MOCK || src !== 'sat' ? 'image/png' : s.type).send(buf);
    })
    .catch((e) => res.status(502).send('tile unavailable: ' + e.message));
}

// ---------- Synthetic tiles for offline development (TILE_MOCK=1) ----------
function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let yy = 0; yy < height; yy++) {
    raw[yy * (width * 4 + 1)] = 0;
    rgba.copy(raw, yy * (width * 4 + 1) + 1, yy * width * 4, (yy + 1) * width * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
let mockRoute = null; // { grid: Map(cell -> [lat, lon, ele][]) }
function setMockRoutes(routes) {
  const grid = new Map();
  for (const pts of routes) for (let i = 0; i < pts.length; i += 3) {
    const p = pts[i];
    const k = `${Math.floor(p.lat / 0.01)},${Math.floor(p.lon / 0.01)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(p);
  }
  mockRoute = { grid };
}
function nearestRoute(lat, lon) {
  if (!mockRoute) return null;
  const ci = Math.floor(lat / 0.01), cj = Math.floor(lon / 0.01);
  let best = Infinity, ele = 0;
  for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) {
    const arr = mockRoute.grid.get(`${ci + a},${cj + b}`);
    if (!arr) continue;
    for (const p of arr) {
      const d = ((p.lat - lat) * 111000) ** 2 + ((p.lon - lon) * 67000) ** 2;
      if (d < best) { best = d; ele = p.ele; }
    }
  }
  return best < Infinity ? [Math.sqrt(best), ele] : null;
}
function mockHeight(lat, lon) {
  // Valleys follow the GPX route (with a few metres of error, like real data); mountains rise away from it.
  const peaks = [[53.068, -4.076, 1085, 0.025], [53.12, -3.98, 900, 0.04], [53.0, -4.2, 600, 0.05], [53.15, -4.05, 500, 0.035]];
  const nr = nearestRoute(lat, lon);
  const base = nr ? nr[1] + 6 * Math.sin(lat * 700) : 150;
  const d = nr ? nr[0] : 3000;
  const k = Math.min(1, d / 1500);
  let h = base + k * (180 * (0.5 + 0.5 * Math.sin(lat * 260) * Math.cos(lon * 170)) + 30 * Math.sin(lat * 1300 + lon * 900));
  for (const [la, lo, hh, r] of peaks) {
    const d2 = ((lat - la) / r) ** 2 + ((lon - lo) / (r * 1.6)) ** 2;
    h += hh * Math.exp(-d2) * Math.min(1, d / 800);
  }
  return h;
}
function mockTile(src, z, x, y) {
  const N = 256, buf = Buffer.alloc(N * N * 4);
  for (let j = 0; j < N; j++) {
    const ty = y + (j + 0.5) / N;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / 2 ** z))) * 180) / Math.PI;
    for (let i = 0; i < N; i++) {
      const lon = ((x + (i + 0.5) / N) / 2 ** z) * 360 - 180;
      const h = mockHeight(lat, lon);
      const o = (j * N + i) * 4;
      if (src === 'ndsm') { // fake trees, hedges and walls for offline testing
        const nr = nearestRoute(lat, lon), d = nr ? nr[0] : 1e9;
        let v = 0;
        const along = Math.sin(lat * 9000) + Math.cos(lon * 7000);
        if (Math.abs(d - 4.5) < 0.9) v = along > -0.4 ? (along > 0.6 ? 1.1 : 1.9) : 0; // walls / hedges / gaps
        const f = Math.sin(lat * 2600) * Math.cos(lon * 1700) + 0.4 * Math.sin(lat * 9100 + lon * 6100);
        const crown = Math.max(0, Math.cos(lat * 111000 / 6 * 6.28) * Math.cos(lon * 67000 / 6 * 6.28));
        if (d > 9 && f > 0.55) v = Math.max(v, 6 + crown * 10);
        else if (d > 9 && ((Math.floor(lat * 111000 / 40) * 31 + Math.floor(lon * 67000 / 40) * 17) % 23) === 0) v = Math.max(v, crown * 12);
        v = Math.max(0, v + 32768);
        buf[o] = Math.floor(v / 256); buf[o + 1] = Math.floor(v % 256); buf[o + 2] = Math.floor((v % 1) * 256); buf[o + 3] = 255;
      } else if (src === 'elev') {
        const v = Math.max(0, h + 32768);
        buf[o] = Math.floor(v / 256); buf[o + 1] = Math.floor(v % 256); buf[o + 2] = Math.floor((v % 1) * 256); buf[o + 3] = 255;
      } else {
        const n = Math.sin(lat * 3000) * Math.cos(lon * 2100) + Math.sin(lat * 7100 + lon * 5300) * 0.5;
        let c;
        if (h < 0) c = [30, 50, 70];
        else if (h > 650) c = [120 + n * 15, 115 + n * 15, 100 + n * 10];
        else if (n > 0.7) c = [40, 70, 35];
        else c = [90 + h * 0.06 + n * 12, 125 - h * 0.02 + n * 12, 60 + n * 8];
        buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; buf[o + 3] = 255;
      }
    }
  }
  return png(N, N, buf);
}

module.exports = { tileHandler: handler, fetchTile, MOCK, setMockRoutes, lidarEnabled: lidar.lidarEnabled };
