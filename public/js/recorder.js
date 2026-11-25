// Records the ride (1 sample / s) and exports GPX + TCX for Strava / Garmin Connect.

const R = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;
const RIDES = 'gpxride.rides';
const DRAFT = 'gpxride.draft';

export class Recorder {
  constructor(route, profile) {
    this.routeId = route.id;
    this.routeName = route.name;
    this.lat0 = route.origin.lat;
    this.lon0 = route.origin.lon;
    this.kx = toRad(1) * R * Math.cos(toRad(this.lat0));
    this.ky = toRad(1) * R;
    this.profile = { name: profile.name, weight: profile.weight };
    this.samples = []; // [t, lat, lon, ele, ridden, power, hr, cad, speed, seg]
    this.seg = 0;
    this.ridden = 0;
    this.id = 'r' + Date.now().toString(36);
  }
  /** Call on teleports: GPS track gets a gap instead of a straight line. */
  newSegment() { if (this.samples.length) this.seg++; }
  addDistance(m) { this.ridden += m; }
  add({ x, y, ele, power, hr, cadence, speed }) {
    const lat = this.lat0 + y / this.ky;
    const lon = this.lon0 + x / this.kx;
    this.samples.push([Date.now(), +lat.toFixed(7), +lon.toFixed(7), +ele.toFixed(1), +this.ridden.toFixed(1),
      Math.round(power), Math.round(hr), Math.round(cadence), +speed.toFixed(2), this.seg]);
  }
  toJSON() {
    return { id: this.id, routeId: this.routeId, routeName: this.routeName, profile: this.profile, samples: this.samples, date: this.samples[0] ? this.samples[0][0] : Date.now() };
  }
}

export function summarize(ride) {
  const s = ride.samples;
  if (!s.length) return null;
  let moving = 0, pSum = 0, pMax = 0, hrSum = 0, hrN = 0, hrMax = 0, cadSum = 0, cadN = 0, asc = 0, kj = 0;
  for (let i = 0; i < s.length; i++) {
    const [, , , ele, , p, hr, cad, v, seg] = s[i];
    if (v > 0.5) { moving++; pSum += p; }
    kj += p / 1000;
    pMax = Math.max(pMax, p);
    if (hr > 0) { hrSum += hr; hrN++; hrMax = Math.max(hrMax, hr); }
    if (cad > 0) { cadSum += cad; cadN++; }
    if (i && s[i - 1][9] === seg && ele > s[i - 1][3]) asc += ele - s[i - 1][3];
  }
  const dist = s[s.length - 1][4];
  return {
    distance: dist,
    elapsed: (s[s.length - 1][0] - s[0][0]) / 1000,
    moving,
    avgSpeed: moving ? dist / moving : 0,
    avgPower: moving ? pSum / moving : 0,
    maxPower: pMax,
    avgHr: hrN ? hrSum / hrN : 0,
    maxHr: hrMax,
    avgCad: cadN ? cadSum / cadN : 0,
    ascent: asc,
    kj,
    wkg: moving && ride.profile.weight ? pSum / moving / ride.profile.weight : 0,
  };
}

const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const xmlEsc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

export function toGPX(ride) {
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<gpx creator="GPX Ride" version="1.1" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd http://www.garmin.com/xmlschemas/TrackPointExtension/v1 http://www.garmin.com/xmlschemas/TrackPointExtensionv1.xsd">');
  out.push(` <metadata><time>${iso(ride.samples[0][0])}</time></metadata>`);
  out.push(` <trk><name>${xmlEsc('GPX Ride: ' + ride.routeName)}</name><type>VirtualRide</type>`);
  let seg = null;
  for (const [t, lat, lon, ele, , p, hr, cad, , sg] of ride.samples) {
    if (sg !== seg) { if (seg !== null) out.push('  </trkseg>'); out.push('  <trkseg>'); seg = sg; }
    const tpx = (hr ? `<gpxtpx:hr>${hr}</gpxtpx:hr>` : '') + (cad ? `<gpxtpx:cad>${Math.min(254, cad)}</gpxtpx:cad>` : '');
    out.push(`   <trkpt lat="${lat}" lon="${lon}"><ele>${ele}</ele><time>${iso(t)}</time><extensions><power>${p}</power>` +
      (tpx ? `<gpxtpx:TrackPointExtension>${tpx}</gpxtpx:TrackPointExtension>` : '') + '</extensions></trkpt>');
  }
  out.push('  </trkseg>', ' </trk>', '</gpx>', '');
  return out.join('\n');
}

