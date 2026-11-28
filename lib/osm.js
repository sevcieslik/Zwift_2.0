// Snap a GPS track onto real road centrelines from OpenStreetMap.
// Recorded GPS is typically 2-8 m off the road; in Google Photorealistic 3D Tiles that puts the
// game road next to the real one (on the verge, through walls and hedges). We download the OSM
// roads along the route once (Overpass API), cache them next to the GPX, and shift each route
// point onto the nearest road segment that runs in the same direction, with smoothing.
const fs = require('fs');
const path = require('path');

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const HIGHWAYS = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street|road|track|cycleway|path|bridleway|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';

const toRad = (d) => (d * Math.PI) / 180;
// typical full carriageway width per OSM class (Welsh lanes are narrow)
const WIDTH = {
  motorway: 11, trunk: 8, primary: 7.3, secondary: 6.5, tertiary: 5.8, unclassified: 4.6, residential: 5.2,
  living_street: 4.5, service: 3.6, road: 5, track: 3.2, cycleway: 3, path: 2.4, bridleway: 2.4,
  motorway_link: 6, trunk_link: 6, primary_link: 6, secondary_link: 5.5, tertiary_link: 5,
  minor: 4.8, // OpenMapTiles groups unclassified / residential / living_street as 'minor'
};
const R = 6371008.8;

function frame(route) {
  const { lat, lon } = route.origin;
  return { lat0: lat, lon0: lon, kx: toRad(1) * R * Math.cos(toRad(lat)), ky: toRad(1) * R };
}

/** Download OSM road geometry within ~40 m of the route. Returns [{id, hw, pts:[[lat,lon],...]}]. */
function fetchRoads(route, log = console.log) {
  return fetchAlong(route, 40, `[highway~"^(${HIGHWAYS})$"]`, (el) => ({ id: el.id, hw: el.tags && el.tags.highway }), 'dróg', log);
}
/** Building footprints within ~250 m of the route: [{id, pts, levels, h, kind, roof}] */
function fetchBuildings(route, log = console.log) {
  return fetchAlong(route, 250, '[building]', (el) => {
    const t = el.tags || {};
    const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : undefined; };
    return { id: el.id, kind: t.building, levels: num(t['building:levels']), h: num(t.height), roof: t['roof:shape'] };
  }, 'budynków', log);
}
async function fetchAlong(route, around, filter, props, label, log) {
  const f = frame(route);
  const every = Math.max(1, Math.round(120 / route.step));
  const coords = [];
  for (let i = 0; i < route.x.length; i += every) {
    coords.push([f.lat0 + route.y[i] / f.ky, f.lon0 + route.x[i] / f.kx]);
  }
  coords.push([f.lat0 + route.y.at(-1) / f.ky, f.lon0 + route.x.at(-1) / f.kx]);
  const ways = new Map();
  const CH = 200;
  for (let c = 0; c < coords.length; c += CH - 1) {
    const part = coords.slice(c, c + CH);
    const line = part.map(([a, b]) => `${a.toFixed(6)},${b.toFixed(6)}`).join(',');
    const q = `[out:json][timeout:90];way(around:${around},${line})${filter};out geom;`;
    let json = null, lastErr;
    for (const url of ENDPOINTS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'gpx-ride/1.0 (club trainer game)' },
          body: 'data=' + encodeURIComponent(q),
          signal: AbortSignal.timeout(120000),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        json = await res.json();
        break;
      } catch (e) { lastErr = e; }
    }
    if (!json) throw new Error('Overpass niedostępny: ' + (lastErr && lastErr.message));
    for (const el of json.elements || []) {
      if (el.type === 'way' && el.geometry) ways.set(el.id, { ...props(el), pts: el.geometry.map((g) => [g.lat, g.lon]) });
    }
    log(`  OSM: ${Math.min(coords.length, c + CH)}/${coords.length} punktów trasy, ${ways.size} ${label}`);
  }
  return [...ways.values()];
}

