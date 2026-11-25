'use strict';
// WGS84 latitude/longitude -> British National Grid (OSGB36, EPSG:27700) easting/northing.
// 7-parameter Helmert transform + Transverse Mercator (Ordnance Survey formulas). Accuracy ~2-5 m,
// plenty for terrain heights sampled on a few-metre grid.

const rad = (d) => (d * Math.PI) / 180;

function toCartesian(lat, lon, a, b, h = 0) {
  const e2 = 1 - (b * b) / (a * a);
  const s = Math.sin(lat), c = Math.cos(lat);
  const nu = a / Math.sqrt(1 - e2 * s * s);
  return [(nu + h) * c * Math.cos(lon), (nu + h) * c * Math.sin(lon), ((1 - e2) * nu + h) * s];
}

function fromCartesian(x, y, z, a, b) {
  const e2 = 1 - (b * b) / (a * a);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - e2));
  for (let i = 0; i < 10; i++) {
    const nu = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    lat = Math.atan2(z + e2 * nu * Math.sin(lat), p);
  }
  return [lat, Math.atan2(y, x)];
}

const WGS84 = [6378137.0, 6356752.314245];
const AIRY = [6377563.396, 6356256.909];
// WGS84 -> OSGB36
const H = { tx: -446.448, ty: 125.157, tz: -542.06, s: 20.4894e-6, rx: rad(-0.1502 / 3600), ry: rad(-0.247 / 3600), rz: rad(-0.8421 / 3600) };

function toBNG(latDeg, lonDeg) {
  const [x1, y1, z1] = toCartesian(rad(latDeg), rad(lonDeg), ...WGS84);
  const s1 = 1 + H.s;
  const x2 = H.tx + s1 * x1 - H.rz * y1 + H.ry * z1;
  const y2 = H.ty + H.rz * x1 + s1 * y1 - H.rx * z1;
  const z2 = H.tz - H.ry * x1 + H.rx * y1 + s1 * z1;
  const [phi, lam] = fromCartesian(x2, y2, z2, ...AIRY);

  const [a, b] = AIRY;
  const F0 = 0.9996012717, phi0 = rad(49), lam0 = rad(-2), E0 = 400000, N0 = -100000;
  const e2 = 1 - (b * b) / (a * a), n = (a - b) / (a + b);
  const sp = Math.sin(phi), cp = Math.cos(phi), tp = Math.tan(phi);
  const nu = (a * F0) / Math.sqrt(1 - e2 * sp * sp);
  const rho = (a * F0 * (1 - e2)) / Math.pow(1 - e2 * sp * sp, 1.5);
  const eta2 = nu / rho - 1;
  const dp = phi - phi0, sm = phi + phi0;
  const M = b * F0 * (
    (1 + n + 1.25 * n * n + 1.25 * n ** 3) * dp -
    (3 * n + 3 * n * n + 2.625 * n ** 3) * Math.sin(dp) * Math.cos(sm) +
    (1.875 * n * n + 1.875 * n ** 3) * Math.sin(2 * dp) * Math.cos(2 * sm) -
    (35 / 24) * n ** 3 * Math.sin(3 * dp) * Math.cos(3 * sm));
  const I = M + N0;
  const II = (nu / 2) * sp * cp;
  const III = (nu / 24) * sp * cp ** 3 * (5 - tp * tp + 9 * eta2);
  const IIIA = (nu / 720) * sp * cp ** 5 * (61 - 58 * tp * tp + tp ** 4);
  const IV = nu * cp;
  const V = (nu / 6) * cp ** 3 * (nu / rho - tp * tp);
  const VI = (nu / 120) * cp ** 5 * (5 - 18 * tp * tp + tp ** 4 + 14 * eta2 - 58 * tp * tp * eta2);
  const dl = lam - lam0;
  const N = I + II * dl ** 2 + III * dl ** 4 + IIIA * dl ** 6;
  const E = E0 + IV * dl + V * dl ** 3 + VI * dl ** 5;
  return [E, N];
}

module.exports = { toBNG };
