'use strict';
// Parse a GPX file and turn it into a resampled, smoothed route usable by the game.

const R = 6371008.8; // Earth radius (m)
const toRad = (d) => (d * Math.PI) / 180;

function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function attr(attrs, name) {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`));
  return m ? parseFloat(m[1]) : NaN;
}

function extractPoints(xml, tag) {
  const pts = [];
  const re = new RegExp(`<${tag}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${tag}>)`, 'g');
  let m;
  while ((m = re.exec(xml))) {
    const lat = attr(m[1], 'lat');
    const lon = attr(m[1], 'lon');
    const eleM = (m[2] || '').match(/<ele>\s*([^<]+?)\s*<\/ele>/);
    const ele = eleM ? parseFloat(eleM[1]) : NaN;
    if (Number.isFinite(lat) && Number.isFinite(lon)) pts.push({ lat, lon, ele });
  }
  return pts;
}

function parseGpx(xml) {
  let pts = extractPoints(xml, 'trkpt');
  if (pts.length < 2) pts = extractPoints(xml, 'rtept');
  if (pts.length < 2) throw new Error('GPX nie zawiera punktów trasy (trkpt/rtept)');
  const nameM = xml.match(/<(?:trk|rte|metadata)>[\s\S]*?<name>\s*(?:<!\[CDATA\[)?([^<\]]*)/);
  return { name: nameM ? nameM[1].trim() : null, points: pts };
}

// Fill missing elevations by linear interpolation.
function fillElevation(pts) {
  const known = pts.map((p, i) => (Number.isFinite(p.ele) ? i : -1)).filter((i) => i >= 0);
  if (!known.length) { pts.forEach((p) => (p.ele = 0)); return; }
  for (let i = 0; i < pts.length; i++) {
    if (Number.isFinite(pts[i].ele)) continue;
    let prev = -1, next = -1;
    for (const k of known) { if (k < i) prev = k; else { next = k; break; } }
    if (prev < 0) pts[i].ele = pts[next].ele;
    else if (next < 0) pts[i].ele = pts[prev].ele;
    else {
      const t = (i - prev) / (next - prev);
      pts[i].ele = pts[prev].ele + t * (pts[next].ele - pts[prev].ele);
    }
  }
}

function buildRoute(xml, fallbackName) {
  const { name, points: raw } = parseGpx(xml);
  fillElevation(raw);

  // Drop duplicate / jittery points.
  const pts = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    if (haversine(pts[pts.length - 1], raw[i]) > 4) pts.push(raw[i]); // drop GPS jitter while standing still
  }
  if (pts.length < 2) throw new Error('Trasa jest za krótka');

  // Remove GPS spikes: a short out-and-back (sharp reversal on segments < 60 m) is never a real road.
  const bearing = (a, b) => Math.atan2((b.lon - a.lon) * Math.cos(toRad(a.lat)), b.lat - a.lat);
  for (let pass = 0; pass < 5; pass++) {
    let removed = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1], b = pts[i], c = pts[i + 1];
      let turn = Math.abs(bearing(b, c) - bearing(a, b));
      if (turn > Math.PI) turn = 2 * Math.PI - turn;
      if (turn > (110 * Math.PI) / 180 && (haversine(a, b) < 60 || haversine(b, c) < 60)) { pts.splice(i, 1); i--; removed++; }
    }
    if (!removed) break;
  }

  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]));
  const total = cum[cum.length - 1];

  const lat0 = pts[0].lat, lon0 = pts[0].lon;
  const kx = toRad(1) * R * Math.cos(toRad(lat0));
  const ky = toRad(1) * R;

  // Resample at fixed spacing.
  const step = Math.max(5, total / 20000);
  const n = Math.max(2, Math.floor(total / step) + 1);
  const xs = new Float64Array(n), ys = new Float64Array(n), es = new Float64Array(n), ds = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.min(total, i * step);
    while (j < cum.length - 2 && cum[j + 1] < d) j++;
    const seg = cum[j + 1] - cum[j] || 1;
    const t = Math.min(1, Math.max(0, (d - cum[j]) / seg));
    const a = pts[j], b = pts[j + 1];
    const lat = a.lat + t * (b.lat - a.lat);
    const lon = a.lon + t * (b.lon - a.lon);
    xs[i] = (lon - lon0) * kx;
    ys[i] = (lat - lat0) * ky;
    es[i] = a.ele + t * (b.ele - a.ele);
    ds[i] = d;
  }

  // Remove single-point spikes (e.g. the first GPS fix): running median over ~50 m.
  const mw = Math.max(1, Math.round(25 / step));
  const med = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const win = [];
    for (let k = Math.max(0, i - mw); k <= Math.min(n - 1, i + mw); k++) win.push(es[k]);
    win.sort((a, b) => a - b);
    med[i] = win[win.length >> 1];
  }
  es.set(med);

  // Smooth elevation (GPS elevation is noisy) with a ~40 m gaussian-ish window.
  const win = Math.max(1, Math.round(20 / step));
  const sm = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, w = 0;
    for (let k = -win * 2; k <= win * 2; k++) {
      const idx = Math.min(n - 1, Math.max(0, i + k));
      const wk = Math.exp(-(k * k) / (2 * win * win));
      s += es[idx] * wk; w += wk;
    }
    sm[i] = s / w;
  }

  // Same road ridden twice (start = finish, out-and-back): GPS puts the passes a few metres apart.
  // Snap the later pass onto the earlier one so the game draws a single road.
  {
    const cell = 20, grid = new Map();
    const key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
    const minGap = Math.round(300 / step); // only passes that are far apart along the route
    for (let i = 0; i < n; i++) {
      let best = Infinity, bj = -1;
      const cx = Math.floor(xs[i] / cell), cy = Math.floor(ys[i] / cell);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        const arr = grid.get(`${cx + a},${cy + b}`);
        if (!arr) continue;
        for (const j of arr) {
          if (i - j < minGap) continue;
          const d = Math.hypot(xs[i] - xs[j], ys[i] - ys[j]);
          if (d < best) { best = d; bj = j; }
        }
      }
      if (bj >= 0 && best < 10) {
        const t = Math.min(1, Math.max(0, (10 - best) / 4)); // full snap under 6 m, fade out to 10 m
        const w = t * t * (3 - 2 * t);
        xs[i] += (xs[bj] - xs[i]) * w;
        ys[i] += (ys[bj] - ys[i]) * w;
      }
      const k = key(xs[i], ys[i]);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    }
  }

  // Gaussian smoothing of the x/y path (~±20 m) so GPS wiggles don't make the road and camera zigzag.
  const sx = new Float64Array(n), sy = new Float64Array(n);
  const pw = Math.max(1, Math.round(8 / step));
  for (let i = 0; i < n; i++) {
    let ax = 0, ay = 0, c = 0;
    for (let k = -pw * 2; k <= pw * 2; k++) {
      const idx = i + k;
      if (idx < 0 || idx >= n) continue;
      const wk = Math.exp(-(k * k) / (2 * pw * pw));
      ax += xs[idx] * wk; ay += ys[idx] * wk; c += wk;
    }
    sx[i] = ax / c; sy[i] = ay / c;
  }

  const gw = Math.max(1, Math.round(10 / step));
  const grade = new Float64Array(n);
  let ascent = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - gw), b = Math.min(n - 1, i + gw);
    const g = (sm[b] - sm[a]) / Math.max(1, ds[b] - ds[a]);
    grade[i] = Math.max(-0.2, Math.min(0.2, g));
    if (i > 0 && sm[i] > sm[i - 1]) ascent += sm[i] - sm[i - 1];
  }

  const loop = haversine(pts[0], pts[pts.length - 1]) < 60;
  const r1 = (v) => Math.round(v * 10) / 10;
  const r3 = (v) => Math.round(v * 1000) / 1000;

  let minEle = Infinity, maxEle = -Infinity;
  for (const e of sm) { if (e < minEle) minEle = e; if (e > maxEle) maxEle = e; }

  return {
    name: name || fallbackName,
    loop,
    total: r1(total),
    ascent: Math.round(ascent),
    minEle: r1(minEle),
    maxEle: r1(maxEle),
    step,
    origin: { lat: lat0, lon: lon0 },
    x: Array.from(sx, r1),
    y: Array.from(sy, r1),
    ele: Array.from(sm, r1),
    dist: Array.from(ds, r1),
    grade: Array.from(grade, r3),
  };
}

module.exports = { buildRoute, parseGpx };