/** Shift route x/y onto the roads. Mutates route; returns stats. */
function snapRoute(route, roads, { maxDist = 18, minCos = 0.8 } = {}) {
  const f = frame(route);
  const n = route.x.length;
  // road segments in local metres, in a 25 m grid
  const segs = [];
  const cell = 25, grid = new Map();
  const add = (k, s) => { let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(s); };
  for (const w of roads) {
    const p = w.pts.map(([la, lo]) => [(lo - f.lon0) * f.kx, (la - f.lat0) * f.ky]);
    for (let i = 0; i + 1 < p.length; i++) {
      const [ax, ay] = p[i], [bx, by] = p[i + 1];
      const L = Math.hypot(bx - ax, by - ay);
      if (L < 0.05) continue;
      const s = { ax, ay, bx, by, ux: (bx - ax) / L, uy: (by - ay) / L, L, way: w.id, wd: WIDTH[w.hw] || 5 };
      const si = segs.push(s) - 1;
      // rasterise the segment's bbox into the grid
      const x0 = Math.floor(Math.min(ax, bx) / cell), x1 = Math.floor(Math.max(ax, bx) / cell);
      const y0 = Math.floor(Math.min(ay, by) / cell), y1 = Math.floor(Math.max(ay, by) / cell);
      for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) add(gx + ',' + gy, si);
    }
  }
  const ox = new Float64Array(n), oy = new Float64Array(n), ok = new Float64Array(n), wd = new Float64Array(n).fill(NaN);
  let prevWay = null;
  for (let i = 0; i < n; i++) {
    const x = route.x[i], y = route.y[i];
    const a = Math.max(0, i - 2), b = Math.min(n - 1, i + 2);
    let dx = route.x[b] - route.x[a], dy = route.y[b] - route.y[a];
    const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    let best = Infinity, bx = 0, by = 0, bw = null, bwd = 5;
    const seen = new Set();
    for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) {
      const arr = grid.get(gx + ',' + gy);
      if (!arr) continue;
      for (const si of arr) {
        if (seen.has(si)) continue; seen.add(si);
        const s = segs[si];
        if (Math.abs(s.ux * dx + s.uy * dy) < minCos) continue; // must run along the route
        const t = Math.max(0, Math.min(s.L, (x - s.ax) * s.ux + (y - s.ay) * s.uy));
        const px = s.ax + s.ux * t, py = s.ay + s.uy * t;
        let d = Math.hypot(px - x, py - y);
        if (s.way !== prevWay) d += 2; // prefer staying on the same road
        if (d < best) { best = d; bx = px; by = py; bw = s.way; bwd = s.wd; }
      }
    }
    if (best <= maxDist) { ox[i] = bx - x; oy[i] = by - y; ok[i] = 1; prevWay = bw; wd[i] = bwd; }
  }
  // smooth the offsets (~±25 m) weighted by validity, so corrections fade in/out instead of jumping
  const pw = Math.max(1, Math.round(10 / route.step));
  const sx = new Float64Array(n), sy = new Float64Array(n);
  let cover = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    let ax = 0, ay = 0, wsum = 0, wall = 0;
    for (let k = -pw * 3; k <= pw * 3; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      const wk = Math.exp(-(k * k) / (2 * pw * pw));
      wall += wk;
      if (!ok[j]) continue;
      ax += ox[j] * wk; ay += oy[j] * wk; wsum += wk;
    }
    const conf = wsum / wall; // fraction of neighbours that found a road
    if (wsum > 0) { sx[i] = (ax / wsum) * conf; sy[i] = (ay / wsum) * conf; }
    if (ok[i]) { cover++; sum += Math.hypot(ox[i], oy[i]); }
  }
  const r1 = (v) => Math.round(v * 10) / 10;
  // half width per point: fill gaps with neighbours, then smooth over ~±40 m so the road edge flows
  const hw = new Float64Array(n);
  let last = 5;
  for (let i = 0; i < n; i++) { if (Number.isFinite(wd[i])) last = wd[i]; hw[i] = last; }
  for (let i = n - 1, nxt = hw[n - 1]; i >= 0; i--) { if (Number.isFinite(wd[i])) nxt = wd[i]; else if (!Number.isFinite(wd[i]) && i < n - 1) hw[i] = Math.min(hw[i], nxt); }
  const ww = Math.max(1, Math.round(40 / route.step));
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + hw[i];
  route.hw = Array.from(hw, (_, i) => { const a = Math.max(0, i - ww), b = Math.min(n, i + ww + 1); return r1(Math.max(1.3, (pre[b] - pre[a]) / (b - a) / 2)); });
  for (let i = 0; i < n; i++) { route.x[i] = r1(route.x[i] + sx[i]); route.y[i] = r1(route.y[i] + sy[i]); }
  const stats = { coverage: Math.round((cover / n) * 100), meanOffset: r1(cover ? sum / cover : 0), roads: roads.length };
  route.snap = stats;
  return stats;
}

/**
 * Roads and building footprints along the route from OpenMapTiles vector tiles (z14) — the same
 * baked/cached tiles the game paints the ground with. No Overpass needed.
 * getTile(z, x, y) -> Buffer. Returns { roads: [{id, hw, pts}], buildings: [{id, kind, h, pts}] }.
 */
