#!/usr/bin/env node
// Download the OpenStreetMap vector tiles a route needs into data/vt/ so they ship with the repo:
// no waiting for OpenFreeMap on first ride, nothing lost when Render wipes its disk.
//   npm run bake                 -> all routes in routes/
//   npm run bake -- snowdonia-rally
const fs = require('fs');
const path = require('path');
const { buildRoute } = require('../lib/gpx');
const { getTile, BAKED_DIR } = require('../lib/vectortiles');

const ROUTES = path.join(__dirname, '..', 'routes');
const R = 6371008.8, toRad = (d) => (d * Math.PI) / 180;
const tileXY = (lat, lon, z) => { const n = 2 ** z; return [Math.floor(((lon + 180) / 360) * n), Math.floor(((1 - Math.log(Math.tan(toRad(lat)) + 1 / Math.cos(toRad(lat))) / Math.PI) / 2) * n)]; };
// what the game loads: z14 around the rider (detailed patch 3 km), z11 for the far ring (40 km)
const LEVELS = [[14, 1800], [11, 23000]];

async function bake(id) {
  const file = path.join(ROUTES, id + '.gpx');
  const route = buildRoute(fs.readFileSync(file, 'utf8'), id);
  const kx = toRad(1) * R * Math.cos(toRad(route.origin.lat)), ky = toRad(1) * R;
  const want = new Set();
  for (const [z, rad] of LEVELS) {
    const step = Math.max(1, Math.round(Math.min(rad / 4, 400) / route.step));
    const grid = Math.min(rad / 3, 2000);
    for (let i = 0; i < route.x.length; i += step) {
      const lat = route.origin.lat + route.y[i] / ky, lon = route.origin.lon + route.x[i] / kx;
      for (let dx = -rad; dx <= rad + 1; dx += grid) for (let dy = -rad; dy <= rad + 1; dy += grid) {
        const [x, y] = tileXY(lat + dy / ky, lon + dx / kx, z);
        want.add(`${z}/${x}/${y}`);
      }
    }
  }
  const list = [...want];
  let done = 0, bytes = 0, failed = 0;
  const work = async () => {
    while (list.length) {
      const key = list.pop();
      const [z, x, y] = key.split('/').map(Number);
      const out = path.join(BAKED_DIR, String(z), String(x), `${y}.pbf`);
      try {
        const buf = fs.existsSync(out) ? fs.readFileSync(out) : await getTile(z, x, y, { noBaked: true });
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, buf);
        bytes += buf.length;
      } catch (e) { failed++; console.warn(`  ${key}: ${e.message}`); }
      if (++done % 25 === 0) process.stdout.write(`\r  ${id}: ${done}/${want.size} kafli, ${(bytes / 1e6).toFixed(1)} MB`);
    }
  };
  await Promise.all(Array.from({ length: 6 }, work));
  console.log(`\r  ${id}: ${done}/${want.size} kafli, ${(bytes / 1e6).toFixed(1)} MB${failed ? `, nieudane: ${failed} (uruchom ponownie)` : ''}`);
}

(async () => {
  const ids = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(ROUTES).filter((f) => f.endsWith('.gpx')).map((f) => f.slice(0, -4));
  for (const id of ids) await bake(id);
  console.log(`Gotowe: ${BAKED_DIR}. Dodaj do repo: git add data/vt`);
})();
