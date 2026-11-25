'use strict';
// Elevation tiles (Terrarium PNG) cut on demand from a LiDAR Cloud-Optimised GeoTIFF in British National Grid.
// Default source: Welsh Government / NRW 1 m LiDAR DTM for the whole of Wales (Open Government Licence).
// Only the parts needed are read, using HTTP range requests.

const { fromUrl, addDecoder, BaseDecoder } = require('geotiff');
const { ZSTDDecoder } = require('zstddec');

// Plain ZSTD (TIFF compression 50000) isn't built into geotiff.js – GDAL COGs often use it.
const zstd = new ZSTDDecoder();
const zstdReady = zstd.init();
class ZstdTiffDecoder extends BaseDecoder {
  async decode(fileDirectory, buffer) {
    await zstdReady;
    const fd = fileDirectory;
    const w = fd.TileWidth || fd.ImageWidth, h = fd.TileLength || fd.RowsPerStrip || fd.ImageLength;
    const bytes = (fd.BitsPerSample ? fd.BitsPerSample[0] : 8) / 8 * (fd.PlanarConfiguration === 2 ? 1 : fd.SamplesPerPixel || 1);
    const out = zstd.decode(new Uint8Array(buffer), w * h * bytes);
    return super.decode(fileDirectory, out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
  }
  decodeBlock(buffer) { return buffer; }
}
addDecoder(50000, () => ZstdTiffDecoder);
const { toBNG } = require('./bng');

const COG_URL = process.env.LIDAR_COG_URL !== undefined
  ? process.env.LIDAR_COG_URL
  : 'https://dmwproductionblob.blob.core.windows.net/cogs/lidar/wales_dtm_32bit_cog.tif';

let opening = null;
let disabledUntil = 0;

function open() {
  if (!COG_URL) return Promise.reject(new Error('LiDAR disabled'));
  if (Date.now() < disabledUntil) return Promise.reject(new Error('LiDAR source unavailable'));
  if (!opening) {
    opening = (async () => {
      const tiff = await fromUrl(COG_URL, { cacheSize: 4000, blockSize: 65536, allowFullFile: false });
      const count = await tiff.getImageCount();
      const imgs = [];
      for (let i = 0; i < count; i++) {
        const im = await tiff.getImage(i);
        const sub = im.fileDirectory.NewSubfileType || 0;
        if (sub & 4) continue; // transparency mask
        imgs.push(im);
      }
      const main = imgs[0];
      const [ox, oy] = main.getOrigin();
      const [rx, ry] = main.getResolution();
      const W = main.getWidth(), H = main.getHeight();
      const levels = imgs
        .map((im) => ({ im, resX: Math.abs(rx) * W / im.getWidth(), resY: Math.abs(ry) * H / im.getHeight(), w: im.getWidth(), h: im.getHeight() }))
        .sort((a, b) => a.resX - b.resX);
      const nd = main.getGDALNoData();
      const info = { ox, oy, levels, nodata: nd === null ? null : Number(nd), bbox: [ox, oy - H * Math.abs(ry), ox + W * Math.abs(rx), oy] };
      console.log(`LiDAR: ${COG_URL} – ${levels.length} poziomów, ${levels[0].resX.toFixed(2)} m/px, zasięg E ${info.bbox[0].toFixed(0)}–${info.bbox[2].toFixed(0)}, N ${info.bbox[1].toFixed(0)}–${info.bbox[3].toFixed(0)}`);
      return info;
    })().catch((e) => {
      console.warn('LiDAR niedostępny:', e.message);
      opening = null;
      disabledUntil = Date.now() + 5 * 60 * 1000; // retry later
      throw e;
    });
  }
  return opening;
}

const tile2lon = (x, z) => (x / 2 ** z) * 360 - 180;
const tile2lat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

/**
 * Heights (metres) for a 256x256 web-mercator tile, or null if the LiDAR has no data there.
 * Pixels without data are NaN.
 */
async function lidarHeights(z, x, y) {
  const info = await open();
  const N = 256;
  const E = new Float64Array(N * N), No = new Float64Array(N * N);
  let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
  for (let j = 0; j < N; j++) {
    const lat = tile2lat(y + (j + 0.5) / N, z);
    for (let i = 0; i < N; i++) {
      const lon = tile2lon(x + (i + 0.5) / N, z);
      const [e, n] = toBNG(lat, lon);
      const k = j * N + i;
      E[k] = e; No[k] = n;
      if (e < minE) minE = e; if (e > maxE) maxE = e;
      if (n < minN) minN = n; if (n > maxN) maxN = n;
    }
  }
  const b = info.bbox;
  if (maxE < b[0] || minE > b[2] || maxN < b[1] || minN > b[3]) return null;

  // pick the coarsest overview that is still at least as detailed as the tile
  const groundRes = (maxE - minE) / N;
  let L = info.levels[0];
  for (const lv of info.levels) if (lv.resX <= groundRes * 1.01) L = lv;

  const px = (e) => (e - info.ox) / L.resX - 0.5;
  const py = (n) => (info.oy - n) / L.resY - 0.5;
  const x0 = Math.max(0, Math.floor(px(minE)) - 1), x1 = Math.min(L.w, Math.ceil(px(maxE)) + 2);
  const y0 = Math.max(0, Math.floor(py(maxN)) - 1), y1 = Math.min(L.h, Math.ceil(py(minN)) + 2);
  if (x1 <= x0 || y1 <= y0) return null;
  const ras = await L.im.readRasters({ window: [x0, y0, x1, y1], samples: [0], interleave: true });
  const ww = x1 - x0, wh = y1 - y0;
  const nd = info.nodata;
  const val = (ix, iy) => {
    if (ix < 0 || iy < 0 || ix >= ww || iy >= wh) return NaN;
    const v = ras[iy * ww + ix];
    if (!Number.isFinite(v) || (nd !== null && Math.abs(v - nd) < 1e-3) || v < -500 || v > 5000) return NaN;
    return v;
  };

  const out = new Float32Array(N * N);
  let valid = 0;
  for (let k = 0; k < N * N; k++) {
    const fx = px(E[k]) - x0, fy = py(No[k]) - y0;
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    const a = val(ix, iy), bb = val(ix + 1, iy), c = val(ix, iy + 1), d = val(ix + 1, iy + 1);
    let h;
    if (Number.isFinite(a) && Number.isFinite(bb) && Number.isFinite(c) && Number.isFinite(d)) {
      h = a * (1 - tx) * (1 - ty) + bb * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
    } else {
      // edge of the data: use whatever neighbour exists
      h = [a, bb, c, d].find(Number.isFinite);
      if (h === undefined) h = NaN;
    }
    out[k] = h;
    if (Number.isFinite(h)) valid++;
  }
  return valid ? out : null;
}

/** Encode heights as a Terrarium PNG (R*256 + G + B/256 - 32768). `fallback(k)` fills pixels with no data. */
function terrarium(heights, fallback, png) {
  const N = 256, buf = Buffer.alloc(N * N * 4);
  for (let k = 0; k < N * N; k++) {
    let h = heights[k];
    if (!Number.isFinite(h)) h = fallback ? fallback(k) : 0;
    if (!Number.isFinite(h)) h = 0;
    const v = Math.max(0, Math.min(65535.99, h + 32768));
    buf[k * 4] = Math.floor(v / 256);
    buf[k * 4 + 1] = Math.floor(v) % 256;
    buf[k * 4 + 2] = Math.floor((v % 1) * 256);
    buf[k * 4 + 3] = 255;
  }
  return png(N, N, buf);
}

module.exports = { lidarHeights, terrarium, lidarEnabled: () => !!COG_URL, COG_URL };
