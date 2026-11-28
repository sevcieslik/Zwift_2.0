// Background warm-up of the LiDAR tile cache along every route, starting at the start line.
// Reading the Welsh LiDAR files is what makes the first visit of a place slow; after this runs,
// riders find everything on the server's disk. Render wipes its disk on every deploy, so this
// simply runs again after each start. Disable with PREWARM=0.
const { fetchTile } = require('./tiles');

const R = 6371008.8, toRad = (d) => (d * Math.PI) / 180;
const tileXY = (lat, lon, z) => { const n = 2 ** z; return [Math.floor(((lon + 180) / 360) * n), Math.floor(((1 - Math.log(Math.tan(toRad(lat)) + 1 / Math.cos(toRad(lat))) / Math.PI) / 2) * n)]; };

// [source, zoom, radius around the route (m)] — the same data the game asks for
const LAYERS = [['lidar', 15, 1600], ['ndsm', 15, 1500], ['ndsm', 17, 20], ['ndsm', 13, 7000], ['elev', 10, 21000]];

function keysFor(route) {
  const kx = toRad(1) * R * Math.cos(toRad(route.origin.lat)), ky = toRad(1) * R;
  const seen = new Set(), list = [];
  const every = Math.max(1, Math.round(100 / route.step));
  // walk the route; for each stretch queue the fine layers first so the start is ready soonest
  for (let i = 0; i < route.x.length; i += every) {
    const lat = route.origin.lat + route.y[i] / ky, lon = route.origin.lon + route.x[i] / kx;
    for (const [src, z, rad] of LAYERS) {
      const step = Math.max(rad / 3, 15);
      for (let dx = -rad; dx <= rad + 1; dx += step) for (let dy = -rad; dy <= rad + 1; dy += step) {
        const [x, y] = tileXY(lat + dy / ky, lon + dx / kx, z);
        const k = `${src}/${z}/${x}/${y}`;
        if (!seen.has(k)) { seen.add(k); list.push([src, z, x, y]); }
      }
    }
  }
  return list;
}

async function prewarm(routes, { concurrency = 3, log = console.log } = {}) {
  for (const route of routes) {
    const list = keysFor(route);
    let done = 0, failed = 0;
    const t0 = Date.now();
    const work = async () => {
      while (list.length) {
        const [src, z, x, y] = list.shift();
        try { await fetchTile(src, z, x, y); } catch { failed++; }
        if (++done % 200 === 0) log(`Rozgrzewanie lidaru (${route.id}): ${done} kafli, ${Math.round((Date.now() - t0) / 1000)} s`);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, work));
    log(`Rozgrzewanie lidaru (${route.id}) gotowe: ${done} kafli${failed ? `, ${failed} poza zasięgiem` : ''}, ${Math.round((Date.now() - t0) / 1000)} s`);
  }
}

module.exports = { prewarm, keysFor };