async function fromVectorTiles(route, getTile, { z = 14, around = 300 } = {}) {
  const { VectorTile } = await import('@mapbox/vector-tile');
  const { PbfReader } = await import('pbf');
  const f = frame(route);
  const tileXY = (lat, lon) => { const n = 2 ** z; return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(toRad(lat)) + 1 / Math.cos(toRad(lat))) / Math.PI) / 2) * n]; };
  const want = new Set();
  const every = Math.max(1, Math.round(80 / route.step));
  for (let i = 0; i < route.x.length; i += every) {
    for (const [dx, dy] of [[0, 0], [around, 0], [-around, 0], [0, around], [0, -around]]) {
      const [tx, ty] = tileXY(f.lat0 + (route.y[i] + dy) / f.ky, f.lon0 + (route.x[i] + dx) / f.kx);
      want.add(Math.floor(tx) + ',' + Math.floor(ty));
    }
  }
  const roads = [], buildings = [];
  const tile2lat = (y) => { const n = Math.PI - (2 * Math.PI * y) / 2 ** z; return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };
  let id = 0, ok = 0;
  for (const key of want) {
    const [tx, ty] = key.split(',').map(Number);
    let buf;
    try { buf = await getTile(z, tx, ty); } catch { continue; }
    ok++;
    if (!buf || !buf.length) continue;
    const t = new VectorTile(new PbfReader(new Uint8Array(buf)));
    const ll = (p, ext) => [tile2lat(ty + p.y / ext), ((tx + p.x / ext) / 2 ** z) * 360 - 180];
    const tr = t.layers.transportation;
    if (tr) for (let i = 0; i < tr.length; i++) {
      const ft = tr.feature(i), c = ft.properties.class;
      if (ft.type !== 2 || !c || /rail|transit|ferry|aerialway|pier/.test(c)) continue;
      for (const line of ft.loadGeometry()) roads.push({ id: ++id, hw: c, pts: line.map((p) => ll(p, tr.extent)) });
    }
    const bl = t.layers.building;
    if (bl) for (let i = 0; i < bl.length; i++) {
      const ft = bl.feature(i);
      if (ft.type !== 3) continue;
      // one feature holds many houses with the same attributes: every exterior ring is a building
      const h = ft.properties.render_height;
      for (const ring of ft.loadGeometry()) {
        let a = 0;
        for (let k = 0, n = ring.length; k < n; k++) { const p = ring[k], q = ring[(k + 1) % n]; a += p.x * q.y - q.x * p.y; }
        if (a <= 0) continue; // hole (exterior rings are clockwise in tile space)
        // OpenMapTiles fills in a small default when OSM has no height: leave those to the LiDAR
        buildings.push({ id: ++id, kind: 'yes', h: h > 6 ? h : undefined, pts: ring.map((p) => ll(p, bl.extent)) });
      }
    }
  }
  if (!ok) throw new Error('brak kafli wektorowych');
  // keep only what is near the route (tiles are 1.5 km wide): 50 m grid cells around the track
  const cell = 50, near = (r) => {
    const set = new Set(), k = Math.ceil(r / cell), ev = Math.max(1, Math.round(cell / route.step));
    for (let i = 0; i < route.x.length; i += ev) {
      const cx = Math.floor(route.x[i] / cell), cy = Math.floor(route.y[i] / cell);
      for (let a = -k; a <= k; a++) for (let b = -k; b <= k; b++) if (a * a + b * b <= (k + 1) * (k + 1)) set.add((cx + a) + ',' + (cy + b));
    }
    return (lat, lon) => set.has(Math.floor(((lon - f.lon0) * f.kx) / cell) + ',' + Math.floor(((lat - f.lat0) * f.ky) / cell));
  };
  const nearRoad = near(60), nearB = near(around);
  const keptRoads = roads.filter((w) => w.pts.some(([la, lo]) => nearRoad(la, lo)));
  const keptB = buildings.filter((b) => { let la = 0, lo = 0; for (const [a, c] of b.pts) { la += a; lo += c; } return nearB(la / b.pts.length, lo / b.pts.length); });
  return { roads: keptRoads, buildings: keptB, tiles: ok };
}

function cacheFile(routesDir, id, kind = 'roads') { return path.join(routesDir, `${id}.${kind}.json`); }
function loadCached(routesDir, id, kind = 'roads') {
  const f = cacheFile(routesDir, id, kind);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}
function saveCached(routesDir, id, items, kind = 'roads') {
  const slim = items.map((w) => ({ ...w, pts: w.pts.map(([a, b]) => [+a.toFixed(7), +b.toFixed(7)]) }));
  fs.writeFileSync(cacheFile(routesDir, id, kind), JSON.stringify(slim));
}

module.exports = { fetchRoads, fetchBuildings, fromVectorTiles, snapRoute, loadCached, saveCached };