export function toTCX(ride) {
  const s = ride.samples, sum = summarize(ride);
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">');
  out.push(' <Activities>', '  <Activity Sport="Biking">', `   <Id>${iso(s[0][0])}</Id>`);
  out.push(`   <Lap StartTime="${iso(s[0][0])}">`);
  out.push(`    <TotalTimeSeconds>${Math.round(sum.elapsed)}</TotalTimeSeconds>`);
  out.push(`    <DistanceMeters>${sum.distance.toFixed(1)}</DistanceMeters>`);
  out.push(`    <Calories>${Math.round(sum.kj)}</Calories>`);
  if (sum.avgHr) out.push(`    <AverageHeartRateBpm><Value>${Math.round(sum.avgHr)}</Value></AverageHeartRateBpm>`);
  if (sum.maxHr) out.push(`    <MaximumHeartRateBpm><Value>${sum.maxHr}</Value></MaximumHeartRateBpm>`);
  out.push('    <Intensity>Active</Intensity>');
  if (sum.avgCad) out.push(`    <Cadence>${Math.min(254, Math.round(sum.avgCad))}</Cadence>`);
  out.push('    <TriggerMethod>Manual</TriggerMethod>');
  let seg = null;
  for (const [t, lat, lon, ele, dist, p, hr, cad, v, sg] of s) {
    if (sg !== seg) { if (seg !== null) out.push('    </Track>'); out.push('    <Track>'); seg = sg; }
    out.push(`     <Trackpoint><Time>${iso(t)}</Time><Position><LatitudeDegrees>${lat}</LatitudeDegrees><LongitudeDegrees>${lon}</LongitudeDegrees></Position>` +
      `<AltitudeMeters>${ele}</AltitudeMeters><DistanceMeters>${dist}</DistanceMeters>` +
      (hr ? `<HeartRateBpm><Value>${hr}</Value></HeartRateBpm>` : '') +
      (cad ? `<Cadence>${Math.min(254, cad)}</Cadence>` : '') +
      `<Extensions><ns3:TPX><ns3:Speed>${v}</ns3:Speed><ns3:Watts>${p}</ns3:Watts></ns3:TPX></Extensions></Trackpoint>`);
  }
  out.push('    </Track>', '   </Lap>', '  </Activity>', ' </Activities>', '</TrainingCenterDatabase>', '');
  return out.join('\n');
}

export function download(ride, fmt) {
  const text = fmt === 'tcx' ? toTCX(ride) : toGPX(ride);
  const d = new Date(ride.samples[0][0]);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const slug = ride.routeName.toLowerCase().normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const blob = new Blob([text], { type: fmt === 'tcx' ? 'application/vnd.garmin.tcx+xml' : 'application/gpx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `gpxride-${date}-${slug}.${fmt}`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---- Saved rides in the browser ----
export function loadRides() {
  try { return JSON.parse(localStorage.getItem(RIDES) || '[]'); } catch { return []; }
}
export function saveRide(ride) {
  let list = loadRides().filter((r) => r.id !== ride.id);
  list.unshift(ride);
  while (list.length) {
    try { localStorage.setItem(RIDES, JSON.stringify(list)); return true; }
    catch { if (list.length === 1) return false; list.pop(); } // storage full: drop oldest
  }
  return false;
}
export function deleteRide(id) {
  try { localStorage.setItem(RIDES, JSON.stringify(loadRides().filter((r) => r.id !== id))); } catch { /* ignore */ }
}
export function saveDraft(ride) { try { localStorage.setItem(DRAFT, JSON.stringify(ride)); } catch { /* ignore */ } }
export function loadDraft() { try { return JSON.parse(localStorage.getItem(DRAFT) || 'null'); } catch { return null; } }
export function clearDraft() { try { localStorage.removeItem(DRAFT); } catch { /* ignore */ } }
