// Proxy + disk cache for OpenStreetMap vector tiles (OpenMapTiles schema) from OpenFreeMap.
// Free, no API key. Attribution: "OpenFreeMap © OpenMapTiles Data from OpenStreetMap".
const fs = require('fs');
const path = require('path');
const os = require('os');

const TILEJSON = process.env.VT_TILEJSON || 'https://tiles.openfreemap.org/planet';
const CACHE_DIR = path.join(process.env.TILE_CACHE_DIR || path.join(os.tmpdir(), 'gpxride-tiles'), 'vt');
const MAX_Z = 14;
// tiles baked into the repository (npm run bake): served first, no download at all
const BAKED_DIR = path.join(__dirname, '..', 'data', 'vt');

let template = null, templateAt = 0;
async function tileUrl(z, x, y) {
  if (!template || Date.now() - templateAt > 24 * 3600 * 1000) {
    const res = await fetch(TILEJSON, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('tilejson HTTP ' + res.status);
    const j = await res.json();
    template = j.tiles[0];
    templateAt = Date.now();
  }
  return template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

const inflight = new Map();
async function getTile(z, x, y, { noBaked = false } = {}) {
  if (!noBaked) { try { return await fs.promises.readFile(path.join(BAKED_DIR, String(z), String(x), `${y}.pbf`)); } catch { /* not baked */ } }
  const file = path.join(CACHE_DIR, String(z), String(x), `${y}.pbf`);
  try { return await fs.promises.readFile(file); } catch { /* not cached */ }
  const key = `${z}/${x}/${y}`;
  if (!inflight.has(key)) {
    inflight.set(key, (async () => {
      let lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(await tileUrl(z, x, y), { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'gpx-ride/1.0' } });
          if (res.status === 204 || res.status === 404) return Buffer.alloc(0); // empty sea / no data
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const buf = Buffer.from(await res.arrayBuffer());
          await fs.promises.mkdir(path.dirname(file), { recursive: true });
          await fs.promises.writeFile(file, buf);
          return buf;
        } catch (e) { lastErr = e; template = attempt ? null : template; await new Promise((r) => setTimeout(r, 400 * (attempt + 1))); }
      }
      throw lastErr;
    })().finally(() => inflight.delete(key)));
  }
  return inflight.get(key);
}

async function handler(req, res) {
  const z = parseInt(req.params.z, 10), x = parseInt(req.params.x, 10), y = parseInt(req.params.y, 10);
  if (!(z >= 0 && z <= MAX_Z) || !(x >= 0 && x < 2 ** z) || !(y >= 0 && y < 2 ** z)) return res.status(400).end();
  if (process.env.TILE_MOCK) return res.status(404).end();
  try {
    const buf = await getTile(z, x, y);
    res.set('Content-Type', 'application/x-protobuf');
    res.set('Cache-Control', 'public, max-age=604800');
    res.send(buf);
  } catch (e) {
    res.status(502).send(String(e.message || e));
  }
}

module.exports = { vectorTileHandler: handler, getTile, BAKED_DIR };
